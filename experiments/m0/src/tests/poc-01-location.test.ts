import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { generateFixtures } from "../fixtures/generate.ts";
import { parseEpub } from "../domain/epub.ts";
import {
  codePointLength,
  codePointRangeToUtf16,
  createTextLocator,
  decodeTextBuffer,
  findQuoteMatches,
  normalizeText,
  resolveTextLocator,
  sliceCodePoints,
  utf16RangeToCodePoints,
} from "../domain/text-locator.ts";
import { fixturesDir } from "../env.ts";
import { writeCases } from "./helpers.ts";
import type { CaseResult } from "@manga/contracts";

const cases: CaseResult[] = [];

test("POC-01 text and EPUB locators", async () => {
  const generated = await generateFixtures();
  const bomFile = generated.items.find((item) => item.id === "utf8-bom.txt")!;
  const mixedFile = generated.items.find((item) => item.id === "zh-ja-emoji.txt")!;
  const bom = decodeTextBuffer(fs.readFileSync(bomFile.path), "utf-8");
  assert.equal(bom.bom, true);
  const normalized = normalizeText(bom.text);
  const sentence = "春が来た。";
  const start = findQuoteMatches(normalized.normalized, sentence)[0]!.start;
  const locator = createTextLocator({
    partId: "p1",
    representationId: "rep1",
    normalized: normalized.normalized,
    start,
    end: start + codePointLength(sentence),
  });
  const resolved = resolveTextLocator(locator, {
    id: "rep1",
    normalized: normalized.normalized,
    parserVersion: normalized.parserVersion,
    available: true,
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.text, sentence);
  const utf16 = codePointRangeToUtf16(normalized.normalized, locator.range.start, locator.range.end);
  const roundTrip = utf16RangeToCodePoints(normalized.normalized, utf16.start, utf16.end);
  assert.deepEqual(roundTrip, locator.range);
  cases.push({
    caseId: "POC-01/utf8-bom",
    poc: "POC-01",
    title: "UTF-8 BOM stripped, code point range round-trips to UTF-16",
    status: "passed",
    expected: sentence,
    actual: resolved.text,
    kind: "automated",
  });

  const mixed = normalizeText(fs.readFileSync(mixedFile.path, "utf8"));
  const emoji = "🙂‍↔️";
  const emojiAt = mixed.normalized.indexOf("🙂");
  assert.ok(emojiAt >= 0);
  const emojiCp = codePointLength(mixed.normalized.slice(0, mixed.normalized.indexOf(emoji)));
  const emojiLoc = createTextLocator({
    partId: "p1",
    representationId: "rep-mix",
    normalized: mixed.normalized,
    start: emojiCp,
    end: emojiCp + codePointLength(emoji),
  });
  const emojiResolved = resolveTextLocator(emojiLoc, {
    id: "rep-mix",
    normalized: mixed.normalized,
    parserVersion: mixed.parserVersion,
    available: true,
  });
  assert.equal(emojiResolved.status, "resolved");
  assert.equal(emojiResolved.text, emoji);
  cases.push({
    caseId: "POC-01/emoji-cluster",
    poc: "POC-01",
    title: "emoji/ZWJ cluster uses code points not JS UTF-16 indexes",
    status: "passed",
    expected: emoji,
    actual: emojiResolved.text,
    kind: "automated",
  });

  const duplicate = "同一句同一句";
  const dupMatches = findQuoteMatches(mixed.normalized, duplicate);
  assert.ok(dupMatches.length >= 1);
  const first = createTextLocator({
    partId: "p1",
    representationId: "rep-old",
    normalized: mixed.normalized,
    start: dupMatches[0]!.start,
    end: dupMatches[0]!.end,
  });
  const v2 = normalizeText(mixed.normalized, "novel-parser-v2-spacing");
  const afterRuleChange = resolveTextLocator(first, {
    id: "rep-new",
    normalized: v2.normalized,
    parserVersion: v2.parserVersion,
    available: true,
  });
  assert.ok(afterRuleChange.status === "resolved" || afterRuleChange.status === "needs_review");
  const ambiguous = resolveTextLocator({
    ...first,
    representationId: "other",
    quote: { exact: duplicate },
  }, {
    id: "other",
    normalized: `${duplicate}\n${duplicate}`,
    parserVersion: "novel-parser-v1",
    available: true,
  });
  assert.equal(ambiguous.status, "needs_review");
  assert.ok((ambiguous.candidates?.length ?? 0) >= 2);
  cases.push({
    caseId: "POC-01/duplicate-needs-review",
    poc: "POC-01",
    title: "duplicate sentence does not silently pick the first match",
    status: "passed",
    expected: "needs_review",
    actual: ambiguous.status,
    kind: "automated",
  });

  const epubPath = generated.items.find((item) => item.id === "basic.epub")!.path;
  const epub = parseEpub(fs.readFileSync(epubPath));
  assert.ok(epub.parts.length >= 2);
  const chapter2 = epub.parts[1]!;
  const quote = sliceCodePoints(chapter2.text.normalized, 0, 6);
  const chapterLocator = createTextLocator({
    partId: chapter2.id,
    representationId: "epub-rep",
    normalized: chapter2.text.normalized,
    start: 0,
    end: codePointLength(quote),
  });
  const chapterResolved = resolveTextLocator(chapterLocator, {
    id: "epub-rep",
    normalized: chapter2.text.normalized,
    parserVersion: chapter2.text.parserVersion,
    available: true,
  });
  assert.equal(chapterResolved.status, "resolved");
  cases.push({
    caseId: "POC-01/epub-chapter",
    poc: "POC-01",
    title: "EPUB multi-chapter text locator",
    status: "passed",
    expected: quote,
    actual: chapterResolved.text,
    kind: "automated",
  });

  const illegal = generated.items.find((item) => item.id === "illegal-path.epub")!.path;
  assert.throws(() => parseEpub(fs.readFileSync(illegal)));
  const huge = generated.items.find((item) => item.id === "huge-entry.epub")!.path;
  assert.throws(() => parseEpub(fs.readFileSync(huge)));
  cases.push({
    caseId: "POC-01/epub-reject",
    poc: "POC-01",
    title: "illegal path and oversized EPUB entries rejected",
    status: "passed",
    expected: "rejected",
    actual: "rejected",
    kind: "automated",
  });

  writeCases("poc-01", cases);
  assert.ok(fs.existsSync(fixturesDir()) || generated.root);
});
