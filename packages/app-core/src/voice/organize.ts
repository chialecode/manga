import { MangaError, createId } from "@manga/contracts";
import type { SegmentAnchor } from "@manga/contracts";
import type { CaptureService } from "./capture.ts";

export type DraftView = {
  id: string;
  sessionId: string;
  state: "organizing" | "ready" | "failed" | "accepted";
  /** What the model produced. Never changed after it is written. */
  text: string;
  /** What the user made of it; a new attempt never touches this. */
  editedText: string | null;
  noteObjectId: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
};

type DraftRow = {
  id: string;
  session_id: string;
  state: string;
  text: string;
  edited_text: string | null;
  note_object_id: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_ANCHORS_IN_NOTE = 12;

const SYSTEM_PROMPT = [
  "你是读书与观影笔记的整理助手。下面是用户在阅读或观看时口述的感想，已经由语音识别转成文字，可能有口误、重复和识别错误。",
  "请整理成条理清晰、可直接保存的笔记：保留用户的观点与语气，合并重复，改正明显的识别错误，分成短段落。",
  "不要添加用户没有说过的内容，不要评价作品，不要编造出处。专有名词以“术语表”为准。只输出笔记正文。",
].join("\n");

const view = (row: DraftRow): DraftView => ({
  id: row.id,
  sessionId: row.session_id,
  state: row.state as DraftView["state"],
  text: row.text,
  editedText: row.edited_text,
  noteObjectId: row.note_object_id,
  error: row.error_json ? JSON.parse(row.error_json) as { code: string; message: string } : null,
  createdAt: row.created_at,
});

/** Turns a finished transcript into a draft note by a text model, and keeps the draft, the user's edits and the note apart. */
export class Organizer {
  private readonly host: CaptureService;
  private readonly running = new Map<string, Promise<DraftView>>();

  constructor(host: CaptureService) {
    this.host = host;
  }

  private draft(id: string): DraftRow {
    const row = this.host.db.prepare("SELECT * FROM capture_drafts WHERE id = ?").get(id) as DraftRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "draft not found");
    return row;
  }

  list(sessionId: string): DraftView[] {
    return (this.host.db.prepare("SELECT * FROM capture_drafts WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId) as DraftRow[]).map(view);
  }

  private transcript(sessionId: string): { text: string; segments: number } {
    const rows = this.host.db.prepare("SELECT text, revised_text FROM transcript_segments WHERE session_id = ? AND state = 'done' ORDER BY start_ms, seq").all(sessionId) as Array<{ text: string; revised_text: string | null }>;
    return { text: rows.map((row) => row.revised_text ?? row.text).join("\n"), segments: rows.length };
  }

  /** Ask the text model for a draft. A second request while one is running joins it instead of starting another. */
  organize(sessionId: string, connectionId?: string): Promise<DraftView> {
    this.host.assertCurrent();
    const existing = this.running.get(sessionId);
    if (existing) return existing;
    const session = this.host.row(sessionId);
    const { text, segments } = this.transcript(sessionId);
    if (!segments) throw new MangaError("VALIDATION_ERROR", "there is no transcript to organize yet", { details: { stage: session.stage } });
    const connection = this.host.llm.resolve(connectionId);
    if (!connection) throw new MangaError("MODEL_CAPABILITY_MISSING", "no text model connection is configured");
    const terms = session.work_id ? (this.host.terms(session.work_id).terms) : [];
    const id = createId("drf");
    const now = new Date().toISOString();
    this.host.db.prepare("INSERT INTO capture_drafts(id, session_id, state, text, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(id, sessionId, "organizing", "", now, now);
    this.host.deps.notify("capture.draft", { sessionId, draftId: id, state: "organizing" });
    const controller = new AbortController();
    const job = this.host.deps.media.jobs.submit({
      lane: "net", kind: "capture-organize", key: `capture:${sessionId}:organize`, owner: "manga.voice",
      run: async ({ signal }) => {
        const combined = AbortSignal.any([signal, controller.signal]);
        const glossary = terms.length ? `\n\n术语表：${terms.map((item) => item.term).join("、")}` : "";
        try {
          const output = await this.host.llm.complete(connection, { system: SYSTEM_PROMPT, user: `${text}${glossary}`, signal: combined });
          // A draft that comes back after the module was turned off is not written.
          if (combined.aborted || !this.host.isCurrent()) throw new MangaError("CANCELLED", "organizing was cancelled");
          const clean = output.trim();
          if (!clean) throw new MangaError("PROVIDER_UNAVAILABLE", "the model returned no text", { retryable: true });
          this.host.db.prepare("UPDATE capture_drafts SET state = 'ready', text = ?, error_json = NULL, updated_at = ? WHERE id = ?").run(clean, new Date().toISOString(), id);
        } catch (error) {
          const failure = error instanceof MangaError ? error : new MangaError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "organizing failed", { retryable: true });
          if (this.host.isCurrent()) {
            this.host.db.prepare("UPDATE capture_drafts SET state = 'failed', error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ code: failure.code, message: failure.message }), new Date().toISOString(), id);
          }
        }
        if (this.host.isCurrent()) this.host.deps.notify("capture.draft", { sessionId, draftId: id, state: this.draft(id).state });
        return view(this.draft(id));
      },
    });
    const run = job.promise.finally(() => this.running.delete(sessionId));
    this.running.set(sessionId, run);
    return run;
  }

  /** Keep the user's text for a draft. Only the user's text changes: the model's output and later attempts are left alone. */
  edit(draftId: string, editedText: string): DraftView {
    this.host.assertCurrent();
    const row = this.draft(draftId);
    if (row.state === "organizing") throw new MangaError("VALIDATION_ERROR", "the draft is still being written");
    if (row.state === "accepted") throw new MangaError("VALIDATION_ERROR", "this draft already became a note");
    this.host.db.prepare("UPDATE capture_drafts SET edited_text = ?, updated_at = ? WHERE id = ?").run(editedText, new Date().toISOString(), draftId);
    return view(this.draft(draftId));
  }

  /**
   * What a note made from this draft contains: the text the user settled on, and the places the recording was at, one per
   * distinct source. `existing` is set when the draft already became a note, so accepting twice never creates a second one.
   */
  prepareAccept(draftId: string, overrides: { editedText?: string; title?: string }): { existing: string | null; draft: DraftView; title: string; text: string; anchors: SegmentAnchor[]; resourceId: string | null } {
    this.host.assertCurrent();
    let row = this.draft(draftId);
    if (row.note_object_id) return { existing: row.note_object_id, draft: view(row), title: "", text: "", anchors: [], resourceId: null };
    if (row.state !== "ready") throw new MangaError("VALIDATION_ERROR", "only a finished draft can become a note", { details: { state: row.state } });
    if (overrides.editedText !== undefined) {
      this.host.db.prepare("UPDATE capture_drafts SET edited_text = ?, updated_at = ? WHERE id = ?").run(overrides.editedText, new Date().toISOString(), draftId);
      row = this.draft(draftId);
    }
    const text = (row.edited_text ?? row.text).trim();
    if (!text) throw new MangaError("VALIDATION_ERROR", "the note text is empty");
    const segments = this.host.db.prepare("SELECT anchors_json FROM transcript_segments WHERE session_id = ? AND state = 'done' ORDER BY start_ms, seq").all(row.session_id) as Array<{ anchors_json: string }>;
    const seen = new Set<string>();
    const anchors: SegmentAnchor[] = [];
    for (const segment of segments) {
      for (const anchor of JSON.parse(segment.anchors_json) as SegmentAnchor[]) {
        if (!anchor.resourceId || !anchor.resourceRevisionId || !anchor.locator) continue;
        const key = JSON.stringify([anchor.resourceId, anchor.resourceRevisionId, anchor.locator.kind === "temporal" ? Math.floor(anchor.locator.startMs / 1000) : anchor.locator]);
        if (seen.has(key)) continue;
        seen.add(key);
        anchors.push(anchor);
        if (anchors.length >= MAX_ANCHORS_IN_NOTE) break;
      }
      if (anchors.length >= MAX_ANCHORS_IN_NOTE) break;
    }
    const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "口述笔记";
    return { existing: null, draft: view(row), title: overrides.title ?? (first.length > 40 ? `${first.slice(0, 40)}…` : first), text, anchors, resourceId: anchors[0]?.resourceId ?? null };
  }
}
