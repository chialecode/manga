import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { MangaError } from "@manga/contracts";

/** What the v12 → v13 move of the frozen pictures did: runs rewritten, pictures moved, distinct contents kept, and how long it took. */
export type AgentMediaMigration = { runs: number; images: number; unique: number; ms: number };

type InlineImage = { base64?: unknown; mediaType?: unknown; width?: unknown; height?: unknown; [key: string]: unknown };
type Snapshot = { media?: { images?: InlineImage[] } };

const BATCH = 50;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function inlineImages(snapshot: Snapshot): InlineImage[] {
  const images = snapshot.media?.images;
  return Array.isArray(images) ? images.filter((image) => image && typeof image.base64 === "string") : [];
}

/** Rows whose snapshot still carries a picture inline, a batch at a time after `rowid` (so memory stays bounded however many runs there are). */
function* batches(sqlite: Database.Database): Generator<Array<{ rowid: number; id: string; created_at: string; snapshot_json: string }>> {
  const select = sqlite.prepare("SELECT rowid, id, created_at, snapshot_json FROM agent_runs WHERE rowid > ? AND snapshot_json LIKE '%\"base64\"%' ORDER BY rowid LIMIT ?");
  let after = 0;
  for (;;) {
    const rows = select.all(after, BATCH) as Array<{ rowid: number; id: string; created_at: string; snapshot_json: string }>;
    if (!rows.length) return;
    yield rows;
    after = rows.at(-1)!.rowid;
  }
}

/** The hashes of every picture frozen into a run, read from wherever the database keeps them now (inline in a snapshot, or in `agent_media`). */
export function frozenImageHashes(sqlite: Database.Database): string[] {
  const out: string[] = [];
  for (const rows of batches(sqlite)) {
    for (const row of rows) {
      let snapshot: Snapshot;
      try { snapshot = JSON.parse(row.snapshot_json) as Snapshot; } catch { continue; }
      for (const image of inlineImages(snapshot)) out.push(sha256(Buffer.from(image.base64 as string, "base64")));
    }
  }
  const stored = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_run_media'").get()
    ? sqlite.prepare("SELECT m.bytes AS bytes FROM agent_run_media r JOIN agent_media m ON m.hash = r.hash").iterate() as Iterable<{ bytes: Buffer }>
    : [];
  for (const row of stored) out.push(sha256(row.bytes));
  return out.sort();
}

/**
 * v12 → v13 (计划 4.4): the pictures frozen inline in `agent_runs.snapshot_json` move to `agent_media`, once per content, and the snapshot keeps a
 * reference (`hash`) with the source and size. It runs inside the migration's transaction, a batch of runs at a time; nothing is removed for age here
 * (the first clean-up follows the new rules after the start). The multiset of picture hashes is computed before and after, from the bytes themselves;
 * if they differ the migration throws and the transaction leaves the library as it was.
 */
export function migrateAgentMedia(sqlite: Database.Database, onBatch?: (done: number) => void): AgentMediaMigration {
  const started = performance.now();
  const before = frozenImageHashes(sqlite);
  const insertMedia = sqlite.prepare("INSERT OR IGNORE INTO agent_media(hash, mime, width, height, size, bytes, created_at) VALUES (?,?,?,?,?,?,?)");
  const insertRef = sqlite.prepare("INSERT OR IGNORE INTO agent_run_media(run_id, hash, ordinal) VALUES (?,?,?)");
  const update = sqlite.prepare("UPDATE agent_runs SET snapshot_json = ? WHERE rowid = ?");
  let runs = 0;
  let images = 0;
  for (const rows of batches(sqlite)) {
    for (const row of rows) {
      let snapshot: Snapshot;
      try { snapshot = JSON.parse(row.snapshot_json) as Snapshot; } catch { continue; }
      const list = snapshot.media?.images;
      if (!Array.isArray(list)) continue;
      let moved = 0;
      snapshot.media!.images = list.map((image, ordinal) => {
        if (!image || typeof image.base64 !== "string") return image;
        const bytes = Buffer.from(image.base64, "base64");
        const hash = sha256(bytes);
        insertMedia.run(hash, typeof image.mediaType === "string" ? image.mediaType : "image/jpeg", typeof image.width === "number" ? image.width : null, typeof image.height === "number" ? image.height : null, bytes.length, bytes, row.created_at);
        insertRef.run(row.id, hash, ordinal);
        moved += 1;
        const { base64: _inline, ...rest } = image;
        return { ...rest, hash };
      });
      if (!moved) continue;
      update.run(JSON.stringify(snapshot), row.rowid);
      runs += 1;
      images += moved;
    }
    onBatch?.(runs);
  }
  const after = frozenImageHashes(sqlite);
  if (before.length !== after.length || before.some((hash, index) => hash !== after[index])) {
    throw new MangaError("INTERRUPTED", "the frozen pictures did not survive the move intact; the library was left as it was", { details: { reason: "agent-media-integrity", before: before.length, after: after.length } });
  }
  const unique = (sqlite.prepare("SELECT COUNT(*) AS n FROM agent_media").get() as { n: number }).n;
  return { runs, images, unique, ms: Math.round(performance.now() - started) };
}
