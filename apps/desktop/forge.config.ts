import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { desktopPackageDir } from "../../scripts/desktop-paths.ts";
import { stageBundledAssets } from "../../scripts/desktop-assets.ts";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopRoot, "../..");

/** better-sqlite3 >= 13 carries its N-API prebuilds; ship only the loader and the win32-x64 binary. */
function copyRuntimeNative(buildPath: string): void {
  const from = path.join(repoRoot, "node_modules", "better-sqlite3");
  const to = path.join(buildPath, "node_modules", "better-sqlite3");
  if (!existsSync(path.join(from, "prebuilds", "win32-x64.node"))) throw new Error("better-sqlite3 win32-x64 prebuild missing; run pnpm install");
  mkdirSync(path.join(to, "prebuilds"), { recursive: true });
  cpSync(path.join(from, "lib"), path.join(to, "lib"), { recursive: true });
  cpSync(path.join(from, "package.json"), path.join(to, "package.json"));
  cpSync(path.join(from, "LICENSE"), path.join(to, "LICENSE"));
  cpSync(path.join(from, "prebuilds", "win32-x64.node"), path.join(to, "prebuilds", "win32-x64.node"));
}

/**
 * Native modules the main process loads at run time and the bundle leaves outside: each is copied with the packages it
 * depends on (only those installed for this platform). `sharp` makes thumbnails and `@napi-rs/canvas` paints PDF pages
 * to images; their binaries and the libraries beside them are unpacked from the app archive (see `unpack` below).
 */
function copyModules(buildPath: string, roots: string[]): void {
  const seen = new Set<string>();
  const visit = (name: string, required: boolean): void => {
    if (seen.has(name)) return;
    const from = path.join(repoRoot, "node_modules", ...name.split("/"));
    if (!existsSync(path.join(from, "package.json"))) {
      if (required) throw new Error(`${name} is missing; run pnpm install`);
      return;
    }
    seen.add(name);
    cpSync(from, path.join(buildPath, "node_modules", ...name.split("/")), { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(from, "package.json"), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, true);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) visit(dependency, false);
  };
  for (const root of roots) visit(root, true);
}

export default {
  outDir: desktopPackageDir,
  packagerConfig: {
    asar: {
      // Native files, the worker bundles, and the whole canvas package and its platform build (PDF.js looks for them next to the unpacked PDF.js files).
      unpack: "{**/{.**,**}/**/{*.node,*.dll,icudtl.dat,parse-worker.cjs,vad-worker.cjs},**/node_modules/@napi-rs/**}",
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
      copyModules(buildPath, ["sharp", "@napi-rs/canvas"]);
      for (const name of ["parse-worker.cjs", "vad-worker.cjs"]) {
        const worker = path.join(desktopRoot, ".vite/build", name);
        if (!existsSync(worker)) throw new Error(`${name} missing after Vite build`);
        const dest = path.join(buildPath, ".vite/build", name);
        mkdirSync(path.dirname(dest), { recursive: true });
        cpSync(worker, dest);
      }
    },
    postPackage: async (_config: unknown, result: { outputPaths: string[] }) => {
      // Everything a package carries besides its code goes next to the app archive with a manifest the app checks at start.
      for (const output of result.outputPaths) {
        stageBundledAssets(path.join(output, "resources"), { rendererDir: path.join(desktopRoot, ".vite/renderer/main_window"), buildDir: path.join(desktopRoot, ".vite/build") });
      }
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: "src/main/index.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};
