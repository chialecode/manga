import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { repoRoot, desktopOutput } from "./desktop-paths.ts";

const prepared = spawnSync(process.execPath, ["scripts/ensure-electron-sqlite.mjs"], { cwd: repoRoot, stdio: "inherit", windowsHide: true });
if (prepared.status !== 0) process.exit(prepared.status ?? 1);
const devRoot = path.join(desktopOutput, "development");
fs.mkdirSync(devRoot, { recursive: true });
const env = {
  ...process.env,
  MANGA_CHANNEL: "development",
  MANGA_PROFILE_ROOT: path.join(devRoot, "profile"),
  MANGA_POINTER_FILE: path.join(devRoot, "launcher/pointer.json"),
  MANGA_DOCUMENTS_DIR: path.join(devRoot, "documents"),
};
console.log("Development data: dist/desktop/development (isolated from installed profiles).");
const require = createRequire(path.join(repoRoot, "apps/desktop/package.json"));
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(process.execPath, [require.resolve("@electron-forge/cli/dist/electron-forge.js"), "start", "--", ...process.argv.slice(2)], {
  cwd: path.join(repoRoot, "apps/desktop"), env, stdio: "inherit", windowsHide: true,
});
process.exitCode = result.status ?? 1;
