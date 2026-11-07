import path from "node:path";
import type { ComicManifest, MetadataFieldKey, VideoProbe } from "@manga/contracts";
import { fileReader } from "../comic/scan.ts";
import type { ZipPool } from "../media/zip-pool.ts";

/** What a file says about itself, in the shape the field projection takes. */
export type LocalFields = Partial<Record<MetadataFieldKey, string | number | string[]>>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1]!.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

const plain = (value: string) => decodeXml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

function allTags(xml: string, name: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    const value = plain(match[1]!);
    if (value) found.push(value);
  }
  return found;
}

function attributes(tagText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tagText.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[match[1]!.toLowerCase()] = decodeXml(match[3] ?? match[4] ?? "");
  return out;
}

function isoDate(text: string): string | undefined {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(text.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  if (year < 1000 || year > 2999) return undefined;
  return [match[1], match[2], match[3]].filter(Boolean).join("-");
}

export type OpfInfo = { fields: LocalFields; coverHref?: string; opfDir: string };

/** Dublin Core fields and the cover image of an EPUB package document. `opfPath` is where the document sits, so hrefs resolve against it. */
export function parseOpf(opf: string, opfPath: string): OpfInfo {
  const fields: LocalFields = {};
  const metadata = /<metadata[\s>][\s\S]*?<\/metadata>/i.exec(opf)?.[0] ?? opf;
  const title = allTags(metadata, "dc:title")[0];
  if (title && title.toLowerCase() !== "untitled") fields.title = title.slice(0, 256);
  const creators = allTags(metadata, "dc:creator");
  if (creators.length) fields.author = [...new Set(creators)].slice(0, 4).join(" / ").slice(0, 256);
  const publisher = allTags(metadata, "dc:publisher")[0];
  if (publisher) fields.studio = publisher.slice(0, 256);
  const date = allTags(metadata, "dc:date")[0];
  const iso = date ? isoDate(date) : undefined;
  if (iso) fields.releaseDate = iso;
  const description = allTags(metadata, "dc:description")[0];
  if (description) fields.summary = description.slice(0, 4000);
  const subjects = allTags(metadata, "dc:subject");
  if (subjects.length) fields.tags = [...new Set(subjects)].slice(0, 12).map((subject) => subject.slice(0, 64));

  const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const imageItem = (item: Record<string, string> | undefined) => (item && /^image\//i.test(item["media-type"] ?? "") && item.href ? item : undefined);
  let cover = imageItem(items.find((item) => /(^|\s)cover-image(\s|$)/.test(item.properties ?? "")));
  if (!cover) {
    const metaCover = [...opf.matchAll(/<meta\b[^>]*>/gi)].map((match) => attributes(match[0])).find((meta) => meta.name?.toLowerCase() === "cover" && meta.content);
    cover = imageItem(items.find((item) => item.id === metaCover?.content));
  }
  if (!cover) cover = imageItem(items.find((item) => /cover/i.test(item.id ?? "") || /cover/i.test(path.posix.basename(item.href ?? ""))));
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  return { fields, coverHref: cover?.href, opfDir };
}

function safeDecode(href: string): string {
  try { return decodeURIComponent(href); } catch { return href; }
}

/** Metadata and cover of an EPUB, read straight from the archive. A broken package gives whatever could be read. */
export async function readEpub(zips: ZipPool, file: string, signal?: AbortSignal): Promise<{ fields: LocalFields; cover: () => Promise<Buffer | null> }> {
  const none = { fields: {}, cover: async () => null };
  try {
    const container = (await zips.read(file, "META-INF/container.xml", { maxBytes: 1024 * 1024, signal })).toString("utf8");
    const rootfile = /<rootfile\b[^>]*>/i.exec(container);
    const opfPath = rootfile ? attributes(rootfile[0])["full-path"] : undefined;
    if (!opfPath) return none;
    const opf = (await zips.read(file, opfPath, { maxBytes: 8 * 1024 * 1024, signal })).toString("utf8");
    const info = parseOpf(opf, opfPath);
    return {
      fields: info.fields,
      cover: async () => {
        if (!info.coverHref) return null;
        const target = path.posix.normalize(`${info.opfDir}${safeDecode(info.coverHref)}`);
        try { return await zips.read(file, target, { maxBytes: 32 * 1024 * 1024, signal }); } catch { return null; }
      },
    };
  } catch {
    return none;
  }
}

export type MobiExth = { fields: LocalFields; coverRecord?: number };

/** Author, publisher, description, subject and the cover record from a MOBI's EXTH block, when it has one. */
export function readMobiExth(file: string): MobiExth {
  const { reader, close } = fileReader(file);
  try {
    const head = reader.read(0, 94);
    if (head.length < 94 || head.toString("latin1", 60, 68) !== "BOOKMOBI") return { fields: {} };
    const start = head.readUInt32BE(78);
    const end = head.readUInt32BE(86);
    const length = Math.min(256 * 1024, Math.max(0, end - start));
    const record = reader.read(start, length);
    if (record.length < 132 || record.toString("latin1", 16, 20) !== "MOBI") return { fields: {} };
    const headerLength = record.readUInt32BE(20);
    const encoding = record.readUInt32BE(28);
    const firstImage = record.readUInt32BE(108);
    const flags = record.readUInt32BE(128);
    if (!(flags & 0x40)) return { fields: {} };
    const exthStart = 16 + headerLength;
    if (record.toString("latin1", exthStart, exthStart + 4) !== "EXTH") return { fields: {} };
    const count = record.readUInt32BE(exthStart + 8);
    const decode = (buffer: Buffer) => (encoding === 65001 ? buffer.toString("utf8") : buffer.toString("latin1")).replace(/\0/g, "").trim();
    const values = new Map<number, string[]>();
    let cursor = exthStart + 12;
    let coverOffset: number | undefined;
    for (let i = 0; i < count && cursor + 8 <= record.length; i += 1) {
      const type = record.readUInt32BE(cursor);
      const size = record.readUInt32BE(cursor + 4);
      if (size < 8 || cursor + size > record.length) break;
      const data = record.subarray(cursor + 8, cursor + size);
      if (type === 201 && data.length === 4) coverOffset = data.readUInt32BE(0);
      else {
        const text = decode(data);
        if (text) values.set(type, [...(values.get(type) ?? []), text]);
      }
      cursor += size;
    }
    const fields: LocalFields = {};
    const author = values.get(100);
    if (author) fields.author = [...new Set(author)].slice(0, 4).join(" / ").slice(0, 256);
    const publisher = values.get(101)?.[0];
    if (publisher) fields.studio = publisher.slice(0, 256);
    const description = values.get(103)?.[0];
    if (description) fields.summary = plain(description).slice(0, 4000);
    const subjects = values.get(105);
    if (subjects) fields.tags = [...new Set(subjects)].slice(0, 12).map((subject) => subject.slice(0, 64));
    const published = values.get(106)?.[0];
    const iso = published ? isoDate(published) : undefined;
    if (iso) fields.releaseDate = iso;
    return { fields, ...(coverOffset !== undefined && firstImage !== 0xffffffff ? { coverRecord: firstImage + coverOffset } : {}) };
  } catch {
    return { fields: {} };
  } finally {
    close();
  }
}

/** Title and author from a PDF's information dictionary. Many files leave them empty or fill them with the authoring tool's name. */
export function cleanPdfInfo(info: Record<string, unknown> | undefined): LocalFields {
  const fields: LocalFields = {};
  const text = (value: unknown) => (typeof value === "string" ? value.replace(/\0/g, "").trim() : "");
  const title = text(info?.Title);
  // A title that is just a file name or an "untitled" placeholder says nothing.
  if (title && !/^(untitled|microsoft word - |document\d*)/i.test(title) && !/\.(docx?|pdf|indd|tex)$/i.test(title)) fields.title = title.slice(0, 256);
  const author = text(info?.Author);
  if (author) fields.author = author.slice(0, 256);
  const subject = text(info?.Subject);
  if (subject) fields.summary = subject.slice(0, 1000);
  const date = typeof info?.CreationDate === "string" ? /D:(\d{4})(\d{2})?(\d{2})?/.exec(info.CreationDate) : null;
  if (date) {
    const iso = isoDate([date[1], date[2], date[3]].filter(Boolean).join("-"));
    if (iso) fields.releaseDate = iso;
  }
  return fields;
}

/** ComicInfo.xml, as read at import time and kept in the revision. */
export function comicInfoFields(info: ComicManifest["info"] | undefined): LocalFields {
  const fields: LocalFields = {};
  if (!info) return fields;
  const title = info.series ?? info.title;
  if (title) fields.title = title.slice(0, 256);
  if (info.writer) fields.author = info.writer.slice(0, 256);
  if (info.summary) fields.summary = info.summary.slice(0, 4000);
  if (info.year) fields.releaseDate = String(info.year);
  return fields;
}

/** Container tags of a video. Release names in `title` are common, so only a tag that differs from the file name counts. */
export function videoTagFields(probe: Pick<VideoProbe, "tags">, fileStem: string): LocalFields {
  const tags = probe.tags ?? {};
  const fields: LocalFields = {};
  const title = tags.title?.trim();
  if (title && title.toLowerCase() !== fileStem.toLowerCase()) fields.title = title.slice(0, 256);
  const author = tags.artist ?? tags.author ?? tags.director;
  if (author) fields.author = author.slice(0, 256);
  const studio = tags.studio ?? tags.publisher ?? tags.copyright;
  if (studio) fields.studio = studio.slice(0, 256);
  const summary = tags.description ?? tags.comment ?? tags.synopsis;
  if (summary) fields.summary = summary.slice(0, 4000);
  const date = tags.date ?? tags.creation_time ?? tags.year;
  const iso = date ? isoDate(date) : undefined;
  if (iso) fields.releaseDate = iso;
  const genre = tags.genre;
  if (genre) fields.tags = genre.split(/[,;/]/).map((part) => part.trim()).filter(Boolean).slice(0, 12);
  return fields;
}

export function isEmptyFields(fields: LocalFields): boolean {
  return Object.keys(fields).length === 0;
}
