// Fetch and verify the pinned subtitle font (Noto Sans CJK, Simplified Chinese subset) into dist/tools/subtitle-font/.
// The font is SIL OFL-1.1-licensed and shipped inside the package; it is not stored in the repository.
// node scripts/tools/fetch-subtitle-font.mjs [--print-dir]
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "scripts/tools/subtitle-font.lock.json"), "utf8"));
const dir = path.join(root, "dist/tools/subtitle-font");
fs.mkdirSync(dir, { recursive: true });
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

for (const [name, item] of Object.entries(lock.files)) {
  const file = path.join(dir, name);
  if (fs.existsSync(file) && sha256(file) === item.sha256) continue;
  const result = spawnSync("curl", ["-L", "--fail", "--silent", "--show-error", "-o", file, item.url], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`download failed: ${item.url}`);
  if (sha256(file) !== item.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`SHA-256 mismatch for ${name}`);
  }
}
if (process.argv.includes("--print-dir")) console.log(dir);
else console.log(`Subtitle font ${lock.name} verified at ${path.relative(root, dir).replaceAll("\\", "/")}`);
