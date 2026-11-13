/**
 * Phonetic recall & deterministic replacement for MANGA voice dictation (R1).
 *
 * Adapted from HaujetZhao/asr-hotword (https://github.com/HaujetZhao/asr-hotword,
 * commit 7e282137e780ac4096cac537bef360235d2efe43).
 *
 * MIT License
 * Copyright (c) 2026 HaujetZhao
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export {
  FUZZY_PHONEME_COST,
  getPhonemeCost,
  phoneticSimilarity,
  TONE_MISMATCH_COST,
} from "./align.ts";

export {
  CANDIDATE_RECALL_THRESHOLD,
  type CorrectionOutput,
  type CorrectorAliasEntry,
  type CorrectorTermEntry,
  DIRECT_REPLACE_THRESHOLD,
  MAX_POLISH_CANDIDATES,
  PhoneticCorrector,
  type RecalledCandidate,
} from "./corrector.ts";

export {
  describeReading,
  toPhonemes,
} from "./phonemes.ts";
