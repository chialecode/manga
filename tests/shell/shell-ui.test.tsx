/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import type { NoteBlock } from "@manga/contracts";
import { afterEach } from "vitest";
import { DEFAULT_SHELL_PREFERENCE } from "@manga/contracts";
import { frame, shellRail } from "../helpers/shell-frame.tsx";
import { NoteEditor } from "../../apps/desktop/src/renderer/note-editor.tsx";
import { productWindow } from "../../apps/desktop/src/main/window-options.ts";
import { readingSelection, ReadingPane, highlightSlices } from "../../apps/desktop/src/renderer/reading.tsx";

/** jsdom has no layout, so the "bring the jump target into view" call the reader makes needs a stub. */
Element.prototype.scrollIntoView = () => {};


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

/** An in-memory draft store so tests never depend on a real localStorage. */
function memoryDrafts() {
  const store = new Map<string, { blocks: NoteBlock[]; title?: string; tags?: string[]; savedAt: string }>();
  return {
    read: (objectId: string) => store.get(objectId) ?? null,
    write: (objectId: string, draft: { blocks: NoteBlock[]; title?: string; tags?: string[] }) => { store.set(objectId, { ...draft, savedAt: "2026-01-01T00:00:00.000Z" }); },
    clear: (objectId: string) => { store.delete(objectId); },
    size: () => store.size,
    peek: (objectId: string) => store.get(objectId),
  };
}

function renderEditor(input: {
  blocks: NoteBlock[];
  revision?: number;
  onSave: Parameters<typeof NoteEditor>[0]["onSave"];
  drafts?: Parameters<typeof NoteEditor>[0]["drafts"];
  onOpenSource?: (blockId: string) => void;
  objectId?: string;
  title?: string;
  tags?: string[];
}) {
  render(
    <NoteEditor
      objectId={input.objectId ?? "obj-1"}
      document={{ schemaVersion: 2, blocks: input.blocks }}
      revision={input.revision ?? 1}
      title={input.title ?? "笔记"}
      tags={input.tags ?? []}
      saveLabel="尚未保存"
      savingLabel="正在保存"
      savedLabel="已保存"
      failedLabel="没有保存成功"
      splitLabel="拆分段落"
      sourceLabel="源编辑"
      labels={editorLabels}
      drafts={input.drafts ?? memoryDrafts()}
      onOpenSource={input.onOpenSource}
      onSave={input.onSave}
    />,
  );
  return screen.getByTestId("note-surface") as HTMLElement & { editor: Editor };
}


afterEach(() => cleanup());

describe("AT-60 AT-61 AT-62 AT-111 shell", () => {
  it("docks the columns on a wide window and keeps the reading measure", () => {
    frame(1600, 900);
    expect(screen.getByTestId("shell-sidebar").getAttribute("data-shell-state")).toBe("dock");
    expect(screen.getByTestId("shell-dock").getAttribute("data-shell-state")).toBe("dock");
    expect(screen.getByTestId("shell-main").getAttribute("data-measure")).toBe("680");
    expect(screen.getByTestId("nav-home")).toBeTruthy();
    expect(screen.queryByText("白板")).toBeNull();
    expect(productWindow.minWidth).toBeLessThanOrEqual(360);
    expect(productWindow.topHeightPx).toBe(36);
  });

  it("opens one overlay from hover and restores focus with Escape", () => {
    frame(800, 700);
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    const toggle = screen.getByTestId("shell-sidebar-toggle");
    toggle.focus();
    fireEvent.mouseEnter(toggle);
    expect(screen.getByTestId("shell-sidebar").getAttribute("data-shell-state")).toBe("overlay");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps a stop control and the full-size layout", () => {
    frame(1280, 840, { running: true });
    expect(screen.getByTestId("shell-task-stop")).toBeTruthy();
    expect(screen.getByTestId("shell-root").getAttribute("data-compact")).toBe("false");
  });

  it("has no mode switch: the top row starts with the sidebar switch, back, forward and the menus, in that order, and the sidebar holds no switch", () => {
    frame(1280, 840);
    const top = screen.getByTestId("shell-top");
    const order = Array.from(top.querySelectorAll("[data-testid='shell-sidebar-toggle'], [data-testid='nav-back'], [data-testid='nav-forward'], [data-testid='menubar'], [data-testid^='mode-']")).map((node) => node.getAttribute("data-testid"));
    expect(order).toEqual(["shell-sidebar-toggle", "nav-back", "nav-forward", "menubar"]);
    expect(screen.getByTestId("shell-sidebar").querySelector("[data-testid^='mode-'], [role='group'][aria-label='模式']")).toBeNull();
    expect(screen.queryByTestId("mode-switch")).toBeNull();
    expect(screen.queryByTestId("mode-menu")).toBeNull();
    // The buttons are icons: no text in the switch and the history buttons.
    for (const id of ["shell-sidebar-toggle", "nav-back", "nav-forward"]) expect((screen.getByTestId(id).textContent ?? "").trim(), id).toBe("");
  });

  it("reflects the saved preference: a hidden sidebar stays hidden until its switch is pressed, and the switch is a plain button", () => {
    const show = vi.fn();
    const hidden = structuredClone(DEFAULT_SHELL_PREFERENCE);
    hidden.sidebar.visible = false;
    frame(1280, 840, { preference: hidden, onShow: show });
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    expect(screen.getByTestId("shell-sidebar-toggle").getAttribute("aria-expanded")).toBe("false");
    // Tab reaches it, and Enter or Space activates it like any button.
    expect(screen.getByTestId("shell-sidebar-toggle").tagName).toBe("BUTTON");
    expect(screen.getByTestId("shell-sidebar-toggle").getAttribute("tabindex")).toBeNull();
    fireEvent.click(screen.getByTestId("shell-sidebar-toggle"));
    expect(show).toHaveBeenCalledWith("sidebar");
  });

  it("restores docking after a user hides the sidebar and closes pinned narrow panels", () => {
    const show = vi.fn();
    const preference = structuredClone(DEFAULT_SHELL_PREFERENCE);
    preference.sidebar.visible = false;
    frame(1280, 840, { preference, onShow: show });
    fireEvent.click(screen.getByTestId("shell-sidebar-toggle"));
    expect(show).toHaveBeenCalledWith("sidebar");
    cleanup();
    frame(360, 780);
    const toggle = screen.getByTestId("shell-sidebar-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("shell-sidebar").getAttribute("data-shell-state")).toBe("overlay");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("does not autosave a note while composition is active and keeps split ids", async () => {
    const saved: string[][] = [];
    render(
      <NoteEditor
        objectId="obj-compose"
        document={{ schemaVersion: 2, blocks: [{ id: "b1", type: "paragraph", text: "甲乙丙丁" }, { id: "code1", type: "code", text: "const a = 1" }] }}
        revision={1}
        title="笔记"
        tags={[]}
        saveLabel="尚未保存"
        savingLabel="正在保存"
        savedLabel="已保存"
        failedLabel="没有保存成功"
        splitLabel="拆分段落"
        sourceLabel="源编辑"
        labels={editorLabels}
        drafts={memoryDrafts()}
        onSave={async (blocks) => { saved.push(blocks.map((block) => block.id)); }}
      />,
    );
    const surface = await screen.findByTestId("note-surface");
    // An open document that matches its stored revision reads as saved, not as unsaved work.
    expect(screen.getByTestId("note-editor").getAttribute("data-save-state")).toBe("saved");
    act(() => { surface.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    fireEvent.click(screen.getByTestId("note-split"));
    // Reading starts at the stored revision, so composition must not turn it into a pending save.
    expect(screen.getByTestId("note-editor").getAttribute("data-save-state")).not.toBe("saving");
    expect(saved).toEqual([]);
    act(() => { surface.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    fireEvent.click(screen.getByTestId("note-split"));
    expect(await screen.findByText("正在保存")).toBeTruthy();
    fireEvent.click(screen.getByTestId("source-code1"));
    expect(screen.getByTestId("note-source").getAttribute("data-block-id")).toBe("code1");
  });


  it("has no dock where a conversation tab is in front: the same conversation is not shown twice, and the conversation is the page", () => {
    frame(1280, 840, { hasDock: false, dock: null });
    expect(screen.queryByTestId("shell-dock")).toBeNull();
    expect(screen.queryByTestId("shell-dock-toggle")).toBeNull();
    expect(screen.getByTestId("shell-sidebar")).toBeTruthy();
    expect(screen.getByTestId("nav-home")).toBeTruthy();
  });

  it("keeps the top row's own actions and a panel under the page, and the settings navigation is not the frame's", () => {
    frame(1280, 840, {
      titleActions: <button type="button" data-testid="title-action-debug">调试</button>,
      bottom: <section data-testid="debug-slot">调试面板</section>,
    });
    expect(screen.getByTestId("shell-title-actions").contains(screen.getByTestId("title-action-debug"))).toBe(true);
    expect(screen.getByTestId("shell-top").contains(screen.getByTestId("shell-title-actions"))).toBe(true);
    expect(screen.getByTestId("shell-main").contains(screen.getByTestId("debug-slot"))).toBe(true);
    expect(screen.getByTestId("shell-sidebar").querySelector("[data-testid='settings-nav']")).toBeNull();
  });

  it("shows the floating capsule only while the dock is folded away, and neither the dock nor the capsule where there is no dock", () => {
    const folded = structuredClone(DEFAULT_SHELL_PREFERENCE);
    folded.dock.visible = false;
    frame(1280, 840, { preference: folded, capsule: <div data-testid="capsule-slot">胶囊</div> });
    expect(screen.getByTestId("shell-dock").getAttribute("data-shell-state")).toBe("hidden");
    expect(screen.getByTestId("shell-main").contains(screen.getByTestId("capsule-slot"))).toBe(true);
    cleanup();
    frame(1600, 900, { capsule: <div data-testid="capsule-slot">胶囊</div> });
    expect(screen.getByTestId("shell-dock")).toBeTruthy();
    expect(screen.queryByTestId("capsule-slot")).toBeNull();
    cleanup();
    // A conversation tab is the conversation itself: no dock, no switch for one, and no capsule.
    frame(1600, 900, { hasDock: false, dock: null, capsule: <div data-testid="capsule-slot">胶囊</div> });
    expect(screen.queryByTestId("shell-dock")).toBeNull();
    expect(screen.queryByTestId("shell-dock-toggle")).toBeNull();
    expect(screen.queryByTestId("capsule-slot")).toBeNull();
  });

  it("marks the view the sidebar is on in the rail, and puts settings apart from the others", () => {
    const go = vi.fn();
    const settings = vi.fn();
    frame(1280, 840, { rail: shellRail({ current: "video", onSelect: go, settings: { active: false, onSelect: settings } }) });
    expect(screen.getByTestId("nav-video").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("nav-home").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("nav-settings").closest(".rail-bottom")).toBeTruthy();
    expect(screen.getByTestId("nav-home").closest(".rail-bottom")).toBeNull();
    fireEvent.click(screen.getByTestId("nav-home"));
    expect(go).toHaveBeenCalledWith("home");
    fireEvent.click(screen.getByTestId("nav-settings"));
    expect(settings).toHaveBeenCalledTimes(1);
  });
});


function note(onSave: Parameters<typeof NoteEditor>[0]["onSave"], drafts?: Parameters<typeof NoteEditor>[0]["drafts"]) {
  renderEditor({
    blocks: [
      { id: "b1", type: "paragraph", text: "第一段" },
      { id: "b2", type: "quote", text: "甲乙丙丁", anchorId: "anchor-1" },
    ],
    onSave,
    drafts,
  });
  return (screen.getByTestId("note-surface") as HTMLElement & { editor: Editor }).editor;
}

const readingLabels = {
  importBook: "导入", empty: "没有资源", search: "查找", progress: "标记已读", note: "记录笔记", missing: "原件不可用",
  scan: "扫描页", more: "继续读", image: "图像页", imageFailed: "图像无法显示",
  style: "阅读样式", fontSize: "字号", lineHeight: "行距", margin: "边距", measure: "行宽",
  fontFamily: "字体", fontSans: "系统黑体", fontSerif: "系统宋体", fontMono: "系统等宽",
  themeWhite: "白", themeGreen: "绿", themePaper: "纸", themeNight: "夜", bookmark: "书签",
  bookmarkAdd: "加书签", bookmarkNone: "还没有书签", bookmarkRemove: "删除", prev: "上一节", next: "下一节",
  part: "第 {index}/{total} 节", hits: "查找结果", hitNone: "没有匹配结果", jump: "跳转", toc: "目录",
  source: "来源", sourceOpen: "打开来源", quote: "摘录", images: "插图 {count}", selectForAgent: "交给 Agent",
};

function renderReader(document_: Parameters<typeof ReadingPane>[0]["document"], overrides: Partial<Parameters<typeof ReadingPane>[0]> = {}) {
  render(
    <ReadingPane
      document={document_}
      style={{ measurePx: 680, fontSizePx: 18, lineHeight: 1.7, marginPx: 16, theme: "white" }}
      labels={readingLabels}
      labelsExtra={{ sourceNeedsReview: "来源待复核", sourceMissing: "来源已失效", sourceRepair: "重新指定文件" }}
      onSearch={() => {}}
      hits={[]}
      onJump={() => {}}
      onProgress={() => {}}
      onNote={() => {}}
      onMore={() => {}}
      onPart={() => {}}
      onStyle={() => {}}
      bookmarks={[]}
      onBookmark={() => {}}
      onRemoveBookmark={() => {}}
      onOpenBookmark={() => {}}
      assets={{}}
      highlight={null}
      sourceCard={null}
      onBackToNote={() => {}}
      onRepair={() => {}}
      {...overrides}
    />,
  );
}

function readingDocument(overrides: Partial<NonNullable<Parameters<typeof ReadingPane>[0]["document"]>> = {}) {
  return {
    resourceId: "res_1",
    revisionId: "rev_1",
    title: "合成书",
    format: "txt",
    warnings: [],
    toc: [{ label: "正文", partId: "body" }],
    parts: [{ id: "body", kind: "text", length: 12, textLayer: true }],
    slice: { partId: "body", text: "甲乙丙丁戊己庚辛", start: 0, end: 8, kind: "text", textLayer: true, images: [] },
    progress: { locator: null, consumed: [], completion: "reading", restoredFrom: "progress", restoredRange: { start: 4, end: 6 } },
    readRanges: [{ partId: "body", start: 0, end: 4 }],
    assets: [],
    source: { available: true, hosted: false },
    ...overrides,
  } as NonNullable<Parameters<typeof ReadingPane>[0]["document"]>;
}

describe("reading surface", () => {
  it("marks the stored bookmark range in the body, and keeps the restored position out of the reading area (it is in the debug panel)", () => {
    renderReader(readingDocument(), { highlight: { start: 4, end: 6 } });
    expect(screen.getByTestId("reading-quote-hit").textContent).toBe("戊己");
    expect(screen.getByTestId("reading-body").textContent).toBe("甲乙丙丁戊己庚辛");
    expect(screen.queryByTestId("reading-restore-status")).toBeNull();
    const text = screen.getByTestId("reading-page").textContent ?? "";
    expect(text).not.toContain("已恢复上次位置");
    expect(text).not.toContain("已读范围");
    // A highlight outside the loaded window is not drawn as if it were on screen.
    cleanup();
    renderReader(readingDocument({ slice: { partId: "body", text: "甲乙", start: 0, end: 2, kind: "text", textLayer: true, images: [] } }), { highlight: { start: 4, end: 6 } });
    expect(screen.queryByTestId("reading-quote-hit")).toBeNull();
  });

  it("keeps an illustration at its text offset and reports a page whose image cannot be shown", () => {
    renderReader(readingDocument({
      slice: {
        partId: "c1",
        text: "前文后文",
        start: 0,
        end: 4,
        kind: "text",
        textLayer: true,
        images: [{ id: "img1", partId: "c1", name: "scan.png", mediaType: "image/png", bytes: 8 }],
        placements: [{ assetId: "img1", offset: 2 }],
      },
    }), { assets: { img1: "blob:scan" } });
    const image = screen.getByTestId("reading-image-img1");
    expect(image.getAttribute("data-offset")).toBe("2");
    expect(image.getAttribute("src")).toBe("blob:scan");
    expect(screen.getByTestId("reading-body").textContent).toContain("前文");
    cleanup();
    renderReader(readingDocument({
      format: "pdf",
      parts: [{ id: "page-1", kind: "image", length: 0, textLayer: false }],
      slice: { partId: "page-1", text: "", start: 0, end: 0, kind: "image", textLayer: false, images: [], placements: [] },
    }));
    expect(screen.getByTestId("reading-image-failed").textContent).toContain("图像无法显示");
  });

  it("keeps the highlight aligned when the text carries emoji before the marked range", () => {
    // Ranges are code points; the body is UTF-16, so an emoji must not shift the mark by one cell.
    expect(highlightSlices("😀甲乙丙丁", { start: 2, end: 4 }, 0, 4)).toEqual(["😀甲", "乙丙", "丁"]);
    expect(highlightSlices("😀甲乙丙丁", { start: 0, end: 2 }, 2, 4)).toBeNull();
    cleanup();
    renderReader(readingDocument({
      slice: { partId: "body", text: "😀甲乙丙丁", start: 0, end: 4, kind: "text", textLayer: true, images: [] },
    }), { highlight: { start: 2, end: 4 } });
    expect(screen.getByTestId("reading-quote-hit").textContent).toBe("乙丙");
    expect(screen.getByTestId("reading-body").textContent).toBe("😀甲乙丙丁");
  });

  it("shows the source state, the empty search result and the reading style controls", () => {
    const styled = vi.fn();
    renderReader(readingDocument({ source: { available: false, hosted: false, path: "missing-original/book.txt" } }), {
      sourceCard: { status: "unresolved", title: "合成书", quote: "丙丁" },
      searched: true,
      hits: [],
      onStyle: styled,
    });
    expect(screen.getByTestId("reading-source-card").getAttribute("data-source-status")).toBe("unresolved");
    // An unresolved source still offers the repair entry instead of pretending the link works.
    expect(screen.getByTestId("reading-source-repair")).toBeTruthy();
    expect(screen.getByTestId("reading-source-quote").textContent).toBe("丙丁");
    expect(screen.getByTestId("reading-missing")).toBeTruthy();
    // The search result is in the search panel.
    fireEvent.click(screen.getByTestId("reading-panel-search"));
    expect(screen.getByTestId("reading-hit-none")).toBeTruthy();
    // The style controls are in the settings panel.
    fireEvent.click(screen.getByTestId("reading-settings"));
    fireEvent.click(screen.getByTestId("reading-theme-night"));
    expect(styled).toHaveBeenCalledWith({ theme: "night" });
    fireEvent.click(screen.getByTestId("reading-theme-teal"));
    expect(styled).toHaveBeenCalledWith({ theme: "teal" });
    fireEvent.click(screen.getByTestId("reading-font-larger"));
    expect(styled).toHaveBeenCalledWith({ fontSizePx: 19 });
    fireEvent.click(screen.getByTestId("reading-mode-double"));
    expect(styled).toHaveBeenCalledWith({ pageMode: "double" });
  });

  it("chooses a part by its number, with no previous or next part button, and offers the bookmark list", () => {
    const opened = vi.fn();
    const part = vi.fn();
    renderReader(readingDocument({
      toc: [{ label: "第一节", partId: "c1" }, { label: "第二节", partId: "c2" }],
      parts: [{ id: "c1", kind: "text", length: 4, textLayer: true }, { id: "c2", kind: "text", length: 4, textLayer: true }],
      slice: { partId: "c2", text: "乙节正文", start: 0, end: 4, kind: "text", textLayer: true, images: [] },
    }), {
      bookmarks: [{ id: "bm_1", label: "第二节", locator: { kind: "text", partId: "c2", range: { start: 0, end: 2 } } }],
      onOpenBookmark: opened,
      onPart: part,
    });
    expect(screen.getByTestId("reading-part-position").textContent).toBe("第 2/2 节");
    expect(screen.queryByTestId("reading-next")).toBeNull();
    expect(screen.queryByTestId("reading-prev")).toBeNull();
    fireEvent.click(screen.getByTestId("reading-part-position"));
    fireEvent.change(screen.getByTestId("reading-part-input"), { target: { value: "1" } });
    fireEvent.keyDown(screen.getByTestId("reading-part-input"), { key: "Enter" });
    expect(part).toHaveBeenCalledWith("c1", 0);
    fireEvent.click(screen.getByTestId("reading-panel-bookmarks"));
    fireEvent.click(screen.getByTestId("reading-bookmark-bm_1"));
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: "bm_1" }));
  });

  it("jumps to the hit's full range instead of a fixed eight code points", () => {
    const jumped = vi.fn();
    renderReader(readingDocument(), {
      searched: true,
      hits: [{ text: "丙丁戊己庚", locator: { partId: "body", range: { start: 2, end: 7 } } }],
      onJump: jumped,
    });
    fireEvent.click(screen.getByTestId("reading-panel-search"));
    fireEvent.click(screen.getByTestId("reading-hit-0"));
    expect(jumped).toHaveBeenCalledWith("body", 2, 7);
  });
});


describe("editor regressions", () => {
  it("maps a repeated quote after emoji to the selected code-point range only", () => {
    const body = document.createElement("div");
    body.textContent = "😀重复句\n重复句";
    document.body.append(body);
    const range = document.createRange();
    range.setStart(body.firstChild!, 6);
    range.setEnd(body.firstChild!, 9);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(readingSelection(body, 100, selection)).toEqual({ quote: "重复句", start: 105, end: 108 });
    expect(readingSelection(document.createElement("div"), 100, selection)).toBeNull();
    selection.removeAllRanges();
    body.remove();
  });
  it("opens the anchored block and not the neighbouring comment", () => {
    const opened = vi.fn();
    renderEditor({
      blocks: [
        { id: "b1", type: "paragraph", text: "评论" },
        { id: "quote", type: "quote", text: "丙丁戊", anchorId: "anc-1" },
      ],
      onSave: async () => 2,
      onOpenSource: opened,
    });
    fireEvent.click(screen.getByTestId("note-block-source-quote"));
    expect(opened).toHaveBeenCalledWith("quote");
    expect(screen.queryByTestId("note-block-source-b1")).toBeNull();
  });
  it("starts at the stored revision instead of claiming unsaved work", () => {
    note(async () => 2);
    // Opening a note that the reader just recorded must not read as "尚未保存".
    expect(screen.getByTestId("note-editor").getAttribute("data-save-state")).toBe("saved");
  });
  it("saves a committed composition without requiring another keystroke", async () => {
    const saved: NoteBlock[][] = [];
    const editor = note(async (blocks) => { saved.push(blocks); return 2; });
    const surface = screen.getByTestId("note-surface");
    fireEvent.compositionStart(surface);
    act(() => { editor.commands.insertContent("中文"); });
    expect(screen.getByTestId("note-editor").getAttribute("data-save-state")).toBe("idle");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(saved).toHaveLength(0);
    fireEvent.compositionEnd(surface);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.[0]?.text).toContain("中文");
    expect(saved[0]?.[1]?.anchorId).toBe("anchor-1");
    expect(screen.getByTestId("note-editor").getAttribute("data-save-state")).toBe("saved");
  });

  it("splits the selected second paragraph and the shared undo restores text and identity", () => {
    const editor = note(async () => 2);
    act(() => { editor.commands.setTextSelection(8); });
    fireEvent.click(screen.getByTestId("note-split"));
    const nodes = editor.getJSON().content!;
    expect(nodes.map((node) => node.content?.map((child) => child.text ?? "").join(""))).toEqual(["第一段", "甲乙", "丙丁"]);
    expect(nodes.slice(0, 2).map((node) => node.attrs?.blockId)).toEqual(["b1", "b2"]);
    expect(new Set(nodes.map((node) => node.attrs?.blockId)).size).toBe(3);
    const thirdId = String(nodes[2]?.attrs?.blockId);
    expect(thirdId).not.toBe("b1");
    // Undo lives on the shared document history, so it also serves the source view.
    fireEvent.click(screen.getByTestId("note-undo"));
    expect(editor.getJSON().content?.map((node) => node.attrs?.blockId)).toEqual(["b1", "b2"]);
    expect(editor.getText()).toContain("甲乙丙丁");
    // Redo restores the split, and the identity of every block survives the round trip.
    fireEvent.click(screen.getByTestId("note-redo"));
    expect(editor.getJSON().content?.map((node) => node.attrs?.blockId)).toEqual(["b1", "b2", thirdId]);
  });

  it("serializes autosaves and uses the committed revision for a later edit", async () => {
    let finish!: (revision: number) => void;
    const calls: Array<{ blocks: NoteBlock[]; revision: number }> = [];
    const editor = note((blocks, revision) => {
      calls.push({ blocks, revision });
      return calls.length === 1 ? new Promise<number>((resolve) => { finish = resolve; }) : Promise.resolve(3);
    });
    act(() => { editor.commands.insertContent("A"); });
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => { editor.commands.insertContent("B"); });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(calls).toHaveLength(1);
    await act(async () => { finish(2); });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.revision).toBe(2);
    expect(calls[1]?.blocks[0]?.text).toContain("AB");
    expect(screen.getByTestId("note-editor").getAttribute("data-save-state")).toBe("saved");
  });

  it("keeps a newer draft when an older save finishes during composition", async () => {
    const drafts = memoryDrafts();
    let finish!: (revision: number) => void;
    const editor = note(() => new Promise<number>((resolve) => { finish = resolve; }), drafts);
    act(() => { editor.commands.insertContent("A"); });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const surface = screen.getByTestId("note-surface");
    fireEvent.compositionStart(surface);
    act(() => { editor.commands.insertContent("未提交组字"); });
    expect(drafts.peek("obj-1")?.blocks[0]?.text).toContain("未提交组字");
    await act(async () => { finish(2); });
    // The receipt only acknowledges A. A crash now must still recover the later text.
    expect(drafts.peek("obj-1")?.blocks[0]?.text).toContain("未提交组字");
    expect(screen.getByTestId("note-editor").getAttribute("data-save-state")).not.toBe("saved");
  });

  it("creates and switches every required block type from the toolbar", async () => {
    const saved: NoteBlock[][] = [];
    const editor = note(async (blocks) => { saved.push(blocks); return 2; });
    for (const type of ["heading", "list", "quote", "code", "plaintext"]) {
      fireEvent.click(screen.getByTestId(`note-insert-${type}`));
      await waitFor(() => expect(editor.getJSON().content?.some((node) => node.attrs?.blockType === type)).toBe(true));
    }
    // Switching the current block changes its type without losing the block identity.
    act(() => { editor.commands.setTextSelection(2); });
    fireEvent.click(screen.getByTestId("note-set-heading"));
    await waitFor(() => expect(saved.length).toBeGreaterThan(0));
    const last = saved.at(-1)!;
    expect(last.some((block) => block.type === "heading")).toBe(true);
    expect(new Set(last.map((block) => block.id)).size).toBe(last.length);
  });

  it("restores an unsaved draft and offers a real save failure state", async () => {
    const drafts = memoryDrafts();
    drafts.write("obj-draft", { blocks: [{ id: "b1", type: "paragraph", text: "草稿正文未被保存" }] });
    renderEditor({
      objectId: "obj-draft",
      blocks: [{ id: "b1", type: "paragraph", text: "已保存正文" }],
      drafts,
      onSave: async () => 2,
    });
    const restore = await screen.findByTestId("note-draft-restore");
    fireEvent.click(restore);
    await waitFor(() => expect(screen.getByTestId("note-surface").textContent).toContain("草稿正文未被保存"));
    expect(screen.getByTestId("note-editor").getAttribute("data-save-state")).toBe("saved");
    cleanup();

    const failing = memoryDrafts();
    renderEditor({
      objectId: "obj-fail",
      blocks: [{ id: "b1", type: "paragraph", text: "起点" }],
      drafts: failing,
      onSave: async () => { throw new Error("note revision changed"); },
    });
    const surface = screen.getByTestId("note-surface") as HTMLElement & { editor: Editor };
    act(() => { surface.editor.commands.insertContent("未保存"); });
    await waitFor(() => expect(screen.getByTestId("note-editor").getAttribute("data-save-state")).toBe("error"));
    expect(screen.getByTestId("note-conflict")).toBeTruthy();
    // A failed save must leave a draft behind instead of claiming success.
    expect(failing.peek("obj-fail")).toBeTruthy();
    expect(screen.getByTestId("note-retry-save")).toBeTruthy();
  });

  it("keeps the rich view in step with the source editor instead of overwriting it", async () => {
    const saved: NoteBlock[][] = [];
    const editor = note(async (blocks) => { saved.push(blocks); return 2; });
    // Only code/plaintext blocks expose the source editor, so create one first.
    fireEvent.click(screen.getByTestId("note-insert-code"));
    await waitFor(() => expect(screen.queryByTestId(/^source-/)).toBeTruthy());
    const sourceButton = screen.getByTestId(/^source-/);
    const sourceBlockId = sourceButton.getAttribute("data-testid")!.replace("source-", "");
    fireEvent.click(sourceButton);
    const source = screen.getByTestId("note-source");
    expect(source.getAttribute("data-block-id")).toBe(sourceBlockId);
    fireEvent.click(screen.getByTestId("note-block-copy"));
    await waitFor(() => expect(saved.length).toBeGreaterThan(0));
    const blocks = saved.at(-1)!;
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
    // A copy of the anchored quote never inherits the source anchor.
    expect(blocks.filter((block) => block.anchorId === "anchor-1")).toHaveLength(1);
    void editor;
  });
});
