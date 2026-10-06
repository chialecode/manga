import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Pause, Play } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import type { SegmentAnchor } from "@manga/contracts/media";
import { formatClock } from "../readers/video-model.ts";
import { captureBus, type LatestPosition } from "./capture-bus.ts";
import { useRecordings, useReview, type Review, type ReviewSegment, type SessionSummary } from "./use-review.ts";

type T = Translator["t"];

const stageLabel = (t: T, stage: string) => t(`review.stage.${stage}` as MessageKey);
const audioLabel = (t: T, state: string) => t(`review.audio.${state}` as MessageKey);

function anchorLabel(t: T, anchor: SegmentAnchor): string {
  const kind = anchor.locator?.kind;
  if (kind === "temporal") return t("review.anchorTemporal", { start: formatClock(anchor.locator!.kind === "temporal" ? anchor.locator!.startMs : 0) });
  if (kind === "image") return t("review.anchorImage");
  return t("review.anchorText");
}

/**
 * The recordings of a resource or a work, and the review of one: a bar of where speech was, the transcript as bubbles
 * with their time, source and state, the stretches that were filtered out, and everything the user can do with them
 * (play, jump to the source, revise and keep a term, calibrate, retry, organize into a draft, clean the audio). Every
 * control is a button or field, so the whole review works from the keyboard.
 */
export function RecordingReview(props: {
  t: T;
  scope: { resourceId?: string; workId?: string };
  enabled?: boolean;
  initialSessionId?: string | null;
  onJump: (anchor: SegmentAnchor) => void;
  onOpenNote: (objectId: string) => void;
  formatDate: (value: string) => string;
  /** Where the reader is now, for calibrating a segment's source. */
  position?: () => LatestPosition | null;
}) {
  const { t } = props;
  const list = useRecordings(props.scope, props.enabled !== false);
  const [selected, setSelected] = useState<string | null>(props.initialSessionId ?? null);
  useEffect(() => { if (props.initialSessionId) setSelected(props.initialSessionId); }, [props.initialSessionId]);

  if (selected) {
    return <SessionReview key={selected} t={t} sessionId={selected} onBack={() => { setSelected(null); void list.reload(); }} onJump={props.onJump} onOpenNote={props.onOpenNote} position={props.position ?? captureBus.latest} formatDate={props.formatDate} />;
  }
  return (
    <section className="review" data-testid="review-list" aria-label={t("review.list")}>
      {list.status === "loading" ? <p role="status" className="detail-muted">{t("review.loading")}</p> : null}
      {list.status === "error" ? <p role="alert" className="detail-muted">{t("review.error", { message: list.error })}</p> : null}
      {list.status === "ready" && !list.sessions.length ? <p className="detail-muted" data-testid="review-empty">{t("review.empty")}</p> : null}
      <ul className="review-sessions">
        {list.sessions.map((session) => <SessionRow key={session.id} t={t} session={session} formatDate={props.formatDate} onOpen={() => setSelected(session.id)} />)}
      </ul>
    </section>
  );
}

function SessionRow(props: { t: T; session: SessionSummary; formatDate: (value: string) => string; onOpen: () => void }) {
  const { t, session } = props;
  return (
    <li>
      <button type="button" className="review-session" data-testid={`review-session-${session.id}`} data-stage={session.stage} onClick={props.onOpen}>
        <span className="review-session-main">
          <strong>{t("review.session", { date: props.formatDate(session.createdAt) })}</strong>
          <span>{t("review.duration", { time: formatClock(session.durationMs) })}</span>
        </span>
        <span className="review-session-state">
          <span className="chip" data-testid={`review-stage-${session.id}`}>{stageLabel(t, session.stage)}</span>
          <span className="detail-muted">{audioLabel(t, session.audioState)}</span>
          {session.segments.total > 0 ? <span className="detail-muted">{t("review.segmentsDone", { done: session.segments.done, total: session.segments.total })}</span> : null}
        </span>
      </button>
    </li>
  );
}

function SessionReview(props: {
  t: T;
  sessionId: string;
  onBack: () => void;
  onJump: (anchor: SegmentAnchor) => void;
  onOpenNote: (objectId: string) => void;
  position: () => LatestPosition | null;
  formatDate: (value: string) => string;
}) {
  const { t } = props;
  const { review, status, error, busy, act } = useReview(props.sessionId);
  const audio = useRef<HTMLAudioElement>(null);
  const audioUrl = useRef<string | null>(null);
  const stopAt = useRef<number | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; term: string; heard: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmClean, setConfirmClean] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    const onTime = () => { if (stopAt.current !== null && element.currentTime * 1000 >= stopAt.current) { element.pause(); stopAt.current = null; } };
    const onPause = () => setPlaying(null);
    element.addEventListener("timeupdate", onTime);
    element.addEventListener("pause", onPause);
    element.addEventListener("ended", onPause);
    return () => { element.removeEventListener("timeupdate", onTime); element.removeEventListener("pause", onPause); element.removeEventListener("ended", onPause); element.pause(); };
  }, [review !== null]);

  const items = useMemo(() => {
    if (!review) return [];
    const rows: Array<{ kind: "segment"; segment: ReviewSegment; index: number } | { kind: "gap"; startMs: number; endMs: number }> = [
      ...review.segments.map((segment, index) => ({ kind: "segment" as const, segment, index })),
      ...review.filtered.map((gap) => ({ kind: "gap" as const, ...gap })),
    ];
    return rows.sort((a, b) => (a.kind === "segment" ? a.segment.startMs : a.startMs) - (b.kind === "segment" ? b.segment.startMs : b.startMs));
  }, [review]);

  if (status === "loading" && !review) return <p role="status" className="detail-muted">{t("review.loading")}</p>;
  if (!review) return <div><button type="button" className="link-button" onClick={props.onBack}>{t("review.back")}</button><p role="alert">{t("review.error", { message: error })}</p></div>;
  const session = review.session;
  const total = Math.max(session.durationMs, ...review.segments.map((segment) => segment.endMs), 1);

  async function play(segment: ReviewSegment) {
    const element = audio.current;
    if (!element) return;
    if (playing === segment.id) { element.pause(); return; }
    if (!audioUrl.current) {
      const handle = await act<{ url: string }>("audio", "capture.audioHandle", { sessionId: session.id });
      if (!handle.ok) return;
      audioUrl.current = handle.value.url;
      element.src = handle.value.url;
    }
    stopAt.current = segment.endMs;
    element.currentTime = segment.startMs / 1000;
    setPlaying(segment.id);
    try { await element.play(); } catch { setPlaying(null); }
  }

  async function saveRevision(segment: ReviewSegment) {
    if (!editing) return;
    const saved = await act("revise", "capture.reviseSegment", { segmentId: segment.id, text: editing.text });
    if (!saved.ok) return;
    if (editing.term.trim() && session.workId) {
      const term = await act("term", "capture.addTerm", { workId: session.workId, term: editing.term.trim(), ...(editing.heard.trim() ? { heard: editing.heard.trim() } : {}) });
      if (term.ok) setNote(t("review.termSaved", { term: editing.term.trim() }));
    }
    setEditing(null);
  }

  async function calibrate(segment: ReviewSegment) {
    const at = props.position();
    if (!at?.resourceId || !at.resourceRevisionId || !at.locator) { setNote(t("review.calibrateNone")); return; }
    const done = await act("calibrate", "capture.calibrate", { segmentId: segment.id, resourceId: at.resourceId, resourceRevisionId: at.resourceRevisionId, locator: at.locator });
    if (done.ok) setNote(t("review.calibrated"));
  }

  async function accept(draftId: string, text: string) {
    const result = await act<{ objectId: string }>("accept", "capture.acceptDraft", { draftId, editedText: text });
    if (result.ok && result.value.objectId) props.onOpenNote(result.value.objectId);
  }

  const failed = review.segments.filter((segment) => segment.state === "failed").length;
  const needsAsr = session.stage === "awaiting_asr";
  const canTranscribe = ["awaiting_asr", "pending", "failed", "recorded"].includes(session.stage);
  const canClean = session.audioState === "retained" || session.audioState === "staged";
  const organizing = review.drafts.some((draft) => draft.state === "organizing");

  return (
    <section className="review" data-testid="review-session" data-session-id={session.id} data-stage={session.stage}>
      <header className="review-head">
        <button type="button" className="icon-button" data-testid="review-back" aria-label={t("review.back")} title={t("review.back")} onClick={props.onBack}><ArrowLeft size={16} /></button>
        <strong>{t("review.session", { date: props.formatDate(session.createdAt) })}</strong>
        <span className="chip" data-testid="review-stage">{stageLabel(t, session.stage)}</span>
        <span className="detail-muted" data-testid="review-audio-state">{audioLabel(t, session.audioState)}</span>
        <span className="detail-muted">{t("review.duration", { time: formatClock(session.durationMs) })}</span>
        {session.speechMs !== null ? <span className="detail-muted">{t("review.speech", { time: formatClock(session.speechMs) })}</span> : null}
      </header>
      <audio ref={audio} preload="none" data-testid="review-audio" />
      {session.error ? <p role="alert" className="review-error" data-testid="review-session-error">{t("review.error", { message: session.error.message })}</p> : null}
      {error ? <p role="alert" className="review-error" data-testid="review-action-error">{t("review.error", { message: error })}</p> : null}
      {note ? <p role="status" className="detail-muted" data-testid="review-note">{note}</p> : null}
      {needsAsr ? <p role="status" className="detail-muted" data-testid="review-no-asr">{t("review.noAsr")}</p> : null}
      {session.stage === "pending" ? <p role="status" className="detail-muted">{t("review.pendingNote")}</p> : null}

      <div className="review-bar" role="group" aria-label={t("review.timeline")} data-testid="review-bar">
        {review.filtered.map((gap) => (
          <span key={`g${gap.startMs}`} className="review-bar-gap" aria-hidden="true" style={{ left: `${(gap.startMs / total) * 100}%`, width: `${Math.max(0.3, ((gap.endMs - gap.startMs) / total) * 100)}%` }} />
        ))}
        {review.segments.map((segment, index) => (
          <button
            key={segment.id}
            type="button"
            className="review-bar-segment"
            data-testid={`review-bar-${segment.id}`}
            data-state={segment.state}
            data-active={active === segment.id || undefined}
            aria-label={`${t("review.segment", { n: index + 1 })} ${t("review.range", { start: formatClock(segment.startMs), end: formatClock(segment.endMs) })}`}
            style={{ left: `${(segment.startMs / total) * 100}%`, width: `${Math.max(0.8, ((segment.endMs - segment.startMs) / total) * 100)}%` }}
            onClick={() => { setActive(segment.id); document.querySelector(`[data-testid="review-segment-${segment.id}"]`)?.scrollIntoView?.({ block: "nearest" }); }}
          />
        ))}
      </div>

      <div className="review-actions">
        {canTranscribe ? <button type="button" className="secondary-button" data-testid="review-transcribe" disabled={busy !== null} onClick={() => void act("transcribe", "capture.transcribe", { sessionId: session.id })}>{t("review.transcribe")}</button> : null}
        {failed > 0 ? <button type="button" className="secondary-button" data-testid="review-retry" disabled={busy !== null} onClick={() => void act("retry", "capture.retry", { sessionId: session.id })}>{t("review.retryFailed")}</button> : null}
        {review.segments.some((segment) => segment.state === "done") ? <button type="button" className="secondary-button" data-testid="review-organize" disabled={busy !== null || organizing} onClick={() => void act("organize", "capture.organize", { sessionId: session.id })}>{organizing ? t("review.organizing") : t("review.organize")}</button> : null}
        {session.retention === "discard" && session.audioState === "staged" && session.stage !== "recording" ? <button type="button" className="link-button" data-testid="review-keep" disabled={busy !== null} onClick={() => void act("retain", "capture.retain", { sessionId: session.id, action: "keep" })}>{t("review.keep")}</button> : null}
        {canClean ? (confirmClean
          ? <button type="button" className="secondary-button" data-testid="review-clean-confirm" onClick={() => { setConfirmClean(false); void act("retain", "capture.retain", { sessionId: session.id, action: "discard" }); }}>{t("review.cleanConfirm")}</button>
          : <button type="button" className="link-button" data-testid="review-clean" onClick={() => setConfirmClean(true)}>{t("review.cleanAudio")}</button>) : null}
      </div>

      <ol className="review-items" data-testid="review-items">
        {items.map((item) => {
          if (item.kind === "gap") {
            return <li key={`gap${item.startMs}`} className="review-gap" data-testid="review-gap">{t("review.filtered", { start: formatClock(item.startMs), end: formatClock(item.endMs) })}</li>;
          }
          const { segment, index } = item;
          const isEditing = editing?.id === segment.id;
          return (
            <li key={segment.id} className="review-bubble" data-testid={`review-segment-${segment.id}`} data-state={segment.state} data-active={active === segment.id || undefined}>
              <div className="review-bubble-head">
                <strong>{t("review.segment", { n: index + 1 })}</strong>
                <span className="detail-muted">{t("review.range", { start: formatClock(segment.startMs), end: formatClock(segment.endMs) })}</span>
                {segment.state !== "done" ? <span className="chip" data-testid={`review-segment-state-${segment.id}`}>{t(`review.state.${segment.state}` as MessageKey)}</span> : null}
                {segment.state === "done" ? <span className="detail-muted" data-testid={`review-precision-${segment.id}`}>{t(`review.precision.${segment.precision}` as MessageKey)}</span> : null}
                {segment.revised ? <span className="chip">{t("review.revised")}</span> : null}
              </div>
              {segment.state === "failed" && segment.error ? <p role="alert" className="review-error">{t("review.error", { message: segment.error.message })}</p> : null}
              {isEditing ? (
                <div className="review-edit">
                  <label>{t("review.reviseField")}
                    <textarea data-testid={`review-edit-${segment.id}`} value={editing!.text} onChange={(event) => setEditing({ ...editing!, text: event.target.value })} />
                  </label>
                  {session.workId ? (
                    <div className="review-term">
                      <label>{t("review.termField")}<input type="text" data-testid={`review-term-${segment.id}`} value={editing!.term} onChange={(event) => setEditing({ ...editing!, term: event.target.value })} /></label>
                      <label>{t("review.termHeard")}<input type="text" data-testid={`review-heard-${segment.id}`} value={editing!.heard} onChange={(event) => setEditing({ ...editing!, heard: event.target.value })} /></label>
                    </div>
                  ) : null}
                  <div className="review-bubble-actions">
                    <button type="button" className="primary-button" data-testid={`review-save-${segment.id}`} disabled={busy !== null} onClick={() => void saveRevision(segment)}>{t("review.reviseSave")}</button>
                    <button type="button" className="secondary-button" onClick={() => setEditing(null)}>{t("review.reviseCancel")}</button>
                  </div>
                </div>
              ) : segment.text ? (
                <p className="review-text" data-testid={`review-text-${segment.id}`}>{segment.text}</p>
              ) : null}
              {segment.revised ? <p className="detail-muted" data-testid={`review-original-${segment.id}`}>{t("review.originalText", { text: segment.originalText })}</p> : null}
              <div className="review-bubble-actions">
                {session.playable
                  ? <button type="button" className="secondary-button" data-testid={`review-play-${segment.id}`} aria-pressed={playing === segment.id} onClick={() => void play(segment)}>{playing === segment.id ? <Pause size={14} /> : <Play size={14} />}{playing === segment.id ? t("review.pause") : t("review.play")}</button>
                  : <span className="detail-muted" data-testid={`review-no-play-${segment.id}`}>{t("review.playUnavailable")}</span>}
                {segment.anchors.length
                  ? segment.anchors.map((anchor, position) => (
                    <button key={position} type="button" className="secondary-button" data-testid={`review-jump-${segment.id}-${position}`} title={t("review.jump")} onClick={() => props.onJump(anchor)}>{t("review.jump")} · {anchorLabel(t, anchor)}</button>
                  ))
                  : <span className="detail-muted">{t("review.sourceNone")}</span>}
                {segment.state === "done" && !isEditing ? <button type="button" className="link-button" data-testid={`review-revise-${segment.id}`} onClick={() => setEditing({ id: segment.id, text: segment.text, term: "", heard: "" })}>{t("review.revise")}</button> : null}
                {segment.state === "done" ? <button type="button" className="link-button" data-testid={`review-calibrate-${segment.id}`} disabled={busy !== null} onClick={() => void calibrate(segment)}>{t("review.calibrate")}</button> : null}
                {segment.state === "failed" ? <button type="button" className="link-button" data-testid={`review-retry-${segment.id}`} disabled={busy !== null} onClick={() => void act("retry", "capture.retry", { sessionId: session.id, segmentId: segment.id })}>{t("review.retry")}</button> : null}
              </div>
            </li>
          );
        })}
      </ol>

      {review.drafts.length ? (
        <div className="review-drafts" data-testid="review-drafts">
          <h3>{t("review.drafts")}</h3>
          {review.drafts.map((draft) => <DraftCard key={draft.id} t={t} draft={draft} value={drafts[draft.id] ?? draft.editedText ?? draft.text} busy={busy !== null} onChange={(text) => setDrafts({ ...drafts, [draft.id]: text })} onSave={(text) => void act("draft", "capture.editDraft", { draftId: draft.id, editedText: text })} onAccept={(text) => void accept(draft.id, text)} onOpenNote={props.onOpenNote} />)}
        </div>
      ) : null}
    </section>
  );
}

function DraftCard(props: { t: T; draft: Review["drafts"][number]; value: string; busy: boolean; onChange: (text: string) => void; onSave: (text: string) => void; onAccept: (text: string) => void; onOpenNote: (objectId: string) => void }) {
  const { t, draft } = props;
  return (
    <div className="review-draft" data-testid={`review-draft-${draft.id}`} data-state={draft.state}>
      {draft.state === "organizing" ? <p role="status" className="detail-muted">{t("review.organizing")}</p> : null}
      {draft.state === "failed" ? <p role="alert" className="review-error">{t("review.draftFailed", { message: draft.error?.message ?? "" })}</p> : null}
      {draft.state === "ready" || draft.state === "accepted" ? (
        <>
          <label>{t("review.draftField")}
            <textarea data-testid={`review-draft-text-${draft.id}`} value={props.value} disabled={draft.state === "accepted"} onChange={(event) => props.onChange(event.target.value)} />
          </label>
          {draft.editedText !== null ? <details><summary>{t("review.draftOriginal")}</summary><p className="review-text">{draft.text}</p></details> : null}
          <div className="review-bubble-actions">
            {draft.state === "ready" ? <button type="button" className="secondary-button" data-testid={`review-draft-save-${draft.id}`} disabled={props.busy} onClick={() => props.onSave(props.value)}>{t("review.draftSave")}</button> : null}
            {draft.state === "ready" ? <button type="button" className="primary-button" data-testid={`review-draft-accept-${draft.id}`} disabled={props.busy} onClick={() => props.onAccept(props.value)}>{t("review.draftAccept")}</button> : null}
            {draft.state === "accepted" && draft.noteObjectId ? <button type="button" className="secondary-button" data-testid={`review-draft-note-${draft.id}`} onClick={() => props.onOpenNote(draft.noteObjectId!)}>{t("review.openNote")}</button> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
