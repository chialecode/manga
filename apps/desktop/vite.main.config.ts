import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import esbuild from "esbuild";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/main/index.ts",
      formats: ["cjs"],
      fileName: () => "main.cjs",
    },
    rollupOptions: {
      external: [
        "electron",
        "better-sqlite3",
        "node:fs",
        "node:path",
        "node:os",
        "node:crypto",
        "node:child_process",
        "node:url",
        "node:readline",
        "node:http",
        "node:process",
        "node:module",
      ],
    },
    sourcemap: true,
    outDir: ".vite/build",
  },
  plugins: [
    {
      name: "bundle-parse-worker",
      async closeBundle() {
        const outfile = path.resolve(".vite/build/parse-worker.cjs");
        await esbuild.build({
          absWorkingDir: process.cwd(),
          entryPoints: ["src/main/parse-worker.ts"],
          outfile,
          bundle: true,
          platform: "node",
          format: "cjs",
          sourcemap: true,
        });
        if (!existsSync(outfile)) throw new Error("parse-worker.cjs was not emitted");
      },
    },
  ],
});
