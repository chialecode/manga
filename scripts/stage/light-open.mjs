import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { repoRoot } from "./lib.mjs";

/**
 * Light open in the packaged build (READ-05, A-128, 第 7 节): the windows (`light-video`, `light-video-copy`, `light-comic`, `light-multi`), what
 * light open writes, its own single-instance lock beside the full application's, and what its bundles carry (`light-boundary`). Synthetic samples
 * only, a fresh application data root for each run, nothing from GitHub.
 */
const require = createRequire(import.meta.url);

function spawnApp(appPath, args, env, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const clean = { ...env };
    for (const name of Object.keys(clean)) if (name.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete clean[name];
    const startedAt = Date.now();
    const child = spawn(path.join(appPath, "manga.exe"), args, { env: { ...clean, MANGA_SMOKE_SPAWNED_AT: String(startedAt) }, windowsHide: true });
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, ms: Date.now() - startedAt, pid: child.pid, stderr: stderr.slice(-2000) }); });
    child.on("error", () => { clearTimeout(timer); resolve({ status: null, ms: Date.now() - startedAt, pid: child.pid, stderr }); });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const filesUnder = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((name) => { try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; } }) : []);

/** A machine of its own: the application data root, Documents, Downloads and the launcher pointer all in one temporary folder. */
export function lightHome(prefix = "manga-light-") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = {
    ...process.env,
    MANGA_CHANNEL: "test",
    MANGA_PROFILE_ROOT: path.join(home, "root"),
    MANGA_DOCUMENTS_DIR: path.join(home, "documents"),
    MANGA_DOWNLOADS_DIR: path.join(home, "downloads"),
    MANGA_POINTER_FILE: path.join(home, "launcher", "pointer.json"),
    ELECTRON_ENABLE_LOGGING: "1",
  };
  return { home, env, lightRoot: path.join(home, "root", "light") };
}

function ffmpegPath() {
  const dir = path.join(repoRoot, "dist/tools/ffmpeg");
  const found = filesUnder(dir).find((name) => path.basename(name).toLowerCase() === "ffmpeg.exe");
  if (!found) throw new Error("the pinned FFmpeg is missing under dist/tools/ffmpeg; run node scripts/tools/fetch-ffmpeg.mjs");
  return path.join(dir, found);
}

/** Folders of synthetic files arranged the way light open meets them: three episodes (one with two audio tracks and its own subtitles) and two books. */
export function lightSamples(samplesRoot, into) {
  const ffmpeg = ffmpegPath();
  const show = path.join(into, "show");
  fs.mkdirSync(show, { recursive: true });
  const source = path.join(samplesRoot, "video", "h264-aac.mp4");
  const twoAudio = spawnSync(ffmpeg, ["-v", "error", "-y", "-i", source, "-map", "0:v", "-map", "0:a", "-map", "0:a", "-c", "copy", "-metadata:s:a:0", "language=jpn", "-metadata:s:a:1", "language=chi", path.join(show, "第 01 话.mp4")], { encoding: "utf8" });
  if (twoAudio.status !== 0) throw new Error(`could not make the two-track sample: ${twoAudio.stderr}`);
  fs.copyFileSync(path.join(samplesRoot, "video", "external-subs", "episode.zh-CN.srt"), path.join(show, "第 01 话.zh-CN.srt"));
  fs.copyFileSync(source, path.join(show, "第 02 话.mp4"));
  fs.copyFileSync(source, path.join(show, "第 10 话.mp4"));
  const books = path.join(into, "books");
  fs.mkdirSync(books, { recursive: true });
  fs.copyFileSync(path.join(samplesRoot, "comic", "cbz-basic.cbz"), path.join(books, "第 1 卷.cbz"));
  fs.copyFileSync(path.join(samplesRoot, "comic", "cbz-comicinfo.cbz"), path.join(books, "第 2 卷.cbz"));
  const pictures = path.join(into, "pictures");
  fs.cpSync(path.join(samplesRoot, "comic", "dir-natural"), pictures, { recursive: true });
  fs.writeFileSync(path.join(pictures, "readme.txt"), "not a page\n");
  const copyNeeded = path.join(samplesRoot, "video", "ac3.mkv");
  const unsupported = path.join(into, "notes.txt");
  fs.writeFileSync(unsupported, "light open does not take this\n");
  return { first: path.join(show, "第 01 话.mp4"), second: path.join(show, "第 02 话.mp4"), last: path.join(show, "第 10 话.mp4"), book: path.join(books, "第 1 卷.cbz"), book2: path.join(books, "第 2 卷.cbz"), picture: path.join(pictures, "3.png"), copyNeeded, unsupported };
}

/** A 1080p H.264 file that plays as it is, for the light open benchmarks (第 7 节). */
export function benchVideo(into, seconds = 12) {
  const file = path.join(into, "bench-1080p.mp4");
  const made = spawnSync(ffmpegPath(), ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=24:duration=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:v", "libopenh264", "-g", "48", "-b:v", "2000k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-shortest", file], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`could not make the 1080p sample: ${made.stderr}`);
  return file;
}

async function runPhase(appPath, env, phase, file, extra = {}, timeoutMs = 240_000) {
  const report = path.join(path.dirname(env.MANGA_PROFILE_ROOT), "reports", `${phase}-${Date.now()}.json`);
  const args = ["--manga-light", ...(file ? [file] : []), "--manga-smoke"];
  const run = await spawnApp(appPath, args, { ...env, MANGA_SMOKE_PHASE: phase, MANGA_SMOKE_REPORT: report, ...extra }, timeoutMs);
  const body = readJson(report);
  return { run, report: body, rows: body?.observations ?? [{ name: `${phase}-report`, status: "failed", detail: { status: run.status, stderr: run.stderr } }] };
}

/** Wait until a file says what is wanted. */
async function until(check, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await sleep(100);
  }
  return null;
}

/** Everything light open checks in its windows and from outside. Returns the observation rows (each one named) and the timings. */
export async function observeLightOpen({ appPath, samplesRoot, evidenceDir }) {
  const rows = [];
  const timings = {};
  const { home, env, lightRoot } = lightHome();
  const samples = lightSamples(samplesRoot, path.join(home, "files"));
  const shots = evidenceDir ? { MANGA_SMOKE_EVIDENCE_DIR: evidenceDir } : {};
  try {
    // ---- light-video: first frame, play, pause, keys, rate, audio track, subtitles, next episode; and where it was left, next time ----
    const video = await runPhase(appPath, env, "light-video", samples.first, { ...shots, MANGA_SMOKE_NEXT: "1" });
    rows.push(...video.rows);
    timings.videoFirstFrameMs = video.report?.timings?.firstFrameMs ?? null;
    timings.videoMemoryMiB = video.report?.timings?.memoryWorkingSetMiB ?? null;
    rows.push({ name: "light-video-exits-with-its-window", status: video.run.status === 0 ? "passed" : "failed", detail: { status: video.run.status } });
    const resume = await runPhase(appPath, env, "light-video-resume", samples.second);
    rows.push(...resume.rows);
    // ---- light-video-copy ----
    const copy = await runPhase(appPath, env, "light-video-copy", samples.copyNeeded, {}, 360_000);
    rows.push(...copy.rows);
    // ---- light-comic: a CBZ (and the next book), then where it was left; a picture in the middle of a folder ----
    const comic = await runPhase(appPath, env, "light-comic", samples.book, { ...shots, MANGA_SMOKE_NEXT: "1" });
    rows.push(...comic.rows);
    timings.comicFirstPageMs = comic.report?.timings?.firstPageMs ?? null;
    const comicResume = await runPhase(appPath, env, "light-comic-resume", samples.book, { MANGA_SMOKE_EXPECT_PAGE: "2" });
    rows.push(...comicResume.rows);
    const picture = await runPhase(appPath, env, "light-comic", samples.picture, { MANGA_SMOKE_START_PAGE: "2" });
    rows.push(...picture.rows.map((row) => ({ ...row, name: row.name.replace("light-comic", "light-image") })));
    // ---- an empty window, and a file light open does not take ----
    rows.push(...(await runPhase(appPath, env, "light-empty", null, shots)).rows);
    rows.push(...(await runPhase(appPath, env, "light-unsupported", samples.unsupported)).rows);
    // ---- light open writes only under <app data root>\light\ (4.6) ----
    const outside = filesUnder(home).map((name) => name.replaceAll("\\", "/")).filter((name) => !name.startsWith("root/light/") && !name.startsWith("files/") && !name.startsWith("reports/"));
    const remembered = readJson(path.join(lightRoot, "positions.json"));
    // Hashes only (4.4): file keys, and a comic page by the hash of its id; no name of a file, a folder or a page anywhere in the file.
    const entries = Object.entries(remembered?.positions ?? {});
    const named = filesUnder(path.join(home, "files")).flatMap((name) => name.replaceAll("\\", "/").split("/")).filter((part) => part.length > 2);
    const text = JSON.stringify(remembered ?? {});
    const keysOnly = Boolean(remembered) && entries.length > 0
      && entries.every(([key, value]) => /^[0-9a-f]{64}$/.test(key) && (value.kind === "video" || (value.kind === "comic" && /^[0-9a-f]{64}$/.test(value.page ?? "") && value.pageId === undefined)))
      && !text.includes("第") && !named.some((part) => text.includes(part));
    rows.push({ name: "light-writes-only-its-folder", status: outside.length === 0 && keysOnly ? "passed" : "failed", detail: { outside, positions: Object.keys(remembered?.positions ?? {}).length, keysOnly } });
    // ---- light-multi: one light process with three windows, while the full application runs and keeps its own lock ----
    const full = spawn(path.join(appPath, "manga.exe"), [], { env: { ...env, MANGA_WINDOW_HIDDEN: "1" }, windowsHide: true });
    const fullReady = await until(() => readJson(path.join(env.MANGA_PROFILE_ROOT, "runtime", "running-instance.json"))?.state === "ready", 90_000);
    const holder = runPhase(appPath, env, "light-multi", samples.first, { MANGA_SMOKE_WINDOWS: "3" });
    const instance = await until(() => readJson(path.join(lightRoot, "runtime", "light-instance.json")), 30_000);
    const handedOver = [];
    for (const file of [samples.book, samples.picture]) handedOver.push(await spawnApp(appPath, ["--manga-light", file], env, 30_000));
    // A second start of the full application still goes to the running one and leaves at once.
    const secondFull = await spawnApp(appPath, [], env, 30_000);
    const multi = await holder;
    rows.push(...multi.rows);
    const onePid = multi.report?.pid === instance?.pid && handedOver.every((run) => run.status === 0 && run.ms < 15_000);
    rows.push({
      name: "light-multi-one-process",
      status: fullReady && onePid && full.exitCode === null && alive(full.pid) && secondFull.status === 0 ? "passed" : "failed",
      detail: { fullReady: Boolean(fullReady), lightPid: instance?.pid ?? null, windowsPid: multi.report?.pid ?? null, handedOverMs: handedOver.map((run) => run.ms), fullStillRunning: alive(full.pid), secondFullStatus: secondFull.status },
    });
    rows.push({
      name: "light-separate-lock",
      status: fullReady && alive(full.pid) && multi.report?.pid !== full.pid && fs.existsSync(path.join(lightRoot, "runtime")) ? "passed" : "failed",
      detail: { lightUserData: "root/light/runtime", fullUserData: "root/runtime" },
    });
    full.kill();
    await until(() => !alive(full.pid), 15_000);
  } catch (error) {
    rows.push({ name: "light-open-error", status: "failed", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    await sleep(500);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return { ok: rows.length > 0 && rows.every((row) => row.status === "passed"), observations: rows, timings };
}

/**
 * `light-boundary` (4.1): the packaged bootstrap, light open's main process and light open's page carry none of the full application's library,
 * plugin, Agent or update code. Each marker is first found in the full application's bundle, so a marker that a build renames cannot pass unseen.
 */
export const LIGHT_BOUNDARY_MARKERS = [
  { name: "better-sqlite3", text: "better-sqlite3" },
  { name: "drizzle", text: "drizzle" },
  // MangaProductApp's own name does not survive minification; the library schema it opens does.
  { name: "MangaProductApp (the library schema)", text: "schema_meta" },
  { name: "electron-updater", text: "electron-updater" },
  { name: "plugin runtime", text: "utilityProcess" },
  { name: "agent runtime", text: "agent_runs" },
];

export function checkLightBoundary(appPath) {
  const asar = require("@electron/asar");
  const archive = path.join(appPath, "resources", "app.asar");
  const read = (file) => { try { return asar.extractFile(archive, path.normalize(file)).toString("utf8"); } catch { return null; } };
  const listed = asar.listPackage(archive, { isPack: false }).map((name) => name.replaceAll("\\", "/").replace(/^\//, ""));
  const full = read(".vite/build/full-main.cjs");
  const bootstrap = read(".vite/build/main.cjs");
  const lightMain = read(".vite/build/light-main.cjs");
  const lightPreload = read(".vite/build/preload-light.cjs");
  const lightPage = listed.filter((name) => name.startsWith(".vite/renderer/light_window/") && /\.(js|mjs|html)$/.test(name)).map((name) => ({ name, text: read(name) ?? "" }));
  const problems = [];
  if (!full || !bootstrap || !lightMain || !lightPreload || lightPage.length === 0) problems.push("a bundle is missing from the package");
  const markers = LIGHT_BOUNDARY_MARKERS.map((marker) => {
    const inFull = Boolean(full?.includes(marker.text));
    const found = [
      ...(bootstrap?.includes(marker.text) ? ["main.cjs"] : []),
      ...(lightMain?.includes(marker.text) ? ["light-main.cjs"] : []),
      ...(lightPreload?.includes(marker.text) ? ["preload-light.cjs"] : []),
      ...lightPage.filter((file) => file.text.includes(marker.text)).map((file) => path.basename(file.name)),
    ];
    if (!inFull) problems.push(`the marker of ${marker.name} is not in the full application's bundle, so its absence proves nothing`);
    if (found.length) problems.push(`${marker.name} is in ${found.join(", ")}`);
    return { name: marker.name, inFull, foundIn: found };
  });
  const bootstrapRequires = [...(bootstrap ?? "").matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]).filter((name) => !/^(node:)?[a-z_]+$/.test(name) && name !== "electron");
  if (bootstrapRequires.length) problems.push(`the bootstrap requires ${bootstrapRequires.join(", ")}`);
  return {
    name: "light-boundary",
    status: problems.length === 0 ? "passed" : "failed",
    detail: { markers, bytes: { bootstrap: bootstrap?.length ?? 0, lightMain: lightMain?.length ?? 0, fullMain: full?.length ?? 0, lightPage: lightPage.reduce((sum, file) => sum + file.text.length, 0) }, problems },
  };
}

/**
 * `light-update` (4.6): a test identity's development build "installed" in a machine of its own, with a real light window open from the package
 * (it runs the same executable an install replaces). `install-dev` asks light open to keep its place and leave, then installs; a light open that
 * will not leave (the test identity's refusal switch) means nothing is installed and the reason is given.
 */
export async function observeLightUpdate({ appPath, samplesRoot, runInstallDev }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "manga-light-update-"));
  const places = { programs: path.join(home, "Programs"), local: path.join(home, "local"), documents: path.join(home, "documents"), downloads: path.join(home, "downloads") };
  for (const dir of Object.values(places)) fs.mkdirSync(dir, { recursive: true });
  const installDir = path.join(places.programs, "manga-dev-test");
  fs.mkdirSync(path.join(installDir, "resources"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "manga-dev-test.exe"), "synthetic development executable");
  const build = (version) => fs.writeFileSync(path.join(installDir, "resources", "build.json"), `${JSON.stringify({ version, channel: "development", commit: "1111111", builtAt: "2026-11-09T00:00:00.000Z", schemaVersion: 14 })}\n`);
  build("0.1.2-dev.202611090900");
  const installer = path.join(home, "manga-dev-test-setup-0.1.2-dev.202611091000.exe");
  fs.writeFileSync(installer, "synthetic installer");
  const video = path.join(home, "files", "clip.mp4");
  fs.mkdirSync(path.dirname(video), { recursive: true });
  fs.copyFileSync(path.join(samplesRoot, "video", "h264-aac.mp4"), video);
  const runtime = path.join(places.local, "manga-dev-test", "light", "runtime");
  const env = { ...process.env, LOCALAPPDATA: places.local, MANGA_DOCUMENTS_DIR: places.documents, MANGA_DOWNLOADS_DIR: places.downloads, MANGA_CHANNEL: "development", MANGA_TEST_IDENTITY: "1" };
  for (const name of ["MANGA_PROFILE_ROOT", "MANGA_POINTER_FILE"]) delete env[name];
  const snapshotOptions = { registryEntries: [], localAppDataDir: path.join(home, "real-local"), roamingAppDataDir: path.join(home, "real-roaming"), desktopDir: path.join(home, "real-desktop"), programsDir: path.join(home, "real-programs"), registry: () => null };
  const open = async (extra = {}) => {
    const report = path.join(home, `hold-${Date.now()}.json`);
    const run = spawnApp(appPath, ["--manga-light", video, "--manga-smoke"], { ...env, MANGA_SMOKE_PHASE: "light-hold", MANGA_SMOKE_REPORT: report, ...extra }, 120_000);
    const ready = await until(() => readJson(report)?.waiting === true && readJson(path.join(runtime, "light-instance.json")), 60_000);
    return { run, pid: ready?.pid ?? null };
  };
  const rows = [];
  let refused = null;
  try {
    // 1. Light open leaves (keeping its place), then the installer runs.
    const first = await open();
    let installs = 0;
    const left = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" }, testIdentity: true, places, installDir, installerPath: installer,
      newVersion: "0.1.2-dev.202611091000", evidenceDir: null, registryEntries: [], runningProcessesFn: () => [], snapshotOptions,
      spawnInstallerFn: async () => { installs += 1; build("0.1.2-dev.202611091000"); return { status: 0 }; },
    });
    const exited = await first.run;
    const positions = readJson(path.join(places.local, "manga-dev-test", "light", "positions.json"));
    rows.push({
      name: "light-update-leaves-then-installs",
      status: first.pid && left.status === "passed" && left.installed && installs === 1 && exited.status === 0 && !alive(first.pid) && Object.keys(positions?.positions ?? {}).length === 1 ? "passed" : "failed",
      detail: { status: left.status, installed: left.installed, installs, lightExit: exited.status, remembered: Object.keys(positions?.positions ?? {}).length, reason: left.reason ?? null },
    });

    // 2. A light open that will not leave: nothing is installed, and the reason says to close it.
    build("0.1.2-dev.202611091000");
    const stuck = await open({ MANGA_TEST_LIGHT_REFUSE_QUIT: "1" });
    refused = stuck;
    let refusedInstalls = 0;
    const started = Date.now();
    const kept = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" }, testIdentity: true, places, installDir, installerPath: installer,
      newVersion: "0.1.2-dev.202611091100", evidenceDir: null, registryEntries: [], runningProcessesFn: () => [], snapshotOptions,
      spawnInstallerFn: async () => { refusedInstalls += 1; return { status: 0 }; },
    });
    rows.push({
      name: "light-update-refused-not-installed",
      status: stuck.pid && kept.status === "aborted" && !kept.installed && refusedInstalls === 0 && String(kept.reason).includes("请先关闭轻量播放窗口") && alive(stuck.pid) && !fs.existsSync(path.join(runtime, "quit-request.json")) ? "passed" : "failed",
      detail: { status: kept.status, installed: kept.installed, reason: kept.reason ?? null, lightStillOpen: stuck.pid ? alive(stuck.pid) : false, waitedMs: Date.now() - started },
    });
  } catch (error) {
    rows.push({ name: "light-update-error", status: "failed", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    if (refused?.pid && alive(refused.pid)) { try { process.kill(refused.pid); } catch { /* gone */ } }
    if (refused) await refused.run;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  const ok = rows.length === 2 && rows.every((row) => row.status === "passed");
  return [{ name: "light-update", status: ok ? "passed" : "failed", detail: { checks: rows } }];
}

/**
 * The light open benchmarks (第 7 节): five cold opens of a 1080p H.264 video to its first frame and of a CBZ to its first page (light open not
 * running before each), and five opens of a video into a light open that is already running. Recorded beside them: the working set with one video
 * playing, and the full application opening the same video from outside its library (start of the process to the first frame). The first cold run
 * of a fresh data root also makes Chromium's profile; it is recorded as `firstEverMs` and not counted.
 */
export async function benchLightOpen({ appPath, samplesRoot, runs = 5, fullApp = true }) {
  const { home, env } = lightHome("manga-light-bench-");
  const files = path.join(home, "files");
  fs.mkdirSync(files, { recursive: true });
  const video = benchVideo(files);
  const second = path.join(files, "bench-1080p-second.mp4");
  fs.copyFileSync(video, second);
  const book = path.join(files, "bench.cbz");
  fs.copyFileSync(path.join(samplesRoot, "comic", "cbz-basic.cbz"), book);
  const failures = [];
  const result = { videoFirstFrameMs: [], comicFirstPageMs: [], secondOpenMs: [], workingSetMiB: [], firstEverMs: null, fullAppFirstFrameMs: null, fullAppListedMs: null };
  try {
    const warm = await runPhase(appPath, env, "light-bench", video, {}, 120_000);
    result.firstEverMs = warm.report?.timings?.firstFrameMs ?? null;
    for (let n = 0; n < runs; n += 1) {
      const one = await runPhase(appPath, env, "light-bench", video, {}, 120_000);
      if (one.report?.ok !== true) failures.push(`video run ${n + 1}: ${JSON.stringify(one.rows).slice(0, 300)}`);
      else { result.videoFirstFrameMs.push(one.report.timings.firstFrameMs); result.workingSetMiB.push(one.report.timings.workingSetMiB); }
    }
    for (let n = 0; n < runs; n += 1) {
      const one = await runPhase(appPath, env, "light-bench", book, { MANGA_SMOKE_BENCH_KIND: "comic" }, 120_000);
      if (one.report?.ok !== true) failures.push(`comic run ${n + 1}: ${JSON.stringify(one.rows).slice(0, 300)}`);
      else result.comicFirstPageMs.push(one.report.timings.firstPageMs);
    }
    // A running light open (holding the first video) gets five more opens, each from a process of its own, as a double-click starts one.
    const report = path.join(home, "reports", `second-${Date.now()}.json`);
    const holding = spawnApp(appPath, ["--manga-light", video, "--manga-smoke"], { ...env, MANGA_SMOKE_PHASE: "light-hold", MANGA_SMOKE_REPORT: report, MANGA_SMOKE_SECOND_OPENS: String(runs) }, 300_000);
    const ready = await until(() => readJson(report)?.waiting === true, 60_000);
    if (!ready) failures.push("the running light open did not come up");
    for (let n = 0; ready && n < runs; n += 1) {
      const before = readJson(report)?.secondOpenMs?.length ?? 0;
      const at = Date.now();
      await spawnApp(appPath, ["--manga-light", second, `--manga-smoke-spawned-at=${at}`], { ...env, MANGA_SMOKE_PHASE: "" }, 60_000);
      if (!(await until(() => (readJson(report)?.secondOpenMs?.length ?? 0) > before, 60_000))) { failures.push(`second open ${n + 1} did not show a frame`); break; }
    }
    const held = readJson(report);
    result.secondOpenMs = held?.secondOpenMs ?? [];
    if (held?.pid && alive(held.pid)) { try { process.kill(held.pid); } catch { /* gone */ } }
    await holding;
    if (fullApp) {
      // The full application's comparison: a profile of its own, the same video in a folder it has not seen.
      const outside = path.join(home, "outside");
      fs.mkdirSync(outside, { recursive: true });
      fs.copyFileSync(video, path.join(outside, "对照.mp4"));
      const fullHome = lightHome("manga-full-open-");
      try {
        const started = Date.now();
        const run = await spawnApp(appPath, ["--manga-smoke"], { ...fullHome.env, MANGA_SMOKE_PHASE: "bench-open-video", MANGA_SMOKE_OPEN_VIDEO: path.join(outside, "对照.mp4"), MANGA_SMOKE_SPAWNED_AT: String(started) }, 180_000);
        const measured = readJson(path.join(fullHome.env.MANGA_PROFILE_ROOT, "logs", "bench-open-video-window.json"));
        if (run.status === 0 && measured?.ok) { result.fullAppFirstFrameMs = measured.firstFrameMs; result.fullAppListedMs = measured.listedMs; }
        else failures.push(`the full application's comparison did not finish (exit ${run.status})`);
      } finally {
        await sleep(200);
        fs.rmSync(fullHome.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  } finally {
    await sleep(200);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return { ok: failures.length === 0 && result.videoFirstFrameMs.length === runs && result.comicFirstPageMs.length === runs && result.secondOpenMs.length === runs, failures, ...result };
}
