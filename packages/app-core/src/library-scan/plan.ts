import { createHash } from "node:crypto";
import path from "node:path";
import { comparePaths, IMAGE_EXTENSIONS, isIgnoredName, NOVEL_EXTENSIONS, VIDEO_EXTENSIONS } from "../comic/scan.ts";

export type ScanKind = "novel" | "comic" | "video";

/** One entry the walker saw below a library path. `p` is the path below the root with forward slashes. */
export type WalkEntry = { p: string; t: "f" | "d"; s: number; m: number };

export type UnitType = "image-dir" | "archive" | "document" | "video";

/**
 * Something the scan reads as one resource: a comic chapter folder, an archive or document, a video, a text file or book.
 * `rel` is the path below the library path; for a folder of images it is the folder and `size`/`mtime` summarise the images.
 */
export type ScanUnit = {
  rel: string;
  type: UnitType;
  /** Work this unit belongs to: the first folder below the library path, or the unit itself when it sits directly in the path. */
  group: string;
  /** Path of the unit below its group's folder; what the import services name the resource after. */
  inGroup: string;
  size: number;
  mtime: number;
  imageCount?: number;
  /** For a folder of images: an identity built from the file names and sizes, so a folder that moved is recognised. */
  sig?: string;
};

export type ScanGroup = {
  key: string;
  /** Whether the group is a folder (several resources) or one file of its own. */
  folder: boolean;
  title: string;
  units: ScanUnit[];
  nested: boolean;
  /** A folder that is itself one chapter (images directly inside it) becomes one resource named after the work. */
  single: boolean;
};

const ARCHIVE_EXTENSIONS = new Set([".cbz", ".zip"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".epub", ".mobi", ".azw3"]);

export const SCAN_LIMITS = { maxUnits: 50_000, maxDepth: 8 } as const;

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

function parentOf(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash < 0 ? "." : rel.slice(0, slash);
}

function unitForFile(kind: ScanKind, entry: WalkEntry): UnitType | null {
  const ext = extOf(entry.p);
  if (kind === "comic") return ARCHIVE_EXTENSIONS.has(ext) ? "archive" : DOCUMENT_EXTENSIONS.has(ext) ? "document" : null;
  if (kind === "video") return VIDEO_EXTENSIONS.has(ext) ? "video" : null;
  return NOVEL_EXTENSIONS.has(ext) ? "document" : null;
}

/**
 * What a library path holds, as units grouped into works. Pure: it only looks at the entries the walker listed, so it is
 * the same whether a folder was walked a moment ago or its listing was kept. Every folder directly below the path is one
 * work (its files, in natural order, are its volumes, chapters or episodes); a file directly in the path is a work of its own.
 */
export function planScan(kind: ScanKind, entries: WalkEntry[], rootName: string, limits: { maxUnits: number } = SCAN_LIMITS): { groups: ScanGroup[]; truncated: boolean } {
  const units: ScanUnit[] = [];
  const imagesByDir = new Map<string, { count: number; size: number; mtime: number; names: string[] }>();
  for (const entry of entries) {
    if (entry.t !== "f" || isIgnoredName(entry.p.split("/").pop() ?? entry.p)) continue;
    if (kind === "comic" && IMAGE_EXTENSIONS.has(extOf(entry.p))) {
      const dir = parentOf(entry.p);
      const seen = imagesByDir.get(dir) ?? { count: 0, size: 0, mtime: 0, names: [] };
      seen.names.push(`${entry.p.split("/").pop()}:${entry.s}`);
      seen.count += 1;
      seen.size += entry.s;
      seen.mtime = Math.max(seen.mtime, entry.m);
      imagesByDir.set(dir, seen);
      continue;
    }
    const type = unitForFile(kind, entry);
    if (type) units.push({ rel: entry.p, type, group: "", inGroup: "", size: entry.s, mtime: entry.m });
  }
  for (const [dir, seen] of imagesByDir) {
    const sig = createHash("sha256").update(seen.names.sort().join("\n")).digest("hex");
    units.push({ rel: dir, type: "image-dir", group: "", inGroup: "", size: seen.size, mtime: seen.mtime, imageCount: seen.count, sig });
  }
  units.sort((a, b) => comparePaths(a.rel, b.rel));
  const truncated = units.length > limits.maxUnits;
  if (truncated) units.length = limits.maxUnits;

  const groups = new Map<string, ScanGroup>();
  for (const unit of units) {
    const first = unit.rel === "." ? "." : unit.rel.split("/")[0]!;
    const folder = unit.rel.includes("/") || (unit.type === "image-dir" && unit.rel !== ".");
    // A unit directly in the path is its own work; anything deeper belongs to the folder it sits under.
    const key = folder ? first : unit.rel;
    unit.group = key;
    unit.inGroup = folder ? (unit.rel === first ? "." : unit.rel.slice(first.length + 1)) : unit.rel;
    let group = groups.get(key);
    if (!group) {
      group = { key, folder, title: key === "." ? rootName : folder ? first : unit.rel.replace(/\.[^./]+$/, ""), units: [], nested: false, single: false };
      groups.set(key, group);
    }
    group.units.push(unit);
  }
  for (const group of groups.values()) {
    group.units.sort((a, b) => comparePaths(a.inGroup, b.inGroup));
    group.nested = group.units.some((unit) => unit.inGroup.includes("/"));
    group.single = group.units.length === 1 && group.units[0]!.type === "image-dir" && group.units[0]!.inGroup === ".";
  }
  return { groups: [...groups.values()].sort((a, b) => comparePaths(a.key, b.key)), truncated };
}
