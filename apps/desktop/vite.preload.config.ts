import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: { entry: "src/preload/index.ts", formats: ["cjs"], fileName: () => "preload.cjs" },
    rollupOptions: { external: ["electron"] },
    sourcemap: true,
    outDir: ".vite/build",
  },
});
