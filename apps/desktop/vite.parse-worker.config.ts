import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: { entry: "src/main/parse-worker.ts", formats: ["cjs"], fileName: () => "parse-worker.cjs" },
    rollupOptions: {
      external: ["electron", "node:fs", "node:path", "node:readline", "node:url"],
    },
    sourcemap: true,
    outDir: ".vite/build",
  },
});
