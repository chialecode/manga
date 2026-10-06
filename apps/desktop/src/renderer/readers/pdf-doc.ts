import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

// Electron's Chromium may not ship Uint8Array.prototype.toHex yet. PDF.js 6 calls it while it builds pages.
const bytesPrototype = Uint8Array.prototype as Uint8Array & { toHex?: () => string };
if (typeof bytesPrototype.toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value(this: Uint8Array) {
      let hex = "";
      for (const byte of this) hex += byte.toString(16).padStart(2, "0");
      return hex;
    },
  });
}

export type PdfViewport = { width: number; height: number; scale: number };
export type PdfPageProxy = {
  getViewport: (params: { scale: number }) => PdfViewport;
  render: (params: { canvas: HTMLCanvasElement; viewport: PdfViewport }) => { promise: Promise<void>; cancel: () => void };
  cleanup: () => void;
};
export type PdfDocumentProxy = { numPages: number; getPage: (index: number) => Promise<PdfPageProxy>; destroy: () => Promise<void> };
type PdfTask = { promise: Promise<PdfDocumentProxy>; destroy: () => Promise<void> };

function assetBase(): string {
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  if (dev) return `${window.location.origin}/pdfjs/`;
  return new URL("./pdfjs/", window.location.href).href;
}

const EXPECTED_VERSION = "6.3.289";
const MAX_OPEN = 2;
const open = new Map<string, { task: PdfTask; doc: Promise<PdfDocumentProxy> }>();

/**
 * A PDF opened from a media handle URL. PDF.js asks the handle for byte ranges, so a large file is never read whole.
 * Documents are shared by URL and only the most recent few stay open, so a long reading session holds a bounded amount.
 */
export async function openPdfDocument(url: string): Promise<PdfDocumentProxy> {
  const cached = open.get(url);
  if (cached) {
    open.delete(url);
    open.set(url, cached);
    return cached.doc;
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as {
    version: string;
    GlobalWorkerOptions: { workerSrc: string };
    getDocument: (source: Record<string, unknown>) => PdfTask;
  };
  if (pdfjs.version !== EXPECTED_VERSION) throw new Error(`pdf.js ${pdfjs.version} does not match ${EXPECTED_VERSION}`);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(workerUrl, window.location.href).toString();
  const base = assetBase();
  const task = pdfjs.getDocument({
    url,
    rangeChunkSize: 1 << 20,
    disableAutoFetch: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
  });
  const doc = task.promise;
  open.set(url, { task, doc });
  // A document that fails to open must not stay cached, or a retry with a fresh handle would never be tried.
  doc.catch(() => { if (open.get(url)?.doc === doc) open.delete(url); });
  while (open.size > MAX_OPEN) {
    const oldest = open.keys().next().value as string;
    const stale = open.get(oldest);
    open.delete(oldest);
    void stale?.task.destroy().catch(() => undefined);
  }
  return doc;
}

/** Drop a document, for example when its handle expired. */
export function closePdfDocument(url: string): void {
  const entry = open.get(url);
  if (!entry) return;
  open.delete(url);
  void entry.task.destroy().catch(() => undefined);
}

/** Cap on canvas pixels: a wide strip page at a high pixel ratio must not ask the GPU for a huge surface. */
export const MAX_CANVAS_PIXELS = 24_000_000;
