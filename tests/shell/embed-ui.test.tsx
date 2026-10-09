/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import type { NoteBlock } from "@manga/contracts";
import { NoteEditor } from "../../apps/desktop/src/renderer/note-editor.tsx";
import type { EmbedItem } from "../../apps/desktop/src/renderer/embed/embed-types.ts";

Element.prototype.scrollIntoView = () => {};
const i18n = createTranslator("zh-CN");
const t = i18n.t;

const labels = {
  blockInsert: "插入块", blockRemove: "删除块", blockMoveUp: "上移", blockMoveDown: "下移", blockCopy: "复制块", blockMerge: "与下一块合并", blockType: "块类型",
  typeParagraph: "正文", typeHeading: "标题", typeList: "列表", typeQuote: "引用", typeCode: "代码", typePlain: "纯文本", draftRestored: "已恢复未保存的草稿",
  draftDiscard: "丢弃草稿", conflict: "冲突", sourceStale: "来源已失效", repairSource: "重新指定来源文件", undo: "撤销", redo: "重做", undoHint: "撤销", sourceEdit: "编辑此块源码",
};

const memoryDrafts = () => ({ read: () => null, write: () => undefined, clear: () => undefined });
const embedBlock = (id: string, kind: string, targetId: string, extra: Record<string, unknown> = {}): NoteBlock => ({ id, type: "embed", text: "", attrs: { embed: { kind, targetId, ...extra } } });
const item = (slot: string, patch: Partial<EmbedItem>): EmbedItem => ({
  id: `emb-${slot}`, slot, sourceKind: "note", sourceId: "obj-1", targetKind: "whiteboard", targetId: "wb-1", locator: {}, mode: "live", state: "valid", title: "目标白板",
  summary: "2 个对象：甲 · 乙", takenAt: null, recovery: ["open", "remove"], ...patch,
});

type Props = { blocks: NoteBlock[]; items?: Record<string, EmbedItem>; onSave?: (blocks: NoteBlock[], revision: number) => Promise<number | void>; enabled?: boolean };
function setup(input: Props) {
  const onOpen = vi.fn();
  const onEnable = vi.fn();
  const onRefresh = vi.fn();
  const onSave = input.onSave ?? vi.fn(async () => 2);
  render(
    <NoteEditor
      objectId="obj-1" document={{ schemaVersion: 2, blocks: input.blocks }} revision={1} title="笔记" tags={[]}
      saveLabel="尚未保存" savingLabel="正在保存" savedLabel="已保存" failedLabel="没有保存成功" splitLabel="拆分段落" sourceLabel="源编辑"
      labels={labels} drafts={memoryDrafts()}
      embeds={input.enabled === false ? undefined : { t, formatDate: (iso) => iso.slice(0, 10), items: input.items ?? {}, onOpen, onEnable, onRefresh }}
      onSave={onSave}
    />,
  );
  return { onOpen, onEnable, onRefresh, onSave: onSave as ReturnType<typeof vi.fn> };
}
/** The node views of Tiptap mount after the first render, so the cards are waited for rather than expected at once. */
const cardsShown = async (count = 1) => { await waitFor(() => expect(document.querySelectorAll("[data-embed-state]").length).toBeGreaterThanOrEqual(count)); };
const lastSaved = (onSave: ReturnType<typeof vi.fn>) => onSave.mock.calls.at(-1)?.[0] as NoteBlock[];

function installHost(handlers: Record<string, (input: Record<string, any>) => unknown>) {
  const calls: Array<{ commandId: string; input: Record<string, any> }> = [];
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, any> }) {
      calls.push({ commandId: payload.commandId, input: payload.input ?? {} });
      const handler = handlers[payload.commandId];
      return { status: "ok", value: handler ? handler(payload.input ?? {}) : {} };
    },
  };
  return calls;
}

afterEach(() => { cleanup(); Reflect.deleteProperty(window, "manga"); });

describe("embed blocks in a note (AT-28)", () => {
  it("shows an embed block as a card with its kind, title, mode and summary, and opens its target", async () => {
    const view = setup({ blocks: [{ id: "p1", type: "paragraph", text: "正文" }, embedBlock("e1", "whiteboard", "wb-1")], items: { e1: item("e1", {}) } });
    await cardsShown();
    const card = screen.getByTestId("embed-e1");
    expect(card.getAttribute("data-embed-state")).toBe("valid");
    expect(within(card).getByTestId("embed-title-e1").textContent).toBe("目标白板");
    expect(within(card).getByTestId("embed-mode-e1").textContent).toBe("跟随原对象");
    expect(within(card).getByTestId("embed-summary-e1").textContent).toBe("2 个对象：甲 · 乙");
    expect(within(card).queryByTestId("embed-state-e1")).toBeNull();
    fireEvent.click(within(card).getByTestId("embed-open-e1"));
    expect(view.onOpen).toHaveBeenCalledWith(expect.objectContaining({ targetId: "wb-1" }));
  });

  it("says what is wrong with a deleted target, a module that is off and a loop, and offers only what helps", async () => {
    const view = setup({
      blocks: [{ id: "p1", type: "paragraph", text: "正文" }, embedBlock("d", "mindmap", "map1", { mode: "snapshot" }), embedBlock("o", "whiteboard", "wb-1"), embedBlock("c", "note", "n2")],
      items: {
        d: item("d", { targetKind: "mindmap", state: "deleted", mode: "snapshot", title: "旧导图", summary: "1 个节点：中心", takenAt: "2026-05-01T00:00:00.000Z", recovery: ["keepSnapshot", "remove"] }),
        o: item("o", { state: "disabled", recovery: ["enable", "remove"] }),
        c: item("c", { targetKind: "note", state: "cycle", title: "笔记乙", recovery: ["remove"] }),
      },
    });
    await cardsShown(3);
    expect(screen.getByTestId("embed-state-d").textContent).toBe("原对象已删除");
    // The snapshot still shows what it saw, with when it was taken.
    expect(screen.getByTestId("embed-summary-d").textContent).toBe("1 个节点：中心");
    expect(screen.getByTestId("embed-taken-d").textContent).toBe("取自 2026-05-01");
    expect(screen.queryByTestId("embed-open-d")).toBeNull();
    expect(screen.getByTestId("embed-keep-d")).toBeTruthy();
    expect(screen.getByTestId("embed-state-o").textContent).toBe("对应功能已关闭");
    fireEvent.click(screen.getByTestId("embed-enable-o"));
    expect(view.onEnable).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("embed-state-c").textContent).toBe("循环嵌入");
    expect(screen.queryByTestId("embed-open-c")).toBeNull();
    expect(screen.getByTestId("embed-remove-c")).toBeTruthy();
  });

  it("refreshes a snapshot that is older than its target", async () => {
    const view = setup({ blocks: [embedBlock("s", "whiteboard", "wb-1", { mode: "snapshot" })], items: { s: item("s", { mode: "snapshot", takenAt: "2026-05-01T00:00:00.000Z", recovery: ["refresh", "open", "remove"] }) } });
    await cardsShown();
    fireEvent.click(screen.getByTestId("embed-refresh-s"));
    expect(view.onRefresh).toHaveBeenCalledWith("s");
  });

  it("removes an embed block and saves the note without it", async () => {
    const view = setup({ blocks: [{ id: "p1", type: "paragraph", text: "正文" }, embedBlock("e1", "whiteboard", "wb-1")], items: { e1: item("e1", {}) } });
    await cardsShown();
    fireEvent.click(screen.getByTestId("embed-remove-e1"));
    await waitFor(() => expect(view.onSave).toHaveBeenCalled());
    expect(lastSaved(view.onSave).map((block) => block.id)).toEqual(["p1"]);
    expect(screen.queryByTestId("embed-e1")).toBeNull();
  });

  it("keeps what a snapshot saw as an ordinary quote when the target is gone", async () => {
    const view = setup({
      blocks: [{ id: "p1", type: "paragraph", text: "正文" }, embedBlock("d", "mindmap", "map1", { mode: "snapshot" })],
      items: { d: item("d", { targetKind: "mindmap", state: "deleted", mode: "snapshot", title: "旧导图", summary: "1 个节点：中心", takenAt: "2026-05-01T00:00:00.000Z", recovery: ["keepSnapshot", "remove"] }) },
    });
    await cardsShown();
    fireEvent.click(screen.getByTestId("embed-keep-d"));
    await waitFor(() => expect(view.onSave).toHaveBeenCalled());
    expect(lastSaved(view.onSave)[1]).toEqual({ id: "d", type: "quote", text: "旧导图：1 个节点：中心" });
    expect(screen.queryByTestId("embed-d")).toBeNull();
  });

  it("inserts an embed from the picker, as a block that stores what it points at, and keeps the note itself off the list", async () => {
    installHost({
      "notes.list": () => [{ objectId: "obj-1", title: "本笔记" }, { objectId: "n2", title: "另一篇" }],
      "whiteboard.list": () => ({ boards: [{ id: "wb-1", title: "白板一" }] }),
      "mindmap.list": () => ({ maps: [{ id: "map1", title: "导图一" }] }),
    });
    const view = setup({ blocks: [{ id: "p1", type: "paragraph", text: "正文" }] });
    fireEvent.click(screen.getByTestId("note-insert-embed"));
    const picker = await screen.findByTestId("embed-picker");
    await within(picker).findByTestId("embed-pick-n2");
    expect(within(picker).queryByTestId("embed-pick-obj-1")).toBeNull();
    fireEvent.click(within(picker).getByTestId("embed-kind-whiteboard"));
    fireEvent.click(await within(picker).findByTestId("embed-pick-wb-1"));
    expect(screen.queryByTestId("embed-picker")).toBeNull();
    await waitFor(() => expect(view.onSave).toHaveBeenCalled());
    const saved = lastSaved(view.onSave);
    expect(saved.map((block) => block.type)).toEqual(["paragraph", "embed"]);
    expect(saved[1]!.attrs).toEqual({ embed: { kind: "whiteboard", targetId: "wb-1", mode: "live", label: "白板一" } });
    // Until the save has registered it, the card shows the name it was picked under.
    await cardsShown();
    expect(screen.getByTestId(`embed-title-${saved[1]!.id}`).textContent).toBe("白板一");
  });

  it("inserts a snapshot embed when asked to freeze the current content", async () => {
    installHost({ "notes.list": () => [], "whiteboard.list": () => ({ boards: [] }), "mindmap.list": () => ({ maps: [{ id: "map1", title: "导图一" }] }) });
    const view = setup({ blocks: [{ id: "p1", type: "paragraph", text: "正文" }] });
    fireEvent.click(screen.getByTestId("note-insert-embed"));
    const picker = await screen.findByTestId("embed-picker");
    fireEvent.click(within(picker).getByTestId("embed-kind-mindmap"));
    fireEvent.click(within(picker).getByTestId("embed-snapshot"));
    fireEvent.click(await within(picker).findByTestId("embed-pick-map1"));
    await waitFor(() => expect(view.onSave).toHaveBeenCalled());
    expect(lastSaved(view.onSave)[1]!.attrs).toMatchObject({ embed: { kind: "mindmap", targetId: "map1", mode: "snapshot" } });
  });

  it("does not merge an embed block into text, and does not retype it", async () => {
    // The first block is the one the toolbar acts on until the caret is somewhere else.
    const view = setup({ blocks: [embedBlock("e1", "whiteboard", "wb-1"), { id: "p1", type: "paragraph", text: "正文" }], items: { e1: item("e1", {}) } });
    await cardsShown();
    fireEvent.click(screen.getByTestId("note-block-merge"));
    fireEvent.click(screen.getByTestId("note-set-quote"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(view.onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("embed-e1")).toBeTruthy();
  });

  it("offers no embed button when the module is off, and an embed block already there stays a plain, readable card", async () => {
    setup({ blocks: [{ id: "p1", type: "paragraph", text: "正文" }, embedBlock("e1", "whiteboard", "wb-1", { label: "白板一" })], enabled: false });
    expect(screen.queryByTestId("note-insert-embed")).toBeNull();
    await cardsShown();
    expect(screen.getByTestId("embed-e1").textContent).toContain("白板一");
  });
});
