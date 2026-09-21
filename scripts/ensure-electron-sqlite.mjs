import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destDir = path.join(root, "dist/m1a-native");
const dest = path.join(destDir, "better_sqlite3.node");
if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
  console.log(JSON.stringify({ status: "cached", dest: path.relative(root, dest).replaceAll("\\", "/") }));
  process.exit(0);
}

const sqlite = path.join(root, "node_modules/better-sqlite3");
const installer = path.join(root, "node_modules/prebuild-install/bin.js");
if (!fs.existsSync(sqlite) || !fs.existsSync(installer)) {
  console.error("better-sqlite3 or prebuild-install is missing; run pnpm install");
  process.exit(1);
}

const result = spawnSync(process.execPath, [installer, "--runtime", "electron", "--target", "37.4.0", "--arch", "x64"], {
  cwd: sqlite,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);
const built = path.join(sqlite, "build/Release/better_sqlite3.node");
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(built, dest);

const restore = spawnSync(process.execPath, [installer, "--runtime", "node", "--target", process.versions.node, "--arch", os.arch()], {
  cwd: sqlite,
  stdio: "inherit",
});
if (restore.status !== 0) process.exit(restore.status ?? 1);
console.log(JSON.stringify({ status: "downloaded", dest: path.relative(root, dest).replaceAll("\\", "/") }));
