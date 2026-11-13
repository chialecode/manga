/** @vitest-environment jsdom */
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NoteBlock } from "@manga/contracts";
import { NoteEditor, type DraftStore } from "../../apps/desktop/src/renderer/note-editor.tsx";
import { DraftEditor } from "../../apps/desktop/src/renderer/pages/projects/copy/draft-editor.tsx";
import {
  captureEditableTarget,
  isImeComposing,
  resetCompositionState,
  waitForCompositionEnd,
  type ObservedEditPayload,
} from "../../apps/desktop/src/renderer/voice/editable-target.ts";

Element.prototype.scrollIntoView = () => undefined;
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects = emptyRects;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const editorLabels: Parameters<typeof NoteEditor>[0]["labels"] = {
  blockInsert: "插入段落",
  blockRemove: "移除段落",
  blockMoveUp: "上移",
  blockMoveDown: "下移",
  blockCopy: "复制段落",
  blockMerge: "合并",
  blockType: "段落类型",
  typeParagraph: "正文",
  typeHeading: "标题",
  typeList: "列表",
  typeQuote: "引用",
  typeCode: "代码",
  typePlain: "原文",
  draftRestored: "恢复草稿",
  draftDiscard: "丢弃草稿",
  conflict: "版本冲突",
  sourceStale: "来源失效",
  repairSource: "修复来源",
  undo: "撤销",
  redo: "重做",
  undoHint: "撤销上一步",
  sourceEdit: "源编辑",
};

function memoryDrafts(): DraftStore {
  const store = new Map<string, { blocks: NoteBlock[]; title?: string; tags?: string[]; savedAt: string }>();
  return {
    read: (id) => store.get(id) ?? null,
    write: (id, draft) => { store.set(id, { ...draft, savedAt: "2026-11-12T00:00:00Z" }); },
    clear: (id) => { store.delete(id); },
  };
}

afterEach(() => {
  cleanup();
  resetCompositionState();
  vi.useRealTimers();
});

describe("EditableTargetAdapter across all 6 surfaces (U1)", () => {
  it("inserts, replaces, and reverts in React 19 controlled <textarea> (Chat Composer / Capsule)", () => {
    const snapshots: string[] = [];
    function ControlledComposer() {
      const [value, setValue] = useState("你好[]世界");
      return createElement("textarea", {
        "data-testid": "controlled-textarea",
        value,
        onChange: (event: { target: HTMLTextAreaElement }) => {
          snapshots.push(event.target.value);
          setValue(event.target.value);
        },
      });
    }

    render(createElement(ControlledComposer));
    const textarea = screen.getByTestId("controlled-textarea") as HTMLTextAreaElement;
    textarea.focus();
    // Select "[]" between "你好" and "世界"
    textarea.setSelectionRange(2, 4);

    const handle = captureEditableTarget();
    expect(handle).not.toBeNull();
    expect(handle?.kind).toBe("native");

    act(() => {
      expect(handle!.insert("原始语音")).toBe(true);
    });
    expect(textarea.value).toBe("你好原始语音世界");
    expect(textarea.selectionStart).toBe(6);
    expect(snapshots.at(-1)).toBe("你好原始语音世界");

    act(() => {
      expect(handle!.replace("润色后的语音")).toBe(true);
    });
    expect(textarea.value).toBe("你好润色后的语音世界");
    expect(textarea.selectionStart).toBe(8);
    expect(snapshots.at(-1)).toBe("你好润色后的语音世界");

    // Revert back to raw text
    act(() => {
      expect(handle!.replace("原始语音")).toBe(true);
    });
    expect(textarea.value).toBe("你好原始语音世界");
    handle!.dispose();
  });

  it("supports <input type='search'> and <input type='text'> (SearchBox) while ignoring password, readOnly, and disabled inputs", () => {
    render(
      createElement(
        "div",
        null,
        createElement("input", { "data-testid": "search-box", type: "search", defaultValue: "动画 " }),
        createElement("input", { "data-testid": "pwd-box", type: "password", defaultValue: "secret" }),
        createElement("input", { "data-testid": "ro-box", type: "text", readOnly: true, defaultValue: "fixed" }),
        createElement("textarea", { "data-testid": "disabled-area", disabled: true, defaultValue: "off" }),
      ),
    );

    const search = screen.getByTestId("search-box") as HTMLInputElement;
    search.focus();
    search.setSelectionRange(3, 3);
    const searchHandle = captureEditableTarget();
    expect(searchHandle?.kind).toBe("native");
    expect(searchHandle!.insert("遥香")).toBe(true);
    expect(search.value).toBe("动画 遥香");
    expect(searchHandle!.replace("神代·遥香")).toBe(true);
    expect(search.value).toBe("动画 神代·遥香");
    searchHandle!.dispose();

    for (const id of ["pwd-box", "ro-box", "disabled-area"]) {
      const el = screen.getByTestId(id) as HTMLElement;
      el.focus();
      expect(captureEditableTarget(el)).toBeNull();
    }
  });

  it("creates discrete NoteEditor undo steps for rich Tiptap insert, polish replace, and revert without coalescing", () => {
    render(
      createElement(NoteEditor, {
        objectId: "note-rich-1",
        document: { schemaVersion: 2, blocks: [{ id: "b1", type: "paragraph", text: "开篇：" }] },
        revision: 1,
        title: "测试笔记",
        tags: [],
        saveLabel: "未保存",
        savingLabel: "保存中",
        savedLabel: "已保存",
        failedLabel: "失败",
        splitLabel: "拆分",
        sourceLabel: "源编辑",
        labels: editorLabels,
        drafts: memoryDrafts(),
        onSave: async () => 2,
      }),
    );

    const surface = screen.getByTestId("note-surface");
    surface.focus();

    const handle = captureEditableTarget(surface);
    expect(handle?.kind).toBe("tiptap");

    // Place caret at end via first insert (default selection in Tiptap starts at pos 1; let's test inserting and replacing)
    act(() => {
      expect(handle!.insert("初稿词")).toBe(true);
    });
    expect(surface.textContent).toContain("初稿词");
    const afterRaw = surface.textContent;

    act(() => {
      expect(handle!.replace("润色词")).toBe(true);
    });
    expect(surface.textContent).toContain("润色词");
    expect(surface.textContent).not.toContain("初稿词");

    // Clicking NoteEditor's undo steps back discrete stages: 润色词 -> 初稿词 -> 开篇：
    const undoBtn = screen.getByTestId("note-undo") as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(false);
    fireEvent.click(undoBtn);
    expect(surface.textContent).toBe(afterRaw);

    fireEvent.click(undoBtn);
    expect(surface.textContent).toBe("开篇：");
    expect(undoBtn.disabled).toBe(true);
    handle!.dispose();
  });

  it("creates discrete NoteEditor undo steps when dictating into CodeMirror 6 SourceEditor", () => {
    render(
      createElement(NoteEditor, {
        objectId: "note-cm-1",
        document: { schemaVersion: 2, blocks: [{ id: "b1", type: "plaintext", text: "行一" }] },
        revision: 1,
        title: "源码笔记",
        tags: [],
        saveLabel: "未保存",
        savingLabel: "保存中",
        savedLabel: "已保存",
        failedLabel: "失败",
        splitLabel: "拆分",
        sourceLabel: "源编辑",
        labels: editorLabels,
        drafts: memoryDrafts(),
        onSave: async () => 2,
      }),
    );

    fireEvent.click(screen.getByTestId("source-b1"));
    const sourceHost = screen.getByTestId("note-source");
    const cmContent = sourceHost.querySelector(".cm-content") as HTMLElement;
    expect(cmContent).toBeTruthy();
    cmContent.focus();

    const handle = captureEditableTarget(cmContent);
    expect(handle?.kind).toBe("codemirror");

    act(() => {
      expect(handle!.insert("初稿")).toBe(true);
    });
    expect(sourceHost.textContent).toContain("初稿");
    const afterRaw = sourceHost.textContent;

    act(() => {
      expect(handle!.replace("精修")).toBe(true);
    });
    expect(sourceHost.textContent).toContain("精修");
    expect(sourceHost.textContent).not.toContain("初稿");

    const undoBtn = screen.getByTestId("note-undo") as HTMLButtonElement;
    fireEvent.click(undoBtn);
    expect(sourceHost.textContent).toBe(afterRaw);

    fireEvent.click(undoBtn);
    expect(sourceHost.textContent).toBe("行一");
    handle!.dispose();
  });

  it("inserts and replaces in DraftEditor with discrete ProseMirror Ctrl+Z history steps", () => {
    const changes: string[] = [];
    render(
      createElement(DraftEditor, {
        text: "序章",
        epoch: 1,
        label: "文稿正文",
        onChange: (next) => changes.push(next),
        onSelection: () => undefined,
      }),
    );

    const draftSurface = screen.getByTestId("draft-surface");
    draftSurface.focus();

    const handle = captureEditableTarget(draftSurface);
    expect(handle?.kind).toBe("tiptap");

    act(() => {
      expect(handle!.insert("口述原稿")).toBe(true);
    });
    const afterRaw = changes.at(-1)!;
    expect(afterRaw).toContain("口述原稿");

    act(() => {
      expect(handle!.replace("书面定稿")).toBe(true);
    });
    expect(changes.at(-1)).toContain("书面定稿");
    expect(changes.at(-1)).not.toContain("口述原稿");

    // Trigger ProseMirror Mod-z keymap once -> reverts to raw text, twice -> reverts to initial "序章"
    fireEvent.keyDown(draftSurface, { key: "z", ctrlKey: true });
    expect(changes.at(-1)).toBe(afterRaw);

    fireEvent.keyDown(draftSurface, { key: "z", ctrlKey: true });
    expect(changes.at(-1)).toBe("序章");
    handle!.dispose();
  });

  it("preserves transient blur-committing inputs (WhiteboardNodes / MindmapTab) on mousedown-prevented controls and observes edits before unmount", () => {
    const committed: string[] = [];
    const observed: ObservedEditPayload[] = [];

    function TransientCardInput() {
      const [editing, setEditing] = useState(true);
      const [text, setText] = useState("节点：");
      return createElement(
        "div",
        null,
        editing
          ? createElement("input", {
              "data-testid": "transient-input",
              value: text,
              onChange: (event: { target: HTMLInputElement }) => setText(event.target.value),
              onBlur: () => {
                committed.push(text);
                setEditing(false);
              },
            })
          : createElement("span", { "data-testid": "transient-committed" }, text),
        createElement(
          "button",
          {
            type: "button",
            "data-testid": "capsule-like-btn",
            onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
          },
          "结束",
        ),
      );
    }

    render(createElement(TransientCardInput));
    const input = screen.getByTestId("transient-input") as HTMLInputElement;
    input.focus();
    input.setSelectionRange(3, 3);

    const handle = captureEditableTarget();
    expect(handle).not.toBeNull();

    // Clicking a capsule/pill button that calls preventDefault on mouseDown does NOT blur/unmount the input
    const prevented = !fireEvent.mouseDown(screen.getByTestId("capsule-like-btn"));
    expect(prevented).toBe(true);
    expect(screen.queryByTestId("transient-input")).not.toBeNull();

    act(() => {
      expect(handle!.insert("天海林音")).toBe(true);
    });
    expect(input.value).toBe("节点：天海林音");

    handle!.startEditObservation((payload) => observed.push(payload), 60_000);

    // User fixes the character's name to "天海凛音" and blurs (which commits & unmounts the input!)
    fireEvent.change(input, { target: { value: "节点：天海凛音" } });
    fireEvent.blur(input);

    expect(screen.getByTestId("transient-committed").textContent).toBe("节点：天海凛音");
    expect(committed).toEqual(["节点：天海凛音"]);
    // Capture-phase blur observer captured the user edit BEFORE React unmounted the input
    expect(observed).toEqual([{ insertedText: "天海林音", editedText: "天海凛音" }]);
    handle!.dispose();
  });

  it("inserts at current cursor when target was modified during recognition, and returns false when target unmounts", () => {
    const { unmount } = render(createElement("textarea", { "data-testid": "live-area", defaultValue: "第一句。" }));
    const area = screen.getByTestId("live-area") as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(0, 0);

    const handle = captureEditableTarget();
    expect(handle).not.toBeNull();

    // User types at the end while recognition is still running
    area.value = "第一句。补充：";
    area.setSelectionRange(area.value.length, area.value.length);

    expect(handle!.insert("识别结果")).toBe(true);
    expect(area.value).toBe("第一句。补充：识别结果");

    // Unmounting makes isAlive() and subsequent writes return false cleanly
    unmount();
    expect(handle!.isAlive()).toBe(false);
    expect(handle!.insert("不会写入")).toBe(false);
    expect(handle!.replace("不会替换")).toBe(false);
  });

  it("fires 60s timer edit observation only when user actually modified the inserted text", () => {
    vi.useFakeTimers();
    render(createElement("textarea", { "data-testid": "obs-area", defaultValue: "前文 " }));
    const area = screen.getByTestId("obs-area") as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(3, 3);

    const handle = captureEditableTarget()!;
    expect(handle.insert("千夏")).toBe(true);

    const observed: ObservedEditPayload[] = [];
    handle.startEditObservation((payload) => observed.push(payload), 60_000);

    // Without user edits, 60s timeout emits nothing
    vi.advanceTimersByTime(60_000);
    expect(observed).toEqual([]);

    // Second insert + user edit within 60s emits the exact diff
    expect(handle.replace("星野仓真")).toBe(true);
    handle.startEditObservation((payload) => observed.push(payload), 60_000);
    area.value = "前文 星野苍真";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(60_000);
    expect(observed).toEqual([{ insertedText: "星野仓真", editedText: "星野苍真" }]);
    handle.dispose();
  });

  it("waits for active IME compositionend before starting, and aborts cleanly if released mid-composition", async () => {
    render(createElement("textarea", { "data-testid": "ime-area" }));
    const area = screen.getByTestId("ime-area");
    area.focus();

    expect(isImeComposing(area)).toBe(false);
    fireEvent.compositionStart(area);
    expect(isImeComposing(area)).toBe(true);

    let resolved: boolean | null = null;
    const waitPromise = waitForCompositionEnd().then((ok) => {
      resolved = ok;
    });
    await Promise.resolve();
    expect(resolved).toBeNull();

    fireEvent.compositionEnd(area);
    await waitPromise;
    expect(resolved).toBe(true);
    expect(isImeComposing(area)).toBe(false);

    // Aborting while still composing resolves false immediately
    fireEvent.compositionStart(area);
    let abortCb: (() => void) | undefined;
    let aborted = false;
    const abortPromise = waitForCompositionEnd({
      get aborted() { return aborted; },
      onAbort: (cb) => {
        abortCb = cb;
        return () => { abortCb = undefined; };
      },
    });
    aborted = true;
    abortCb?.();
    expect(await abortPromise).toBe(false);
  });
});
