// Byte-level writers for the synthetic M2 samples: ZIP (including deliberately hostile entries), image-only PDF,
// fixed-layout EPUB, bilevel PNG, WAV. They are independent of the product parsers so a bug in a reader cannot hide
// in the sample that is meant to exercise it.
import { crc32, createDeflate, deflateRawSync, constants } from "node:zlib";
import { once } from "node:events";

const DOS_TIME = 0x6000; // 12:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

/**
 * entries: { name, data?: Buffer, method?: 0|8, flags?: number, payload?: Buffer, crc?: number, size?: number }
 * `payload` + `size` + `crc` describe an entry whose stored bytes are supplied already compressed (a bomb).
 */
export function buildArchive(entries, { comment } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 8;
    const raw = entry.data ?? Buffer.alloc(0);
    const payload = entry.payload ?? (method === 8 ? deflateRawSync(raw) : raw);
    const size = entry.size ?? raw.length;
    const crc = entry.crc ?? crc32(raw);
    const flags = (entry.flags ?? 0) | 0x0800; // names are UTF-8
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const localBytes = Buffer.concat([local, name, payload]);
    locals.push(localBytes);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += localBytes.length;
  }
  const cdBytes = Buffer.concat(central);
  const tail = Buffer.from(comment ?? "", "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(tail.length, 20);
  return Buffer.concat([...locals, cdBytes, eocd, tail]);
}

/** A deflate stream of `total` zero bytes without allocating them at once, as a ready-to-store entry. */
export function zeroBombEntry(name, total) {
  const chunk = 64 * 1024 * 1024;
  const zeros = Buffer.alloc(Math.min(chunk, total));
  const parts = [];
  let crc = 0;
  let remaining = total;
  while (remaining > 0) {
    const part = remaining >= zeros.length ? zeros : zeros.subarray(0, remaining);
    // A sync-flushed block is byte aligned and not final, so blocks from separate calls concatenate into one stream.
    parts.push(deflateRawSync(part, { level: 9, finishFlush: constants.Z_SYNC_FLUSH }));
    crc = crc32(part, crc);
    remaining -= part.length;
  }
  parts.push(Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff]));
  return { name, method: 8, payload: Buffer.concat(parts), size: total, crc };
}

function pdfObject(number, body) {
  return Buffer.concat([Buffer.from(`${number} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from("\nendobj\n")]);
}

/** Image-only PDF: one DCT (JPEG) image per page, page size = image size in points. */
export function buildImagePdf(pages, { title = "Synthetic image PDF" } = {}) {
  const objects = [];
  const pageIds = [];
  const first = 3; // 1 catalog, 2 pages, 3.. per page: page, content, image
  pages.forEach((page, index) => {
    const base = first + index * 3;
    pageIds.push(base);
    const content = Buffer.from(`q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q`);
    objects.push(pdfObject(base, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Im0 ${base + 2} 0 R >> >> /Contents ${base + 1} 0 R >>`));
    objects.push(pdfObject(base + 1, Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")])));
    objects.push(pdfObject(base + 2, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`), page.jpeg, Buffer.from("\nendstream")])));
  });
  const infoId = first + pages.length * 3;
  const all = [
    pdfObject(1, "<< /Type /Catalog /Pages 2 0 R >>"),
    pdfObject(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`),
    ...objects,
    pdfObject(infoId, `<< /Title (${title}) >>`),
  ];
  const header = Buffer.from("%PDF-1.4\n");
  let cursor = header.length;
  const xref = ["xref\n", `0 ${all.length + 1}\n`, "0000000000 65535 f \n"];
  for (const object of all) {
    xref.push(`${String(cursor).padStart(10, "0")} 00000 n \n`);
    cursor += object.length;
  }
  const tail = Buffer.from(`${xref.join("")}trailer << /Size ${all.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${cursor}\n%%EOF\n`);
  return Buffer.concat([header, ...all, tail]);
}

const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Fixed-layout (pre-paginated) EPUB 3 whose spine is one image page per document, with an optional cover image item. */
export function buildImageEpub({ title, pages, cover, language = "en" }) {
  const entries = [
    { name: "mimetype", data: Buffer.from("application/epub+zip"), method: 0 },
    { name: "META-INF/container.xml", data: Buffer.from(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`) },
  ];
  const manifest = [];
  const spine = [];
  pages.forEach((page, index) => {
    const id = `p${String(index + 1).padStart(3, "0")}`;
    const ext = page.name.split(".").pop();
    const mime = IMAGE_MIME[ext] ?? "application/octet-stream";
    entries.push({ name: `OEBPS/images/${page.name}`, data: page.data, method: 0 });
    entries.push({
      name: `OEBPS/${id}.xhtml`,
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title} ${index + 1}</title><meta name="viewport" content="width=${page.width}, height=${page.height}"/></head><body style="margin:0"><img src="images/${page.name}" alt="" width="${page.width}" height="${page.height}"/></body></html>`),
    });
    manifest.push(`<item id="${id}-img" href="images/${page.name}" media-type="${mime}"/>`, `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
  });
  let coverMeta = "";
  if (cover) {
    const ext = cover.name.split(".").pop();
    entries.push({ name: `OEBPS/images/${cover.name}`, data: cover.data, method: 0 });
    manifest.push(`<item id="cover-image" href="images/${cover.name}" media-type="${IMAGE_MIME[ext]}" properties="cover-image"/>`);
    coverMeta = `<meta name="cover" content="cover-image"/>`;
  }
  manifest.push(`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  entries.push({ name: "OEBPS/nav.xhtml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body><nav epub:type="toc"><ol>${pages.map((_, index) => `<li><a href="p${String(index + 1).padStart(3, "0")}.xhtml">Page ${index + 1}</a></li>`).join("")}</ol></nav></body></html>`) });
  entries.push({
    name: "OEBPS/content.opf",
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:manga-sample:${title.replaceAll(/\W+/g, "-").toLowerCase()}</dc:identifier><dc:title>${title}</dc:title><dc:language>${language}</dc:language><meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta>${coverMeta}</metadata><manifest>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`),
  });
  return buildArchive(entries);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * 1-bit grayscale PNG streamed row by row, for sizes whose raw raster would not fit in memory as decoded RGBA.
 * rowAt(y) returns a Buffer of ceil(width/8) packed bytes.
 */
export async function writeBilevelPng(width, height, rowAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  const deflate = createDeflate({ level: 9 });
  const compressed = [];
  deflate.on("data", (chunk) => compressed.push(chunk));
  const finished = once(deflate, "end");
  const stride = Math.ceil(width / 8);
  let previous;
  for (let y = 0; y < height; y += 1) {
    const row = rowAt(y);
    if (row.length !== stride) throw new Error(`row ${y} has ${row.length} bytes, expected ${stride}`);
    const line = Buffer.concat([Buffer.from([0]), row]);
    if (!deflate.write(line)) await once(deflate, "drain");
    previous = row;
  }
  void previous;
  deflate.end();
  await finished;
  const idat = Buffer.concat(compressed);
  const chunks = [];
  for (let offset = 0; offset < idat.length; offset += 1 << 20) chunks.push(pngChunk("IDAT", idat.subarray(offset, offset + (1 << 20))));
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), ...chunks, pngChunk("IEND", Buffer.alloc(0))]);
}

/** 16-bit mono PCM WAV from Int16Array samples. */
export function buildWav(samples, sampleRate = 16000) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Read the PCM samples of a 16-bit mono WAV written by SAPI or ffmpeg (skips any extra chunks). */
export function readWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let offset = 12;
  let rate = 16000;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") rate = buffer.readUInt32LE(offset + 12);
    if (id === "data") {
      const end = Math.min(buffer.length, offset + 8 + size);
      const bytes = buffer.subarray(offset + 8, end - ((end - offset - 8) % 2));
      const aligned = Buffer.from(bytes);
      return { rate, samples: new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}
