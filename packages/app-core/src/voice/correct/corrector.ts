/**
 * Adapted from HaujetZhao/asr-hotword (https://github.com/HaujetZhao/asr-hotword, commit 7e282137e780ac4096cac537bef360235d2efe43).
 * Copyright (c) 2026 HaujetZhao. Licensed under the MIT License.
 */

import type {
  DictationReplacement,
  DictionaryAliasKind,
  DictionaryCategory,
} from "@manga/contracts";
import {
  type EncodedPhonemes,
  encodePhonemes,
  fuzzySubstringSearchEncoded,
  passesEncodedBagLowerBound,
} from "./align.ts";
import { Phoneme2GramIndex } from "./index-2gram.ts";
import {
  describeReading,
  isCjkCodePoint,
  isKanaCodePoint,
  type Phoneme,
  toPhonemes,
} from "./phonemes.ts";

/** Score threshold (`>= 0.90`) for deterministic direct replacement when a term belongs to the current work or is manual. */
export const DIRECT_REPLACE_THRESHOLD = 0.9;

/** Score threshold (`0.75..0.90`, or `>= 0.90` when neither current-work nor manual) for recalling candidates into LLM polish. */
export const CANDIDATE_RECALL_THRESHOLD = 0.75;

/** Maximum number of recalled candidates passed to LLM polish per utterance. */
export const MAX_POLISH_CANDIDATES = 15;

export type CorrectorAliasEntry = {
  alias: string;
  kind: DictionaryAliasKind;
};

export type CorrectorTermEntry = {
  id: string;
  scope: "global" | "work";
  workId: string | null;
  workTitle?: string | null;
  term: string;
  category: DictionaryCategory;
  source: string;
  disabled?: boolean;
  aliases?: ReadonlyArray<CorrectorAliasEntry>;
  blocked?: ReadonlyArray<string>;
};

export type RecalledCandidate = {
  termId: string;
  term: string;
  matchedText: string;
  start: number;
  end: number;
  score: number;
  category: DictionaryCategory;
  scope: "global" | "work";
  workId: string | null;
  workTitle: string | null;
  source: string;
  readingOrOriginal: string;
};

export type CorrectionOutput = {
  rawText: string;
  correctedText: string;
  replacements: DictationReplacement[];
  candidates: RecalledCandidate[];
  elapsedMs: number;
};

type IndexedVariant = {
  surface: string;
  surfaceFolded: string;
  kind: "term" | DictionaryAliasKind;
  phonemes: Phoneme[];
  encoded: EncodedPhonemes;
  cjkCount: number;
  kanaCount: number;
  asciiAlnumCount: number;
  pureAsciiWord: boolean;
  cjkChars: Set<string>;
};

type IndexedTerm = {
  entry: CorrectorTermEntry;
  isManual: boolean;
  readingOrOriginal: string;
  blockedExact: Set<string>;
  blockedPhrases: string[];
  variants: IndexedVariant[];
};

type RawMatch = {
  termId: string;
  indexed: IndexedTerm;
  variant: IndexedVariant;
  start: number;
  end: number;
  matchedText: string;
  score: number;
  isExact: boolean;
  directEligible: boolean;
};

const COMMON_FUNCTION_BIGRAMS = new Set([
  "真是", "也是", "都是", "就是", "不是", "还是", "可是", "只是", "但是", "若是",
  "因为", "所以", "如果", "虽然", "而且", "然后", "或者", "以及", "不仅", "并且",
  "已经", "可以", "可能", "应该", "需要", "必须", "能够", "不会", "不能", "不要",
  "什么", "怎么", "为什么", "多少", "哪里", "哪个", "这些", "那些", "这个", "那个",
  "这里", "那里", "这时", "那时", "现在", "今天", "明天", "昨天", "刚才", "以后",
  "时候", "地方", "东西", "事情", "问题", "情况", "方面", "部分", "结果", "原因",
  "我们", "你们", "他们", "她们", "它们", "自己", "大家", "别人", "有人", "没人",
  "觉得", "知道", "看到", "听到", "想到", "感到", "认为", "希望", "喜欢", "开始",
  "没有", "一个", "一些", "一下", "一起", "一直", "一定", "一样", "一般", "一点",
  "出来", "起来", "下来", "过来", "回去", "进去", "出去", "上来", "下去", "回来",
]);

const STRUCTURAL_PARTICLES = new Set(["的", "了", "吗", "呢", "吧", "啊", "呀", "着", "过"]);

function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function foldSurface(text: string): string {
  return text.trim().toLowerCase();
}

function analyzeSurface(surface: string): IndexedVariant {
  const phonemes = toPhonemes(surface);
  const encoded = encodePhonemes(phonemes);

  let cjkCount = 0;
  let kanaCount = 0;
  let asciiAlnumCount = 0;
  const cjkChars = new Set<string>();
  for (let i = 0; i < surface.length; i += 1) {
    const code = surface.charCodeAt(i);
    if (isCjkCodePoint(code)) {
      cjkCount += 1;
      cjkChars.add(surface[i]!);
    } else if (isKanaCodePoint(code)) {
      kanaCount += 1;
    } else if (isAsciiWordCode(code)) {
      asciiAlnumCount += 1;
    }
  }
  const pureAsciiWord =
    cjkCount === 0 &&
    kanaCount === 0 &&
    asciiAlnumCount > 0 &&
    isAsciiWordCode(surface.charCodeAt(0)) &&
    isAsciiWordCode(surface.charCodeAt(surface.length - 1));

  return {
    surface,
    surfaceFolded: foldSurface(surface),
    kind: "term",
    phonemes,
    encoded,
    cjkCount,
    kanaCount,
    asciiAlnumCount,
    pureAsciiWord,
    cjkChars,
  };
}

function computeReadingHint(entry: CorrectorTermEntry): string {
  const aliases = entry.aliases ?? [];
  const preferred =
    aliases.find((a) => a.kind === "kana") ??
    aliases.find((a) => a.kind === "romaji") ??
    aliases.find((a) => a.kind === "alias" && a.alias !== entry.term) ??
    aliases.find((a) => a.kind === "english");
  if (preferred) return preferred.alias;
  return describeReading(entry.term);
}

export class PhoneticCorrector {
  private readonly terms = new Map<string, IndexedTerm>();
  private readonly index = new Phoneme2GramIndex();
  // Folded 2-char prefix (or 1-char for single-char surfaces) -> exact surface entries
  private readonly exactByPrefix = new Map<
    string,
    Array<{ termId: string; variantIdx: number; folded: string }>
  >();

  get size(): number {
    return this.terms.size;
  }

  clear(): void {
    this.terms.clear();
    this.index.clear();
    this.exactByPrefix.clear();
  }

  setTerms(entries: ReadonlyArray<CorrectorTermEntry>): void {
    this.clear();
    for (const entry of entries) {
      this.upsertTerm(entry);
    }
  }

  removeTerm(termId: string): void {
    const existing = this.terms.get(termId);
    if (!existing) return;
    for (const v of existing.variants) {
      if (!v.surfaceFolded) continue;
      const prefixKey = v.surfaceFolded.length >= 2 ? v.surfaceFolded.slice(0, 2) : v.surfaceFolded;
      const bucket = this.exactByPrefix.get(prefixKey);
      if (!bucket) continue;
      let write = 0;
      for (let i = 0; i < bucket.length; i += 1) {
        if (bucket[i]!.termId !== termId) {
          bucket[write] = bucket[i]!;
          write += 1;
        }
      }
      if (write === 0) this.exactByPrefix.delete(prefixKey);
      else bucket.length = write;
    }
    this.index.removeTerm(termId);
    this.terms.delete(termId);
  }

  upsertTerm(entry: CorrectorTermEntry): void {
    this.removeTerm(entry.id);
    if (entry.disabled) return;
    const canonical = entry.term.trim();
    if (!canonical) return;

    const variants: IndexedVariant[] = [];
    const seenFolded = new Set<string>();

    const addVariant = (raw: string, kind: "term" | DictionaryAliasKind) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const folded = foldSurface(trimmed);
      if (!folded || seenFolded.has(folded)) return;
      seenFolded.add(folded);
      const v = analyzeSurface(trimmed);
      v.kind = kind;
      variants.push(v);
    };

    addVariant(canonical, "term");
    if (entry.aliases) {
      for (const a of entry.aliases) {
        addVariant(a.alias, a.kind);
      }
    }

    const blockedExact = new Set<string>();
    const blockedPhrases: string[] = [];
    if (entry.blocked) {
      for (const b of entry.blocked) {
        const f = foldSurface(b);
        if (!f) continue;
        blockedExact.add(f);
        if (f.length >= 2) blockedPhrases.push(f);
      }
    }

    const indexed: IndexedTerm = {
      entry,
      isManual: entry.source === "manual",
      readingOrOriginal: computeReadingHint(entry),
      blockedExact,
      blockedPhrases,
      variants,
    };

    this.terms.set(entry.id, indexed);

    // Register exact surface buckets by 2-char prefix (or 1-char for single-char entries)
    for (let vIdx = 0; vIdx < variants.length; vIdx += 1) {
      const folded = variants[vIdx]!.surfaceFolded;
      if (!folded) continue;
      const prefixKey = folded.length >= 2 ? folded.slice(0, 2) : folded;
      let bucket = this.exactByPrefix.get(prefixKey);
      if (!bucket) {
        bucket = [];
        this.exactByPrefix.set(prefixKey, bucket);
      }
      bucket.push({ termId: entry.id, variantIdx: vIdx, folded });
    }

    // Register phonetic 2-gram postings (only variants eligible for phonetic recall need 2-gram indexing)
    const phoneticVariants = variants.map((v) =>
      this.isVariantPhoneticEligible(v) ? v.phonemes : [],
    );
    this.index.upsertTerm(entry.id, phoneticVariants);
  }

  private isVariantPhoneticEligible(v: IndexedVariant): boolean {
    if (v.phonemes.length === 0) return false;
    // 1-char CJK terms and <= 3-char pure ASCII words only match exact surface/alias, never fuzzy!
    if (v.cjkCount === 1 && v.kanaCount === 0 && v.asciiAlnumCount === 0) return false;
    if (v.cjkCount === 0 && v.kanaCount === 0 && v.asciiAlnumCount <= 3) return false;
    return true;
  }

  private isBlocked(
    indexed: IndexedTerm,
    textFolded: string,
    start: number,
    end: number,
    matchedText: string,
  ): boolean {
    if (indexed.blockedExact.size === 0) return false;
    const matchedFolded = foldSurface(matchedText);
    if (indexed.blockedExact.has(matchedFolded)) return true;

    for (const phrase of indexed.blockedPhrases) {
      if (phrase.length <= matchedFolded.length) continue;
      const winStart = Math.max(0, start - phrase.length);
      const winEnd = Math.min(textFolded.length, end + phrase.length);
      const slice = textFolded.slice(winStart, winEnd);
      let idx = slice.indexOf(phrase);
      while (idx !== -1) {
        const absStart = winStart + idx;
        const absEnd = absStart + phrase.length;
        if (absStart <= start && end <= absEnd) return true;
        idx = slice.indexOf(phrase, idx + 1);
      }
    }
    return false;
  }

  private isDirectReplaceScope(entry: CorrectorTermEntry, currentWorkId: string | null): boolean {
    if (entry.source === "manual") return true;
    if (currentWorkId && entry.scope === "work" && entry.workId === currentWorkId) return true;
    return false;
  }

  /**
   * Adjusts raw phonetic alignment score to prevent false modifications on short ordinary Chinese words
   * in non-entity sentences while preserving candidate recall (`>= 0.75`) for LLM polish.
   */
  private adjustPhoneticScore(
    rawScore: number,
    matchedText: string,
    indexed: IndexedTerm,
    variant: IndexedVariant,
  ): number {
    if (variant.cjkCount === 2 && variant.kanaCount === 0 && variant.asciiAlnumCount === 0) {
      const trimmed = matchedText.trim();
      if (COMMON_FUNCTION_BIGRAMS.has(trimmed)) {
        return 0;
      }
      // Do not consume grammatical particles (`的/了/吗/呢/吧/...`) into a 2-char entity unless present in the term
      for (let i = 0; i < trimmed.length; i += 1) {
        const ch = trimmed[i]!;
        if (
          STRUCTURAL_PARTICLES.has(ch) &&
          !variant.cjkChars.has(ch) &&
          !indexed.variants[0]!.cjkChars.has(ch)
        ) {
          return 0;
        }
      }
      // Count shared CJK characters between matchedText and canonical term / matched variant
      let shared = 0;
      const canonicalChars = indexed.variants[0]!.cjkChars;
      for (let i = 0; i < trimmed.length; i += 1) {
        const ch = trimmed[i]!;
        if (variant.cjkChars.has(ch) || canonicalChars.has(ch)) {
          shared += 1;
        }
      }
      // Zero-char-overlap 2-syllable homophones (e.g. "签下" vs "千夏", "绳带" vs "神代", "心也" vs "星野")
      // frequently collide with everyday words in non-entity sentences: cap at 0.88 so they enter
      // `candidates` (`>= 0.75`) for context-aware LLM polish instead of blind deterministic replacement!
      if (shared === 0) {
        return Math.min(rawScore, 0.88);
      }
    }
    return rawScore;
  }

  correct(
    rawText: string,
    options?: {
      currentWorkId?: string | null;
      maxCandidates?: number;
    },
  ): CorrectionOutput {
    const t0 = performance.now();
    if (!rawText || this.terms.size === 0) {
      return {
        rawText,
        correctedText: rawText,
        replacements: [],
        candidates: [],
        elapsedMs: performance.now() - t0,
      };
    }

    const currentWorkId = options?.currentWorkId ?? null;
    const maxCandidates = options?.maxCandidates ?? MAX_POLISH_CANDIDATES;
    const textLower = rawText.toLowerCase();
    const allMatches: RawMatch[] = [];

    // Phase 1: Exact surface & alias scan (respecting ASCII word boundaries)
    if (textLower.length === rawText.length) {
      const checkBucket = (
        pos: number,
        bucket: Array<{ termId: string; variantIdx: number; folded: string }> | undefined,
      ) => {
        if (!bucket) return;
        for (let b = 0; b < bucket.length; b += 1) {
          const item = bucket[b]!;
          const end = pos + item.folded.length;
          if (end > textLower.length) continue;
          if (item.folded.length > 2 && !textLower.startsWith(item.folded, pos)) continue;

          const indexed = this.terms.get(item.termId);
          if (!indexed) continue;
          const variant = indexed.variants[item.variantIdx]!;

          // Enforce ASCII word boundaries so e.g. "cat" does not match inside "category"
          if (variant.pureAsciiWord) {
            if (pos > 0 && isAsciiWordCode(rawText.charCodeAt(pos - 1))) continue;
            if (end < rawText.length && isAsciiWordCode(rawText.charCodeAt(end))) continue;
          }

          const matchedText = rawText.slice(pos, end);
          if (this.isBlocked(indexed, textLower, pos, end, matchedText)) continue;

          allMatches.push({
            termId: item.termId,
            indexed,
            variant,
            start: pos,
            end,
            matchedText,
            score: 1.0,
            isExact: true,
            // Rule (§4.8): exact match with term or alias -> direct replacement!
            directEligible: true,
          });
        }
      };

      for (let pos = 0; pos < textLower.length; pos += 1) {
        checkBucket(pos, this.exactByPrefix.get(textLower[pos]!));
        if (pos + 1 < textLower.length) {
          checkBucket(pos, this.exactByPrefix.get(textLower.slice(pos, pos + 2)));
        }
      }
    }

    // Phase 2: 2-gram Inverted Index Coarse Recall + Encoded Laminar Bag Pre-check + Constrained Local DP Fine Alignment
    const inputPhonemes = toPhonemes(rawText);
    if (inputPhonemes.length > 0) {
      const inputEncoded = encodePhonemes(inputPhonemes);
      const searchThreshold = CANDIDATE_RECALL_THRESHOLD;

      this.index.forEachCandidate(
        inputPhonemes,
        (termId, vIdx, anchorsBuf, anchorOffset, anchorCount) => {
          const indexed = this.terms.get(termId);
          if (!indexed) return;
          const variant = indexed.variants[vIdx];
          if (!variant) return;

          const hwEncoded = variant.encoded;
          const hwLen = hwEncoded.length;
          if (hwLen === 0) return;

          const scopeDirect = this.isDirectReplaceScope(indexed.entry, currentWorkId);
          const maxAllowedDist = hwLen * (1.0 - searchThreshold);
          const margin = Math.max(5, Math.ceil(hwLen * 0.35));

          for (let a = 0; a < anchorCount; a += 1) {
            const approxStart = anchorsBuf[anchorOffset + a]!;
            const winStart = Math.max(0, approxStart - margin);
            const winEnd = Math.min(inputPhonemes.length, approxStart + hwLen + margin);
            if (winEnd <= winStart) continue;

            if (
              !passesEncodedBagLowerBound(
                hwEncoded,
                inputEncoded,
                winStart,
                winEnd,
                maxAllowedDist,
              )
            ) {
              continue;
            }

            const aligned = fuzzySubstringSearchEncoded(
              hwEncoded,
              inputEncoded,
              winStart,
              winEnd,
              searchThreshold,
            );

            for (let m = 0; m < aligned.length; m += 1) {
              const seg = aligned[m]!;
              const charStart = inputPhonemes[seg.startPhonemeIdx]!.charStart;
              const charEnd = inputPhonemes[seg.endPhonemeIdx - 1]!.charEnd;
              const matchedText = rawText.slice(charStart, charEnd);

              if (this.isBlocked(indexed, textLower, charStart, charEnd, matchedText)) {
                continue;
              }

              const isSurfaceSameAsVariant = foldSurface(matchedText) === variant.surfaceFolded;
              // Exact kana <-> romaji match (e.g. `かみしろはるか` vs `Kamishiro Haruka`) has score 1.0
              const isKanaRomajiExact =
                seg.score >= 0.999999 &&
                (variant.kind === "kana" || variant.kind === "romaji" || variant.kanaCount > 0);

              const effectiveScore =
                isSurfaceSameAsVariant || isKanaRomajiExact
                  ? 1.0
                  : this.adjustPhoneticScore(seg.score, matchedText, indexed, variant);

              if (effectiveScore + 1e-9 < CANDIDATE_RECALL_THRESHOLD) continue;

              const isExact = isSurfaceSameAsVariant || isKanaRomajiExact;
              const directEligible =
                isExact || (effectiveScore + 1e-9 >= DIRECT_REPLACE_THRESHOLD && scopeDirect);

              allMatches.push({
                termId,
                indexed,
                variant,
                start: charStart,
                end: charEnd,
                matchedText,
                score: effectiveScore,
                isExact,
                directEligible,
              });
            }
          }
        },
      );
    }

    if (allMatches.length === 0) {
      return {
        rawText,
        correctedText: rawText,
        replacements: [],
        candidates: [],
        elapsedMs: performance.now() - t0,
      };
    }

    // Priority sort:
    // 1. Higher score first
    // 2. Longer character span first (prevents shorter substring term from corrupting a longer compound term!)
    // 3. Manual / current-work priority tie-breaker
    allMatches.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 1e-6) return b.score - a.score;
      const lenDiff = (b.end - b.start) - (a.end - a.start);
      if (lenDiff !== 0) return lenDiff;
      const aPrio =
        (a.indexed.isManual ? 2 : 0) +
        (currentWorkId && a.indexed.entry.workId === currentWorkId ? 1 : 0);
      const bPrio =
        (b.indexed.isManual ? 2 : 0) +
        (currentWorkId && b.indexed.entry.workId === currentWorkId ? 1 : 0);
      return bPrio - aPrio;
    });

    // Resolve non-overlapping direct replacements
    const acceptedDirect: RawMatch[] = [];
    const occupied: Array<{ start: number; end: number }> = [];

    for (let i = 0; i < allMatches.length; i += 1) {
      const m = allMatches[i]!;
      if (!m.directEligible) continue;

      let overlaps = false;
      for (let r = 0; r < occupied.length; r += 1) {
        const occ = occupied[r]!;
        if (!(m.end <= occ.start || m.start >= occ.end)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      // Mark span occupied even when matchedText === canonical term so shorter overlapping terms cannot clobber it!
      occupied.push({ start: m.start, end: m.end });
      if (m.matchedText !== m.indexed.entry.term) {
        acceptedDirect.push(m);
      }
    }

    // Collect non-direct recalled candidates (`0.75 <= score < 0.90`, or `>= 0.90` outside current-work/manual),
    // excluding terms already deterministically applied at that span.
    const candidates: RecalledCandidate[] = [];
    const seenCandidateTerms = new Set<string>();
    for (let i = 0; i < allMatches.length; i += 1) {
      if (candidates.length >= maxCandidates) break;
      const m = allMatches[i]!;
      if (m.directEligible) continue;
      if (m.score + 1e-9 < CANDIDATE_RECALL_THRESHOLD) continue;
      if (seenCandidateTerms.has(m.termId)) continue;

      // Skip if an accepted higher-confidence direct replacement already claimed this exact span
      let claimedByHigher = false;
      for (let r = 0; r < occupied.length; r += 1) {
        const occ = occupied[r]!;
        if (!(m.end <= occ.start || m.start >= occ.end)) {
          claimedByHigher = true;
          break;
        }
      }
      if (claimedByHigher) continue;

      seenCandidateTerms.add(m.termId);
      candidates.push({
        termId: m.termId,
        term: m.indexed.entry.term,
        matchedText: m.matchedText,
        start: m.start,
        end: m.end,
        score: Number(m.score.toFixed(4)),
        category: m.indexed.entry.category,
        scope: m.indexed.entry.scope,
        workId: m.indexed.entry.workId,
        workTitle: m.indexed.entry.workTitle ?? null,
        source: m.indexed.entry.source,
        readingOrOriginal: m.indexed.readingOrOriginal,
      });
    }

    if (acceptedDirect.length === 0) {
      return {
        rawText,
        correctedText: rawText,
        replacements: [],
        candidates,
        elapsedMs: performance.now() - t0,
      };
    }

    // Apply accepted replacements left-to-right to build `correctedText` and exact post-replacement spans
    acceptedDirect.sort((a, b) => a.start - b.start);
    let cursor = 0;
    let correctedText = "";
    const replacements: DictationReplacement[] = [];

    for (let i = 0; i < acceptedDirect.length; i += 1) {
      const m = acceptedDirect[i]!;
      correctedText += rawText.slice(cursor, m.start);
      const repStart = correctedText.length;
      const replacement = m.indexed.entry.term;
      correctedText += replacement;
      const repEnd = correctedText.length;
      cursor = m.end;

      replacements.push({
        start: repStart,
        end: repEnd,
        original: m.matchedText,
        replacement,
        termId: m.termId,
        term: replacement,
        category: m.indexed.entry.category,
        score: Number(m.score.toFixed(4)),
      });
    }
    correctedText += rawText.slice(cursor);

    return {
      rawText,
      correctedText,
      replacements,
      candidates,
      elapsedMs: performance.now() - t0,
    };
  }
}
