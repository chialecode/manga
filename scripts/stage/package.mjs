import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { startSwarm } from "../../tests/helpers/bt-swarm.ts";
import { FakeDandan } from "../../tests/helpers/fake-dandan.ts";
import { desktopPackageDir, latestDesktopPackage } from "../desktop-paths.ts";
import { currentStage, loadGate, repoRoot as root, runDir, stageFingerprints } from "./lib.mjs";

const stage = currentStage();
const config = loadGate();
if (process.platform !== "win32") throw new Error("package verification targets Windows x64");
const sqlite = spawnSync(process.execPath, ["scripts/verify-electron-sqlite.mjs"], { cwd: root, stdio: "inherit" });
if (sqlite.status !== 0) process.exit(sqlite.status ?? 1);
const pnpm = spawnSync("pnpm", ["exec", "electron-forge", "package", "--platform", "win32", "--arch", "x64"], {
  cwd: path.join(root, "apps/desktop"),
  stdio: "inherit",
  shell: true,
});
if (pnpm.status !== 0) process.exit(pnpm.status ?? 1);
const outDir = desktopPackageDir;
const built = fs.existsSync(outDir) ? fs.readdirSync(outDir).find((name) => name.startsWith("MANGA")) : undefined;
if (!built) throw new Error("electron-forge package output missing");
const appPath = path.join(outDir, built);
const evidence = runDir();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-package-"));
const phases = config.package.smoke;
// The window walk starts from an empty library (the app must open on the library paths), so it gets a Profile of its own; the creative walk and
// the plugin walk make their own projects, library path and plugin, and do not share a Profile with the phases before them.
const OWN_PROFILE = new Set(["window-walk", "creative", "plugins", "trace"]);
// The media and recording phases drive the real window with synthetic samples; they have to exist for the gate to mean anything.
const samplesRoot = path.join(root, "dist/samples/media");
const speechClip = path.join(samplesRoot, "voice/tts-clips/zh-CN-1.wav");
for (const phase of phases) {
  if ((phase === "media" || phase === "voice" || phase === "window-walk" || phase === "creative") && !fs.existsSync(path.join(samplesRoot, "manifest.json"))) throw new Error("synthetic samples are missing; run: node scripts/samples/generate-media-samples.mjs");
}
if (phases.includes("voice") && !fs.existsSync(speechClip)) throw new Error("the synthetic speech clip is missing; run: node scripts/samples/generate-media-samples.mjs");
const electronVersion = fs.readFileSync(path.join(appPath, "version"), "utf8").trim();
// The plugin walk downloads from a seed and a tracker on the loopback address, run here in a process of their own; the tracker's address in the
// magnet carries a made-up secret that must never reach the page or the logs. Nothing reaches a public tracker, the DHT or the LAN.
async function prepareBt(home) {
  const swarm = await startSwarm();
  const chapter = (title) => `${title}

${"这是用于 BitTorrent 下载测试的一段合成文字。".repeat(300)}
`;
  const secret = `S${crypto.randomBytes(9).toString("hex")}`;
  const seeded = await swarm.seed({ id: "window", root: path.join(home, "seed"), name: "季卷", files: [{ path: "第1话.txt", text: chapter("第一话") }, { path: "第2话.txt", text: chapter("第二话") }, { path: "第3话.txt", text: chapter("第三话") }], pieceLength: 16 * 1024 });
  const magnet = `magnet:?xt=urn:btih:${seeded.infoHash}&dn=${encodeURIComponent("季卷")}&tr=${encodeURIComponent(`${swarm.announce}?passkey=${secret}`)}`;
  const specFile = path.join(home, "bt-spec.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(specFile, JSON.stringify({ magnet, secret, libraryDir: path.join(home, "downloads"), subdir: "下载", files: seeded.files }));
  return { swarm, env: { MANGA_SMOKE_BT_SPEC: specFile, MANGA_SMOKE_BT_LOOPBACK: "1" } };
}
// The window walk's fake service answers from this process, so the application runs without blocking it.
function spawnAsync(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), options.timeout);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on("error", () => { clearTimeout(timer); resolve({ status: null, stdout, stderr }); });
  });
}
// What the stand-in service saw during the window walk: everything signed with the smoke credentials, nothing about the file sent after the answer "no",
// the search and the chosen episode's comments fetched, and no local path anywhere in what was asked.
function dandanTraffic(fake) {
  const problems = [];
  const all = fake.requests;
  if (all.length === 0) problems.push("the application never reached the service");
  if (all.some((request) => !request.signed)) problems.push("a request was not signed with the credentials of a smoke run");
  if (fake.hits("/api/v2/match").length > 0) problems.push("the file's details were sent although the answer was no");
  if (fake.hits("/api/v2/search/episodes").length === 0) problems.push("the search never reached the service");
  if (fake.hits(/^\/api\/v2\/comment\/900102$/).length === 0) problems.push("the comments of the chosen episode were not fetched");
  const text = (request) => { try { return decodeURIComponent(`${request.path}?${request.query.toString()}`) + request.body; } catch { return request.path + request.body; } };
  if (all.some((request) => /(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(text(request)))) problems.push("a request carried a local path");
  if (all.some((request) => request.body !== "")) problems.push("a request carried a body");
  return { status: problems.length === 0 ? "passed" : "failed", detail: { requests: all.length, paths: [...new Set(all.map((request) => request.path))], problems } };
}
async function smoke(phase) {
  const home = OWN_PROFILE.has(phase) ? fs.mkdtempSync(path.join(os.tmpdir(), `manga-package-${phase}-`)) : profile;
  const bt = phase === "plugins" ? await prepareBt(home) : null;
  // The window walk's danmaku step talks to a stand-in for the DanDanPlay service on the loopback address; it accepts only the credentials a smoke run uses.
  const dandan = phase === "window-walk" ? await new FakeDandan().start() : null;
  if (dandan) dandan.accepts = { appId: "smokeapp01", secret: "smoke-secret-for-the-local-fake-server" };
  let result;
  let traffic = null;
  try {
    result = await spawnAsync(path.join(appPath, "MANGA.exe"), ["--manga-smoke"], {
      cwd: home,
      env: {
        ...process.env,
        MANGA_CHANNEL: "test",
        MANGA_PROFILE_ROOT: path.join(home, "root"),
        MANGA_DOCUMENTS_DIR: path.join(home, "documents"),
        MANGA_POINTER_FILE: path.join(home, "launcher", "pointer.json"),
        MANGA_SMOKE_PHASE: phase,
        MANGA_SMOKE_EVIDENCE_DIR: evidence,
        MANGA_SMOKE_SAMPLES: samplesRoot,
        MANGA_SMOKE_AUDIO: speechClip,
        ELECTRON_ENABLE_LOGGING: "1",
        ...(bt?.env ?? {}),
        ...(dandan ? { MANGA_SMOKE_DANDAN_ORIGIN: dandan.origin } : {}),
      },
      timeout: phase.startsWith("agent") ? 90_000 : phase === "media" ? 600_000 : phase === "voice" ? 240_000 : phase === "window-walk" || phase === "creative" ? 300_000 : phase === "plugins" ? 420_000 : phase === "reading-loop" || phase === "reading-loop-restart" || phase === "formats" || phase === "trace" ? 120_000 : 60_000,
    });
  } finally {
    await bt?.swarm.close();
    if (dandan) traffic = dandanTraffic(dandan);
    await dandan?.stop();
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  const smokeLog = path.join(home, "root", "logs", `smoke-${phase}.json`);
  if (fs.existsSync(smokeLog)) process.stdout.write(`${fs.readFileSync(smokeLog, "utf8")}\n`);
  if (result.status !== 0) throw new Error(`smoke ${phase} failed status=${result.status}`);
  const report = fs.existsSync(smokeLog) ? JSON.parse(fs.readFileSync(smokeLog, "utf8")) : undefined;
  if (!report || report.status !== "passed") throw new Error(`smoke ${phase} did not report passed`);
  if (traffic) report.danmakuNetwork = traffic;
  if (phase === "restart" && report.markerRestored !== true) throw new Error("restart did not restore the marker note");
  if (phase === "agent") {
    if (report.revoked !== true) throw new Error("agent smoke did not revoke the module");
    if (report.runningShown !== true || report.stoppedShown !== true) throw new Error("agent smoke did not show the stop control while the run was going and send again after it");
  }
  if (phase === "agent-restart") {
    if (!String(report.inputText ?? "").includes("slow-smoke-prompt")) throw new Error("agent restart did not restore the prompt");
    if (report.conversationShown !== true) throw new Error("agent restart did not show the conversation that was left");
  }
  if (phase === "reading" && report.readingNav !== true) throw new Error("reading smoke did not open the reading page");
  if (phase === "reading-loop") {
    if (report.readLastChapter !== true) throw new Error("reading-loop smoke did not read the last chapter");
    if (report.recordedNote !== true) throw new Error("reading-loop smoke did not record a note from the selection");
    if (report.selectionAccurate !== true) throw new Error("reading-loop smoke recorded a range that is not the selection");
    if (report.materialsFrozen !== true || report.materialsFromUi !== true) throw new Error("reading-loop smoke did not freeze the task materials from the composer");
    if (report.uiTailVisible !== true || report.progressAtTail !== true || report.progressStillAtTail !== true) throw new Error("reading-loop smoke did not read the tail in the window and keep that position");
    if (report.sourceCardOk !== true) throw new Error("reading-loop smoke did not open a source card from the note");
    if (report.styleReachable !== true || report.theme !== "green") throw new Error("reading-loop smoke did not apply the reader style");
    if (report.bookmarkHighlighted !== true) throw new Error("reading-loop smoke did not highlight a bookmark range");
    if (report.bookmarkRemoved !== true) throw new Error("reading-loop smoke did not remove a bookmark");
  }
  if (phase === "media") {
    if (report.notRun) throw new Error("media smoke did not run");
    if (!Array.isArray(report.steps) || report.steps.length < 10) throw new Error("media smoke covered too few samples");
    if (report.ok !== true) throw new Error(`media smoke steps failed: ${(report.failed ?? []).join(", ")}`);
    // AT-84: the picture of a video whose fonts nobody has shows letters, and the debug panel says how the picture is made.
    // AT-89: the episode and audio menus, which the window walk's single file does not have, are hit-tested in the window and in screen full screen.
    const ran = new Set(report.steps.filter((step) => step.ok && !step.detail?.skipped).map((step) => step.id));
    // AT-109: a screenshot carries the subtitles on the picture (an ASS subtitle at the size of the file, and text subtitles) and not when the setting is off.
    for (const id of ["picture:missing-font-glyphs", "picture:debug-facts", "subtitles:menus-hit-testable", "menus:episodes-audio", "subtitles:shot-text", "subtitles:shot-setting-off", "picture:shot-ass-subtitles"]) if (!ran.has(id)) throw new Error(`media smoke did not run ${id}`);
  }
  if (phase === "voice") {
    if (report.notRun) throw new Error("voice smoke did not run");
    if (report.ok !== true) throw new Error(`voice smoke steps failed: ${(report.failed ?? []).join(", ")}`);
  }
  if (phase === "formats") {
    if (report.pages !== true || report.modes !== true || report.failureVisible !== true) throw new Error("formats smoke did not show four format pages, the mode switch and the failed import");
    // LOOP-06: the PDF page is painted once at its opening width and not again once the width has held still; the selection survives.
    const loop = report.loop06 ?? {};
    if (loop.settled?.stable !== true || loop.tagged !== true || loop.repainted !== false || loop.atEnd?.nodeConnected !== true) throw new Error(`formats smoke lost the PDF selection to a repaint: ${JSON.stringify(loop)}`);
  }
  if (phase === "window-walk") {
    if (report.notRun) throw new Error("window-walk smoke did not run");
    if (report.ok !== true) throw new Error(`window-walk smoke failed: ${(report.failed ?? []).concat(report.missing ?? []).join(", ")}`);
  }
  if (phase === "creative") {
    if (report.notRun) throw new Error("creative smoke did not run");
    if (report.ok !== true) throw new Error(`creative smoke failed: ${(report.failed ?? []).join(", ")}`);
  }
  if (phase === "trace") {
    if (report.notRun) throw new Error("trace smoke did not run");
    if (report.ok !== true) throw new Error(`trace smoke failed: ${(report.failed ?? []).join(", ")}`);
  }
  if (phase === "plugins") {
    if (report.notRun) throw new Error("plugins smoke did not run");
    if (report.ok !== true) throw new Error(`plugins smoke steps failed: ${(report.failed ?? []).join(", ")}`);
  }
  if (phase === "reading-loop-restart") {
    if (report.restoredNote !== true || report.restoredResource !== true) throw new Error("reading-loop restart did not restore the note and resource");
    if (report.restoredProgress !== true || report.uiRestoredTail !== true) throw new Error("reading-loop restart did not restore the reading position in the window");
    if (report.restoredSource !== true) throw new Error("reading-loop restart lost the note's source link");
    if (report.restoredMaterials !== true) throw new Error("reading-loop restart lost the frozen task materials");
  }
  return report;
}
const smokeReports = {};
for (const phase of phases) smokeReports[phase] = await smoke(phase);

// Each observation of the window walk (library paths, work home, right pane, settings, comic zoom at three window sizes, player and
// reader controls) is written on its own so the report can require every one of them by name.
// The creative walk (projects, whiteboard, mind map, draft, research, embeds, package, rough cut, vector extension, fit at three window sizes) adds its own.
const danmakuNetwork = smokeReports["window-walk"]?.danmakuNetwork;
const observations = [
  ...(smokeReports["window-walk"]?.observations ?? []),
  ...(danmakuNetwork ? [{ name: "danmaku-network", status: danmakuNetwork.status, detail: danmakuNetwork.detail }] : []),
  ...(smokeReports.creative?.observations ?? []),
  ...(smokeReports.trace?.observations ?? []),
];

// A package that is missing a bundled tool must stop at start, naming it, instead of failing in the middle of a recording.
function missingAssetCheck() {
  const target = path.join(appPath, "resources", "vad", "silero_vad.onnx");
  const hidden = `${target}.hidden`;
  const profileMissing = fs.mkdtempSync(path.join(os.tmpdir(), "manga-package-missing-"));
  fs.renameSync(target, hidden);
  try {
    const result = spawnSync(path.join(appPath, "MANGA.exe"), ["--manga-smoke"], {
      cwd: profileMissing,
      env: { ...process.env, MANGA_CHANNEL: "test", MANGA_PROFILE_ROOT: path.join(profileMissing, "root"), MANGA_DOCUMENTS_DIR: path.join(profileMissing, "documents"), MANGA_POINTER_FILE: path.join(profileMissing, "launcher", "pointer.json"), MANGA_SMOKE_PHASE: "initial" },
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    const log = path.join(profileMissing, "root", "logs", "smoke-initial.json");
    const report = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : {};
    const named = Array.isArray(report.missingAssets) && report.missingAssets.some((item) => String(item).includes("silero_vad.onnx"));
    if (result.status === 0 || !named) throw new Error(`a package without its voice model did not stop at start (status ${result.status})`);
    return { stoppedAtStart: true, status: result.status, message: String(report.error ?? "") };
  } finally {
    fs.renameSync(hidden, target);
    fs.rmSync(profileMissing, { recursive: true, force: true });
  }
}
const missingAsset = missingAssetCheck();
fs.writeFileSync(path.join(evidence, "scenarios.json"), `${JSON.stringify({
  status: observations.length > 0 && observations.every((row) => row.status === "passed") ? "passed" : "failed",
  stage,
  ...stageFingerprints(root, config),
  productAcceptance: "not-run",
  at: new Date().toISOString(),
  source: "packaged window walk and creative walk, phases window-walk and creative (synthetic samples, fresh Profile each)",
  windowSizes: smokeReports["window-walk"]?.windowSizes ?? null,
  observations: observations.map((row) => ({ name: row.name, status: row.status, detail: row.detail ?? null })),
}, null, 2)}\n`);
const readingLoopTimings = smokeReports["reading-loop"]?.timings ?? {};
fs.writeFileSync(path.join(evidence, "package.json"), `${JSON.stringify({
  status: "passed",
  stage,
  ...stageFingerprints(root, config),
  productAcceptance: "not-run",
  at: new Date().toISOString(),
  format: "unsigned local Electron package",
  electron: electronVersion,
  output: path.relative(root, appPath).replaceAll("\\", "/"),
  smoke: phases,
  formats: {
    pages: smokeReports.formats?.pages ?? false,
    modes: smokeReports.formats?.modes ?? false,
    failureVisible: smokeReports.formats?.failureVisible ?? false,
    opened: smokeReports.formats?.opened ?? null,
  },
  viewports: smokeReports.reading?.viewports ?? null,
  // LOOP-06: the PDF page's paints around the selection, from the real window.
  loop06: smokeReports.formats?.loop06 ?? null,
  agent: { runningShown: smokeReports.agent?.runningShown ?? false, stoppedShown: smokeReports.agent?.stoppedShown ?? false, conversationShown: smokeReports["agent-restart"]?.conversationShown ?? false },
  windowWalk: { ok: smokeReports["window-walk"]?.ok ?? false, observations: observations.length },
  creative: { ok: smokeReports.creative?.ok ?? false, observations: (smokeReports.creative?.observations ?? []).length },
  // AT-97 in the window: a task against a stand-in model, its record opened from the reply, and no secret anywhere it could be read.
  trace: { ok: smokeReports.trace?.ok ?? false, observations: (smokeReports.trace?.observations ?? []).length },
  // The bundled BitTorrent plugin in the packaged window: offered, installed with confirmed permissions, run in a process of its own, a loopback download imported, stopped and started again.
  plugins: { ok: smokeReports.plugins?.ok ?? false, steps: smokeReports.plugins?.steps ?? [] },
  missingAsset,
  media: smokeReports.media ? { steps: smokeReports.media.steps, matrix: smokeReports.media.matrix, timings: smokeReports.media.timings } : null,
  voice: smokeReports.voice ? { steps: smokeReports.voice.steps } : null,
  // Operation-level timing from the real reading-loop run, not from click dispatch.
  readingLoop: {
    readLastChapter: smokeReports["reading-loop"]?.readLastChapter ?? false,
    recordedNote: smokeReports["reading-loop"]?.recordedNote ?? false,
    selectionAccurate: smokeReports["reading-loop"]?.selectionAccurate ?? false,
    materialsFrozen: smokeReports["reading-loop"]?.materialsFrozen ?? false,
    materialsFromUi: smokeReports["reading-loop"]?.materialsFromUi ?? false,
    uiTailVisible: smokeReports["reading-loop"]?.uiTailVisible ?? false,
    progressAtTail: smokeReports["reading-loop"]?.progressAtTail ?? false,
    uiRestoredTail: smokeReports["reading-loop-restart"]?.uiRestoredTail ?? false,
    bookmarkHighlighted: smokeReports["reading-loop"]?.bookmarkHighlighted ?? false,
    sourceCardOk: smokeReports["reading-loop"]?.sourceCardOk ?? false,
    restoredProgress: smokeReports["reading-loop-restart"]?.restoredProgress ?? false,
    restoredSource: smokeReports["reading-loop-restart"]?.restoredSource ?? false,
    restoredMaterials: smokeReports["reading-loop-restart"]?.restoredMaterials ?? false,
    diagnostics: smokeReports["reading-loop"]?.diagnostics ?? null,
    timings: readingLoopTimings,
  },
}, null, 2)}\n`);
console.log(JSON.stringify({ status: "passed", check: "stage-package", output: appPath }));
fs.writeFileSync(latestDesktopPackage, `${JSON.stringify({ target: path.relative(root, appPath).replaceAll("\\", "/"), evidence: path.relative(root, evidence).replaceAll("\\", "/"), stage, ...stageFingerprints(root, config) }, null, 2)}\n`);
