import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Trash2 } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { asArray, attempt } from "../../lib/api.ts";
import { Modal } from "../../components/modal.tsx";
import { Pager } from "./rows.tsx";

type T = Translator["t"];
export type ConversationKindId = "shared" | "resource" | "work" | "project" | "note";
export type ConversationRecord = {
  sessionId: string;
  title: string;
  kind: ConversationKindId;
  /** The context the conversation belongs to: a project id, null for "最近". */
  contextId: string | null;
  contextName: string | null;
  targetId: string | null;
  ownerTitle: string | null;
  runCount: number;
  createdAt: string;
  lastAt: string;
  excerpt: string;
  current: boolean;
  running: boolean;
};
type Removal = { removed: string[]; skipped: Array<{ sessionId: string; reason: string }> };

const PAGE = 30;
const KINDS: ConversationKindId[] = ["shared", "resource", "work", "project", "note"];
const DAY = 86_400_000;
type Time = "" | "week" | "month" | "older";
/** `project`: all, "recent" for the conversations outside every project, or a project id. */
type Filter = { project: string; kind: "" | ConversationKindId; time: Time; q: string };

/** The part of a filter the main process understands; the same object lists and deletes, so what is deleted is what the list shows. */
function wireFilter(filter: Filter): Record<string, unknown> {
  const now = Date.now();
  return {
    ...(filter.project ? { contextId: filter.project === "recent" ? null : filter.project } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.time === "week" ? { after: new Date(now - 7 * DAY).toISOString() } : {}),
    ...(filter.time === "month" ? { after: new Date(now - 30 * DAY).toISOString() } : {}),
    ...(filter.time === "older" ? { before: new Date(now - 30 * DAY).toISOString() } : {}),
    ...(filter.q ? { q: filter.q } : {}),
  };
}

/**
 * Every conversation, of every kind, with the means to delete them (AGENT-06, A-89): one, several chosen, or all that the filter shows. Deleting is
 * asked about first and says what goes and what stays; a conversation whose task is still running is left and said so.
 */
export function ConversationRecords(props: {
  t: T;
  formatDate: (value: string) => string;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [filter, setFilter] = useState<Filter>({ project: "", kind: "", time: "", q: "" });
  const [text, setText] = useState("");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<ConversationRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState<{ scope: "ids"; ids: string[]; count: number } | { scope: "all"; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [contexts, setContexts] = useState<Array<{ value: string; name: string }>>([]);
  const latest = useRef(0);

  // The contexts to filter by: "最近" and the projects, archived ones included (their conversations are still there).
  useEffect(() => {
    let live = true;
    void attempt<{ contexts: Array<{ contextId: string | null; name: string }> }>("workspace.contexts", { includeArchived: true }).then((result) => {
      if (live && result.ok) setContexts(asArray<{ contextId: string | null; name: string }>(result.value.contexts).map((item) => ({ value: item.contextId ?? "recent", name: item.contextId === null ? t("sidebar.recent") : item.name })));
    });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    const request = ++latest.current;
    const result = await attempt<{ items: ConversationRecord[]; total: number }>("conversation.list", { ...wireFilter(filter), limit: PAGE, offset });
    if (request !== latest.current) return;
    if (!result.ok) { setStatus("error"); props.onError(result.error.message); return; }
    setItems(asArray<ConversationRecord>(result.value.items));
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

  // A conversation deleted from anywhere else (the history list) leaves this list as well.
  useEffect(() => window.manga.onNotice?.((notice) => { if (notice.topic === "conversation.deleted") void load(); }), [load]);

  const patch = (next: Partial<Filter>) => { setFilter((current) => ({ ...current, ...next })); setOffset(0); setPicked(new Set()); };
  const filtered = Boolean(filter.project || filter.kind || filter.time || filter.q);
  const pageIds = items.map((item) => item.sessionId);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  const toggle = (id: string) => setPicked((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  async function confirm() {
    if (!asking) return;
    setBusy(true);
    const result = asking.scope === "ids"
      ? await attempt<Removal>("conversation.delete", { sessionIds: asking.ids })
      : await attempt<Removal>("conversation.deleteAll", wireFilter(filter));
    setBusy(false);
    setAsking(null);
    if (!result.ok) { props.onError(result.error.message); return; }
    const skipped = asArray<{ sessionId: string }>(result.value.skipped).filter((item) => (item as { reason?: string }).reason === "running").length;
    props.onNotice(skipped ? `${t("records.conv.done", { count: result.value.removed.length })} ${t("records.conv.skipped", { count: skipped })}` : t("records.conv.done", { count: result.value.removed.length }));
    setPicked(new Set());
    if (offset > 0 && result.value.removed.length >= items.length) setOffset(Math.max(0, offset - PAGE));
    await load();
  }

  /** Where a conversation belongs: the context it is in, and for a conversation about a file, a work or a note, what it is about. */
  const place = (item: ConversationRecord) => {
    const context = item.contextId === null ? t("sidebar.recent") : item.contextName || t("records.conv.ownerGone");
    if (item.kind === "shared" || item.kind === "project") return context;
    return [item.ownerTitle || t("records.conv.ownerGone"), context].join(" · ");
  };

  return (
    <>
      <div className="records-filters" role="search" data-testid="conv-filters">
        <select aria-label={t("records.conv.project")} data-testid="conv-project" value={filter.project} onChange={(event) => patch({ project: event.target.value })}>
          <option value="">{t("records.conv.projectAll")}</option>
          {contexts.map((item) => <option key={item.value} value={item.value}>{item.name}</option>)}
        </select>
        <select aria-label={t("records.conv.kind")} data-testid="conv-kind" value={filter.kind} onChange={(event) => patch({ kind: event.target.value as Filter["kind"] })}>
          <option value="">{t("records.conv.kindAll")}</option>
          {KINDS.map((kind) => <option key={kind} value={kind}>{t(`records.conv.kind.${kind}` as MessageKey)}</option>)}
        </select>
        <select aria-label={t("records.conv.time")} data-testid="conv-time" value={filter.time} onChange={(event) => patch({ time: event.target.value as Time })}>
          <option value="">{t("records.conv.timeAll")}</option>
          <option value="week">{t("records.conv.time.week")}</option>
          <option value="month">{t("records.conv.time.month")}</option>
          <option value="older">{t("records.conv.time.older")}</option>
        </select>
        <input type="search" aria-label={t("records.conv.search")} placeholder={t("records.conv.search")} data-testid="conv-search" value={text} onChange={(event) => setText(event.target.value)} />
      </div>

      <div className="records-bulk" data-testid="conv-bulk">
        <label className="msettings-check">
          <input type="checkbox" data-testid="conv-select-page" checked={allOnPage} disabled={items.length === 0} onChange={() => setPicked(allOnPage ? new Set() : new Set(pageIds))} />
          {t("records.conv.selectPage")}
        </label>
        <button type="button" className="secondary-button" data-testid="conv-delete-picked" disabled={picked.size === 0} onClick={() => setAsking({ scope: "ids", ids: [...picked], count: picked.size })}>
          <Trash2 size={14} aria-hidden="true" />{t("records.conv.deletePicked", { count: picked.size })}
        </button>
        <button type="button" className="danger-button" data-testid="conv-delete-all" disabled={total === 0} onClick={() => setAsking({ scope: "all", count: total })}>
          {filtered ? t("records.conv.deleteFiltered", { count: total }) : t("records.conv.deleteAll", { count: total })}
        </button>
      </div>

      {status === "loading" && !items.length ? <p role="status" className="detail-muted" data-testid="conv-loading">{t("status.loading")}</p> : null}
      {status === "ready" && items.length === 0 ? <p className="detail-muted settings-empty" data-testid="conv-empty">{t("records.conv.empty")}</p> : null}

      <ul className="records-list" data-testid="conv-list" aria-busy={status === "loading"}>
        {items.map((item) => (
          <li key={item.sessionId} className="record-row record-row-select" data-testid={`conv-${item.sessionId}`} data-kind={item.kind} data-running={item.running ? "true" : "false"}>
            <input type="checkbox" className="record-check" data-testid={`conv-pick-${item.sessionId}`} aria-label={t("records.conv.select", { title: item.title })} checked={picked.has(item.sessionId)} onChange={() => toggle(item.sessionId)} />
            <span className="record-icon" aria-hidden="true"><MessageCircle size={16} /></span>
            <div className="record-main">
              <strong className="record-title">{item.title}</strong>
              {item.excerpt ? <span className="record-preview">{item.excerpt}</span> : null}
              <span className="detail-muted record-meta" data-testid={`conv-meta-${item.sessionId}`}>
                {[t(`records.conv.kind.${item.kind}` as MessageKey), place(item), item.runCount > 0 ? t("records.conv.rounds", { count: item.runCount }) : t("records.conv.noRounds"), props.formatDate(item.lastAt)].join(" · ")}
              </span>
              {item.current || item.running ? (
                <span className="record-chips">
                  {item.current ? <span className="chip" data-testid={`conv-current-${item.sessionId}`}>{t("records.conv.current")}</span> : null}
                  {item.running ? <span className="chip" data-testid={`conv-running-${item.sessionId}`}>{t("records.conv.running")}</span> : null}
                </span>
              ) : null}
            </div>
            <div className="record-actions">
              <button type="button" className="link-button" data-testid={`conv-delete-${item.sessionId}`} aria-label={t("records.conv.deleteOne", { title: item.title })} onClick={() => setAsking({ scope: "ids", ids: [item.sessionId], count: 1 })}>
                <Trash2 size={14} aria-hidden="true" />{t("records.delete")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <Pager testId="conv-pager" offset={offset} limit={PAGE} total={total} onPage={(next) => { setOffset(next); setPicked(new Set()); }} previous={t("pager.previous")} next={t("pager.next")} label={(from, to, count) => t("pager.range", { from, to, total: count })} />
      <p className="detail-muted records-scope" data-testid="conv-scope">{t("records.conv.backup")}</p>

      {asking ? (
        <Modal
          variant="dialog"
          testId="conv-confirm"
          title={t("records.conv.confirm.title", { count: asking.count })}
          closeLabel={t("common.close")}
          onClose={() => { if (!busy) setAsking(null); }}
          footer={(
            <>
              <button type="button" className="secondary-button" data-testid="conv-confirm-cancel" disabled={busy} onClick={() => setAsking(null)}>{t("common.cancel")}</button>
              <button type="button" className="danger-button" data-testid="conv-confirm-ok" disabled={busy} onClick={() => void confirm()}>{busy ? t("records.conv.confirm.working") : t("records.conv.confirm.ok")}</button>
            </>
          )}
        >
          <div className="delete-entry">
            <section data-testid="conv-confirm-removes"><h3>{t("records.conv.confirm.removesTitle")}</h3><p>{t("records.conv.confirm.removes")}</p><p>{t("records.conv.confirm.usage")}</p></section>
            <section data-testid="conv-confirm-keeps"><h3>{t("records.conv.confirm.keepsTitle")}</h3><p>{t("records.conv.confirm.keeps")}</p></section>
            <p data-testid="conv-confirm-warning"><strong>{t("records.conv.confirm.irreversible")}</strong></p>
            {asking.scope === "all" && filtered ? <p className="detail-muted">{t("records.conv.confirm.filtered")}</p> : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
