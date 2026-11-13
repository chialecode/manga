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

/** The pdf.js the packaged assets are built from; both PDF views check the loaded library against it. */
export const EXPECTED_VERSION = "6.5.438";
const MAX_OPEN = 2;
type OpenPdfEntry = { task: PdfTask | null; doc: Promise<PdfDocumentProxy>; closed: boolean };
const open = new Map<string, OpenPdfEntry>();

/**
 * A PDF opened from a media handle URL. PDF.js asks the handle for byte ranges, so a large file is never read whole.
 * Documents are shared by URL (including concurrent opens while pdf.js loads) and only the most recent few stay open,
 * so a long reading session holds a bounded amount.
 */
export function openPdfDocument(url: string): Promise<PdfDocumentProxy> {
  const cached = open.get(url);
  if (cached) {
    open.delete(url);
    open.set(url, cached);
    return cached.doc;
  }
  const entry: OpenPdfEntry = { task: null, doc: Promise.resolve(null as never), closed: false };
  const doc = (async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as {
      version: string;
      GlobalWorkerOptions: { workerSrc: string };
      getDocument: (source: Record<string, unknown>) => PdfTask;
    };
    if (pdfjs.version !== EXPECTED_VERSION) throw new Error(`pdf.js ${pdfjs.version} does not match ${EXPECTED_VERSION}`);
    if (entry.closed) throw new Error("pdf document closed before opening");
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
    if (entry.closed) {
      void task.destroy().catch(() => undefined);
      throw new Error("pdf document closed before opening");
    }
    entry.task = task;
    try {
      const loaded = await task.promise;
      if (entry.closed) {
        void task.destroy().catch(() => undefined);
        throw new Error("pdf document closed before opening");
      }
      return loaded;
    } catch (error) {
      void task.destroy().catch(() => undefined);
      throw error;
    }
  })();
  entry.doc = doc;
  open.set(url, entry);
  // A document that fails to open must not stay cached, or a retry with a fresh handle would never be tried.
  doc.catch(() => { if (open.get(url) === entry) open.delete(url); });
  while (open.size > MAX_OPEN) {
    const oldest = open.keys().next().value as string;
    const stale = open.get(oldest);
    open.delete(oldest);
    if (stale) {
      stale.closed = true;
      void stale.task?.destroy().catch(() => undefined);
    }
  }
  return doc;
}

/** Drop a document, for example when its handle expired. */
export function closePdfDocument(url: string): void {
  const entry = open.get(url);
  if (!entry) return;
  open.delete(url);
  entry.closed = true;
  void entry.task?.destroy().catch(() => undefined);
}

/** Cap on canvas pixels: a wide strip page at a high pixel ratio must not ask the GPU for a huge surface. */
export const MAX_CANVAS_PIXELS = 24_000_000;
