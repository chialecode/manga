import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { desktopPackageDir } from "../../scripts/desktop-paths.ts";
import { stageBundledAssets } from "../../scripts/desktop-assets.ts";
import { stageBundledPlugins } from "../../scripts/desktop-plugins.ts";
import { createBuildInfo, writeBuildInfo } from "@manga/app-core";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopRoot, "../..");
// Capture source inputs before Vite builds. This also gives CI's direct Forge package a provenance
// record; an absent local latest-package.json must not allow an older directory into a release.
const provenancePromise = import(pathToFileURL(path.join(repoRoot, "scripts/stage/lib.mjs")).href).then(({ stageFingerprints, loadGate }) => stageFingerprints(repoRoot, loadGate()));

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
 * to images; `sqlite-vec` brings the vector search extension of the semantic index. Their binaries and the libraries beside them are unpacked from the app archive (see `unpack` below).
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

/** `MANGA_BUILD_CHANNEL=release` makes a release; anything else a development build. */
export const buildChannel = (): "release" | "development" => (process.env.MANGA_BUILD_CHANNEL === "release" ? "release" : "development");

export default {
  outDir: desktopPackageDir,
  packagerConfig: {
    asar: {
      // Native files, the worker bundles, and the whole canvas package and its platform build (PDF.js looks for them next to the unpacked PDF.js files).
      unpack: "{**/{.**,**}/**/{*.node,*.dll,icudtl.dat,parse-worker.cjs,vad-worker.cjs},**/node_modules/@napi-rs/**}",
    },
    name: "manga",
    executableName: "manga",
    icon: path.join(desktopRoot, "assets/icon"),
    appCopyright: "Copyright © 2026 chialecode",
    win32metadata: {
      CompanyName: "chialecode",
      FileDescription: "二次元阅读观看、记录与辅助创作工作台",
      ProductName: "MANGA",
    },
    // The Electron zip is checked against the checksums the installed electron package carries, not a SHASUMS256.txt fetched from GitHub on every
    // package: a GitHub error (a 504 once ended a gate run) no longer fails a build whose zip is already in the cache (LOOP-27).
    download: { checksums: JSON.parse(readFileSync(path.join(repoRoot, "node_modules", "electron", "checksums.json"), "utf8")) as Record<string, string> },
  },
  rebuildConfig: {
    force: false,
    onlyModules: ["__skip_native_rebuild__"],
  },
  hooks: {
    packageAfterCopy: async (_config: unknown, buildPath: string) => {
      copyRuntimeNative(buildPath);
      copyModules(buildPath, ["sharp", "@napi-rs/canvas", "sqlite-vec", "electron-updater"]);
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
        const resources = path.join(output, "resources");
        stageBundledAssets(resources, { rendererDir: path.join(desktopRoot, ".vite/renderer/main_window"), buildDir: path.join(desktopRoot, ".vite/build") });
        // The plugins that come with the application are signed with the first party's key at this point; without the key the package is not made.
        await stageBundledPlugins(resources);
        // The channel and build metadata are part of the package (计划 4.1, 4.9): a package from the repository is a development build unless the release is asked for.
        const channel = buildChannel();
        const buildInfo = createBuildInfo({ channel, cwd: repoRoot });
        writeFileSync(path.join(resources, "channel.json"), `${JSON.stringify({ channel })}\n`);
        writeBuildInfo(resources, buildInfo);
        writeFileSync(path.join(resources, "build-provenance.json"), `${JSON.stringify({ ...(await provenancePromise), commit: buildInfo.commit })}\n`);
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
