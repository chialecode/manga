import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Light open's page (`light_window`): the light shells and the readers' hooks and controls they use, with the app's theme. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(here, "src/renderer") } },
  root: "src/light",
  build: {
    outDir: "../../.vite/renderer/light_window",
    emptyOutDir: true,
  },
});
