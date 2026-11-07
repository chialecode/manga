import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopRoot, "../..");

function copyRuntimeNative(buildPath: string): void {
  const names = ["better-sqlite3", "bindings", "file-uri-to-path"];
  for (const name of names) {
    const from = path.join(repoRoot, "node_modules", name);
    const to = path.join(buildPath, "node_modules", name);
    if (!existsSync(from)) throw new Error(`runtime native dependency missing: ${name}`);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  const electronNode = path.join(repoRoot, "dist/m1a-native/better_sqlite3.node");
  if (!existsSync(electronNode)) throw new Error("Electron better-sqlite3 prebuild missing; run node scripts/ensure-electron-sqlite.mjs");
  const nativeDest = path.join(buildPath, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
  mkdirSync(path.dirname(nativeDest), { recursive: true });
  cpSync(electronNode, nativeDest);
}

export default {
  outDir: path.resolve(desktopRoot, "../../dist/m1a-package"),
  packagerConfig: {
    asar: {
      unpack: "**/{.**,**}/**/{*.node,parse-worker.cjs}",
    },
    name: "MANGA",
    executableName: "MANGA",
  },
  rebuildConfig: {
    force: false,
    onlyModules: ["__skip_native_rebuild__"],
  },
  hooks: {
    packageAfterCopy: async (_config: unknown, buildPath: string) => {
      copyRuntimeNative(buildPath);
      const worker = path.join(desktopRoot, ".vite/build/parse-worker.cjs");
      if (!existsSync(worker)) throw new Error("parse-worker.cjs missing after Vite build");
      const dest = path.join(buildPath, ".vite/build/parse-worker.cjs");
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(worker, dest);
    },
    postPackage: async (_config: unknown, result: { outputPaths: string[] }) => {
      const worker = path.join(desktopRoot, ".vite/build/parse-worker.cjs");
      if (!existsSync(worker)) throw new Error("parse-worker.cjs missing after package");
      for (const output of result.outputPaths) {
        const dest = path.join(output, "resources", "parse-worker.cjs");
        mkdirSync(path.dirname(dest), { recursive: true });
        cpSync(worker, dest);
      }
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: "src/main/index.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload/index.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};
