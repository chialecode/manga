/**
 * Taking a picture of what is on the page (NOTE-05). The picture is the source's own pixels: a video's current frame at the size the file is
 * decoded at, a comic page at its original size. Nothing is re-seeked or re-decoded by another program, so the picture is the frame the person sees.
 */

import { drawTextSubtitles, type TextSubtitleDraw } from "./subtitle-raster.ts";

export type Captured = { data: string; width: number; height: number };
export type CaptureFailure = "no-frame" | "tainted" | "encode";

/** A canvas result is a Blob; the command carries base64, which the reader of data URLs gives without holding the bytes twice in script. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const text = String(reader.result); resolve(text.slice(text.indexOf(",") + 1)); };
    reader.onerror = () => reject(reader.error ?? new Error("the picture could not be read"));
    reader.readAsDataURL(blob);
  });
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

/**
 * The subtitles to draw into a picture: the text tracks as cues with the style they are shown in, and an ASS track as the canvas its renderer drew
 * at the video's own size. Either may be absent; a track that shows nothing at that moment draws nothing.
 */
export type SubtitleDraw = { text?: TextSubtitleDraw | null; ass?: HTMLCanvasElement | null };

/** Whether any pixel of a canvas has been painted: an ASS renderer's canvas is transparent where there is no subtitle. */
export function hasInk(canvas: HTMLCanvasElement): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  const context = canvas.getContext("2d");
  if (!context) return false;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let at = 3; at < data.length; at += 4) if (data[at]! > 0) return true;
  return false;
}

/** Draws the subtitles and says whether any of them reached the picture. */
function drawSubtitles(context: CanvasRenderingContext2D, width: number, height: number, subtitles: SubtitleDraw): boolean {
  let drawn = false;
  if (subtitles.ass && hasInk(subtitles.ass)) {
    context.drawImage(subtitles.ass, 0, 0, subtitles.ass.width, subtitles.ass.height, 0, 0, width, height);
    drawn = true;
  }
  if (subtitles.text && drawTextSubtitles(context, width, height, subtitles.text) > 0) drawn = true;
  return drawn;
}

/** The canvas the flying comments are drawn on, and how much of the picture it covers from the top (the display area) and how opaque it is. */
export type DanmakuDraw = { canvas: HTMLCanvasElement; area: number; opacity: number };

/** The comments go where they are on screen: the canvas spans the picture's width and the top `area` of its height, whatever size the file is. */
function drawDanmaku(context: CanvasRenderingContext2D, width: number, height: number, danmaku: DanmakuDraw): void {
  if (danmaku.canvas.width <= 0 || danmaku.canvas.height <= 0) return;
  context.save();
  context.globalAlpha = Math.min(1, Math.max(0, danmaku.opacity));
  context.drawImage(danmaku.canvas, 0, 0, danmaku.canvas.width, danmaku.canvas.height, 0, 0, width, Math.round(height * danmaku.area));
  context.restore();
}

/** A frame taken from a video, and which of the things laid over it reached the picture. */
export type VideoCaptured = Captured & { subtitlesDrawn: boolean; danmakuDrawn: boolean };

/**
 * The current frame of a `video` element at the file's own size. `no-frame` when nothing has been decoded yet (the element has no size or no data),
 * which is the case the person is told about instead of being handed a black picture. The frame (and the comments over it) are taken at once; the
 * subtitles may be asked for afterwards, because an ASS renderer needs a moment to draw at the file's size, and are put on top.
 */
export async function captureVideoFrame(video: HTMLVideoElement, options: { subtitles?: SubtitleDraw | (() => Promise<SubtitleDraw | null>) | null; danmaku?: DanmakuDraw | null } = {}): Promise<VideoCaptured | { failure: CaptureFailure }> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  // readyState 2 is HAVE_CURRENT_DATA: a frame for the current position exists.
  if (width <= 0 || height <= 0 || video.readyState < 2) return { failure: "no-frame" };
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return { failure: "encode" };
  try {
    context.drawImage(video, 0, 0, width, height);
    let danmakuDrawn = false;
    if (options.danmaku) { drawDanmaku(context, width, height, options.danmaku); danmakuDrawn = true; }
    const wanted = typeof options.subtitles === "function" ? await options.subtitles().catch(() => null) : options.subtitles ?? null;
    const subtitlesDrawn = wanted ? drawSubtitles(context, width, height, wanted) : false;
    const blob = await toBlob(canvas);
    if (!blob) return { failure: "encode" };
    return { data: await blobToBase64(blob), width, height, subtitlesDrawn, danmakuDrawn };
  } catch {
    return { failure: "tainted" };
  }
}

/** A region of an image as fractions of the whole (the same coordinates a note's region source uses). */
export type Fractions = { x: number; y: number; width: number; height: number };

/** What a comic page is drawn as: a picture file's image, or a PDF page's canvas. */
export type PageDrawing = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

function sizeOf(source: PageDrawing): { width: number; height: number } {
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) return { width: source.naturalWidth, height: source.naturalHeight };
  return { width: source.width, height: source.height };
}

/** A page's own pixels, or a part of them. A page that has not decoded yet has no size. */
export async function captureImage(image: PageDrawing, region?: Fractions): Promise<Captured | { failure: CaptureFailure }> {
  const natural = sizeOf(image);
  if (natural.width <= 0 || natural.height <= 0) return { failure: "no-frame" };
  const sx = region ? Math.max(0, Math.round(region.x * natural.width)) : 0;
  const sy = region ? Math.max(0, Math.round(region.y * natural.height)) : 0;
  const sw = region ? Math.min(natural.width - sx, Math.max(1, Math.round(region.width * natural.width))) : natural.width;
  const sh = region ? Math.min(natural.height - sy, Math.max(1, Math.round(region.height * natural.height))) : natural.height;
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const context = canvas.getContext("2d");
  if (!context) return { failure: "encode" };
  try {
    context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await toBlob(canvas);
    if (!blob) return { failure: "encode" };
    return { data: await blobToBase64(blob), width: sw, height: sh };
  } catch {
    return { failure: "tainted" };
  }
}

/** Pages side by side in the order they are seen, drawn at their own sizes on one canvas as tall as the tallest. */
export async function captureSpread(pages: PageDrawing[]): Promise<Captured | { failure: CaptureFailure }> {
  const sizes = pages.map(sizeOf);
  if (sizes.length === 0 || sizes.some((size) => size.width <= 0 || size.height <= 0)) return { failure: "no-frame" };
  const height = Math.max(...sizes.map((size) => size.height));
  const width = sizes.reduce((sum, size) => sum + size.width, 0);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return { failure: "encode" };
  try {
    let left = 0;
    pages.forEach((page, index) => {
      context.drawImage(page, left, Math.round((height - sizes[index]!.height) / 2));
      left += sizes[index]!.width;
    });
    const blob = await toBlob(canvas);
    if (!blob) return { failure: "encode" };
    return { data: await blobToBase64(blob), width, height };
  } catch {
    return { failure: "tainted" };
  }
}
