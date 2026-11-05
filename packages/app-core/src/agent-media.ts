import { createHash } from "node:crypto";
import fs from "node:fs";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import { resolveLocation } from "./library-locations.ts";

/**
 * The pictures and video clips frozen for Agent tasks (LOOP-05, 计划 4.4). The bytes are kept once per content in `agent_media`, keyed by SHA-256; a run's
 * snapshot names them by hash and `agent_run_media` says which run uses which. When a run has been over for longer than the retention period its
 * references go, the snapshot keeps the source and size of each picture with `expired: true`, and a content no run refers to any more is deleted.
 */

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** What the source file looked like when a picture was taken from it: a retry after expiry extracts again only from the same file. */
export type SourceStamp = { size: number; mtimeMs: number };

/** The run states after which nothing more is sent: only these runs lose their pictures to age. */
// An interrupted run can still be resumed, so it keeps its pictures like a running one.
export const ENDED_RUN_STATES = ["succeeded", "failed", "cancelled"] as const;

export function sourceStamp(store: DrizzleStore, revisionId: string): SourceStamp | null {
  try {
    const file = resolveLocation(store, revisionId)?.path;
    if (!file) return null;
    const stat = fs.statSync(file);
    return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  } catch {
    return null;
  }
}

/** The latest revision of a resource: a picture extracted again must come from the revision it was first taken from. */
export function latestRevision(store: DrizzleStore, resourceId: string): string | undefined {
  return (store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(resourceId) as { id: string } | undefined)?.id;
}

/** The statements that keep `bytes` for a run, at position `ordinal` of its material; a content that is already kept is not written again. */
export function keepMediaMutations(runId: string, items: Array<{ bytes: Buffer; hash: string; mime: string; width?: number | null; height?: number | null; ordinal: number }>, at: string): Mutation[] {
  const out: Mutation[] = [];
  for (const item of items) {
    out.push({ sql: "INSERT OR IGNORE INTO agent_media(hash, mime, width, height, size, bytes, created_at) VALUES (?,?,?,?,?,?,?)", params: [item.hash, item.mime, item.width ?? null, item.height ?? null, item.bytes.length, item.bytes, at] });
    out.push({ sql: "INSERT OR IGNORE INTO agent_run_media(run_id, hash, ordinal) VALUES (?,?,?)", params: [runId, item.hash, item.ordinal] });
  }
  return out;
}

/**
 * The bytes a run keeps under `hash`, read in one statement (so a clean-up running at the same time either has not removed them yet or has, never half),
 * and only if they still hash to what they are named by. Undefined when the run no longer has them.
 */
export function runMedia(store: DrizzleStore, runId: string, hash: string): Buffer | undefined {
  const row = store.sqlite.prepare("SELECT m.bytes AS bytes FROM agent_run_media r JOIN agent_media m ON m.hash = r.hash WHERE r.run_id = ? AND r.hash = ? LIMIT 1").get(runId, hash) as { bytes: Buffer } | undefined;
  if (!row) return undefined;
  const bytes = Buffer.from(row.bytes);
  return sha256(bytes) === hash ? bytes : undefined;
}

export type MediaRetention = { retentionDays: number | null };

/**
 * One pass of the clean-up: runs that ended more than `retentionDays` ago lose their references, a batch at a time, each batch one short transaction;
 * their snapshots mark each picture `expired` (source and size stay). Contents no run refers to any more are deleted. Runs still going are never touched.
 * `retentionDays: null` keeps everything (only unreferenced contents, left by a deleted conversation, are removed).
 */
export function sweepAgentMedia(store: DrizzleStore, retention: MediaRetention, now = Date.now(), batch = 20): { runs: number; removed: number } {
  let runs = 0;
  if (retention.retentionDays !== null) {
    const before = new Date(now - retention.retentionDays * 86_400_000).toISOString();
    const states = ENDED_RUN_STATES.map(() => "?").join(",");
    const select = store.sqlite.prepare(`SELECT DISTINCT r.id, r.snapshot_json FROM agent_runs r JOIN agent_run_media m ON m.run_id = r.id WHERE r.status IN (${states}) AND r.updated_at < ? LIMIT ?`);
    for (;;) {
      const rows = select.all(...ENDED_RUN_STATES, before, batch) as Array<{ id: string; snapshot_json: string | null }>;
      if (!rows.length) break;
      store.sqlite.transaction(() => {
        for (const row of rows) {
          // Checked again inside the transaction: a retry may have started the run again since it was selected.
          const still = store.sqlite.prepare(`SELECT 1 FROM agent_runs WHERE id = ? AND status IN (${states}) AND updated_at < ?`).get(row.id, ...ENDED_RUN_STATES, before);
          if (!still) continue;
          store.sqlite.prepare("UPDATE agent_runs SET snapshot_json = ? WHERE id = ?").run(expireSnapshot(row.snapshot_json), row.id);
          store.sqlite.prepare("DELETE FROM agent_run_media WHERE run_id = ?").run(row.id);
          runs += 1;
        }
      })();
      if (rows.length < batch) break;
    }
  }
  const removed = store.sqlite.prepare("DELETE FROM agent_media WHERE NOT EXISTS (SELECT 1 FROM agent_run_media r WHERE r.hash = agent_media.hash)").run().changes;
  return { runs, removed };
}

function expireSnapshot(text: string | null): string | null {
  if (!text) return text;
  try {
    const snapshot = JSON.parse(text) as { media?: { images?: Array<Record<string, unknown>>; clip?: Record<string, unknown> } };
    if (snapshot.media?.images) snapshot.media.images = snapshot.media.images.map((image) => (image && typeof image.hash === "string" ? { ...image, expired: true } : image));
    if (snapshot.media?.clip && typeof snapshot.media.clip.hash === "string") snapshot.media.clip = { ...snapshot.media.clip, expired: true };
    return JSON.stringify(snapshot);
  } catch {
    return text;
  }
}
