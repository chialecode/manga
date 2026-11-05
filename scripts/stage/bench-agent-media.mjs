import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { MangaProductApp, TestVault } from "../../packages/app-core/src/index.ts";
import { cutClip } from "../../packages/app-core/src/agent-native-input.ts";
import { keepMediaMutations, sha256 } from "../../packages/app-core/src/agent-media.ts";
import { resolveLaunchLayout } from "../../packages/app-core/src/locations.ts";
import { DrizzleStore } from "../../packages/storage-drizzle/src/index.ts";
import { seedV12 } from "../../tests/helpers/legacy-v12.ts";

/**
 * The service-side figures of the dependency and Agent loop stage (计划第 7 节), on synthetic data in temporary folders only:
 *  - a 60 s clip cut without re-encoding from a 90 s H.264 file (gated);
 *  - freezing a 4 MB picture for a run: its hash and the one transaction that keeps it (gated);
 *  - the v13 move of 300 runs' inline pictures, and the copy of a 500 MB profile to the new place (recorded).
 */
const samplesRoot = path.resolve(import.meta.dirname, "../../dist/samples/media");
const round = (value) => Math.round(value * 10) / 10;

async function openApp(dir) {
  const app = new MangaProductApp({ profileRoot: path.join(dir, "root"), documentsDir: path.join(dir, "documents"), pointerPath: path.join(dir, "launcher", "pointer.json"), channel: "test", hostId: "bench-media", vault: new TestVault("bench-media") });
  await app.start();
  const actor = { kind: "user", id: "bench-media" };
  const grant = app.issueOwnerGrant(actor);
  const call = async (commandId, input) => {
    const result = await app.call(actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, grant.handle);
    if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
    return result.value;
  };
  return { app, call };
}

async function clipBench(dir, runs) {
  const { app, call } = await openApp(dir);
  try {
    const ffmpeg = app.media.ffmpeg.tools?.ffmpeg;
    if (!ffmpeg) return { ok: false, reason: "ffmpeg is missing", raw: [] };
    const library = path.join(dir, "library");
    fs.mkdirSync(library, { recursive: true });
    const file = path.join(library, "九十秒.mp4");
    // 90 s of H.264 and AAC: the synthetic sample repeated by stream copy (the bundled FFmpeg has no H.264 encoder, and none is needed).
    const sample = path.join(samplesRoot, "video", "h264-aac.mp4");
    if (!fs.existsSync(sample)) return { ok: false, reason: "the synthetic H.264 sample is missing", raw: [] };
    const made = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", sample, "-t", "90", "-c", "copy", "-movflags", "+faststart", "-y", file], { windowsHide: true, timeout: 180_000 });
    if (made.status !== 0) return { ok: false, reason: `the synthetic video was not made: ${String(made.stderr).slice(0, 200)}`, raw: [] };
    await call("library.paths.add", { pathHandle: app.registerPath("directory", library), mediaKind: "video", autoScan: false });
    const video = await call("library.importDocument", { title: "九十秒", kind: "video", pathHandle: app.registerPath("file", file) });
    const raw = [];
    let bytes = 0;
    for (let index = 0; index < runs; index += 1) {
      const startMs = 10_000 + index * 2_000;
      const started = performance.now();
      const clip = await cutClip(app.videos, video.resourceId, video.revisionId, { startMs, endMs: startMs + 60_000 }, 512 * 1024 * 1024);
      raw.push(round(performance.now() - started));
      bytes = clip.length;
    }
    return { ok: raw.length === runs && bytes > 0, raw, clipBytes: bytes, sourceBytes: fs.statSync(file).size, wait: "cutClip from the call to the clip's bytes in memory (stream copy, no re-encoding)" };
  } finally {
    app.close();
  }
}

async function freezeBench(dir, runs) {
  const { app } = await openApp(dir);
  try {
    const at = new Date().toISOString();
    app.store.sqlite.prepare("INSERT INTO agent_sessions(id, title, grant_handle, created_at, updated_at) VALUES (?,?,?,?,?)").run("ses-bench", "基准", "grant-bench", at, at);
    const insertRun = app.store.sqlite.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
    const raw = [];
    for (let index = 0; index < runs; index += 1) {
      const runId = `run-bench-${index}`;
      insertRun.run(runId, "ses-bench", "succeeded", "grant-bench", "{}", "基准", at, at);
      // 4 MB that do not compress, different each time so every sample writes a new content.
      const bytes = crypto.randomBytes(4 * 1024 * 1024);
      const started = performance.now();
      const hash = sha256(bytes);
      const mutations = keepMediaMutations(runId, [{ bytes, hash, mime: "image/png", width: 2048, height: 2048, ordinal: 0 }], at);
      app.store.sqlite.transaction(() => { for (const mutation of mutations) app.store.sqlite.prepare(mutation.sql).run(...mutation.params); })();
      raw.push(round(performance.now() - started));
    }
    return { ok: raw.length === runs, raw, bytes: 4 * 1024 * 1024, wait: "the picture's SHA-256 and the transaction that keeps it for the run" };
  } finally {
    app.close();
  }
}

function migrationRecord(dir) {
  const seeded = seedV12({ root: path.join(dir, "v12"), runs: 300 });
  const file = path.join(seeded.data, "manga.sqlite");
  const before = fs.statSync(file).size;
  const started = performance.now();
  const store = new DrizzleStore({ profileDir: seeded.data, hostId: "bench-v13" });
  const ms = performance.now() - started;
  const migration = store.migration?.agentMedia ?? null;
  store.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  store.close();
  return { runs: 300, images: seeded.images, unique: seeded.unique, openMs: Math.round(ms), moveMs: migration?.ms ?? null, bytesBefore: before, bytesAfter: fs.statSync(file).size };
}

async function upgradeCopyRecord(dir) {
  const machine = { documents: path.join(dir, "Docs"), local: path.join(dir, "Local"), downloads: path.join(dir, "Downloads") };
  for (const folder of Object.values(machine)) fs.mkdirSync(folder, { recursive: true });
  const oldRoot = path.join(machine.documents, "MANGA", "release");
  const app = new MangaProductApp({ profileRoot: oldRoot, channel: "release", pointerPath: path.join(oldRoot, "launcher", "pointer.json"), documentsDir: machine.documents, hostId: "old", vault: new TestVault("old") });
  await app.start();
  app.close();
  // 500 MB of the application's own data that is carried (automatic backups stand for it; the cache is not carried), written in 1 MiB pieces.
  const filler = path.join(oldRoot, "backups", "filler");
  fs.mkdirSync(filler, { recursive: true });
  const piece = crypto.randomBytes(1024 * 1024);
  for (let file = 0; file < 50; file += 1) {
    const handle = fs.openSync(path.join(filler, `copy-${file}.bin`), "w");
    for (let mib = 0; mib < 10; mib += 1) fs.writeSync(handle, piece);
    fs.closeSync(handle);
  }
  const started = performance.now();
  const layout = resolveLaunchLayout({ channel: "release", documentsDir: machine.documents, downloadsDir: machine.downloads, localAppDataDir: machine.local });
  const ms = performance.now() - started;
  return { state: layout.upgrade?.state ?? null, files: layout.upgrade?.files ?? 0, bytes: layout.upgrade?.bytes ?? 0, ms: Math.round(ms) };
}

export async function runAgentMediaBench({ clipRuns = 8, freezeRuns = 20 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-media-"));
  try {
    const clip = await clipBench(path.join(dir, "clip"), clipRuns);
    const freeze = await freezeBench(path.join(dir, "freeze"), freezeRuns);
    const migration = migrationRecord(path.join(dir, "migration"));
    const upgrade = await upgradeCopyRecord(path.join(dir, "upgrade"));
    return { clip, freeze, migration, upgrade };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
