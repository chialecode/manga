/**
 * Offline PDF.js asset locations. The packaged app copies the same tree to resources/pdfjs;
 * development and tests resolve the installed package. No CDN.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PDFJS_VERSION = "6.3.289";
export const PDFJS_ENGINE_ID = "pdfjs-dist";
export const PDFJS_REPRESENTATION = "pdfjs-text-layer-v1";
export const PDFJS_PARSER_ID = "pdfjs-dist@6.3.289";

function hasModule(dir: string): boolean {
  return fs.existsSync(path.join(dir, "legacy", "build", "pdf.mjs"));
}

/** Directory that contains `legacy/build/pdf.mjs`, `cmaps`, `standard_fonts` and `wasm`. */
export function pdfjsPackageRoot(): string {
  const fromEnv = process.env.MANGA_PDFJS_DIR;
  if (fromEnv && hasModule(fromEnv)) return fromEnv;
  const starts = [process.cwd(), path.dirname(process.argv[1] ?? "")];
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(dir, "node_modules", "pdfjs-dist");
      if (hasModule(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("pdf.js offline assets are not available");
}

/** Filesystem URL prefix PDF.js accepts for cmap, font and wasm data. Always uses `/` and a trailing slash. */
export function pdfjsAssetUrl(kind: "cmaps" | "standard_fonts" | "wasm"): string {
  return path.join(pdfjsPackageRoot(), kind).replaceAll("\\", "/") + "/";
}

export function pdfjsModuleHref(): string {
  return pathToFileURL(path.join(pdfjsPackageRoot(), "legacy", "build", "pdf.mjs")).href;
}

export function pdfjsWorkerHref(): string {
  return pathToFileURL(path.join(pdfjsPackageRoot(), "legacy", "build", "pdf.worker.mjs")).href;
}
