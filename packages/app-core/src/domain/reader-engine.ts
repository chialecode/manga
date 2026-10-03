/**
 * Minimal replaceable reading-engine boundary (唯一计划第 14.3 节的最小落地).
 *
 * Domain identity — resources, revisions, anchors, refs, progress and notes — stays with MANGA. A
 * reading engine only turns bytes into parts, text layers and page geometry, so it can be evaluated,
 * replaced or reverted without touching the application contract. The built-in parsers are exposed
 * through the same interface an external engine would implement; a candidate adapter only has to
 * satisfy this type, keep the stable part identity (`page-N`), the MANGA normalization, and map runs
 * to code-point offsets in the normalized text.
 */

import { parseDocument } from "./formats.ts";
import type { PdfRenderItem } from "./page-render.ts";

export type ReaderEngineTextRun = {
  text: string;
  /** Page-space position of the run origin (PDF user space, y up). */
  x: number;
  y: number;
  /** Width the engine's layout model assigns to the run, so visible glyphs match the model. */
  width?: number;
  /** Code-point offset of the run inside the part's normalized text when the mapping is stable. */
  offset?: number;
};

export type ReaderEnginePart = {
  /** Stable part identity; PDF pages keep `page-N` so existing anchors survive an engine switch. */
  id: string;
  kind: "text" | "scan" | "image";
  /** Normalized text layer of the part under MANGA normalization v1. */
  normalized?: string;
  /** Positioned runs of one page, when the engine provides a page model. */
  runs?: ReaderEngineTextRun[];
  /** Illustrations belonging to the part, in reading order. */
  images?: Array<{ id: string; mediaType: string; bytes: Uint8Array }>;
};

export type ReaderEngineDocument = {
  format: "txt" | "epub" | "mobi" | "pdf";
  parts: ReaderEnginePart[];
  warnings: string[];
};

export type ReaderEngine = {
  readonly engineId: string;
  readonly version: string;
  parse(bytes: Uint8Array, options?: { signal?: AbortSignal }): Promise<ReaderEngineDocument>;
  /** Release workers, caches and object URLs the engine holds; a stopped module must not leak them. */
  dispose(): Promise<void>;
};

/** The built-in parsers, behind the same boundary an external engine would implement. */
export function builtinReaderEngine(): ReaderEngine {
  return {
    engineId: "builtin-formats",
    version: "m1b",
    async parse(bytes, options) {
      if (options?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const parsed = await parseDocument(bytes, { signal: options?.signal });
      const parts = parsed.parts.map((part) => {
        const fromLayer = part.textRuns ?? [];
        const fromFixed = (part.render?.items ?? []).filter((item): item is Extract<PdfRenderItem, { k: "t" }> => item.k === "t")
          .map((item) => ({ text: item.t, x: item.x, y: item.y, ...(item.w !== undefined ? { width: item.w } : {}), ...(item.o !== undefined ? { offset: item.o } : {}) }));
        const runs = fromLayer.length ? fromLayer : fromFixed;
        return {
          id: part.id,
          kind: part.kind,
          normalized: part.normalized,
          ...(runs.length ? { runs } : {}),
        };
      });
      return { format: parsed.format, parts, warnings: [...parsed.warnings] };
    },
    async dispose() { /* the built-in parsers hold no engine state */ },
  };
}
