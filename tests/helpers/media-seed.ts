import { createHash } from "node:crypto";
import type { MangaProductApp } from "@manga/app-core";
import { createId } from "@manga/contracts";

/**
 * Rows for comic and video resources written straight into a profile, so contract and data tests do not depend on a
 * reader or on FFmpeg. The shapes match what the importers store: `payload.comic.pages` and `payload.video`.
 */
export function seedComic(app: MangaProductApp, input: { title: string; pageCount?: number; workId?: string; ordinal?: { label?: string; number?: number; type?: string }; createdAt?: string }) {
  const pageCount = input.pageCount ?? 6;
  const now = input.createdAt ?? new Date().toISOString();
  const workId = input.workId ?? createId("work");
  const resourceId = createId("res");
  const revisionId = createId("rev");
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    id: `p${String(index + 1).padStart(3, "0")}.png`,
    index,
    name: `${index + 1}.png`,
    width: 600,
    height: 900,
    hash: createHash("sha256").update(`${input.title}:${index}`).digest("hex"),
    ok: true,
    ref: { kind: "file", relativePath: `${index + 1}.png` },
  }));
  const payload = { id: revisionId, format: "comic-dir", parserId: "comic-dir-v1", comic: { source: "dir", pages, warnings: [] }, parts: [], warnings: [] };
  const db = app.store.sqlite;
  if (!input.workId) db.prepare("INSERT INTO works(id,title,created_at,media_kind,updated_at) VALUES (?,?,?,?,?)").run(workId, input.title, now, "comic", now);
  db.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at, ordinal_label, ordinal_number, ordinal_type, sort_key) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(resourceId, workId, "comic", input.title, "[]", now, input.ordinal?.label ?? null, input.ordinal?.number ?? null, input.ordinal?.type ?? null, input.ordinal?.number !== undefined ? `1|${String(Math.round(input.ordinal.number * 1000)).padStart(12, "0")}|${input.title}` : "");
  db.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)")
    .run(revisionId, resourceId, createHash("sha256").update(input.title).digest("hex"), "comic-dir-v1", JSON.stringify(payload), now);
  return { workId, resourceId, revisionId, pageIds: pages.map((page) => page.id) };
}

export function seedVideo(app: MangaProductApp, input: { title: string; durationMs?: number; workId?: string; ordinal?: { label?: string; number?: number; type?: string }; createdAt?: string }) {
  const durationMs = input.durationMs ?? 24_000;
  const now = input.createdAt ?? new Date().toISOString();
  const workId = input.workId ?? createId("work");
  const resourceId = createId("res");
  const revisionId = createId("rev");
  const payload = { id: revisionId, format: "video", parserId: "video-probe-v1", video: { durationMs, container: "matroska", startMs: 0, hasSubtitles: false }, parts: [], warnings: [] };
  const db = app.store.sqlite;
  if (!input.workId) db.prepare("INSERT INTO works(id,title,created_at,media_kind,updated_at) VALUES (?,?,?,?,?)").run(workId, input.title, now, "video", now);
  db.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at, ordinal_label, ordinal_number, ordinal_type, sort_key) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(resourceId, workId, "video", input.title, "[]", now, input.ordinal?.label ?? null, input.ordinal?.number ?? null, input.ordinal?.type ?? null, input.ordinal?.number !== undefined ? `1|${String(Math.round(input.ordinal.number * 1000)).padStart(12, "0")}|${input.title}` : "");
  db.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)")
    .run(revisionId, resourceId, createHash("sha256").update(`video:${input.title}`).digest("hex"), "video-probe-v1", JSON.stringify(payload), now);
  return { workId, resourceId, revisionId, durationMs };
}
