import { defineConfig } from "vite";

// Forge's Vite plugin supplies the entry and emits [name].cjs, so src/preload/preload.ts becomes .vite/build/preload.cjs.
export default defineConfig({
  build: {
    emptyOutDir: false,
    sourcemap: true,
    outDir: ".vite/build",
  },
});
