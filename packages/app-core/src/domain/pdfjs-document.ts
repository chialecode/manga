/**
 * Product PDF adapter. PDF.js owns objects, fonts, images and painting.
 * MANGA owns page identity (`page-N`), NFC/LF code-point offsets, and the stored text layer.
 * There is no fallback to a built-in content-stream interpreter.
 */

import { MangaError, NORMALIZATION_V1 } from "@manga/contracts";
import { mapCanonicalPieces } from "./pdf-text-map.ts";
import { normalizeText } from "./text.ts";
import { PDFJS_ENGINE_ID, PDFJS_PARSER_ID, PDFJS_REPRESENTATION, PDFJS_VERSION, pdfjsAssetUrl, pdfjsModuleHref, pdfjsWorkerHref } from "./pdfjs-assets.ts";
import type { ParsedAsset, ParsedDocument, ParsedPart, PdfTextRun } from "./formats.ts";

type PdfjsModule = {
  version: string;
  GlobalWorkerOptions: { workerSrc: string };
  OPS: Record<string, number>;
  getDocument: (src: Record<string, unknown>) => { promise: Promise<PdfjsDocument>; destroy: () => Promise<void> };
};

type PdfjsDocument = {
  numPages: number;
  getPage: (index: number) => Promise<PdfjsPage>;
};

type PdfjsTextItem = {
  str?: string;
  fontName?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
};

type PdfjsPage = {
  getTextContent: () => Promise<{ items: PdfjsTextItem[] }>;
  getOperatorList: () => Promise<{ fnArray: number[] }>;
  cleanup: () => void;
};

const IMAGE_OPS = ["paintImageXObject", "paintJpegXObject", "paintImageXObjectRepeat", "paintImageMaskXObject", "paintXObject"];

function latinSample(bytes: Uint8Array): string {
  const head = bytes.subarray(0, Math.min(bytes.length, 256 * 1024));
  const tail = bytes.subarray(Math.max(0, bytes.length - 8192));
  let out = "";
  const append = (chunk: Uint8Array) => {
    for (let index = 0; index < chunk.length; index += 0x8000) {
      out += String.fromCharCode(...chunk.subarray(index, index + 0x8000));
    }
  };
  append(head);
  if (tail !== head) append(tail);
  return out;
}

/** One mapping from PDF.js text items onto the normalized page text. Offsets are omitted when NFC would merge across an item boundary. */
const UNMAPPED_GLYPH = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export function mapPdfTextItems(items: PdfjsTextItem[]): { normalized: string; parserVersion: string; runs: PdfTextRun[]; stable: boolean; droppedUnmapped: boolean } {
  const unmappedFonts = new Set<string>();
  for (const item of items) {
    if (typeof item.str === "string" && item.fontName && UNMAPPED_GLYPH.test(item.str)) unmappedFonts.add(item.fontName);
  }
  const textual: PdfjsTextItem[] = [];
  const full: Array<{ text: string; eol: boolean }> = [];
  for (const item of items) {
    if (!("str" in item) || typeof item.str !== "string") continue;
    const unmapped = UNMAPPED_GLYPH.test(item.str) || (item.fontName !== undefined && unmappedFonts.has(item.fontName));
    if (unmapped) {
      if (item.hasEOL) full.push({ text: "", eol: true });
      continue;
    }
    textual.push(item);
    full.push({ text: item.str, eol: Boolean(item.hasEOL) });
  }
  const mapped = mapCanonicalPieces(full);
  const runsOnly = mapCanonicalPieces(textual.map((item) => ({ text: item.str ?? "", eol: Boolean(item.hasEOL) })));
  const stable = mapped.stable && runsOnly.stable && mapped.normalized === runsOnly.normalized;
  const runs: PdfTextRun[] = textual.map((item, index) => {
    const transform = item.transform ?? [];
    const span = runsOnly.spans[index];
    return {
      text: item.str ?? "",
      x: Number(transform[4] ?? 0),
      y: Number(transform[5] ?? 0),
      width: Number(item.width ?? 0),
      ...(stable && span ? { offset: span.start } : {}),
    };
  });
  return {
    normalized: mapped.normalized,
    parserVersion: normalizeText(mapped.normalized).parserVersion,
    runs,
    stable,
    droppedUnmapped: unmappedFonts.size > 0,
  };
}

async function loadPdfjs(): Promise<PdfjsModule> {
  const pdfjs = await import(pdfjsModuleHref()) as PdfjsModule;
  if (pdfjs.version !== PDFJS_VERSION) {
    throw new MangaError("UNSUPPORTED_FORMAT", `pdf.js ${pdfjs.version} does not match pinned ${PDFJS_VERSION}`);
  }
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerHref();
  return pdfjs;
}

function paintImage(ops: number[], names: Record<string, number>): boolean {
  const wanted = new Set(IMAGE_OPS.map((name) => names[name]).filter((value) => value !== undefined));
  return ops.some((fn) => wanted.has(fn));
}

/**
 * Open a PDF with PDF.js and return the MANGA document. Encrypted files are rejected before
 * any page is published. A parse failure is an error, never a silent downgrade.
 */
export async function parsePdfDocument(bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<ParsedDocument> {
  if (options.signal?.aborted) throw new MangaError("CANCELLED", "pdf parse cancelled");
  if (latinSample(bytes).includes("%PDF-") === false && !String.fromCharCode(...bytes.subarray(0, 5)).startsWith("%PDF-")) {
    throw new MangaError("UNSUPPORTED_FORMAT", "invalid pdf");
  }
  if (/\/Encrypt\b/.test(latinSample(bytes))) throw new MangaError("UNSUPPORTED_FORMAT", "encrypted pdf rejected");
  const pdfjs = await loadPdfjs();
  if (options.signal?.aborted) throw new MangaError("CANCELLED", "pdf parse cancelled");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    cMapUrl: pdfjsAssetUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: pdfjsAssetUrl("standard_fonts"),
    wasmUrl: pdfjsAssetUrl("wasm"),
  });
  // Destroying a PDF.js worker does not guarantee that every outstanding page promise rejects.
  // Give cancellation its own completion path, while observing the original promises via race.
  const cancelled = Promise.withResolvers<never>();
  const wait = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, cancelled.promise]);
  let destruction: Promise<void> | undefined;
  const destroy = () => destruction ??= task.destroy().catch(() => undefined);
  const onAbort = () => {
    cancelled.reject(new MangaError("CANCELLED", "pdf parse cancelled"));
    void destroy();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const doc = await wait(task.promise);
    options.signal?.throwIfAborted();
    const assets: ParsedAsset[] = [];
    const parts: ParsedPart[] = [];
    const emptyPages: number[] = [];
    const warnings: string[] = [];
    for (let index = 1; index <= doc.numPages; index += 1) {
      options.signal?.throwIfAborted();
      const page = await wait(doc.getPage(index));
      const content = await wait(page.getTextContent());
      let hasImage = false;
      try {
        const operators = await wait(page.getOperatorList());
        hasImage = paintImage(operators.fnArray, pdfjs.OPS);
      } catch {
        hasImage = false;
      }
      options.signal?.throwIfAborted();
      const mapped = mapPdfTextItems(content.items);
      const hasText = Boolean(mapped.normalized.trim());
      const partId = `page-${index}`;
      if (!hasText && !hasImage) emptyPages.push(index);
      if (mapped.droppedUnmapped) warnings.push(`page ${index} omitted glyphs with no Unicode mapping`);
      parts.push({
        id: partId,
        title: `第 ${index} 页`,
        normalized: mapped.normalized,
        kind: hasText ? "text" : hasImage ? "image" : "text",
        parserVersion: mapped.parserVersion,
        index: index - 1,
        ...(mapped.runs.length ? { textRuns: mapped.runs } : {}),
      });
      page.cleanup();
    }
    if (!parts.length) throw new MangaError("UNSUPPORTED_FORMAT", "pdf has no pages");
    const sample = latinSample(bytes);
    const scanPages = parts.filter((part) => part.kind === "image");
    if (scanPages.length) warnings.push("scanned pages show their image and have no OCR text layer");
    if (emptyPages.length) warnings.push(`pages without text or image content: ${emptyPages.join(", ")}`);
    warnings.push("pdf pages are drawn by PDF.js; selection uses the text layer code-point map");
    const title = parts.find((part) => part.kind === "text" && part.normalized)?.normalized.split("\n")[0]?.slice(0, 80) || "pdf";
    return {
      format: "pdf",
      title,
      parserId: PDFJS_PARSER_ID,
      parts,
      toc: parts.map((part) => ({ label: part.title || part.id, partId: part.id })),
      assets,
      traits: {
        pages: parts.length,
        pageTree: doc.numPages,
        textPages: parts.filter((part) => part.kind === "text" && part.normalized.trim()).length,
        scanPages: scanPages.length,
        emptyPages: emptyPages.length,
        objectStreams: /\/ObjStm\b/.test(sample),
        storedAssets: assets.length,
        multiContentStream: /\/Contents\s*\[/.test(sample),
        pdfjsPageRendering: true,
        engine: PDFJS_ENGINE_ID,
        engineVersion: pdfjs.version,
        representation: PDFJS_REPRESENTATION,
        ocr: false,
        candidate: false,
        accepted: true,
        normalization: NORMALIZATION_V1,
      },
      warnings,
    };
  } catch (error) {
    if (options.signal?.aborted) throw new MangaError("CANCELLED", "pdf parse cancelled");
    if (error instanceof MangaError) throw error;
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError") throw new MangaError("CANCELLED", "pdf parse cancelled");
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt|password/i.test(message)) throw new MangaError("UNSUPPORTED_FORMAT", "encrypted pdf rejected", { cause: error });
    throw new MangaError("UNSUPPORTED_FORMAT", message || "pdf could not be opened", { cause: error });
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await destroy();
  }
}
