import path from "node:path";
import { MangaError } from "@manga/contracts";
import type { WorkMediaKind } from "@manga/contracts";
import { htmlImageSources, htmlSvgImageHrefs, resolveArchiveReference } from "../domain/formats.ts";
import { samplePdfContent } from "../domain/pdfjs-document.ts";
import type { ZipPool } from "../media/zip-pool.ts";
import { VIDEO_EXTENSIONS, isImageName, mobiTableOfFile } from "./scan.ts";

export type KindSuggestion = {
  kind: WorkMediaKind;
  /** Short machine-readable basis, shown in the import dialog next to the choice. */
  basis: "extension" | "images_only" | "text" | "mixed" | "unknown";
  confidence: "high" | "low";
  pages?: number;
};

function textLength(html: string): number {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "").replace(/&[a-z]+;|&#\d+;/gi, " ").replace(/\s+/g, "").length;
}

async function epubStats(file: string, zips: ZipPool, signal?: AbortSignal): Promise<{ spine: number; images: number; textChars: number }> {
  const index = await zips.index(file, signal);
  const read = async (name: string) => (await zips.read(file, name, { maxBytes: 4 * 1024 * 1024, signal })).toString("utf8");
  const opfPath = /full-path\s*=\s*["']([^"']+)["']/i.exec(await read("META-INF/container.xml"))?.[1];
  if (!opfPath || !index.byName.has(opfPath)) throw new MangaError("UNSUPPORTED_FORMAT", "missing opf");
  const opf = await read(opfPath);
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const items = new Map<string, { href: string; type: string }>();
  for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = match[0];
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    const type = /\bmedia-type\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    if (id && href) items.set(id, { href, type });
  }
  const spineIds = [...opf.matchAll(/<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]!);
  let images = 0;
  let textChars = 0;
  const seen = new Set<string>();
  for (const id of spineIds.slice(0, 40)) {
    const item = items.get(id);
    if (!item) continue;
    const href = resolveArchiveReference(base, item.href);
    if (!href) continue;
    if (item.type.startsWith("image/")) {
      if (!seen.has(href)) { seen.add(href); images += 1; }
      continue;
    }
    if (!index.byName.has(href)) continue;
    const html = await read(href);
    textChars += textLength(html);
    const dir = href.includes("/") ? href.slice(0, href.lastIndexOf("/") + 1) : "";
    for (const reference of [...htmlImageSources(html), ...htmlSvgImageHrefs(html)]) {
      const target = resolveArchiveReference(dir, reference);
      if (target && isImageName(target) && !seen.has(target)) { seen.add(target); images += 1; }
    }
  }
  return { spine: spineIds.length, images, textChars };
}

function mobiStats(file: string): { images: number; textChars: number } {
  const { records, textLength } = mobiTableOfFile(file);
  return { images: records.length, textChars: textLength };
}

/**
 * A default for the import dialog. The reader's choice always wins; this only decides what is pre-selected, so a book of
 * pictures is not opened as a novel by accident (and the other way round).
 */
export async function suggestKind(file: string, options: { zips: ZipPool; signal?: AbortSignal }): Promise<KindSuggestion> {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return { kind: "video", basis: "extension", confidence: "high" };
  if (ext === ".cbz") return { kind: "comic", basis: "extension", confidence: "high" };
  if (ext === ".txt") return { kind: "novel", basis: "extension", confidence: "high" };
  try {
    if (ext === ".pdf") {
      const sample = await samplePdfContent({ file }, { signal: options.signal });
      if (sample.textPages === 0 && sample.imagePages >= Math.ceil(sample.sampled * 0.8)) return { kind: "comic", basis: "images_only", confidence: "high", pages: sample.pages };
      if (sample.textPages >= Math.ceil(sample.sampled / 2)) return { kind: "novel", basis: "text", confidence: "high", pages: sample.pages };
      return { kind: "novel", basis: "mixed", confidence: "low", pages: sample.pages };
    }
    if (ext === ".epub") {
      const stats = await epubStats(file, options.zips, options.signal);
      const perItem = stats.textChars / Math.max(1, stats.spine);
      if (stats.images >= 3 && perItem < 120) return { kind: "comic", basis: "images_only", confidence: "high", pages: stats.images };
      if (stats.images >= 3 && perItem < 500) return { kind: "novel", basis: "mixed", confidence: "low", pages: stats.images };
      return { kind: "novel", basis: "text", confidence: "high" };
    }
    if (ext === ".mobi" || ext === ".azw3") {
      const stats = mobiStats(file);
      if (stats.images >= 3 && stats.textChars / stats.images < 400) return { kind: "comic", basis: "images_only", confidence: "high", pages: stats.images };
      return { kind: "novel", basis: stats.images ? "mixed" : "text", confidence: stats.images ? "low" : "high" };
    }
  } catch (error) {
    if (error instanceof MangaError && error.code === "CANCELLED") throw error;
    return { kind: "novel", basis: "unknown", confidence: "low" };
  }
  return { kind: "novel", basis: "unknown", confidence: "low" };
}
