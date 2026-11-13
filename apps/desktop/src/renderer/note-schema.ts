import type { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { NoteBlock } from "@manga/contracts/reading";
import { uniqueBlockIds } from "../../../../packages/app-core/src/domain/note-document.ts";
import type { EmbedAttr } from "./embed/embed-types.ts";

export const MangaDoc = Document.extend({
  content: "(mangaBlock|mangaEmbed|mangaScreenshot)+",
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _old, state) {
        if (!transactions.some((transaction) => transaction.docChanged)) return null;
        const seen = new Set<string>();
        const tr = state.tr;
        state.doc.forEach((node, pos) => {
          const original = node.attrs.blockId as string;
          const duplicate = !original || seen.has(original);
          const blockId = duplicate ? `b_${crypto.randomUUID()}` : original;
          seen.add(blockId);
          if (duplicate) tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId, anchorId: null });
        });
        return tr.docChanged ? tr : null;
      },
    })];
  },
});

export const MangaBlock = Node.create({
  name: "mangaBlock",
  group: "block",
  content: "text*",
  defining: true,
  addAttributes() {
    return {
      blockId: { default: "b1" },
      blockType: { default: "paragraph" },
      level: { default: null },
      ordered: { default: null },
      anchorId: { default: null },
      // Payload written by a newer editor build; kept verbatim instead of being dropped on the round trip.
      noteAttrs: { default: null },
    };
  },
  parseHTML: () => [{ tag: "div[data-block-id]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, {
    "data-block-id": HTMLAttributes.blockId,
    "data-block-type": HTMLAttributes.blockType,
    // Heading level and list style are visible in the editor, not just stored attributes.
    "data-level": HTMLAttributes.level ?? undefined,
    "data-ordered": HTMLAttributes.ordered ? "true" : undefined,
    "data-testid": `block-${HTMLAttributes.blockId}`,
  }), 0],
  addKeyboardShortcuts() {
    return { Enter: () => this.editor.view.composing ? false : this.editor.commands.splitBlock() };
  },
});

/** An embed block carries what it points at in `attrs.embed`; a block of type `embed` without it is an ordinary (empty) block. */
const embedOf = (block: NoteBlock): EmbedAttr | null => block.type === "embed" && block.attrs && typeof block.attrs.embed === "object" && block.attrs.embed ? block.attrs.embed as EmbedAttr : null;

/** A screenshot block carries the id of the screenshot in `attrs.screenshotId`; the picture stays in the folder of its work. */
const screenshotOf = (block: NoteBlock): string | null => block.type === "screenshot" && block.attrs && typeof block.attrs.screenshotId === "string" && block.attrs.screenshotId ? block.attrs.screenshotId : null;

export function contentFrom(blocks: NoteBlock[]) {
  return {
    type: "doc",
    content: blocks.map((block) => screenshotOf(block) ? {
      type: "mangaScreenshot",
      attrs: { blockId: block.id, anchorId: block.anchorId ?? null, screenshotId: screenshotOf(block) },
    } : embedOf(block) ? {
      type: "mangaEmbed",
      attrs: { blockId: block.id, anchorId: block.anchorId ?? null, embed: embedOf(block) },
    } : {
      type: "mangaBlock",
      attrs: { blockId: block.id, blockType: block.type, level: block.level, ordered: block.ordered, anchorId: block.anchorId, noteAttrs: block.attrs ?? null },
      content: block.text ? [{ type: "text", text: block.text }] : [],
    }),
  };
}

export function blocksFromEditor(editor: Editor): NoteBlock[] {
  const raw: NoteBlock[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === "mangaScreenshot") {
      raw.push({ id: String(node.attrs.blockId ?? ""), type: "screenshot", text: "", ...(node.attrs.anchorId != null ? { anchorId: node.attrs.anchorId } : {}), attrs: { screenshotId: String(node.attrs.screenshotId ?? "") } });
      return;
    }
    if (node.type.name === "mangaEmbed") {
      raw.push({ id: String(node.attrs.blockId ?? ""), type: "embed", text: "", ...(node.attrs.anchorId != null ? { anchorId: node.attrs.anchorId } : {}), attrs: { embed: node.attrs.embed as EmbedAttr } });
      return;
    }
    if (node.type.name !== "mangaBlock") return;
    raw.push({
      id: String(node.attrs.blockId ?? ""),
      type: String(node.attrs.blockType ?? "paragraph"),
      text: node.textContent,
      ...(node.attrs.level != null ? { level: node.attrs.level } : {}),
      ...(node.attrs.ordered != null ? { ordered: node.attrs.ordered } : {}),
      ...(node.attrs.anchorId != null ? { anchorId: node.attrs.anchorId } : {}),
      ...(node.attrs.noteAttrs ? { attrs: node.attrs.noteAttrs as Record<string, unknown> } : {}),
    });
  });
  const ids = uniqueBlockIds(raw.map((block) => block.id), () => `b_${crypto.randomUUID().slice(0, 8)}`);
  return raw.map((block, index) => ({ ...block, id: ids[index] ?? block.id }));
}

function codePoints(text: string): number {
  return [...text].length;
}

/** Where the caret currently sits, as a block id plus a code-point offset inside it. */
export function caretLocation(editor: Editor): { blockId: string; offset: number; index: number } | null {
  const { from } = editor.state.selection;
  let found: { blockId: string; offset: number; index: number } | null = null;
  let index = 0;
  editor.state.doc.forEach((node, pos) => {
    const start = pos + 1;
    const end = start + node.content.size;
    if (from >= start && from <= end && !found) {
      found = { blockId: String(node.attrs.blockId ?? ""), offset: codePoints(editor.state.doc.textBetween(start, from, "\n", "\n")), index };
    }
    index += 1;
  });
  return found;
}

/** The unsaved draft is kept per note so leaving the page or closing the window cannot lose it. */
function draftKey(objectId: string): string {
  return `manga.note.draft.${objectId}`;
}

export type DraftStore = {
  read(objectId: string): { blocks: NoteBlock[]; title?: string; tags?: string[]; savedAt: string } | null;
  write(objectId: string, draft: { blocks: NoteBlock[]; title?: string; tags?: string[] }): void;
  clear(objectId: string): void;
};

export const localStorageDrafts: DraftStore = {
  read(objectId) {
    try {
      const raw = window.localStorage.getItem(draftKey(objectId));
      return raw ? JSON.parse(raw) as { blocks: NoteBlock[]; savedAt: string } : null;
    } catch {
      return null;
    }
  },
  write(objectId, draft) {
    try {
      window.localStorage.setItem(draftKey(objectId), JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
    } catch {
      // A full or unavailable store must not break editing; the in-memory state stays authoritative.
    }
  },
  clear(objectId) {
    try {
      window.localStorage.removeItem(draftKey(objectId));
    } catch {
      // ignore
    }
  },
};
