import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { repoRoot, desktopOutput } from "./desktop-paths.ts";
import { packAllPlugins, pluginBuildDir } from "./desktop-plugins.ts";

const prepared = spawnSync(process.execPath, ["scripts/verify-electron-sqlite.mjs"], { cwd: repoRoot, stdio: "inherit", windowsHide: true });
if (prepared.status !== 0) process.exit(prepared.status ?? 1);
// A development run is the development channel and keeps to its own places (计划 4.9): %LOCALAPPDATA%\manga-dev, <Documents>\manga-dev and
// <Downloads>\manga-dev, beside an installed release and never in its folders. `--isolated` keeps everything under dist/desktop/development instead.
const isolated = process.argv.includes("--isolated");
const devRoot = path.join(desktopOutput, "development");
const env = { ...process.env, MANGA_CHANNEL: "development" };
if (isolated) {
  fs.mkdirSync(devRoot, { recursive: true });
  Object.assign(env, {
    MANGA_PROFILE_ROOT: path.join(devRoot, "profile"),
    MANGA_POINTER_FILE: path.join(devRoot, "launcher/pointer.json"),
    MANGA_DOCUMENTS_DIR: path.join(devRoot, "documents"),
    MANGA_DOWNLOADS_DIR: path.join(devRoot, "downloads"),
  });
}
// The plugins that come with the application are built and signed here, so the plugin settings offer them; without the first party's key they are left out.
try {
  const built = await packAllPlugins();
  env.MANGA_PLUGINS_DIR = pluginBuildDir;
  for (const item of built) console.log(`Bundled plugin ${item.id} ${item.version} built into dist/plugins.`);
} catch (error) {
  console.log(`Bundled plugins were not built: ${error instanceof Error ? error.message : String(error)}`);
}
console.log(isolated ? "Development data: dist/desktop/development (isolated)." : "Development data: the development channel's own folders (manga-dev), apart from a release.");
const require = createRequire(path.join(repoRoot, "apps/desktop/package.json"));
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(process.execPath, [require.resolve("@electron-forge/cli/dist/electron-forge.js"), "start", "--", ...process.argv.slice(2).filter((arg) => arg !== "--isolated")], {
  cwd: path.join(repoRoot, "apps/desktop"), env, stdio: "inherit", windowsHide: true,
});
process.exitCode = result.status ?? 1;
