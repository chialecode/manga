import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sourceFingerprint } from "../experiments/m0/src/report.ts";
import { m1aSourceFingerprint } from "./m1a-fingerprint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") throw new Error("M1a package verification targets Windows x64");
const desktop = path.join(root, "apps/desktop");
const sqlite = spawnSync(process.execPath, ["scripts/ensure-electron-sqlite.mjs"], { cwd: root, stdio: "inherit" });
if (sqlite.status !== 0) process.exit(sqlite.status ?? 1);
const pnpm = spawnSync("pnpm", ["exec", "electron-forge", "package", "--platform", "win32", "--arch", "x64"], {
  cwd: desktop,
  stdio: "inherit",
  shell: true,
});
if (pnpm.status !== 0) process.exit(pnpm.status ?? 1);
const outDir = path.join(root, "dist/m1a-package");
const built = fs.existsSync(outDir) ? fs.readdirSync(outDir).find((name) => name.startsWith("MANGA")) : undefined;
if (!built) throw new Error("electron-forge package output missing");
const appPath = path.join(outDir, built);
const evidence = path.resolve(root, process.env.M1A_EVIDENCE_DIR ?? "docs/evidence/m1a-review");
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1a-package-"));
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
    timeout: phase.startsWith("agent") ? 90_000 : 60_000,
    windowsHide: true,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error) process.stderr.write(`${result.error.stack || result.error.message}\n`);
  const smokeLog = path.join(profile, "root", "logs", `smoke-${phase}.json`);
  if (fs.existsSync(smokeLog)) process.stdout.write(`${fs.readFileSync(smokeLog, "utf8")}\n`);
  if (result.status !== 0) throw new Error(`m1a smoke ${phase} failed status=${result.status} signal=${result.signal}`);
  const report = fs.existsSync(smokeLog) ? JSON.parse(fs.readFileSync(smokeLog, "utf8")) : undefined;
  if (!report || report.status !== "passed") throw new Error(`m1a smoke ${phase} did not report passed`);
  if (phase === "restart" && report.markerRestored !== true) throw new Error("m1a smoke restart did not find the note written in the initial phase");
  if (phase === "agent" && report.revoked !== true) throw new Error("m1a smoke agent did not revoke the module entry");
  if (phase === "agent-restart" && !String(report.inputText ?? "").includes("slow-smoke-prompt")) {
    throw new Error("m1a smoke agent-restart did not restore the sent prompt");
  }
  return report;
}
smoke("initial");
smoke("restart");
smoke("agent");
smoke("agent-restart");
const native = fs.existsSync(path.join(appPath, "resources/app.asar.unpacked")) || fs.existsSync(path.join(appPath, "resources/app/node_modules/better-sqlite3"));
fs.writeFileSync(path.join(evidence, "package.json"), `${JSON.stringify({
  status: "passed",
  sourceFingerprint: sourceFingerprint(root),
  m1aSourceFingerprint: m1aSourceFingerprint(root),
  at: new Date().toISOString(),
  format: "unsigned local Electron package",
  electron: "37.4.0",
  nativeModuleUnpacked: native,
  output: path.relative(root, appPath).replaceAll("\\", "/"),
  smoke: ["initial", "restart", "agent", "agent-restart"],
}, null, 2)}\n`);
fs.writeFileSync(path.join(root, "dist/latest-m1a-package.json"), `${JSON.stringify({ target: appPath, profile }, null, 2)}\n`);
console.log(JSON.stringify({ status: "passed", check: "m1a-package", output: appPath }));
