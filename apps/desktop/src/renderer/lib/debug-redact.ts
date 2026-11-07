/**
 * What the debug panel copies (A-48): credentials never leave it, and an image is described by its size and a short hash, not its
 * bytes. The main process already removes credentials and local paths from what it reports; this is the second pass over
 * everything the window adds itself (the live position, the picked tags, the notices) and over the whole copied document.
 */
const SECRET_KEY = /(secret|token|password|passwd|authorization|api[-_]?key|credential|cookie|bearer)/i;
const IMAGE_KEY = /^(preview|base64|bytes|data|dataUrl|imageData)$/i;
const HIDDEN = "[已隐去]";

/** A short, stable hash (FNV-1a, 32 bits). Enough to tell two pictures apart in a debug listing; it is not a security measure. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const isDataUrl = (value: unknown): boolean => typeof value === "string" && /^data:[^,]{0,80},/.test(value);
const looksLikeBase64 = (value: string) => value.length > 512 && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 256));
const secretText = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*)/g;

export function redactForDebug<T>(value: T, depth = 0): T {
  if (depth > 12) return HIDDEN as unknown as T;
  if (typeof value === "string") {
    if (isDataUrl(value)) return `[图像 ${value.length} 字符 #${shortHash(value)}]` as unknown as T;
    if (looksLikeBase64(value)) return `[二进制 ${value.length} 字符 #${shortHash(value)}]` as unknown as T;
    return value.replace(secretText, HIDDEN) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => redactForDebug(item, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (SECRET_KEY.test(key) && item !== null && item !== undefined && item !== false) { out[key] = HIDDEN; continue; }
      if (IMAGE_KEY.test(key)) {
        // Bytes of a picture or a recording: only their size and a short hash are kept.
        if (typeof item === "string" && (isDataUrl(item) || looksLikeBase64(item) || item.length > 512)) { out[key] = `[二进制 ${item.length} 字符 #${shortHash(item)}]`; continue; }
        if ((item instanceof Uint8Array || Array.isArray(item)) && (item as ArrayLike<unknown>).length > 64 && typeof (item as ArrayLike<unknown>)[0] === "number") {
          const list = item as ArrayLike<number>;
          out[key] = `[二进制 ${list.length} 字节 #${shortHash(Array.prototype.slice.call(list, 0, 256).join(","))}]`;
          continue;
        }
      }
      out[key] = redactForDebug(item, depth + 1);
    }
    return out as T;
  }
  return value;
}
