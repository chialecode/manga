import fs from "node:fs";
import path from "node:path";
import { toMarkdown } from "mdast-util-to-markdown";
import type { NoteBlock } from "@manga/contracts/reading";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { coerceNoteDocument } from "./domain/note-document.ts";
import { safeName, type FileTarget, type WorkFolders } from "./work-folders.ts";

/**
 * The notes written as files (A-88, Q-31). A note stays in the database, which is its record; for each note that belongs to a resource or a work a
 * Markdown file is written into the `笔记` folder next to the screenshots and recordings, so the person's work for a title is in one place that other
 * tools can open. The file is written one way: what is changed in it is not read back, and it says so at the top.
 *
 * Saving a note queues one write; saves that follow each other close together become one (the last text is what is written). A title change
 * renames the file, deleting a note removes it, restoring a note writes it again. A note that belongs to neither a resource nor a work (a global
 * or a project note) has no folder to be in and is not written.
 */

type Tree = Parameters<typeof toMarkdown>[0];
type Node = Extract<Tree, { type: "root" }>["children"][number];

type NoteRow = { id: string; title: string; payload_json: string; scope_json: string; work_id: string | null; deleted_at: string | null };
type RecordRow = { id: string; folder_id: string; file_name: string; bytes: number };

const NOTICE = "由 MANGA 生成，在这里修改不会写回应用。";
const DEFAULT_DELAY_MS = 600;

const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h ? `${String(h).padStart(2, "0")}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const text = (value: string): Node => ({ type: "text", value });
const paragraph = (...children: Node[]): Node => ({ type: "paragraph", children } as Node);
/** Text with its line ends kept: a single newline in a block is a line break in the file. */
const lines = (value: string): Node[] => value.split(/\r?\n/).flatMap((line, at) => (at ? [{ type: "break" } as Node, text(line)] : [text(line)]));

export type NoteFilesOptions = {
  /** Wait before a queued write is made; saves inside it are merged. */
  delayMs?: number;
  onError?: (reason: string) => void;
};

export class NoteFiles {
  private readonly store: DrizzleStore;
  private readonly folders: WorkFolders;
  private readonly delayMs: number;
  private readonly onError: (reason: string) => void;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private off: (() => void) | null = null;
  /** How many writes were made, to see that saves are merged. */
  writes = 0;

  constructor(store: DrizzleStore, folders: WorkFolders, options: NoteFilesOptions = {}) {
    this.store = store;
    this.folders = folders;
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.onError = options.onError ?? (() => undefined);
  }

  /** Follow what is saved: every committed note event queues a write. */
  attach(): void {
    this.off?.();
    this.off = this.store.onEvent((event) => {
      if (!event.type.startsWith("note.")) return;
      const objectId = event.payload.objectId;
      if (typeof objectId === "string") this.queue(objectId);
    });
  }

  queue(objectId: string): void {
    const waiting = this.timers.get(objectId);
    if (waiting) clearTimeout(waiting);
    const timer = setTimeout(() => {
      this.timers.delete(objectId);
      this.run(objectId);
    }, this.delayMs);
    timer.unref?.();
    this.timers.set(objectId, timer);
  }

  /** Make the writes that are waiting now; the application does this before it closes. */
  flush(): void {
    for (const [objectId, timer] of [...this.timers]) {
      clearTimeout(timer);
      this.timers.delete(objectId);
      this.run(objectId);
    }
  }

  dispose(): void {
    this.off?.();
    this.off = null;
    try { this.flush(); } catch { /* the store may already be closed */ }
  }

  private run(objectId: string): void {
    try { this.sync(objectId); } catch (error) { this.onError(error instanceof Error ? error.message : String(error)); }
  }

  // ------------------------------------------------------------------ one note

  private recordsOf(objectId: string): RecordRow[] {
    return this.store.sqlite.prepare("SELECT id, folder_id, file_name, bytes FROM work_files WHERE kind = 'note' AND ref_kind = 'note' AND ref_id = ? ORDER BY created_at, rowid").all(objectId) as RecordRow[];
  }

  /** What a note's file is for, or null when the note has no place for a file. */
  private targetOf(row: NoteRow): FileTarget | null {
    let resourceId: string | null = null;
    try {
      const scope = JSON.parse(row.scope_json) as { kind?: string; resourceId?: string | null };
      if (scope.kind === "library" && typeof scope.resourceId === "string") resourceId = scope.resourceId;
    } catch { /* a scope that cannot be read means no resource */ }
    if (resourceId && this.store.sqlite.prepare("SELECT 1 FROM resources WHERE id = ?").get(resourceId)) return { resourceId, workId: row.work_id };
    if (row.work_id && (this.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(row.work_id) || this.store.sqlite.prepare("SELECT 1 FROM removed_works WHERE id = ?").get(row.work_id))) return { workId: row.work_id };
    return null;
  }

  /** The file of a note: written, renamed, or removed so that it says what the database says. */
  sync(objectId: string): "written" | "unchanged" | "removed" | "skipped" {
    const row = this.store.sqlite.prepare("SELECT id, title, payload_json, scope_json, work_id, deleted_at FROM content_objects WHERE id = ? AND type = 'notes.document'").get(objectId) as NoteRow | undefined;
    const records = this.recordsOf(objectId);
    if (!row || row.deleted_at) {
      for (const record of records) this.drop(record.id);
      return records.length ? "removed" : "skipped";
    }
    const target = this.targetOf(row);
    if (!target) {
      for (const record of records) this.drop(record.id);
      return records.length ? "removed" : "skipped";
    }
    let place: ReturnType<WorkFolders["dirFor"]>;
    try { place = this.folders.dirFor(target, "note"); } catch (error) {
      for (const record of records) this.drop(record.id);
      this.onError(error instanceof Error ? error.message : String(error));
      return "skipped";
    }
    // One file for a note: the first record in the right folder is kept, any other is a leftover.
    const keep = records.find((record) => record.folder_id === place.folder.id);
    for (const record of records) if (record !== keep) this.drop(record.id);
    const wanted = `${safeName(row.title || "笔记", "笔记")}.md`;
    let fileId: string;
    let fileName: string;
    if (keep) {
      fileId = keep.id;
      fileName = keep.file_name === wanted || stemMatches(keep.file_name, wanted) ? keep.file_name : this.folders.renameFile(keep.id, wanted);
    } else {
      fileName = this.folders.uniqueName(place.dir, wanted);
      fs.writeFileSync(path.join(place.dir, fileName), "");
      fileId = this.folders.record(target, { kind: "note", fileName, resourceId: typeof target === "string" ? null : target.resourceId ?? null, refKind: "note", refId: objectId });
    }
    const body = Buffer.from(this.render(row, place.folder.id, target), "utf8");
    const file = path.join(place.dir, fileName);
    let current: Buffer | null = null;
    try { current = fs.readFileSync(file); } catch { /* not there yet */ }
    if (current?.equals(body)) return "unchanged";
    const part = `${file}.part`;
    fs.writeFileSync(part, body);
    fs.renameSync(part, file);
    this.store.sqlite.prepare("UPDATE work_files SET bytes = ? WHERE id = ?").run(body.length, fileId);
    this.writes += 1;
    return "written";
  }

  /** Forget the file of a note and delete it; written to the journal first, so a stop leaves nothing half removed. */
  private drop(fileId: string): void {
    const file = this.folders.file(fileId);
    if (!file) return;
    const location = this.folders.pathOf(fileId);
    const folderId = file.folderId;
    if (location) {
      const journal = this.folders.journalRemoval(location);
      this.store.sqlite.prepare("DELETE FROM work_files WHERE id = ?").run(fileId);
      this.folders.finishRemoval(journal, location);
    } else {
      this.store.sqlite.prepare("DELETE FROM work_files WHERE id = ?").run(fileId);
    }
    this.folders.pruneIfEmpty(folderId);
  }

  // ------------------------------------------------------------------ many notes

  private allIds(): string[] {
    const ids = new Set((this.store.sqlite.prepare("SELECT id FROM content_objects WHERE type = 'notes.document'").all() as Array<{ id: string }>).map((row) => row.id));
    for (const row of this.store.sqlite.prepare("SELECT DISTINCT ref_id AS id FROM work_files WHERE kind = 'note' AND ref_kind = 'note'").all() as Array<{ id: string }>) ids.add(row.id);
    return [...ids];
  }

  /** Every note: the files that are missing are written, the ones that are out of date are rewritten, the ones that have no note are removed. Can be stopped and started again. */
  async syncAll(options: { batch?: number; stop?: () => boolean } = {}): Promise<{ written: number; removed: number; looked: number; finished: boolean }> {
    const ids = this.allIds();
    const batch = options.batch ?? 25;
    let written = 0;
    let removed = 0;
    for (let at = 0; at < ids.length; at += batch) {
      if (options.stop?.()) return { written, removed, looked: at, finished: false };
      for (const id of ids.slice(at, at + batch)) {
        try {
          const result = this.sync(id);
          if (result === "written") written += 1;
          if (result === "removed") removed += 1;
        } catch (error) { this.onError(error instanceof Error ? error.message : String(error)); }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { written, removed, looked: ids.length, finished: true };
  }

  /** The notes of some resources or works, after the place of what they belong to changed. The writes are queued, so a long list does not hold the command back. */
  syncScope(scope: { workId?: string; workIds?: string[]; resourceIds?: string[] }): number {
    const ids = new Set<string>();
    for (const workId of [...(scope.workId ? [scope.workId] : []), ...(scope.workIds ?? [])]) {
      for (const row of this.store.sqlite.prepare("SELECT id FROM content_objects WHERE type = 'notes.document' AND work_id = ?").all(workId) as Array<{ id: string }>) ids.add(row.id);
    }
    for (const resourceId of scope.resourceIds ?? []) {
      for (const row of this.store.sqlite.prepare("SELECT id FROM content_objects WHERE type = 'notes.document' AND json_extract(scope_json, '$.resourceId') = ?").all(resourceId) as Array<{ id: string }>) ids.add(row.id);
    }
    // A work's own resources hold notes that name the resource, not the work.
    for (const workId of [...(scope.workId ? [scope.workId] : []), ...(scope.workIds ?? [])]) {
      for (const row of this.store.sqlite.prepare("SELECT c.id AS id FROM content_objects c JOIN resources r ON r.id = json_extract(c.scope_json, '$.resourceId') WHERE c.type = 'notes.document' AND r.work_id = ?").all(workId) as Array<{ id: string }>) ids.add(row.id);
    }
    for (const id of ids) this.queue(id);
    return ids.size;
  }

  // ------------------------------------------------------------------ the text of a file

  private source(row: NoteRow, target: FileTarget): string[] {
    const out: string[] = [];
    const resourceId = typeof target === "string" ? null : target.resourceId ?? null;
    const resource = resourceId ? this.store.sqlite.prepare("SELECT title, work_id AS workId FROM resources WHERE id = ?").get(resourceId) as { title: string; workId: string | null } | undefined : undefined;
    const workId = resource ? resource.workId : row.work_id;
    const work = workId
      ? (this.store.sqlite.prepare("SELECT title FROM works WHERE id = ?").get(workId) as { title: string } | undefined) ?? (this.store.sqlite.prepare("SELECT title FROM removed_works WHERE id = ?").get(workId) as { title: string } | undefined)
      : undefined;
    if (work) out.push(`作品：${work.title}`);
    if (resource) out.push(`资源：${resource.title}`);
    return out;
  }

  /** Where in the resource the first anchored block points, as a person would say it. */
  private position(blocks: NoteBlock[]): string | null {
    for (const block of blocks) {
      if (!block.anchorId) continue;
      const anchor = this.store.sqlite.prepare("SELECT locator_json FROM anchors WHERE id = ?").get(block.anchorId) as { locator_json: string } | undefined;
      if (!anchor) continue;
      try {
        const locator = JSON.parse(anchor.locator_json) as { kind?: string; startMs?: number; endMs?: number; quote?: { exact?: string } };
        if (locator.kind === "temporal" && typeof locator.startMs === "number") return `${clock(locator.startMs)}${typeof locator.endMs === "number" ? ` – ${clock(locator.endMs)}` : ""}`;
        if (locator.kind === "image") return "漫画页面";
        if (locator.kind === "text") return locator.quote?.exact ? `“${[...locator.quote.exact].slice(0, 24).join("")}”附近` : "正文";
      } catch { /* an anchor that cannot be read has no position to give */ }
    }
    return null;
  }

  private embedNode(block: NoteBlock, folderId: string): Node {
    const shotId = typeof block.attrs?.screenshotId === "string" ? block.attrs.screenshotId : null;
    if (shotId) {
      const shot = this.store.sqlite.prepare("SELECT s.title AS title, f.folder_id AS folderId, f.sub_dir AS subDir, f.file_name AS fileName FROM screenshots s JOIN work_files f ON f.id = s.file_id WHERE s.id = ?").get(shotId) as
        { title: string; folderId: string; subDir: string; fileName: string } | undefined;
      if (shot && shot.folderId === folderId) return paragraph({ type: "image", url: `../${encodeURIComponent(shot.subDir)}/${encodeURIComponent(shot.fileName)}`, alt: block.text || shot.title } as Node);
      return paragraph(text(`截图：${shot?.title ?? (block.text || "已不在")}`));
    }
    return paragraph(text(`嵌入：${block.text || "内容"}`));
  }

  /** The file as text. */
  render(row: NoteRow, folderId: string, target: FileTarget): string {
    const document = coerceNoteDocument(JSON.parse(row.payload_json));
    const children: Node[] = [{ type: "heading", depth: 1, children: [text(row.title || "笔记")] } as Node];
    const source = this.source(row, target);
    const position = this.position(document.blocks);
    if (position) source.push(`位置：${position}`);
    if (document.tags?.length) source.push(`标签：${document.tags.join("、")}`);
    children.push({ type: "blockquote", children: [paragraph(text(NOTICE)), ...source.map((line) => paragraph(text(line)))] } as Node);
    let list: { ordered: boolean; items: Node[] } | null = null;
    const closeList = () => {
      if (!list) return;
      children.push({ type: "list", ordered: list.ordered, start: list.ordered ? 1 : null, spread: false, children: list.items } as Node);
      list = null;
    };
    for (const block of document.blocks) {
      if (block.type === "list") {
        const ordered = block.ordered === true;
        if (list && list.ordered !== ordered) closeList();
        list ??= { ordered, items: [] };
        list.items.push({ type: "listItem", spread: false, children: [paragraph(...lines(block.text))] } as Node);
        continue;
      }
      closeList();
      if (block.type === "heading") children.push({ type: "heading", depth: Math.min(6, Math.max(1, (block.level ?? 1) + 1)), children: [text(block.text)] } as Node);
      else if (block.type === "quote") children.push({ type: "blockquote", children: [paragraph(...lines(block.text))] } as Node);
      else if (block.type === "code") children.push({ type: "code", lang: null, meta: null, value: block.text } as Node);
      else if (block.type === "screenshot" || block.type === "embed") children.push(this.embedNode(block, folderId));
      else if (block.text.length) children.push(paragraph(...lines(block.text)));
    }
    closeList();
    return toMarkdown({ type: "root", children } as Tree, { bullet: "-", fences: true, rule: "-", listItemIndent: "one", emphasis: "*", strong: "*" });
  }
}

/** The same name up to a counter the folder added to keep it apart from another file: "a (2).md" is still the file of the note called "a". */
function stemMatches(current: string, wanted: string): boolean {
  const ext = path.extname(wanted);
  const stem = wanted.slice(0, wanted.length - ext.length);
  return current.startsWith(`${stem} (`) && current.endsWith(`)${ext}`) && /^ \(\d+\)$/.test(current.slice(stem.length, current.length - ext.length));
}
