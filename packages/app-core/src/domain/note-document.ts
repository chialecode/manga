import { MangaError } from "@manga/contracts/errors";
import { type NoteBlock, type NoteDocument } from "@manga/contracts/reading";
import { codePointLength, sliceCodePoints } from "./text.ts";

export type NoteOp =
  | { type: "setText"; blockId: string; text: string }
  | { type: "setType"; blockId: string; blockType: string; level?: number | null; ordered?: boolean | null }
  | { type: "split"; blockId: string; offset: number }
  | { type: "merge"; blockId: string }
  | { type: "move"; blockId: string; toIndex: number }
  | { type: "copy"; blockId: string }
  | { type: "insert"; atIndex: number; blockType: string; text?: string; level?: number; ordered?: boolean }
  | { type: "remove"; blockId: string }
  | { type: "replace"; blocks: NoteBlock[]; title?: string };

const BLOCK_TYPES = new Set(["paragraph", "heading", "list", "quote", "code", "plaintext"]);

function normalizeType(type: string): string {
  // Unknown types from a future editor build are preserved rather than rewritten.
  return type;
}

export function coerceNoteDocument(payload: unknown): NoteDocument {
  const value = payload as { blocks?: Array<Partial<NoteBlock> & { text?: string; attrs?: Record<string, unknown> }>; tags?: string[] };
  const blocks = value?.blocks ?? [];
  if (!blocks.length) throw new MangaError("VALIDATION_ERROR", "note has no blocks");
  return {
    schemaVersion: 2,
    blocks: blocks.map((block) => {
      if (!block.id || typeof block.text !== "string") throw new MangaError("VALIDATION_ERROR", "note block is missing an id or text");
      const type = block.type ?? "paragraph";
      return {
        id: block.id,
        type,
        text: block.text,
        ...(block.level ? { level: block.level } : {}),
        ...(block.ordered ? { ordered: true } : {}),
        ...(block.anchorId ? { anchorId: block.anchorId } : {}),
        ...(block.attrs ? { attrs: block.attrs } : {}),
      };
    }),
    ...(Array.isArray(value.tags) && value.tags.length ? { tags: value.tags.filter((tag) => typeof tag === "string" && tag.length > 0) } : {}),
  };
}

export function notePlainText(document: NoteDocument): string {
  return document.blocks.map((block) => block.text).join("\n");
}

function clone(document: NoteDocument): NoteDocument {
  return {
    schemaVersion: 2,
    blocks: document.blocks.map((block) => ({ ...block })),
    ...(document.tags ? { tags: [...document.tags] } : {}),
  };
}

export function applyNoteOp(document: NoteDocument, op: NoteOp, nextId: () => string): NoteDocument {
  const next = clone(document);
  if (op.type === "replace") {
    const ids = new Set<string>();
    for (const block of op.blocks) {
      if (ids.has(block.id)) throw new MangaError("VALIDATION_ERROR", "duplicate block id");
      ids.add(block.id);
    }
    return { ...next, blocks: op.blocks.map((block) => ({ ...block })) };
  }
  const index = next.blocks.findIndex((block) => block.id === ("blockId" in op ? op.blockId : ""));
  if (op.type === "insert") {
    if (op.atIndex < 0 || op.atIndex > next.blocks.length) throw new MangaError("VALIDATION_ERROR", "insert index is outside the block list");
    const block: NoteBlock = {
      id: nextId(),
      type: normalizeType(op.blockType),
      text: op.text ?? "",
      ...(op.blockType === "heading" && op.level ? { level: op.level } : {}),
      ...(op.blockType === "list" && op.ordered ? { ordered: true } : {}),
    };
    next.blocks.splice(op.atIndex, 0, block);
    return next;
  }
  if (index < 0) throw new MangaError("VALIDATION_ERROR", "editable note block missing");
  const block = next.blocks[index]!;
  if (op.type === "setText") {
    block.text = op.text;
    return next;
  }
  if (op.type === "setType") {
    block.type = normalizeType(op.blockType);
    if (op.blockType === "heading") {
      block.level = op.level ?? block.level ?? 1;
      delete block.ordered;
    } else if (op.blockType === "list") {
      if (op.ordered) block.ordered = true; else delete block.ordered;
      delete block.level;
    } else {
      delete block.level;
      delete block.ordered;
    }
    return next;
  }
  if (op.type === "remove") {
    // A note document always keeps at least one block so the editor has an editable surface.
    if (next.blocks.length <= 1) throw new MangaError("VALIDATION_ERROR", "a note must keep at least one block");
    next.blocks.splice(index, 1);
    return next;
  }
  if (op.type === "split") {
    const length = codePointLength(block.text);
    if (op.offset <= 0 || op.offset >= length) throw new MangaError("VALIDATION_ERROR", "split offset must stay inside the block");
    // The first half keeps the block and anchor identity; the tail is a new block without a source.
    const tail: NoteBlock = { ...block, id: nextId(), text: sliceCodePoints(block.text, op.offset, length) };
    delete tail.anchorId;
    next.blocks.splice(index + 1, 0, tail);
    block.text = sliceCodePoints(block.text, 0, op.offset);
    return next;
  }
  if (op.type === "merge") {
    const following = next.blocks[index + 1];
    if (!following) throw new MangaError("VALIDATION_ERROR", "there is no following block to merge");
    block.text = `${block.text}${following.text}`;
    next.blocks.splice(index + 1, 1);
    return next;
  }
  if (op.type === "move") {
    const [item] = next.blocks.splice(index, 1);
    const target = Math.max(0, Math.min(op.toIndex, next.blocks.length));
    next.blocks.splice(target, 0, item!);
    return next;
  }
  // A copy is a new block with a new identity, and it must not claim the original's source anchor.
  const copy: NoteBlock = { ...block, id: nextId() };
  delete copy.anchorId;
  next.blocks.splice(index + 1, 0, copy);
  return next;
}

export function uniqueBlockIds(ids: Array<string | null>, nextId: () => string): string[] {
  const seen = new Set<string>();
  return ids.map((id) => {
    if (!id || seen.has(id)) {
      const created = nextId();
      seen.add(created);
      return created;
    }
    seen.add(id);
    return id;
  });
}

export function isKnownBlockType(type: string): boolean {
  return BLOCK_TYPES.has(type);
}
