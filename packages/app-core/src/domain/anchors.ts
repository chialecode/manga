import {
  type AnchorResolveResult,
  type SourceLocator,
  type TextLocator,
  MangaError,
} from "@manga/contracts";
import { codePointLength, findQuoteMatches, sliceCodePoints } from "./text.ts";

export { findQuoteMatches };

function codePointRangeToUtf16(text: string, start: number, end: number): { start: number; end: number } {
  const chars = [...text];
  return {
    start: chars.slice(0, start).join("").length,
    end: chars.slice(0, end).join("").length,
  };
}

function resolveByQuote(locator: TextLocator, normalized: string): AnchorResolveResult {
  const exact = locator.quote?.exact;
  if (!exact) return { status: "unresolved", reason: "quote missing" };
  const matches = findQuoteMatches(normalized, exact).map((item) => ({
    ...item,
    text: sliceCodePoints(normalized, item.start, item.end),
  }));
  if (matches.length === 1) {
    const match = matches[0]!;
    return { status: "resolved", text: match.text, codePointRange: { start: match.start, end: match.end }, utf16Range: codePointRangeToUtf16(normalized, match.start, match.end) };
  }
  if (matches.length > 1) return { status: "needs_review", candidates: matches, reason: "ambiguous duplicate sentence" };
  return { status: "unresolved", reason: "quote not found" };
}

export function resolveTextLocator(
  locator: TextLocator,
  representation: { id: string; normalized: string; available: boolean; kind?: "text" | "scan" | "image" },
  options: { resourceExists?: boolean; revisionExists?: boolean; capability?: boolean } = {},
): AnchorResolveResult {
  if (options.resourceExists === false) return { status: "missing_resource" };
  if (options.revisionExists === false) return { status: "missing_revision" };
  if (options.capability === false || representation.kind === "scan" || representation.kind === "image") {
    return { status: "missing_capability", reason: "this page has no OCR text layer" };
  }
  if (!representation.available) return { status: "unresolved", reason: "representation unavailable" };
  if (representation.id !== locator.representationId && locator.quote?.exact) return resolveByQuote(locator, representation.normalized);
  const { start, end } = locator.range;
  if (end > codePointLength(representation.normalized)) {
    return locator.quote?.exact ? resolveByQuote(locator, representation.normalized) : { status: "unresolved", reason: "range past end" };
  }
  const text = sliceCodePoints(representation.normalized, start, end);
  if (locator.quote?.exact && text !== locator.quote.exact) return resolveByQuote(locator, representation.normalized);
  return { status: "resolved", text, codePointRange: { start, end }, utf16Range: codePointRangeToUtf16(representation.normalized, start, end) };
}

export function assertTextLocator(locator: SourceLocator): TextLocator {
  if (locator.kind !== "text") throw new MangaError("VALIDATION_ERROR", "this reading surface only resolves text or page locators");
  return locator;
}
