import { useCallback, useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { attempt } from "../lib/api.ts";
import { entryTitle, readable, sizeLabel, spanLabel, type TraceEntry, type TracePart } from "../lib/trace-model.ts";
import { Modal } from "./modal.tsx";

type T = Translator["t"];
const PAGE_CHARS = 16 * 1024;

/** One part of one entry: the first page is fetched when it is shown and the rest on request, so a long context never arrives at once. */
function PartView(props: { t: T; entry: TraceEntry; part: "request" | "response" }) {
  const { t, entry, part } = props;
  const [text, setText] = useState("");
  const [total, setTotal] = useState(0);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const token = useRef(0);

  const load = useCallback(async (offset: number) => {
    const mine = token.current;
    setBusy(true);
    const result = await attempt<TracePart>("agent.trace.get", { entryId: entry.id, part, offset, limit: PAGE_CHARS });
    if (mine !== token.current) return;
    setBusy(false);
    if (!result.ok) { setAvailable(false); return; }
    setAvailable(result.value.available);
    setTotal(result.value.total);
    setTruncated(result.value.truncated);
    setText((current) => (offset === 0 ? result.value.text : current + result.value.text));
  }, [entry.id, part]);

  useEffect(() => {
    token.current += 1;
    setText(""); setTotal(0); setAvailable(null); setTruncated(false);
    void load(0);
  }, [load]);

  const shown = [...text].length;
  const complete = available === true && shown >= total;
  return (
    <section className="trace-part" data-testid={`trace-part-${part}`} aria-label={t(`trace.part.${part}` as MessageKey)}>
      <h4>{t(`trace.part.${part}` as MessageKey)}</h4>
      {available === null ? <p className="detail-muted" role="status">{t("trace.loading")}</p> : null}
      {available === false ? <p className="detail-muted" data-testid={`trace-part-${part}-none`}>{entry.hasContent ? t("trace.noPart") : t("trace.noContent")}</p> : null}
      {truncated ? <p className="review-error" data-testid={`trace-part-${part}-cut`}>{t("trace.truncated")}</p> : null}
      {available ? <pre className="trace-text" tabIndex={0} data-testid={`trace-text-${part}`}>{readable(text, complete)}</pre> : null}
      {available && !complete ? (
        <div className="trace-more">
          <span className="detail-muted">{t("trace.loaded", { shown, total })}</span>
          <button type="button" className="secondary-button" disabled={busy} data-testid={`trace-more-${part}`} onClick={() => void load(shown)}>{t("trace.more")}</button>
        </div>
      ) : null}
    </section>
  );
}

function EntryDetail(props: { t: T; entry: TraceEntry; formatNumber: (value: number) => string }) {
  const { t, entry } = props;
  return (
    <div className="trace-detail" data-testid="trace-detail" data-entry={entry.id}>
      <header className="trace-detail-head">
        <strong>{entryTitle(t, entry)}</strong>
        <span className="chip" data-status={entry.status}>{t(`trace.status.${entry.status}` as MessageKey)}</span>
      </header>
      <ul className="trace-facts">
        {entry.modelId ? <li data-testid="trace-model">{t("trace.model", { model: entry.modelId, protocol: entry.protocol ?? "—" })}</li> : null}
        {entry.firstTokenMs !== null ? <li data-testid="trace-first-token">{t("trace.firstToken", { time: spanLabel(entry.firstTokenMs) })}</li> : null}
        {entry.durationMs !== null ? <li data-testid="trace-duration">{t("trace.duration", { time: spanLabel(entry.durationMs) })}</li> : null}
        {entry.usage && (entry.usage.inputTokens || entry.usage.outputTokens) ? <li data-testid="trace-tokens">{t("trace.tokens", { input: props.formatNumber(entry.usage.inputTokens ?? 0), output: props.formatNumber(entry.usage.outputTokens ?? 0) })}</li> : null}
        <li>{t("trace.bytes", { request: sizeLabel(entry.requestBytes), response: sizeLabel(entry.responseBytes) })}</li>
      </ul>
      {entry.error?.message ? <p className="review-error" role="alert" data-testid="trace-error">{t("trace.error", { message: entry.error.message })}</p> : null}
      <PartView t={t} entry={entry} part="request" />
      <PartView t={t} entry={entry} part="response" />
    </div>
  );
}

/**
 * The trace of one task (A-83): every request to a model, every tool and every compaction in the order they happened, and for the one picked, what was
 * sent and what came back. It is opened from the usage page and from a reply in the conversation. The copy is the same text the host exports, cleaned
 * the same way.
 */
export function TraceDialog(props: { t: T; runId: string; formatNumber: (value: number) => string; onNotice: (message: string) => void; onClose: () => void }) {
  const { t, runId } = props;
  const [entries, setEntries] = useState<TraceEntry[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void attempt<{ entries: TraceEntry[] }>("agent.trace.list", { runId }).then((result) => {
      if (!live) return;
      const list = result.ok ? result.value.entries : [];
      setEntries(list);
      setPicked(list[0]?.id ?? null);
    });
    return () => { live = false; };
  }, [runId]);

  async function copy() {
    const result = await attempt<{ json: string; entries: number; omitted: number }>("agent.trace.export", { runId });
    if (!result.ok) { props.onNotice(t("trace.copyFailed")); return; }
    try {
      await navigator.clipboard.writeText(result.value.json);
      props.onNotice(result.value.omitted ? t("trace.copiedPartial", { count: result.value.entries, omitted: result.value.omitted }) : t("trace.copied", { count: result.value.entries }));
    } catch { props.onNotice(t("trace.copyFailed")); }
  }

  const first = entries?.[0] ? Date.parse(entries[0].startedAt) : 0;
  const current = entries?.find((entry) => entry.id === picked);
  return (
    <Modal
      title={t("trace.title")}
      description={t("trace.lead")}
      closeLabel={t("trace.close")}
      onClose={props.onClose}
      testId="trace-dialog"
      variant="drawer"
      className="trace-drawer"
      footer={entries?.length ? <button type="button" className="secondary-button" data-testid="trace-copy" onClick={() => void copy()}><Copy size={13} />{t("trace.copy")}</button> : undefined}
    >
      {entries === null ? <p className="detail-muted" role="status">{t("trace.loading")}</p> : null}
      {entries && entries.length === 0 ? <p className="detail-muted" data-testid="trace-empty">{t("trace.empty")}</p> : null}
      {entries?.length ? (
        <div className="trace-view">
          <ol className="trace-list" aria-label={t("trace.list")} data-testid="trace-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="trace-item" aria-current={entry.id === picked ? "true" : undefined} data-testid={`trace-item-${entry.id}`} data-kind={entry.kind} data-status={entry.status} onClick={() => setPicked(entry.id)}>
                  <span className="trace-item-title">{entryTitle(t, entry)}</span>
                  <span className="trace-item-meta detail-muted">
                    {t(`trace.kind.${entry.kind}` as MessageKey)} · {t(`trace.status.${entry.status}` as MessageKey)}
                    {entry.durationMs !== null ? ` · ${spanLabel(entry.durationMs)}` : ""}
                  </span>
                  <span className="trace-item-meta detail-muted">{t("trace.at", { time: spanLabel(Math.max(0, Date.parse(entry.startedAt) - first)) })}</span>
                </button>
              </li>
            ))}
          </ol>
          {current ? <EntryDetail key={current.id} t={t} entry={current} formatNumber={props.formatNumber} /> : null}
        </div>
      ) : null}
    </Modal>
  );
}
