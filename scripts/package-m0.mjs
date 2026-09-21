import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sourceFingerprint } from "../experiments/m0/src/report.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") throw new Error("This local prototype package targets Windows x64");
const desktop = path.join(root, "experiments/m0-desktop");
const build = spawnSync(process.execPath, [path.join(desktop, "build.mjs")], {cwd:root, stdio:"inherit"});
if (build.status !== 0) process.exit(1);
const electronDir = fs.realpathSync(path.join(desktop, "node_modules/electron/dist"));
const target = path.join(root, "dist", `manga-m0-win32-x64-${Date.now()}`);
fs.mkdirSync(target, {recursive:true});
fs.cpSync(electronDir, target, {recursive:true, errorOnExist:true});
const appDir = path.join(target, "resources/app");
fs.cpSync(path.join(desktop,"dist"), appDir, {recursive:true});
fs.writeFileSync(path.join(appDir,"package.json"), JSON.stringify({name:"manga-m0",version:"0.0.0",main:"main.cjs"}));
fs.copyFileSync(process.execPath, path.join(target,"resources/node.exe"));
const nodeLicense = path.join(path.dirname(process.execPath), "LICENSE");
if(fs.existsSync(nodeLicense)) fs.copyFileSync(nodeLicense, path.join(target,"resources/NODE-LICENSE"));
fs.renameSync(path.join(target,"electron.exe"), path.join(target,"MANGA-M0.exe"));
const fixtures = spawnSync(process.execPath, ["--experimental-strip-types", "experiments/m0/src/fixtures/generate.ts"], { cwd: root, encoding: "utf8" });
process.stdout.write(fixtures.stdout || "");
process.stderr.write(fixtures.stderr || "");
if (fixtures.status !== 0) process.exit(1);
const generated = JSON.parse((fixtures.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1));
const videoSample = path.join(generated.root, "media", "h264-aac.mp4");
const imageSample = path.join(generated.root, "comic", "p1.png");
const hevcSample = path.join(os.tmpdir(), `manga-m0-hevc-${process.pid}.mp4`);
const hevc = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=24:duration=1", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error:pools=1", "-pix_fmt", "yuv420p", "-an", hevcSample], { encoding: "utf8" });
const profile = fs.mkdtempSync(path.join(os.tmpdir(),"manga-m0-package-"));
const exportPath = path.join(profile, "exported-capture.webm");
const smokeResults = [];
function runSmoke(phase, profileDir, extraEnv = {}, args = []) {
  const env = {
    ...process.env,
    MANGA_M0_DIR: profileDir,
    M0_SMOKE_PHASE: phase,
    PATH: process.env.SystemRoot + "\\System32",
    M0_EXPORT_PATH: extraEnv.M0_EXPORT_PATH ?? exportPath,
    M0_EXPORT_OVERWRITE: extraEnv.M0_EXPORT_OVERWRITE ?? "1",
    M0_MEDIA_VIDEO: fs.existsSync(videoSample) ? videoSample : "",
    M0_MEDIA_IMAGE: fs.existsSync(imageSample) ? imageSample : "",
    M0_MEDIA_HEVC: hevc.status === 0 ? hevcSample : "",
    ...extraEnv,
  };
  delete env.MANGA_NODE_BIN;
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(path.join(target,"MANGA-M0.exe"), ["--m0-smoke", ...args], {cwd:profileDir, env, encoding:"utf8", timeout:120000, windowsHide:true});
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if(result.status !== 0) { console.error(result.error || `smoke exit ${result.status} phase=${phase}`); process.exit(1); }
  const report = JSON.parse(fs.readFileSync(path.join(profileDir,`smoke-${phase}.json`),"utf8"));
  smokeResults.push(report);
  return report;
}
runSmoke("initial", profile, { M0_EXPORT_OVERWRITE: "1" });
runSmoke("restart", profile, { M0_EXPORT_CANCEL: "1" }, ["--force-device-scale-factor=1.25"]);
const permissionProfile = fs.mkdtempSync(path.join(os.tmpdir(),"manga-m0-permission-"));
runSmoke("permission", permissionProfile, { M0_FORCE_PERMISSION_DENY: "1", M0_EXPORT_PATH: path.join(permissionProfile, "no.webm") });
const mediaElectron = fs.existsSync(path.join(profile, "media-electron.json")) ? JSON.parse(fs.readFileSync(path.join(profile, "media-electron.json"), "utf8")) : null;
const evidence = path.resolve(root, process.env.M0_EVIDENCE_DIR ?? "docs/evidence/m0-closure");
fs.mkdirSync(evidence,{recursive:true});
const packageReport = {
  status:"passed",
  sourceFingerprint:sourceFingerprint(root),
  at:new Date().toISOString(),
  format:"unsigned unpacked local prototype",
  bundledNode:process.version,
  electron:"37.4.0",
  standalonePath:true,
  smokeResults,
  mediaElectron,
  hevcGenerated: hevc.status === 0,
  exportBytes: fs.existsSync(exportPath) ? fs.statSync(exportPath).size : 0,
};
fs.writeFileSync(path.join(evidence,"package.json"),JSON.stringify(packageReport,null,2)+"\n");
if (mediaElectron) fs.writeFileSync(path.join(evidence,"media-electron.json"),JSON.stringify({...mediaElectron,sourceFingerprint:sourceFingerprint(root)},null,2)+"\n");
fs.writeFileSync(path.join(root,"dist/latest-package.json"),JSON.stringify({target,profile},null,2));
console.log(`Local prototype: ${target}\nSmoke profile: ${profile}`);
