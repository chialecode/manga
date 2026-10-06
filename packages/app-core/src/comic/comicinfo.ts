import type { ComicManifest } from "@manga/contracts";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1]!.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!match) return undefined;
  const value = decodeEntities(match[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
  return value || undefined;
}

export type ComicInfoPage = { image: number; type?: string; doublePage?: boolean; width?: number; height?: number };
export type ComicInfo = NonNullable<ComicManifest["info"]> & { pages: ComicInfoPage[]; direction?: "ltr" | "rtl"; language?: string; genre?: string[] };

/**
 * Read the fields of an Anansi-spec `ComicInfo.xml` that MANGA uses. A missing, truncated or oddly encoded file gives
 * whatever could be read (possibly nothing); it never blocks the import.
 */
export function parseComicInfo(source: Uint8Array | string): ComicInfo | null {
  let xml: string;
  try {
    if (typeof source === "string") xml = source;
    else {
      const bytes = source.length > 1024 * 1024 ? source.subarray(0, 1024 * 1024) : source;
      // A BOM or a UTF-16 declaration is the only encoding evidence the format gives.
      if (bytes[0] === 0xff && bytes[1] === 0xfe) xml = new TextDecoder("utf-16le").decode(bytes);
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) xml = new TextDecoder("utf-16be").decode(bytes);
      else xml = new TextDecoder("utf-8").decode(bytes);
    }
  } catch {
    return null;
  }
  xml = xml.replace(/^﻿/, "");
  if (!/<ComicInfo[\s>]/i.test(xml)) return null;
  const info: ComicInfo = { pages: [] };
  const series = tag(xml, "Series");
  const title = tag(xml, "Title");
  const number = tag(xml, "Number");
  const writer = tag(xml, "Writer");
  const summary = tag(xml, "Summary");
  const year = Number(tag(xml, "Year"));
  const manga = tag(xml, "Manga");
  const language = tag(xml, "LanguageISO");
  const genre = tag(xml, "Genre");
  if (series) info.series = series.slice(0, 256);
  if (title) info.title = title.slice(0, 256);
  if (number) info.number = number.slice(0, 32);
  if (writer) info.writer = writer.slice(0, 256);
  if (summary) info.summary = summary.slice(0, 4000);
  if (Number.isInteger(year) && year > 0 && year < 3000) info.year = year;
  if (manga) info.manga = manga;
  if (language) info.language = language.slice(0, 16);
  if (genre) info.genre = genre.split(/[,;]/).map((item) => item.trim()).filter(Boolean).slice(0, 16);
  if (manga && /^YesAndRightToLeft$/i.test(manga)) info.direction = "rtl";
  else if (manga && /^(Yes|No)$/i.test(manga)) info.direction = "ltr";
  for (const match of xml.matchAll(/<Page\b([^>]*?)\/?>/gi)) {
    const attrs = Object.fromEntries([...match[1]!.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((item) => [item[1]!.toLowerCase(), decodeEntities(item[2]!)]));
    const image = Number(attrs.image);
    if (!Number.isInteger(image) || image < 0 || image > 100_000) continue;
    info.pages.push({
      image,
      ...(attrs.type ? { type: attrs.type } : {}),
      ...(attrs.doublepage ? { doublePage: attrs.doublepage.toLowerCase() === "true" } : {}),
      ...(Number(attrs.imagewidth) > 0 ? { width: Number(attrs.imagewidth) } : {}),
      ...(Number(attrs.imageheight) > 0 ? { height: Number(attrs.imageheight) } : {}),
    });
    if (info.pages.length >= 20_000) break;
  }
  return info;
}
