import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, NotebookPen, RotateCcw, Trash2, Undo2 } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { CAPTURE_AUDIO_STATES, CAPTURE_STAGES } from "@manga/contracts/media";
import { asArray, attempt } from "../../lib/api.ts";
import { formatClock } from "../../readers/video-model.ts";
import { Pager, SettingsPage } from "./rows.tsx";

type T = Translator["t"];
export type RecordItem = {
  kind: "note" | "recording";
  id: string;
  title: string;
  preview: string;
  at: string;
  deleted: boolean;
  workId: string | null;
  workTitle: string | null;
  mediaKind: string | null;
  resourceId: string | null;
  resourceTitle: string | null;
  tags: string[];
  stage: string | null;
  audioState: string | null;
  durationMs: number | null;
  hasSource: boolean;
};

const PAGE = 30;
const KINDS = ["novel", "comic", "video"] as const;
/** The states a recording can be filtered by: where the pipeline is, and what became of the audio. */
const STATES = [...CAPTURE_STAGES, ...CAPTURE_AUDIO_STATES.filter((state) => state !== "none")] as readonly string[];
const RETRYABLE = ["awaiting_asr", "pending", "failed", "recorded"];

type Filter = { type: "all" | "note" | "recording"; mediaKind: string; state: string; q: string; deleted: boolean; workId: string | null };

/**
 * Every note and recording in one filterable, paged list (交互设计 3.5, "记录"). A note can be opened, deleted (it is only hidden:
 * the "deleted" view lists it and brings it back) or followed to its source; a recording can be reviewed, retried, or have its
 * waiting audio cleaned. The list is paged on the server, so it stays quick with many records.
 */
export function RecordsPage(props: {
  t: T;
  formatDate: (value: string) => string;
  /** Opens only the records of one work, as from its page. */
  initialWorkId?: string | null;
  onOpenNote: (objectId: string) => void;
  onOpenNoteSource: (objectId: string) => void;
  onOpenRecording: (sessionId: string, workId: string | null) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [filter, setFilter] = useState<Filter>({ type: "all", mediaKind: "", state: "", q: "", deleted: false, workId: props.initialWorkId ?? null });
  const [text, setText] = useState("");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<RecordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    const result = await attempt<{ items: RecordItem[]; total: number }>("records.list", {
      type: filter.type,
      ...(filter.mediaKind ? { mediaKind: filter.mediaKind } : {}),
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.q ? { q: filter.q } : {}),
      ...(filter.workId ? { workId: filter.workId } : {}),
      ...(filter.deleted ? { deleted: true } : {}),
      limit: PAGE,
      offset,
    });
    if (request !== latest.current) return;
    if (!result.ok) { setStatus("error"); props.onError(result.error.message); return; }
    setItems(asArray<RecordItem>(result.value.items));
    setTotal(Number(result.value.total ?? 0));
    setStatus("ready");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, offset]);

  useEffect(() => { void load(); }, [load]);

  // Typing waits a moment so each keystroke is not a query.
  useEffect(() => {
    const timer = window.setTimeout(() => { setFilter((current) => (current.q === text.trim() ? current : { ...current, q: text.trim() })); setOffset(0); }, 250);
    return () => window.clearTimeout(timer);
  }, [text]);

  const patch = (next: Partial<Filter>) => { setFilter((current) => ({ ...current, ...next })); setOffset(0); };

  async function act(commandId: string, input: unknown, done: string) {
    const result = await attempt(commandId, input);
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(done);
    await load();
  }

  const stateLabel = (state: string) => (CAPTURE_AUDIO_STATES as readonly string[]).includes(state) ? t(`review.audio.${state}` as MessageKey) : t(`review.stage.${state}` as MessageKey);

  return (
    <SettingsPage id="records" title={t("settings.page.records")} hint={t("records.hint")} wide>
      <div className="records-filters" role="search" data-testid="records-filters">
        <select aria-label={t("records.type")} data-testid="records-type" value={filter.type} onChange={(event) => patch({ type: event.target.value as Filter["type"], state: event.target.value === "note" ? "" : filter.state })}>
          <option value="all">{t("records.typeAll")}</option>
          <option value="note">{t("records.typeNote")}</option>
          <option value="recording">{t("records.typeRecording")}</option>
        </select>
        <select aria-label={t("records.kind")} data-testid="records-kind" value={filter.mediaKind} onChange={(event) => patch({ mediaKind: event.target.value })}>
          <option value="">{t("records.kindAll")}</option>
          {KINDS.map((kind) => <option key={kind} value={kind}>{t(`shelf.kind.${kind}`)}</option>)}
        </select>
        <select aria-label={t("records.state")} data-testid="records-state" value={filter.state} disabled={filter.type === "note"} onChange={(event) => patch({ state: event.target.value, type: event.target.value ? "recording" : filter.type })}>
          <option value="">{t("records.stateAll")}</option>
          {STATES.map((state) => <option key={state} value={state}>{stateLabel(state)}</option>)}
        </select>
        <input type="search" aria-label={t("records.search")} placeholder={t("records.search")} data-testid="records-search" value={text} onChange={(event) => setText(event.target.value)} />
        <label className="msettings-check"><input type="checkbox" data-testid="records-deleted" checked={filter.deleted} onChange={(event) => patch({ deleted: event.target.checked, type: event.target.checked ? "note" : filter.type })} />{t("records.deleted")}</label>
        {filter.workId ? <button type="button" className="chip chip-button" data-testid="records-work-scope" onClick={() => patch({ workId: null })}>{t("records.workScope")} ×</button> : null}
      </div>

      {status === "loading" && !items.length ? <p role="status" className="detail-muted" data-testid="records-loading">{t("status.loading")}</p> : null}
      {status === "ready" && items.length === 0 ? <p className="detail-muted settings-empty" data-testid="records-empty">{filter.deleted ? t("records.emptyDeleted") : t("records.empty")}</p> : null}

      <ul className="records-list" data-testid="records-list" aria-busy={status === "loading"}>
        {items.map((item) => {
          const place = [item.workTitle, item.resourceTitle && item.resourceTitle !== item.workTitle ? item.resourceTitle : null].filter(Boolean).join(" · ");
          const title = item.kind === "note" ? (item.title || t("records.untitled")) : t("records.recordingTitle", { time: props.formatDate(item.at) });
          return (
            <li key={`${item.kind}:${item.id}`} className="record-row" data-testid={`record-${item.id}`} data-kind={item.kind} data-deleted={item.deleted ? "true" : "false"}>
              <span className="record-icon" aria-hidden="true">{item.kind === "note" ? <NotebookPen size={16} /> : <Mic size={16} />}</span>
              <div className="record-main">
                <strong className="record-title">{title}</strong>
                {item.preview ? <span className="record-preview">{item.preview}</span> : null}
                <span className="detail-muted record-meta">
                  {[place, item.kind === "note" ? props.formatDate(item.at) : item.durationMs !== null ? formatClock(item.durationMs) : ""].filter(Boolean).join(" · ")}
                </span>
                {item.kind === "recording" ? (
                  <span className="record-chips">
                    {item.stage ? <span className="chip" data-testid={`record-stage-${item.id}`}>{stateLabel(item.stage)}</span> : null}
                    {item.audioState && item.audioState !== "none" ? <span className="chip" data-testid={`record-audio-${item.id}`}>{stateLabel(item.audioState)}</span> : null}
                  </span>
                ) : item.tags.length ? <span className="record-chips">{item.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}</span> : null}
              </div>
              <div className="record-actions">
                {item.kind === "note" ? (
                  item.deleted ? (
                    <button type="button" className="secondary-button" data-testid={`record-restore-${item.id}`} onClick={() => void act("notes.undelete", { objectId: item.id }, t("records.restored"))}><Undo2 size={14} aria-hidden="true" />{t("records.restore")}</button>
                  ) : (
                    <>
                      <button type="button" className="secondary-button" data-testid={`record-open-${item.id}`} onClick={() => props.onOpenNote(item.id)}>{t("records.open")}</button>
                      {item.hasSource ? <button type="button" className="secondary-button" data-testid={`record-source-${item.id}`} onClick={() => props.onOpenNoteSource(item.id)}>{t("records.source")}</button> : null}
                      <button type="button" className="link-button" data-testid={`record-delete-${item.id}`} onClick={() => void act("notes.delete", { objectId: item.id }, t("records.deletedDone"))}><Trash2 size={14} aria-hidden="true" />{t("records.delete")}</button>
                    </>
                  )
                ) : (
                  <>
                    <button type="button" className="secondary-button" data-testid={`record-review-${item.id}`} onClick={() => props.onOpenRecording(item.id, item.workId)}>{t("records.review")}</button>
                    {item.stage && RETRYABLE.includes(item.stage) ? <button type="button" className="secondary-button" data-testid={`record-retry-${item.id}`} onClick={() => void act("capture.retry", { sessionId: item.id }, t("records.retried"))}><RotateCcw size={14} aria-hidden="true" />{t("records.retry")}</button> : null}
                    {item.audioState === "staged" ? <button type="button" className="link-button" data-testid={`record-clean-${item.id}`} onClick={() => void act("capture.retain", { sessionId: item.id, action: "discard" }, t("records.cleaned"))}>{t("records.clean")}</button> : null}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <Pager testId="records-pager" offset={offset} limit={PAGE} total={total} onPage={setOffset} previous={t("pager.previous")} next={t("pager.next")} label={(from, to, count) => t("pager.range", { from, to, total: count })} />
    </SettingsPage>
  );
}
