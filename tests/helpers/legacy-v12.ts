import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DrizzleStore } from "@manga/storage-drizzle";

export type SeededV12 = { root: string; data: string; runs: string[]; images: number; unique: number; hashes: string[] };

/**
 * A synthetic v12 library for the move of the frozen pictures to v13 (计划 4.4): a current database made by this code and turned back into v12 (v13 only
 * added the two picture tables and one column of the call record), then `runs` Agent runs whose snapshots carry their pictures inline the way v12 wrote
 * them. Every third run reuses the same picture, one run is still running and one failed. `image` may give real picture bytes (the packaged
 * observation sends one); otherwise the bytes are synthetic. Nothing real is read.
 */
export function seedV12(options: { root?: string; runs?: number; image?: { bytes: Buffer; mediaType: string; width: number; height: number; origin: Record<string, unknown> } } = {}): SeededV12 {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "manga-v13-profile-"));
  const data = path.join(root, "data");
  fs.mkdirSync(data, { recursive: true });
  new DrizzleStore({ profileDir: data, hostId: "seed-v12" }).close();
  const db = new Database(path.join(data, "manga.sqlite"));
  db.exec("DROP TABLE agent_run_media; DROP TABLE agent_media; ALTER TABLE agent_requests DROP COLUMN delivery_json;");
  db.prepare("UPDATE schema_meta SET value = '12' WHERE key = 'schemaVersion'").run();
  const at = (n: number) => new Date(Date.parse("2026-09-01T00:00:00.000Z") + n * 60_000).toISOString();
  db.prepare("INSERT INTO agent_sessions(id, title, grant_handle, created_at, updated_at) VALUES (?,?,?,?,?)").run("ses-v12", "旧对话", "grant-v12", at(0), at(0));
  const insert = db.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, snapshot_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  const shared = options.image?.bytes ?? Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 251));
  const count = options.runs ?? 300;
  const runs: string[] = [];
  const hashes: string[] = [];
  const unique = new Set<string>();
  let images = 0;
  for (let index = 0; index < count; index += 1) {
    const id = `run-v12-${String(index).padStart(4, "0")}`;
    const status = index === 1 ? "running" : index === 2 ? "failed" : "succeeded";
    const own = Buffer.concat([Buffer.from(`synthetic-still-${index}-`), Buffer.alloc(2048 + (index % 13) * 512, index % 256)]);
    const pictures = index % 3 === 0 ? [shared] : [own, ...(index % 5 === 0 ? [shared] : [])];
    const frozen = pictures.map((bytes, ordinal) => ({
      id: `img_v12_${index}_${ordinal}`,
      mediaType: options.image?.mediaType ?? "image/jpeg",
      base64: bytes.toString("base64"),
      width: options.image?.width ?? 640,
      height: options.image?.height ?? 480,
      bytes: bytes.length,
      origin: options.image?.origin ?? { kind: "video_frame", resourceId: "res-v12", resourceRevisionId: "rev-v12", timeMs: index * 1000 },
      extraction: "合成的旧画面",
    }));
    for (const bytes of pictures) { const hash = createHash("sha256").update(bytes).digest("hex"); hashes.push(hash); unique.add(hash); }
    images += pictures.length;
    insert.run(id, "ses-v12", status, "grant-v12", "{}", `第 ${index} 个问题`, JSON.stringify({ capturedAt: at(index), media: { images: frozen } }), at(index), at(index));
    runs.push(id);
  }
  db.close();
  return { root, data, runs, images, unique: unique.size, hashes: hashes.sort() };
}
