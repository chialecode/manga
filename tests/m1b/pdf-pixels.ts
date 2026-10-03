import path from "node:path";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

function assetUrl(kind: string): string {
  return path.resolve("node_modules/pdfjs-dist", kind).replaceAll("\\", "/") + "/";
}

/** Paint one page with the same offline PDF.js options the product uses. */
export async function renderPdfPage(bytes: Uint8Array, scale = 4): Promise<{ ctx: SKRSContext2D; width: number; height: number }> {
  const task = getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    cMapUrl: assetUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assetUrl("standard_fonts"),
    wasmUrl: assetUrl("wasm"),
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
    page.cleanup();
    return { ctx, width: viewport.width, height: viewport.height };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** True when two rasters match and the first is not a blank white box. */
export function samePaintedRegion(ctx: SKRSContext2D, left: [number, number, number, number], right: [number, number, number, number]): boolean {
  const a = ctx.getImageData(...left).data;
  const b = ctx.getImageData(...right).data;
  if (a.length !== b.length) return false;
  let different = 0;
  let ink = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) different += 1;
    if (a[index] !== 255) ink += 1;
  }
  return different === 0 && ink > 0;
}
