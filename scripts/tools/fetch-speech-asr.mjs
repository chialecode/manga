// Fetch, verify and unpack the pinned gate/smoke ASR model (sense-voice-funasr-nano-int8) into dist/tools/asr/<modelId>/.
// ASR models are NEVER bundled into the installer or packaged resources; this cache feeds local/CI smoke checks only.
// node scripts/tools/fetch-speech-asr.mjs [--print-dir]
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "scripts/tools/speech-asr.lock.json"), "utf8"));
const toolsRoot = path.join(root, "dist/tools");
const installDir = path.join(toolsRoot, "asr", lock.modelId);

function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let read = fs.readSync(fd, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(fd, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function speechAsrInstallDir() {
  return installDir;
}

function verifyInstalled() {
  for (const [relative, expected] of Object.entries(lock.files)) {
    const file = path.join(installDir, relative);
    if (!fs.existsSync(file)) return false;
    if (fs.statSync(file).size !== expected.bytes) return false;
    if (sha256File(file) !== expected.sha256) return false;
  }
  return true;
}

function downloadArchive() {
  fs.mkdirSync(toolsRoot, { recursive: true });
  const archive = path.join(toolsRoot, lock.source.asset);
  if (!fs.existsSync(archive) || fs.statSync(archive).size !== lock.source.bytes || sha256File(archive) !== lock.source.sha256) {
    const result = spawnSync("curl", ["-L", "--fail", "--silent", "--show-error", "-o", archive, lock.source.url], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`download failed: ${lock.source.url}`);
  }
  const size = fs.statSync(archive).size;
  const actual = sha256File(archive);
  if (size !== lock.source.bytes || actual !== lock.source.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(`archive verification failed for ${lock.source.asset}: expected ${lock.source.bytes}B / ${lock.source.sha256}, got ${size}B / ${actual}`);
  }
  return archive;
}

function validateTarEntries(tarBin, archive, stagingDir) {
  const tvf = spawnSync(tarBin, ["-tvf", archive], { maxBuffer: 16 * 1024 * 1024 });
  if (tvf.status !== 0) throw new Error(`tar -tvf failed (${tvf.status}): ${(tvf.stderr ?? Buffer.alloc(0)).toString("utf8")}`);
  const tvfLines = tvf.stdout.toString("latin1").split(/\r?\n/).filter((line) => line.length > 0);

  const tf = spawnSync(tarBin, ["-tf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (tf.status !== 0) throw new Error(`tar -tf failed (${tf.status}): ${tf.stderr ?? ""}`);
  const tfLines = tf.stdout.split(/\r?\n/).filter((line) => line.length > 0);

  if (tvfLines.length === 0 || tvfLines.length !== tfLines.length) {
    throw new Error(`tar entry listing mismatch (${tvfLines.length} vs ${tfLines.length})`);
  }
  for (const line of tvfLines) {
    if (!/^[-d][rwxstST-]{9}\s/.test(line) || line.includes(" -> ") || line.includes(" link to ")) {
      throw new Error(`tar archive contains disallowed link or special entry: ${line.slice(0, 120)}`);
    }
  }
  const resolvedRoot = path.resolve(stagingDir);
  for (const raw of tfLines) {
    if (/^[/\\]/.test(raw) || raw.includes(":") || /[\x00-\x1f]/.test(raw)) {
      throw new Error(`tar archive contains unsafe path: ${raw}`);
    }
    const normalized = raw.replaceAll("\\", "/");
    const segments = normalized.split("/").filter((part) => part.length > 0);
    if (segments.length === 0 || segments.some((part) => part === "." || part === "..")) {
      throw new Error(`tar archive contains traversal segment: ${raw}`);
    }
    const target = path.resolve(resolvedRoot, ...segments);
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`tar archive entry escapes staging directory: ${raw}`);
    }
  }
}

function unpackArchive(archive) {
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "", "System32/tar.exe") : "tar";
  if (process.platform === "win32" && !fs.existsSync(tar)) throw new Error(`missing system tar executable: ${tar}`);
  const staging = path.join(toolsRoot, `asr-staging-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    validateTarEntries(tar, archive, staging);
    const extract = spawnSync(tar, ["-xjf", archive, "-C", staging], { stdio: "inherit" });
    if (extract.status !== 0) throw new Error("ASR archive extraction failed");
    const extractedRoot = path.join(staging, lock.topLevelDirectory);
    for (const [relative, expected] of Object.entries(lock.files)) {
      const file = path.join(extractedRoot, relative);
      if (!fs.existsSync(file)) throw new Error(`missing required ASR file after extraction: ${relative}`);
      const size = fs.statSync(file).size;
      const actual = sha256File(file);
      if (size !== expected.bytes || actual !== expected.sha256) {
        throw new Error(`extracted ASR file mismatch for ${relative}: expected ${expected.bytes}B / ${expected.sha256}, got ${size}B / ${actual}`);
      }
    }
    const finalTemp = path.join(toolsRoot, "asr", `.${lock.modelId}-${process.pid}`);
    fs.mkdirSync(finalTemp, { recursive: true });
    for (const relative of Object.keys(lock.files)) {
      const dst = path.join(finalTemp, relative);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(extractedRoot, relative), dst);
    }
    if (fs.existsSync(path.join(extractedRoot, "README.md"))) {
      fs.copyFileSync(path.join(extractedRoot, "README.md"), path.join(finalTemp, "README.md"));
    }
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(installDir), { recursive: true });
    fs.renameSync(finalTemp, installDir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  if (!verifyInstalled()) {
    unpackArchive(downloadArchive());
    if (!verifyInstalled()) throw new Error("installed ASR smoke model does not match scripts/tools/speech-asr.lock.json");
  }
  if (process.argv.includes("--print-dir")) console.log(installDir);
  else console.log(`ASR smoke model ${lock.modelId} (${lock.version}) verified at ${path.relative(root, installDir).replaceAll("\\", "/")}`);
}
