/**
 * PDF.js adapter behind the MANGA reader-engine boundary (tests only).
 *
 * This is the reversible prototype of the唯一计划第 14 节 evaluation: pdfjs-dist is a devDependency,
 * the adapter lives in the test tree, and nothing in the product imports it. A production switch
 * (Q-14) would move this file into a workspace package implementing the same ReaderEngine type.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "node:path";
import type { ReaderEngine, ReaderEngineDocument, ReaderEnginePart, ReaderEngineTextRun } from "@manga/app-core";
import { normalizeText } from "../../packages/app-core/src/domain/text.ts";

/** Local copies of the offline assets pdfjs-dist ships; a production bundle must carry the same files. */
export const pdfjsAssets = {
  cmaps: path.join("node_modules", "pdfjs-dist", "cmaps") + path.sep,
  standardFonts: path.join("node_modules", "pdfjs-dist", "standard_fonts") + path.sep,
};

/** pdf.js's Node factories read plain filesystem paths, not `file://` URLs. */
export function assetUrl(relative: string): string {
  return path.resolve(relative).split(path.sep).join("/") + "/";
}

/** Open one PDF with PDF.js and map pages onto MANGA part identity, normalization and run offsets. */
export function createPdfjsEngine(version: string): ReaderEngine {
  return {
    engineId: "pdfjs-dist",
    version,
    async parse(bytes, options) {
      options?.signal?.throwIfAborted();
      const task = getDocument({
        data: bytes.slice(),
        disableFontFace: true,
        isEvalSupported: false,
        useSystemFonts: false,
        useWorkerFetch: false,
        cMapUrl: assetUrl(pdfjsAssets.cmaps),
        cMapPacked: true,
        standardFontDataUrl: assetUrl(pdfjsAssets.standardFonts),
      });
      const onAbort = () => { task.destroy().catch(() => undefined); };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const doc = await task.promise;
        const parts: ReaderEnginePart[] = [];
        for (let index = 1; index <= doc.numPages; index += 1) {
          options?.signal?.throwIfAborted();
          const page = await doc.getPage(index);
          const content = await page.getTextContent();
          // PDF.js reports each positioned item in PDF user space (y up) with its rendered width and an
          // EOL flag. Items arrive in content order, so the offset of one item is the code-point length
          // of the normalized prefix before it; if NFC would merge across an item boundary, the offsets
          // are dropped (the same rule the built-in layout model applies).
          const raw = content.items.map((item) => ("str" in item ? item.str : "") + (("hasEOL" in item && item.hasEOL) ? "\n" : "")).join("");
          const normalized = normalizeText(raw);
          const runs: ReaderEngineTextRun[] = [];
          let prefix = "";
          for (const item of content.items) {
            if (!("str" in item)) continue;
            const eol = "hasEOL" in item && item.hasEOL ? "\n" : "";
            runs.push({
              text: item.str,
              x: item.transform[4] as number,
              y: item.transform[5] as number,
              width: item.width as number,
              offset: [...normalizeText(prefix).normalized].length,
            });
            prefix += item.str + eol;
          }
          const stable = normalizeText(prefix).normalized === normalized.normalized;
          parts.push({
            id: `page-${index}`,
            kind: runs.length ? "text" : "scan",
            normalized: normalized.normalized,
            ...(runs.length ? { runs: stable ? runs : runs.map(({ offset: _offset, ...rest }) => rest) } : {}),
          });
        }
        return { format: "pdf", parts, warnings: [] };
      } finally {
        options?.signal?.removeEventListener("abort", onAbort);
        // The prototype parses eagerly and releases the document right away.
        task.destroy().catch(() => undefined);
      }
    },
    async dispose() { /* each parse releases its own document */ },
  };
}

/** Open and immediately release one PDF, returning the mapped document (prototype convenience). */
export async function parseWithPdfjs(bytes: Uint8Array, version: string, options?: { signal?: AbortSignal }): Promise<ReaderEngineDocument> {
  const engine = createPdfjsEngine(version);
  try {
    return await engine.parse(bytes, options);
  } finally {
    await engine.dispose();
  }
}
