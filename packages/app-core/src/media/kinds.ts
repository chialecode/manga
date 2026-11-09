import path from "node:path";

/** File kinds by extension, shared by the library scan and light open; no other module is pulled in with them. */
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".jpe", ".jfif", ".webp", ".gif", ".avif", ".bmp", ".tif", ".tiff"]);
/** Formats a Chromium `<img>` shows as is. Everything else is converted when displayed. */
export const BROWSER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"]);
export const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".m4v", ".mov", ".avi", ".webm", ".ts", ".m2ts", ".flv", ".wmv", ".ogv", ".mpg", ".mpeg"]);
export const ARCHIVE_EXTENSIONS = new Set([".cbz", ".zip"]);

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jpe": "image/jpeg", ".jfif": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
};

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function mediaTypeForName(name: string): string {
  return MEDIA_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Names the operating system and archive tools leave behind; they are never pages. */
export function isIgnoredName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  return /^(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(base) || base.startsWith("._") || (base.startsWith(".") && base !== ".") || name.split("/").some((segment) => segment === "__MACOSX");
}
