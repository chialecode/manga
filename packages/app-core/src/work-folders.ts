import fs from "node:fs";
import path from "node:path";
import { MangaError, createId } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { bangumiEntrySql } from "./works-versions.ts";
import { libraryRoots, relativeWithin, resolveResourceLocations } from "./library-locations.ts";
import { displayTitle } from "./works-service.ts";

/**
 * Where what the person makes goes (A-79, A-88). Everything the person makes for a title (screenshots, recordings, audio brought in for
 * transcription, rough cut files, exports, and each note as a Markdown file) is written into one folder of the works partition, which is
 * chosen by one rule only, `ownerOf`:
 *
 * - a resource whose work is linked to an online entry: `<medium>/<entry title>/`, shared by every resource of that entry and medium (A-68);
 * - any other resource: `未分类/<name of its file>/`, one for each file;
 * - something that is the work's own and belongs to no resource: the entry's folder, else `未分类/<title of the work>/`.
 *
 * The folders hold `截图`, `录音`, `粗剪`, `导出` and `笔记`. The database stays the record of what is in them (`work_files`); a note is written
 * from the database one way and a change made to the file is not read back (Q-31). A file moves when the rule gives it another folder
 * (a link made or taken away, an entry deleted, a resource moved); `settle` is what applies the rule to what is already there.
 */

export type WorkFileKind = "screenshot" | "recording" | "audio-import" | "roughcut" | "export" | "note";

/** The sub-folder each kind of file goes to. */
export const SUB_DIR: Record<WorkFileKind, string> = {
  screenshot: "截图",
  recording: "录音",
  "audio-import": "录音",
  roughcut: "粗剪",
  export: "导出",
  note: "笔记",
};

/** The folder of the files that belong to no online entry. */
export const UNSORTED_DIR = "未分类";

const MEDIUM_DIR: Record<string, string> = { novel: "小说", comic: "漫画", video: "动漫" };
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const NAME_LIMIT = 80;

export type WorkFolder = {
  id: string;
  ownerKind: "subject" | "work" | "resource";
  ownerId: string;
  mediaKind: string;
  relDir: string;
  title: string;
  createdAt: string;
};

export type WorkFile = {
  id: string;
  folderId: string;
  workId: string | null;
  resourceId: string | null;
  kind: WorkFileKind;
  subDir: string;
  fileName: string;
  refKind: string | null;
  refId: string | null;
  bytes: number;
  createdAt: string;
};

/** What a file is for: a resource (which has a file of its own), or only a work. A resource is enough on its own. */
export type FileTarget = string | { workId?: string | null; resourceId?: string | null };

type Owner = { kind: WorkFolder["ownerKind"]; id: string; mediaKind: string; title: string; top: string; parent: string | null; workId: string | null };

type FolderRow = { id: string; owner_kind: WorkFolder["ownerKind"]; owner_id: string; media_kind: string; rel_dir: string; title: string; created_at: string };
type FileRow = { id: string; folder_id: string; work_id: string | null; resource_id: string | null; kind: WorkFileKind; sub_dir: string; file_name: string; ref_kind: string | null; ref_id: string | null; bytes: number; created_at: string };

const folderOf = (row: FolderRow): WorkFolder => ({ id: row.id, ownerKind: row.owner_kind, ownerId: row.owner_id, mediaKind: row.media_kind, relDir: row.rel_dir, title: row.title, createdAt: row.created_at });
const fileOf = (row: FileRow): WorkFile => ({ id: row.id, folderId: row.folder_id, workId: row.work_id, resourceId: row.resource_id, kind: row.kind, subDir: row.sub_dir, fileName: row.file_name, refKind: row.ref_kind, refId: row.ref_id, bytes: row.bytes, createdAt: row.created_at });

/** A name that is safe as one path segment on every system the folder may be copied to. */
export function safeName(value: string, fallback = "未命名"): string {
  const cleaned = [...value.normalize("NFC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/\s+/g, " ").trim()].slice(0, NAME_LIMIT).join("").replace(/[. ]+$/, "").trim();
  if (!cleaned) return fallback;
  return RESERVED.test(cleaned.split(".")[0]!) ? `_${cleaned}` : cleaned;
}

const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const keyOf = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);

/** The name of a file without the extension a file has; a number after a dot ("v1.2") is part of the name. */
function stemOf(name: string): string {
  const ext = path.extname(name);
  return ext && ext.length <= 6 && /^\.[a-z0-9]*[a-z][a-z0-9]*$/i.test(ext) ? name.slice(0, name.length - ext.length) : name;
}

/** Moves a file, or copies it and removes the first when the two places are on different disks. A failure leaves the first file where it was. */
export function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  const part = `${to}.part`;
  fs.copyFileSync(from, part);
  if (fs.statSync(part).size !== fs.statSync(from).size) {
    fs.rmSync(part, { force: true });
    throw new Error("the copy is not the size of the original");
  }
  fs.renameSync(part, to);
  fs.rmSync(from, { force: true });
}

export class WorkFolders {
  private readonly store: DrizzleStore;
  readonly root: string;

  constructor(store: DrizzleStore) {
    this.store = store;
    this.root = store.worksDir;
  }

  // ------------------------------------------------------------------ who a file belongs to

  /** The name a resource's file has, without the extension, and the folder it is in; the title of the resource when it has no file of its own. */
  private fileNameOf(resourceId: string, title: string): { stem: string; parent: string | null } {
    const location = resolveResourceLocations(this.store, resourceId)[0];
    const full = location && !location.managed ? (location.path ?? location.legacyPath ?? (location.relativePath && location.relativePath !== "." ? location.relativePath : null)) : null;
    if (!full) return { stem: title, parent: null };
    const segments = full.split(/[\\/]/).filter(Boolean);
    const name = segments[segments.length - 1];
    if (!name) return { stem: title, parent: null };
    return { stem: stemOf(name), parent: segments.length > 1 ? segments[segments.length - 2]! : null };
  }

  /** The online entry a work is linked to, if any, with the name its entry has now. */
  private entryOf(workId: string): { mediaKind: string; entry: string; title: string } | null {
    const row = this.store.sqlite.prepare(`SELECT w.title AS title, w.projection_json AS projection_json, w.media_kind AS kind, ${bangumiEntrySql("w")} AS entry FROM works w WHERE w.id = ?`).get(workId) as
      { title: string; projection_json: string; kind: string; entry: string | null } | undefined;
    if (!row?.entry) return null;
    return { mediaKind: row.kind, entry: row.entry, title: displayTitle(row) };
  }

  /** The one rule for where a file goes. A resource's own work is read now, so a stale work in `target` is ignored. */
  ownerOf(target: FileTarget): Owner {
    const given = typeof target === "string" ? { workId: target } : target;
    const resource = given.resourceId
      ? this.store.sqlite.prepare("SELECT id, kind, title, work_id AS workId FROM resources WHERE id = ?").get(given.resourceId) as { id: string; kind: string; title: string; workId: string | null } | undefined
      : undefined;
    if (given.resourceId && !resource) throw new MangaError("NOT_FOUND", "resource missing");
    const workId = resource ? resource.workId : given.workId ?? null;
    const workRow = workId ? this.store.sqlite.prepare("SELECT id, title, projection_json, media_kind AS kind FROM works WHERE id = ?").get(workId) as { id: string; title: string; projection_json: string; kind: string } | undefined : undefined;
    const work = workRow ? { id: workRow.id, title: displayTitle(workRow), kind: workRow.kind } : undefined;
    const entry = work ? this.entryOf(work.id) : null;
    if (work && entry) return { kind: "subject", id: `${entry.mediaKind}:bgm:${entry.entry}`, mediaKind: entry.mediaKind, title: entry.title, top: MEDIUM_DIR[entry.mediaKind] ?? safeName(entry.mediaKind), parent: null, workId: work.id };
    if (resource) {
      const file = this.fileNameOf(resource.id, resource.title);
      return { kind: "resource", id: resource.id, mediaKind: resource.kind, title: file.stem, top: UNSORTED_DIR, parent: file.parent, workId: work?.id ?? null };
    }
    if (work) return { kind: "work", id: work.id, mediaKind: work.kind, title: work.title, top: UNSORTED_DIR, parent: null, workId: work.id };
    const gone = workId ? this.store.sqlite.prepare("SELECT title, media_kind AS kind FROM removed_works WHERE id = ?").get(workId) as { title: string; kind: string } | undefined : undefined;
    if (workId && gone) return { kind: "work", id: workId, mediaKind: gone.kind, title: gone.title, top: UNSORTED_DIR, parent: null, workId };
    throw new MangaError("NOT_FOUND", "work missing");
  }

  absolute(folder: Pick<WorkFolder, "relDir">): string {
    return path.join(this.root, ...folder.relDir.split("/"));
  }

  /** The works partition may not overlap a library path: a scan would take the screenshots for a comic (A-79). */
  assertApart(): void {
    for (const item of libraryRoots(this.store)) {
      if (item.managed) continue;
      if (relativeWithin(item.root, this.root) !== null || relativeWithin(this.root, item.root) !== null) {
        throw new MangaError("VALIDATION_ERROR", "the folder for the works' own files overlaps a library path; move one of them", { details: { reason: "works-in-library", libraryRoot: item.root } });
      }
    }
  }

  // ------------------------------------------------------------------ folders

  /** A folder name nothing else has: the name itself, then with the folder above the file in front, then with a number. */
  private freeRelDir(top: string, name: string, parent: string | null, own?: WorkFolder): string {
    const taken = new Set((this.store.sqlite.prepare("SELECT rel_dir FROM work_folders WHERE id IS NOT ?").all(own?.id ?? null) as Array<{ rel_dir: string }>).map((row) => keyOf(row.rel_dir)));
    const free = (relDir: string) => !taken.has(keyOf(relDir)) && ((own !== undefined && keyOf(relDir) === keyOf(own.relDir)) || !fs.existsSync(path.join(this.root, ...relDir.split("/"))));
    const base = safeName(name);
    let relDir = `${top}/${base}`;
    if (free(relDir)) return relDir;
    if (parent) {
      const widened = `${top}/${safeName(`${parent} - ${name}`)}`;
      if (free(widened)) return widened;
      relDir = widened;
    }
    for (let n = 2; ; n += 1) {
      const next = `${relDir} (${n})`;
      if (free(next)) return next;
    }
  }

  private lookup(owner: Owner): FolderRow | undefined {
    return this.store.sqlite.prepare("SELECT * FROM work_folders WHERE owner_kind = ? AND owner_id = ? AND media_kind = ?").get(owner.kind, owner.id, owner.mediaKind) as FolderRow | undefined;
  }

  private ensure(owner: Owner): WorkFolder {
    const found = this.lookup(owner);
    if (found) {
      fs.mkdirSync(this.absolute(folderOf(found)), { recursive: true });
      return folderOf(found);
    }
    this.assertApart();
    const row: FolderRow = {
      id: createId("wfold"), owner_kind: owner.kind, owner_id: owner.id, media_kind: owner.mediaKind, rel_dir: this.freeRelDir(owner.top, owner.title, owner.parent),
      title: owner.title, created_at: new Date().toISOString(),
    };
    this.store.sqlite.prepare("INSERT INTO work_folders(id, owner_kind, owner_id, media_kind, rel_dir, title, created_at) VALUES (?,?,?,?,?,?,?)").run(row.id, row.owner_kind, row.owner_id, row.media_kind, row.rel_dir, row.title, row.created_at);
    fs.mkdirSync(this.absolute(folderOf(row)), { recursive: true });
    return folderOf(row);
  }

  /** The folder files for `target` go to; made the first time something needs it unless `create` is false. */
  folderFor(target: FileTarget, options: { create?: boolean } = {}): WorkFolder | null {
    const owner = this.ownerOf(target);
    if (options.create === false) {
      const found = this.lookup(owner);
      if (!found) return null;
      fs.mkdirSync(this.absolute(folderOf(found)), { recursive: true });
      return folderOf(found);
    }
    return this.ensure(owner);
  }

  folder(folderId: string): WorkFolder | null {
    const row = this.store.sqlite.prepare("SELECT * FROM work_folders WHERE id = ?").get(folderId) as FolderRow | undefined;
    return row ? folderOf(row) : null;
  }

  list(): Array<WorkFolder & { files: number; bytes: number }> {
    const rows = this.store.sqlite.prepare(`SELECT f.*, (SELECT COUNT(*) FROM work_files x WHERE x.folder_id = f.id) AS files, (SELECT COALESCE(SUM(x.bytes), 0) FROM work_files x WHERE x.folder_id = f.id) AS bytes
      FROM work_folders f ORDER BY f.rel_dir`).all() as Array<FolderRow & { files: number; bytes: number }>;
    return rows.map((row) => ({ ...folderOf(row), files: row.files, bytes: row.bytes }));
  }

  /** The folders that hold what was made for a work: the entry's folder, or the folder of each of its resources, with what is in them. */
  foldersOfWork(workId: string): Array<{ folder: WorkFolder; files: WorkFile[] }> {
    const ids = new Set<string>();
    const resources = this.store.sqlite.prepare("SELECT id FROM resources WHERE work_id = ?").all(workId) as Array<{ id: string }>;
    for (const resource of resources) {
      const found = this.lookup(this.ownerOf({ resourceId: resource.id }));
      if (found) ids.add(found.id);
    }
    try {
      const found = this.lookup(this.ownerOf({ workId }));
      if (found) ids.add(found.id);
    } catch { /* a work that is gone has no folder of its own to show */ }
    const viaFiles = this.store.sqlite.prepare("SELECT DISTINCT folder_id AS id FROM work_files WHERE work_id = ?").all(workId) as Array<{ id: string }>;
    for (const row of viaFiles) ids.add(row.id);
    return this.withFiles(ids);
  }

  /** The folder that holds what was made from one resource, and what is in it. */
  foldersOfResource(resourceId: string): Array<{ folder: WorkFolder; files: WorkFile[] }> {
    const ids = new Set<string>();
    const found = this.lookup(this.ownerOf({ resourceId }));
    if (found) ids.add(found.id);
    for (const row of this.store.sqlite.prepare("SELECT DISTINCT folder_id AS id FROM work_files WHERE resource_id = ?").all(resourceId) as Array<{ id: string }>) ids.add(row.id);
    return this.withFiles(ids);
  }

  private withFiles(ids: Set<string>): Array<{ folder: WorkFolder; files: WorkFile[] }> {
    return [...ids].map((id) => this.folder(id)).filter((item): item is WorkFolder => item !== null).sort((a, b) => a.relDir.localeCompare(b.relDir))
      .map((folder) => ({ folder, files: this.filesIn(folder.id) }));
  }

  /** "按当前标题重命名": the folder of an entry (or of a work) takes the name its title has now; the files inside move with it. Names never overwrite each other. */
  rename(folderId: string): WorkFolder {
    const folder = this.folder(folderId);
    if (!folder) throw new MangaError("NOT_FOUND", "folder missing");
    if (folder.ownerKind === "resource") return folder;
    const workId = this.workOf(folder);
    if (!workId) return folder;
    const owner = this.ownerOf({ workId });
    const top = folder.relDir.split("/")[0]!;
    const relDir = this.freeRelDir(top, owner.title, null, folder);
    if (same(relDir, folder.relDir) || relDir === folder.relDir) return folder;
    this.relocate(folder, relDir, owner.title);
    return this.folder(folderId)!;
  }

  /** A folder takes another place; the move is written down first, so a stop in the middle is finished at the next start. */
  private relocate(folder: WorkFolder, relDir: string, title: string): void {
    const from = this.absolute(folder);
    const to = path.join(this.root, ...relDir.split("/"));
    const journal = createId("mv");
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("INSERT INTO file_moves(id, kind, from_path, to_path, state, created_at) VALUES (?,?,?,?,'pending',?)").run(journal, "folder-rename", from, to, new Date().toISOString());
      this.store.sqlite.prepare("UPDATE work_folders SET rel_dir = ?, title = ? WHERE id = ?").run(relDir, title, folder.id);
    })();
    this.finishMove(journal, "folder-rename", from, to);
  }

  /** Any work of the folder's owner, to read the current title from. */
  private workOf(folder: WorkFolder): string | null {
    if (folder.ownerKind === "work") return this.store.sqlite.prepare("SELECT id FROM works WHERE id = ?").get(folder.ownerId) ? folder.ownerId : null;
    const entry = folder.ownerId.split(":bgm:")[1];
    const row = this.store.sqlite.prepare(`SELECT w.id AS id FROM work_links l JOIN works w ON w.id = l.work_id
      WHERE l.provider_id = 'bangumi' AND l.link_state = 'linked' AND l.external_id = ? AND w.media_kind = ? ORDER BY COALESCE(w.last_opened_at, '') DESC, w.created_at LIMIT 1`).get(entry, folder.mediaKind) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // ------------------------------------------------------------------ files

  file(fileId: string): WorkFile | null {
    const row = this.store.sqlite.prepare("SELECT * FROM work_files WHERE id = ?").get(fileId) as FileRow | undefined;
    return row ? fileOf(row) : null;
  }

  /** Where a file is now. A move that was started and not finished still resolves: the file is where it was until the move is done. */
  pathOf(fileId: string): string | null {
    const file = this.file(fileId);
    if (!file) return null;
    const folder = this.folder(file.folderId);
    if (!folder) return null;
    const target = path.join(this.absolute(folder), file.subDir, file.fileName);
    if (fs.existsSync(target)) return target;
    const pending = this.store.sqlite.prepare("SELECT from_path FROM file_moves WHERE state = 'pending' AND kind = 'work-move' AND to_path = ?").get(target) as { from_path: string } | undefined;
    return pending && fs.existsSync(pending.from_path) ? pending.from_path : null;
  }

  /** A name in `dir` that nothing has: `name`, or `name (2)` and so on. */
  uniqueName(dir: string, fileName: string, taken: Set<string> = new Set()): string {
    const ext = path.extname(fileName);
    const stem = fileName.slice(0, fileName.length - ext.length);
    let candidate = fileName;
    for (let n = 2; fs.existsSync(path.join(dir, candidate)) || taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${ext}`;
    return candidate;
  }

  private placeOf(target: FileTarget): { owner: Owner; folder: WorkFolder } {
    const owner = this.ownerOf(target);
    return { owner, folder: this.ensure(owner) };
  }

  private resourceOf(target: FileTarget, given?: string | null): string | null {
    return given ?? (typeof target === "string" ? null : target.resourceId ?? null);
  }

  /**
   * Put a file into the folder of `target`: moved from `sourcePath` (a file the application wrote elsewhere first) or written from `bytes`.
   * The name is made safe and unique; nothing already there is overwritten.
   */
  put(target: FileTarget, input: { kind: WorkFileKind; fileName: string; bytes?: Uint8Array; sourcePath?: string; copy?: boolean; resourceId?: string | null; refKind?: string | null; refId?: string | null }): { fileId: string; path: string; fileName: string; folder: WorkFolder } {
    const { owner, folder } = this.placeOf(typeof target === "string" || !input.resourceId ? target : { ...target, resourceId: input.resourceId });
    const subDir = SUB_DIR[input.kind];
    const dir = path.join(this.absolute(folder), subDir);
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(input.fileName);
    const fileName = this.uniqueName(dir, `${safeName(input.fileName.slice(0, input.fileName.length - ext.length))}${ext.replace(/[^.\w]/g, "")}`);
    const destination = path.join(dir, fileName);
    const part = `${destination}.part`;
    if (input.bytes) fs.writeFileSync(part, input.bytes);
    else if (input.sourcePath) fs.copyFileSync(input.sourcePath, part);
    else throw new MangaError("VALIDATION_ERROR", "a file needs bytes or a source");
    const size = fs.statSync(part).size;
    fs.renameSync(part, destination);
    if (input.sourcePath && input.copy !== true) fs.rmSync(input.sourcePath, { force: true });
    const id = createId("wfile");
    this.store.sqlite.prepare("INSERT INTO work_files(id, folder_id, work_id, resource_id, kind, sub_dir, file_name, ref_kind, ref_id, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, folder.id, owner.workId, this.resourceOf(target, input.resourceId), input.kind, subDir, fileName, input.refKind ?? null, input.refId ?? null, size, new Date().toISOString());
    return { fileId: id, path: destination, fileName, folder };
  }

  /**
   * The sub-folder of a kind of file in the folder of `target`, made when it is not there yet, for a writer that places the file itself (an export names
   * and checks its files before they are put down). `record` writes the file down afterwards.
   */
  dirFor(target: FileTarget, kind: WorkFileKind): { dir: string; folder: WorkFolder; label: string } {
    const { folder } = this.placeOf(target);
    const dir = path.join(this.absolute(folder), SUB_DIR[kind]);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, folder, label: `${folder.relDir}/${SUB_DIR[kind]}` };
  }

  /** Writes down a file that is already in `dirFor(target, kind).dir`. */
  record(target: FileTarget, input: { kind: WorkFileKind; fileName: string; resourceId?: string | null; refKind?: string | null; refId?: string | null }): string {
    const { owner, folder } = this.placeOf(typeof target === "string" || !input.resourceId ? target : { ...target, resourceId: input.resourceId });
    const dir = path.join(this.absolute(folder), SUB_DIR[input.kind]);
    const size = fs.statSync(path.join(dir, input.fileName)).size;
    const id = createId("wfile");
    // A record of a file that is no longer there must not stop the one that took its name.
    this.store.sqlite.prepare("DELETE FROM work_files WHERE folder_id = ? AND sub_dir = ? AND file_name = ?").run(folder.id, SUB_DIR[input.kind], input.fileName);
    this.store.sqlite.prepare("INSERT INTO work_files(id, folder_id, work_id, resource_id, kind, sub_dir, file_name, ref_kind, ref_id, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, folder.id, owner.workId, this.resourceOf(target, input.resourceId), input.kind, SUB_DIR[input.kind], input.fileName, input.refKind ?? null, input.refId ?? null, size, new Date().toISOString());
    return id;
  }

  /** A file takes another name in its own folder; written down in the journal first, so a stop in the middle is finished at the next start. */
  renameFile(fileId: string, fileName: string): string {
    const file = this.file(fileId);
    const folder = file ? this.folder(file.folderId) : null;
    if (!file || !folder) throw new MangaError("NOT_FOUND", "file missing");
    if (file.fileName === fileName) return fileName;
    const from = this.pathOf(fileId) ?? path.join(this.absolute(folder), file.subDir, file.fileName);
    const dir = path.join(this.absolute(folder), file.subDir);
    const taken = new Set((this.store.sqlite.prepare("SELECT file_name FROM work_files WHERE folder_id = ? AND sub_dir = ? AND id <> ?").all(folder.id, file.subDir, fileId) as Array<{ file_name: string }>).map((item) => item.file_name.toLowerCase()));
    const next = same(fileName, file.fileName) ? fileName : this.uniqueName(dir, fileName, taken);
    const to = path.join(dir, next);
    const journal = createId("mv");
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("INSERT INTO file_moves(id, kind, from_path, to_path, state, created_at) VALUES (?,?,?,?,'pending',?)").run(journal, "work-move", from, to, new Date().toISOString());
      this.store.sqlite.prepare("UPDATE work_files SET file_name = ? WHERE id = ?").run(next, fileId);
    })();
    this.finishMove(journal, "work-move", from, to);
    return next;
  }

  /** Forget a file, and delete it from the folder unless the person is keeping it. */
  remove(fileId: string, options: { deleteFile: boolean } = { deleteFile: true }): void {
    const target = this.pathOf(fileId);
    const folderId = this.file(fileId)?.folderId;
    this.store.sqlite.prepare("DELETE FROM work_files WHERE id = ?").run(fileId);
    if (options.deleteFile && target) fs.rmSync(target, { force: true });
    if (options.deleteFile && folderId) this.pruneIfEmpty(folderId);
  }

  files(workId: string, kind?: WorkFileKind): WorkFile[] {
    const rows = this.store.sqlite.prepare(`SELECT * FROM work_files WHERE work_id = ? ${kind ? "AND kind = ?" : ""} ORDER BY created_at, id`).all(...(kind ? [workId, kind] : [workId])) as FileRow[];
    return rows.map(fileOf);
  }

  filesOfResource(resourceId: string, kind?: WorkFileKind): WorkFile[] {
    const rows = this.store.sqlite.prepare(`SELECT * FROM work_files WHERE resource_id = ? ${kind ? "AND kind = ?" : ""} ORDER BY created_at, id`).all(...(kind ? [resourceId, kind] : [resourceId])) as FileRow[];
    return rows.map(fileOf);
  }

  filesIn(folderId: string): WorkFile[] {
    return (this.store.sqlite.prepare("SELECT * FROM work_files WHERE folder_id = ? ORDER BY created_at, id").all(folderId) as FileRow[]).map(fileOf);
  }

  // ------------------------------------------------------------------ following the rule

  /** The resource and work a file row stands for now: the resource it was made from (a recording names it through its session), else the work. */
  private targetOfRow(row: FileRow): FileTarget {
    let resourceId = row.resource_id;
    if (!resourceId && row.ref_kind === "capture" && row.ref_id) {
      resourceId = (this.store.sqlite.prepare("SELECT e.resource_id AS id FROM capture_events e WHERE e.session_id = ? AND e.resource_id IS NOT NULL ORDER BY e.offset_ms, e.id LIMIT 1").get(row.ref_id) as { id: string } | undefined)?.id ?? null;
    }
    if (resourceId && this.store.sqlite.prepare("SELECT 1 FROM resources WHERE id = ?").get(resourceId)) return { resourceId, workId: row.work_id };
    return { workId: row.work_id };
  }

  /**
   * Apply the rule to what is there (A-88): every file whose folder is not the one `ownerOf` gives it now goes there. A name that is taken in the new
   * place is changed, never overwritten. Every move is written down first, so a stop in the middle is finished at the next start; running it again moves
   * nothing more. `scope` narrows it to the files of some resources or one work; without it, every file is looked at.
   */
  settle(scope: { workId?: string; workIds?: string[]; resourceIds?: string[] } = {}): { moved: number; looked: number } {
    this.followWorkOfScreenshots();
    const works = new Set([...(scope.workId ? [scope.workId] : []), ...(scope.workIds ?? [])]);
    const resources = new Set(scope.resourceIds ?? []);
    for (const workId of works) for (const row of this.store.sqlite.prepare("SELECT id FROM resources WHERE work_id = ?").all(workId) as Array<{ id: string }>) resources.add(row.id);
    const all = this.store.sqlite.prepare("SELECT * FROM work_files ORDER BY created_at, id").all() as FileRow[];
    const rows = works.size || scope.resourceIds
      ? all.filter((row) => (row.resource_id !== null && resources.has(row.resource_id)) || (row.work_id !== null && works.has(row.work_id)) || (row.resource_id === null && row.ref_kind === "capture" && this.refResourceIn(row, resources)))
      : all;
    return this.settleRows(rows);
  }

  private refResourceIn(row: FileRow, resources: Set<string>): boolean {
    const target = this.targetOfRow(row);
    return typeof target !== "string" && target.resourceId !== undefined && target.resourceId !== null && resources.has(target.resourceId);
  }

  /** Settle the files in batches that give the event loop back between them; what was done stays done if the process stops. */
  async settleAll(options: { batch?: number; stop?: () => boolean } = {}): Promise<{ moved: number; looked: number; finished: boolean }> {
    this.followWorkOfScreenshots();
    this.reflowOldFolders();
    const rows = this.store.sqlite.prepare("SELECT * FROM work_files ORDER BY created_at, id").all() as FileRow[];
    const batch = options.batch ?? 50;
    let moved = 0;
    for (let at = 0; at < rows.length; at += batch) {
      if (options.stop?.()) return { moved, looked: at, finished: false };
      moved += this.settleRows(rows.slice(at, at + batch)).moved;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const row of this.store.sqlite.prepare("SELECT id FROM work_folders").all() as Array<{ id: string }>) this.pruneIfEmpty(row.id);
    return { moved, looked: rows.length, finished: true };
  }

  /** The folder a work had of its own is now under 未分类, named after the work. */
  private reflowOldFolders(): void {
    // Only a folder that holds something of the work itself (not of one of its resources) is moved as it is; the files of a resource leave it one by one.
    const rows = this.store.sqlite.prepare(`SELECT * FROM work_folders f WHERE f.owner_kind = 'work' AND f.rel_dir NOT LIKE ?
      AND EXISTS (SELECT 1 FROM work_files x WHERE x.folder_id = f.id AND x.resource_id IS NULL)`).all(`${UNSORTED_DIR}/%`) as FolderRow[];
    for (const row of rows) {
      const folder = folderOf(row);
      const relDir = this.freeRelDir(UNSORTED_DIR, folder.title, null, folder);
      this.relocate(folder, relDir, folder.title);
    }
  }

  /** A screenshot names the work its resource is in now. */
  private followWorkOfScreenshots(): void {
    this.store.sqlite.prepare(`UPDATE screenshots SET work_id = (SELECT r.work_id FROM resources r WHERE r.id = screenshots.resource_id)
      WHERE work_id IS NOT (SELECT r.work_id FROM resources r WHERE r.id = screenshots.resource_id)`).run();
  }

  private settleRows(rows: FileRow[]): { moved: number; looked: number } {
    const moves: Array<{ journal: string; from: string; to: string }> = [];
    const now = new Date().toISOString();
    const touched = new Set<string>();
    const current = this.store.sqlite.prepare("SELECT * FROM work_files WHERE id = ?");
    this.store.sqlite.transaction(() => {
      for (const listed of rows) {
        // The list may be older than the row: between two batches of `settleAll` a command can move the file or forget it, and the row says where it is now.
        const row = current.get(listed.id) as FileRow | undefined;
        if (!row) continue;
        let owner: Owner;
        try { owner = this.ownerOf(this.targetOfRow(row)); } catch { continue; }
        // The work a file names follows the resource it was made from.
        if ((row.work_id ?? null) !== owner.workId && row.resource_id !== null) this.store.sqlite.prepare("UPDATE work_files SET work_id = ? WHERE id = ?").run(owner.workId, row.id);
        const target = this.ensure(owner);
        if (row.folder_id === target.id) continue;
        const from = this.pathOf(row.id) ?? path.join(this.absolute(this.folder(row.folder_id) ?? target), row.sub_dir, row.file_name);
        const dir = path.join(this.absolute(target), row.sub_dir);
        const taken = new Set((this.store.sqlite.prepare("SELECT file_name FROM work_files WHERE folder_id = ? AND sub_dir = ?").all(target.id, row.sub_dir) as Array<{ file_name: string }>).map((item) => item.file_name.toLowerCase()));
        const fileName = this.uniqueName(dir, row.file_name, taken);
        const journal = createId("mv");
        this.store.sqlite.prepare("INSERT INTO file_moves(id, kind, from_path, to_path, state, created_at) VALUES (?,?,?,?,'pending',?)").run(journal, "work-move", from, path.join(dir, fileName), now);
        this.store.sqlite.prepare("UPDATE work_files SET folder_id = ?, file_name = ? WHERE id = ?").run(target.id, fileName, row.id);
        moves.push({ journal, from, to: path.join(dir, fileName) });
        touched.add(row.folder_id);
      }
    })();
    for (const move of moves) this.finishMove(move.journal, "work-move", move.from, move.to);
    for (const folderId of touched) this.pruneIfEmpty(folderId);
    return { moved: moves.length, looked: rows.length };
  }

  /** A folder nothing is recorded in any more, and that holds no file of the person's own, goes; one with something in it stays. */
  pruneIfEmpty(folderId: string): void {
    const folder = this.folder(folderId);
    if (!folder) return;
    if (this.store.sqlite.prepare("SELECT 1 FROM work_files WHERE folder_id = ?").get(folderId)) return;
    const dir = this.absolute(folder);
    const empty = (target: string): boolean => {
      if (!fs.existsSync(target)) return true;
      const entries = fs.readdirSync(target, { withFileTypes: true });
      return entries.every((entry) => entry.isDirectory() && empty(path.join(target, entry.name)));
    };
    if (empty(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      this.store.sqlite.prepare("DELETE FROM work_folders WHERE id = ?").run(folderId);
      const medium = path.dirname(dir);
      if (medium !== this.root && fs.existsSync(medium) && !fs.readdirSync(medium).length) fs.rmdirSync(medium);
    }
  }

  /** The moves the journal still holds, finished at the start; a file that is not at either place is reported, not guessed. */
  resumeMoves(): { done: number; pending: number } {
    const rows = this.store.sqlite.prepare("SELECT id, kind, from_path, to_path FROM file_moves WHERE state = 'pending' AND kind IN ('work-move', 'folder-rename', 'note-remove') ORDER BY created_at, rowid").all() as Array<{ id: string; kind: string; from_path: string; to_path: string }>;
    let done = 0;
    for (const row of rows) if (this.finishMove(row.id, row.kind, row.from_path, row.to_path)) done += 1;
    return { done, pending: rows.length - done };
  }

  private finishMove(journal: string, kind: string, from: string, to: string): boolean {
    // The state a stop leaves in the middle of a move: the records point at the new place, the journal says pending, the file has not moved.
    this.store.maybeCrash("before-work-move");
    try {
      if (kind === "note-remove") {
        // A note file that was replaced by one with another name or place: the old one goes.
        fs.rmSync(from, { force: true });
        this.store.sqlite.prepare("UPDATE file_moves SET state = 'done', done_at = ?, error = NULL WHERE id = ?").run(new Date().toISOString(), journal);
        return true;
      }
      const source = fs.existsSync(from);
      const target = fs.existsSync(to);
      if (source && !target) {
        moveFile(from, to);
        if (kind === "folder-rename") this.removeEmptyParent(from);
      } else if (source && target && kind === "work-move") {
        // Both exist: the move was finished by another route; the same bytes are a leftover, different bytes are kept apart.
        if (fs.statSync(from).size === fs.statSync(to).size) fs.rmSync(from, { force: true });
        else throw new Error("a different file is already at the new place");
      } else if (!source && !target) throw new Error("the file is not at either place");
      this.store.sqlite.prepare("UPDATE file_moves SET state = 'done', done_at = ?, error = NULL WHERE id = ?").run(new Date().toISOString(), journal);
      this.store.maybeCrash("after-work-move");
      return true;
    } catch (error) {
      this.store.sqlite.prepare("UPDATE file_moves SET error = ? WHERE id = ?").run(error instanceof Error ? error.message : String(error), journal);
      return false;
    }
  }

  /** The folder of a medium that a folder left is removed when it is empty. */
  private removeEmptyParent(dir: string): void {
    const parent = path.dirname(dir);
    if (path.resolve(parent) !== path.resolve(this.root) && fs.existsSync(parent) && !fs.readdirSync(parent).length) fs.rmdirSync(parent);
  }

  /** Writes a journal row for a file to remove later and returns its id; `resumeMoves` finishes it if the process stops first. */
  journalRemoval(file: string): string {
    const id = createId("mv");
    this.store.sqlite.prepare("INSERT INTO file_moves(id, kind, from_path, to_path, state, created_at) VALUES (?,?,?,?,'pending',?)").run(id, "note-remove", file, "", new Date().toISOString());
    return id;
  }

  finishRemoval(journal: string, file: string): void {
    this.finishMove(journal, "note-remove", file, "");
  }

  // ------------------------------------------------------------------ recordings that were kept before the folders

  /**
   * Recordings kept before the works had folders sit in the attachments partition. Each one whose session names a work (or whose events name
   * a resource) is copied into its folder, written down in the journal and verified; the original stays where it is, so the backup taken
   * before the migration still works, and is listed with the other unreferenced attachments for the person to clean.
   */
  migrateRecordings(attachmentsDir: string, options: { keepOriginal: boolean } = { keepOriginal: true }): { copied: number; kept: number; pending: number } {
    const rows = this.store.sqlite.prepare(`SELECT c.id AS id, c.opus_name AS opus, c.created_at AS createdAt, c.work_id AS ownWorkId,
        (SELECT e.resource_id FROM capture_events e WHERE e.session_id = c.id AND e.resource_id IS NOT NULL ORDER BY e.id LIMIT 1) AS resourceId,
        COALESCE(c.work_id, (SELECT r.work_id FROM capture_events e JOIN resources r ON r.id = e.resource_id WHERE e.session_id = c.id AND e.resource_id IS NOT NULL ORDER BY e.id LIMIT 1)) AS workId
      FROM capture_sessions c WHERE c.audio_file_id IS NULL AND c.opus_name IS NOT NULL ORDER BY c.created_at, c.id`).all() as Array<{ id: string; opus: string; createdAt: string; ownWorkId: string | null; resourceId: string | null; workId: string | null }>;
    let copied = 0;
    let kept = 0;
    let pending = 0;
    for (const row of rows) {
      const source = path.join(attachmentsDir, row.opus);
      const hasWork = Boolean(row.workId && this.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(row.workId));
      const hasResource = Boolean(row.resourceId && this.store.sqlite.prepare("SELECT 1 FROM resources WHERE id = ?").get(row.resourceId));
      if (!hasWork && !hasResource) { kept += 1; continue; }
      const journal = createId("mv");
      try {
        if (!fs.existsSync(source)) throw new Error("the recording is not in the attachments");
        // A stop after the copy and before the row was switched leaves the copy recorded: it is taken over when its size is the original's, replaced when it is not.
        const left = this.store.sqlite.prepare("SELECT id FROM work_files WHERE ref_kind = 'capture' AND ref_id = ? AND kind = 'recording' ORDER BY created_at, rowid LIMIT 1").get(row.id) as { id: string } | undefined;
        const leftPath = left ? this.pathOf(left.id) : null;
        const reusable = Boolean(left && leftPath && fs.statSync(leftPath).size === fs.statSync(source).size);
        if (left && !reusable) this.remove(left.id);
        const target: FileTarget = { workId: hasWork ? row.workId : null, resourceId: hasResource ? row.resourceId : null };
        const label = hasWork
          ? (this.store.sqlite.prepare("SELECT w.title AS title FROM works w WHERE w.id = ?").get(row.workId) as { title: string }).title
          : (this.store.sqlite.prepare("SELECT title FROM resources WHERE id = ?").get(row.resourceId) as { title: string }).title;
        const stamp = row.createdAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const put = reusable
          ? { fileId: left!.id, path: leftPath! }
          : this.put(target, { kind: "recording", fileName: `${label} 录音 ${stamp}${path.extname(row.opus) || ".webm"}`, sourcePath: source, copy: options.keepOriginal, refKind: "capture", refId: row.id });
        if (!options.keepOriginal && fs.existsSync(source) && put.path !== source) fs.rmSync(source, { force: true });
        this.store.sqlite.prepare("INSERT INTO file_moves(id, kind, from_path, to_path, state, created_at, done_at) VALUES (?,?,?,?,'done',?,?)").run(journal, options.keepOriginal ? "recording-copy" : "recording-move", source, put.path, new Date().toISOString(), new Date().toISOString());
        this.store.sqlite.prepare("UPDATE capture_sessions SET audio_file_id = ?, opus_name = NULL WHERE id = ?").run(put.fileId, row.id);
        copied += 1;
      } catch (error) {
        pending += 1;
        this.store.sqlite.prepare("INSERT OR REPLACE INTO file_moves(id, kind, from_path, to_path, state, error, created_at) VALUES (?,?,?,?,'failed',?,?)").run(journal, "recording-copy", source, "", error instanceof Error ? error.message : String(error), new Date().toISOString());
      }
      this.store.maybeCrash("after-recording-copy");
    }
    return { copied, kept, pending };
  }
}
