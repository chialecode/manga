import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { schemaSql } from "@manga/storage-drizzle";

/**
 * A synthetic library at an older schema, built from the same DDL the real migrations ran. It holds one work with
 * a text resource, an anchor, progress, a capture row, a link and a snapshot, so a migration test can prove nothing is lost.
 */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export function makeLegacyProfile(version: 6 | 7 = 6): { dir: string; ids: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-legacy-"));
  const db = new Database(path.join(dir, "manga.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(schemaSql.BASE_SCHEMA_SQL);
  db.exec(schemaSql.V2_SCHEMA_SQL);
  db.exec(schemaSql.V3_SCHEMA_SQL);
  db.exec(schemaSql.V4_SCHEMA_SQL);
  db.exec(schemaSql.V5_SCHEMA_SQL);
  db.exec(schemaSql.V6_SCHEMA_SQL);
  if (version >= 7) db.exec(schemaSql.V7_SCHEMA_SQL);
  db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schemaVersion', ?)").run(String(version));
  const ids = { work: "work-legacy", resource: "res-legacy", revision: "rev-legacy", anchor: "anc-legacy", capture: "cap-legacy", second: "res-legacy-2", secondWork: "work-legacy-2" };
  const now = "2026-09-01T00:00:00.000Z";
  const payload = JSON.stringify({ id: ids.revision, format: "txt", parts: [{ id: "body", normalized: "第一章。旧库里的正文，用来验证迁移后锚点仍然可以解析。", parserVersion: "novel-parser-v1" }], parserVersion: "novel-parser-v1" });
  db.prepare("INSERT INTO works(id,title,created_at) VALUES (?,?,?)").run(ids.work, "旧库作品", now);
  db.prepare("INSERT INTO works(id,title,created_at) VALUES (?,?,?)").run(ids.secondWork, "旧库作品二", "2026-09-02T00:00:00.000Z");
  db.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)").run(ids.resource, ids.work, "novel", "旧库作品", '["旧库作品"]', now);
  db.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)").run(ids.second, ids.secondWork, "comic", "旧库作品二", '[]', "2026-09-02T00:00:00.000Z");
  db.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(ids.revision, ids.resource, "f".repeat(64), "novel-parser-v1", payload, now);
  db.prepare("INSERT INTO anchors(id, resource_id, resource_revision_id, locator_json, preview_json, created_at) VALUES (?,?,?,?,?,?)").run(
    ids.anchor, ids.resource, ids.revision,
    JSON.stringify({ kind: "text", partId: "body", representationId: ids.revision, normalizationVersion: "text-nfc-lf-v1", range: { start: 6, end: 14 }, quote: { exact: "旧库里的正文，用来" } }),
    '{"text":"旧库里的正文"}', now,
  );
  db.prepare("INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at) VALUES (?,?,?,?,?,?)").run(ids.resource, ids.revision, null, '[{"partId":"body","start":0,"end":10}]', "reading", now);
  db.prepare("INSERT INTO capture_sessions(id, clock_json, status, attachment_id, created_at) VALUES (?,?,?,?,?)").run(ids.capture, '{"domainId":"d","startedAtMs":0,"sampleRate":16000}', "saved", "legacy-audio.webm", now);
  db.prepare("INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at) VALUES (?,?,?,?,?)").run(ids.work, "bangumi", "12345", '{"name":"旧"}', now);
  db.prepare("INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json) VALUES (?,?,?,?)").run(ids.work, "bangumi", "12345", '{"fields":{"title":"旧"}}');
  db.prepare("INSERT INTO metadata_candidates(id, work_id, provider_id, payload_json) VALUES (?,?,?,?)").run("cand-legacy", ids.work, "bangumi", "{}");
  if (version >= 7) {
    // Three authoritative covers as a v7 library kept them: a file that is whole, one that went missing, and one whose bytes changed.
    const attachments = path.join(dir, "attachments");
    fs.mkdirSync(attachments, { recursive: true });
    const hash = createHash("sha256").update(TINY_PNG).digest("hex");
    fs.writeFileSync(path.join(attachments, `cover-${hash.slice(0, 40)}.png`), TINY_PNG);
    fs.writeFileSync(path.join(attachments, "cover-changed.png"), Buffer.concat([TINY_PNG, Buffer.from([0])]));
    const insert = db.prepare("INSERT INTO covers(id, work_id, source, provider_id, external_id, content_hash, media_type, width, height, bytes, area, file_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insert.run("cov-whole", ids.work, "bangumi", "bangumi", "12345", hash, "image/png", 1, 1, TINY_PNG.length, "attachments", `cover-${hash.slice(0, 40)}.png`, now);
    insert.run("cov-missing", ids.work, "user", null, null, "a".repeat(64), "image/png", 1, 1, 70, "attachments", "cover-gone.png", now);
    insert.run("cov-changed", ids.secondWork, "user", null, null, createHash("sha256").update(TINY_PNG).digest("hex").replace(/^./, "b"), "image/png", 1, 1, 70, "attachments", "cover-changed.png", now);
    insert.run("cov-cache", ids.secondWork, "file", null, null, "c".repeat(64), "image/png", 1, 1, 70, "cache", "cover-cached.png", now);
    db.prepare("UPDATE works SET cover_id = 'cov-whole', cover_state = 'user' WHERE id = ?").run(ids.work);
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return { dir, ids };
}
