import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { FakeDandan } from "../../tests/helpers/fake-dandan.ts";
import { repoRoot } from "./lib.mjs";

/**
 * Two figures of the video player in the real window (see apps/desktop/src/main/smoke/bench-reader.ts):
 *
 * - `danmaku`: an episode with thousands of comments is played with the layer on, and the share of frames that reached the page late is counted against the
 *   same playback with the layer off. The comments come from a stand-in for the DanDanPlay service on the loopback address, which runs here, so the
 *   application is started without blocking this process; nothing leaves the machine.
 * - `memory`: what the application's working set grows by when a player is kept behind settings.
 *
 * Each runs in its own window and Profile, because the figures must not depend on what the other left behind.
 */

const SAMPLES = path.join(repoRoot, "dist/samples/media");
const SMOKE_CREDENTIALS = { appId: "smokeapp01", secret: "smoke-secret-for-the-local-fake-server" };

/** The comments of one episode, spread over its first seconds the way a busy moment of a real episode is (many at once, each mode, a few colors). */
export function busyComments(count, seconds) {
  const out = [];
  let state = 20250117;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const words = ["哈哈哈哈", "前方高能", "名场面", "太好笑了", "泪目", "这个作画", "好耶", "来了来了", "第一", "神回", "awsl", "草", "笑死我了", "bgm 响起来了", "这里的配音绝了"];
  for (let i = 0; i < count; i += 1) {
    const at = (next() % (seconds * 1000)) / 1000;
    const roll = next() % 100;
    const mode = roll < 88 ? 1 : roll < 94 ? 5 : 4;
    const color = [16777215, 16777215, 16711680, 65280, 255, 16776960][next() % 6];
    out.push({ cid: i + 1, p: `${at.toFixed(2)},${mode},${color},[Bench]u${next() % 5000}`, m: `${words[next() % words.length]}${i % 7 === 0 ? ` ${i}` : ""}` });
  }
  return out;
}

function runWindow({ executable, args, env, cwd, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdout.on("data", () => {});
    const timer = setTimeout(() => child.kill(), timeout);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ status: null, stderr: String(error.message) }); });
  });
}

async function phase({ executable, args, name, spec, file, fake }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-bench-${name}-`));
  const specFile = path.join(dir, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const root = path.join(dir, "root");
  const env = {
    ...process.env,
    MANGA_CHANNEL: "test",
    MANGA_PROFILE_ROOT: root,
    MANGA_DOCUMENTS_DIR: path.join(dir, "documents"),
    MANGA_POINTER_FILE: path.join(dir, "launcher", "pointer.json"),
    MANGA_SMOKE_PHASE: name,
    MANGA_SMOKE_READER_SPEC: specFile,
    MANGA_SMOKE_SAMPLES: SAMPLES,
    MANGA_SMOKE_LAUNCHED_AT: String(Date.now()),
    ...(fake ? { MANGA_SMOKE_DANDAN_ORIGIN: fake.origin } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = await runWindow({ executable, args, env, cwd: dir, timeout: 420_000 });
  const out = path.join(root, "logs", file);
  const measured = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : undefined;
  if (child.status !== 0 || !measured) {
    return { ok: false, reason: `${name} window run failed (exit ${child.status})`, stderr: child.stderr.slice(-1500), measured, dir };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return measured;
}

export async function runReaderBench({ executable, args, danmaku, memory }) {
  if (!fs.existsSync(path.join(SAMPLES, "manifest.json"))) return { ok: false, reason: "the synthetic samples are missing; run: node scripts/samples/generate-media-samples.mjs" };
  const fake = await new FakeDandan().start();
  fake.accepts = SMOKE_CREDENTIALS;
  fake.comments.set(900102, busyComments(danmaku.comments, 20));
  let danmakuResult;
  try {
    danmakuResult = await phase({ executable, args, name: "bench-danmaku", spec: danmaku, file: "bench-danmaku-window.json", fake });
    danmakuResult.requests = fake.requests.length;
    danmakuResult.signedOnly = fake.requests.every((request) => request.signed);
  } finally {
    await fake.stop();
  }
  // A window that has already shown a player keeps the memory it was given (the next one costs next to nothing), so every sample is a window of its own.
  const rows = [];
  const raw = [];
  const failures = [];
  const processes = [];
  for (let i = 0; i < memory.runs; i += 1) {
    const one = await phase({ executable, args, name: "bench-memory", spec: { runs: 1 }, file: "bench-memory-window.json" });
    if (!one.ok) failures.push(...(one.failures ?? [one.reason ?? "the window run failed"]));
    raw.push(...(one.raw ?? []));
    rows.push(...(one.rows ?? []));
    processes.push(...(one.processes ?? []));
  }
  const memoryResult = { ok: failures.length === 0 && raw.length === memory.runs, failures, raw, rows, unit: "MiB", processes: [...new Set(processes)].sort() };
  return { danmaku: danmakuResult, memory: memoryResult };
}
