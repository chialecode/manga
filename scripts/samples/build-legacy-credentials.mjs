// Builds dist/samples/legacy-e44-credentials: the Profile an Electron 44 build saved credentials into (计划 4.1).
// It needs Electron 44; once the repository is on a later Electron it fetches 44.9.3 with `pnpm dlx` (no change to the lock file).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { repoRoot } from "../desktop-paths.ts";

const out = path.join(repoRoot, "dist/samples/legacy-e44-credentials");
const bundle = path.join(repoRoot, "dist/samples/.legacy-e44/main.cjs");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.dirname(bundle), { recursive: true });
await build({
  entryPoints: [path.join(repoRoot, "scripts/samples/legacy-credentials-e44.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, target: "node22",
  // Native modules stay outside the bundle, as in the desktop main build (apps/desktop/vite.main.config.ts).
  external: ["electron", "better-sqlite3", "sharp", "@napi-rs/canvas", "@napi-rs/canvas-*", "onnxruntime-node"],
  define: { "import.meta.url": "__importMetaUrl" },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: "warning",
});
const desktopRequire = createRequire(path.join(repoRoot, "apps/desktop/package.json"));
const installed = JSON.parse(fs.readFileSync(desktopRequire.resolve("electron/package.json"), "utf8")).version;
const env = { ...process.env, MANGA_LEGACY_HOME: out, NODE_PATH: path.join(repoRoot, "node_modules") };
delete env.ELECTRON_RUN_AS_NODE;
const result = installed.startsWith("44.")
  ? spawnSync(desktopRequire("electron"), [bundle], { cwd: repoRoot, env, stdio: "inherit", windowsHide: true, timeout: 120_000 })
  : spawnSync("pnpm", ["dlx", "electron@44.9.3", bundle], { cwd: repoRoot, env, stdio: "inherit", shell: true, timeout: 600_000 });
if (result.status !== 0 || !fs.existsSync(path.join(out, "legacy.json"))) {
  console.error("the legacy credentials Profile was not made");
  process.exit(1);
}
console.log(`legacy Profile ready: ${path.relative(repoRoot, out)} (${fs.readFileSync(path.join(out, "legacy.json"), "utf8").trim()})`);
