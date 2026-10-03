import { describe, expect, it } from "vitest";
import { NORMALIZATION_V1 } from "@manga/contracts";
import { resolveTextLocator } from "../../packages/app-core/src/domain/anchors.ts";

describe("A b5 Unicode source navigation", () => {
  it("keeps resolved code-point windows separate from DOM offsets, including quote recovery", () => {
    const text = "😀开头。中文日本語😀é。末尾";
    const quote = "中文日本語😀é";
    const locator = { kind: "text" as const, partId: "last", representationId: "revision", normalizationVersion: NORMALIZATION_V1, range: { start: 4, end: 11 }, quote: { exact: quote } };
    const resolved = resolveTextLocator(locator, { id: "revision", normalized: text, available: true });
    expect(resolved).toMatchObject({ status: "resolved", text: quote, codePointRange: { start: 4, end: 11 }, utf16Range: { start: 5, end: 13 } });
    const moved = resolveTextLocator(locator, { id: "replacement", normalized: `🦊${text}`, available: true });
    expect(moved).toMatchObject({ status: "resolved", text: quote, codePointRange: { start: 5, end: 12 }, utf16Range: { start: 7, end: 15 } });
    const ambiguous = resolveTextLocator(locator, { id: "replacement", normalized: `${text}${text}`, available: true });
    expect(ambiguous.status).toBe("needs_review");
    expect(ambiguous.codePointRange).toBeUndefined();
  });
});
