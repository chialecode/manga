// Fetch, verify and unpack the pinned FFmpeg LGPL shared build into dist/tools/ffmpeg/<version>/.
// FFmpeg is a separate program that MANGA starts as a subprocess; it is not linked into the app and is
// not stored in the repository. node scripts/tools/fetch-ffmpeg.mjs [--print-dir]
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lockFile = path.join(root, "scripts/tools/ffmpeg.lock.json");
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
const toolsRoot = path.join(root, "dist/tools");
const installDir = path.join(toolsRoot, "ffmpeg", lock.version);

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function ffmpegInstallDir() {
  return installDir;
}

function verifyInstalled() {
  for (const [relative, expected] of Object.entries(lock.files)) {
    const file = path.join(installDir, relative);
    if (!fs.existsSync(file) || sha256(file) !== expected) return false;
  }
  return true;
}

function download() {
  fs.mkdirSync(toolsRoot, { recursive: true });
  const zip = path.join(toolsRoot, lock.source.asset);
  if (!fs.existsSync(zip) || sha256(zip) !== lock.source.zipSha256) {
    const result = spawnSync("curl", ["-L", "--fail", "--silent", "--show-error", "-o", zip, lock.source.url], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`download failed: ${lock.source.url}`);
  }
  const actual = sha256(zip);
  if (actual !== lock.source.zipSha256) throw new Error(`SHA-256 mismatch for ${lock.source.asset}: expected ${lock.source.zipSha256}, got ${actual}`);
  return zip;
}

function unpack(zip) {
  const staging = path.join(toolsRoot, `ffmpeg-staging-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  // Windows ships bsdtar, which reads zip archives; GNU tar does not.
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "System32/tar.exe") : "tar";
  const result = spawnSync(tar, ["-xf", zip, "-C", staging], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("archive extraction failed");
  const [inner] = fs.readdirSync(staging);
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  fs.renameSync(path.join(staging, inner), installDir);
  fs.rmSync(staging, { recursive: true, force: true });
}

if (process.argv.includes("--record")) {
  // Maintainer step after changing the pinned archive: unpack it and record the hash of every shipped file.
  unpack(download());
  const files = {};
  for (const relative of ["LICENSE.txt", ...fs.readdirSync(path.join(installDir, "bin")).map((name) => `bin/${name}`)]) files[relative] = sha256(path.join(installDir, relative));
  fs.writeFileSync(lockFile, `${JSON.stringify({ ...lock, files }, null, 2)}
`);
  console.log(`recorded ${Object.keys(files).length} file hashes`);
  process.exit(0);
}
if (!verifyInstalled()) {
  unpack(download());
  if (!verifyInstalled()) throw new Error("installed FFmpeg files do not match scripts/tools/ffmpeg.lock.json");
}
if (process.argv.includes("--print-dir")) console.log(installDir);
else console.log(`FFmpeg ${lock.version} verified at ${path.relative(root, installDir).replaceAll("\\", "/")}`);
