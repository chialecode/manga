import { createHash } from "node:crypto";
import { MangaError, createId, DRAFT_TEXT_LIMIT, type DraftSourceKind, type DraftSuggestionKind, type DraftSuggestionStatus } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import type { LlmPort } from "../voice/ports.ts";
import { featureOfKind, isObjectKind } from "./objects.ts";

type DraftRow = { id: string; project_id: string | null; title: string; text: string; version: number; created_at: string; updated_at: string };
type SuggestionRow = {
  id: string; draft_id: string; kind: DraftSuggestionKind; instruction: string; status: DraftSuggestionStatus; base_version: number; base_text: string; result_text: string;
  sources_json: string; model_json: string | null; adopted_version: number | null; created_at: string; updated_at: string;
};

/** What a suggestion was made from: the text of one source as it was when the model was asked, with a hash to tell later whether it changed. */
export type SourceSnapshot = { kind: DraftSourceKind; targetId: string; label: string; hash: string; text: string };
type ModelInfo = {
  connectionId: string | null; model?: string; range?: { start: number; end: number }; language?: string; by?: "agent";
  generated?: string; adoptedFrom?: number; error?: { code: string; message: string }; finishedAt?: string;
};
export type SourceRef = { kind: DraftSourceKind; targetId: string };
export type SourceState = "same" | "changed" | "missing" | "disabled";

export type DraftSummary = { id: string; projectId: string | null; title: string; version: number; chars: number; pending: number; createdAt: string; updatedAt: string };
export type DraftDoc = { id: string; projectId: string | null; title: string; text: string; version: number; createdAt: string; updatedAt: string };
export type VersionSummary = { version: number; label: string; chars: number; createdAt: string; current: boolean };
export type SuggestionView = {
  id: string; draftId: string; kind: DraftSuggestionKind; instruction: string; status: DraftSuggestionStatus; baseVersion: number; adoptedVersion: number | null;
  createdAt: string; updatedAt: string; connectionId: string | null; model: string | null; /** Who wrote the text: an agent that gave it with the request, or null when a model was asked. */ by: "agent" | null; range: { start: number; end: number } | null; language: string | null;
  /** The start of what the model wrote; the whole text is in `generated` of the full view. */
  preview: string;
  error: { code: string; message: string } | null;
  /** The draft moved on since the suggestion was made, so taking it would replace newer text. */
  baseChanged: boolean;
  /** At least one source changed or is gone since the suggestion was made ("依据已变化"). */
  stale: boolean;
  sources: Array<{ kind: DraftSourceKind; targetId: string; label: string; state: SourceState }>;
};
export type SuggestionDetail = Omit<SuggestionView, "sources"> & {
  baseText: string; resultText: string; generated: string;
  /** The material the suggestion quoted, as it was: shown apart from what was generated. */
  quoted: Array<{ kind: DraftSourceKind; targetId: string; label: string; text: string }>;
  sources: Array<SuggestionView["sources"][number] & { before: string; after: string | null }>;
};

export type DraftHooks = {
  llm: () => LlmPort;
  featureOn?: (featureId: string) => boolean;
  notify?: (topic: string, payload: Record<string, unknown>) => void;
  /** The text connection the project's conversations use, when it picked one. */
  projectConnection?: (projectId: string) => string | null;
};

const MAX_DRAFTS = 2000;
const MAX_VERSIONS = 100;
const MAX_SUGGESTIONS = 200;
const MAX_RUNNING_PER_DRAFT = 3;
const SOURCE_CHARS = 6000;
const PROMPT_SOURCE_CHARS = 24_000;
const VERSION_GAP_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 120_000;
const PREVIEW_CHARS = 120;

const SOURCE_FEATURE: Partial<Record<DraftSourceKind, string>> = { terms: "projects" };
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const SYSTEM = [
  "你是写作助手，帮人修改和扩写文稿。",
  "只输出可以直接放进文稿的正文：不要解释，不要加前后缀，不要使用代码块或标题行说明。",
  "保持文稿原有的语言和语气，除非要求翻译。",
  "引用材料时，在相应句子末尾用 [编号] 标注，编号对应“引用材料”列表；不得编造材料里没有的内容或出处。",
].join("\n");

/**
 * Drafts (CRE-05): text with a version history, and suggestions made for it. A suggestion is written in the background from the draft and the
 * chosen sources, kept apart from the draft, and shown as a difference. Only taking it changes the draft, and that can be undone: whatever
 * was there is saved as a version first. A suggestion remembers the sources as they were; when one of them changes later, the suggestion says
 * its basis changed and shows old and new side by side, and the person decides to keep it or have it made again.
 */
export class DraftService {
  private readonly store: DrizzleStore;
  private readonly hooks: DraftHooks;
  private readonly running = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();

  constructor(store: DrizzleStore, hooks: DraftHooks) {
    this.store = store;
    this.hooks = hooks;
    // A suggestion that was being written when the app stopped cannot finish; it says so instead of staying "running" forever.
    const note: ModelInfo = { connectionId: null, error: { code: "INTERRUPTED", message: "the app stopped before the suggestion was finished" } };
    for (const row of this.store.sqlite.prepare("SELECT id, model_json FROM draft_suggestions WHERE status = 'running'").all() as Array<{ id: string; model_json: string | null }>) {
      const model = { ...(row.model_json ? JSON.parse(row.model_json) as ModelInfo : {}), error: note.error };
      this.store.sqlite.prepare("UPDATE draft_suggestions SET status = 'failed', model_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(model), new Date().toISOString(), row.id);
    }
  }

  // ------------------------------------------------------------------ drafts

  private row(draftId: string): DraftRow {
    const row = this.store.sqlite.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId) as DraftRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the draft does not exist");
    return row;
  }

  private doc(row: DraftRow): DraftDoc {
    return { id: row.id, projectId: row.project_id, title: row.title, text: row.text, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  exists(draftId: string): boolean {
    return Boolean(this.store.sqlite.prepare("SELECT 1 FROM drafts WHERE id = ?").get(draftId));
  }

  list(projectId?: string): { drafts: DraftSummary[] } {
    const rows = (projectId
      ? this.store.sqlite.prepare("SELECT * FROM drafts WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId)
      : this.store.sqlite.prepare("SELECT * FROM drafts ORDER BY updated_at DESC, id").all()) as DraftRow[];
    return {
      drafts: rows.map((row) => ({
        id: row.id, projectId: row.project_id, title: row.title, version: row.version, chars: [...row.text].length, createdAt: row.created_at, updatedAt: row.updated_at,
        pending: (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM draft_suggestions WHERE draft_id = ? AND status IN ('pending','running')").get(row.id) as { n: number }).n,
      })),
    };
  }

  create(input: { projectId: string; title: string; text?: string }): DraftDoc {
    if (!this.store.sqlite.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) throw new MangaError("NOT_FOUND", "the project does not exist");
    if ((this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n >= MAX_DRAFTS) throw new MangaError("VALIDATION_ERROR", "there are too many drafts", { details: { reason: "limit" } });
    const id = createId("drf");
    const now = new Date().toISOString();
    const text = input.text ?? "";
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("INSERT INTO drafts(id, project_id, title, text, version, created_at, updated_at) VALUES (?,?,?,?,1,?,?)").run(id, input.projectId, input.title, text, now, now);
      this.store.sqlite.prepare("INSERT INTO draft_versions(id, draft_id, version, text, label, created_at) VALUES (?,?,?,?,?,?)").run(createId("dvr"), id, 1, text, "", now);
    })();
    return this.doc(this.row(id));
  }

  get(draftId: string): { draft: DraftDoc; versions: VersionSummary[]; suggestions: SuggestionView[] } {
    const row = this.row(draftId);
    return { draft: this.doc(row), versions: this.versions(row), suggestions: this.suggestions(draftId).suggestions };
  }

  rename(draftId: string, title: string): DraftDoc {
    this.row(draftId);
    this.store.sqlite.prepare("UPDATE drafts SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), draftId);
    return this.doc(this.row(draftId));
  }

  delete(draftId: string): { draftId: string; versions: number; suggestions: number } {
    this.row(draftId);
    for (const [id, controller] of this.running) {
      const owner = this.store.sqlite.prepare("SELECT draft_id FROM draft_suggestions WHERE id = ?").get(id) as { draft_id: string } | undefined;
      if (owner?.draft_id === draftId) controller.abort();
    }
    return this.store.sqlite.transaction(() => {
      const versions = Number(this.store.sqlite.prepare("DELETE FROM draft_versions WHERE draft_id = ?").run(draftId).changes);
      const suggestions = Number(this.store.sqlite.prepare("DELETE FROM draft_suggestions WHERE draft_id = ?").run(draftId).changes);
      this.store.sqlite.prepare("DELETE FROM drafts WHERE id = ?").run(draftId);
      return { draftId, versions, suggestions };
    })();
  }

  // ------------------------------------------------------------------ text and versions

  /**
   * Saves the text. Each change makes a new version number, so a stale window is refused rather than overwriting. The history keeps the text
   * that is about to be replaced when none was kept for a while, so typing does not make a version of every pause.
   */
  save(draftId: string, expectedVersion: number, text: string): DraftDoc {
    if (text.length > DRAFT_TEXT_LIMIT) throw new MangaError("VALIDATION_ERROR", "the draft is too long", { details: { reason: "limit" } });
    const row = this.row(draftId);
    if (row.version !== expectedVersion) throw new MangaError("REVISION_CONFLICT", "the draft was changed elsewhere", { details: { version: row.version } });
    if (row.text === text) return this.doc(row);
    this.store.sqlite.transaction(() => {
      this.keepIfDue(row);
      this.store.sqlite.prepare("UPDATE drafts SET text = ?, version = version + 1, updated_at = ? WHERE id = ?").run(text, new Date().toISOString(), draftId);
    })();
    return this.doc(this.row(draftId));
  }

  private keepIfDue(row: DraftRow): void {
    const kept = this.store.sqlite.prepare("SELECT 1 FROM draft_versions WHERE draft_id = ? AND version = ?").get(row.id, row.version);
    if (kept) return;
    const last = this.store.sqlite.prepare("SELECT created_at FROM draft_versions WHERE draft_id = ? ORDER BY created_at DESC LIMIT 1").get(row.id) as { created_at: string } | undefined;
    if (last && Date.now() - Date.parse(last.created_at) < VERSION_GAP_MS) return;
    this.keep(row, "");
  }

  /** Puts the text of the current version in the history, with a name when one is given. */
  private keep(row: DraftRow, label: string): void {
    const existing = this.store.sqlite.prepare("SELECT id, label FROM draft_versions WHERE draft_id = ? AND version = ?").get(row.id, row.version) as { id: string; label: string } | undefined;
    if (existing) {
      if (label && !existing.label) this.store.sqlite.prepare("UPDATE draft_versions SET label = ? WHERE id = ?").run(label, existing.id);
      return;
    }
    this.store.sqlite.prepare("INSERT INTO draft_versions(id, draft_id, version, text, label, created_at) VALUES (?,?,?,?,?,?)").run(createId("dvr"), row.id, row.version, row.text, label, new Date().toISOString());
    // Old unnamed versions go first when there are too many; named ones, and the ones suggestions were adopted at, stay.
    const total = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM draft_versions WHERE draft_id = ?").get(row.id) as { n: number }).n;
    if (total > MAX_VERSIONS) {
      this.store.sqlite.prepare("DELETE FROM draft_versions WHERE id IN (SELECT id FROM draft_versions WHERE draft_id = ? AND label = '' AND version <> ? ORDER BY version LIMIT ?)").run(row.id, row.version, total - MAX_VERSIONS);
    }
  }

  checkpoint(draftId: string, label?: string): { draft: DraftDoc; versions: VersionSummary[] } {
    const row = this.row(draftId);
    this.keep(row, label?.trim() || "手动保存");
    return { draft: this.doc(row), versions: this.versions(row) };
  }

  private versions(row: DraftRow): VersionSummary[] {
    const rows = this.store.sqlite.prepare("SELECT version, label, text, created_at FROM draft_versions WHERE draft_id = ? ORDER BY version DESC").all(row.id) as Array<{ version: number; label: string; text: string; created_at: string }>;
    const list = rows.map((item) => ({ version: item.version, label: item.label, chars: [...item.text].length, createdAt: item.created_at, current: item.version === row.version }));
    // The version being edited is always listed, even before the history holds its text.
    if (!list.some((item) => item.current)) list.unshift({ version: row.version, label: "", chars: [...row.text].length, createdAt: row.updated_at, current: true });
    return list;
  }

  version(draftId: string, version: number): { version: number; label: string; text: string; createdAt: string; current: boolean } {
    const row = this.row(draftId);
    if (version === row.version) return { version, label: "", text: row.text, createdAt: row.updated_at, current: true };
    const found = this.store.sqlite.prepare("SELECT version, label, text, created_at FROM draft_versions WHERE draft_id = ? AND version = ?").get(draftId, version) as { version: number; label: string; text: string; created_at: string } | undefined;
    if (!found) throw new MangaError("NOT_FOUND", "that version is not kept");
    return { version: found.version, label: found.label, text: found.text, createdAt: found.created_at, current: false };
  }

  /** Goes back to an earlier text as a new version; what is there now is kept first, so going back can itself be gone back from. */
  restore(draftId: string, version: number): DraftDoc {
    const target = this.version(draftId, version);
    const row = this.row(draftId);
    if (target.current) return this.doc(row);
    this.store.sqlite.transaction(() => {
      this.keep(row, `回到 v${version} 之前`);
      this.store.sqlite.prepare("UPDATE drafts SET text = ?, version = version + 1, updated_at = ? WHERE id = ?").run(target.text, new Date().toISOString(), draftId);
      this.keep(this.row(draftId), `回到 v${version}`);
    })();
    return this.doc(this.row(draftId));
  }

  // ------------------------------------------------------------------ sources

  /** The text of something a suggestion can be made from, or `null` when it is gone. */
  private read(kind: DraftSourceKind, id: string, draft: DraftRow): { label: string; text: string } | null {
    const sqlite = this.store.sqlite;
    if (kind === "note") {
      const row = sqlite.prepare("SELECT title, payload_json AS payload FROM content_objects WHERE id = ? AND type = 'notes.document' AND deleted_at IS NULL").get(id) as { title: string; payload: string } | undefined;
      if (!row) return null;
      const blocks = (JSON.parse(row.payload) as { blocks?: Array<{ type?: string; text?: string }> }).blocks ?? [];
      return { label: row.title, text: blocks.filter((block) => block.type !== "embed").map((block) => block.text ?? "").join("\n") };
    }
    if (kind === "excerpt") {
      const row = sqlite.prepare("SELECT title, text FROM excerpts WHERE id = ?").get(id) as { title: string; text: string } | undefined;
      return row ? { label: row.title || clip(row.text, 40), text: row.text } : null;
    }
    if (kind === "draft") {
      const row = sqlite.prepare("SELECT title, text FROM drafts WHERE id = ?").get(id) as { title: string; text: string } | undefined;
      return row ? { label: row.title, text: row.text } : null;
    }
    if (kind === "mindmap") {
      const map = sqlite.prepare("SELECT title FROM mindmaps WHERE id = ?").get(id) as { title: string } | undefined;
      if (!map) return null;
      const nodes = sqlite.prepare("SELECT id, parent_id AS parentId, text FROM mindmap_nodes WHERE map_id = ? ORDER BY sort_key, id").all(id) as Array<{ id: string; parentId: string | null; text: string }>;
      const children = new Map<string | null, typeof nodes>();
      for (const node of nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
      const lines: string[] = [];
      const walk = (parent: string | null, depth: number) => { for (const node of children.get(parent) ?? []) { lines.push(`${"  ".repeat(depth)}- ${node.text}`); walk(node.id, depth + 1); } };
      walk(null, 0);
      return { label: map.title, text: lines.join("\n") };
    }
    if (kind === "whiteboard") {
      const board = sqlite.prepare("SELECT title FROM whiteboards WHERE id = ?").get(id) as { title: string } | undefined;
      if (!board) return null;
      const nodes = sqlite.prepare("SELECT kind, data_json AS data FROM whiteboard_nodes WHERE board_id = ? AND kind IN ('text','card') ORDER BY y, x, id").all(id) as Array<{ kind: string; data: string }>;
      const lines = nodes.map((node) => {
        const data = JSON.parse(node.data) as { title?: unknown; text?: unknown };
        return [data.title, data.text].filter((part): part is string => typeof part === "string" && part.trim() !== "").join("：");
      }).filter(Boolean);
      return { label: board.title, text: lines.join("\n") };
    }
    if (kind === "recording") {
      const session = sqlite.prepare("SELECT created_at FROM capture_sessions WHERE id = ?").get(id) as { created_at: string } | undefined;
      if (!session) return null;
      const segments = sqlite.prepare("SELECT text, revised_text AS revised FROM transcript_segments WHERE session_id = ? ORDER BY start_ms, seq, id").all(id) as Array<{ text: string | null; revised: string | null }>;
      return { label: `录音 ${session.created_at.slice(0, 16).replace("T", " ")}`, text: segments.map((segment) => segment.revised || segment.text || "").filter(Boolean).join("\n") };
    }
    // The project's term list: the same list is read whichever id the caller names, since a draft only has its own project's.
    if (!draft.project_id) return null;
    const terms = sqlite.prepare("SELECT term, heard, note FROM project_terms WHERE project_id = ? ORDER BY created_at, id").all(draft.project_id) as Array<{ term: string; heard: string | null; note: string | null }>;
    return { label: "术语表", text: terms.map((item) => `${item.term}${item.heard ? `（常被听成：${item.heard}）` : ""}${item.note ? `：${item.note}` : ""}`).join("\n") };
  }

  private snapshot(ref: SourceRef, draft: DraftRow, limit: number): SourceSnapshot {
    if (ref.kind === "draft" && ref.targetId === draft.id) throw new MangaError("VALIDATION_ERROR", "a draft cannot be made from itself", { details: { reason: "self" } });
    const feature = SOURCE_FEATURE[ref.kind] ?? (isObjectKind(ref.kind) ? featureOfKind(ref.kind) : undefined);
    if (feature && this.hooks.featureOn && !this.hooks.featureOn(feature)) throw new MangaError("CAPABILITY_UNAVAILABLE", "the function that source belongs to is switched off", { details: { reason: "disabled", kind: ref.kind } });
    const found = this.read(ref.kind, ref.targetId, draft);
    if (!found) throw new MangaError("NOT_FOUND", "a source of the suggestion does not exist", { details: { kind: ref.kind } });
    return { kind: ref.kind, targetId: ref.kind === "terms" ? (draft.project_id ?? ref.targetId) : ref.targetId, label: found.label, hash: hashOf(found.text), text: clip(found.text, limit) };
  }

  /** How each remembered source compares with what is there now. */
  private compare(sources: SourceSnapshot[], draft: DraftRow): Array<{ snapshot: SourceSnapshot; state: SourceState; after: string | null }> {
    return sources.map((snapshot) => {
      const feature = SOURCE_FEATURE[snapshot.kind] ?? (isObjectKind(snapshot.kind) ? featureOfKind(snapshot.kind) : undefined);
      const current = this.read(snapshot.kind, snapshot.targetId, draft);
      if (!current) return { snapshot, state: "missing" as const, after: null };
      if (feature && this.hooks.featureOn && !this.hooks.featureOn(feature)) return { snapshot, state: "disabled" as const, after: null };
      const same = hashOf(current.text) === snapshot.hash;
      return { snapshot, state: same ? "same" as const : "changed" as const, after: same ? null : clip(current.text, SOURCE_CHARS) };
    });
  }

  // ------------------------------------------------------------------ suggestions

  private suggestionRow(suggestionId: string): SuggestionRow {
    const row = this.store.sqlite.prepare("SELECT * FROM draft_suggestions WHERE id = ?").get(suggestionId) as SuggestionRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the suggestion does not exist");
    return row;
  }

  private viewOf(row: SuggestionRow, draft: DraftRow): SuggestionView {
    const model = row.model_json ? JSON.parse(row.model_json) as ModelInfo : { connectionId: null };
    const sources = this.compare(JSON.parse(row.sources_json) as SourceSnapshot[], draft);
    const open = row.status === "pending" || row.status === "running";
    return {
      id: row.id, draftId: row.draft_id, kind: row.kind, instruction: row.instruction, status: row.status, baseVersion: row.base_version, adoptedVersion: row.adopted_version,
      createdAt: row.created_at, updatedAt: row.updated_at, connectionId: model.connectionId, model: model.model ?? null, by: model.by ?? null, range: model.range ?? null, language: model.language ?? null,
      preview: clip((model.generated ?? "").replace(/\s+/g, " ").trim(), PREVIEW_CHARS), error: model.error ?? null,
      baseChanged: row.status === "pending" && draft.version !== row.base_version,
      stale: open && sources.some((item) => item.state === "changed" || item.state === "missing"),
      sources: sources.map((item) => ({ kind: item.snapshot.kind, targetId: item.snapshot.targetId, label: item.snapshot.label, state: item.state })),
    };
  }

  suggestions(draftId: string): { suggestions: SuggestionView[] } {
    const draft = this.row(draftId);
    const rows = this.store.sqlite.prepare("SELECT * FROM draft_suggestions WHERE draft_id = ? ORDER BY created_at DESC, id DESC").all(draftId) as SuggestionRow[];
    return { suggestions: rows.map((row) => this.viewOf(row, draft)) };
  }

  suggestion(suggestionId: string): { suggestion: SuggestionDetail } {
    const row = this.suggestionRow(suggestionId);
    const draft = this.row(row.draft_id);
    const view = this.viewOf(row, draft);
    const snapshots = JSON.parse(row.sources_json) as SourceSnapshot[];
    const compared = this.compare(snapshots, draft);
    const model = row.model_json ? JSON.parse(row.model_json) as ModelInfo : { connectionId: null };
    return {
      suggestion: {
        ...view, baseText: row.base_text, resultText: row.result_text, generated: model.generated ?? "",
        quoted: snapshots.map((item) => ({ kind: item.kind, targetId: item.targetId, label: item.label, text: item.text })),
        sources: compared.map((item) => ({ kind: item.snapshot.kind, targetId: item.snapshot.targetId, label: item.snapshot.label, state: item.state, before: item.snapshot.text, after: item.after })),
      },
    };
  }

  /** Starts a suggestion in the background and returns it at once, still running; its progress arrives as `draft.suggestion` notices. */
  suggest(input: { draftId: string; kind: DraftSuggestionKind; instruction?: string; sources?: SourceRef[]; range?: { start: number; end: number }; language?: string; connectionId?: string; redoOf?: string; text?: string; author?: "agent" }): { suggestion: SuggestionView } {
    const draft = this.row(input.draftId);
    if (input.text !== undefined && !input.redoOf) return this.written(draft, { ...input, text: input.text });
    let { kind, instruction, sources, range, language, connectionId } = input;
    if (input.redoOf) {
      const old = this.suggestionRow(input.redoOf);
      if (old.draft_id !== draft.id) throw new MangaError("NOT_FOUND", "the suggestion does not belong to this draft");
      const model = old.model_json ? JSON.parse(old.model_json) as ModelInfo : { connectionId: null };
      kind = old.kind; instruction = old.instruction;
      sources = (JSON.parse(old.sources_json) as SourceSnapshot[]).map((item) => ({ kind: item.kind, targetId: item.targetId }));
      range = model.range; language = model.language; connectionId = input.connectionId ?? model.connectionId ?? undefined;
    }
    const length = draft.text.length;
    if (range && range.end > length) throw new MangaError("VALIDATION_ERROR", "the range is outside the draft", { details: { reason: "range" } });
    const refs = [...(sources ?? [])];
    if (kind === "terms" && !refs.some((ref) => ref.kind === "terms")) refs.push({ kind: "terms", targetId: draft.project_id ?? "" });
    if (kind === "cite" && !refs.some((ref) => ref.kind !== "terms")) throw new MangaError("VALIDATION_ERROR", "quoting needs at least one source", { details: { reason: "noSources" } });
    const each = Math.max(500, Math.min(SOURCE_CHARS, Math.floor(PROMPT_SOURCE_CHARS / Math.max(1, refs.length))));
    const snapshots = refs.map((ref) => this.snapshot(ref, draft, each));
    if (kind === "terms" && !snapshots.find((item) => item.kind === "terms")?.text.trim()) throw new MangaError("VALIDATION_ERROR", "the project has no terms yet", { details: { reason: "noTerms" } });
    if ((this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM draft_suggestions WHERE draft_id = ? AND status = 'running'").get(draft.id) as { n: number }).n >= MAX_RUNNING_PER_DRAFT) {
      throw new MangaError("VALIDATION_ERROR", "wait for a suggestion to finish, or cancel one", { details: { reason: "busy" } });
    }
    const fallback = draft.project_id ? this.hooks.projectConnection?.(draft.project_id) ?? undefined : undefined;
    const llm = this.hooks.llm();
    // A connection named in the request must exist; the project's own pick falls back to the default one when it is gone.
    if (connectionId && !llm.resolve(connectionId)) throw new MangaError("NOT_FOUND", "that text connection does not exist", { details: { reason: "connection" } });
    const connection = llm.resolve(connectionId ?? fallback) ?? (fallback ? llm.resolve() : null);
    if (!connection) throw new MangaError("CAPABILITY_UNAVAILABLE", "no text model is set up", { details: { reason: "noTextModel" } });
    const total = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM draft_suggestions WHERE draft_id = ?").get(draft.id) as { n: number }).n;
    if (total >= MAX_SUGGESTIONS) this.store.sqlite.prepare("DELETE FROM draft_suggestions WHERE id IN (SELECT id FROM draft_suggestions WHERE draft_id = ? AND status IN ('discarded','failed','cancelled') ORDER BY created_at LIMIT 20)").run(draft.id);

    const id = createId("dsg");
    const now = new Date().toISOString();
    const solid = range && range.end > range.start ? range : undefined;
    const model: ModelInfo = { connectionId: connection.id, ...(connection.model ? { model: connection.model } : {}), ...(solid ? { range: solid } : {}), ...(language ? { language } : {}) };
    this.store.sqlite.prepare("INSERT INTO draft_suggestions(id, draft_id, kind, instruction, status, base_version, base_text, result_text, sources_json, model_json, adopted_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?)")
      .run(id, draft.id, kind, instruction ?? "", "running", draft.version, draft.text, "", JSON.stringify(snapshots), JSON.stringify(model), now, now);

    const controller = new AbortController();
    this.running.set(id, controller);
    const task = this.write(id, connection, controller).finally(() => { this.running.delete(id); this.tasks.delete(task); });
    this.tasks.add(task);
    return { suggestion: this.viewOf(this.suggestionRow(id), draft) };
  }

  /**
   * A suggestion whose text came with the request (an agent wrote it): nothing is asked of a model, so it costs nothing and is waiting at once.
   * It is kept apart from the draft like any other, with the draft as it stood; only the person taking it changes the draft.
   */
  private written(draft: DraftRow, input: { kind: DraftSuggestionKind; instruction?: string; sources?: SourceRef[]; range?: { start: number; end: number }; language?: string; text: string; author?: "agent" }): { suggestion: SuggestionView } {
    if (input.range && input.range.end > draft.text.length) throw new MangaError("VALIDATION_ERROR", "the range is outside the draft", { details: { reason: "range" } });
    const total = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM draft_suggestions WHERE draft_id = ?").get(draft.id) as { n: number }).n;
    if (total >= MAX_SUGGESTIONS) this.store.sqlite.prepare("DELETE FROM draft_suggestions WHERE id IN (SELECT id FROM draft_suggestions WHERE draft_id = ? AND status IN ('discarded','failed','cancelled') ORDER BY created_at LIMIT 20)").run(draft.id);
    const refs = input.sources ?? [];
    const each = Math.max(500, Math.min(SOURCE_CHARS, Math.floor(PROMPT_SOURCE_CHARS / Math.max(1, refs.length))));
    const snapshots = refs.map((ref) => this.snapshot(ref, draft, each));
    const solid = input.range && input.range.end > input.range.start ? input.range : undefined;
    const model: ModelInfo = { connectionId: null, ...(input.author ? { by: input.author } : {}), generated: input.text, ...(solid ? { range: solid } : {}), ...(input.language ? { language: input.language } : {}), finishedAt: new Date().toISOString() };
    const id = createId("dsg");
    const now = new Date().toISOString();
    this.store.sqlite.prepare("INSERT INTO draft_suggestions(id, draft_id, kind, instruction, status, base_version, base_text, result_text, sources_json, model_json, adopted_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?)")
      .run(id, draft.id, input.kind, input.instruction ?? "", "pending", draft.version, draft.text, compose(input.kind, draft.text, solid, input.text), JSON.stringify(snapshots), JSON.stringify(model), now, now);
    this.hooks.notify?.("draft.suggestion", { draftId: draft.id, suggestionId: id, status: "pending" });
    return { suggestion: this.viewOf(this.suggestionRow(id), draft) };
  }

  private async write(id: string, connection: { id: string }, controller: AbortController): Promise<void> {
    const row = this.suggestionRow(id);
    const model = JSON.parse(row.model_json ?? "{}") as ModelInfo;
    const snapshots = JSON.parse(row.sources_json) as SourceSnapshot[];
    const { system, user } = prompt(row.kind, row.instruction, row.base_text, model.range, model.language, snapshots);
    const finish = (status: DraftSuggestionStatus, patch: Partial<ModelInfo>, result = "") => {
      // A suggestion that was deleted with its draft while it was being written has nowhere to go.
      if (!this.store.sqlite.prepare("SELECT 1 FROM draft_suggestions WHERE id = ?").get(id)) return;
      this.store.sqlite.prepare("UPDATE draft_suggestions SET status = ?, result_text = ?, model_json = ?, updated_at = ? WHERE id = ?")
        .run(status, result, JSON.stringify({ ...model, ...patch, finishedAt: new Date().toISOString() }), new Date().toISOString(), id);
      this.hooks.notify?.("draft.suggestion", { draftId: row.draft_id, suggestionId: id, status });
    };
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
      const answer = (await this.hooks.llm().complete(connection, { system, user, signal })).trim();
      if (controller.signal.aborted) { finish("cancelled", {}); return; }
      if (!answer) { finish("failed", { error: { code: "PROVIDER_UNAVAILABLE", message: "the model returned no text" } }); return; }
      finish("pending", { generated: answer }, compose(row.kind, row.base_text, model.range, answer));
    } catch (error) {
      if (controller.signal.aborted) { finish("cancelled", {}); return; }
      const failure = error as { code?: string; message?: string; name?: string };
      const code = failure.name === "TimeoutError" ? "PROVIDER_UNAVAILABLE" : failure.code ?? "PROVIDER_UNAVAILABLE";
      finish("failed", { error: { code, message: failure.name === "TimeoutError" ? "the model took too long" : String(failure.message ?? "the model could not be reached") } });
    }
  }

  cancel(suggestionId: string): { suggestion: SuggestionView } {
    const row = this.suggestionRow(suggestionId);
    if (row.status !== "running") throw new MangaError("VALIDATION_ERROR", "only a suggestion that is being written can be cancelled", { details: { reason: "state", status: row.status } });
    const controller = this.running.get(suggestionId);
    if (controller) controller.abort();
    else this.store.sqlite.prepare("UPDATE draft_suggestions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), suggestionId);
    return { suggestion: this.viewOf(this.suggestionRow(suggestionId), this.row(row.draft_id)) };
  }

  /** Takes the suggestion into the draft. The text that was there is kept as a version first, so this can be undone. */
  adopt(suggestionId: string, force = false): { draft: DraftDoc; suggestion: SuggestionView } {
    const row = this.suggestionRow(suggestionId);
    if (row.status !== "pending") throw new MangaError("VALIDATION_ERROR", "only a finished suggestion that was not taken can be adopted", { details: { reason: "state", status: row.status } });
    const draft = this.row(row.draft_id);
    if (draft.version !== row.base_version && !force) throw new MangaError("REVISION_CONFLICT", "the draft changed after this suggestion was made", { details: { reason: "draftChanged", baseVersion: row.base_version, version: draft.version } });
    const model = JSON.parse(row.model_json ?? "{}") as ModelInfo;
    this.store.sqlite.transaction(() => {
      this.keep(draft, `采纳前：${kindName(row.kind)}`);
      this.store.sqlite.prepare("UPDATE drafts SET text = ?, version = version + 1, updated_at = ? WHERE id = ?").run(this.applied(row, draft, model), new Date().toISOString(), draft.id);
      const next = this.row(draft.id);
      this.keep(next, `采纳：${kindName(row.kind)}`);
      this.store.sqlite.prepare("UPDATE draft_suggestions SET status = 'adopted', adopted_version = ?, model_json = ?, updated_at = ? WHERE id = ?")
        .run(next.version, JSON.stringify({ ...model, adoptedFrom: draft.version }), new Date().toISOString(), suggestionId);
    })();
    return { draft: this.doc(this.row(draft.id)), suggestion: this.viewOf(this.suggestionRow(suggestionId), this.row(draft.id)) };
  }

  /** The text the draft gets: the composed result, or, when the draft moved on and the person insisted, the same change made on the newer text. */
  private applied(row: SuggestionRow, draft: DraftRow, model: ModelInfo): string {
    if (draft.version === row.base_version) return row.result_text;
    return compose(row.kind, draft.text, model.range && model.range.end <= draft.text.length ? model.range : undefined, model.generated ?? "");
  }

  /** Puts back the text from before the suggestion was taken, and makes the suggestion available again. Whatever was there is kept as a version first. */
  undoAdopt(suggestionId: string): { draft: DraftDoc; suggestion: SuggestionView } {
    const row = this.suggestionRow(suggestionId);
    if (row.status !== "adopted") throw new MangaError("VALIDATION_ERROR", "this suggestion was not adopted", { details: { reason: "state", status: row.status } });
    const model = JSON.parse(row.model_json ?? "{}") as ModelInfo;
    if (model.adoptedFrom === undefined) throw new MangaError("NOT_FOUND", "the text from before the suggestion was not kept");
    const before = this.version(row.draft_id, model.adoptedFrom);
    this.store.sqlite.transaction(() => {
      const draft = this.row(row.draft_id);
      this.keep(draft, "撤销采纳前");
      this.store.sqlite.prepare("UPDATE drafts SET text = ?, version = version + 1, updated_at = ? WHERE id = ?").run(before.text, new Date().toISOString(), draft.id);
      this.keep(this.row(draft.id), `撤销采纳：${kindName(row.kind)}`);
      const { adoptedFrom: _gone, ...rest } = model;
      const range = rest.range && rest.range.end <= before.text.length ? rest.range : undefined;
      this.store.sqlite.prepare("UPDATE draft_suggestions SET status = 'pending', adopted_version = NULL, base_version = ?, base_text = ?, result_text = ?, model_json = ?, updated_at = ? WHERE id = ?")
        .run(this.row(draft.id).version, before.text, compose(row.kind, before.text, range, rest.generated ?? ""), JSON.stringify(rest), new Date().toISOString(), suggestionId);
    })();
    return { draft: this.doc(this.row(row.draft_id)), suggestion: this.viewOf(this.suggestionRow(suggestionId), this.row(row.draft_id)) };
  }

  discard(suggestionId: string): { suggestion: SuggestionView } {
    const row = this.suggestionRow(suggestionId);
    if (row.status === "running") throw new MangaError("VALIDATION_ERROR", "cancel the suggestion before putting it aside", { details: { reason: "state", status: row.status } });
    if (row.status === "adopted") throw new MangaError("VALIDATION_ERROR", "an adopted suggestion is undone, not discarded", { details: { reason: "state", status: row.status } });
    this.store.sqlite.prepare("UPDATE draft_suggestions SET status = 'discarded', updated_at = ? WHERE id = ?").run(new Date().toISOString(), suggestionId);
    return { suggestion: this.viewOf(this.suggestionRow(suggestionId), this.row(row.draft_id)) };
  }

  /** The person looked at what changed and keeps the suggestion: its sources are taken as they are now, and a source that is gone is dropped from the list. */
  keepSuggestion(suggestionId: string): { suggestion: SuggestionView } {
    const row = this.suggestionRow(suggestionId);
    if (row.status !== "pending") throw new MangaError("VALIDATION_ERROR", "only a finished suggestion that was not taken can be kept", { details: { reason: "state", status: row.status } });
    const draft = this.row(row.draft_id);
    const next = this.compare(JSON.parse(row.sources_json) as SourceSnapshot[], draft).flatMap((item): SourceSnapshot[] => {
      if (item.state === "missing") return [];
      if (item.state !== "changed") return [item.snapshot];
      const now = this.read(item.snapshot.kind, item.snapshot.targetId, draft);
      return now ? [{ ...item.snapshot, label: now.label, hash: hashOf(now.text), text: clip(now.text, SOURCE_CHARS) }] : [];
    });
    this.store.sqlite.prepare("UPDATE draft_suggestions SET sources_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), new Date().toISOString(), suggestionId);
    return { suggestion: this.viewOf(this.suggestionRow(suggestionId), draft) };
  }

  /** Resolves when every suggestion being written has finished (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  close(): void {
    for (const controller of this.running.values()) controller.abort();
  }
}

const KIND_NAMES: Record<DraftSuggestionKind, string> = { outline: "提纲", continue: "续写", polish: "润色", translate: "翻译", terms: "按术语表改写", cite: "引用材料生成" };
const kindName = (kind: DraftSuggestionKind) => KIND_NAMES[kind];

/** The whole text the draft would have if the suggestion were taken. */
export function compose(kind: DraftSuggestionKind, base: string, range: { start: number; end: number } | undefined, generated: string): string {
  const end = range ? Math.min(range.end, base.length) : base.length;
  const start = range ? Math.min(range.start, end) : 0;
  if (kind === "outline") return base.trim() ? `${generated}\n\n${base}` : generated;
  if (kind === "continue" || kind === "cite") {
    const before = base.slice(0, end).replace(/\s+$/, "");
    const after = base.slice(end).replace(/^\s+/, "");
    return `${before ? `${before}\n\n` : ""}${generated}${after ? `\n\n${after}` : ""}`;
  }
  return `${base.slice(0, start)}${generated}${base.slice(end)}`;
}

function prompt(kind: DraftSuggestionKind, instruction: string, base: string, range: { start: number; end: number } | undefined, language: string | undefined, sources: SourceSnapshot[]): { system: string; user: string } {
  const quoted = sources.filter((item) => item.kind !== "terms");
  const terms = sources.find((item) => item.kind === "terms");
  const target = range ? base.slice(range.start, range.end) : base;
  const parts: string[] = [];
  const ask: Record<DraftSuggestionKind, string> = {
    outline: "请为这篇文稿列出提纲，用多级编号列表，每条一行。文稿可能还是空的，这时按“要求”和材料来列。",
    continue: "请接着文稿末尾继续写下去，不要重复已有内容，语气保持一致。",
    polish: "请润色“待处理的文字”，保持原意与事实，让表达更通顺。只输出润色后的文字。",
    translate: `请把“待处理的文字”翻译成${language || "英文"}。只输出译文。`,
    terms: "请按“术语表”统一“待处理的文字”里的用词，保持原意与其余内容不变。只输出改写后的文字。",
    cite: "请依据“引用材料”写一段内容，接在文稿后面；每个出自材料的事实，在句末用 [编号] 标注出处。",
  };
  parts.push(ask[kind]);
  if (instruction.trim()) parts.push(`要求：${instruction.trim()}`);
  if (terms?.text.trim()) parts.push(`术语表：\n${terms.text}`);
  if (quoted.length) parts.push(`引用材料：\n${quoted.map((item, index) => `[${index + 1}] ${item.label}\n${item.text}`).join("\n\n")}`);
  const subject = kind === "polish" || kind === "translate" || kind === "terms";
  parts.push(subject ? `待处理的文字：\n${target}` : `文稿：\n${base}`);
  return { system: SYSTEM, user: parts.join("\n\n") };
}
