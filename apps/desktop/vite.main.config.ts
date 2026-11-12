import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";
import esbuild from "esbuild";
import { danmakuDefine } from "./danmaku-define.ts";

/** Native and runtime-resolved modules stay outside the bundles; the package copies them next to the app (see forge.config.ts). */
const NATIVE = ["better-sqlite3", "sharp", "@napi-rs/canvas", "electron-updater", "sherpa-onnx-node"];
const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

/** A worker that runs on its own thread or process is one self-contained file, built here next to the main bundle. */
async function bundleWorker(entry: string, name: string): Promise<void> {
  const outfile = path.resolve(".vite/build", name);
  await esbuild.build({
    absWorkingDir: process.cwd(),
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    sourcemap: true,
    external: [...NATIVE, "@napi-rs/canvas-*", "sherpa-onnx-*", "electron"],
  });
  if (!existsSync(outfile)) throw new Error(`${name} was not emitted`);
}

/** The build of the main process without the worker step, so a test can build it into a folder of its own. */
export const mainBuild = {
  // The DanDanPlay application credentials are built into the main process and nowhere else (the renderer and preload configs have no such entry).
  define: danmakuDefine(process.env, path.resolve(process.cwd(), "../..")),
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/main/index.ts",
      formats: ["cjs" as const],
      // The full application; the packaged entry main.cjs is the bootstrap (vite.bootstrap.config.ts), which loads this file or light-main.cjs.
      fileName: () => "full-main.cjs",
    },
    rollupOptions: {
      external: ["electron", ...NATIVE, /^@napi-rs\/canvas/, /^sherpa-onnx/, ...nodeBuiltins],
      // The main process is one file: a module the entry and a lazily loaded part both use (the credentials among them) must not be split into a chunk of its own.
      output: { inlineDynamicImports: true },
    },
    sourcemap: true,
    outDir: ".vite/build",
  },
};

export default defineConfig({
  ...mainBuild,
  plugins: [
    {
      name: "bundle-workers",
      async closeBundle() {
        await bundleWorker("src/main/parse-worker.ts", "parse-worker.cjs");
        // The voice filter's worker thread; it loads the model and the WebAssembly runtime by path at run time.
        await bundleWorker("../../packages/app-core/src/voice/vad-worker.ts", "vad-worker.cjs");
        // The local speech inference utilityProcess entry; it loads sherpa-onnx-node outside the main bundle.
        await bundleWorker("src/main/asr-host.ts", "asr-host.cjs");
      },
    },
  ],
});
