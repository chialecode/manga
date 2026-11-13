/** @vitest-environment jsdom */
import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import type { NoteBlock } from "@manga/contracts/reading";
import { createTranslator } from "@manga/i18n";
import { InlineRename } from "../../apps/desktop/src/renderer/components/inline-rename.tsx";
import { NumberField } from "../../apps/desktop/src/renderer/components/number-field.tsx";
import { WorkPicker } from "../../apps/desktop/src/renderer/components/work-picker.tsx";
import { useAsyncGuard, useDebouncedSearch } from "../../apps/desktop/src/renderer/hooks/use-async-guard.ts";
import { useNotes } from "../../apps/desktop/src/renderer/hooks/use-notes.ts";
import { dayBounds, formatBytes, formatClockMs, formatClockSec } from "../../apps/desktop/src/renderer/lib/format.ts";
import { isImeEvent, isTypingTarget } from "../../apps/desktop/src/renderer/lib/ime.ts";
import { createPatchQueue } from "../../apps/desktop/src/renderer/lib/patch-queue.ts";
import { NoteEditor, localStorageDrafts } from "../../apps/desktop/src/renderer/note-editor.tsx";
import { PdfPageView } from "../../apps/desktop/src/renderer/pdf-page.tsx";
import { ReadingPane } from "../../apps/desktop/src/renderer/reading.tsx";
import { hostOf, placeTabs, registerHost, releaseContext, releaseHost, setParking, setSlot } from "../../apps/desktop/src/renderer/workspace/placement.ts";

Element.prototype.scrollIntoView = () => {};

const pdfFake = vi.hoisted(() => ({
  getDocument: vi.fn(),
  destroy: vi.fn(async () => undefined),
  getPage: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  version: "6.5.438",
  GlobalWorkerOptions: {},
  getDocument: (...args: unknown[]) => {
    pdfFake.getDocument(...args);
    return {
      destroy: pdfFake.destroy,
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (index: number) => {
          pdfFake.getPage(index);
          return {
            getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 400 * scale, scale }),
            render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
            getTextContent: async () => ({ items: [{ str: index === 1 ? "ALPHA BETA GAMMA" : "SECOND PAGE TEXT" }] }),
            cleanup: () => undefined,
          };
        },
      }),
    };
  },
}));

vi.mock("pdfjs-dist/legacy/web/pdf_viewer.mjs", () => ({
  TextLayerBuilder: class {
    div = document.createElement("div");
    constructor(private options: { pdfPage: { getTextContent: () => Promise<{ items: Array<{ str: string }> }> }; onAppend: (div: HTMLDivElement) => void }) {
      this.div.className = "textLayer";
    }
    async render() {
      const content = await this.options.pdfPage.getTextContent();
      const span = document.createElement("span");
      span.textContent = content.items[0]!.str;
      this.div.append(span);
      this.options.onAppend(this.div);
    }
    cancel() {}
  },
}));

const i18n = createTranslator("zh-CN");
const t = i18n.t;

const editorLabels = {
  blockInsert: "插入块",
  blockRemove: "删除块",
  blockMoveUp: "上移",
  blockMoveDown: "下移",
  blockCopy: "复制块",
  blockMerge: "与下一块合并",
  blockType: "块类型",
  typeParagraph: "正文",
  typeHeading: "标题",
  typeList: "列表",
  typeQuote: "引用",
  typeCode: "代码",
  typePlain: "纯文本",
  draftRestored: "已恢复未保存的草稿",
  draftDiscard: "丢弃草稿",
  conflict: "笔记已被其他修改更新，草稿保留为候选",
  sourceStale: "来源已失效",
  repairSource: "重新指定来源文件",
  undo: "撤销",
  redo: "重做",
  undoHint: "撤销/重做会同时作用于富文本和源编辑视图",
  sourceEdit: "编辑此块源码",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { localStorage.clear(); } catch { /* none */ }
});

describe("P0/P1 renderer regressions", () => {
  it("clears local draft and increments epoch together with restored doc on useNotes.restore (US-01)", async () => {
    localStorageDrafts.write("note_1", { blocks: [{ id: "b1", type: "paragraph", text: "stale local draft" }] });
    let releaseGet!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGet = resolve; });
    let version = 1;
    vi.stubGlobal("manga", {
      command: vi.fn(async ({ commandId }: { commandId: string }) => {
        if (commandId === "notes.get") {
          if (version === 2) await gate;
          return {
            status: "ok",
            value: {
              revision: version,
              title: version === 1 ? "旧标题" : "恢复后标题",
              tags: [],
              document: { blocks: [{ id: "b1", type: "paragraph", text: version === 1 ? "当前内容" : "恢复内容" }] },
            },
          };
        }
        if (commandId === "notes.restore") {
          version = 2;
          return { status: "ok", value: { revision: 2 } };
        }
        return { status: "ok", value: {} };
      }),
      onNotice: () => () => undefined,
    });

    const { result } = renderHook(() => useNotes({ i18n, setError: vi.fn(), setNotice: vi.fn(), contextId: null }));
    await act(async () => { await result.current.open("note_1"); });
    expect(result.current.epoch).toBe(0);
    expect(result.current.doc?.title).toBe("旧标题");

    let restoring!: Promise<void>;
    await act(async () => {
      restoring = result.current.restore(1);
      await Promise.resolve();
    });
    // Local draft is cleared before notes.get finishes, and epoch has NOT bumped while doc is still stale.
    expect(localStorageDrafts.read("note_1")).toBeNull();
    expect(result.current.epoch).toBe(0);
    expect(result.current.doc?.title).toBe("旧标题");

    releaseGet();
    await act(async () => { await restoring; });
    expect(result.current.epoch).toBe(1);
    expect(result.current.doc?.title).toBe("恢复后标题");
    expect(result.current.doc?.blocks[0]?.text).toBe("恢复内容");
  });

  it("keeps tab portal host nodes attached under React 19 StrictMode double-effect invocation (US-05)", () => {
    const key = "strict-ctx";
    const tabId = "tab-strict-1";
    function StrictPlacementHarness() {
      const parking = useRef<HTMLDivElement>(null);
      const slot = useRef<HTMLDivElement>(null);
      const nodeRef = useRef<HTMLDivElement | null>(null);
      if (!nodeRef.current) nodeRef.current = hostOf(key, tabId);
      useLayoutEffect(() => {
        setSlot(key, "home", tabId, slot.current);
        return () => setSlot(key, "home", tabId, null);
      }, []);
      useLayoutEffect(() => {
        if (nodeRef.current) registerHost(key, tabId, nodeRef.current);
        return () => releaseHost(key, tabId);
      }, []);
      useLayoutEffect(() => {
        setParking(key, parking.current);
        placeTabs(key, "home", [tabId]);
        return () => { setParking(key, null); releaseContext(key); };
      }, []);
      return (
        <div>
          <div ref={slot} data-testid="strict-slot" />
          <div ref={parking} data-testid="strict-parking" />
          {createPortal(<span data-testid="strict-portal-body">内容在线</span>, nodeRef.current)}
        </div>
      );
    }

    const view = render(
      <StrictMode>
        <StrictPlacementHarness />
      </StrictMode>,
    );
    const slot = screen.getByTestId("strict-slot");
    const body = screen.getByTestId("strict-portal-body");
    expect(slot.contains(body)).toBe(true);
    view.unmount();
  });

  it("drains an in-flight save and flushes edits typed during it when onSaveNow fires (US-10)", async () => {
    let saveNowHandler: (() => Promise<unknown>) | null = null;
    vi.stubGlobal("manga", {
      onSaveNow: (cb: () => Promise<unknown>) => { saveNowHandler = cb; return () => { saveNowHandler = null; }; },
      onNotice: () => () => undefined,
    });
    const firstGate = Promise.withResolvers<number>();
    const saved: Array<{ expected: number; text: string }> = [];
    const onSave = vi.fn(async (blocks: NoteBlock[], expectedRevision: number) => {
      saved.push({ expected: expectedRevision, text: blocks[0]?.text ?? "" });
      if (saved.length === 1) return firstGate.promise;
      return expectedRevision + 1;
    });
    const drafts = { read: () => null, write: vi.fn(), clear: vi.fn() };
    render(
      <NoteEditor
        objectId="obj-drain"
        document={{ schemaVersion: 2, blocks: [{ id: "b1", type: "paragraph", text: "初始" }] }}
        revision={1}
        title="测试笔记"
        tags={[]}
        saveLabel="尚未保存"
        savingLabel="正在保存"
        savedLabel="已保存"
        failedLabel="没有保存成功"
        splitLabel="拆分段落"
        sourceLabel="源编辑"
        labels={editorLabels}
        drafts={drafts}
        onSave={onSave}
      />,
    );
    const surface = screen.getByTestId("note-surface") as HTMLElement & { editor: Editor };
    expect(saveNowHandler).toBeTruthy();

    // Edit 1 and kick off save 1 (stays in-flight behind firstGate).
    act(() => { surface.editor.commands.insertContent("一"); });
    let pendingFlush!: Promise<unknown>;
    act(() => { pendingFlush = saveNowHandler!(); });
    await waitFor(() => expect(saved).toHaveLength(1));

    // Edit 2 while save 1 is STILL in-flight, then trigger onSaveNow again.
    act(() => { surface.editor.commands.insertContent("二"); });
    const quitFlush = saveNowHandler!();
    firstGate.resolve(2);
    await act(async () => { await Promise.all([pendingFlush, quitFlush]); });

    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual({ expected: 1, text: "一初始" });
    expect(saved[1]).toEqual({ expected: 2, text: "一二初始" });
  });

  it("renders both quote highlight and inline illustration when paragraphSpacingPx is 0 (US-11)", () => {
    const text = "第一段测试引用文本。\n第二段补充内容。";
    const highlight = { start: 3, end: 7 };
    render(
      <ReadingPane
        document={{
          resourceId: "res_1",
          revisionId: "rev_1",
          title: "测试小说",
          format: "epub",
          warnings: [],
          toc: [],
          parts: [{ id: "p1", title: "第一章", kind: "chapter", length: text.length, textLayer: true }],
          slice: {
            partId: "p1",
            text,
            start: 0,
            end: text.length,
            kind: "chapter",
            textLayer: true,
            images: [{ id: "img1", partId: "p1", name: "插画一", mediaType: "image/png", bytes: 128 }],
            placements: [{ assetId: "img1", offset: 10 }],
          },
          source: { available: true },
        }}
        assets={{ img1: "data:image/png;base64,AAAA" }}
        highlight={highlight}
        style={{
          fontFamily: "system",
          fontSizePx: 18,
          lineHeight: 1.7,
          paragraphSpacingPx: 0,
          measurePx: 680,
          marginPx: 32,
          theme: "paper",
          flow: "scroll",
        }}
        labels={{
          empty: "",
          search: "",
          progress: "",
          note: "",
          missing: "",
          scan: "",
          more: "",
          image: "",
          imageFailed: "",
          bookmark: "",
          bookmarkAdd: "",
          bookmarkNone: "",
          bookmarkRemove: "",
          part: "",
          hits: "",
          hitNone: "",
          jump: "",
          toc: "",
          source: "",
          sourceOpen: "",
          quote: "",
          images: "",
          selectForAgent: "",
        }}
        labelsExtra={{ sourceNeedsReview: "", sourceMissing: "", sourceRepair: "" }}
        hits={[]}
        bookmarks={[]}
        sourceCard={null}
        onSearch={vi.fn()}
        onJump={vi.fn()}
        onProgress={vi.fn()}
        onSelect={vi.fn()}
        onPart={vi.fn()}
        onStyle={vi.fn()}
        onBookmark={vi.fn()}
        onRemoveBookmark={vi.fn()}
        onOpenBookmark={vi.fn()}
        onBackToNote={vi.fn()}
        onRepair={vi.fn()}
      />,
    );
    const mark = screen.getByTestId("reading-quote-hit");
    expect(mark.textContent).toBe("测试引用");
    expect(screen.getByTestId("reading-image-img1")).toBeTruthy();
  });

  it("keeps PDF document alive across page turns and updates highlights in place without re-rendering canvas (US-12)", async () => {
    pdfFake.getDocument.mockClear();
    pdfFake.destroy.mockClear();
    pdfFake.getPage.mockClear();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const shared = {
      bytes: new Uint8Array([1, 2, 3]),
      sliceStart: 0,
      scanLabel: "scan",
      missingLabel: "review",
      zoomLabels: { out: "out", in: "in", fit: "fit" },
      onSelection: vi.fn(),
    };
    const view = render(<PdfPageView {...shared} pageNumber={1} storedText="ALPHA BETA GAMMA" highlight={null} />);
    await waitFor(() => expect(screen.getByTestId("reading-pdf-text").textContent).toBe("ALPHA BETA GAMMA"));
    expect(pdfFake.getDocument).toHaveBeenCalledTimes(1);
    const epochBefore = Number(screen.getByTestId("reading-page-render").getAttribute("data-pdf-epoch"));

    // Highlight change does NOT reload document or re-render page canvas.
    view.rerender(<PdfPageView {...shared} pageNumber={1} storedText="ALPHA BETA GAMMA" highlight={{ start: 6, end: 10 }} highlightQuote="BETA" />);
    await waitFor(() => expect(screen.getByTestId("reading-pdf-text").querySelector("[data-testid='reading-quote-hit']")).toBeTruthy());
    expect(pdfFake.getDocument).toHaveBeenCalledTimes(1);
    expect(Number(screen.getByTestId("reading-page-render").getAttribute("data-pdf-epoch"))).toBe(epochBefore);

    // Turning page reuses the already-loaded PDF document without destroying it.
    view.rerender(<PdfPageView {...shared} pageNumber={2} storedText="SECOND PAGE TEXT" highlight={null} />);
    await waitFor(() => expect(screen.getByTestId("reading-pdf-text").textContent).toBe("SECOND PAGE TEXT"));
    expect(pdfFake.getDocument).toHaveBeenCalledTimes(1);
    expect(pdfFake.destroy).not.toHaveBeenCalled();

    // Unmounting destroys the PDF document task cleanly.
    view.unmount();
    expect(pdfFake.destroy).toHaveBeenCalledTimes(1);
  });

  it("resolves human work title via works.get and never renders raw work ID in WorkPicker (US-25)", async () => {
    vi.stubGlobal("manga", {
      command: vi.fn(async ({ commandId, input }: { commandId: string; input?: Record<string, unknown> }) => {
        if (commandId === "works.list") return { status: "ok", value: { items: [{ id: "work_a", title: "作品甲", mediaKind: "novel" }] } };
        if (commandId === "works.get" && input?.workId === "work_outside_id") return { status: "ok", value: { title: "远方作品" } };
        return { status: "error", error: { code: "NOT_FOUND", message: "missing" } };
      }),
      onNotice: () => () => undefined,
    });

    const view = render(<WorkPicker t={t} value="work_outside_id" onChange={vi.fn()} label="作品" placeholder="全部作品" testId="wp" />);
    // Immediately before works.get resolves, raw work ID is NOT shown in option text.
    const select = screen.getByTestId("wp-select") as HTMLSelectElement;
    expect(select.textContent).not.toContain("work_outside_id");
    await waitFor(() => expect(select.textContent).toContain("远方作品"));
    expect(select.textContent).not.toContain("work_outside_id");

    // If works.get fails for an unknown ID, falls back to placeholder, never raw ID.
    view.rerender(<WorkPicker t={t} value="work_missing_999" onChange={vi.fn()} label="作品" placeholder="全部作品" testId="wp" />);
    await waitFor(() => expect(select.value).toBe("work_missing_999"));
    expect(select.textContent).not.toContain("work_missing_999");
  });
});

describe("shared renderer helpers for ui-shell and ui-pages", () => {
  it("detects IME composition events and typing targets cleanly", () => {
    expect(isImeEvent({ key: "Process" })).toBe(true);
    expect(isImeEvent({ keyCode: 229 })).toBe(true);
    expect(isImeEvent({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeEvent({ key: "Enter" }, true)).toBe(true);
    expect(isImeEvent({ key: "Enter" }, false)).toBe(false);

    const input = document.createElement("input");
    const div = document.createElement("div");
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("formats bytes, clocks, and day bounds consistently", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatClockSec(65)).toBe("1:05");
    expect(formatClockSec(65, { padMinutes: true })).toBe("01:05");
    expect(formatClockSec(3661)).toBe("1:01:01");
    expect(formatClockMs(125_400)).toBe("2:05");
    expect(dayBounds("2026-10-01")).toEqual({
      from: new Date(2026, 9, 1, 0, 0, 0, 0).toISOString(),
      to: new Date(2026, 9, 1, 23, 59, 59, 999).toISOString(),
    });
    expect(dayBounds("")).toEqual({});
  });

  it("serializes patches FIFO, preserves pending overlays on hydrate, and rolls back on failure in createPatchQueue", async () => {
    const states: Array<{ a: number; b: number }> = [];
    const errors: string[] = [];
    const first = Promise.withResolvers<{ ok: true } | { ok: false; error: string }>();
    const sent: Array<Partial<{ a: number; b: number }>> = [];
    const queue = createPatchQueue<{ a: number; b: number }, Partial<{ a: number; b: number }>>({
      initial: { a: 0, b: 0 },
      apply: (state, patch) => ({ ...state, ...patch }),
      send: async (patch) => {
        sent.push(patch);
        if (sent.length === 1) return first.promise;
        return { ok: false, error: "save failed" };
      },
      onState: (next) => { states.push(next); },
      onError: (message) => { if (message) errors.push(message); },
    });

    const p1 = queue.enqueue({ a: 1 });
    const p2 = queue.enqueue({ b: 2 });
    expect(queue.current()).toEqual({ a: 1, b: 2 });
    // Hydrate while pending preserves queued optimistic overlays over the new server base.
    queue.hydrate({ a: 10, b: 20 });
    expect(queue.current()).toEqual({ a: 1, b: 2 });

    first.resolve({ ok: true });
    await Promise.all([p1, p2]);
    expect(sent).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errors).toEqual(["save failed"]);
    // Patch 1 succeeded (base became a:1, b:20), patch 2 failed and rolled back to base.
    expect(queue.current()).toEqual({ a: 1, b: 20 });
  });

  it("guards stale async work and debounces search with IME awareness", async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => {
        const guard = useAsyncGuard();
        const search = useDebouncedSearch("", 200);
        return { guard, search };
      });
      const t1 = result.current.guard.next();
      const t2 = result.current.guard.next();
      expect(result.current.guard.isCurrent(t1)).toBe(false);
      expect(result.current.guard.isCurrent(t2)).toBe(true);

      act(() => { result.current.search.inputProps.onCompositionStart(); });
      act(() => { result.current.search.setText("拼"); });
      act(() => { vi.advanceTimersByTime(250); });
      expect(result.current.search.query).toBe("");
      act(() => {
        result.current.search.inputProps.onCompositionEnd({ currentTarget: { value: "拼音" } } as never);
      });
      act(() => { vi.advanceTimersByTime(200); });
      expect(result.current.search.query).toBe("拼音");

      unmount();
      expect(result.current.guard.isAlive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps and commits NumberField on blur/Enter and reverts on Escape", () => {
    const onCommit = vi.fn();
    render(<NumberField value={10} min={1} max={100} onCommit={onCommit} testId="nf" ariaLabel="数量" />);
    const input = screen.getByTestId("nf") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(100);
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("10");
  });

  it("commits trimmed text on submit and cancels on Escape in InlineRename while preventing IME Enter", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const view = render(<InlineRename initialValue="原名" onCommit={onCommit} onCancel={onCancel} testId="ir" ariaLabel="重命名" />);
    const input = screen.getByTestId("ir") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  新名  " } });
    fireEvent.compositionStart(input);
    const imeEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(imeEnter);
    expect(imeEnter.defaultPrevented).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.submit(input.closest("form")!);
    expect(onCommit).toHaveBeenCalledWith("新名");
    view.unmount();

    onCommit.mockClear();
    onCancel.mockClear();
    render(<InlineRename initialValue="另一个" onCommit={onCommit} onCancel={onCancel} testId="ir" ariaLabel="重命名" />);
    fireEvent.keyDown(screen.getByTestId("ir"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("renders a live React component updating state via useAsyncGuard cleanly", () => {
    function Demo() {
      const [val, setVal] = useState("init");
      const guard = useAsyncGuard();
      useEffect(() => {
        const token = guard.next();
        if (guard.isCurrent(token)) setVal("ready");
      }, [guard]);
      return <span data-testid="guard-demo">{val}</span>;
    }
    render(<Demo />);
    expect(screen.getByTestId("guard-demo").textContent).toBe("ready");
  });
});
