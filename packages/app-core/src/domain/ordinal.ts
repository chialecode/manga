import { parse as parseAnimeName } from "anitomy";
import type { Ordinal, OrdinalType } from "@manga/contracts";

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/** Natural order: digit runs compare as numbers, so `2` sorts before `10`; names compare with locale rules. */
export function naturalCompare(left: string, right: string): number {
  return collator.compare(left, right);
}

const SPECIAL_TAGS = new Set(["sp", "ova", "oad", "ona", "special", "specials", "extra", "extras", "omake", "番外", "特典"]);

export type ParsedName = {
  title?: string;
  number?: number;
  version?: number;
  season?: number;
  type: OrdinalType | "unknown";
  specialTag?: string;
  group?: string;
  resolution?: string;
  /** True when the anime-name adapter produced the result; false when the fallback patterns did. */
  adapter: boolean;
};

function baseName(fileName: string): string {
  const slash = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  return slash >= 0 ? fileName.slice(slash + 1) : fileName;
}

function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
}

/** Patterns for comic files and folders: 第12话, Vol.03, ch 12, 12 — a bare number as the whole name. */
function parseComicName(name: string): ParsedName | undefined {
  const text = stripExtension(baseName(name)).trim();
  const patterns: Array<[RegExp, OrdinalType]> = [
    [/第\s*(\d+(?:\.\d+)?)\s*(?:卷|巻|册|冊)/, "volume"],
    [/第\s*(\d+(?:\.\d+)?)\s*(?:话|話|章|回|集)/, "chapter"],
    [/(?:^|[\s_.\-\[(])(?:vol(?:ume)?)[\s._-]*(\d+(?:\.\d+)?)/i, "volume"],
    [/(?:^|[\s_.\-\[(])(?:ch(?:apter)?|ep(?:isode)?)[\s._-]*(\d+(?:\.\d+)?)/i, "chapter"],
  ];
  for (const [pattern, type] of patterns) {
    const match = pattern.exec(text);
    if (match) return { number: Number(match[1]), type, adapter: false, title: text };
  }
  const bare = /^\D*?(\d+(?:\.\d+)?)\D*$/.exec(text);
  if (bare) return { number: Number(bare[1]), type: "chapter", adapter: false, title: text };
  return undefined;
}

/** Number, season and specials from a file name. Anime-style names go through the adapter; anything it cannot read falls back. */
export function parseOrdinalName(fileName: string, hint: "comic" | "video"): ParsedName {
  const name = baseName(fileName);
  if (hint === "video") {
    try {
      const parsed = parseAnimeName(name) as {
        title?: string;
        type?: string;
        season?: string | number;
        episode?: { number?: number };
        release?: { version?: number };
        video?: { resolution?: string };
        group?: string;
      };
      const tag = parsed.type?.toLowerCase();
      const special = tag ? SPECIAL_TAGS.has(tag) : false;
      let title = parsed.title?.trim();
      // The adapter keeps "- SP" in the title of a special; the series title is what comes before it.
      if (special && title) title = title.replace(/[\s._-]*(sp|ova|oad|ona)\s*$/i, "").trim() || title;
      const season = parsed.season === undefined ? undefined : Number(parsed.season);
      if (parsed.episode?.number !== undefined || special) {
        return {
          title,
          number: parsed.episode?.number,
          version: parsed.release?.version,
          season: Number.isFinite(season) ? season : undefined,
          type: special ? "special" : "episode",
          specialTag: special ? parsed.type : undefined,
          group: parsed.group,
          resolution: parsed.video?.resolution,
          adapter: true,
        };
      }
    } catch {
      // The adapter is a replaceable heuristic; a failure falls back to the plain number patterns below.
    }
    const bare = /(?:^|[\s_.\-\[(])(\d{1,4})(?:v(\d))?(?:$|[\s_.\-\])])/i.exec(stripExtension(name));
    if (bare) return { number: Number(bare[1]), version: bare[2] ? Number(bare[2]) : undefined, type: "episode", adapter: false };
    return { type: "unknown", adapter: false };
  }
  return parseComicName(name) ?? { type: "unknown", adapter: false };
}

/** The label shown next to a resource: 第 3 话, 第 2 卷, 第 7 集, SP1. A user-written label always wins. */
export function ordinalLabel(ordinal: Ordinal): string | undefined {
  if (ordinal.label) return ordinal.label;
  const number = ordinal.number;
  const text = number === undefined ? undefined : Number.isInteger(number) ? String(number) : String(number);
  switch (ordinal.type) {
    case "volume": return text ? `第 ${text} 卷` : undefined;
    case "chapter": return text ? `第 ${text} 话` : undefined;
    case "episode": return text ? `第 ${text} 集` : undefined;
    case "special": return text ? `SP${text}` : "SP";
    default: return undefined;
  }
}

/** Replace each digit run by a fixed-width one so plain string comparison orders names numerically. */
function paddedName(name: string): string {
  return name.toLowerCase().replace(/\d+/g, (digits) => digits.padStart(12, "0"));
}

/**
 * Sort key of a resource inside its work: main sequence first (by number), then specials, then anything unnumbered by name.
 * Keys compare with plain string order, so SQL `ORDER BY sort_key` and in-memory sorting agree.
 */
export function sortKeyFor(ordinal: Ordinal | undefined, name: string): string {
  const number = ordinal?.number;
  const bucket = ordinal?.type === "special" ? "2" : number !== undefined ? "1" : "3";
  const numeric = number === undefined ? "" : String(Math.round(number * 1000)).padStart(12, "0");
  return `${bucket}|${numeric}|${paddedName(name)}`;
}

export function ordinalFromParsed(parsed: ParsedName): Ordinal | undefined {
  if (parsed.type === "unknown" || (parsed.number === undefined && parsed.type !== "special")) return undefined;
  const ordinal: Ordinal = { type: parsed.type as OrdinalType };
  if (parsed.number !== undefined) ordinal.number = parsed.number;
  const label = ordinalLabel(ordinal);
  if (label) ordinal.label = label;
  return ordinal;
}
