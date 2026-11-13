/**
 * Adapted from HaujetZhao/asr-hotword (https://github.com/HaujetZhao/asr-hotword, commit 7e282137e780ac4096cac537bef360235d2efe43).
 * Copyright (c) 2026 HaujetZhao. Licensed under the MIT License.
 */

import { canonicalZhPhoneme } from "./align.ts";
import { type Phoneme } from "./phonemes.ts";

type IndexPosting = {
  termId: string;
  variantIdx: number;
  anchorPhonemeIdx: number;
};

export type ZhSyllableUnit = {
  init: string;
  fin: string;
  full: string;
  phonemeIdx: number;
};

/**
 * Extracts fuzzy-canonical Mandarin syllables and Latin/numeric character 2-grams from a phoneme list.
 */
export function extractIndexKeys(
  phonemes: readonly Phoneme[],
  mode: "index" | "query",
): Array<{ key: string; phonemeIdx: number }> {
  const keys: Array<{ key: string; phonemeIdx: number }> = [];

  // 1. Collect Mandarin syllables in order
  const zhSyllables: ZhSyllableUnit[] = [];
  let i = 0;
  while (i < phonemes.length) {
    const p = phonemes[i]!;
    if (p.lang === "zh") {
      const startIdx = i;
      let init = "";
      let fin = "";
      while (i < phonemes.length && phonemes[i]!.lang === "zh") {
        const cur = phonemes[i]!;
        if (cur.isWordStart && i > startIdx) break;
        if (!cur.isTone) {
          if (!init && !fin && i === startIdx && cur.isWordStart) {
            // Determine whether cur is initial or zero-initial final:
            // If next phoneme is also zh and non-tone on same char, cur is initial; otherwise check value.
            const next = phonemes[i + 1];
            if (next && next.lang === "zh" && !next.isTone && !next.isWordStart) {
              init = canonicalZhPhoneme(cur.value);
            } else {
              fin = canonicalZhPhoneme(cur.value);
            }
          } else {
            fin = canonicalZhPhoneme(cur.value);
          }
        }
        const ended = cur.isWordEnd;
        i += 1;
        if (ended) break;
      }
      const full = `${init}:${fin}`;
      zhSyllables.push({ init, fin, full, phonemeIdx: startIdx });
    } else {
      i += 1;
    }
  }

  // Adjacent syllable 2-grams (`zh2:s0|s1`)
  for (let s = 0; s + 1 < zhSyllables.length; s += 1) {
    const a = zhSyllables[s]!;
    const b = zhSyllables[s + 1]!;
    keys.push({ key: `zh2:${a.full}|${b.full}`, phonemeIdx: a.phonemeIdx });

    // Sub-syllable cross 2-grams so 2-syllable words with 1 non-fuzzy initial/final typo still recall:
    // On query we emit them for all adjacent pairs; on index we emit them ONLY for 2-syllable variants
    // (3+ syllable variants already have multiple syllable pairs + skip-1 pairs!).
    if (mode === "query" || zhSyllables.length === 2) {
      if (a.fin) {
        keys.push({ key: `zhp:f:${a.fin}|${b.full}`, phonemeIdx: a.phonemeIdx });
      }
      if (b.fin) {
        keys.push({ key: `zhp:${a.full}|f:${b.fin}`, phonemeIdx: a.phonemeIdx });
      }
    }
  }

  // Skip-1 syllable 2-grams (`zhs:s0|s2`) so a 3+ syllable entity with a corrupted middle syllable recalls
  for (let s = 0; s + 2 < zhSyllables.length; s += 1) {
    const a = zhSyllables[s]!;
    const c = zhSyllables[s + 2]!;
    keys.push({ key: `zhs:${a.full}|${c.full}`, phonemeIdx: a.phonemeIdx });
  }

  // 2. Collect Latin / Romaji / numeric character 2-grams
  let k = 0;
  while (k < phonemes.length) {
    const p = phonemes[k]!;
    if (p.lang === "en" || p.lang === "num") {
      const runStart = k;
      while (k < phonemes.length && (phonemes[k]!.lang === "en" || phonemes[k]!.lang === "num")) {
        k += 1;
      }
      const runLen = k - runStart;
      // For indexed variants, index every 2nd char 2-gram plus final 2-gram to keep postings compact;
      // for queries, emit every char 2-gram so any uncorrupted 2-char window hits.
      if (runLen >= 2) {
        const step = mode === "index" && runLen >= 6 ? 2 : 1;
        for (let r = runStart; r + 1 < k; r += step) {
          const c0 = phonemes[r]!.value;
          const c1 = phonemes[r + 1]!.value;
          keys.push({ key: `en2:${c0}${c1}`, phonemeIdx: r });
        }
        if (step > 1 && (k - 2 - runStart) % step !== 0) {
          const r = k - 2;
          keys.push({ key: `en2:${phonemes[r]!.value}${phonemes[r + 1]!.value}`, phonemeIdx: r });
        }
      }
    } else {
      k += 1;
    }
  }

  return keys;
}

type InternalPosting = {
  slotId: number;
  termId: string;
  variantIdx: number;
  anchorPhonemeIdx: number;
};

type SlotMeta = {
  termId: string;
  variantIdx: number;
  active: boolean;
};

const MAX_INLINE_ANCHORS = 8;

/**
 * Fuzzy-canonical 2-gram inverted index supporting incremental `upsertTerm` and `removeTerm`,
 * plus zero-allocation generation-stamped `forEachCandidate` queries for 10k+ term scales.
 */
export class Phoneme2GramIndex {
  private readonly buckets: Map<string, InternalPosting[]> = new Map();
  private readonly termKeys: Map<string, Set<string>> = new Map();
  private readonly termSlots: Map<string, number[]> = new Map();
  private readonly slots: SlotMeta[] = [];
  private readonly freeSlots: number[] = [];

  private slotCap = 256;
  private slotStamp: Int32Array = new Int32Array(256);
  private slotAnchorCount: Uint8Array = new Uint8Array(256);
  private slotAnchors: Int32Array = new Int32Array(256 * MAX_INLINE_ANCHORS);
  private touchedSlots: Int32Array = new Int32Array(256);
  private queryGen = 1;

  get termCount(): number {
    return this.termKeys.size;
  }

  clear(): void {
    this.buckets.clear();
    this.termKeys.clear();
    this.termSlots.clear();
    this.slots.length = 0;
    this.freeSlots.length = 0;
  }

  private allocSlot(termId: string, variantIdx: number): number {
    let slotId: number;
    if (this.freeSlots.length > 0) {
      slotId = this.freeSlots.pop()!;
      this.slots[slotId] = { termId, variantIdx, active: true };
    } else {
      slotId = this.slots.length;
      this.slots.push({ termId, variantIdx, active: true });
      if (slotId >= this.slotCap) {
        while (this.slotCap <= slotId) {
          this.slotCap *= 2;
        }
        this.slotStamp = new Int32Array(this.slotCap);
        this.slotAnchorCount = new Uint8Array(this.slotCap);
        this.slotAnchors = new Int32Array(this.slotCap * MAX_INLINE_ANCHORS);
        this.touchedSlots = new Int32Array(this.slotCap);
        this.queryGen = 1;
      }
    }
    return slotId;
  }

  removeTerm(termId: string): void {
    const keys = this.termKeys.get(termId);
    if (keys) {
      for (const key of keys) {
        const list = this.buckets.get(key);
        if (!list) continue;
        let write = 0;
        for (let i = 0; i < list.length; i += 1) {
          if (list[i]!.termId !== termId) {
            list[write] = list[i]!;
            write += 1;
          }
        }
        if (write === 0) {
          this.buckets.delete(key);
        } else {
          list.length = write;
        }
      }
      this.termKeys.delete(termId);
    }

    const allocated = this.termSlots.get(termId);
    if (allocated) {
      for (let i = 0; i < allocated.length; i += 1) {
        const s = allocated[i]!;
        if (this.slots[s]) {
          this.slots[s]!.active = false;
        }
        this.freeSlots.push(s);
      }
      this.termSlots.delete(termId);
    }
  }

  upsertTerm(termId: string, variantPhonemes: ReadonlyArray<readonly Phoneme[]>): void {
    this.removeTerm(termId);
    const recordedKeys = new Set<string>();
    const allocatedSlots: number[] = [];

    for (let vIdx = 0; vIdx < variantPhonemes.length; vIdx += 1) {
      const phons = variantPhonemes[vIdx]!;
      if (phons.length === 0) continue;
      const extracted = extractIndexKeys(phons, "index");
      if (extracted.length === 0) continue;

      const slotId = this.allocSlot(termId, vIdx);
      allocatedSlots.push(slotId);

      const seenInVariant = new Set<string>();
      for (const { key, phonemeIdx } of extracted) {
        const dedupeTag = `${key}@${phonemeIdx}`;
        if (seenInVariant.has(dedupeTag)) continue;
        seenInVariant.add(dedupeTag);

        let list = this.buckets.get(key);
        if (!list) {
          list = [];
          this.buckets.set(key, list);
        }
        list.push({
          slotId,
          termId,
          variantIdx: vIdx,
          anchorPhonemeIdx: phonemeIdx,
        });
        recordedKeys.add(key);
      }
    }

    if (recordedKeys.size > 0) {
      this.termKeys.set(termId, recordedKeys);
    }
    if (allocatedSlots.length > 0) {
      this.termSlots.set(termId, allocatedSlots);
    }
  }

  /**
   * Zero-allocation coarse recall: invokes `visitor(termId, variantIdx, anchorsBuf, anchorOffset, anchorCount)`
   * for each recalled `(termId, variantIdx)` using pre-allocated TypedArrays.
   */
  forEachCandidate(
    inputPhonemes: readonly Phoneme[],
    visitor: (
      termId: string,
      variantIdx: number,
      anchorsBuf: Int32Array,
      anchorOffset: number,
      anchorCount: number,
    ) => void,
  ): void {
    if (inputPhonemes.length === 0 || this.buckets.size === 0) return;

    this.queryGen += 1;
    if (this.queryGen >= 0x7fffffff) {
      this.slotStamp.fill(0);
      this.queryGen = 1;
    }
    const gen = this.queryGen;
    const stamp = this.slotStamp;
    const counts = this.slotAnchorCount;
    const anchors = this.slotAnchors;
    const touched = this.touchedSlots;
    let touchedLen = 0;

    const queryKeys = extractIndexKeys(inputPhonemes, "query");
    for (let q = 0; q < queryKeys.length; q += 1) {
      const { key, phonemeIdx: inputIdx } = queryKeys[q]!;
      const postings: InternalPosting[] | undefined = this.buckets.get(key);
      if (!postings) continue;

      for (let p = 0; p < postings.length; p += 1) {
        const post: InternalPosting = postings[p]!;
        const slotId = post.slotId;
        const approxStart = inputIdx - post.anchorPhonemeIdx;
        const base = slotId * MAX_INLINE_ANCHORS;

        if (stamp[slotId] !== gen) {
          stamp[slotId] = gen;
          counts[slotId] = 1;
          anchors[base] = approxStart;
          touched[touchedLen++] = slotId;
        } else {
          const c = counts[slotId]!;
          if (c < MAX_INLINE_ANCHORS) {
            let near = false;
            for (let a = 0; a < c; a += 1) {
              if (Math.abs(anchors[base + a]! - approxStart) < 5) {
                near = true;
                break;
              }
            }
            if (!near) {
              anchors[base + c] = approxStart;
              counts[slotId] = c + 1;
            }
          }
        }
      }
    }

    for (let t = 0; t < touchedLen; t += 1) {
      const slotId = touched[t]!;
      const meta = this.slots[slotId];
      if (!meta || !meta.active) continue;
      visitor(
        meta.termId,
        meta.variantIdx,
        anchors,
        slotId * MAX_INLINE_ANCHORS,
        counts[slotId]!,
      );
    }
  }

  /**
   * Recalls `(termId, variantIdx)` candidates with deduplicated approximate start phoneme positions.
   */
  query(inputPhonemes: readonly Phoneme[]): Map<string, Map<number, number[]>> {
    const hits = new Map<string, Map<number, number[]>>();
    this.forEachCandidate(inputPhonemes, (termId, variantIdx, buf, offset, count) => {
      let byVariant = hits.get(termId);
      if (!byVariant) {
        byVariant = new Map<number, number[]>();
        hits.set(termId, byVariant);
      }
      const list: number[] = [];
      for (let i = 0; i < count; i += 1) {
        list.push(buf[offset + i]!);
      }
      byVariant.set(variantIdx, list);
    });
    return hits;
  }
}
