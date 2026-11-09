import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { MangaProductApp, TestVault } from "../../packages/app-core/src/index.ts";
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
const SAMPLE_ID = "video-mp4-h264-aac";
const SMOKE_CREDENTIALS = { appId: "smokeapp01", secret: "smoke-secret-for-the-local-fake-server" };

async function call(app, actor, grant, commandId, input) {
  const result = await app.call(actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, grant.handle);
  if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
  return result.value;
}

async function waitMediaJobsIdle(app) {
  while (app.media.jobs.list({ active: true }).length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Seed a clean template Profile containing the synthetic video so the four windows do not repeat FFprobe/cover scans and reloads. */
async function seedReaderTemplate(baseDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, "manifest.json"), "utf8"));
  const entry = manifest.samples.find((item) => item.id === SAMPLE_ID && item.status === "generated");
  if (!entry) return null;
  const mediaDir = path.join(baseDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.copyFileSync(path.join(SAMPLES, entry.path), path.join(mediaDir, "合成动画.mp4"));
  const templateDir = path.join(baseDir, "template");
  const profileRoot = path.join(templateDir, "root");
  const documentsDir = path.join(templateDir, "documents");
  const pointerPath = path.join(templateDir, "launcher", "pointer.json");
  const app = new MangaProductApp({
    profileRoot,
    documentsDir,
    pointerPath,
    channel: "test",
    hostId: "bench-reader-seed",
    vault: new TestVault("bench-reader-seed"),
    useParseWorker: true,
  });
  await app.start();
  try {
    const actor = { kind: "user", id: "bench-reader-seed" };
    const grant = app.issueOwnerGrant(actor);
    await call(app, actor, grant, "settings.skipAi", {});
    await call(app, actor, grant, "library.scan.setSchedule", { onStartup: false, intervalMinutes: 0 });
    await call(app, actor, grant, "library.paths.add", { pathHandle: app.registerPath("directory", mediaDir), mediaKind: "video", autoScan: true });
    await app.scan.whenIdle();
    await waitMediaJobsIdle(app);
    const works = (await call(app, actor, grant, "works.list", { limit: 20, group: false }))?.items ?? [];
    const work = works[0];
    if (!work) return null;
    const got = await call(app, actor, grant, "works.get", { workId: work.id });
    const resourceId = got?.lastResource?.id ?? got?.resources?.[0]?.id ?? null;
    if (!resourceId) return null;
    app.noteFiles?.flush?.();
    return { resourceId, template: { root: profileRoot, documents: documentsDir } };
  } finally {
    app.close();
  }
}

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

export async function phase({ executable, args, name, spec, file, fake, template, specEnv = "MANGA_SMOKE_READER_SPEC" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-bench-${name}-`));
  const specFile = path.join(dir, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const root = path.join(dir, "root");
  const documents = path.join(dir, "documents");
  if (template?.root && fs.existsSync(template.root)) fs.cpSync(template.root, root, { recursive: true });
  if (template?.documents && fs.existsSync(template.documents)) fs.cpSync(template.documents, documents, { recursive: true });
  const env = {
    ...process.env,
    MANGA_CHANNEL: "test",
    MANGA_PROFILE_ROOT: root,
    MANGA_DOCUMENTS_DIR: documents,
    MANGA_POINTER_FILE: path.join(dir, "launcher", "pointer.json"),
    MANGA_SMOKE_PHASE: name,
    [specEnv]: specFile,
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
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return measured;
}

export async function runReaderBench({ executable, args, danmaku, memory }) {
  if (!fs.existsSync(path.join(SAMPLES, "manifest.json"))) return { ok: false, reason: "the synthetic samples are missing; run: node scripts/samples/generate-media-samples.mjs" };
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-reader-seed-"));
  try {
    const seeded = await seedReaderTemplate(sharedDir);
    const fake = await new FakeDandan().start();
    fake.accepts = SMOKE_CREDENTIALS;
    fake.comments.set(900102, busyComments(danmaku.comments, 20));
    let danmakuResult;
    try {
      danmakuResult = await phase({
        executable,
        args,
        name: "bench-danmaku",
        spec: seeded ? { ...danmaku, resourceId: seeded.resourceId } : danmaku,
        file: "bench-danmaku-window.json",
        fake,
        template: seeded?.template,
      });
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
      const one = await phase({
        executable,
        args,
        name: "bench-memory",
        spec: seeded ? { runs: 1, resourceId: seeded.resourceId } : { runs: 1 },
        file: "bench-memory-window.json",
        template: seeded?.template,
      });
      if (!one.ok) failures.push(...(one.failures ?? [one.reason ?? "the window run failed"]));
      raw.push(...(one.raw ?? []));
      rows.push(...(one.rows ?? []));
      processes.push(...(one.processes ?? []));
    }
    const memoryResult = { ok: failures.length === 0 && raw.length === memory.runs, failures, raw, rows, unit: "MiB", processes: [...new Set(processes)].sort() };
    return { danmaku: danmakuResult, memory: memoryResult };
  } finally {
    fs.rmSync(sharedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
