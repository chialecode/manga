import { deflateRawSync, inflateRawSync } from "node:zlib";
import { MangaError, NORMALIZATION_V1, PARSER_CANDIDATES } from "@manga/contracts";
import { codePointLength, normalizeText, sliceCodePoints } from "./text.ts";
import type { PdfPageRender, PdfRenderItem } from "./page-render.ts";

/** One PDF.js text item mapped onto the part's normalized text. `offset` is a code-point index and is omitted when normalization would merge across items. */
export type PdfTextRun = { text: string; x: number; y: number; width?: number; offset?: number };

export type ParsedPart = {
  id: string;
  title?: string;
  normalized: string;
  kind: "text" | "scan" | "image";
  parserVersion: string;
  /** Names of assets this part displays, in reading order. */
  images?: string[];
  /** Where each illustration sits in the normalized text, plus any declared box. */
  placements?: Array<{ assetId: string; offset: number; width?: number; height?: number }>;
  /** Absolute position of the part in the source document (page number, spine index). */
  index?: number;
  /** Raw markup retained for fixed-layout pages so the renderer can show the actual page. */
  sourceHref?: string;
  /** EPUB fixed-layout page model. PDF pages are drawn by PDF.js and do not store this list. */
  render?: PdfPageRender;
  /** PDF.js text items in content order, aligned with `normalized` when `offset` is present. */
  textRuns?: PdfTextRun[];
};

export type ParsedAsset = {
  id: string;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  partId: string;
};

export type ParsedDocument = {
  format: "txt" | "epub" | "mobi" | "pdf";
  title: string;
  parserId: string;
  parts: ParsedPart[];
  toc: Array<{ label: string; partId: string }>;
  traits: Record<string, unknown>;
  warnings: string[];
  assets?: ParsedAsset[];
  /** Author stylesheets kept with the book. They are not applied to the text layer. */
  stylesheets?: Array<{ href: string; text: string }>;
  /** Presentation properties derived from the author CSS; the reader applies them as defaults. */
  authorStyle?: AuthorStyle;
};

/** The subset of author CSS the reader applies: page-level colours and type, never layout-affecting hacks. */
export type AuthorStyle = {
  fontFamily?: string;
  color?: string;
  background?: string;
  lineHeight?: number;
  textAlign?: string;
  sources: string[];
};

const ZIP_ENTRY = 40 * 1024 * 1024;
const ZIP_TOTAL = 40 * 1024 * 1024;
const ZIP_COUNT = 4096;
const ZIP_RATIO = 100;

function latin(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return out;
}

function assertSafePath(name: string): void {
  const normalized = name.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new MangaError("PATH_ESCAPE", `illegal archive path ${name}`);
  }
}

/** Resolve a relative archive reference without letting `..` leave the archive root. */
export function resolveArchiveReference(directory: string, reference: string): string | undefined {
  const clean = decodeURIComponent((reference.split("#")[0] ?? "").trim()).replaceAll("\\", "/");
  if (!clean || /^(https?:|data:|mailto:)/i.test(clean)) return undefined;
  const combined = clean.startsWith("/") ? clean.slice(1) : `${directory.replaceAll("\\", "/")}${clean}`;
  const segments: string[] = [];
  for (const segment of combined.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function readZip(bytes: Uint8Array, limits = { maxEntry: ZIP_ENTRY, maxTotal: ZIP_TOTAL, maxEntries: ZIP_COUNT, maxRatio: ZIP_RATIO }): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new MangaError("UNSUPPORTED_FORMAT", "invalid zip");
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  if (count > limits.maxEntries) throw new MangaError("UNSUPPORTED_FORMAT", "zip entry budget exceeded");
  const listed: Array<{ name: string; method: number; compSize: number; uncompSize: number; localOffset: number }> = [];
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) throw new MangaError("UNSUPPORTED_FORMAT", "invalid zip directory");
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    if (name.endsWith("/")) {
      pos += 46 + nameLen + extraLen + commentLen;
      continue;
    }
    assertSafePath(name);
    if (uncompSize > limits.maxEntry || compSize === 0xffffffff) throw new MangaError("UNSUPPORTED_FORMAT", `zip entry too large: ${name}`);
    if (compSize > 0 && uncompSize / compSize > limits.maxRatio) throw new MangaError("UNSUPPORTED_FORMAT", `zip compression ratio rejected: ${name}`);
    listed.push({ name, method, compSize, uncompSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of listed) {
    if (entry.localOffset + 30 > bytes.length || view.getUint32(entry.localOffset, true) !== 0x04034b50) {
      throw new MangaError("UNSUPPORTED_FORMAT", "invalid zip local header");
    }
    const nameLen = view.getUint16(entry.localOffset + 26, true);
    const extraLen = view.getUint16(entry.localOffset + 28, true);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const compressed = bytes.subarray(dataStart, dataStart + entry.compSize);
    let data: Uint8Array;
    if (entry.method === 0) data = compressed;
    else if (entry.method === 8) {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: Math.min(limits.maxEntry, Math.max(1, limits.maxTotal - total)) });
      } catch (error) {
        throw new MangaError("UNSUPPORTED_FORMAT", "zip expansion failed or exceeded budget", { cause: error });
      }
    }
    else throw new MangaError("UNSUPPORTED_FORMAT", `unsupported zip method ${entry.method}`);
    if (data.length > limits.maxEntry) throw new MangaError("UNSUPPORTED_FORMAT", `zip entry expanded past budget: ${entry.name}`);
    total += data.length;
    if (total > limits.maxTotal) throw new MangaError("UNSUPPORTED_FORMAT", "zip expansion budget exceeded");
    files.set(entry.name.replaceAll("\\", "/"), data);
  }
  return files;
}

export function buildZip(files: Array<{ name: string; data: Uint8Array; method?: 0 | 8 }>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    assertSafePath(file.name);
    const name = Buffer.from(file.name);
    const method = file.method ?? 0;
    const raw = Buffer.from(file.data);
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localHeader = Buffer.concat([local, name, payload]);
    locals.push(localHeader);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += localHeader.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cdBuf, eocd]));
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (token, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return "\"";
    if (entity === "apos") return "'";
    const point = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(point) ? String.fromCodePoint(point) : token;
  });
}

export function htmlToText(html: string): { text: string; images: number; externalHrefs: string[] } {
  const without = html
    // Document head text is not body content; keeping it would leak titles into the reading text.
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<\?xml[^>]*\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const images = without.match(/<img\b/gi)?.length ?? 0;
  const externalHrefs = [...without.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1] ?? "")
    .filter((href) => /^https?:/i.test(href));
  const text = decodeEntities(without
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|tr|blockquote|section)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, images, externalHrefs };
}

/** Inline image sources in document order, so a chapter can list the illustrations it actually shows. */
export function htmlImageSources(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1] ?? "").filter(Boolean);
}

/** Code-point offset of each inline image in the extracted text, plus a declared box when the markup has one. */
export function htmlImagePlacements(html: string): Array<{ src: string; offset: number; width?: number; height?: number }> {
  const placements: Array<{ src: string; offset: number; width?: number; height?: number }> = [];
  let cursor = 0;
  let consumed = 0;
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const at = match.index ?? 0;
    consumed += [...htmlToText(html.slice(cursor, at)).text].length;
    cursor = at + match[0].length;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[0])?.[1] ?? "";
    if (!src) continue;
    const width = Number(/\bwidth\s*=\s*["'](\d+(?:\.\d+)?)/i.exec(match[0])?.[1] ?? "");
    const height = Number(/\bheight\s*=\s*["'](\d+(?:\.\d+)?)/i.exec(match[0])?.[1] ?? "");
    placements.push({
      src,
      offset: consumed,
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
    });
  }
  return placements;
}

/** SVG image hrefs, used by fixed-layout pages that embed the page as a vector. */
export function htmlSvgImageHrefs(html: string): string[] {
  return [...html.matchAll(/<image\b[^>]*\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1] ?? "").filter(Boolean);
}

function tags(xml: string, name: string): Array<Record<string, string>> {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((match) => Object.fromEntries(
    [...match[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map((item) => [item[1] ?? "", item[3] ?? ""]),
  ));
}

const AUTHOR_STYLE_BUDGET = 256 * 1024;

/** Declared CSS properties of one rule body, so an author style can actually be applied by the reader. */
function cssDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of body.split(";")) {
    const at = declaration.indexOf(":");
    if (at <= 0) continue;
    const property = declaration.slice(0, at).trim().toLowerCase();
    const value = declaration.slice(at + 1).trim();
    if (!property || !value || value.includes("expression") || /url\s*\(/i.test(value)) continue;
    out[property] = value;
  }
  return out;
}

function cssColorValue(value: string): string | undefined {
  const clean = value.trim();
  if (/^#[0-9A-Fa-f]{3,8}$/.test(clean) || /^rgba?\(/i.test(clean) || /^[a-zA-Z]+$/.test(clean)) return clean;
  return undefined;
}

/**
 * Derive the reader-applied subset of the book's author CSS: `body` rules provide the page defaults and
 * `p` rules refine the type. Bounded input, no url() values, and the raw CSS stays stored as before.
 */
export function deriveEpubAuthorStyle(stylesheets: Array<{ href: string; text: string }> | undefined): AuthorStyle | undefined {
  if (!stylesheets?.length) return undefined;
  const style: AuthorStyle = { sources: [] };
  let found = false;
  for (const sheet of stylesheets) {
    if (style.sources.length > 8) break;
    const css = sheet.text.length > AUTHOR_STYLE_BUDGET ? "" : sheet.text.replace(/\/\*[\s\S]*?\*\//g, "");
    if (!css) continue;
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? "").trim().toLowerCase();
      const declarations = cssDeclarations(match[2] ?? "");
      const bodyLevel = /(^|,)\s*body\b/.test(selector);
      const paragraphLevel = /(^|,)\s*p\b/.test(selector) && !/[\w.#]/.test(selector.replace(/(^|,)\s*p\b/g, ""));
      if (!bodyLevel && !paragraphLevel) continue;
      const apply = (entries: Array<[string, string | number | undefined]>) => {
        for (const [key, value] of entries) {
          if (value === undefined) continue;
          (style as Record<string, unknown>)[key] = value;
          found = true;
        }
      };
      apply([
        ["fontFamily", declarations["font-family"]],
        ["color", declarations.color ? cssColorValue(declarations.color) : undefined],
        ["background", (declarations.background ?? declarations["background-color"]) ? cssColorValue(declarations.background ?? declarations["background-color"]!) : undefined],
        ["lineHeight", declarations["line-height"] && /^\d+(?:\.\d+)?$/.test(declarations["line-height"]) ? Number(declarations["line-height"]) : undefined],
        ["textAlign", declarations["text-align"] && /^(left|right|center|justify)$/.test(declarations["text-align"]) ? declarations["text-align"] : undefined],
      ]);
      if (Object.keys(declarations).length) style.sources.push(sheet.href);
    }
  }
  if (!found) return undefined;
  return style;
}

type FixedBox = { x?: number; y?: number; w?: number; h?: number };
const numberAttr = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

/** Attrs of one SVG element as a lowercase map. */
function svgAttrs(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g)].map((match) => [
    (match[1] ?? match[3] ?? "").toLowerCase(),
    match[2] ?? match[4] ?? "",
  ]));
}

/**
 * Page model of a pre-paginated spine document: the declared page box plus the positioned images,
 * shapes and SVG text it shows, so a fixed page renders from the author's layout instead of only
 * listing an illustration.
 */
export function epubFixedRender(
  html: string,
  resolveAsset: (reference: string) => ParsedAsset | undefined,
): PdfPageRender | undefined {
  if (html.length > 2 * 1024 * 1024) return undefined;
  const items: PdfRenderItem[] = [];
  let width: number | undefined;
  let height: number | undefined;
  const viewport = /<meta[^>]*name\s*=\s*["']viewport["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html)?.[1] ?? "";
  width = numberAttr(/(?:^|,)\s*width\s*=\s*(\d+(?:\.\d+)?)/i.exec(viewport)?.[1] ?? "");
  height = numberAttr(/(?:^|,)\s*height\s*=\s*(\d+(?:\.\d+)?)/i.exec(viewport)?.[1] ?? "");
  const svg = /<svg\b[^>]*>/i.exec(html)?.[0] ?? "";
  if (svg) {
    const attrs = svgAttrs(svg);
    const viewBox = (attrs["viewbox"] ?? "").trim().split(/[\s,]+/).map(Number);
    if (viewBox.length === 4 && viewBox.every((num) => Number.isFinite(num))) {
      width = width ?? viewBox[2];
      height = height ?? viewBox[3];
    }
    width = width ?? numberAttr(parseFloat(attrs.width || "").toString());
    height = height ?? numberAttr(parseFloat(attrs.height || "").toString());
  }
  let cursor = 0;
  const addItem = (item: PdfRenderItem) => {
    if (items.length >= 600) { cursor = html.length; return; }
    items.push(item);
  };
  for (const match of html.matchAll(/<(image|rect|circle|ellipse|line|text)\b[^>]*>/gi)) {
    cursor = match.index + match[0].length;
    const tag = match[1]!.toLowerCase();
    const attrs = svgAttrs(match[0]);
    if (tag === "image") {
      const reference = attrs["xlink:href"] ?? attrs.href ?? "";
      const asset = reference ? resolveAsset(reference.split("#")[0] ?? "") : undefined;
      const x = numberAttr(attrs.x) ?? 0;
      const y = numberAttr(attrs.y) ?? 0;
      const w = numberAttr(attrs.width) ?? 0;
      const h = numberAttr(attrs.height) ?? 0;
      if (!asset || w <= 0 || h <= 0) continue;
      addItem({ k: "i", x, y, w, h, a: asset.id });
      width = width ?? x + w;
      height = height ?? y + h;
      continue;
    }
    if (tag === "rect") {
      const w = numberAttr(attrs.width) ?? 0;
      const h = numberAttr(attrs.height) ?? 0;
      if (w <= 0 || h <= 0) continue;
      addItem({ k: "r", x: numberAttr(attrs.x) ?? 0, y: numberAttr(attrs.y) ?? 0, w, h, c: attrs.fill && attrs.fill !== "none" ? attrs.fill : "none" });
      width = width ?? (numberAttr(attrs.x) ?? 0) + w;
      height = height ?? (numberAttr(attrs.y) ?? 0) + h;
      continue;
    }
    if (tag === "circle" || tag === "ellipse") {
      const cx = numberAttr(attrs.cx) ?? 0;
      const cy = numberAttr(attrs.cy) ?? 0;
      const rx = tag === "circle" ? numberAttr(attrs.r) ?? 0 : numberAttr(attrs.rx) ?? 0;
      const ry = tag === "circle" ? numberAttr(attrs.r) ?? 0 : numberAttr(attrs.ry) ?? 0;
      if (rx <= 0 || ry <= 0) continue;
      // The ellipse keeps its real geometry; a bounding-box rectangle would distort the author's page.
      addItem({ k: "e", x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2, c: attrs.fill && attrs.fill !== "none" ? attrs.fill : "none" });
      width = width ?? cx + rx;
      height = height ?? cy + ry;
      continue;
    }
    if (tag === "line") {
      addItem({ k: "l", p: [numberAttr(attrs.x1) ?? 0, numberAttr(attrs.y1) ?? 0, numberAttr(attrs.x2) ?? 0, numberAttr(attrs.y2) ?? 0], c: attrs.stroke ?? "#000000", w: numberAttr(attrs["stroke-width"]) ?? 1 });
      continue;
    }
    if (tag === "text") {
      // SVG text is presentation-only: it is not part of the reflowable text layer, so it carries no offset.
      const end = html.indexOf("</text>", cursor);
      if (end < 0) continue;
      const content = decodeEntities(html.slice(cursor, end).replace(/<[^>]+>/g, "")).trim();
      cursor = end;
      if (!content) continue;
      addItem({ k: "t", x: numberAttr(attrs.x) ?? 0, y: numberAttr(attrs.y) ?? 0, s: numberAttr(attrs["font-size"]) ?? 12, f: /serif/i.test(attrs["font-family"] ?? "") ? "serif" : "sans", t: content });
      continue;
    }
  }
  if (!items.length) return undefined;
  // Without a declared page box, the extent of the content stands in for it.
  let maxX = width ?? 0;
  let maxY = height ?? 0;
  for (const item of items) {
    if (item.k === "t") { maxX = Math.max(maxX, item.x + item.s * [...item.t].length); maxY = Math.max(maxY, item.y + item.s); continue; }
    if (item.k === "l") {
      for (let index = 0; index + 1 < item.p.length; index += 2) { maxX = Math.max(maxX, item.p[index]!); maxY = Math.max(maxY, item.p[index + 1]!); }
      continue;
    }
    maxX = Math.max(maxX, item.x + item.w);
    maxY = Math.max(maxY, item.y + item.h);
  }
  return { w: width ?? (maxX || 600), h: height ?? (maxY || 800), items };
}

export function parseEpubBytes(bytes: Uint8Array): ParsedDocument {
  const parserId = PARSER_CANDIDATES.find((item) => item.format === "epub")!.id;
  let files: Map<string, Uint8Array>;
  try {
    files = readZip(bytes);
  } catch (error) {
    if (error instanceof MangaError) throw error;
    throw new MangaError("UNSUPPORTED_FORMAT", "invalid epub zip", { cause: error });
  }
  if ([...files.keys()].some((name) => name.toLowerCase() === "meta-inf/encryption.xml")) {
    throw new MangaError("UNSUPPORTED_FORMAT", "encrypted epub rejected");
  }
  const container = files.get("META-INF/container.xml");
  if (!container) throw new MangaError("UNSUPPORTED_FORMAT", "missing container.xml");
  const opfHref = tags(latin(container), "rootfile")[0]?.["full-path"];
  if (!opfHref) throw new MangaError("UNSUPPORTED_FORMAT", "missing opf path");
  assertSafePath(opfHref);
  const opfBytes = files.get(opfHref);
  if (!opfBytes) throw new MangaError("UNSUPPORTED_FORMAT", "opf missing from archive");
  const opf = new TextDecoder().decode(opfBytes);
  const title = /<dc:title[^>]*>([^<]*)<\/dc:title>/.exec(opf)?.[1]?.trim() || "untitled";
  const manifest = tags(opf, "item").map((item) => ({
    id: item.id ?? "",
    href: item.href ?? "",
    mediaType: item["media-type"] ?? "",
    properties: item.properties ?? "",
  }));
  if (manifest.some((item) => !item.id || !item.href || !item.mediaType)) throw new MangaError("UNSUPPORTED_FORMAT", "invalid EPUB manifest");
  const spine = tags(opf, "itemref").map((item) => item.idref ?? "").filter(Boolean);
  const base = opfHref.includes("/") ? opfHref.slice(0, opfHref.lastIndexOf("/") + 1) : "";
  const fixedLayout = /property\s*=\s*["']rendition:layout["'][^>]*>\s*pre-paginated/i.test(opf) || /content\s*=\s*["']pre-paginated["']/i.test(opf);
  const assets: ParsedAsset[] = [];
  const assetsByName = new Map<string, ParsedAsset>();
  const imageItems = new Map<string, { href: string; mediaType: string }>();
  for (const item of manifest) {
    if (!item.mediaType.startsWith("image/")) continue;
    imageItems.set(item.href.replace(/^\.\//, ""), { href: item.href, mediaType: item.mediaType });
  }
  /** Resolve an image reference relative to the part that shows it, and store the bytes for the reader. */
  const assetFor = (reference: string, partId: string, partHref: string): ParsedAsset | undefined => {
    if (!reference || /^(https?:|data:|mailto:|#)/i.test(reference)) return undefined;
    const partDir = partHref.includes("/") ? partHref.slice(0, partHref.lastIndexOf("/") + 1) : "";
    const candidates = [resolveArchiveReference(partDir, reference), resolveArchiveReference(base, reference), resolveArchiveReference("", reference)].filter((name): name is string => Boolean(name));
    let resolved: string | undefined;
    let declared: { href: string; mediaType: string } | undefined;
    for (const candidate of candidates) {
      if (files.has(candidate)) { resolved = candidate; declared = imageItems.get(candidate); break; }
      // A manifest href is relative to the OPF directory, so compare against that archive path too.
      const fromManifest = imageItems.get(candidate);
      if (fromManifest) {
        const archivePath = resolveArchiveReference(base, fromManifest.href);
        if (archivePath && files.has(archivePath)) { resolved = archivePath; declared = fromManifest; break; }
      }
      for (const [href, item] of imageItems) {
        const archivePath = resolveArchiveReference(base, href);
        if (!archivePath || !files.has(archivePath)) continue;
        if (href === candidate || archivePath === candidate || archivePath.endsWith(`/${candidate}`)) {
          resolved = archivePath;
          declared = item;
          break;
        }
      }
      if (resolved) break;
    }
    if (!resolved) return undefined;
    try { assertSafePath(resolved); } catch { return undefined; }
    const data = files.get(resolved);
    if (!data) return undefined;
    const existing = assetsByName.get(resolved);
    if (existing) {
      if (!existing.partId.includes(partId)) existing.partId = `${existing.partId},${partId}`;
      return existing;
    }
    const asset: ParsedAsset = {
      id: resolved.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 120) || `asset_${assets.length + 1}`,
      name: resolved.split("/").pop() ?? resolved,
      mediaType: declared?.mediaType ?? guessMediaType(resolved),
      bytes: data,
      partId,
    };
    assetsByName.set(resolved, asset);
    assets.push(asset);
    return asset;
  };
  const parts: ParsedPart[] = [];
  let images = 0;
  let vectorOnlyPages = 0;
  const externalHrefs: string[] = [];
  let styles = 0;
  for (const [spineIndex, id] of spine.entries()) {
    const item = manifest.find((entry) => entry.id === id);
    if (!item || !item.mediaType.includes("html")) throw new MangaError("UNSUPPORTED_FORMAT", "unsupported or missing spine item");
    const href = `${base}${decodeURIComponent(item.href)}`.replace(/^\.\//, "");
    assertSafePath(href);
    const file = files.get(href);
    if (!file) throw new MangaError("UNSUPPORTED_FORMAT", "missing spine document");
    const html = new TextDecoder().decode(file);
    const extracted = htmlToText(html);
    images += extracted.images;
    externalHrefs.push(...extracted.externalHrefs);
    const references = [...htmlImageSources(html), ...htmlSvgImageHrefs(html)];
    const placed = htmlImagePlacements(html);
    const partAssets: string[] = [];
    const placements: NonNullable<ParsedPart["placements"]> = [];
    for (const reference of references) {
      const asset = assetFor(reference, id, href);
      if (!asset) continue;
      partAssets.push(asset.id);
      const box = placed.find((item) => item.src === reference);
      const svg = html.match(new RegExp(`<(?:svg|image)\\b[^>]*(?:${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})[^>]*>`, "i"))?.[0] ?? "";
      const width = box?.width ?? Number(/\bwidth\s*=\s*["'](\d+(?:\.\d+)?)/i.exec(svg)?.[1] ?? "");
      const height = box?.height ?? Number(/\bheight\s*=\s*["'](\d+(?:\.\d+)?)/i.exec(svg)?.[1] ?? "");
      placements.push({
        assetId: asset.id,
        offset: box?.offset ?? [...normalizeText(extracted.text).normalized].length,
        ...(Number.isFinite(width) && width > 0 ? { width } : {}),
        ...(Number.isFinite(height) && height > 0 ? { height } : {}),
      });
    }
    const normalized = normalizeText(extracted.text);
    // A fixed-layout page keeps its illustration even when it carries no text layer.
    const isFixedPage = fixedLayout && references.length > 0;
    // A pre-paginated page drawn only with vector markup has no image record we can show verbatim.
    const vectorOnly = fixedLayout && !references.length && /<svg\b/i.test(html) && !extracted.text;
    if (vectorOnly) vectorOnlyPages += 1;
    // Fixed pages render from the author's layout: positioned images, shapes and SVG text.
    const fixedRender = fixedLayout ? epubFixedRender(html, (reference) => assetFor(reference, id, href)) : undefined;
    parts.push({
      id,
      title: extracted.text.split("\n")[0]?.slice(0, 80) || item.href,
      normalized: normalized.normalized,
      kind: (isFixedPage && !extracted.text) || vectorOnly ? "image" : "text",
      parserVersion: normalized.parserVersion,
      images: partAssets,
      placements,
      index: spineIndex,
      sourceHref: href,
      ...(fixedRender ? { render: fixedRender } : {}),
    });
  }
  if (!parts.length) throw new MangaError("UNSUPPORTED_FORMAT", "EPUB has no readable spine");
  const stylesheets: NonNullable<ParsedDocument["stylesheets"]> = [];
  const droppedStyles: string[] = [];
  for (const item of manifest) {
    if (!item.mediaType.includes("css")) continue;
    const href = resolveArchiveReference(base, item.href);
    const data = href ? files.get(href) : undefined;
    if (!href || !data) { droppedStyles.push(item.href || item.id); continue; }
    if (data.byteLength > 256 * 1024) { droppedStyles.push(item.href || item.id); continue; }
    stylesheets.push({ href, text: new TextDecoder().decode(data) });
  }
  styles = stylesheets.length;
  const authorStyle = deriveEpubAuthorStyle(stylesheets);
  const declaredImages = manifest.filter((item) => item.mediaType.startsWith("image/")).length;
  const toc: ParsedDocument["toc"] = [];
  const nav = manifest.find((item) => item.properties.split(/\s+/).includes("nav"));
  const ncx = manifest.find((item) => item.mediaType === "application/x-dtbncx+xml");
  const tocItem = nav ?? ncx;
  if (tocItem) {
    const href = `${base}${tocItem.href}`.replace(/^\.\//, "");
    assertSafePath(href);
    const data = files.get(href);
    if (!data) throw new MangaError("UNSUPPORTED_FORMAT", "missing navigation document");
    const html = new TextDecoder().decode(data);
    if (nav) {
      for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const target = (match[1] ?? "").split("#")[0] ?? "";
        const part = parts.find((item) => item.id && target.endsWith(`${manifest.find((entry) => entry.id === item.id)?.href}`))
          ?? parts.find((item) => target.includes(item.id));
        if (part) toc.push({ label: htmlToText(match[2] ?? "").text || part.id, partId: part.id });
      }
    } else {
      for (const match of html.matchAll(/<text[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*src\s*=\s*["']([^"']+)["']/gi)) {
        const target = match[2] ?? "";
        const part = parts.find((item) => target.includes(item.id)) ?? parts[0];
        if (part) toc.push({ label: htmlToText(match[1] ?? "").text || part.id, partId: part.id });
      }
    }
  }
  return {
    format: "epub",
    title,
    parserId,
    parts,
    toc,
    assets,
    traits: {
      chapters: parts.length,
      images,
      declaredImages,
      storedAssets: assets.length,
      styles,
      retainedStyles: stylesheets.length,
      fixedLayout,
      fixedPagesRendered: parts.filter((part) => part.render).length,
      vectorOnlyPages,
      authorStyleApplied: Boolean(authorStyle),
      externalHrefs,
      normalization: NORMALIZATION_V1,
      candidate: true,
      accepted: false,
    },
    stylesheets,
    ...(authorStyle ? { authorStyle } : {}),
    warnings: [
      ...(externalHrefs.length ? ["external links were recorded and not fetched"] : []),
      ...(stylesheets.length ? ["author page styles are applied as reading defaults; the text layer itself stays unchanged"] : []),
      ...(droppedStyles.length ? [`stylesheets that could not be retained: ${droppedStyles.join(", ")}`] : []),
      ...(fixedLayout ? ["fixed-layout pages render from their stored layout model with the declared page box"] : []),
      ...(vectorOnlyPages ? [`${vectorOnlyPages} fixed-layout pages are vector-only and show their stored vector model`] : []),
    ],
  };
}

function guessMediaType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "application/octet-stream";
}

export function buildEpubFixture(input: {
  title: string;
  chapters: Array<{ id: string; title: string; html: string; svgPage?: string; svgBody?: string }>;
  extra?: Record<string, Uint8Array>;
  fixedLayout?: boolean;
  encrypt?: boolean;
}): Uint8Array {
  const files: Array<{ name: string; data: Uint8Array; method?: 0 | 8 }> = [];
  files.push({ name: "mimetype", data: new TextEncoder().encode("application/epub+zip"), method: 0 });
  files.push({
    name: "META-INF/container.xml",
    data: new TextEncoder().encode(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
  });
  if (input.encrypt) {
    files.push({ name: "META-INF/encryption.xml", data: new TextEncoder().encode(`<encryption><EncryptedData/></encryption>`) });
  }
  const manifest = input.chapters.map((chapter) => `<item id="${chapter.id}" href="${chapter.id}.xhtml" media-type="application/xhtml+xml"/>`).join("")
    + `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/><item id="pic" href="pic.png" media-type="image/png"/><item id="plate" href="plate.png" media-type="image/png"/>`;
  const spine = input.chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`).join("");
  const layout = input.fixedLayout ? `<meta property="rendition:layout">pre-paginated</meta>` : "";
  files.push({
    name: "OEBPS/content.opf",
    data: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${input.title}</dc:title><dc:language>zh</dc:language>${layout}</metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`),
  });
  files.push({
    name: "OEBPS/nav.xhtml",
    data: new TextEncoder().encode(`<html xmlns="http://www.w3.org/1999/xhtml"><body><nav>${input.chapters.map((chapter) => `<a href="${chapter.id}.xhtml">${chapter.title}</a>`).join("")}</nav></body></html>`),
  });
  files.push({ name: "OEBPS/style.css", data: new TextEncoder().encode("p{color:SECRETSTYLE}") });
  files.push({ name: "OEBPS/pic.png", data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]) });
  files.push({ name: "OEBPS/plate.png", data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]) });
  for (const chapter of input.chapters) {
    // A fixed-layout chapter whose spine document is the SVG page itself: either an image page
    // (`svgPage`) or a raw vector body (`svgBody`) with shapes and text but no image record.
    const body = chapter.svgPage
      ? `<svg viewBox="0 0 600 800"><image xlink:href="${chapter.svgPage}" width="600" height="800"/></svg>`
      : chapter.svgBody
        ? `<svg viewBox="0 0 400 600">${chapter.svgBody}</svg>`
        : `<h1>${chapter.title}</h1>${chapter.html}<img alt="插图" src="pic.png"/><a href="https://example.invalid/out">外链</a><script>alert(1)</script>`;
    files.push({
      name: `OEBPS/${chapter.id}.xhtml`,
      data: new TextEncoder().encode(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><head><title>${chapter.title}</title></head><body>${body}</body></html>`),
    });
  }
  for (const [name, data] of Object.entries(input.extra ?? {})) files.push({ name, data });
  return buildZip(files);
}

export function palmdocDecompress(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i] ?? 0;
    i += 1;
    if (c >= 1 && c <= 8) {
      for (let n = 0; n < c; n += 1) out.push(bytes[i + n] ?? 0);
      i += c;
    } else if (c < 128) out.push(c);
    else if (c >= 192) {
      out.push(32, c ^ 0x80);
    } else {
      const pair = (c << 8) | (bytes[i] ?? 0);
      i += 1;
      const distance = (pair >> 3) & 0x7ff;
      const length = (pair & 7) + 3;
      if (distance <= 0 || distance > out.length) throw new MangaError("UNSUPPORTED_FORMAT", "invalid palmdoc backreference");
      for (let n = 0; n < length; n += 1) out.push(out[out.length - distance] ?? 0);
    }
  }
  return Uint8Array.from(out);
}

export function parseMobiBytes(bytes: Uint8Array): ParsedDocument {
  const parserId = PARSER_CANDIDATES.find((item) => item.format === "mobi")!.id;
  if (bytes.length < 86) throw new MangaError("UNSUPPORTED_FORMAT", "mobi header is truncated");
  const type = latin(bytes.subarray(60, 68));
  if (type !== "BOOKMOBI" && type !== "TEXtREAd") throw new MangaError("UNSUPPORTED_FORMAT", "not a mobi palm database");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = view.getUint16(76, false);
  if (records < 2 || 78 + records * 8 > bytes.length) throw new MangaError("UNSUPPORTED_FORMAT", "mobi records are truncated");
  const offsets: number[] = [];
  for (let i = 0; i < records; i += 1) offsets.push(view.getUint32(78 + i * 8, false));
  offsets.push(bytes.length);
  const record0 = offsets[0] ?? 0;
  const compression = view.getUint16(record0, false);
  const textLength = view.getUint32(record0 + 4, false);
  const textRecords = view.getUint16(record0 + 8, false);
  const encryption = view.getUint16(record0 + 12, false);
  if (encryption !== 0) throw new MangaError("UNSUPPORTED_FORMAT", "encrypted mobi rejected");
  if (compression !== 1 && compression !== 2) throw new MangaError("UNSUPPORTED_FORMAT", `unsupported mobi compression ${compression}`);
  let title = "untitled";
  let firstImageIndex: number | undefined;
  let textEncoding = 65001;
  if (latin(bytes.subarray(record0 + 16, record0 + 20)) === "MOBI") {
    const nameOffset = view.getUint32(record0 + 16 + 84, false);
    const nameLength = view.getUint32(record0 + 16 + 88, false);
    if (nameLength > 0 && nameLength < 1024 && record0 + nameOffset + nameLength <= bytes.length) {
      title = new TextDecoder().decode(bytes.subarray(record0 + nameOffset, record0 + nameOffset + nameLength)).replaceAll("\u0000", "") || title;
    }
    if (record0 + 16 + 0x6c + 4 <= bytes.length) {
      const candidate = view.getUint32(record0 + 16 + 0x6c, false);
      if (candidate > textRecords && candidate < records) firstImageIndex = candidate;
    }
    if (record0 + 16 + 0x1c + 4 <= bytes.length) {
      const declared = view.getUint32(record0 + 16 + 0x1c, false);
      if (declared === 1252 || declared === 65001) textEncoding = declared;
    }
  }
  const chunks: Uint8Array[] = [];
  for (let i = 1; i <= textRecords && i < offsets.length - 1; i += 1) {
    const start = offsets[i] ?? 0;
    const end = offsets[i + 1] ?? start;
    const record = bytes.subarray(start, end);
    chunks.push(compression === 2 ? palmdocDecompress(record) : record);
  }
  const joined = new Uint8Array(chunks.reduce((sum, item) => sum + item.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    joined.set(chunk, cursor);
    cursor += chunk.length;
  }
  const sliced = joined.subarray(0, Math.min(textLength, joined.length));
  let decoded: string;
  try {
    decoded = textEncoding === 65001
      ? new TextDecoder("utf-8", { fatal: true }).decode(sliced)
      : new TextDecoder("windows-1252").decode(sliced);
  } catch (error) {
    throw new MangaError("VALIDATION_ERROR", "mobi text is not valid UTF-8; choose another file or encoding", { cause: error });
  }
  const markup = decoded.replaceAll("\u0000", "");
  // MOBI bodies are HTML with <mbp:pagebreak> as the page boundary; keep the parts apart.
  const pageChunks = markup
    .split(/<mbp:pagebreak\b[^>]*\/?>/i)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
  const source = pageChunks.length ? pageChunks : [markup];
  const imageStart = firstImageIndex ?? textRecords + 1;
  const assets: ParsedAsset[] = [];
  const assetCache = new Map<number, ParsedAsset | null>();
  const assetForRecord = (recindex: number, partId: string): ParsedAsset | null => {
    if (!Number.isFinite(recindex) || recindex < 1) return null;
    const cached = assetCache.get(recindex);
    if (cached !== undefined) {
      if (cached && !cached.partId.includes(partId)) cached.partId = `${cached.partId},${partId}`;
      return cached;
    }
    const recordNumber = imageStart + recindex - 1;
    if (recordNumber < 1 || recordNumber >= offsets.length - 1) { assetCache.set(recindex, null); return null; }
    const start = offsets[recordNumber] ?? 0;
    const end = offsets[recordNumber + 1] ?? start;
    const data = bytes.subarray(start, end);
    if (!data.length || data.length > ZIP_ENTRY) { assetCache.set(recindex, null); return null; }
    const mediaType = guessMediaTypeFromMagic(data);
    const asset: ParsedAsset = {
      id: `rec${recindex}`,
      name: `record-${recindex}`,
      mediaType,
      bytes: data,
      partId,
    };
    assetCache.set(recindex, asset);
    assets.push(asset);
    return asset;
  };
  const parts: ParsedPart[] = [];
  let unresolvedImages = 0;
  let flowImages = 0;
  const warnings: string[] = [];
  for (const [index, piece] of source.entries()) {
    // `recindex` and `kindle:embed` both name image records; a kindle URL may carry an offset after ':'.
    const references = [
      ...[...piece.matchAll(/<img\b[^>]*\brecindex\s*=\s*["']?(\d+)/gi)].map((match) => Number(match[1])),
      ...[...piece.matchAll(/kindle:embed:([0-9A-Fa-f]{1,4})(?::\d+)?/gi)].map((match) => Number.parseInt(match[1]!, 16)),
    ].filter((recindex) => Number.isFinite(recindex) && recindex > 0);
    if (/kindle:flow:[0-9A-Fa-f]{1,4}\?[^"']*mime=image/i.test(piece)) flowImages += 1;
    const partId = source.length === 1 ? "body" : `page-${index + 1}`;
    const partAssets: string[] = [];
    for (const recindex of references) {
      const asset = assetForRecord(recindex, partId);
      if (asset) partAssets.push(asset.id);
      else unresolvedImages += 1;
    }
    const extracted = htmlToText(piece);
    const normalized = normalizeText(extracted.text);
    const heading = extracted.text.split("\n").find((line) => line.trim());
    parts.push({
      id: partId,
      title: heading?.slice(0, 80) || (source.length === 1 ? title : `第 ${index + 1} 页`),
      normalized: normalized.normalized,
      kind: !extracted.text && partAssets.length ? "image" : "text",
      parserVersion: normalized.parserVersion,
      images: partAssets,
      index,
    });
  }
  if (unresolvedImages) warnings.push(`${unresolvedImages} mobi image records could not be read`);
  if (flowImages) warnings.push("kindle flow images are not rendered; only record images are shown");
  if (parts.some((part) => part.kind === "image")) warnings.push("image-only mobi pages have no text layer");
  return {
    format: "mobi",
    title,
    parserId,
    parts,
    toc: parts.map((part) => ({ label: part.title ?? part.id, partId: part.id })),
    assets,
    traits: {
      compression,
      encryption: false,
      records: textRecords,
      pages: parts.length,
      storedAssets: assets.length,
      unresolvedImages,
      flowImages,
      textEncoding,
      html: true,
      candidate: true,
      accepted: false,
      normalization: NORMALIZATION_V1,
    },
    warnings,
  };
}

function guessMediaTypeFromMagic(data: Uint8Array): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif";
  if (data.length >= 12 && latin(data.subarray(0, 4)) === "RIFF" && latin(data.subarray(8, 12)) === "WEBP") return "image/webp";
  if (data.length >= 4 && data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) return "image/x-icon";
  return "application/octet-stream";
}

export function buildMobiFixture(text: string, title = "合成", options: { html?: string; images?: Uint8Array[] } = {}): Uint8Array {
  const body = new TextEncoder().encode(options.html ?? text);
  const recordSize = 4096;
  const textRecords = Math.max(1, Math.ceil(body.length / recordSize));
  const name = Buffer.from(title);
  const headerLength = 232;
  const record0 = Buffer.alloc(16 + headerLength + name.length);
  record0.writeUInt16BE(1, 0);
  record0.writeUInt32BE(body.length, 4);
  record0.writeUInt16BE(textRecords, 8);
  record0.writeUInt16BE(recordSize, 10);
  record0.writeUInt16BE(0, 12);
  record0.write("MOBI", 16);
  record0.writeUInt32BE(headerLength, 20);
  record0.writeUInt32BE(2, 24);
  record0.writeUInt32BE(65001, 28);
  record0.writeUInt32BE(16 + headerLength, 16 + 84);
  record0.writeUInt32BE(name.length, 16 + 88);
  const images = options.images ?? [];
  // firstImageIndex points at the first image record, which follows the text records.
  if (images.length) record0.writeUInt32BE(textRecords + 1, 16 + 0x6c);
  name.copy(record0, 16 + headerLength);
  const chunks: Buffer[] = [record0];
  for (let i = 0; i < textRecords; i += 1) chunks.push(Buffer.from(body.subarray(i * recordSize, (i + 1) * recordSize)));
  for (const image of images) chunks.push(Buffer.from(image));
  const count = chunks.length;
  const header = Buffer.alloc(78 + count * 8);
  header.write("BOOK", 0);
  header.write("BOOKMOBI", 60);
  header.writeUInt16BE(count, 76);
  let offset = header.length;
  for (let i = 0; i < count; i += 1) {
    header.writeUInt32BE(offset, 78 + i * 8);
    offset += chunks[i]!.length;
  }
  return new Uint8Array(Buffer.concat([header, ...chunks]));
}

export { buildPdfFixture, buildPdfObjectStreamFixture } from "./pdf-fixture.ts";

export async function parsePdfBytes(bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<ParsedDocument> {
  const { parsePdfDocument } = await import("./pdfjs-document.ts");
  return parsePdfDocument(bytes, options);
}

export async function parseDocument(bytes: Uint8Array, options: { format?: "txt" | "epub" | "mobi" | "pdf" | "auto"; encoding?: "utf-8" | "utf-16le"; signal?: AbortSignal } = {}): Promise<ParsedDocument> {
  const format = !options.format || options.format === "auto" ? sniffFormat(bytes) : options.format;
  if (format === "pdf") return parsePdfBytes(bytes, { signal: options.signal });
  return parseDocumentBytes(bytes, options);
}

export function parseTextBytes(bytes: Uint8Array, encoding: "utf-8" | "utf-16le" = "utf-8"): ParsedDocument {
  const parserId = PARSER_CANDIDATES.find((item) => item.format === "txt")!.id;
  let decoded: string;
  let bom = false;
  try {
    if (encoding === "utf-16le" || (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)) {
      bom = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
      decoded = new TextDecoder("utf-16le", { fatal: true }).decode(bom ? bytes.subarray(2) : bytes);
    } else {
      bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
    }
  } catch (error) {
    throw new MangaError("VALIDATION_ERROR", "text encoding failed; choose UTF-8 or UTF-16LE instead of replacing characters", { cause: error, details: { encoding } });
  }
  const normalized = normalizeText(decoded);
  return {
    format: "txt",
    title: normalized.normalized.split("\n")[0]?.slice(0, 80) || "txt",
    parserId,
    parts: [{ id: "body", normalized: normalized.normalized, kind: "text", parserVersion: normalized.parserVersion }],
    toc: [{ label: "正文", partId: "body" }],
    traits: { bom, encoding: bom && bytes[0] === 0xff ? "utf-16le" : encoding, normalization: NORMALIZATION_V1, candidate: true, accepted: false },
    warnings: [],
  };
}

export function sniffFormat(bytes: Uint8Array): "txt" | "epub" | "mobi" | "pdf" {
  if (latin(bytes.subarray(0, 5)) === "%PDF-") return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "epub";
  if (latin(bytes.subarray(60, 68)) === "BOOKMOBI" || latin(bytes.subarray(60, 68)) === "TEXtREAd") return "mobi";
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let nuls = 0;
  for (const byte of sample) if (byte === 0) nuls += 1;
  if (nuls > sample.length / 20 && !(bytes[0] === 0xff && bytes[1] === 0xfe)) {
    throw new MangaError("UNSUPPORTED_FORMAT", "unrecognized binary document");
  }
  return "txt";
}

export function parseDocumentBytes(bytes: Uint8Array, options: { format?: "txt" | "epub" | "mobi" | "pdf" | "auto"; encoding?: "utf-8" | "utf-16le" } = {}): ParsedDocument {
  const format = !options.format || options.format === "auto" ? sniffFormat(bytes) : options.format;
  if (format === "epub") return parseEpubBytes(bytes);
  if (format === "mobi") return parseMobiBytes(bytes);
  if (format === "pdf") throw new MangaError("UNSUPPORTED_FORMAT", "pdf parsing is asynchronous; use parseDocument");
  return parseTextBytes(bytes, options.encoding ?? "utf-8");
}

export function documentLength(part: { normalized: string }): number {
  return codePointLength(part.normalized);
}

export function slicePart(part: { normalized: string }, start = 0, limit = 4000): { text: string; start: number; end: number } {
  const length = codePointLength(part.normalized);
  const safeStart = Math.min(start, length);
  const end = Math.min(length, safeStart + limit);
  return { text: sliceCodePoints(part.normalized, safeStart, end), start: safeStart, end };
}
