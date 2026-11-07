import { randomBytes } from "node:crypto";
import { MangaError } from "@manga/contracts";

/**
 * What a media handle can stand for. The renderer never sees a path: it holds an opaque handle that the main process
 * resolves to one of these sources, so a handle can never reach outside the file or cache entry it was issued for.
 */
export type MediaSource =
  | { kind: "file"; path: string; mediaType: string }
  | { kind: "slice"; path: string; offset: number; length: number; mediaType: string }
  | { kind: "zip-entry"; archive: string; entry: string; size: number; mediaType: string }
  | { kind: "buffer"; bytes: Uint8Array; mediaType: string };

export type HandleBinding = {
  /** Module whose generation the handle depends on; disabling that module invalidates it. */
  moduleId: string;
  resourceId?: string;
  revisionId?: string;
  /** Agent or reading session that asked for it; closing the session invalidates it. */
  sessionId?: string;
  /** Free-form subject, only used for revocation by owner (for example a play copy id or a capture id). */
  subject?: string;
};

type HandleRecord = {
  id: string;
  source: MediaSource;
  binding: HandleBinding;
  generation: number;
  issuedAt: number;
  expiresAt: number | null;
};

export type HandleIssue = { handle: string; url: string };

export const MEDIA_SCHEME = "manga-media";
export const MEDIA_HOST = "media";
const MAX_HANDLES = 8192;

export function mediaUrl(handle: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${handle}`;
}

/**
 * The only shape of URL the protocol answers: scheme, fixed host, one path segment that is a well-formed handle.
 * The raw string is matched, not a parsed URL, because parsing quietly resolves `..` and percent-escapes into a valid-looking path.
 */
export function parseMediaUrl(raw: string): string | null {
  const match = /^manga-media:\/\/media\/(h[A-Za-z0-9_-]{22})$/.exec(raw);
  return match ? match[1]! : null;
}

/**
 * Issues and resolves handles. A handle is bound to a module generation, so a stopped-and-restarted module (or any
 * code that bumps the generation) cannot reach handles from before the change. Memory is bounded; the least recently
 * used handle is dropped first when the table is full.
 */
export class MediaHandleTable {
  private readonly records = new Map<string, HandleRecord>();
  private readonly generations = new Map<string, number>();
  private readonly closedSessions = new Set<string>();

  private readonly now: () => number;
  private readonly limit: number;

  constructor(now: () => number = () => Date.now(), limit = MAX_HANDLES) {
    this.now = now;
    this.limit = limit;
  }

  generationOf(moduleId: string): number {
    return this.generations.get(moduleId) ?? 1;
  }

  /** Invalidate every handle bound to the module, past and (by its new number) present. */
  bumpGeneration(moduleId: string): number {
    const next = this.generationOf(moduleId) + 1;
    this.generations.set(moduleId, next);
    for (const [id, record] of this.records) if (record.binding.moduleId === moduleId && record.generation < next) this.records.delete(id);
    return next;
  }

  issue(source: MediaSource, binding: HandleBinding, options: { ttlMs?: number } = {}): HandleIssue {
    if (binding.sessionId && this.closedSessions.has(binding.sessionId)) {
      throw new MangaError("FORBIDDEN", "session is closed");
    }
    while (this.records.size >= this.limit) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    const id = `h${randomBytes(17).toString("base64url").slice(0, 22)}`;
    this.records.set(id, {
      id,
      source,
      binding,
      generation: this.generationOf(binding.moduleId),
      issuedAt: this.now(),
      expiresAt: options.ttlMs ? this.now() + options.ttlMs : null,
    });
    return { handle: id, url: mediaUrl(id) };
  }

  /** Returns the source for a live handle, or null. The reason is not distinguished: a caller learns nothing about stale handles. */
  resolve(handle: string): { source: MediaSource; binding: HandleBinding } | null {
    const record = this.records.get(handle);
    if (!record) return null;
    if (record.expiresAt !== null && record.expiresAt <= this.now()) { this.records.delete(handle); return null; }
    if (record.generation !== this.generationOf(record.binding.moduleId)) { this.records.delete(handle); return null; }
    if (record.binding.sessionId && this.closedSessions.has(record.binding.sessionId)) { this.records.delete(handle); return null; }
    // A handle in use moves to the young end, so a full table drops idle handles before a video that is still being read.
    this.records.delete(handle);
    this.records.set(handle, record);
    return { source: record.source, binding: record.binding };
  }

  revokeWhere(predicate: (binding: HandleBinding, source: MediaSource) => boolean): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (predicate(record.binding, record.source)) { this.records.delete(id); removed += 1; }
    }
    return removed;
  }

  revokeSubject(subject: string): number {
    return this.revokeWhere((binding) => binding.subject === subject);
  }

  closeSession(sessionId: string): number {
    this.closedSessions.add(sessionId);
    return this.revokeWhere((binding) => binding.sessionId === sessionId);
  }

  get size(): number {
    return this.records.size;
  }
}
