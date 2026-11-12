import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Where a file was left in light open, as the page reports it: a time for a video, a page for a comic. `finished` follows the full app's resume rule. */
export type LightPosition =
  | { kind: "video"; positionMs: number; durationMs: number; finished: boolean; at: string }
  | { kind: "comic"; pageId: string; pageIndex: number; pageCount: number; finished: boolean; at: string };

/**
 * What `positions.json` keeps. A comic page's id is the name of its image (in a folder) or of its entry in the archive, so only its SHA-256 is
 * kept (`page`): the file holds no name and no path (A-128, 4.4).
 */
export type StoredLightPosition =
  | { kind: "video"; positionMs: number; durationMs: number; finished: boolean; at: string }
  | { kind: "comic"; page: string; pageIndex: number; pageCount: number; finished: boolean; at: string };

/** At most this many files are remembered; the one opened longest ago goes first. */
export const LIGHT_POSITIONS_LIMIT = 500;
/** A video watched to within this of its end starts again from the beginning, as in the full app. */
export const LIGHT_FINISHED_WITHIN_MS = 5000;

const HEX64 = /^[0-9a-f]{64}$/;
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The hash a comic page is remembered by. */
export function lightPageHash(pageId: string): string {
  return createHash("sha256").update(pageId).digest("hex");
}

/** Only the known fields, with a comic page's id replaced by its hash; anything else is dropped. An entry kept by page name before is hashed. */
function stored(value: unknown): StoredLightPosition | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const at = typeof body.at === "string" ? body.at : new Date().toISOString();
  const finished = body.finished === true;
  if (body.kind === "video") return { kind: "video", positionMs: num(body.positionMs), durationMs: num(body.durationMs), finished, at };
  if (body.kind !== "comic") return null;
  const page = typeof body.page === "string" && HEX64.test(body.page) ? body.page : typeof body.pageId === "string" ? lightPageHash(body.pageId) : null;
  if (!page) return null;
  return { kind: "comic", page, pageIndex: Math.max(0, Math.round(num(body.pageIndex))), pageCount: Math.max(0, Math.round(num(body.pageCount))), finished, at };
}

/**
 * Light open's own memory of positions (A-128): `positions.json` under `<app data root>\light\`, keyed by `lightFileKey` (a hash, never a name or a
 * path), with a comic's page kept as the hash of its id. It is separate from the library's progress and never enters it. Written whole through a
 * temporary file.
 */
export class LightPositions {
  private entries = new Map<string, StoredLightPosition>();
  private readonly file: string;
  private readonly limit: number;

  constructor(file: string, limit = LIGHT_POSITIONS_LIMIT) {
    this.file = file;
    this.limit = limit;
    let rewrite = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: number; positions?: Record<string, unknown> };
      if (parsed.version === 1 && parsed.positions && typeof parsed.positions === "object") {
        const kept: Array<[string, StoredLightPosition]> = [];
        for (const [key, value] of Object.entries(parsed.positions)) {
          const entry = HEX64.test(key) ? stored(value) : null;
          if (entry) kept.push([key, entry]);
          // An entry that kept its page by name, or one that is not understood, is written again without it.
          if (!entry || (value as { pageId?: unknown }).pageId !== undefined) rewrite = true;
        }
        this.entries = new Map(kept.sort((a, b) => String(a[1].at).localeCompare(String(b[1].at))));
      }
    } catch { /* missing or unreadable: nothing is remembered yet */ }
    if (rewrite) this.save();
  }

  get(key: string): StoredLightPosition | null {
    return this.entries.get(key) ?? null;
  }

  /**
   * Where to start: a finished video or comic starts from the beginning, an unfinished one where it was left. A comic's page is looked up among
   * `pageIds` (the pages of the file now open) by its hash, else by its place when the book has as many pages as before.
   */
  resume(key: string, pageIds: readonly string[] = []): { positionMs: number } | { pageId: string } | null {
    const known = this.entries.get(key);
    if (!known || known.finished) return null;
    if (known.kind === "video") return { positionMs: known.positionMs };
    const pageId = pageIds.find((id) => lightPageHash(id) === known.page) ?? (known.pageCount === pageIds.length ? pageIds[known.pageIndex] : undefined);
    return pageId === undefined ? null : { pageId };
  }

  set(key: string, position: LightPosition): void {
    if (!HEX64.test(key)) return;
    const entry = stored(position);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value as string);
    this.save();
  }

  get size(): number {
    return this.entries.size;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const staging = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(staging, `${JSON.stringify({ version: 1, positions: Object.fromEntries(this.entries) })}\n`);
    fs.renameSync(staging, this.file);
  }
}

/** Whether a video position counts as watched to the end. */
export function videoFinished(positionMs: number, durationMs: number, ended: boolean): boolean {
  return ended || (durationMs > 0 && positionMs >= durationMs - LIGHT_FINISHED_WITHIN_MS);
}
