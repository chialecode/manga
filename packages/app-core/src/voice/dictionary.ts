import { MangaError, PROMPT_LIMIT_DEFAULT, createId } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";

export type DictionaryTerm = {
  id: string;
  scope: "global" | "work";
  workId: string | null;
  term: string;
  heard: string | null;
  /** `manual`, or `metadata:<provider>:<category>:<external id>` for a term taken from a linked source. */
  source: string;
  auto: boolean;
  createdAt: string;
  updatedAt: string;
};

type Row = { id: string; scope: "global" | "work"; work_id: string; term: string; heard: string | null; source: string; created_at: string; updated_at: string };

const MAX_TERMS = 5000;
const MANUAL = "manual";

const termOf = (row: Row): DictionaryTerm => ({
  id: row.id, scope: row.scope, workId: row.work_id || null, term: row.term, heard: row.heard, source: row.source, auto: row.source !== MANUAL, createdAt: row.created_at, updatedAt: row.updated_at,
});

/** A name worth giving the transcriber: not empty, not a single character (it would match everything), not absurdly long. */
const usable = (name: string): string | null => {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean.length >= 2 && clean.length <= 64 ? clean : null;
};

/** What the dictionary can take from the data cached for a linked work: characters, the people who voice them, and the work's names. */
export function termsFromMetadata(store: DrizzleStore, workId: string): { linked: boolean; providerId: string | null; terms: Array<{ term: string; source: string }> } {
  const link = store.sqlite.prepare(`SELECT s.provider_id AS providerId, s.external_id AS externalId, s.snapshot_json AS json FROM metadata_snapshots s
    WHERE s.work_id = ? AND s.provider_id <> 'local' AND s.detached = 0 ORDER BY s.fetched_at DESC LIMIT 1`).get(workId) as { providerId: string; externalId: string; json: string } | undefined;
  if (!link) return { linked: false, providerId: null, terms: [] };
  const found = new Map<string, string>();
  const add = (name: string | null | undefined, category: string, externalId: string) => {
    const clean = name ? usable(name) : null;
    if (clean && !found.has(clean)) found.set(clean, `metadata:${link.providerId}:${category}:${externalId}`);
  };
  try {
    const snapshot = JSON.parse(link.json) as { fields?: { title?: unknown; titleOriginal?: unknown }; aliases?: unknown };
    add(typeof snapshot.fields?.title === "string" ? snapshot.fields.title : null, "work", link.externalId);
    add(typeof snapshot.fields?.titleOriginal === "string" ? snapshot.fields.titleOriginal : null, "work", link.externalId);
    if (Array.isArray(snapshot.aliases)) for (const alias of snapshot.aliases) if (typeof alias === "string") add(alias, "work", link.externalId);
  } catch { /* a snapshot that does not read gives no work names; the credits below are still good */ }
  const characters = store.sqlite.prepare("SELECT character_id AS id, name, actors_json AS actors FROM subject_characters WHERE work_id = ? AND provider_id = ? AND subject_id = ? ORDER BY position").all(workId, link.providerId, link.externalId) as Array<{ id: string; name: string; actors: string }>;
  for (const character of characters) {
    add(character.name, "character", character.id);
    try {
      for (const actor of JSON.parse(character.actors) as Array<{ externalId?: string; name?: string }>) add(actor.name, "actor", String(actor.externalId ?? character.id));
    } catch { /* an actor list that does not read is skipped */ }
  }
  return { linked: true, providerId: link.providerId, terms: [...found].map(([term, source]) => ({ term, source })) };
}

/**
 * The voice dictionary (VOICE-09): terms for every recording and terms for one work. A term is written by hand or taken from the data cached for a
 * linked work, and a hand-written term always wins over an automatic one. Refreshing a work's data only adds and removes the automatic ones.
 */
export class DictionaryService {
  private readonly store: DrizzleStore;

  constructor(store: DrizzleStore) {
    this.store = store;
  }

  private row(termId: string): Row {
    const row = this.store.sqlite.prepare("SELECT * FROM dictionary_terms WHERE id = ?").get(termId) as Row | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "that term does not exist");
    return row;
  }

  private requireWork(workId: string): void {
    if (!this.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(workId) && !this.store.sqlite.prepare("SELECT 1 FROM removed_works WHERE id = ?").get(workId)) throw new MangaError("NOT_FOUND", "work not found");
  }

  /** The works whose entry was deleted and that still have terms: what the person wrote for them is kept and found here (A-87). */
  removedWorks(): Array<{ workId: string; title: string; mediaKind: string; terms: number }> {
    return this.store.sqlite.prepare(`SELECT d.work_id AS workId, rw.title AS title, rw.media_kind AS mediaKind, COUNT(*) AS terms
      FROM dictionary_terms d JOIN removed_works rw ON rw.id = d.work_id
      WHERE d.scope = 'work' AND NOT EXISTS (SELECT 1 FROM works w WHERE w.id = d.work_id) GROUP BY d.work_id ORDER BY rw.removed_at DESC`).all() as Array<{ workId: string; title: string; mediaKind: string; terms: number }>;
  }

  list(filter: { scope?: "global" | "work"; workId?: string } = {}): { terms: DictionaryTerm[] } {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.scope) { where.push("scope = ?"); params.push(filter.scope); }
    if (filter.workId) { where.push("work_id = ?"); params.push(filter.workId); }
    const rows = this.store.sqlite.prepare(`SELECT * FROM dictionary_terms ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY scope DESC, (source = 'manual') DESC, created_at, rowid`).all(...params) as Row[];
    return { terms: rows.map(termOf) };
  }

  /** Adds a term by hand. An automatic term of the same name becomes the hand-written one, so a later refresh leaves it alone. */
  add(input: { scope: "global" | "work"; workId?: string; term: string; heard?: string }): DictionaryTerm {
    const workId = input.scope === "work" ? input.workId ?? "" : "";
    if (input.scope === "work") this.requireWork(workId);
    const term = input.term.trim();
    if (!term) throw new MangaError("VALIDATION_ERROR", "a term cannot be empty");
    const total = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM dictionary_terms").get() as { n: number }).n;
    const existing = this.store.sqlite.prepare("SELECT id FROM dictionary_terms WHERE scope = ? AND work_id = ? AND term = ?").get(input.scope, workId, term) as { id: string } | undefined;
    if (!existing && total >= MAX_TERMS) throw new MangaError("VALIDATION_ERROR", "the dictionary is full; remove some terms first", { details: { reason: "limit" } });
    const now = new Date().toISOString();
    const id = existing?.id ?? createId("dic");
    if (existing) this.store.sqlite.prepare("UPDATE dictionary_terms SET heard = ?, source = 'manual', updated_at = ? WHERE id = ?").run(input.heard?.trim() || null, now, id);
    else this.store.sqlite.prepare("INSERT INTO dictionary_terms(id, scope, work_id, term, heard, source, created_at, updated_at) VALUES (?,?,?,?,?,'manual',?,?)").run(id, input.scope, workId, term, input.heard?.trim() || null, now, now);
    return termOf(this.row(id));
  }

  /** A changed term is the user's, so it is kept as a hand-written term from then on. */
  update(input: { termId: string; term?: string; heard?: string | null }): DictionaryTerm {
    const row = this.row(input.termId);
    const term = input.term?.trim() ?? row.term;
    if (!term) throw new MangaError("VALIDATION_ERROR", "a term cannot be empty");
    const clash = this.store.sqlite.prepare("SELECT id FROM dictionary_terms WHERE scope = ? AND work_id = ? AND term = ? AND id <> ?").get(row.scope, row.work_id, term, row.id);
    if (clash) throw new MangaError("VALIDATION_ERROR", "the dictionary already has that term", { details: { reason: "duplicate" } });
    this.store.sqlite.prepare("UPDATE dictionary_terms SET term = ?, heard = ?, source = 'manual', updated_at = ? WHERE id = ?").run(term, input.heard === undefined ? row.heard : input.heard?.trim() || null, new Date().toISOString(), row.id);
    return termOf(this.row(row.id));
  }

  remove(termId: string): { termId: string } {
    this.row(termId);
    this.store.sqlite.prepare("DELETE FROM dictionary_terms WHERE id = ?").run(termId);
    return { termId };
  }

  /**
   * Brings a work's automatic terms in line with the data cached for its linked entry: new names are added, names the entry no longer has
   * are removed, and a hand-written term of the same name is never touched. A work with no linked entry has no automatic terms.
   */
  syncFromMetadata(workId: string): { linked: boolean; added: number; removed: number; kept: number; manualWins: number } {
    this.requireWork(workId);
    const wanted = termsFromMetadata(this.store, workId);
    const result = { linked: wanted.linked, added: 0, removed: 0, kept: 0, manualWins: 0 };
    this.store.sqlite.transaction(() => {
      const rows = this.store.sqlite.prepare("SELECT * FROM dictionary_terms WHERE scope = 'work' AND work_id = ?").all(workId) as Row[];
      const have = new Map(rows.map((row) => [row.term, row]));
      const keep = new Set(wanted.terms.map((item) => item.term));
      const now = new Date().toISOString();
      for (const row of rows) {
        if (row.source !== MANUAL && !keep.has(row.term)) {
          this.store.sqlite.prepare("DELETE FROM dictionary_terms WHERE id = ?").run(row.id);
          result.removed += 1;
        }
      }
      let room = MAX_TERMS - (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM dictionary_terms").get() as { n: number }).n;
      for (const item of wanted.terms) {
        const existing = have.get(item.term);
        if (existing && existing.source === MANUAL) { result.manualWins += 1; continue; }
        if (existing) {
          if (existing.source !== item.source) this.store.sqlite.prepare("UPDATE dictionary_terms SET source = ?, updated_at = ? WHERE id = ?").run(item.source, now, existing.id);
          result.kept += 1;
          continue;
        }
        if (room <= 0) continue;
        this.store.sqlite.prepare("INSERT INTO dictionary_terms(id, scope, work_id, term, heard, source, created_at, updated_at) VALUES (?,?,?,?,NULL,?,?,?)").run(createId("dic"), "work", workId, item.term, item.source, now, now);
        room -= 1;
        result.added += 1;
      }
    })();
    return result;
  }

  /** After a refresh or an unlink: only a work that already took terms from its source follows it, so nothing appears that the user did not ask for. */
  followMetadata(workId: string): void {
    const hasAuto = this.store.sqlite.prepare("SELECT 1 FROM dictionary_terms WHERE scope = 'work' AND work_id = ? AND source <> 'manual' LIMIT 1").get(workId);
    if (hasAuto) this.syncFromMetadata(workId);
  }

  /** The terms in the order a transcription hint is built: the work's own, then those taken from its data, then the global ones. */
  ordered(workId: string | null): DictionaryTerm[] {
    const rows = this.store.sqlite.prepare(`SELECT * FROM dictionary_terms WHERE scope = 'global' OR (scope = 'work' AND work_id = ?)
      ORDER BY CASE WHEN scope = 'work' AND source = 'manual' THEN 0 WHEN scope = 'work' THEN 1 ELSE 2 END, created_at, rowid`).all(workId ?? "") as Row[];
    return rows.map(termOf);
  }

  /** Every term a work may be heard with, without caring about the hint's length: what the organizer is given as its glossary. */
  glossaryFor(workId: string | null): string[] {
    return [...new Set(this.ordered(workId).map((item) => item.term))];
  }

  prompt(workId: string | null, limit: number): PromptBuild {
    return buildPrompt(this.ordered(workId).map((item) => item.term), limit);
  }

  /** Legacy shape for the older term commands: the work's own terms with how each was heard. */
  workTerms(workId: string): Array<{ term: string; heard: string | null }> {
    return (this.store.sqlite.prepare("SELECT term, heard FROM dictionary_terms WHERE scope = 'work' AND work_id = ? ORDER BY (source = 'manual') DESC, created_at, rowid").all(workId) as Array<{ term: string; heard: string | null }>);
  }

  removeWorkTerm(workId: string, term: string): boolean {
    return this.store.sqlite.prepare("DELETE FROM dictionary_terms WHERE scope = 'work' AND work_id = ? AND term = ?").run(workId, term.trim()).changes > 0;
  }
}

export type PromptBuild = { text: string; included: string[]; total: number; cut: number; limit: number };

/** Joins terms with commas until the next one no longer fits; how many were left out is reported so the settings page can say so. */
export function buildPrompt(terms: string[], limit: number = PROMPT_LIMIT_DEFAULT): PromptBuild {
  const unique = [...new Set(terms)];
  const included: string[] = [];
  let text = "";
  for (const term of unique) {
    const next = text ? `${text}, ${term}` : term;
    if ([...next].length > limit) break;
    text = next;
    included.push(term);
  }
  return { text, included, total: unique.length, cut: unique.length - included.length, limit };
}

const SEPARATORS = /[\s,，、;；.。:：!！?？"'“”‘’「」『』()（）\-—~·…]+/gu;
const normalize = (value: string) => value.replace(SEPARATORS, "").toLowerCase();

/**
 * Whether a transcript only repeats the hint it was given. A dictionary makes this more likely, since a model with little audio to go on
 * (silence, music) tends to give the hint back. The text is taken apart into dictionary terms from the left; it counts as an echo when
 * almost all of it is terms and they either run in the order of the hint (three or more in a row), or one term is repeated three times
 * or more, or the text is the hint itself.
 */
export function isPromptEcho(transcript: string, hint: string[]): boolean {
  const text = normalize(transcript);
  if (!text || hint.length === 0) return false;
  const terms = hint.map((term) => ({ term, key: normalize(term) })).filter((item) => item.key.length > 0);
  if (terms.length === 0) return false;
  // Longest term first so "魔王城" is taken before "魔王".
  const byLength = [...terms].sort((a, b) => b.key.length - a.key.length);
  let position = 0;
  let matched = 0;
  const run: number[] = [];
  while (position < text.length) {
    const hit = byLength.find((item) => text.startsWith(item.key, position));
    if (hit) {
      matched += hit.key.length;
      run.push(terms.indexOf(terms.find((item) => item.key === hit.key)!));
      position += hit.key.length;
    } else {
      position += 1;
    }
  }
  if (matched / text.length < 0.8) return false;
  const counts = new Map<number, number>();
  for (const index of run) counts.set(index, (counts.get(index) ?? 0) + 1);
  const repeated = [...counts.values()].some((count) => count >= 3);
  let longest = 1;
  let current = 1;
  for (let i = 1; i < run.length; i += 1) {
    current = run[i]! === run[i - 1]! + 1 ? current + 1 : 1;
    if (current > longest) longest = current;
  }
  const whole = normalize(hint.join(""));
  return repeated || longest >= 3 || (whole.length >= 6 && text === whole);
}
