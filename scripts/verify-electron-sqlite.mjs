// better-sqlite3 >= 13 ships N-API prebuilds inside the package, so the same binary loads in Node and Electron.
// This script only verifies that; it never downloads or replaces a binary.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { repoRoot } from "./desktop-paths.ts";

const desktopRequire = createRequire(path.join(repoRoot, "apps/desktop/package.json"));
const electron = desktopRequire("electron");
const probe = "const Database = require('better-sqlite3'); const db = new Database(':memory:'); const row = db.prepare('SELECT sqlite_version() AS v').get(); db.close(); process.stdout.write(row.v);";

function run(command, env) {
  return spawnSync(command, ["-e", probe], { cwd: repoRoot, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true, timeout: 20_000 });
}

const inNode = run(process.execPath, {});
const inElectron = run(electron, { ELECTRON_RUN_AS_NODE: "1" });
if (inNode.status !== 0 || inElectron.status !== 0) {
  console.error(`better-sqlite3 check failed. node=${inNode.status} ${inNode.stderr?.trim()} electron=${inElectron.status} ${inElectron.stderr?.trim()}`);
  process.exit(1);
}
console.log(`better-sqlite3 prebuild verified in Node (SQLite ${inNode.stdout}) and Electron (SQLite ${inElectron.stdout}).`);
