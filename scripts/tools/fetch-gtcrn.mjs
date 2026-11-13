// Fetch and verify the pinned GTCRN 16 kHz speech enhancement ONNX model and its MIT licence into dist/tools/gtcrn/.
// The model is MIT-licensed (~523 KB) and shipped inside the application package; it is not stored in Git.
// node scripts/tools/fetch-gtcrn.mjs [--print-dir]
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "scripts/tools/gtcrn.lock.json"), "utf8"));
const dir = path.join(root, "dist/tools/gtcrn");
fs.mkdirSync(dir, { recursive: true });
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

for (const [name, item] of Object.entries(lock.files)) {
  const file = path.join(dir, name);
  if (fs.existsSync(file) && fs.statSync(file).size === item.bytes && sha256(file) === item.sha256) continue;
  const result = spawnSync("curl", ["-L", "--fail", "--silent", "--show-error", "-o", file, item.url], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`download failed: ${item.url}`);
  const size = fs.statSync(file).size;
  const actual = sha256(file);
  if (size !== item.bytes || actual !== item.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`verification mismatch for ${name}: expected ${item.bytes}B / ${item.sha256}, got ${size}B / ${actual}`);
  }
}
if (process.argv.includes("--print-dir")) console.log(dir);
else console.log(`${lock.name} ${lock.version} verified at ${path.relative(root, dir).replaceAll("\\", "/")}`);
