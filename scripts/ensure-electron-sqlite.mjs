import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { repoRoot, desktopOutput, electronSqlite } from "./desktop-paths.ts";

const require = createRequire(import.meta.url);
const desktopRequire = createRequire(path.join(repoRoot, "apps/desktop/package.json"));
const electron = desktopRequire("electron");
function verifyNative() {
  if (!fs.existsSync(electronSqlite)) return false;
  const result = spawnSync(electron, ["-e", "const Database = require('better-sqlite3'); const db = new Database(':memory:', { nativeBinding: process.env.MANGA_NATIVE_PROBE }); db.prepare('SELECT 1').get(); db.close();"], {
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MANGA_NATIVE_PROBE: electronSqlite },
    encoding: "utf8", windowsHide: true, timeout: 20_000,
  });
  return result.status === 0;
}
if (verifyNative()) {
  console.log("Electron SQLite ABI verified (cached).");
  process.exit(0);
}

// Download in isolated staging. Never replace Node's installed binding.
const stagingRoot = path.join(desktopOutput, "native/staging");
fs.mkdirSync(stagingRoot, { recursive: true });
const staging = fs.mkdtempSync(path.join(stagingRoot, "sqlite-"));
fs.copyFileSync(require.resolve("better-sqlite3/package.json"), path.join(staging, "package.json"));
const installer = require.resolve("prebuild-install/bin.js");
const result = spawnSync(process.execPath, [installer, "--runtime", "electron", "--target", "37.4.0", "--arch", "x64"], {
  cwd: staging,
  stdio: "inherit",
  windowsHide: true,
});
if (result.status !== 0) process.exit(result.status ?? 1);
fs.mkdirSync(path.dirname(electronSqlite), { recursive: true });
fs.copyFileSync(path.join(staging, "build/Release/better_sqlite3.node"), electronSqlite);
if (!verifyNative()) throw new Error("Electron SQLite ABI check failed; development launch stopped.");
console.log("Electron SQLite ABI verified; Node binding preserved.");
