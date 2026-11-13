/**
 * Adapted from HaujetZhao/asr-hotword (https://github.com/HaujetZhao/asr-hotword, commit 7e282137e780ac4096cac537bef360235d2efe43).
 * Copyright (c) 2026 HaujetZhao. Licensed under the MIT License.
 */

import { type Phoneme, toPhonemes } from "./phonemes.ts";

/** Substitution cost when two Mandarin tones differ (fixes upstream `h_p && i_p` check). */
export const TONE_MISMATCH_COST = 0.4;

/** Substitution cost for Mandarin fuzzy phoneme pairs (`z/zh`, `c/ch`, `s/sh`, `n/l`, `an/ang`, `en/eng`, `in/ing`, etc.). */
export const FUZZY_PHONEME_COST = 0.5;

/**
 * Canonicalizes a Mandarin phoneme so fuzzy-equivalent phonemes hash to the exact same key in O(1).
 */
export function canonicalZhPhoneme(value: string): string {
  switch (value) {
    case "zh":
      return "z";
    case "ch":
      return "c";
    case "sh":
      return "s";
    case "l":
      return "n";
    case "h":
      return "f";
    case "ang":
      return "an";
    case "eng":
      return "en";
    case "ing":
      return "in";
    case "iang":
      return "ian";
    case "uang":
      return "uan";
    case "uo":
      return "o";
    default:
      return value;
  }
}

const EXACT_ID_BY_TOKEN = new Map<string, number>();
let nextExactId = 1;

const CANON_ID_BY_TOKEN = new Map<string, number>();
let nextCanonId = 1;

export type EncodedPhonemes = {
  length: number;
  exactIds: Int32Array;
  /** `-1` for Mandarin tone, `> 0` for Mandarin fuzzy-canonical initial/final, `0` for non-fuzzy (`en`/`num`/`other`). */
  canonIds: Int32Array;
  /** Bit 1 = `isWordStart`, Bit 2 = `isWordEnd`. */
  flags: Uint8Array;
};

function internExactPhonemeId(p: Phoneme): number {
  const key = `${p.lang}:${p.isTone ? 1 : 0}:${p.value}`;
  let id = EXACT_ID_BY_TOKEN.get(key);
  if (id === undefined) {
    id = nextExactId++;
    EXACT_ID_BY_TOKEN.set(key, id);
  }
  return id;
}

function internZhCanonId(value: string): number {
  const canon = canonicalZhPhoneme(value);
  let id = CANON_ID_BY_TOKEN.get(canon);
  if (id === undefined) {
    id = nextCanonId++;
    CANON_ID_BY_TOKEN.set(canon, id);
  }
  return id;
}

/** Pre-encodes a `Phoneme[]` sequence into compact integer TypedArrays for zero-overhead alignment. */
export function encodePhonemes(phonemes: readonly Phoneme[]): EncodedPhonemes {
  const n = phonemes.length;
  const exactIds = new Int32Array(n);
  const canonIds = new Int32Array(n);
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = phonemes[i]!;
    exactIds[i] = internExactPhonemeId(p);
    if (p.lang === "zh") {
      canonIds[i] = p.isTone ? -1 : internZhCanonId(p.value);
    } else {
      canonIds[i] = 0;
    }
    flags[i] = (p.isWordStart ? 1 : 0) | (p.isWordEnd ? 2 : 0);
  }
  return { length: n, exactIds, canonIds, flags };
}

export function getPhonemeCost(h: Phoneme, inp: Phoneme): number {
  if (h.lang !== inp.lang) return 1.0;
  if (h.value === inp.value) return 0.0;
  if (h.lang === "zh") {
    // Fix upstream `if h_p` bug: reduced tone cost applies ONLY when BOTH phonemes are tones.
    if (h.isTone && inp.isTone) {
      return TONE_MISMATCH_COST;
    }
    if (h.isTone || inp.isTone) {
      return 1.0;
    }
    if (canonicalZhPhoneme(h.value) === canonicalZhPhoneme(inp.value)) {
      return FUZZY_PHONEME_COST;
    }
    return 1.0;
  }
  return 1.0;
}

export type LocalAlignmentMatch = {
  score: number;
  startPhonemeIdx: number;
  endPhonemeIdx: number;
};

// Pre-allocated scratch buffers to avoid GC pressure during 10,000-term scans.
let bufCap = 256;
let prevDist = new Float64Array(bufCap);
let currDist = new Float64Array(bufCap);
let prevStart = new Int32Array(bufCap);
let currStart = new Int32Array(bufCap);

let exactBagCap = 512;
let exactBag = new Int16Array(exactBagCap);
let exactTouched = new Int32Array(256);

let canonBagCap = 128;
let canonBag = new Int16Array(canonBagCap);
let canonTouched = new Int32Array(256);

let unmatchedCanonBuf = new Int32Array(256);

function ensureBuffers(required: number): void {
  if (required <= bufCap) return;
  while (bufCap < required) {
    bufCap *= 2;
  }
  prevDist = new Float64Array(bufCap);
  currDist = new Float64Array(bufCap);
  prevStart = new Int32Array(bufCap);
  currStart = new Int32Array(bufCap);
}

function ensureBagCapacity(maxExact: number, maxCanon: number, windowLen: number, hwLen: number): void {
  if (maxExact >= exactBagCap) {
    while (exactBagCap <= maxExact) exactBagCap *= 2;
    exactBag = new Int16Array(exactBagCap);
  }
  if (maxCanon >= canonBagCap) {
    while (canonBagCap <= maxCanon) canonBagCap *= 2;
    canonBag = new Int16Array(canonBagCap);
  }
  if (windowLen > exactTouched.length) {
    const cap = Math.max(windowLen * 2, 512);
    exactTouched = new Int32Array(cap);
    canonTouched = new Int32Array(cap);
  }
  if (hwLen > unmatchedCanonBuf.length) {
    unmatchedCanonBuf = new Int32Array(Math.max(hwLen * 2, 512));
  }
}

/**
 * Exact O(n + m) 2-level laminar bag lower-bound filter:
 * Greedily pairs identical `exactId`s (`cost = 0`), then pairs remaining phonemes within the same
 * `canonId` class (`0.4` for Mandarin tones, `0.5` for Mandarin fuzzy phoneme groups), and charges `1.0`
 * for any remaining unmatched phoneme. Mathematically guaranteed `<=` true DP alignment cost (zero false negatives).
 */
export function passesEncodedBagLowerBound(
  hw: EncodedPhonemes,
  input: EncodedPhonemes,
  winStart: number,
  winEnd: number,
  maxAllowedDist: number,
): boolean {
  const n = hw.length;
  const m = winEnd - winStart;
  if (n === 0) return true;
  if (m === 0) return n <= maxAllowedDist + 1e-6;

  ensureBagCapacity(nextExactId + 1, nextCanonId + 1, m, n);
  const inExact = input.exactIds;
  const inCanon = input.canonIds;

  let exactTouchedLen = 0;
  let canonTouchedLen = 0;
  let tonePool = 0;

  for (let j = winStart; j < winEnd; j += 1) {
    const eid = inExact[j]!;
    if (exactBag[eid] === 0) {
      exactTouched[exactTouchedLen++] = eid;
    }
    exactBag[eid]! += 1;

    const cid = inCanon[j]!;
    if (cid < 0) {
      tonePool += 1;
    } else if (cid > 0) {
      if (canonBag[cid] === 0) {
        canonTouched[canonTouchedLen++] = cid;
      }
      canonBag[cid]! += 1;
    }
  }

  const hwExact = hw.exactIds;
  const hwCanon = hw.canonIds;
  let uLen = 0;
  for (let i = 0; i < n; i += 1) {
    const eid = hwExact[i]!;
    const cid = hwCanon[i]!;
    if (exactBag[eid]! > 0) {
      exactBag[eid]! -= 1;
      if (cid < 0) {
        tonePool -= 1;
      } else if (cid > 0) {
        canonBag[cid]! -= 1;
      }
    } else {
      unmatchedCanonBuf[uLen++] = cid;
    }
  }

  let minCost = 0.0;
  let passed = true;
  const limit = maxAllowedDist + 1e-6;

  for (let u = 0; u < uLen; u += 1) {
    const cid = unmatchedCanonBuf[u]!;
    if (cid < 0 && tonePool > 0) {
      tonePool -= 1;
      minCost += TONE_MISMATCH_COST;
    } else if (cid > 0 && canonBag[cid]! > 0) {
      canonBag[cid]! -= 1;
      minCost += FUZZY_PHONEME_COST;
    } else {
      minCost += 1.0;
    }
    if (minCost > limit) {
      passed = false;
      break;
    }
  }

  for (let t = 0; t < exactTouchedLen; t += 1) {
    exactBag[exactTouched[t]!] = 0;
  }
  for (let t = 0; t < canonTouchedLen; t += 1) {
    canonBag[canonTouched[t]!] = 0;
  }
  return passed;
}

/**
 * Word-boundary constrained local alignment DP over pre-encoded `input[winStart..winEnd)`.
 * Matches MUST begin on `isWordStart` (`flag & 1`) and end on `isWordEnd` (`flag & 2`).
 */
export function fuzzySubstringSearchEncoded(
  hw: EncodedPhonemes,
  input: EncodedPhonemes,
  winStart: number,
  winEnd: number,
  minThreshold: number,
): LocalAlignmentMatch[] {
  const n = hw.length;
  const m = winEnd - winStart;
  if (n === 0 || m <= 0) return [];

  ensureBuffers(m + 1);
  const maxAllowedDist = n * (1.0 - minThreshold);
  const limit = maxAllowedDist + 1e-6;

  const inFlags = input.flags;
  const inExact = input.exactIds;
  const inCanon = input.canonIds;
  const hwExact = hw.exactIds;
  const hwCanon = hw.canonIds;

  // Row 0: allow starting with cost 0 ONLY at valid word-start boundaries in `input`.
  for (let j = 0; j < m; j += 1) {
    if ((inFlags[winStart + j]! & 1) !== 0) {
      prevDist[j] = 0.0;
      prevStart[j] = j;
    } else {
      prevDist[j] = Number.POSITIVE_INFINITY;
      prevStart[j] = -1;
    }
  }
  prevDist[m] = Number.POSITIVE_INFINITY;
  prevStart[m] = -1;

  for (let i = 1; i <= n; i += 1) {
    const he = hwExact[i - 1]!;
    const hc = hwCanon[i - 1]!;
    currDist[0] = prevDist[0]! + 1.0;
    currStart[0] = prevStart[0]!;
    let rowMin = currDist[0]!;

    for (let j = 1; j <= m; j += 1) {
      const idx = winStart + j - 1;
      let cost = 1.0;
      if (he === inExact[idx]) {
        cost = 0.0;
      } else if (hc !== 0 && hc === inCanon[idx]) {
        cost = hc < 0 ? TONE_MISMATCH_COST : FUZZY_PHONEME_COST;
      }

      const dMatch = prevDist[j - 1]! + cost;
      const dDel = prevDist[j]! + 1.0;
      const dIns = currDist[j - 1]! + 1.0;

      if (dMatch <= dDel) {
        if (dMatch <= dIns) {
          currDist[j] = dMatch;
          currStart[j] = prevStart[j - 1]!;
        } else {
          currDist[j] = dIns;
          currStart[j] = currStart[j - 1]!;
        }
      } else if (dDel <= dIns) {
        currDist[j] = dDel;
        currStart[j] = prevStart[j]!;
      } else {
        currDist[j] = dIns;
        currStart[j] = currStart[j - 1]!;
      }

      const v = currDist[j]!;
      if (v < rowMin) rowMin = v;
    }

    // Swap rolling rows
    const tmpD = prevDist;
    prevDist = currDist;
    currDist = tmpD;
    const tmpS = prevStart;
    prevStart = currStart;
    currStart = tmpS;

    if (rowMin > limit) {
      return [];
    }
  }

  const raw: LocalAlignmentMatch[] = [];
  for (let j = 1; j <= m; j += 1) {
    if ((inFlags[winStart + j - 1]! & 2) === 0) continue;
    const dist = prevDist[j]!;
    const sIdx = prevStart[j]!;
    if (sIdx < 0 || sIdx >= j) continue;
    const score = 1.0 - dist / n;
    if (score + 1e-9 >= minThreshold) {
      raw.push({
        score: Math.max(0, Math.min(1, score)),
        startPhonemeIdx: winStart + sIdx,
        endPhonemeIdx: winStart + j,
      });
    }
  }

  if (raw.length <= 1) return raw;
  raw.sort((a, b) => b.score - a.score || (b.endPhonemeIdx - b.startPhonemeIdx) - (a.endPhonemeIdx - a.startPhonemeIdx));

  // Deduplicate matches that share the same start or end boundary, keeping highest score.
  const deduped: LocalAlignmentMatch[] = [];
  for (const cand of raw) {
    let conflict = false;
    for (const kept of deduped) {
      if (cand.endPhonemeIdx === kept.endPhonemeIdx || cand.startPhonemeIdx === kept.startPhonemeIdx) {
        conflict = true;
        break;
      }
    }
    if (!conflict) deduped.push(cand);
  }
  return deduped;
}

/**
 * Computes global full-span phonetic similarity in `[0, 1]` between two strings
 * (used by learn-from-edits to test whether a user correction is phonetically plausible).
 */
export function phoneticSimilarity(a: string, b: string): number {
  const pa = toPhonemes(a);
  const pb = toPhonemes(b);
  const n = pa.length;
  const m = pb.length;
  if (n === 0 || m === 0) return 0;

  let prev = new Float64Array(m + 1);
  let curr = new Float64Array(m + 1);
  for (let j = 0; j <= m; j += 1) {
    prev[j] = j;
  }
  for (let i = 1; i <= n; i += 1) {
    curr[0] = i;
    const ha = pa[i - 1]!;
    for (let j = 1; j <= m; j += 1) {
      const hb = pb[j - 1]!;
      const cost = getPhonemeCost(ha, hb);
      const dMatch = prev[j - 1]! + cost;
      const dDel = prev[j]! + 1.0;
      const dIns = curr[j - 1]! + 1.0;
      curr[j] = Math.min(dMatch, dDel, dIns);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const dist = prev[m]!;
  return Math.max(0, Math.min(1, 1.0 - dist / Math.max(n, m)));
}
