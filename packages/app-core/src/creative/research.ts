import { createHash } from "node:crypto";
import { MangaError, createId, EXCERPT_TEXT_LIMIT, RESEARCH_SCOPES, type ResearchScope } from "@manga/contracts";
import { matchQuery, ngramsFor, type DrizzleStore } from "@manga/storage-drizzle";
import type { NetworkBroker } from "../net/broker.ts";
import { listNotes } from "../reading-service.ts";
import { extractPage } from "./extract.ts";

type PageRow = { id: string; url: string; title: string; fetched_at: string; content_hash: string; body_text: string; version: number; previous_id: string | null; created_at: string };
type ExcerptRow = { id: string; project_id: string | null; page_id: string; title: string; text: string; start_offset: number; end_offset: number; note: string; created_at: string };

export type PageSummary = { id: string; url: string; title: string; fetchedAt: string; contentHash: string; version: number; previousId: string | null; chars: number; excerpts: number; latest: boolean };
export type ExcerptView = {
  id: string; projectId: string | null; pageId: string; url: string; pageTitle: string; title: string; text: string; start: number; end: number; note: string;
  createdAt: string; fetchedAt: string; version: number;
  /** A newer version of the page was fetched after this excerpt was taken from its version. */
  newerVersion: { id: string; version: number; fetchedAt: string } | null;
};
export type SearchResult = {
  kind: ResearchScope; id: string; title: string; snippet: string; at: string | null; inProject: boolean;
  workId?: string; resourceId?: string; mediaKind?: string; startMs?: number; url?: string; start?: number;
};

export type ResearchHooks = { broker: NetworkBroker; featureOn?: (featureId: string) => boolean };

const MAX_PAGES = 2000;
const MAX_VERSIONS_PER_URL = 20;
const MAX_EXCERPTS = 20_000;
const WINDOW = 1200;
const OVERLAP = 120;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 120;

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
const like = (needle: string) => `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/** The address a page is kept under: the one the person gave, without the part after `#`, which only picks a place inside the page. */
export function pageKey(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.toString();
}

/** A stretch of text around the first place the needle occurs (case-insensitive), or the start of the text when it does not occur whole. */
export function snippetAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(needle.trim().toLowerCase());
  const start = at < 0 ? 0 : Math.max(0, at - SNIPPET_BEFORE);
  const piece = flat.slice(start, start + SNIPPET_BEFORE + SNIPPET_AFTER + (at < 0 ? 0 : needle.length));
  return `${start > 0 ? "…" : ""}${piece}${start + piece.length < flat.length ? "…" : ""}`;
}

/**
 * Searching the person's own material and keeping excerpts of web pages (CRE-06). Local search spans works, notes, recording transcripts and
 * excerpts. The only outside access is fetching the one address the person gave, through the network broker: the text is extracted without
 * running the page, kept as a version of that address, and a later fetch that finds the page changed makes a new version instead of
 * overwriting. An excerpt points into one version, so it keeps saying what the page said when it was taken.
 */
export class ResearchService {
  private readonly store: DrizzleStore;
  private readonly hooks: ResearchHooks;

  constructor(store: DrizzleStore, hooks: ResearchHooks) {
    this.store = store;
    this.hooks = hooks;
  }

  // ------------------------------------------------------------------ pages

  private page(pageId: string): PageRow {
    const row = this.store.sqlite.prepare("SELECT * FROM excerpt_pages WHERE id = ?").get(pageId) as PageRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the page is not kept");
    return row;
  }

  private latest(url: string): PageRow | undefined {
    return this.store.sqlite.prepare("SELECT * FROM excerpt_pages WHERE url = ? ORDER BY version DESC LIMIT 1").get(url) as PageRow | undefined;
  }

  private summary(row: PageRow): PageSummary {
    const excerpts = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM excerpts WHERE page_id = ?").get(row.id) as { n: number }).n;
    return {
      id: row.id, url: row.url, title: row.title, fetchedAt: row.fetched_at, contentHash: row.content_hash, version: row.version, previousId: row.previous_id,
      chars: [...row.body_text].length, excerpts, latest: this.latest(row.url)?.id === row.id,
    };
  }

  /** Fetches the page, keeps its text, and says whether it is new, changed since the last time, or the same. */
  async fetch(rawUrl: string, signal?: AbortSignal): Promise<{ page: PageSummary; created: boolean; changed: boolean; previousId: string | null }> {
    const fetched = await this.hooks.broker.fetchText(rawUrl, signal);
    const url = pageKey(fetched.requestedUrl);
    const host = new URL(fetched.finalUrl).hostname;
    const { title, text } = extractPage(fetched.text, fetched.contentType, host);
    if (!text.trim()) throw new MangaError("UNSUPPORTED_FORMAT", "no readable text was found on that page", { details: { reason: "empty" } });
    const hash = hashOf(text);
    const last = this.latest(url);
    if (last && last.content_hash === hash) return { page: this.summary(last), created: false, changed: false, previousId: last.previous_id };
    if (!last && (this.store.sqlite.prepare("SELECT COUNT(DISTINCT url) AS n FROM excerpt_pages").get() as { n: number }).n >= MAX_PAGES) {
      throw new MangaError("QUOTA_EXCEEDED", "too many pages are kept; delete some first", { details: { reason: "limit" } });
    }
    const id = createId("pgv");
    const now = new Date().toISOString();
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("INSERT INTO excerpt_pages(id, url, title, fetched_at, content_hash, body_text, version, previous_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, url, title, now, hash, text, (last?.version ?? 0) + 1, last?.id ?? null, now);
      this.indexPage(id, text);
      this.prune(url);
    })();
    return { page: this.summary(this.page(id)), created: !last, changed: Boolean(last), previousId: last?.id ?? null };
  }

  /**
   * Keeps a page that came in a project package: the same address with the same text is not kept twice, so its id is used; otherwise it becomes the
   * newest version of its address here, under the id the package knew it by when that is free. Nothing is fetched.
   */
  adoptPage(page: { url: string; title: string; fetched_at: string; content_hash: string; body_text: string; created_at?: string }, preferredId?: string): string {
    const same = this.store.sqlite.prepare("SELECT id FROM excerpt_pages WHERE url = ? AND content_hash = ?").get(page.url, page.content_hash) as { id: string } | undefined;
    if (same) return same.id;
    const last = this.latest(page.url);
    if (!last && (this.store.sqlite.prepare("SELECT COUNT(DISTINCT url) AS n FROM excerpt_pages").get() as { n: number }).n >= MAX_PAGES) {
      throw new MangaError("QUOTA_EXCEEDED", "too many pages are kept; delete some first", { details: { reason: "limit" } });
    }
    const id = preferredId && !this.store.sqlite.prepare("SELECT 1 FROM excerpt_pages WHERE id = ?").get(preferredId) ? preferredId : createId("pgv");
    this.store.sqlite.prepare("INSERT INTO excerpt_pages(id, url, title, fetched_at, content_hash, body_text, version, previous_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, page.url, page.title, page.fetched_at, page.content_hash, page.body_text, (last?.version ?? 0) + 1, last?.id ?? null, page.created_at ?? new Date().toISOString());
    this.indexPage(id, page.body_text);
    return id;
  }

  /** The oldest versions of an address go when there are too many, except any an excerpt still points into. */
  private prune(url: string): void {
    const rows = this.store.sqlite.prepare("SELECT id FROM excerpt_pages WHERE url = ? AND id NOT IN (SELECT page_id FROM excerpts) ORDER BY version DESC").all(url) as Array<{ id: string }>;
    const total = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM excerpt_pages WHERE url = ?").get(url) as { n: number }).n;
    for (const old of rows.slice(Math.max(0, rows.length - Math.max(0, total - MAX_VERSIONS_PER_URL)))) this.dropPage(old.id);
  }

  private dropPage(pageId: string): void {
    this.store.sqlite.prepare("DELETE FROM research_idx WHERE ref_kind = 'page' AND ref_id = ?").run(pageId);
    this.store.sqlite.prepare("DELETE FROM excerpt_pages WHERE id = ?").run(pageId);
  }

  private indexPage(pageId: string, text: string): void {
    const insert = this.store.sqlite.prepare("INSERT INTO research_idx(ref_kind, ref_id, start_offset, text, ngrams) VALUES ('page', ?, ?, ?, ?)");
    const chars = [...text];
    // Windows are counted in code points while offsets are in UTF-16 units; the index only has to say roughly where, the page text itself is exact.
    let offset = 0;
    for (let at = 0; at < chars.length; at += WINDOW - OVERLAP) {
      const part = chars.slice(at, at + WINDOW).join("");
      insert.run(pageId, offset, part, ngramsFor(part));
      offset += chars.slice(at, at + WINDOW - OVERLAP).join("").length;
      if (at + WINDOW >= chars.length) break;
    }
  }

  pages(limit = 100): { pages: PageSummary[] } {
    const rows = this.store.sqlite.prepare(`SELECT * FROM excerpt_pages p WHERE version = (SELECT MAX(version) FROM excerpt_pages q WHERE q.url = p.url) ORDER BY fetched_at DESC LIMIT ?`).all(limit) as PageRow[];
    return { pages: rows.map((row) => this.summary(row)) };
  }

  getPage(pageId: string): { page: PageSummary; text: string; versions: Array<{ id: string; version: number; fetchedAt: string; contentHash: string; chars: number; current: boolean }>; excerpts: ExcerptView[] } {
    const row = this.page(pageId);
    const versions = this.store.sqlite.prepare("SELECT id, version, fetched_at, content_hash, body_text FROM excerpt_pages WHERE url = ? ORDER BY version DESC").all(row.url) as Array<{ id: string; version: number; fetched_at: string; content_hash: string; body_text: string }>;
    return {
      page: this.summary(row), text: row.body_text,
      versions: versions.map((item) => ({ id: item.id, version: item.version, fetchedAt: item.fetched_at, contentHash: item.content_hash, chars: [...item.body_text].length, current: item.id === row.id })),
      excerpts: this.excerpts({ pageId }).excerpts,
    };
  }

  /** A page version goes, unless an excerpt points into it. */
  deletePage(pageId: string): { pageId: string } {
    const row = this.page(pageId);
    const used = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM excerpts WHERE page_id = ?").get(row.id) as { n: number }).n;
    if (used) throw new MangaError("VALIDATION_ERROR", "excerpts still point into this page; delete them first", { details: { reason: "inUse", excerpts: used } });
    this.store.sqlite.transaction(() => this.dropPage(row.id))();
    return { pageId };
  }

  // ------------------------------------------------------------------ excerpts

  private view(row: ExcerptRow): ExcerptView {
    const page = this.page(row.page_id);
    const newest = this.latest(page.url);
    return {
      id: row.id, projectId: row.project_id, pageId: row.page_id, url: page.url, pageTitle: page.title, title: row.title, text: row.text, start: row.start_offset, end: row.end_offset,
      note: row.note, createdAt: row.created_at, fetchedAt: page.fetched_at, version: page.version,
      newerVersion: newest && newest.version > page.version ? { id: newest.id, version: newest.version, fetchedAt: newest.fetched_at } : null,
    };
  }

  private excerptRow(excerptId: string): ExcerptRow {
    const row = this.store.sqlite.prepare("SELECT * FROM excerpts WHERE id = ?").get(excerptId) as ExcerptRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the excerpt does not exist");
    return row;
  }

  indexExcerpt(row: Pick<ExcerptRow, "id" | "title" | "text" | "note">): void {
    this.store.sqlite.prepare("DELETE FROM research_idx WHERE ref_kind = 'excerpt' AND ref_id = ?").run(row.id);
    const text = `${row.title}\n${row.text}\n${row.note}`.trim();
    this.store.sqlite.prepare("INSERT INTO research_idx(ref_kind, ref_id, start_offset, text, ngrams) VALUES ('excerpt', ?, 0, ?, ?)").run(row.id, text, ngramsFor(text));
  }

  create(input: { pageId: string; start: number; end: number; title?: string; note?: string; projectId?: string }): ExcerptView {
    const page = this.page(input.pageId);
    if (input.projectId && !this.store.sqlite.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) throw new MangaError("NOT_FOUND", "the project does not exist");
    if (input.end > page.body_text.length) throw new MangaError("VALIDATION_ERROR", "the excerpt reaches past the end of the page", { details: { reason: "range" } });
    const text = page.body_text.slice(input.start, input.end);
    if (!text.trim()) throw new MangaError("VALIDATION_ERROR", "the excerpt is empty", { details: { reason: "empty" } });
    if (text.length > EXCERPT_TEXT_LIMIT) throw new MangaError("VALIDATION_ERROR", "the excerpt is too long", { details: { reason: "tooLong", limit: EXCERPT_TEXT_LIMIT } });
    if ((this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM excerpts").get() as { n: number }).n >= MAX_EXCERPTS) throw new MangaError("QUOTA_EXCEEDED", "there are too many excerpts", { details: { reason: "limit" } });
    const id = createId("exc");
    const title = input.title?.trim() || text.replace(/\s+/g, " ").slice(0, 40);
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("INSERT INTO excerpts(id, project_id, page_id, title, text, start_offset, end_offset, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, input.projectId ?? null, page.id, title, text, input.start, input.end, input.note ?? "", new Date().toISOString());
      this.indexExcerpt({ id, title, text, note: input.note ?? "" });
    })();
    return this.view(this.excerptRow(id));
  }

  excerpts(filter: { projectId?: string; pageId?: string } = {}): { excerpts: ExcerptView[] } {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.projectId) { where.push("project_id = ?"); params.push(filter.projectId); }
    if (filter.pageId) { where.push("page_id = ?"); params.push(filter.pageId); }
    const rows = this.store.sqlite.prepare(`SELECT * FROM excerpts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id`).all(...params) as ExcerptRow[];
    return { excerpts: rows.map((row) => this.view(row)) };
  }

  get(excerptId: string): { excerpt: ExcerptView } {
    return { excerpt: this.view(this.excerptRow(excerptId)) };
  }

  update(excerptId: string, patch: { title?: string; note?: string }): ExcerptView {
    const row = this.excerptRow(excerptId);
    const title = patch.title === undefined ? row.title : patch.title.trim() || row.title;
    const note = patch.note ?? row.note;
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("UPDATE excerpts SET title = ?, note = ? WHERE id = ?").run(title, note, excerptId);
      this.indexExcerpt({ id: excerptId, title, text: row.text, note });
    })();
    return this.view(this.excerptRow(excerptId));
  }

  delete(excerptId: string): { excerptId: string } {
    this.excerptRow(excerptId);
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("DELETE FROM research_idx WHERE ref_kind = 'excerpt' AND ref_id = ?").run(excerptId);
      this.store.sqlite.prepare("DELETE FROM project_materials WHERE kind = 'excerpt' AND target_id = ?").run(excerptId);
      this.store.sqlite.prepare("DELETE FROM excerpts WHERE id = ?").run(excerptId);
    })();
    return { excerptId };
  }

  /** Forgets the search entries of excerpts that went with their project. */
  forgetExcerpts(ids: string[]): void {
    for (const id of ids) this.store.sqlite.prepare("DELETE FROM research_idx WHERE ref_kind = 'excerpt' AND ref_id = ?").run(id);
  }

  /** The same passage in the newest version of its page, kept as an excerpt of its own; the old one stays as it was. */
  follow(excerptId: string): { status: "current" | "found" | "missing"; excerpt?: ExcerptView } {
    const row = this.excerptRow(excerptId);
    const page = this.page(row.page_id);
    const newest = this.latest(page.url);
    if (!newest || newest.id === page.id) return { status: "current" };
    let at = newest.body_text.indexOf(row.text);
    let length = row.text.length;
    if (at < 0) {
      // The page may have moved its line breaks; look for the same words with any whitespace between them.
      const words = row.text.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const found = words.length ? new RegExp(words.join("\\s+")).exec(newest.body_text) : null;
      if (found) { at = found.index; length = found[0].length; }
    }
    if (at < 0) return { status: "missing" };
    const made = this.create({ pageId: newest.id, start: at, end: at + length, title: row.title, note: row.note, ...(row.project_id ? { projectId: row.project_id } : {}) });
    return { status: "found", excerpt: made };
  }

  // ------------------------------------------------------------------ search

  private inProject(kind: string, id: string, projectId?: string): boolean {
    const row = projectId
      ? this.store.sqlite.prepare("SELECT 1 FROM project_materials WHERE project_id = ? AND kind = ? AND target_id = ?").get(projectId, kind, id)
      : this.store.sqlite.prepare("SELECT 1 FROM project_materials WHERE kind = ? AND target_id = ? LIMIT 1").get(kind, id);
    return Boolean(row);
  }

  /** One list for the person's own material: each result says what it is, where it is and a stretch of text around the match. */
  search(input: { text: string; scopes?: ResearchScope[]; projectId?: string; limit?: number }): { results: SearchResult[]; counts: Record<ResearchScope, number> } {
    const text = input.text.trim();
    const limit = input.limit ?? 30;
    const scopes = new Set(input.scopes ?? RESEARCH_SCOPES);
    const results: SearchResult[] = [];
    const counts = Object.fromEntries(RESEARCH_SCOPES.map((scope) => [scope, 0])) as Record<ResearchScope, number>;
    const add = (result: SearchResult) => { results.push(result); counts[result.kind] += 1; };
    const sqlite = this.store.sqlite;
    const on = (featureId: string) => !this.hooks.featureOn || this.hooks.featureOn(featureId);

    if (scopes.has("work") && on("library")) {
      const seen = new Set<string>();
      const resourceOf = sqlite.prepare("SELECT r.id AS id, r.title AS title, r.kind AS mediaKind, r.work_id AS workId, w.title AS workTitle FROM resources r LEFT JOIN works w ON w.id = r.work_id WHERE r.id = ?");
      for (const hit of this.store.search({ text, kinds: ["title", "body"], limit: limit * 4 })) {
        if (!hit.resourceId) continue;
        const resource = resourceOf.get(hit.resourceId) as { id: string; title: string; mediaKind: string; workId: string | null; workTitle: string | null } | undefined;
        if (!resource) continue;
        const key = resource.workId ?? resource.id;
        if (seen.has(key)) continue;
        seen.add(key);
        add({
          kind: "work", id: resource.workId ?? resource.id, title: resource.workTitle ?? resource.title, snippet: hit.kind === "title" ? resource.title : snippetAround(hit.text, text), at: null,
          inProject: this.inProject(resource.workId ? "work" : "resource", resource.workId ?? resource.id, input.projectId), resourceId: resource.id, mediaKind: resource.mediaKind, ...(resource.workId ? { workId: resource.workId } : {}),
        });
        if (seen.size >= limit) break;
      }
      for (const work of sqlite.prepare("SELECT w.id AS id, w.title AS title, (SELECT r.id FROM resources r WHERE r.work_id = w.id ORDER BY r.created_at LIMIT 1) AS resourceId, (SELECT r.kind FROM resources r WHERE r.work_id = w.id LIMIT 1) AS mediaKind FROM works w WHERE w.title LIKE ? ESCAPE '\\' LIMIT ?").all(like(text), limit) as Array<{ id: string; title: string; resourceId: string | null; mediaKind: string | null }>) {
        if (seen.has(work.id) || seen.size >= limit) continue;
        seen.add(work.id);
        add({ kind: "work", id: work.id, title: work.title, snippet: work.title, at: null, inProject: this.inProject("work", work.id, input.projectId), workId: work.id, ...(work.resourceId ? { resourceId: work.resourceId } : {}), ...(work.mediaKind ? { mediaKind: work.mediaKind } : {}) });
      }
    }

    if (scopes.has("note") && on("notes")) {
      for (const note of listNotes(this.store, { text, limit }) as Array<{ objectId: string; title: string; preview: string; updatedAt: string }>) {
        add({ kind: "note", id: note.objectId, title: note.title, snippet: snippetAround(note.preview, text), at: note.updatedAt, inProject: this.inProject("note", note.objectId, input.projectId) });
      }
    }

    if (scopes.has("recording") && on("voice")) {
      const rows = sqlite.prepare(`SELECT s.session_id AS id, s.start_ms AS startMs, COALESCE(NULLIF(s.revised_text, ''), s.text) AS text, c.created_at AS at, c.work_id AS workId
        FROM transcript_segments s JOIN capture_sessions c ON c.id = s.session_id
        WHERE COALESCE(NULLIF(s.revised_text, ''), s.text) LIKE ? ESCAPE '\\' ORDER BY c.created_at DESC, s.start_ms LIMIT ?`).all(like(text), limit * 5) as Array<{ id: string; startMs: number; text: string; at: string; workId: string | null }>;
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.id) || seen.size >= limit) continue;
        seen.add(row.id);
        add({ kind: "recording", id: row.id, title: `录音 ${row.at.slice(0, 16).replace("T", " ")}`, snippet: snippetAround(row.text, text), at: row.at, inProject: this.inProject("recording", row.id, input.projectId), startMs: row.startMs, ...(row.workId ? { workId: row.workId } : {}) });
      }
    }

    const match = matchQuery(text);
    if (match && (scopes.has("excerpt") || scopes.has("page")) && on("research")) {
      const rows = sqlite.prepare("SELECT ref_kind AS kind, ref_id AS id, start_offset AS start, text FROM research_idx WHERE ngrams MATCH ? ORDER BY rank LIMIT ?").all(match, limit * 6) as Array<{ kind: "excerpt" | "page"; id: string; start: number; text: string }>;
      const seen = new Set<string>();
      for (const row of rows) {
        if (!scopes.has(row.kind) || seen.has(`${row.kind}:${row.id}`)) continue;
        // The full-text match works on short pieces of the words; the person asked for the whole phrase, so that is what is checked.
        if (!row.text.toLowerCase().includes(text.toLowerCase()) && !/\s/.test(text)) continue;
        if (row.kind === "excerpt") {
          const excerpt = sqlite.prepare("SELECT e.id, e.title, e.text, e.project_id AS projectId, e.created_at AS at, p.url AS url FROM excerpts e JOIN excerpt_pages p ON p.id = e.page_id WHERE e.id = ?").get(row.id) as { id: string; title: string; text: string; projectId: string | null; at: string; url: string } | undefined;
          if (!excerpt || (input.projectId && excerpt.projectId !== input.projectId && !this.inProject("excerpt", excerpt.id, input.projectId))) continue;
          seen.add(`excerpt:${row.id}`);
          add({ kind: "excerpt", id: excerpt.id, title: excerpt.title, snippet: snippetAround(excerpt.text, text), at: excerpt.at, inProject: excerpt.projectId === input.projectId || this.inProject("excerpt", excerpt.id, input.projectId), url: excerpt.url });
        } else {
          const page = sqlite.prepare("SELECT id, url, title, fetched_at AS at, version FROM excerpt_pages p WHERE id = ? AND version = (SELECT MAX(version) FROM excerpt_pages q WHERE q.url = p.url)").get(row.id) as { id: string; url: string; title: string; at: string; version: number } | undefined;
          if (!page) continue;
          seen.add(`page:${row.id}`);
          add({ kind: "page", id: page.id, title: page.title || page.url, snippet: snippetAround(row.text, text), at: page.at, inProject: false, url: page.url, start: row.start });
        }
        if (seen.size >= limit * 2) break;
      }
    }
    return { results, counts };
  }
}
