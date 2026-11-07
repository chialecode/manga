import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { parse } from "parse5";
import { MangaError } from "@manga/contracts";
import { normalizeText, type NormalizedText } from "./text-locator.ts";

const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_RATIO = 100;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(match => [match[1]!, match[3]!]));
}
function tags(xml: string, name: string): Array<Record<string,string>> {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map(match => attributes(match[0]));
}

export type EpubPart = {
  id: string;
  href: string;
  mediaType: string;
  html: string;
  text: NormalizedText;
};

export type EpubDocument = {
  title: string;
  parts: EpubPart[];
  toc: Array<{ label: string; href: string }>;
  rejected?: string;
};

function assertSafePath(name: string): void {
  const normalized = name.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new MangaError("PATH_ESCAPE", `illegal epub path ${name}`, { details: { name } });
  }
}

export function parseEpub(bytes: Uint8Array): EpubDocument {
  let files: Record<string, Uint8Array>;
  let total = 0, entries = 0;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        assertSafePath(file.name);
        total += file.originalSize; entries++;
        if (total > MAX_TOTAL_BYTES || entries > 2048) throw new MangaError("UNSUPPORTED_FORMAT", "epub archive expansion budget exceeded");
        if (file.originalSize > MAX_ENTRY_BYTES) {
          throw new MangaError("UNSUPPORTED_FORMAT", `epub entry too large: ${file.name}`, {
            details: { name: file.name, originalSize: file.originalSize },
          });
        }
        const compressed = file.size;
        if (compressed > 0 && file.originalSize / compressed > MAX_RATIO) {
          throw new MangaError("UNSUPPORTED_FORMAT", `epub compression ratio rejected: ${file.name}`, {
            details: { name: file.name },
          });
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof MangaError) throw error;
    throw new MangaError("UNSUPPORTED_FORMAT", "invalid epub zip", { cause: error });
  }
  const names = Object.fromEntries(Object.keys(files).map((name) => [name.replaceAll("\\", "/"), name]));
  const containerName = names["META-INF/container.xml"];
  if (!containerName) throw new MangaError("UNSUPPORTED_FORMAT", "missing container.xml");
  const container = strFromU8(files[containerName]!);
  const opfHref = tags(container,"rootfile")[0]?.["full-path"];
  if (!opfHref) throw new MangaError("UNSUPPORTED_FORMAT", "missing opf path");
  assertSafePath(opfHref);
  const opfFile = names[opfHref];
  if (!opfFile) throw new MangaError("UNSUPPORTED_FORMAT", "opf missing from archive");
  const opf = strFromU8(files[opfFile]!);
  const title = /<dc:title[^>]*>([^<]+)<\/dc:title>/.exec(opf)?.[1] ?? "untitled";
  const manifest = tags(opf,"item").map(item => ({id:item.id!,href:item.href!,mediaType:item["media-type"]!,properties:item.properties}));
  if (manifest.some(item => !item.id || !item.href || !item.mediaType)) throw new MangaError("UNSUPPORTED_FORMAT","invalid EPUB manifest");
  const spine = tags(opf,"itemref").map(item => item.idref!);
  const base = opfHref.includes("/") ? opfHref.slice(0, opfHref.lastIndexOf("/") + 1) : "";
  const parts: EpubPart[] = [];
  for (const id of spine) {
    const item = manifest.find((entry) => entry.id === id);
    if (!item || !item.mediaType.includes("html")) throw new MangaError("UNSUPPORTED_FORMAT","unsupported or missing spine item");
    const href = `${base}${item.href}`.replace(/^\.\//, "");
    assertSafePath(href);
    const fileName = names[href];
    if (!fileName) throw new MangaError("UNSUPPORTED_FORMAT","missing spine document");
    const html = strFromU8(files[fileName]!);
    const text = htmlToText(html);
    parts.push({
      id: item.id,
      href,
      mediaType: item.mediaType,
      html,
      text: normalizeText(text),
    });
  }
  if (!parts.length) throw new MangaError("UNSUPPORTED_FORMAT","EPUB has no readable spine");
  const toc: EpubDocument["toc"] = [];
  const nav = manifest.find(item => item.properties?.split(/\s+/).includes("nav"));
  const ncx = manifest.find(item => item.mediaType === "application/x-dtbncx+xml");
  if (nav) {
    const href = base + nav.href; assertSafePath(href);
    const data = files[names[href]!];
    if (!data) throw new MangaError("UNSUPPORTED_FORMAT","missing navigation document");
    const html = strFromU8(data);
    for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const target=attributes(match[1]!).href;
      if (target) { assertSafePath(target); toc.push({label:htmlToText(match[2]!),href:target}); }
    }
  } else if (ncx) {
    const href=base+ncx.href; assertSafePath(href); const data=files[names[href]!];
    if (!data) throw new MangaError("UNSUPPORTED_FORMAT","missing NCX document");
    for(const match of strFromU8(data).matchAll(/<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<\/navLabel>\s*<content\b([^>]*)/g)) {
      const target=attributes(match[2]!).src;
      if(target) { assertSafePath(target); toc.push({label:htmlToText(match[1]!),href:target}); }
    }
  }
  return { title, parts, toc };
}

export function htmlToText(html: string): string {
  const doc = parse(html);
  const chunks: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const value = node as { nodeName?: string; value?: string; childNodes?: unknown[]; tagName?: string };
    if (value.nodeName === "#text" && value.value) {
      chunks.push(value.value);
      return;
    }
    const name = (value.tagName ?? value.nodeName ?? "").toLowerCase();
    if (name === "script" || name === "style") return;
    if (name === "p" || name === "div" || name === "br" || name === "li") chunks.push("\n");
    for (const child of value.childNodes ?? []) walk(child);
  };
  walk(doc);
  return chunks.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildEpubFixture(input: {
  title: string;
  chapters: Array<{ id: string; title: string; html: string }>;
  extra?: Record<string, Uint8Array>;
}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "mimetype": strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
  };
  const manifest = input.chapters.map((chapter, index) =>
    `<item id="${chapter.id}" href="${chapter.id}.xhtml" media-type="application/xhtml+xml"/>${index === 0 ? "" : ""}`).join("");
  const spine = input.chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`).join("");
  files["OEBPS/content.opf"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${input.title}</dc:title>
    <dc:identifier id="bookid">m0-epub</dc:identifier>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>${manifest}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
  <spine>${spine}</spine>
</package>`);
  files["OEBPS/nav.xhtml"] = strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><body><nav>${
    input.chapters.map((chapter) => `<a href="${chapter.id}.xhtml">${chapter.title}</a>`).join("")
  }</nav></body></html>`);
  for (const chapter of input.chapters) {
    files[`OEBPS/${chapter.id}.xhtml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter.title}</title><style>p{font-size:1em}</style></head><body><h1>${chapter.title}</h1>${chapter.html}</body></html>`);
  }
  for (const [name, data] of Object.entries(input.extra ?? {})) files[name] = data;
  return zipSync(files, { level: 6 });
}
