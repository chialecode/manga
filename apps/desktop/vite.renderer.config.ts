import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const rendererRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src/renderer");
const pdfjsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/pdfjs-dist");
const pdfjsKinds = ["cmaps", "standard_fonts", "wasm", "iccs"];

function pdfjsAssets(): Plugin {
  return {
    name: "manga-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split("?")[0] ?? "";
        if (!url.startsWith("/pdfjs/")) { next(); return; }
        const relative = decodeURIComponent(url.slice("/pdfjs/".length));
        const file = path.resolve(pdfjsRoot, relative);
        if (relative.includes("..") || !file.startsWith(pdfjsRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { next(); return; }
        response.setHeader("Content-Type", "application/octet-stream");
        fs.createReadStream(file).pipe(response);
      });
    },
    generateBundle() {
      const emit = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const from = path.join(dir, entry.name);
          const key = `${prefix}/${entry.name}`.replaceAll("\\", "/");
          if (entry.isDirectory()) emit(from, key);
          else this.emitFile({ type: "asset", fileName: `pdfjs/${key}`, source: fs.readFileSync(from) });
        }
      };
      for (const kind of pdfjsKinds) {
        const dir = path.join(pdfjsRoot, kind);
        if (fs.existsSync(dir)) emit(dir, kind);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  resolve: { alias: { "@": rendererRoot } },
  root: "src/renderer",
  build: {
    outDir: "../../.vite/renderer/main_window",
    emptyOutDir: true,
  },
});
