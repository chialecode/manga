import {
  type DictionaryAliasInput,
  type DictionaryAliasKind,
  type DictionaryCategory,
  MangaError,
  PROMPT_LIMIT_DEFAULT,
  createId,
} from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import {
  type BangumiClient,
  type BangumiInfobox,
  InfoboxSchema,
  parseBangumiInfoboxNames,
} from "../metadata/bangumi.ts";
import {
  type CorrectionOutput,
  type CorrectorTermEntry,
  PhoneticCorrector,
  describeReading,
  toPhonemes,
} from "./correct/index.ts";

export const MAX_HOTWORDS = 50;
export const BANGUMI_DETAIL_REQUEST_BUDGET = 60;

export type DictionaryAlias = {
  id: string;
  alias: string;
  kind: DictionaryAliasKind;
  source: string;
  createdAt: string;
};

export type DictionaryTerm = {
  id: string;
  scope: "global" | "work";
  workId: string | null;
  term: string;
  heard: string | null;
  category: DictionaryCategory;
  disabled: boolean;
  blocked: string[];
  aliases: DictionaryAlias[];
  /** `manual`, or `metadata:<provider>:<category>:<external id>` for a term taken from a linked source. */
  source: string;
  auto: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EnrichBangumiProgress = {
  workId: string;
  completed: number;
  total: number;
  requestsSent: number;
  cachedHits: number;
};

export type EnrichBangumiResult = {
  linked: boolean;
  added: number;
  removed: number;
  kept: number;
  manualWins: number;
  requestsSent: number;
  cachedHits: number;
  budgetReached: boolean;
  totalTargets: number;
};

type TermRow = {
  id: string;
  scope: "global" | "work";
  work_id: string;
  term: string;
  heard: string | null;
  category: DictionaryCategory;
  disabled: number;
  blocked_json: string;
  source: string;
  created_at: string;
  updated_at: string;
};

type AliasRow = {
  id: string;
  term_id: string;
  alias: string;
  kind: DictionaryAliasKind;
  source: string;
  created_at: string;
};

const MAX_TERMS = 5000;
const MANUAL = "manual";

const AUTO_NOISE_TERMS = new Set(["不明", "未知", "未定", "暂无", "无", "cv", "n/a", "none", "null", "tbd"]);
const MEANINGFUL_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]/u;

function parseBlockedJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((s) => s.trim());
  } catch {
    return [];
  }
}

function normalizeBlockedList(blocked: ReadonlyArray<string> | undefined): string[] {
  if (!blocked) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of blocked) {
    const clean = raw.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export function categoryFromSource(source: string, fallback: DictionaryCategory = "other"): DictionaryCategory {
  if (source === MANUAL) return fallback;
  if (/^metadata:[^:]+:character:/u.test(source)) return "character";
  if (/^metadata:[^:]+:(?:actor|person):/u.test(source)) return "actor";
  if (/^metadata:[^:]+:work:/u.test(source)) return "work";
  return fallback;
}

/** A name worth giving the transcriber automatically: >=2 code points, <=64, containing letters/digits/CJK/Kana and not placeholder noise. */
const usable = (name: string): string | null => {
  const clean = name.replace(/\s+/g, " ").trim();
  const len = [...clean].length;
  if (len < 2 || len > 64) return null;
  if (!MEANINGFUL_CHAR_RE.test(clean)) return null;
  if (AUTO_NOISE_TERMS.has(clean.toLowerCase())) return null;
  return clean;
};

/**
 * Sanitizes a dictionary term before passing it to `sherpa-onnx` hotwords.
 * `sherpa-onnx` splits hotword lines on `:` to parse `:boost_score`, so colons and control characters must never pass through.
 */
export function cleanHotwordForSherpa(raw: string): string | null {
  let text = raw.replace(/[\r\n\t]+/gu, " ").trim();
  if (!text) return null;
  // Strip leading/trailing colons and trailing numeric `:boost_score` suffixes, then replace any internal `:` with spaces.
  text = text
    .replace(/^:+|:+$/gu, "")
    .replace(/([^\s:]):[+-]?\d+(?:\.\d+)?$/gu, "$1")
    .replace(/:/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text || !MEANINGFUL_CHAR_RE.test(text)) return null;
  return text;
}

export type MetadataExtractedTerm = {
  term: string;
  source: string;
  category: DictionaryCategory;
  aliases: Array<{ alias: string; kind: DictionaryAliasKind }>;
};

function readCachedBangumiInfobox(
  store: DrizzleStore,
  kind: "character" | "person",
  externalId: string,
): { cached: boolean; name: string; infobox: BangumiInfobox | null } {
  const row = store.sqlite
    .prepare("SELECT name, infobox_json AS infoboxJson FROM bangumi_details WHERE kind = ? AND external_id = ?")
    .get(kind, externalId) as { name: string; infoboxJson: string | null } | undefined;
  if (!row) return { cached: false, name: "", infobox: null };
  if (!row.infoboxJson) return { cached: true, name: row.name, infobox: null };
  try {
    const parsed = InfoboxSchema.safeParse(JSON.parse(row.infoboxJson));
    return { cached: true, name: row.name, infobox: parsed.success ? parsed.data : null };
  } catch {
    return { cached: true, name: row.name, infobox: null };
  }
}

/** What the dictionary can take from the data cached for a linked work: characters, the people who voice them, and the work's names. */
export function termsFromMetadata(
  store: DrizzleStore,
  workId: string,
): { linked: boolean; providerId: string | null; terms: MetadataExtractedTerm[] } {
  const link = store.sqlite.prepare(`SELECT s.provider_id AS providerId, s.external_id AS externalId, s.snapshot_json AS json FROM metadata_snapshots s
    WHERE s.work_id = ? AND s.provider_id <> 'local' AND s.detached = 0 ORDER BY s.fetched_at DESC LIMIT 1`).get(workId) as
    | { providerId: string; externalId: string; json: string }
    | undefined;
  if (!link) return { linked: false, providerId: null, terms: [] };

  const found = new Map<string, MetadataExtractedTerm>();
  const addEntry = (
    rawTerm: string | null | undefined,
    category: DictionaryCategory,
    externalId: string,
    rawAliases: ReadonlyArray<{ alias: string; kind: DictionaryAliasKind }> = [],
  ) => {
    const cleanTerm = rawTerm ? usable(rawTerm) : null;
    const filteredAliases: Array<{ alias: string; kind: DictionaryAliasKind }> = [];
    const seenAliases = new Set<string>();
    for (const candidate of rawAliases) {
      const cleanAlias = usable(candidate.alias);
      if (!cleanAlias || cleanAlias === cleanTerm || seenAliases.has(cleanAlias)) continue;
      seenAliases.add(cleanAlias);
      filteredAliases.push({ alias: cleanAlias, kind: candidate.kind });
    }

    let finalTerm = cleanTerm;
    let finalAliases = filteredAliases;
    if (!finalTerm && filteredAliases.length > 0) {
      finalTerm = filteredAliases[0]!.alias;
      finalAliases = filteredAliases.slice(1);
    }
    if (!finalTerm) return;

    const existing = found.get(finalTerm);
    if (!existing) {
      found.set(finalTerm, {
        term: finalTerm,
        source: `metadata:${link.providerId}:${category}:${externalId}`,
        category,
        aliases: finalAliases,
      });
    } else if (finalAliases.length > 0) {
      const mergedSeen = new Set(existing.aliases.map((item) => item.alias));
      for (const extra of finalAliases) {
        if (extra.alias !== existing.term && !mergedSeen.has(extra.alias)) {
          mergedSeen.add(extra.alias);
          existing.aliases.push(extra);
        }
      }
    }
  };

  try {
    const snapshot = JSON.parse(link.json) as { fields?: { title?: unknown; titleOriginal?: unknown }; aliases?: unknown };
    addEntry(typeof snapshot.fields?.title === "string" ? snapshot.fields.title : null, "work", link.externalId);
    addEntry(typeof snapshot.fields?.titleOriginal === "string" ? snapshot.fields.titleOriginal : null, "work", link.externalId);
    if (Array.isArray(snapshot.aliases)) {
      for (const alias of snapshot.aliases) {
        if (typeof alias === "string") addEntry(alias, "work", link.externalId);
      }
    }
  } catch {
    /* a snapshot that does not read gives no work names; the credits below are still good */
  }

  const characters = store.sqlite
    .prepare(
      "SELECT character_id AS id, name, actors_json AS actors FROM subject_characters WHERE work_id = ? AND provider_id = ? AND subject_id = ? ORDER BY position",
    )
    .all(workId, link.providerId, link.externalId) as Array<{ id: string; name: string; actors: string }>;

  for (const character of characters) {
    if (link.providerId === "bangumi") {
      const detail = readCachedBangumiInfobox(store, "character", String(character.id));
      if (detail.cached) {
        const parsed = parseBangumiInfoboxNames(detail.name || character.name, detail.infobox);
        addEntry(parsed.term, "character", String(character.id), parsed.aliases);
      } else {
        addEntry(character.name, "character", String(character.id));
      }
    } else {
      addEntry(character.name, "character", String(character.id));
    }

    try {
      for (const actor of JSON.parse(character.actors) as Array<{ externalId?: string | number; id?: string | number; name?: string }>) {
        const actorId = String(actor.externalId ?? actor.id ?? character.id);
        if (link.providerId === "bangumi" && (actor.externalId !== undefined || actor.id !== undefined)) {
          const detail = readCachedBangumiInfobox(store, "person", actorId);
          if (detail.cached) {
            const parsed = parseBangumiInfoboxNames(detail.name || actor.name || "", detail.infobox);
            addEntry(parsed.term, "actor", actorId, parsed.aliases);
            continue;
          }
        }
        addEntry(actor.name, "actor", actorId);
      }
    } catch {
      /* an actor list that does not read is skipped */
    }
  }

  return { linked: true, providerId: link.providerId, terms: [...found.values()] };
}

/**
 * The voice dictionary (VOICE-09): terms for every recording and terms for one work. A term is written by hand or taken from the data cached for a
 * linked work, and a hand-written term always wins over an automatic one. Refreshing a work's data only adds and removes the automatic ones.
 */
export class DictionaryService {
  private readonly store: DrizzleStore;
  private correctorInstance: PhoneticCorrector | null = null;
  private correctorWatermark = "";
  private readonly activeEnrichments = new Map<string, AbortController>();

  constructor(store: DrizzleStore) {
    this.store = store;
  }

  private row(termId: string): TermRow {
    const row = this.store.sqlite.prepare("SELECT * FROM dictionary_terms WHERE id = ?").get(termId) as TermRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "that term does not exist");
    return row;
  }

  private requireWork(workId: string): void {
    if (
      !this.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(workId) &&
      !this.store.sqlite.prepare("SELECT 1 FROM removed_works WHERE id = ?").get(workId)
    ) {
      throw new MangaError("NOT_FOUND", "work not found");
    }
  }

  private aliasesByTermIds(termIds: ReadonlyArray<string>): Map<string, DictionaryAlias[]> {
    const map = new Map<string, DictionaryAlias[]>();
    if (termIds.length === 0) return map;
    const chunkSize = 400;
    for (let offset = 0; offset < termIds.length; offset += chunkSize) {
      const slice = termIds.slice(offset, offset + chunkSize);
      const placeholders = slice.map(() => "?").join(",");
      const rows = this.store.sqlite
        .prepare(`SELECT * FROM dictionary_aliases WHERE term_id IN (${placeholders}) ORDER BY created_at, rowid`)
        .all(...slice) as AliasRow[];
      for (const aliasRow of rows) {
        let list = map.get(aliasRow.term_id);
        if (!list) {
          list = [];
          map.set(aliasRow.term_id, list);
        }
        list.push({
          id: aliasRow.id,
          alias: aliasRow.alias,
          kind: aliasRow.kind,
          source: aliasRow.source,
          createdAt: aliasRow.created_at,
        });
      }
    }
    return map;
  }

  private hydrateRows(rows: ReadonlyArray<TermRow>): DictionaryTerm[] {
    if (rows.length === 0) return [];
    const aliasesMap = this.aliasesByTermIds(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      workId: r.work_id || null,
      term: r.term,
      heard: r.heard,
      category: r.category ?? categoryFromSource(r.source, r.source === MANUAL ? "term" : "other"),
      disabled: Boolean(r.disabled),
      blocked: parseBlockedJson(r.blocked_json),
      aliases: aliasesMap.get(r.id) ?? [],
      source: r.source,
      auto: r.source !== MANUAL,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  private hydrateOne(termId: string): DictionaryTerm {
    return this.hydrateRows([this.row(termId)])[0]!;
  }

  private computeWatermark(): string {
    const stats = this.store.sqlite
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM dictionary_terms) AS tc,
          (SELECT COUNT(*) FROM dictionary_aliases) AS ac,
          COALESCE((SELECT MAX(updated_at) FROM dictionary_terms), '') AS mu`,
      )
      .get() as { tc: number; ac: number; mu: string };
    return `${stats.tc}:${stats.ac}:${stats.mu}`;
  }

  private workTitleFor(workId: string | null): string | null {
    if (!workId) return null;
    const row = this.store.sqlite
      .prepare(
        `SELECT COALESCE(w.title, rw.title) AS title
         FROM (SELECT ? AS id) target
         LEFT JOIN works w ON w.id = target.id
         LEFT JOIN removed_works rw ON rw.id = target.id`,
      )
      .get(workId) as { title: string | null } | undefined;
    return row?.title ?? null;
  }

  private toCorrectorEntry(term: DictionaryTerm, workTitle?: string | null): CorrectorTermEntry {
    const aliases: Array<{ alias: string; kind: DictionaryAliasKind }> = term.aliases.map((item) => ({
      alias: item.alias,
      kind: item.kind,
    }));
    if (term.heard && term.heard.trim() && !aliases.some((item) => item.alias === term.heard!.trim())) {
      aliases.unshift({ alias: term.heard.trim(), kind: "heard" });
    }
    return {
      id: term.id,
      scope: term.scope,
      workId: term.workId,
      workTitle: workTitle === undefined ? this.workTitleFor(term.workId) : workTitle,
      term: term.term,
      category: term.category,
      source: term.source,
      disabled: term.disabled,
      aliases,
      blocked: term.blocked,
    };
  }

  private syncCorrectorTerm(termId: string): void {
    if (!this.correctorInstance) return;
    const row = this.store.sqlite.prepare("SELECT * FROM dictionary_terms WHERE id = ?").get(termId) as TermRow | undefined;
    if (!row) {
      this.correctorInstance.removeTerm(termId);
    } else {
      const hydrated = this.hydrateRows([row])[0]!;
      this.correctorInstance.upsertTerm(this.toCorrectorEntry(hydrated));
    }
    this.correctorWatermark = this.computeWatermark();
  }

  private removeCorrectorTerm(termId: string): void {
    if (!this.correctorInstance) return;
    this.correctorInstance.removeTerm(termId);
    this.correctorWatermark = this.computeWatermark();
  }

  /** Computes Mandarin/Japanese/Latin phonetic tokens and human-readable reading in memory. */
  phoneticsOf(text: string): { phonemes: string[]; reading: string } {
    return {
      phonemes: toPhonemes(text).map((p) => p.value),
      reading: describeReading(text),
    };
  }

  /** Lazily loads and incrementally maintains the in-memory 2-gram phonetic corrector. */
  corrector(): PhoneticCorrector {
    const currentWatermark = this.computeWatermark();
    if (this.correctorInstance && this.correctorWatermark === currentWatermark) {
      return this.correctorInstance;
    }
    const rows = this.store.sqlite.prepare("SELECT * FROM dictionary_terms ORDER BY created_at, rowid").all() as TermRow[];
    const terms = this.hydrateRows(rows);
    const workTitleRows = this.store.sqlite
      .prepare("SELECT id, title FROM works UNION ALL SELECT id, title FROM removed_works")
      .all() as Array<{ id: string; title: string }>;
    const titleByWorkId = new Map(workTitleRows.map((w) => [w.id, w.title]));
    const corrector = new PhoneticCorrector();
    for (const term of terms) {
      corrector.upsertTerm(this.toCorrectorEntry(term, term.workId ? (titleByWorkId.get(term.workId) ?? null) : null));
    }
    this.correctorInstance = corrector;
    this.correctorWatermark = currentWatermark;
    return corrector;
  }

  /** Runs stage-2 phonetic recall and deterministic replacement for `rawText`. */
  correct(rawText: string, workId: string | null = null): CorrectionOutput {
    return this.corrector().correct(rawText, { currentWorkId: workId });
  }

  /** Active canonical term strings in scope (`work` + `global` when `workId` is set, else `global` only), for OpenCC protection and LLM guardrails. */
  activeTermStrings(workId: string | null): string[] {
    const rows = workId
      ? (this.store.sqlite
          .prepare("SELECT term FROM dictionary_terms WHERE disabled = 0 AND (scope = 'global' OR (scope = 'work' AND work_id = ?))")
          .all(workId) as Array<{ term: string }>)
      : (this.store.sqlite
          .prepare("SELECT term FROM dictionary_terms WHERE disabled = 0 AND scope = 'global'")
          .all() as Array<{ term: string }>);
    return [...new Set(rows.map((r) => r.term))];
  }

  /** The works whose entry was deleted and that still have terms: what the person wrote for them is kept and found here (A-87). */
  removedWorks(): Array<{ workId: string; title: string; mediaKind: string; terms: number }> {
    return this.store.sqlite.prepare(`SELECT d.work_id AS workId, rw.title AS title, rw.media_kind AS mediaKind, COUNT(*) AS terms
      FROM dictionary_terms d JOIN removed_works rw ON rw.id = d.work_id
      WHERE d.scope = 'work' AND NOT EXISTS (SELECT 1 FROM works w WHERE w.id = d.work_id) GROUP BY d.work_id ORDER BY rw.removed_at DESC`).all() as Array<{
      workId: string;
      title: string;
      mediaKind: string;
      terms: number;
    }>;
  }

  list(filter: { scope?: "global" | "work"; workId?: string; includeDisabled?: boolean } = {}): { terms: DictionaryTerm[] } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.scope) {
      where.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.workId) {
      where.push("work_id = ?");
      params.push(filter.workId);
    }
    if (filter.includeDisabled === false) {
      where.push("disabled = 0");
    }
    const rows = this.store.sqlite
      .prepare(`SELECT * FROM dictionary_terms ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY scope DESC, (source = 'manual') DESC, created_at, rowid`)
      .all(...params) as TermRow[];
    return { terms: this.hydrateRows(rows) };
  }

  private normalizeAliasesInput(
    term: string,
    aliases: ReadonlyArray<DictionaryAliasInput> | undefined,
    heard: string | null | undefined,
  ): Array<{ alias: string; kind: DictionaryAliasKind }> {
    const out: Array<{ alias: string; kind: DictionaryAliasKind }> = [];
    const seen = new Set<string>();
    const push = (rawAlias: string, kind: DictionaryAliasKind) => {
      const clean = rawAlias.replace(/\s+/g, " ").trim();
      if (!clean || clean === term || seen.has(clean)) return;
      seen.add(clean);
      out.push({ alias: clean, kind });
    };
    if (heard) push(heard, "heard");
    if (aliases) {
      for (const item of aliases) push(item.alias, item.kind);
    }
    return out;
  }

  /** Adds a term by hand. An automatic term of the same name becomes the hand-written one, so a later refresh leaves it alone. */
  add(input: {
    scope: "global" | "work";
    workId?: string;
    term: string;
    heard?: string;
    category?: DictionaryCategory;
    disabled?: boolean;
    aliases?: ReadonlyArray<DictionaryAliasInput>;
    blocked?: ReadonlyArray<string>;
  }): DictionaryTerm {
    if (input.scope === "global" && input.workId) {
      throw new MangaError("VALIDATION_ERROR", "a global term cannot have a workId");
    }
    const workId = input.scope === "work" ? (input.workId ?? "") : "";
    if (input.scope === "work") {
      if (!workId) throw new MangaError("VALIDATION_ERROR", "a work term requires workId");
      this.requireWork(workId);
    }
    const term = input.term.trim();
    if (!term) throw new MangaError("VALIDATION_ERROR", "a term cannot be empty");

    const total = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM dictionary_terms").get() as { n: number }).n;
    const existing = this.store.sqlite
      .prepare("SELECT * FROM dictionary_terms WHERE scope = ? AND work_id = ? AND term = ?")
      .get(input.scope, workId, term) as TermRow | undefined;
    if (!existing && total >= MAX_TERMS) {
      throw new MangaError("VALIDATION_ERROR", "the dictionary is full; remove some terms first", { details: { reason: "limit" } });
    }

    const now = new Date().toISOString();
    const id = existing?.id ?? createId("dic");
    const explicitHeard = input.heard !== undefined ? (input.heard.trim() || null) : undefined;
    const normalizedAliases =
      input.aliases !== undefined || explicitHeard !== undefined
        ? this.normalizeAliasesInput(term, input.aliases, explicitHeard)
        : null;
    const heardColumn =
      explicitHeard !== undefined
        ? explicitHeard
        : normalizedAliases
          ? (normalizedAliases.find((a) => a.kind === "heard")?.alias ?? existing?.heard ?? null)
          : (existing?.heard ?? null);
    const category: DictionaryCategory = input.category ?? existing?.category ?? "term";
    const disabled = input.disabled !== undefined ? (input.disabled ? 1 : 0) : (existing?.disabled ?? 0);
    const blockedJson =
      input.blocked !== undefined ? JSON.stringify(normalizeBlockedList(input.blocked)) : (existing?.blocked_json ?? "[]");

    this.store.sqlite.transaction(() => {
      if (existing) {
        this.store.sqlite
          .prepare(
            "UPDATE dictionary_terms SET heard = ?, category = ?, disabled = ?, blocked_json = ?, source = 'manual', updated_at = ? WHERE id = ?",
          )
          .run(heardColumn, category, disabled, blockedJson, now, id);
      } else {
        this.store.sqlite
          .prepare(
            "INSERT INTO dictionary_terms(id, scope, work_id, term, heard, category, disabled, blocked_json, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'manual',?,?)",
          )
          .run(id, input.scope, workId, term, heardColumn, category, disabled, blockedJson, now, now);
      }

      if (input.aliases !== undefined) {
        this.store.sqlite.prepare("DELETE FROM dictionary_aliases WHERE term_id = ?").run(id);
        const ins = this.store.sqlite.prepare(
          "INSERT OR IGNORE INTO dictionary_aliases(id, term_id, alias, kind, source, created_at) VALUES (?, ?, ?, ?, 'manual', ?)",
        );
        for (const aliasItem of normalizedAliases ?? []) {
          ins.run(createId("dica"), id, aliasItem.alias, aliasItem.kind, now);
        }
      } else if (explicitHeard !== undefined) {
        this.store.sqlite.prepare("DELETE FROM dictionary_aliases WHERE term_id = ? AND kind = 'heard'").run(id);
        if (explicitHeard && explicitHeard !== term) {
          this.store.sqlite
            .prepare(
              "INSERT OR IGNORE INTO dictionary_aliases(id, term_id, alias, kind, source, created_at) VALUES (?, ?, ?, 'heard', 'manual', ?)",
            )
            .run(createId("dica"), id, explicitHeard, now);
        }
      }
    })();

    this.syncCorrectorTerm(id);
    return this.hydrateOne(id);
  }

  /** A changed term is the user's, so it is kept as a hand-written term from then on (toggling `disabled` alone preserves automatic provenance). */
  update(input: {
    termId: string;
    term?: string;
    heard?: string | null;
    category?: DictionaryCategory;
    disabled?: boolean;
    aliases?: ReadonlyArray<DictionaryAliasInput>;
    blocked?: ReadonlyArray<string>;
  }): DictionaryTerm {
    const row = this.row(input.termId);
    const term = input.term !== undefined ? input.term.trim() : row.term;
    if (!term) throw new MangaError("VALIDATION_ERROR", "a term cannot be empty");
    const clash = this.store.sqlite
      .prepare("SELECT id FROM dictionary_terms WHERE scope = ? AND work_id = ? AND term = ? AND id <> ?")
      .get(row.scope, row.work_id, term, row.id);
    if (clash) throw new MangaError("VALIDATION_ERROR", "the dictionary already has that term", { details: { reason: "duplicate" } });

    const onlyDisabledToggled =
      input.disabled !== undefined &&
      input.term === undefined &&
      input.heard === undefined &&
      input.category === undefined &&
      input.aliases === undefined &&
      input.blocked === undefined;

    const nextSource = onlyDisabledToggled ? row.source : MANUAL;
    const nextCategory = input.category ?? row.category;
    const nextDisabled = input.disabled !== undefined ? (input.disabled ? 1 : 0) : row.disabled;
    const nextBlockedJson =
      input.blocked !== undefined ? JSON.stringify(normalizeBlockedList(input.blocked)) : row.blocked_json;

    const explicitHeard = input.heard !== undefined ? (input.heard?.trim() || null) : undefined;
    const normalizedAliases =
      input.aliases !== undefined
        ? this.normalizeAliasesInput(term, input.aliases, explicitHeard)
        : null;
    const nextHeard =
      explicitHeard !== undefined
        ? explicitHeard
        : normalizedAliases
          ? (normalizedAliases.find((a) => a.kind === "heard")?.alias ?? null)
          : row.heard;

    const now = new Date().toISOString();
    this.store.sqlite.transaction(() => {
      this.store.sqlite
        .prepare(
          "UPDATE dictionary_terms SET term = ?, heard = ?, category = ?, disabled = ?, blocked_json = ?, source = ?, updated_at = ? WHERE id = ?",
        )
        .run(term, nextHeard, nextCategory, nextDisabled, nextBlockedJson, nextSource, now, row.id);

      if (normalizedAliases !== null) {
        this.store.sqlite.prepare("DELETE FROM dictionary_aliases WHERE term_id = ?").run(row.id);
        const ins = this.store.sqlite.prepare(
          "INSERT OR IGNORE INTO dictionary_aliases(id, term_id, alias, kind, source, created_at) VALUES (?, ?, ?, ?, 'manual', ?)",
        );
        for (const aliasItem of normalizedAliases) {
          ins.run(createId("dica"), row.id, aliasItem.alias, aliasItem.kind, now);
        }
      } else if (explicitHeard !== undefined) {
        this.store.sqlite.prepare("DELETE FROM dictionary_aliases WHERE term_id = ? AND kind = 'heard'").run(row.id);
        if (explicitHeard && explicitHeard !== term) {
          this.store.sqlite
            .prepare(
              "INSERT OR IGNORE INTO dictionary_aliases(id, term_id, alias, kind, source, created_at) VALUES (?, ?, ?, 'heard', 'manual', ?)",
            )
            .run(createId("dica"), row.id, explicitHeard, now);
        }
      } else if (term !== row.term) {
        // Remove any alias that became identical to the renamed canonical term.
        this.store.sqlite.prepare("DELETE FROM dictionary_aliases WHERE term_id = ? AND alias = ?").run(row.id, term);
      }
    })();

    this.syncCorrectorTerm(row.id);
    return this.hydrateOne(row.id);
  }

  /**
   * Used when accepting a learned suggestion: if `term` already exists in the target scope (or global when `workId` is set),
   * appends `heard` as a `heard` alias without wiping existing aliases; otherwise creates a new manual term with that `heard` alias.
   */
  addHeardAliasOrCreateManual(input: {
    scope: "global" | "work";
    workId?: string | null;
    term: string;
    heard: string;
    category?: DictionaryCategory;
  }): DictionaryTerm {
    const cleanTerm = input.term.trim();
    const cleanHeard = input.heard.trim();
    if (!cleanTerm) throw new MangaError("VALIDATION_ERROR", "a term cannot be empty");
    const workId = input.scope === "work" ? (input.workId ?? "") : "";
    if (input.scope === "work") {
      if (!workId) throw new MangaError("VALIDATION_ERROR", "a work term requires workId");
      this.requireWork(workId);
    }

    const existing = (this.store.sqlite
      .prepare("SELECT * FROM dictionary_terms WHERE scope = ? AND work_id = ? AND term = ?")
      .get(input.scope, workId, cleanTerm) ??
      (input.scope === "work"
        ? this.store.sqlite
            .prepare("SELECT * FROM dictionary_terms WHERE scope = 'global' AND work_id = '' AND term = ?")
            .get(cleanTerm)
        : undefined)) as TermRow | undefined;

    if (!existing) {
      return this.add({
        scope: input.scope,
        workId: input.scope === "work" ? workId : undefined,
        term: cleanTerm,
        heard: cleanHeard || undefined,
        category: input.category ?? "term",
        aliases: cleanHeard && cleanHeard !== cleanTerm ? [{ alias: cleanHeard, kind: "heard" }] : [],
      });
    }

    const now = new Date().toISOString();
    this.store.sqlite.transaction(() => {
      if (cleanHeard && cleanHeard !== cleanTerm) {
        this.store.sqlite
          .prepare(
            "INSERT OR IGNORE INTO dictionary_aliases(id, term_id, alias, kind, source, created_at) VALUES (?, ?, ?, 'heard', 'manual', ?)",
          )
          .run(createId("dica"), existing.id, cleanHeard, now);
      }
      const nextHeard = existing.heard || (cleanHeard && cleanHeard !== cleanTerm ? cleanHeard : null);
      this.store.sqlite
        .prepare("UPDATE dictionary_terms SET heard = ?, disabled = 0, updated_at = ? WHERE id = ?")
        .run(nextHeard, now, existing.id);
    })();

    this.syncCorrectorTerm(existing.id);
    return this.hydrateOne(existing.id);
  }

  /**
   * Batch imports manual terms from newline / comma / `、` separated text.
   * Lines containing `|` are parsed as `词条 | 别名1, 别名2`; blank lines are ignored and duplicates are skipped.
   */
  importBatch(input: {
    scope: "global" | "work";
    workId?: string;
    text: string;
    category?: DictionaryCategory;
  }): { added: number; skipped: number; terms: DictionaryTerm[] } {
    if (input.scope === "global" && input.workId) {
      throw new MangaError("VALIDATION_ERROR", "a global term cannot have a workId");
    }
    const workId = input.scope === "work" ? (input.workId ?? "") : "";
    if (input.scope === "work") {
      if (!workId) throw new MangaError("VALIDATION_ERROR", "a work term requires workId");
      this.requireWork(workId);
    }

    const parsedItems: Array<{ term: string; aliases: string[] }> = [];
    for (const rawLine of input.text.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line) continue;
      const pipeAt = line.indexOf("|");
      if (pipeAt >= 0) {
        const termPart = line.slice(0, pipeAt).trim();
        const aliasPart = line.slice(pipeAt + 1);
        if (!termPart) continue;
        const aliases = aliasPart
          .split(/[,，、]+/u)
          .map((item) => item.trim())
          .filter(Boolean);
        parsedItems.push({ term: termPart, aliases });
      } else {
        for (const token of line.split(/[,，、]+/u)) {
          const clean = token.trim();
          if (clean) parsedItems.push({ term: clean, aliases: [] });
        }
      }
    }

    let added = 0;
    let skipped = 0;
    const addedIds: string[] = [];
    const category: DictionaryCategory = input.category ?? "term";

    this.store.sqlite.transaction(() => {
      const existingRows = this.store.sqlite
        .prepare("SELECT term FROM dictionary_terms WHERE scope = ? AND work_id = ?")
        .all(input.scope, workId) as Array<{ term: string }>;
      const seenTerms = new Set(existingRows.map((r) => r.term));
      let total = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM dictionary_terms").get() as { n: number }).n;
      const now = new Date().toISOString();

      const insertTerm = this.store.sqlite.prepare(
        "INSERT INTO dictionary_terms(id, scope, work_id, term, heard, category, disabled, blocked_json, source, created_at, updated_at) VALUES (?,?,?,?,NULL,?,0,'[]','manual',?,?)",
      );
      const insertAlias = this.store.sqlite.prepare(
        "INSERT OR IGNORE INTO dictionary_aliases(id, term_id, alias, kind, source, created_at) VALUES (?, ?, ?, 'alias', 'manual', ?)",
      );

      for (const item of parsedItems) {
        if ([...item.term].length > 128) {
          skipped += 1;
          continue;
        }
        if (seenTerms.has(item.term)) {
          skipped += 1;
          continue;
        }
        if (total >= MAX_TERMS) {
          throw new MangaError("VALIDATION_ERROR", "the dictionary is full; remove some terms first", {
            details: { reason: "limit" },
          });
        }
        const id = createId("dic");
        insertTerm.run(id, input.scope, workId, item.term, category, now, now);
        const seenAliases = new Set<string>();
        for (const alias of item.aliases) {
          if (!alias || alias === item.term || [...alias].length > 128 || seenAliases.has(alias)) continue;
          seenAliases.add(alias);
          insertAlias.run(createId("dica"), id, alias, now);
        }
        seenTerms.add(item.term);
        total += 1;
        added += 1;
        addedIds.push(id);
      }
    })();

    for (const id of addedIds) {
      this.syncCorrectorTerm(id);
    }
    const hydrated = addedIds.length
      ? this.hydrateRows(
          addedIds.map((id) => this.row(id)),
        )
      : [];
    return { added, skipped, terms: hydrated };
  }

  remove(termId: string): { termId: string } {
    this.row(termId);
    this.store.sqlite.prepare("DELETE FROM dictionary_terms WHERE id = ?").run(termId);
    this.removeCorrectorTerm(termId);
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
    const removedIds: string[] = [];
    const upsertedIds: string[] = [];

    this.store.sqlite.transaction(() => {
      const rows = this.store.sqlite
        .prepare("SELECT * FROM dictionary_terms WHERE scope = 'work' AND work_id = ?")
        .all(workId) as TermRow[];
      const have = new Map(rows.map((row) => [row.term, row]));
      const keep = new Set(wanted.terms.map((item) => item.term));
      const now = new Date().toISOString();

      // Track disabled state of removed auto rows by `source` so Japanese -> Chinese canonicalization preserves user's disable toggle.
      const disabledByRemovedSource = new Map<string, number>();
      for (const row of rows) {
        if (row.source !== MANUAL && !keep.has(row.term)) {
          if (row.disabled) disabledByRemovedSource.set(row.source, 1);
          this.store.sqlite.prepare("DELETE FROM dictionary_terms WHERE id = ?").run(row.id);
          removedIds.push(row.id);
          result.removed += 1;
        }
      }

      const syncAutoAliases = (termId: string, source: string, desired: ReadonlyArray<{ alias: string; kind: DictionaryAliasKind }>) => {
        const currentAliases = this.store.sqlite
          .prepare("SELECT alias, kind FROM dictionary_aliases WHERE term_id = ? AND source <> 'manual' ORDER BY created_at, rowid")
          .all(termId) as Array<{ alias: string; kind: DictionaryAliasKind }>;
        const same =
          currentAliases.length === desired.length &&
          currentAliases.every((cur, idx) => cur.alias === desired[idx]!.alias && cur.kind === desired[idx]!.kind);
        if (same) return false;
        this.store.sqlite.prepare("DELETE FROM dictionary_aliases WHERE term_id = ? AND source <> 'manual'").run(termId);
        const ins = this.store.sqlite.prepare(
          "INSERT OR IGNORE INTO dictionary_aliases(id, term_id, alias, kind, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const item of desired) {
          ins.run(createId("dica"), termId, item.alias, item.kind, source, now);
        }
        return true;
      };

      let room = MAX_TERMS - (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM dictionary_terms").get() as { n: number }).n;
      for (const item of wanted.terms) {
        const existing = have.get(item.term);
        if (existing && existing.source === MANUAL) {
          result.manualWins += 1;
          continue;
        }
        if (existing) {
          const aliasesChanged = syncAutoAliases(existing.id, item.source, item.aliases);
          if (existing.source !== item.source || existing.category !== item.category || aliasesChanged) {
            this.store.sqlite
              .prepare("UPDATE dictionary_terms SET source = ?, category = ?, updated_at = ? WHERE id = ?")
              .run(item.source, item.category, now, existing.id);
            upsertedIds.push(existing.id);
          }
          result.kept += 1;
          continue;
        }
        if (room <= 0) continue;
        const id = createId("dic");
        const carriedDisabled = disabledByRemovedSource.get(item.source) ?? 0;
        this.store.sqlite
          .prepare(
            "INSERT INTO dictionary_terms(id, scope, work_id, term, heard, category, disabled, blocked_json, source, created_at, updated_at) VALUES (?,?,?,?,NULL,?,?,'[]',?,?,?)",
          )
          .run(id, "work", workId, item.term, item.category, carriedDisabled, item.source, now, now);
        syncAutoAliases(id, item.source, item.aliases);
        upsertedIds.push(id);
        room -= 1;
        result.added += 1;
      }
    })();

    for (const id of removedIds) this.removeCorrectorTerm(id);
    for (const id of upsertedIds) this.syncCorrectorTerm(id);
    return result;
  }

  /** Cancels an in-flight `enrichFromBangumi` job for `workId`, if any. */
  cancelEnrich(workId: string): boolean {
    const active = this.activeEnrichments.get(workId);
    if (!active) return false;
    active.abort();
    this.activeEnrichments.delete(workId);
    return true;
  }

  /** Cancels every in-flight `enrichFromBangumi` job (on module deactivation or app shutdown). */
  cancelAllEnrich(): void {
    for (const [, controller] of this.activeEnrichments) {
      controller.abort();
    }
    this.activeEnrichments.clear();
  }

  /**
   * Sequentially enriches a Bangumi-linked work's characters and voice actors via `/v0/characters/{id}` and `/v0/persons/{id}`.
   * Order: main characters -> supporting/other characters -> voice actors (deduplicated, strict cap of 60 HTTP requests per work).
   */
  async enrichFromBangumi(input: {
    workId: string;
    client: BangumiClient;
    refresh?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: EnrichBangumiProgress) => void;
  }): Promise<EnrichBangumiResult> {
    this.requireWork(input.workId);
    const link = this.store.sqlite
      .prepare(
        `SELECT provider_id AS providerId, external_id AS externalId
         FROM metadata_snapshots
         WHERE work_id = ? AND provider_id <> 'local' AND detached = 0
         ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get(input.workId) as { providerId: string; externalId: string } | undefined;

    if (!link) {
      return {
        linked: false,
        added: 0,
        removed: 0,
        kept: 0,
        manualWins: 0,
        requestsSent: 0,
        cachedHits: 0,
        budgetReached: false,
        totalTargets: 0,
      };
    }

    if (link.providerId !== "bangumi") {
      const synced = this.syncFromMetadata(input.workId);
      return { ...synced, requestsSent: 0, cachedHits: 0, budgetReached: false, totalTargets: 0 };
    }

    this.activeEnrichments.get(input.workId)?.abort();
    const controller = new AbortController();
    this.activeEnrichments.set(input.workId, controller);
    const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;

    const characters = this.store.sqlite
      .prepare(
        "SELECT character_id AS id, name, relation, actors_json AS actors FROM subject_characters WHERE work_id = ? AND provider_id = 'bangumi' AND subject_id = ? ORDER BY position",
      )
      .all(input.workId, link.externalId) as Array<{ id: string; name: string; relation: string; actors: string }>;

    const mainChars = characters.filter((item) => item.relation.trim() === "主角");
    const supportingChars = characters.filter((item) => item.relation.trim() !== "主角");

    const targets: Array<{ kind: "character" | "person"; id: string }> = [];
    const seenTargets = new Set<string>();
    const pushTarget = (kind: "character" | "person", id: string) => {
      const cleanId = id.trim();
      if (!cleanId) return;
      const key = `${kind}:${cleanId}`;
      if (seenTargets.has(key)) return;
      seenTargets.add(key);
      targets.push({ kind, id: cleanId });
    };

    for (const ch of mainChars) pushTarget("character", String(ch.id));
    for (const ch of supportingChars) pushTarget("character", String(ch.id));
    for (const ch of [...mainChars, ...supportingChars]) {
      try {
        const actors = JSON.parse(ch.actors) as Array<{ externalId?: string | number; id?: string | number }>;
        for (const actor of actors) {
          const actorId = actor.externalId ?? actor.id;
          if (actorId !== undefined && actorId !== null) pushTarget("person", String(actorId));
        }
      } catch {
        /* malformed actors_json is ignored */
      }
    }

    let requestsSent = 0;
    let cachedHits = 0;
    let budgetReached = false;
    const clientRequestsAtStart = input.client.requests;

    const checkCachedStmt = this.store.sqlite.prepare("SELECT 1 FROM bangumi_details WHERE kind = ? AND external_id = ?");
    const upsertDetailStmt = this.store.sqlite.prepare(
      `INSERT INTO bangumi_details(kind, external_id, name, infobox_json, payload_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, external_id) DO UPDATE SET
         name = excluded.name,
         infobox_json = excluded.infobox_json,
         payload_json = excluded.payload_json,
         fetched_at = excluded.fetched_at`,
    );

    try {
      for (let i = 0; i < targets.length; i += 1) {
        if (signal.aborted) {
          throw new MangaError("CANCELLED", "词典详情补全已取消");
        }
        const target = targets[i]!;
        if (!input.refresh && checkCachedStmt.get(target.kind, target.id)) {
          cachedHits += 1;
          input.onProgress?.({
            workId: input.workId,
            completed: i + 1,
            total: targets.length,
            requestsSent,
            cachedHits,
          });
          continue;
        }

        const transportUsed = input.client.requests - clientRequestsAtStart;
        const usedSoFar = Math.max(requestsSent, transportUsed);
        if (usedSoFar >= BANGUMI_DETAIL_REQUEST_BUDGET) {
          budgetReached = true;
          continue;
        }

        try {
          const detail =
            target.kind === "character"
              ? await input.client.character(target.id, signal)
              : await input.client.person(target.id, signal);
          requestsSent = Math.max(requestsSent + 1, input.client.requests - clientRequestsAtStart);
          const now = new Date().toISOString();
          upsertDetailStmt.run(
            target.kind,
            target.id,
            detail.name,
            detail.infobox ? JSON.stringify(detail.infobox) : null,
            JSON.stringify(detail),
            now,
          );
        } catch (error) {
          requestsSent = Math.max(requestsSent, input.client.requests - clientRequestsAtStart);
          if (signal.aborted || (error instanceof MangaError && error.code === "CANCELLED")) {
            throw new MangaError("CANCELLED", "词典详情补全已取消");
          }
          if (error instanceof MangaError && error.code === "NOT_FOUND") {
            // An individual missing character/person page does not abort the rest of the work.
          } else {
            // Persist any already-cached details into dictionary_terms before surfacing auth/rate-limit/network errors.
            this.syncFromMetadata(input.workId);
            throw error;
          }
        }

        input.onProgress?.({
          workId: input.workId,
          completed: i + 1,
          total: targets.length,
          requestsSent,
          cachedHits,
        });
      }
    } finally {
      if (this.activeEnrichments.get(input.workId) === controller) {
        this.activeEnrichments.delete(input.workId);
      }
    }

    const synced = this.syncFromMetadata(input.workId);
    return {
      ...synced,
      requestsSent,
      cachedHits,
      budgetReached,
      totalTargets: targets.length,
    };
  }

  /** After a refresh or an unlink: only a work that already took terms from its source follows it, so nothing appears that the user did not ask for. */
  followMetadata(workId: string): void {
    const hasAuto = this.store.sqlite
      .prepare("SELECT 1 FROM dictionary_terms WHERE scope = 'work' AND work_id = ? AND source <> 'manual' LIMIT 1")
      .get(workId);
    if (hasAuto) this.syncFromMetadata(workId);
  }

  /** Active (`disabled = 0`) terms in the order a transcription hint is built: the work's own, then those taken from its data, then the global ones. */
  ordered(workId: string | null): DictionaryTerm[] {
    const rows = workId
      ? (this.store.sqlite
          .prepare(
            `SELECT * FROM dictionary_terms
             WHERE disabled = 0 AND (scope = 'global' OR (scope = 'work' AND work_id = ?))
             ORDER BY CASE WHEN scope = 'work' AND source = 'manual' THEN 0 WHEN scope = 'work' THEN 1 ELSE 2 END, created_at, rowid`,
          )
          .all(workId) as TermRow[])
      : (this.store.sqlite
          .prepare("SELECT * FROM dictionary_terms WHERE disabled = 0 AND scope = 'global' ORDER BY (source = 'manual') DESC, created_at, rowid")
          .all() as TermRow[]);
    return this.hydrateRows(rows);
  }

  /**
   * Builds up to `limit` (default 50) sanitized hotwords for `sherpa-onnx` models.
   * Priority: manual terms -> main characters -> supporting characters -> voice actors -> work/term/other, excluding disabled terms.
   */
  hotwordsFor(workId: string | null, limit = MAX_HOTWORDS): string[] {
    if (limit <= 0) return [];
    const rows = workId
      ? (this.store.sqlite
          .prepare(
            "SELECT * FROM dictionary_terms WHERE disabled = 0 AND (scope = 'global' OR (scope = 'work' AND work_id = ?)) ORDER BY created_at, rowid",
          )
          .all(workId) as TermRow[])
      : (this.store.sqlite
          .prepare("SELECT * FROM dictionary_terms WHERE disabled = 0 AND scope = 'global' ORDER BY created_at, rowid")
          .all() as TermRow[]);

    const mainCharacterSources = new Set<string>();
    const characterPositions = new Map<string, number>();
    if (workId) {
      const charRows = this.store.sqlite
        .prepare("SELECT provider_id AS providerId, character_id AS id, relation, position FROM subject_characters WHERE work_id = ? ORDER BY position")
        .all(workId) as Array<{ providerId: string; id: string; relation: string; position: number }>;
      for (const ch of charRows) {
        const src = `metadata:${ch.providerId}:character:${ch.id}`;
        if (!characterPositions.has(src)) characterPositions.set(src, ch.position);
        if (ch.relation.trim() === "主角") mainCharacterSources.add(src);
      }
    }

    const bucketOf = (row: TermRow): number => {
      if (row.source === MANUAL) return row.scope === "work" ? 0 : 1;
      const cat = row.category ?? categoryFromSource(row.source);
      if (cat === "character") {
        return mainCharacterSources.has(row.source) ? 2 : 3;
      }
      if (cat === "actor") return 4;
      return row.scope === "work" ? 5 : 6;
    };

    const indexed = rows.map((row, idx) => ({
      row,
      idx,
      bucket: bucketOf(row),
      charPos: characterPositions.get(row.source) ?? Number.MAX_SAFE_INTEGER,
    }));

    indexed.sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      if (a.charPos !== b.charPos) return a.charPos - b.charPos;
      return a.idx - b.idx;
    });

    const out: string[] = [];
    const seen = new Set<string>();
    for (const { row } of indexed) {
      if (out.length >= limit) break;
      const cleaned = cleanHotwordForSherpa(row.term);
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleaned);
    }
    return out;
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
    return this.store.sqlite
      .prepare("SELECT term, heard FROM dictionary_terms WHERE scope = 'work' AND work_id = ? ORDER BY (source = 'manual') DESC, created_at, rowid")
      .all(workId) as Array<{ term: string; heard: string | null }>;
  }

  removeWorkTerm(workId: string, term: string): boolean {
    const clean = term.trim();
    const existing = this.store.sqlite
      .prepare("SELECT id FROM dictionary_terms WHERE scope = 'work' AND work_id = ? AND term = ?")
      .all(workId, clean) as Array<{ id: string }>;
    const changed =
      this.store.sqlite.prepare("DELETE FROM dictionary_terms WHERE scope = 'work' AND work_id = ? AND term = ?").run(workId, clean)
        .changes > 0;
    for (const row of existing) this.removeCorrectorTerm(row.id);
    return changed;
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
