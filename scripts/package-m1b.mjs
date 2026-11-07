import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";
import { desktopPackageDir, latestDesktopPackage } from "./desktop-paths.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") throw new Error("M1b package verification targets Windows x64");
const sqlite = spawnSync(process.execPath, ["scripts/ensure-electron-sqlite.mjs"], { cwd: root, stdio: "inherit" });
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
const evidence = path.resolve(root, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/b-final");
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1b-package-"));
const phases = ["initial", "restart", "agent", "agent-restart", "reading", "closure", "closure-restart", "formats"];
function smoke(phase) {
  const result = spawnSync(path.join(appPath, "MANGA.exe"), ["--m1a-smoke"], {
    cwd: profile,
    env: {
      ...process.env,
      MANGA_CHANNEL: "test",
      MANGA_PROFILE_ROOT: path.join(profile, "root"),
      MANGA_DOCUMENTS_DIR: path.join(profile, "documents"),
      MANGA_POINTER_FILE: path.join(profile, "launcher", "pointer.json"),
      M1A_SMOKE_PHASE: phase,
      M1A_EVIDENCE_DIR: evidence,
      ELECTRON_ENABLE_LOGGING: "1",
    },
    encoding: "utf8",
    timeout: phase.startsWith("agent") ? 90_000 : phase === "closure" || phase === "closure-restart" || phase === "formats" ? 120_000 : 60_000,
    windowsHide: true,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  const smokeLog = path.join(profile, "root", "logs", `smoke-${phase}.json`);
  if (fs.existsSync(smokeLog)) process.stdout.write(`${fs.readFileSync(smokeLog, "utf8")}\n`);
  if (result.status !== 0) throw new Error(`m1b smoke ${phase} failed status=${result.status}`);
  const report = fs.existsSync(smokeLog) ? JSON.parse(fs.readFileSync(smokeLog, "utf8")) : undefined;
  if (!report || report.status !== "passed") throw new Error(`m1b smoke ${phase} did not report passed`);
  if (phase === "restart" && report.markerRestored !== true) throw new Error("restart did not restore the marker note");
  if (phase === "agent" && report.revoked !== true) throw new Error("agent smoke did not revoke the module");
  if (phase === "agent-restart" && !String(report.inputText ?? "").includes("slow-smoke-prompt")) throw new Error("agent restart did not restore the prompt");
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
  if (phase === "formats") {
    if (report.pages !== true || report.modes !== true || report.failureVisible !== true) throw new Error("formats smoke did not show four format pages, the mode switch and the failed import");
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
const closureTimings = smokeReports.closure?.timings ?? {};
fs.writeFileSync(path.join(evidence, "package.json"), `${JSON.stringify({
  status: "passed",
  ...m1bFingerprints(root),
  productAcceptance: "not-run",
  at: new Date().toISOString(),
  format: "unsigned local Electron package",
  electron: "37.4.0",
  output: path.relative(root, appPath).replaceAll("\\", "/"),
  smoke: phases,
  formats: {
    pages: smokeReports.formats?.pages ?? false,
    modes: smokeReports.formats?.modes ?? false,
    failureVisible: smokeReports.formats?.failureVisible ?? false,
    opened: smokeReports.formats?.opened ?? null,
  },
  viewports: smokeReports.reading?.viewports ?? null,
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
console.log(JSON.stringify({ status: "passed", check: "m1b-package", output: appPath }));
fs.writeFileSync(latestDesktopPackage, `${JSON.stringify({ target: path.relative(root, appPath).replaceAll("\\", "/"), evidence: path.relative(root, evidence).replaceAll("\\", "/"), stage: "m1b", ...m1bFingerprints(root) }, null, 2)}\n`);
