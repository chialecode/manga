import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exportLibraryPackage, importLibraryPackageResolved, previewLibraryPackage } from "../../packages/app-core/src/domain/library-package.ts";
import { startApp, tempProfile } from "../helpers/app.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

type Ctx = Awaited<ReturnType<typeof startApp>>;
let counter = 0;
const call = (ctx: Ctx, commandId: string, input: Record<string, unknown>) => {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `rt-${counter}`, input }, ctx.grant.handle);
};

/** A library holding every object kind M2 added, built from synthetic rows only. */
async function seedLibrary(ctx: Ctx) {
  const comic = seedComic(ctx.app, { title: "往返漫画", pageCount: 5 });
  const video = seedVideo(ctx.app, { title: "往返视频", durationMs: 120_000 });
  const db = ctx.app.store.sqlite;
  const now = "2026-10-01T08:00:00.000Z";

  // Cover bytes are a package attachment; the row points at them by file name.
  const coverBytes = Buffer.from("synthetic-cover-bytes");
  const coverHash = createHash("sha256").update(coverBytes).digest("hex");
  const coverName = `cover-${coverHash.slice(0, 16)}.jpg`;
  fs.mkdirSync(ctx.app.store.attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.app.store.attachmentsDir, coverName), coverBytes);
  const coverId = "cov-fixed-1";
  db.prepare("INSERT INTO covers(id, work_id, source, provider_id, external_id, content_hash, media_type, width, height, bytes, area, file_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(coverId, comic.workId, "user", null, null, coverHash, "image/jpeg", 300, 450, coverBytes.length, "attachments", coverName, now);
  db.prepare("UPDATE works SET cover_id = ?, cover_state = 'user', shelf_state = 'reading', author = '合成作者', last_resource_id = ?, last_opened_at = ? WHERE id = ?").run(coverId, comic.resourceId, now, comic.workId);
  // A cover extracted into the cache is rebuilt from the file; it never travels.
  db.prepare("INSERT INTO covers(id, work_id, source, provider_id, external_id, content_hash, media_type, width, height, bytes, area, file_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("cov-cache-1", video.workId, "file", null, null, "c".repeat(64), "image/jpeg", 10, 10, 1, "cache", "cache-only.jpg", now);

  db.prepare("INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at, namespace, subject_type, link_state, match_basis) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(comic.workId, "bangumi", "424242", '{"name":"合成条目"}', now, "bangumi:subject", 1, "linked", "manual");
  db.prepare("INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json, fetched_at, source_url, api_version, detached) VALUES (?,?,?,?,?,?,?,?)")
    .run(comic.workId, "bangumi", "424242", '{"fields":{"title":"合成条目"}}', now, "https://api.bgm.tv/v0/subjects/424242", "v0", 0);
  db.prepare("INSERT INTO metadata_candidates(id, work_id, provider_id, payload_json, external_id, search_id, state, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("cand-1", comic.workId, "bangumi", '{"name":"候选"}', "99", "search-1", "open", now);
  db.prepare("INSERT INTO work_terms(id, work_id, term, heard, created_at) VALUES (?,?,?,?,?)").run("trm-1", video.workId, "魔王城", "魔王成", now);
  db.prepare("INSERT INTO media_probes(resource_revision_id, probe_json, tool_version, created_at) VALUES (?,?,?,?)").run(video.revisionId, '{"durationMs":120000}', "ffprobe-test", now);

  // Notes with a page region and a time range, created through the normal command so anchors are real.
  const pageNote = await call(ctx, "notes.create", { title: "格子笔记", text: "构图", resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, locator: { kind: "image", pageId: comic.pageIds[1], region: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 } } });
  const timeNote = await call(ctx, "notes.create", { title: "片段笔记", text: "片头", resourceId: video.resourceId, resourceRevisionId: video.revisionId, locator: { kind: "temporal", startMs: 3000, endMs: 9000 } });
  expect(pageNote.status, JSON.stringify(pageNote)).toBe("ok");
  expect(timeNote.status, JSON.stringify(timeNote)).toBe("ok");

  // A recording kept with its audio, the position events that ran beside it and a transcript mapped to the video.
  const audioBytes = Buffer.from("synthetic-opus-bytes");
  const audioName = "cap-fixed-1.opus";
  fs.writeFileSync(path.join(ctx.app.store.attachmentsDir, audioName), audioBytes);
  db.prepare("INSERT INTO capture_sessions(id, clock_json, status, attachment_id, created_at, mode, retention, audio_state, stage, duration_ms, stopped_at, staging_name, opus_name, device_label, work_id, vad_json, error_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("cap-fixed-1", '{"domainId":"d","startedAtMs":0,"sampleRate":16000}', "saved", audioName, now, "hold", "keep", "kept", "done", 8000, now, null, audioName, "合成麦克风", video.workId, '{"speechMs":6000}', null, now);
  const event = (offsetMs: number, reason: string, locator: unknown) => db.prepare("INSERT INTO capture_events(session_id, payload_json, offset_ms, reason, resource_id, resource_revision_id) VALUES (?,?,?,?,?,?)")
    .run("cap-fixed-1", JSON.stringify({ resourceId: video.resourceId, resourceRevisionId: video.revisionId, locator }), offsetMs, reason, video.resourceId, video.revisionId);
  event(0, "start", { kind: "temporal", startMs: 3000, representationId: video.revisionId });
  event(4000, "seek", { kind: "temporal", startMs: 60_000, representationId: video.revisionId });
  const anchor = [{ resourceId: video.resourceId, resourceRevisionId: video.revisionId, locator: { kind: "temporal", startMs: 3000, endMs: 9000, representationId: video.revisionId } }];
  db.prepare("INSERT INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, revised_text, state, precision, calibrated, anchors_json, attempts, error_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("seg-1", "cap-fixed-1", 0, "chunk-0", 0, 4000, "勇者来到魔王城", "勇者来到魔王城。", "done", "segment", 1, JSON.stringify(anchor), 1, null, now, now);
  db.prepare("INSERT INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, revised_text, state, precision, calibrated, anchors_json, attempts, error_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("seg-2", "cap-fixed-1", 1, "chunk-1", 4000, 8000, "", null, "failed", "segment", 0, "[]", 3, '{"code":"MODEL_UNAVAILABLE"}', now, now);
  db.prepare("INSERT INTO capture_drafts(id, session_id, state, text, edited_text, note_object_id, error_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("drf-1", "cap-fixed-1", "ready", "整理后的草稿", null, null, null, now, now);
  db.prepare("UPDATE progress SET percent = 0.4 WHERE resource_id = ?").run(comic.resourceId);
  await call(ctx, "progress.setPage", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[2] });
  return { comic, video, coverId, coverName, audioName, pageNote: pageNote.value as { objectId: string }, timeNote: timeNote.value as { objectId: string } };
}

const count = (ctx: Ctx, table: string) => (ctx.app.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("library package round trip with M2 objects", () => {
  it("exports every new object kind, leaves cache-only covers out, and restores them into an empty profile", async () => {
    const source = await startApp();
    const target = await startApp();
    try {
      const seeded = await seedLibrary(source);
      const dir = path.join(tempProfile(), "pkg");
      const manifest = exportLibraryPackage(source.app.store, dir);
      expect(manifest.covers).toHaveLength(1);
      expect(manifest.captureEvents).toHaveLength(2);
      expect(manifest.transcriptSegments).toHaveLength(2);
      expect(manifest.captureDrafts).toHaveLength(1);
      expect(manifest.workTerms).toHaveLength(1);
      expect(manifest.mediaProbes).toHaveLength(1);
      expect(manifest.attachments.map((item) => item.id)).toEqual(expect.arrayContaining([seeded.coverName, seeded.audioName]));

      const preview = previewLibraryPackage(target.app.store, dir);
      expect(preview.empty).toBe(true);
      expect(preview.conflicts).toEqual([]);
      importLibraryPackageResolved(target.app.store, dir, { strategy: "replace" });

      for (const table of ["works", "resources", "resource_revisions", "anchors", "progress", "capture_sessions", "capture_events", "transcript_segments", "capture_drafts", "work_terms", "media_probes", "work_links", "metadata_snapshots", "metadata_candidates"]) {
        expect(count(target, table), table).toBe(count(source, table));
      }
      expect(count(target, "covers")).toBe(1);
      expect(target.app.store.sqlite.prepare("SELECT * FROM works WHERE id = ?").get(seeded.comic.workId)).toMatchObject({ media_kind: "comic", shelf_state: "reading", author: "合成作者", cover_id: seeded.coverId, cover_state: "user", last_resource_id: seeded.comic.resourceId });
      expect(fs.readFileSync(path.join(target.app.store.attachmentsDir, seeded.coverName)).toString()).toBe("synthetic-cover-bytes");
      expect(target.app.store.sqlite.prepare("SELECT audio_state, retention, opus_name, work_id, device_label FROM capture_sessions WHERE id = 'cap-fixed-1'").get())
        .toEqual({ audio_state: "kept", retention: "keep", opus_name: seeded.audioName, work_id: seeded.video.workId, device_label: "合成麦克风" });
      expect(target.app.store.sqlite.prepare("SELECT state, calibrated, revised_text FROM transcript_segments WHERE id = 'seg-1'").get()).toEqual({ state: "done", calibrated: 1, revised_text: "勇者来到魔王城。" });
      expect(target.app.store.sqlite.prepare("SELECT state, attempts, error_json FROM transcript_segments WHERE id = 'seg-2'").get()).toEqual({ state: "failed", attempts: 3, error_json: '{"code":"MODEL_UNAVAILABLE"}' });
      expect(target.app.store.sqlite.prepare("SELECT percent, last_locator_json FROM progress WHERE resource_id = ?").get(seeded.comic.resourceId)).toMatchObject({ percent: expect.any(Number) });

      // Both source kinds still open from the restored library.
      const page = await call(target, "notes.openSource", { objectId: seeded.pageNote.objectId });
      const time = await call(target, "notes.openSource", { objectId: seeded.timeNote.objectId });
      expect(page.value).toMatchObject({ status: "resolved", kind: "image", pageIndex: 1 });
      expect(time.value).toMatchObject({ status: "resolved", kind: "temporal", startMs: 3000, endMs: 9000 });
      expect(target.app.store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(target.app.store.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally { source.app.close(); target.app.close(); }
  });

  it("duplicate import into a library that holds the same ids remaps every dependent row consistently", async () => {
    const ctx = await startApp();
    try {
      const seeded = await seedLibrary(ctx);
      const dir = path.join(tempProfile(), "pkg");
      exportLibraryPackage(ctx.app.store, dir);
      const preview = previewLibraryPackage(ctx.app.store, dir);
      expect(preview.conflicts.map((conflict) => conflict.kind)).toEqual(expect.arrayContaining(["work", "resource", "resource_revision", "capture"]));
      expect(preview.defaultStrategy).toBe("duplicate");

      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "duplicate" });
      const db = ctx.app.store.sqlite;
      expect(count(ctx, "works")).toBe(4);
      expect(count(ctx, "capture_sessions")).toBe(2);
      expect(count(ctx, "transcript_segments")).toBe(4);
      expect(count(ctx, "capture_events")).toBe(4);
      expect(count(ctx, "capture_drafts")).toBe(2);

      // The copy's session points at the copy's video, not the original's.
      const copySession = db.prepare("SELECT id, work_id FROM capture_sessions WHERE id != 'cap-fixed-1'").get() as { id: string; work_id: string };
      expect(copySession.work_id).not.toBe(seeded.video.workId);
      expect(db.prepare("SELECT media_kind FROM works WHERE id = ?").get(copySession.work_id)).toEqual({ media_kind: "video" });
      const copyVideoResource = db.prepare("SELECT id FROM resources WHERE work_id = ?").get(copySession.work_id) as { id: string };
      const copyVideoRevision = db.prepare("SELECT id FROM resource_revisions WHERE resource_id = ?").get(copyVideoResource.id) as { id: string };
      expect(copyVideoRevision.id).not.toBe(seeded.video.revisionId);

      const events = db.prepare("SELECT resource_id, resource_revision_id, payload_json FROM capture_events WHERE session_id = ?").all(copySession.id) as Array<{ resource_id: string; resource_revision_id: string; payload_json: string }>;
      expect(events).toHaveLength(2);
      for (const row of events) {
        expect(row.resource_id).toBe(copyVideoResource.id);
        expect(row.resource_revision_id).toBe(copyVideoRevision.id);
        const payload = JSON.parse(row.payload_json) as { resourceId: string; resourceRevisionId: string; locator: { representationId: string } };
        expect(payload).toMatchObject({ resourceId: copyVideoResource.id, resourceRevisionId: copyVideoRevision.id });
        expect(payload.locator.representationId).toBe(copyVideoRevision.id);
      }
      const segments = db.prepare("SELECT id, anchors_json, text FROM transcript_segments WHERE session_id = ? ORDER BY seq").all(copySession.id) as Array<{ id: string; anchors_json: string; text: string }>;
      expect(segments.map((row) => row.id)).not.toContain("seg-1");
      expect(segments[0]!.text).toBe("勇者来到魔王城");
      const anchors = JSON.parse(segments[0]!.anchors_json) as Array<{ resourceId: string; resourceRevisionId: string; locator: { representationId: string } }>;
      expect(anchors[0]).toMatchObject({ resourceId: copyVideoResource.id, resourceRevisionId: copyVideoRevision.id });
      expect(anchors[0]!.locator.representationId).toBe(copyVideoRevision.id);
      // The original session keeps its own ids and its own rows.
      const originalAnchors = JSON.parse((db.prepare("SELECT anchors_json FROM transcript_segments WHERE id = 'seg-1'").get() as { anchors_json: string }).anchors_json) as typeof anchors;
      expect(originalAnchors[0]!.resourceRevisionId).toBe(seeded.video.revisionId);

      // Terms, probes, links and the cover follow their work; the same cover is not stored twice for one work.
      const copyComic = db.prepare("SELECT id, cover_id FROM works WHERE media_kind = 'comic' AND id != ?").get(seeded.comic.workId) as { id: string; cover_id: string };
      expect(copyComic.cover_id).toBeTruthy();
      expect(copyComic.cover_id).not.toBe(seeded.coverId);
      expect(db.prepare("SELECT work_id FROM covers WHERE id = ?").get(copyComic.cover_id)).toEqual({ work_id: copyComic.id });
      expect(db.prepare("SELECT COUNT(*) AS n FROM work_links WHERE work_id = ?").get(copyComic.id)).toEqual({ n: 1 });
      expect(db.prepare("SELECT term FROM work_terms WHERE work_id = ?").all(copySession.work_id)).toEqual([{ term: "魔王城" }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM media_probes WHERE resource_revision_id = ?").get(copyVideoRevision.id)).toEqual({ n: 1 });

      // Importing the same package a second time stays consistent and never doubles a cover inside one work.
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "duplicate" });
      const covers = db.prepare("SELECT work_id, COUNT(*) AS n FROM covers GROUP BY work_id, content_hash").all() as Array<{ work_id: string; n: number }>;
      expect(covers.every((row) => row.n === 1)).toBe(true);
      expect(db.pragma("foreign_key_check")).toEqual([]);

      // Every copy of a page note and a time note opens against the copy of its own source.
      const noteRows = db.prepare("SELECT id FROM content_objects WHERE type = 'notes.document'").all() as Array<{ id: string }>;
      expect(noteRows.length).toBe(6);
      const kinds: Record<string, number> = {};
      for (const row of noteRows) {
        const opened = await call(ctx, "notes.openSource", { objectId: row.id });
        const value = opened.value as { status: string; kind: string };
        expect(value.status, row.id).toBe("resolved");
        kinds[value.kind] = (kinds[value.kind] ?? 0) + 1;
      }
      expect(kinds).toEqual({ image: 3, temporal: 3 });
    } finally { ctx.app.close(); }
  });

  it("skip leaves the target untouched and adds nothing for the skipped session", async () => {
    const ctx = await startApp();
    try {
      await seedLibrary(ctx);
      const dir = path.join(tempProfile(), "pkg");
      exportLibraryPackage(ctx.app.store, dir);
      const before = ["works", "capture_sessions", "capture_events", "transcript_segments", "covers", "work_terms"].map((table) => count(ctx, table));
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "skip" });
      expect(["works", "capture_sessions", "capture_events", "transcript_segments", "covers", "work_terms"].map((table) => count(ctx, table))).toEqual(before);
    } finally { ctx.app.close(); }
  });

  it("records audio the package no longer carries as cleaned, keeps the transcript, and drops that cover instead of pointing at nothing", async () => {
    const source = await startApp();
    const target = await startApp();
    try {
      const seeded = await seedLibrary(source);
      const dir = path.join(tempProfile(), "pkg");
      exportLibraryPackage(source.app.store, dir);
      fs.rmSync(path.join(dir, "attachments", seeded.audioName));
      fs.rmSync(path.join(dir, "attachments", seeded.coverName));
      const preview = previewLibraryPackage(target.app.store, dir);
      expect(preview.missingAttachments.sort()).toEqual([seeded.audioName, seeded.coverName].sort());
      importLibraryPackageResolved(target.app.store, dir, { strategy: "replace" });
      expect(target.app.store.sqlite.prepare("SELECT audio_state, opus_name, attachment_id FROM capture_sessions WHERE id = 'cap-fixed-1'").get()).toEqual({ audio_state: "cleaned", opus_name: null, attachment_id: null });
      expect(count(target, "transcript_segments")).toBe(2);
      expect(count(target, "covers")).toBe(0);
      expect((target.app.store.sqlite.prepare("SELECT cover_id FROM works WHERE id = ?").get(seeded.comic.workId) as { cover_id: string | null }).cover_id).toBeNull();
    } finally { source.app.close(); target.app.close(); }
  });

  it("rejects a package whose M2 rows point at nothing before it writes anything", async () => {
    const source = await startApp();
    const target = await startApp();
    try {
      await seedLibrary(source);
      const dir = path.join(tempProfile(), "pkg");
      exportLibraryPackage(source.app.store, dir);
      const manifestPath = path.join(dir, "manifest.json");
      const original = fs.readFileSync(manifestPath, "utf8");
      const mutate = (edit: (manifest: Record<string, any>) => void) => {
        const manifest = JSON.parse(original);
        edit(manifest);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      };
      const cases: Array<[string, (manifest: Record<string, any>) => void]> = [
        ["a transcript for a session that is not there", (manifest) => { manifest.transcriptSegments[0].session_id = "cap-ghost"; }],
        ["a cover for a work that is not there", (manifest) => { manifest.covers[0].work_id = "work-ghost"; }],
        ["a term for a work that is not there", (manifest) => { manifest.workTerms[0].work_id = "work-ghost"; }],
        ["a probe for a revision that is not there", (manifest) => { manifest.mediaProbes[0].resource_revision_id = "rev-ghost"; }],
        ["a duplicated transcript id", (manifest) => { manifest.transcriptSegments[1].id = manifest.transcriptSegments[0].id; }],
        ["a cover file name that escapes the folder", (manifest) => { manifest.covers[0].file_name = "../escape.jpg"; }],
        ["a shelf state field the schema forbids on covers", (manifest) => { manifest.covers[0].extra = 1; }],
        ["a capture event with a negative offset", (manifest) => { manifest.captureEvents[0].offset_ms = -1; }],
      ];
      const tables = ["works", "resources", "capture_sessions", "transcript_segments", "covers", "capture_events", "recovery_jobs"];
      for (const [label, edit] of cases) {
        mutate(edit);
        const before = tables.map((table) => count(target, table));
        expect(() => importLibraryPackageResolved(target.app.store, dir, { strategy: "replace" }), label).toThrow();
        expect(tables.map((table) => count(target, table)), label).toEqual(before);
        expect(fs.readdirSync(target.app.store.attachmentsDir).filter((name) => name.startsWith(".import-")), label).toEqual([]);
      }
    } finally { source.app.close(); target.app.close(); }
  });

  it("imports a package written before this stage without M2 columns", async () => {
    const source = await startApp();
    const target = await startApp();
    try {
      const book = await call(source, "library.importText", { title: "旧包书", bytes: [...Buffer.from("旧包里的正文。")] });
      expect(book.status).toBe("ok");
      const dir = path.join(tempProfile(), "pkg");
      exportLibraryPackage(source.app.store, dir);
      const manifestPath = path.join(dir, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      for (const key of ["covers", "captureEvents", "transcriptSegments", "captureDrafts", "workTerms", "mediaProbes"]) delete manifest[key];
      for (const row of manifest.works) for (const key of ["media_kind", "shelf_state", "author", "cover_id", "cover_state", "last_resource_id", "last_opened_at", "projection_json", "updated_at"]) delete row[key];
      for (const row of manifest.resources) for (const key of ["ordinal_label", "ordinal_number", "ordinal_type", "sort_key"]) delete row[key];
      for (const row of manifest.revisions) delete row.layout_json;
      for (const row of manifest.progress) delete row.percent;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      importLibraryPackageResolved(target.app.store, dir, { strategy: "replace" });
      expect(target.app.store.sqlite.prepare("SELECT media_kind, shelf_state, cover_state FROM works").get()).toEqual({ media_kind: "novel", shelf_state: "none", cover_state: "auto" });
      const read = await call(target, "library.read", { resourceId: (book.value as { resourceId: string }).resourceId });
      expect(read.status).toBe("ok");
    } finally { source.app.close(); target.app.close(); }
  });
});
