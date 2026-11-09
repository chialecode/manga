import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangaProductApp, TestVault } from "../../packages/app-core/src/index.ts";
import { longChaptersEpub } from "../../apps/desktop/src/main/smoke/fixtures.ts";
import { phase } from "./bench-reader.mjs";
import { repoRoot } from "./lib.mjs";

const SAMPLES_ROOT = path.join(repoRoot, "dist/samples/media");
const SAMPLE_IDS = { videoA: "video-mp4-h264-aac", videoB: "video-vfr", comic: "cbz-basic" };
const LONG_CHAPTER_CHARACTERS = 300_000;

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

/**
 * Pre-seed the workspace benchmark media, projects, note and draft once in Node so the four windows do not repeat
 * FFprobe/CBZ scans and post-seed reloads. Memory windows receive the 1-novel snapshot; the main window receives
 * all `readers` novels plus the 300k-character two-chapter EPUB.
 */
async function seedWorkspaceTemplates(baseDir, readers) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES_ROOT, "manifest.json"), "utf8"));
  const sample = (id) => {
    const entry = manifest.samples.find((item) => item.id === id && item.status === "generated");
    return entry ? path.join(SAMPLES_ROOT, entry.path) : null;
  };
  const mediaRoot = path.join(baseDir, "media");
  const place = (kind, folder, name, from) => {
    if (!from) return null;
    const dir = path.join(mediaRoot, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(from, path.join(dir, name));
    return { dir, kind };
  };
  const places = [
    place("video", "video-a", "合成动画甲.mp4", sample(SAMPLE_IDS.videoA)),
    place("video", "video-b", "合成动画乙.mp4", sample(SAMPLE_IDS.videoB)),
    place("comic", "comic", "合成漫画.cbz", sample(SAMPLE_IDS.comic)),
  ];
  if (places.some((item) => !item)) return null;

  const memDir = path.join(baseDir, "memory-template");
  const memTemplate = { root: path.join(memDir, "root"), documents: path.join(memDir, "documents") };
  const memApp = new MangaProductApp({
    profileRoot: memTemplate.root,
    documentsDir: memTemplate.documents,
    pointerPath: path.join(memDir, "launcher", "pointer.json"),
    channel: "test",
    hostId: "bench-workspace-seed-mem",
    vault: new TestVault("bench-workspace-seed"),
    useParseWorker: true,
  });
  await memApp.start();
  let baseSeeds;
  try {
    const actor = { kind: "user", id: "bench-workspace-seed" };
    const grant = memApp.issueOwnerGrant(actor);
    await call(memApp, actor, grant, "settings.skipAi", {});
    await call(memApp, actor, grant, "library.scan.setSchedule", { onStartup: false, intervalMinutes: 0 });
    for (const item of places) {
      await call(memApp, actor, grant, "library.paths.add", { pathHandle: memApp.registerPath("directory", item.dir), mediaKind: item.kind, autoScan: true });
    }
    await memApp.scan.whenIdle();
    await waitMediaJobsIdle(memApp);
    const works = (await call(memApp, actor, grant, "works.list", { limit: 50, group: false }))?.items ?? [];
    const resourceOf = async (match) => {
      const work = works.find(match);
      if (!work) return null;
      const got = await call(memApp, actor, grant, "works.get", { workId: work.id });
      return got?.lastResource?.id ?? got?.resources?.[0]?.id ?? null;
    };
    const videoA = await resourceOf((work) => work.mediaKind === "video" && work.title.includes("甲"));
    const videoB = await resourceOf((work) => work.mediaKind === "video" && work.title.includes("乙"));
    const comic = await resourceOf((work) => work.mediaKind === "comic");
    if (!videoA || !videoB || !comic) return null;
    const text0 = `${"基准正文，每一段都不长。".repeat(120)}末尾标记0`;
    const firstNovel = String((await call(memApp, actor, grant, "library.importDocument", { title: "基准书01", format: "txt", bytes: [...new TextEncoder().encode(text0)] }))?.resourceId ?? "");
    const noteId = String((await call(memApp, actor, grant, "notes.create", { title: "基准文稿", text: "基准文稿的正文。" }))?.objectId ?? "");
    const projects = [];
    for (const name of ["基准项目甲", "基准项目乙"]) {
      const made = await call(memApp, actor, grant, "project.create", { name });
      if (made?.id) projects.push(String(made.id));
    }
    const drafted = projects[0] ? await call(memApp, actor, grant, "draft.create", { projectId: projects[0], title: "基准文稿", text: "基准文稿的正文。" }) : null;
    const draftId = String(drafted?.draft?.id ?? "");
    if (!firstNovel || !noteId || projects.length < 2 || !draftId) return null;
    memApp.noteFiles?.flush?.();
    baseSeeds = { videoA, videoB, comic, novels: [firstNovel], noteId, projects, draftId };
  } finally {
    memApp.close();
  }

  const winDir = path.join(baseDir, "window-template");
  const winTemplate = { root: path.join(winDir, "root"), documents: path.join(winDir, "documents") };
  fs.cpSync(memTemplate.root, winTemplate.root, { recursive: true });
  if (fs.existsSync(memTemplate.documents)) fs.cpSync(memTemplate.documents, winTemplate.documents, { recursive: true });
  const winApp = new MangaProductApp({
    profileRoot: winTemplate.root,
    documentsDir: winTemplate.documents,
    pointerPath: path.join(winDir, "launcher", "pointer.json"),
    channel: "test",
    hostId: "bench-workspace-seed-win",
    vault: new TestVault("bench-workspace-seed"),
    useParseWorker: true,
  });
  await winApp.start();
  let windowSeeds;
  try {
    const actor = { kind: "user", id: "bench-workspace-seed" };
    const grant = winApp.issueOwnerGrant(actor);
    const novels = [...baseSeeds.novels];
    for (let i = 1; i < readers; i += 1) {
      const text = `${"基准正文，每一段都不长。".repeat(120)}末尾标记${i}`;
      const imported = await call(winApp, actor, grant, "library.importDocument", { title: `基准书${String(i + 1).padStart(2, "0")}`, format: "txt", bytes: [...new TextEncoder().encode(text)] });
      if (imported?.resourceId) novels.push(String(imported.resourceId));
    }
    const longMade = await call(winApp, actor, grant, "library.importDocument", { title: "基准长章 EPUB", format: "epub", bytes: [...longChaptersEpub(2, LONG_CHAPTER_CHARACTERS)] });
    const longBook = String(longMade?.resourceId ?? "");
    if (novels.length < readers || !longBook) return null;
    winApp.noteFiles?.flush?.();
    windowSeeds = { ...baseSeeds, novels, longBook };
  } finally {
    winApp.close();
  }

  return { memory: { template: memTemplate, seeds: baseSeeds }, window: { template: winTemplate, seeds: windowSeeds } };
}

/**
 * The workspace in the real window (plan 7; see apps/desktop/src/main/smoke/bench-workspace.ts):
 *
 * - `window`: switching tabs, switching contexts (loaded, and made anew after a restart), the readers kept loaded after ten were opened, and the frames
 *   given to the page while a video plays in four columns.
 * - `memory`: what the application's working set grows by from a video in a single column to the four columns.
 *
 * The first runs in one window; the memory figure runs in a window of its own for each sample, because a window that has shown a player keeps the memory it
 * was given (see bench-reader.mjs).
 */
export async function runWorkspaceBench({ executable, args, window: windowSpec, memory }) {
  if (!fs.existsSync(path.join(SAMPLES_ROOT, "manifest.json"))) return { ok: false, reason: "the synthetic samples are missing; run: node scripts/samples/generate-media-samples.mjs" };
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-workspace-seed-"));
  try {
    const seeded = await seedWorkspaceTemplates(sharedDir, windowSpec.readers);
    const common = { executable, args, specEnv: "MANGA_SMOKE_WORKSPACE_SPEC" };
    const measured = await phase({
      ...common,
      name: "bench-workspace",
      spec: seeded ? { ...windowSpec, seeds: seeded.window.seeds } : windowSpec,
      file: "bench-workspace-window.json",
      template: seeded?.window.template,
    });
    const rows = [];
    const raw = [];
    const failures = [];
    const stderr = [];
    for (let i = 0; i < memory.runs; i += 1) {
      const one = await phase({
        ...common,
        name: "bench-workspace-memory",
        spec: seeded ? { runs: 1, seeds: seeded.memory.seeds } : { runs: 1 },
        file: "bench-workspace-memory-window.json",
        template: seeded?.memory.template,
      });
      if (!one.ok) failures.push(...(one.failures ?? [one.reason ?? "the window run failed"]));
      if (!one.ok && one.stderr) stderr.push(one.stderr);
      raw.push(...(one.raw ?? []));
      rows.push(...(one.rows ?? []));
    }
    return { window: measured, memory: { ok: failures.length === 0 && raw.length === memory.runs, failures, raw, rows, unit: "MiB", stderr: stderr.join(" | ") } };
  } finally {
    fs.rmSync(sharedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
