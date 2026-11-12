import {
  type DictionarySuggestionItem,
  type DictionarySuggestionStatus,
  MangaError,
  createId,
} from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { phoneticSimilarity } from "../correct/index.ts";
import type { DictionaryService, DictionaryTerm } from "../dictionary.ts";

/** Maximum elapsed time (`60s`) after dictation insertion during which edits are observed for term learning. */
export const LEARN_EDIT_WINDOW_MS = 60_000;

/** Minimum length (in Unicode code points) of a newly edited candidate term. */
export const LEARN_MIN_TERM_CHARS = 2;

/** Maximum length (in Unicode code points) of a newly edited candidate term. */
export const LEARN_MAX_TERM_CHARS = 16;

/** Minimum phonetic similarity (`>= 0.60`) between misrecognized span and user's edited span to propose a dictionary term. */
export const LEARN_PHONETIC_THRESHOLD = 0.6;

type SuggestionRow = {
  id: string;
  scope: "global" | "work";
  work_id: string | null;
  term: string;
  heard: string;
  score: number;
  status: DictionarySuggestionStatus;
  created_at: string;
  updated_at: string;
};

const TRIM_PUNCT_RE = /^[\s,，、;；.。:：!！?？"'“”‘’「」『』《》〈〉()（）[\]【】\-—~·…]+|[\s,，、;；.。:：!！?？"'“”‘’「」『』《》〈〉()（）[\]【】\-—~·…]+$/gu;
const MEANINGFUL_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]/u;
const ASCII_WORD_CHAR_RE = /^[A-Za-z0-9_-]$/u;
const KANA_CHAR_RE = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]$/u;
const ZH_WORD_SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });
const CJK_BOUNDARY_CHARS = new Set([
  "的", "了", "着", "过", "吗", "呢", "吧", "啊", "呀", "哦",
  "是", "在", "有", "和", "与", "跟", "及", "或", "但", "而",
  "把", "被", "给", "对", "向", "从", "到", "往", "于", "为",
  "看", "见", "说", "叫", "让", "去", "来", "想", "要", "会", "能",
  "很", "太", "真", "最", "更", "也", "都", "就", "才", "还", "又", "再",
  "我", "你", "他", "她", "它", "这", "那", "里", "中", "上", "下",
]);

function isBoundaryCodePoint(ch: string): boolean {
  if (!MEANINGFUL_CHAR_RE.test(ch)) return true;
  return CJK_BOUNDARY_CHARS.has(ch);
}

function toSuggestionItem(row: SuggestionRow): DictionarySuggestionItem {
  return {
    id: row.id,
    scope: row.scope,
    workId: row.work_id || null,
    term: row.term,
    heard: row.heard,
    score: row.score,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function formatSuggestionPrompt(term: string, heard: string): string {
  return `把「${term}」加入词典？（识别成了「${heard}」）`;
}

/**
 * Extracts the single edited span `(heard, term)` between `insertedText` and `editedText`.
 * Returns `null` when nothing changed, when the whole sentence was rewritten, or when the span falls outside `2..16` code points.
 */
export function extractEditedTermSpan(
  insertedText: string,
  editedText: string,
): { heard: string; term: string } | null {
  const oldChars = [...insertedText];
  const newChars = [...editedText];
  if (oldChars.length === 0 || newChars.length === 0) return null;

  let prefix = 0;
  const maxPrefix = Math.min(oldChars.length, newChars.length);
  while (prefix < maxPrefix && oldChars[prefix] === newChars[prefix]) {
    prefix += 1;
  }
  if (prefix === oldChars.length && prefix === newChars.length) {
    return null; // identical
  }

  let suffix = 0;
  const maxSuffix = Math.min(oldChars.length - prefix, newChars.length - prefix);
  while (
    suffix < maxSuffix &&
    oldChars[oldChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  // Reject whole-sentence rewrites on multi-clause sentences where almost no surrounding context stayed intact.
  const unchangedChars = prefix + suffix;
  if (oldChars.length >= 10 && unchangedChars < Math.min(2, Math.floor(oldChars.length * 0.2))) {
    return null;
  }

  // Expand mid-word boundaries for ASCII words or Japanese Kana runs so partial edits capture the whole token.
  while (
    prefix > 0 &&
    ((ASCII_WORD_CHAR_RE.test(oldChars[prefix - 1]!) &&
      ((prefix < oldChars.length - suffix && ASCII_WORD_CHAR_RE.test(oldChars[prefix]!)) ||
        (prefix < newChars.length - suffix && ASCII_WORD_CHAR_RE.test(newChars[prefix]!)))) ||
      (KANA_CHAR_RE.test(oldChars[prefix - 1]!) &&
        ((prefix < oldChars.length - suffix && KANA_CHAR_RE.test(oldChars[prefix]!)) ||
          (prefix < newChars.length - suffix && KANA_CHAR_RE.test(newChars[prefix]!)))))
  ) {
    prefix -= 1;
  }

  while (
    suffix > 0 &&
    ((ASCII_WORD_CHAR_RE.test(oldChars[oldChars.length - suffix]!) &&
      ((oldChars.length - suffix - 1 >= prefix && ASCII_WORD_CHAR_RE.test(oldChars[oldChars.length - suffix - 1]!)) ||
        (newChars.length - suffix - 1 >= prefix && ASCII_WORD_CHAR_RE.test(newChars[newChars.length - suffix - 1]!)))) ||
      (KANA_CHAR_RE.test(oldChars[oldChars.length - suffix]!) &&
        ((oldChars.length - suffix - 1 >= prefix && KANA_CHAR_RE.test(oldChars[oldChars.length - suffix - 1]!)) ||
          (newChars.length - suffix - 1 >= prefix && KANA_CHAR_RE.test(newChars[newChars.length - suffix - 1]!)))))
  ) {
    suffix -= 1;
  }

  // When only 1 character changed inside a multi-character CJK name (e.g. "配角克雷雅拿起了" -> "配角克蕾雅拿起了"),
  // use ICU Chinese word segmentation on `editedText` so ordinary surrounding words ("配角", "拿起") are never absorbed.
  const rawNewLen = newChars.length - prefix - suffix;
  const rawOldLen = oldChars.length - prefix - suffix;
  if (rawNewLen > 0 && rawOldLen > 0 && (rawNewLen < LEARN_MIN_TERM_CHARS || rawOldLen < LEARN_MIN_TERM_CHARS)) {
    const editStart = prefix;
    const editEnd = newChars.length - suffix;
    const segments: Array<{ start: number; end: number; text: string; len: number }> = [];
    let cpCursor = 0;
    for (const part of ZH_WORD_SEGMENTER.segment(editedText)) {
      const len = [...part.segment].length;
      segments.push({ start: cpCursor, end: cpCursor + len, text: part.segment, len });
      cpCursor += len;
    }

    let firstIdx = segments.findIndex((seg) => seg.end > editStart);
    let lastIdx = -1;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i]!.start < editEnd) {
        lastIdx = i;
        break;
      }
    }

    if (firstIdx >= 0 && lastIdx >= firstIdx) {
      // Step B: absorb adjacent single-character non-boundary CJK segments (out-of-vocabulary name characters).
      while (
        firstIdx > 0 &&
        segments[firstIdx - 1]!.len === 1 &&
        !isBoundaryCodePoint(segments[firstIdx - 1]!.text) &&
        segments[lastIdx]!.end - segments[firstIdx - 1]!.start <= 6
      ) {
        firstIdx -= 1;
      }
      while (
        lastIdx + 1 < segments.length &&
        segments[lastIdx + 1]!.len === 1 &&
        !isBoundaryCodePoint(segments[lastIdx + 1]!.text) &&
        segments[lastIdx + 1]!.end - segments[firstIdx]!.start <= 6
      ) {
        lastIdx += 1;
      }

      // Step C: if a 4-char Japanese/Chinese `surname + givenName` split into two 2-char segments right before/after a particle (`的`/`了`), merge the second half.
      const curSpanLen = segments[lastIdx]!.end - segments[firstIdx]!.start;
      if (
        curSpanLen === 2 &&
        lastIdx + 1 < segments.length &&
        segments[lastIdx + 1]!.len === 2 &&
        MEANINGFUL_CHAR_RE.test(segments[lastIdx + 1]!.text) &&
        (lastIdx + 2 === segments.length || isBoundaryCodePoint([...segments[lastIdx + 2]!.text][0]!))
      ) {
        lastIdx += 1;
      } else if (
        curSpanLen === 2 &&
        firstIdx > 0 &&
        segments[firstIdx - 1]!.len === 2 &&
        MEANINGFUL_CHAR_RE.test(segments[firstIdx - 1]!.text) &&
        (firstIdx - 1 === 0 || isBoundaryCodePoint([...segments[firstIdx - 2]!.text].at(-1)!))
      ) {
        firstIdx -= 1;
      }

      const expandLeft = editStart - segments[firstIdx]!.start;
      const expandRight = segments[lastIdx]!.end - editEnd;
      if (expandLeft >= 0 && expandRight >= 0 && expandLeft <= prefix && expandRight <= suffix) {
        prefix -= expandLeft;
        suffix -= expandRight;
      }
    }
  }

  const heard = oldChars
    .slice(prefix, oldChars.length - suffix)
    .join("")
    .replace(TRIM_PUNCT_RE, "")
    .trim();
  const term = newChars
    .slice(prefix, newChars.length - suffix)
    .join("")
    .replace(TRIM_PUNCT_RE, "")
    .trim();

  if (!heard || !term || heard === term) return null;
  if (!MEANINGFUL_CHAR_RE.test(heard) || !MEANINGFUL_CHAR_RE.test(term)) return null;

  const termLen = [...term].length;
  const heardLen = [...heard].length;
  if (termLen < LEARN_MIN_TERM_CHARS || termLen > LEARN_MAX_TERM_CHARS) return null;
  if (heardLen < 1 || heardLen > LEARN_MAX_TERM_CHARS + 4) return null;

  return { heard, term };
}

export class LearnFromEditsService {
  private readonly store: DrizzleStore;
  private readonly dictionary: DictionaryService;

  constructor(options: { store: DrizzleStore; dictionary: DictionaryService }) {
    this.store = options.store;
    this.dictionary = options.dictionary;
  }

  private isAlreadyKnownTermOrAlias(term: string, workId: string | null): boolean {
    const folded = term.toLowerCase();
    const existingTerm = workId
      ? this.store.sqlite
          .prepare(
            "SELECT 1 FROM dictionary_terms WHERE lower(term) = ? AND (scope = 'global' OR (scope = 'work' AND work_id = ?)) LIMIT 1",
          )
          .get(folded, workId)
      : this.store.sqlite
          .prepare("SELECT 1 FROM dictionary_terms WHERE lower(term) = ? AND scope = 'global' LIMIT 1")
          .get(folded);
    if (existingTerm) return true;

    const existingAlias = workId
      ? this.store.sqlite
          .prepare(
            `SELECT 1 FROM dictionary_aliases a
             JOIN dictionary_terms t ON t.id = a.term_id
             WHERE lower(a.alias) = ? AND (t.scope = 'global' OR (t.scope = 'work' AND t.work_id = ?))
             LIMIT 1`,
          )
          .get(folded, workId)
      : this.store.sqlite
          .prepare(
            `SELECT 1 FROM dictionary_aliases a
             JOIN dictionary_terms t ON t.id = a.term_id
             WHERE lower(a.alias) = ? AND t.scope = 'global'
             LIMIT 1`,
          )
          .get(folded);
    return Boolean(existingAlias);
  }

  /**
   * Compares `insertedText` vs `editedText` within the 60s window and creates/updates a `pending` suggestion
   * when the modified span is `2..16` chars, not already a term/alias, not ignored, and has phonetic similarity `>= 0.6`.
   */
  observeEdit(input: {
    workId?: string | null;
    insertedText: string;
    editedText: string;
    elapsedMs?: number;
    untrackable?: boolean;
  }): {
    suggestion: DictionarySuggestionItem | null;
    promptText: string | null;
    reason?: string;
  } {
    if (input.untrackable) {
      return { suggestion: null, promptText: null, reason: "untrackable" };
    }
    if (input.elapsedMs !== undefined && input.elapsedMs > LEARN_EDIT_WINDOW_MS) {
      return { suggestion: null, promptText: null, reason: "window_expired" };
    }

    const workId =
      input.workId && this.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(input.workId)
        ? input.workId
        : null;
    const scope: "global" | "work" = workId ? "work" : "global";

    const extracted = extractEditedTermSpan(input.insertedText, input.editedText);
    if (!extracted) {
      return { suggestion: null, promptText: null, reason: "span_invalid" };
    }

    const { heard, term } = extracted;

    // Check if this exact `(scope, work_id, term, heard)` pair was already ignored or accepted.
    const existingSuggestion = this.store.sqlite
      .prepare(
        "SELECT * FROM dictionary_suggestions WHERE scope = ? AND IFNULL(work_id, '') = ? AND term = ? AND heard = ? LIMIT 1",
      )
      .get(scope, workId ?? "", term, heard) as SuggestionRow | undefined;

    if (existingSuggestion && (existingSuggestion.status === "ignored" || existingSuggestion.status === "accepted")) {
      return { suggestion: null, promptText: null, reason: "suppressed" };
    }

    if (this.isAlreadyKnownTermOrAlias(term, workId)) {
      return { suggestion: null, promptText: null, reason: "already_in_dictionary" };
    }

    const score = Number(phoneticSimilarity(heard, term).toFixed(4));
    if (score < LEARN_PHONETIC_THRESHOLD) {
      return { suggestion: null, promptText: null, reason: "low_phonetic_similarity" };
    }

    const now = new Date().toISOString();
    let id = existingSuggestion?.id;
    if (existingSuggestion) {
      this.store.sqlite
        .prepare("UPDATE dictionary_suggestions SET score = ?, status = 'pending', updated_at = ? WHERE id = ?")
        .run(score, now, existingSuggestion.id);
    } else {
      id = createId("dsug");
      this.store.sqlite
        .prepare(
          `INSERT INTO dictionary_suggestions (id, scope, work_id, term, heard, score, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, scope, workId, term, heard, score, now, now);
    }

    const saved = this.store.sqlite
      .prepare("SELECT * FROM dictionary_suggestions WHERE id = ?")
      .get(id!) as SuggestionRow;

    return {
      suggestion: toSuggestionItem(saved),
      promptText: formatSuggestionPrompt(term, heard),
    };
  }

  list(filter: { workId?: string; status?: DictionarySuggestionStatus } = {}): {
    items: DictionarySuggestionItem[];
  } {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.workId) {
      where.push("(scope = 'global' OR work_id = ?)");
      params.push(filter.workId);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const rows = this.store.sqlite
      .prepare(
        `SELECT * FROM dictionary_suggestions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(...params) as SuggestionRow[];
    return { items: rows.map(toSuggestionItem) };
  }

  /**
   * Confirms (`accept`) or permanently suppresses (`ignore`) a learned suggestion.
   * On `accept`: if `term` already exists in the dictionary, adds `heard` as a `heard` alias;
   * otherwise creates a manual term (in `workId` if set, else `global`) with `heard` as its alias.
   */
  decide(input: {
    suggestionId: string;
    action: "accept" | "ignore";
  }): { suggestion: DictionarySuggestionItem; term?: DictionaryTerm } {
    const row = this.store.sqlite
      .prepare("SELECT * FROM dictionary_suggestions WHERE id = ?")
      .get(input.suggestionId) as SuggestionRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "词典建议不存在");

    const now = new Date().toISOString();
    if (input.action === "ignore") {
      this.store.sqlite
        .prepare("UPDATE dictionary_suggestions SET status = 'ignored', updated_at = ? WHERE id = ?")
        .run(now, row.id);
      const updated = this.store.sqlite
        .prepare("SELECT * FROM dictionary_suggestions WHERE id = ?")
        .get(row.id) as SuggestionRow;
      return { suggestion: toSuggestionItem(updated) };
    }

    const savedTerm = this.dictionary.addHeardAliasOrCreateManual({
      scope: row.scope,
      workId: row.work_id,
      term: row.term,
      heard: row.heard,
    });

    this.store.sqlite
      .prepare("UPDATE dictionary_suggestions SET status = 'accepted', updated_at = ? WHERE id = ?")
      .run(now, row.id);
    const updated = this.store.sqlite
      .prepare("SELECT * FROM dictionary_suggestions WHERE id = ?")
      .get(row.id) as SuggestionRow;
    return { suggestion: toSuggestionItem(updated), term: savedTerm };
  }
}
