import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { desktopPackageDir, latestDesktopPackage } from "../desktop-paths.ts";
import { loadStage, repoRoot as root, runDir, stageFingerprints } from "./lib.mjs";

const stage = process.argv[2] ?? "m2";
const config = loadStage(stage);
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
const evidence = runDir(stage);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-package-"));
const phases = config.package.smoke;
// The rework walk starts from an empty library (the app must open on the library paths), so it gets a Profile of its own.
const OWN_PROFILE = new Set(["rework"]);
// The media and recording phases drive the real window with synthetic samples; they have to exist for the gate to mean anything.
const samplesRoot = path.join(root, "dist/samples/m2");
const speechClip = path.join(samplesRoot, "voice/tts-clips/zh-CN-1.wav");
for (const phase of phases) {
  if ((phase === "media" || phase === "voice" || phase === "rework") && !fs.existsSync(path.join(samplesRoot, "manifest.json"))) throw new Error("synthetic samples are missing; run: node scripts/samples/generate-media-samples.mjs");
}
if (phases.includes("voice") && !fs.existsSync(speechClip)) throw new Error("the synthetic speech clip is missing; run: node scripts/samples/generate-media-samples.mjs");
const electronVersion = fs.readFileSync(path.join(appPath, "version"), "utf8").trim();
function smoke(phase) {
  const home = OWN_PROFILE.has(phase) ? fs.mkdtempSync(path.join(os.tmpdir(), `manga-package-${phase}-`)) : profile;
  const result = spawnSync(path.join(appPath, "MANGA.exe"), ["--manga-smoke"], {
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
    },
    encoding: "utf8",
    timeout: phase.startsWith("agent") ? 90_000 : phase === "media" ? 600_000 : phase === "voice" ? 240_000 : phase === "rework" ? 300_000 : phase === "closure" || phase === "closure-restart" || phase === "formats" ? 120_000 : 60_000,
    windowsHide: true,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  const smokeLog = path.join(home, "root", "logs", `smoke-${phase}.json`);
  if (fs.existsSync(smokeLog)) process.stdout.write(`${fs.readFileSync(smokeLog, "utf8")}\n`);
  if (result.status !== 0) throw new Error(`smoke ${phase} failed status=${result.status}`);
  const report = fs.existsSync(smokeLog) ? JSON.parse(fs.readFileSync(smokeLog, "utf8")) : undefined;
  if (!report || report.status !== "passed") throw new Error(`smoke ${phase} did not report passed`);
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
  if (phase === "closure") {
    if (report.readLastChapter !== true) throw new Error("closure smoke did not read the last chapter");
    if (report.recordedNote !== true) throw new Error("closure smoke did not record a note from the selection");
    if (report.selectionAccurate !== true) throw new Error("closure smoke recorded a range that is not the selection");
    if (report.materialsFrozen !== true || report.materialsFromUi !== true) throw new Error("closure smoke did not freeze the task materials from the composer");
    if (report.uiTailVisible !== true || report.progressAtTail !== true || report.progressStillAtTail !== true) throw new Error("closure smoke did not read the tail in the window and keep that position");
    if (report.sourceCardOk !== true) throw new Error("closure smoke did not open a source card from the note");
    if (report.styleReachable !== true || report.theme !== "green") throw new Error("closure smoke did not apply the reader style");
    if (report.bookmarkHighlighted !== true) throw new Error("closure smoke did not highlight a bookmark range");
    if (report.bookmarkRemoved !== true) throw new Error("closure smoke did not remove a bookmark");
  }
  if (phase === "media") {
    if (report.notRun) throw new Error("media smoke did not run");
    if (!Array.isArray(report.steps) || report.steps.length < 10) throw new Error("media smoke covered too few samples");
    if (report.ok !== true) throw new Error(`media smoke steps failed: ${(report.failed ?? []).join(", ")}`);
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
  if (phase === "rework") {
    if (report.notRun) throw new Error("rework smoke did not run");
    if (report.ok !== true) throw new Error(`rework smoke failed: ${(report.failed ?? []).concat(report.missing ?? []).join(", ")}`);
  }
  if (phase === "closure-restart") {
    if (report.restoredNote !== true || report.restoredResource !== true) throw new Error("closure restart did not restore the note and resource");
    if (report.restoredProgress !== true || report.uiRestoredTail !== true) throw new Error("closure restart did not restore the reading position in the window");
    if (report.restoredSource !== true) throw new Error("closure restart lost the note's source link");
    if (report.restoredMaterials !== true) throw new Error("closure restart lost the frozen task materials");
  }
  return report;
}
const smokeReports = {};
for (const phase of phases) smokeReports[phase] = smoke(phase);

// Each observation of the rework walk (library paths, work home, right pane, settings, comic zoom at three window sizes, player and
// reader controls) is written on its own so the report can require every one of them by name.
const observations = smokeReports.rework?.observations ?? [];

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
  source: "packaged window walk, phase rework (synthetic samples, fresh Profile)",
  windowSizes: smokeReports.rework?.windowSizes ?? null,
  observations: observations.map((row) => ({ name: row.name, status: row.status, detail: row.detail ?? null })),
}, null, 2)}\n`);
const closureTimings = smokeReports.closure?.timings ?? {};
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
  rework: { ok: smokeReports.rework?.ok ?? false, observations: observations.length },
  missingAsset,
  media: smokeReports.media ? { steps: smokeReports.media.steps, matrix: smokeReports.media.matrix, timings: smokeReports.media.timings } : null,
  voice: smokeReports.voice ? { steps: smokeReports.voice.steps } : null,
  // Operation-level timing from the real closure run, not from click dispatch.
  closure: {
    readLastChapter: smokeReports.closure?.readLastChapter ?? false,
    recordedNote: smokeReports.closure?.recordedNote ?? false,
    selectionAccurate: smokeReports.closure?.selectionAccurate ?? false,
    materialsFrozen: smokeReports.closure?.materialsFrozen ?? false,
    materialsFromUi: smokeReports.closure?.materialsFromUi ?? false,
    uiTailVisible: smokeReports.closure?.uiTailVisible ?? false,
    progressAtTail: smokeReports.closure?.progressAtTail ?? false,
    uiRestoredTail: smokeReports["closure-restart"]?.uiRestoredTail ?? false,
    bookmarkHighlighted: smokeReports.closure?.bookmarkHighlighted ?? false,
    sourceCardOk: smokeReports.closure?.sourceCardOk ?? false,
    restoredProgress: smokeReports["closure-restart"]?.restoredProgress ?? false,
    restoredSource: smokeReports["closure-restart"]?.restoredSource ?? false,
    restoredMaterials: smokeReports["closure-restart"]?.restoredMaterials ?? false,
    diagnostics: smokeReports.closure?.diagnostics ?? null,
    timings: closureTimings,
  },
}, null, 2)}\n`);
console.log(JSON.stringify({ status: "passed", check: `${stage}-package`, output: appPath }));
fs.writeFileSync(latestDesktopPackage, `${JSON.stringify({ target: path.relative(root, appPath).replaceAll("\\", "/"), evidence: path.relative(root, evidence).replaceAll("\\", "/"), stage, ...stageFingerprints(root, config) }, null, 2)}\n`);
