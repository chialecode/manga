import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";
import esbuild from "esbuild";

/** Native modules stay outside the bundles; the package copies them next to the app (see forge.config.ts). */
const NATIVE = ["better-sqlite3", "sharp", "@napi-rs/canvas"];
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
    external: [...NATIVE, "@napi-rs/canvas-*", "electron"],
  });
  if (!existsSync(outfile)) throw new Error(`${name} was not emitted`);
}

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/main/index.ts",
      formats: ["cjs"],
      fileName: () => "main.cjs",
    },
    rollupOptions: {
      external: ["electron", ...NATIVE, /^@napi-rs\/canvas/, ...nodeBuiltins],
    },
    sourcemap: true,
    outDir: ".vite/build",
  },
  plugins: [
    {
      name: "bundle-workers",
      async closeBundle() {
        await bundleWorker("src/main/parse-worker.ts", "parse-worker.cjs");
        // The voice filter's worker thread; it loads the model and the WebAssembly runtime by path at run time.
        await bundleWorker("../../packages/app-core/src/voice/vad-worker.ts", "vad-worker.cjs");
      },
    },
  ],
});
