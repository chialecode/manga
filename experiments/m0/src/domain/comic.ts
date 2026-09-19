import { unzipSync, zipSync } from "fflate";
import { MangaError } from "@manga/contracts";

export const COMIC_DISPLAY_BUDGET = {
  maxBytes: 12 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxLongEdge: 8192,
};

export type ComicPage = {
  pageId: string;
  name: string;
  fingerprint: string;
  width?: number;
  height?: number;
  rotation?: number;
};

const PAGE_NAME = /\.(png|jpe?g|webp|gif)$/i;

export function listComicPages(bytes: Uint8Array, source: "cbz" | "dir", names?: string[]): ComicPage[] {
  const files = source === "cbz"
    ? Object.keys(unzipSync(bytes)).filter((name) => PAGE_NAME.test(name) && !name.endsWith("/"))
    : (names ?? []).filter((name) => PAGE_NAME.test(name));
  const sorted = [...files].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const seen = new Map<string, number>();
  return sorted.map((name, index) => {
    const fingerprint = `${source}:${name}:${index}`;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return {
      pageId: `page-${index + 1}`,
      name,
      fingerprint: count > 1 ? `${fingerprint}:dup${count}` : fingerprint,
    };
  });
}

export type ImageInspection = {
  name: string;
  bytes: number;
  width?: number;
  height?: number;
  rotation?: number;
  longForm: boolean;
  overBudget: boolean;
  reason?: string;
};

function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function inspectImage(name: string, bytes: Uint8Array, rotation = 0): ImageInspection {
  const size = pngSize(bytes);
  const width = size?.width;
  const height = size?.height;
  const pixels = width && height ? width * height : undefined;
  const longEdge = width && height ? Math.max(width, height) : undefined;
  const longForm = Boolean(width && height && height > width * 3);
  let overBudget = bytes.length > COMIC_DISPLAY_BUDGET.maxBytes;
  let reason: string | undefined;
  if (overBudget) reason = "bytes";
  if (pixels && pixels > COMIC_DISPLAY_BUDGET.maxPixels) {
    overBudget = true;
    reason = "pixels";
  }
  if (longEdge && longEdge > COMIC_DISPLAY_BUDGET.maxLongEdge) {
    overBudget = true;
    reason = "long-edge";
  }
  if (!size) {
    overBudget = true;
    reason = reason ?? "unreadable";
  }
  return { name, bytes: bytes.length, width, height, rotation, longForm, overBudget, reason };
}

export function buildCbz(files: Record<string, Uint8Array>): Uint8Array {
  for (const name of Object.keys(files)) {
    if (name.includes("..") || name.startsWith("/")) {
      throw new MangaError("PATH_ESCAPE", `illegal comic path ${name}`);
    }
  }
  return zipSync(files);
}
