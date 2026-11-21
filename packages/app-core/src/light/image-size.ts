/**
 * Width and height from the first bytes of an image, without decoding it (light open, A-128). The full library decodes every page once when it
 * imports a comic; light open shows the first page at once, so it only reads each page's header. Returns null when the header is not one of the
 * formats light open shows or is cut short; the reader then lays the page out as 2:3 until the image itself loads.
 */
export type ImageSize = { width: number; height: number };

/** How many bytes are enough for every format below in practice (JPEG markers before SOF can be long: EXIF thumbnails, ICC profiles). */
export const IMAGE_HEADER_BYTES = 256 * 1024;

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

function png(view: DataView, bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || ascii(bytes, 1, 3) !== "PNG" || ascii(bytes, 12, 4) !== "IHDR") return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gif(view: DataView, bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== "GIF") return null;
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function bmp(view: DataView, bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 26 || ascii(bytes, 0, 2) !== "BM") return null;
  const header = view.getUint32(14, true);
  if (header === 12) return { width: view.getUint16(18, true), height: view.getUint16(20, true) };
  return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
}

function exifOrientation(view: DataView, bytes: Uint8Array, start: number, end: number): number | null {
  if (start + 14 > end || ascii(bytes, start, 6) !== "Exif\0\0") return null;
  const tiff = start + 6;
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!little && !big) return null;
  if (view.getUint16(tiff + 2, little) !== 42) return null;
  const ifd0 = tiff + view.getUint32(tiff + 4, little);
  if (ifd0 < tiff || ifd0 + 2 > end) return null;
  const count = view.getUint16(ifd0, little);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > end) break;
    if (view.getUint16(entry, little) === 0x0112) {
      const type = view.getUint16(entry + 2, little);
      const values = view.getUint32(entry + 4, little);
      if (type === 3 && values >= 1) return view.getUint16(entry + 8, little);
      return null;
    }
  }
  return null;
}

function jpeg(view: DataView, bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  let orientation: number | null = null;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) { at += 1; continue; }
    // Standalone markers have no length; SOS (DA) and EOI (D9) end the headers.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = view.getUint16(at + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && orientation === null) {
      orientation = exifOrientation(view, bytes, at + 4, Math.min(at + 2 + length, bytes.length));
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      const height = view.getUint16(at + 5);
      const width = view.getUint16(at + 7);
      return orientation !== null && orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
    }
    at += 2 + length;
  }
  return null;
}

function webp(view: DataView, bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) };
  if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** AVIF (HEIF): the `ispe` property of the primary item, found by walking `meta` › `iprp` › `ipco`. */
function avif(view: DataView, bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return null;
  const brands = ascii(bytes, 8, Math.min(view.getUint32(0) - 8, 64));
  if (!/avi[fs]|mif1|heic/.test(brands)) return null;
  const walk = (start: number, end: number, path: string[]): ImageSize | null => {
    let at = start;
    while (at + 8 <= end) {
      const size = view.getUint32(at);
      const type = ascii(bytes, at + 4, 4);
      const boxEnd = size === 0 ? end : at + size;
      if (size !== 0 && size < 8) return null;
      if (type === "ispe" && boxEnd <= bytes.length && at + 20 <= bytes.length) return { width: view.getUint32(at + 12), height: view.getUint32(at + 16) };
      if (type === path[0]) {
        // `meta` is a full box: four bytes of version and flags before its children.
        const found = walk(at + 8 + (type === "meta" ? 4 : 0), Math.min(boxEnd, bytes.length), path.slice(1));
        if (found) return found;
      }
      at = boxEnd;
    }
    return null;
  };
  return walk(0, bytes.length, ["meta", "iprp", "ipco", "ispe"]);
}

export function imageSizeOf(input: Uint8Array): ImageSize | null {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  try {
    const size = png(view, input) ?? jpeg(view, input) ?? webp(view, input) ?? gif(view, input) ?? bmp(view, input) ?? avif(view, input);
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}
