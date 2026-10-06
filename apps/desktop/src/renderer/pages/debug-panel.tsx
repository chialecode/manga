import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, X } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { attempt } from "../lib/api.ts";
import { redactForDebug } from "../lib/debug-redact.ts";

type T = Translator["t"];

export type DebugTab = "current" | "last" | "events";
export type DebugView = { open: boolean; height: number; tab: DebugTab };
export const DEFAULT_DEBUG_VIEW: DebugView = { open: false, height: 260, tab: "current" };
export const DEBUG_MIN = 120;
export const DEBUG_MAX = 640;

const KEY = "manga.debug.view";
/** Open or closed and how tall, kept per session so a reader's panel and the chat page's panel do not fight over one setting. */
export function loadDebugView(sessionKey: string): DebugView {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, Partial<DebugView>>;
    const saved = all[sessionKey];
    return { ...DEFAULT_DEBUG_VIEW, ...(saved ?? {}), height: Math.min(DEBUG_MAX, Math.max(DEBUG_MIN, Number(saved?.height ?? DEFAULT_DEBUG_VIEW.height))) };
  } catch { return DEFAULT_DEBUG_VIEW; }
}
export function saveDebugView(sessionKey: string, view: DebugView): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, DebugView>;
    window.localStorage.setItem(KEY, JSON.stringify({ ...all, [sessionKey]: view }));
  } catch { /* the view just is not remembered */ }
}

export type NoticeEntry = { at: string; topic: string; payload: unknown };

/** The last notices the host sent, for the "events" tab. A ring: the window never keeps more than a screenful of them. */
export function useNoticeLog(limit = 60): NoticeEntry[] {
  const [entries, setEntries] = useState<NoticeEntry[]>([]);
  useEffect(() => {
    const off = window.manga.onNotice?.((notice) => {
      // Progress ticks arrive many times a second; only the latest of each topic is kept in a row.
      setEntries((current) => {
        const last = current[current.length - 1];
        const next = { at: new Date().toISOString(), topic: notice.topic, payload: notice.payload };
        return [...(last && last.topic === notice.topic && /progress/.test(notice.topic) ? current.slice(0, -1) : current), next].slice(-limit);
      });
    });
    return () => off?.();
  }, [limit]);
  return entries;
}

type DebugReport = {
  scope?: Record<string, unknown>;
  model?: Record<string, unknown> | null;
  tools?: Array<{ id: string; description: string }>;
  budget?: Record<string, unknown>;
  lastRun?: Record<string, unknown> | null;
  redactions?: { secrets: number; paths: number };
  generatedAt?: string;
};

/**
 * The context debug panel (A-48): read-only, under the page, for seeing what the next task would be given and what the last one
 * was given. Everything comes from the existing snapshot and commands; this panel keeps no copy of its own. Credentials are always
 * hidden and a picture is shown by size and hash.
 */
export function DebugPanel(props: {
  t: T;
  view: DebugView;
  onView: (view: DebugView) => void;
  scope: { sessionId?: string; resourceId?: string; workId?: string; page: string };
  /** What the window itself knows about the next send: the live position, the picked tags, the composer's choices. */
  live: Record<string, unknown>;
  events: NoticeEntry[];
  version: number;
  onNotice: (message: string) => void;
}) {
  const { t, view } = props;
  const [report, setReport] = useState<DebugReport | null>(null);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const { sessionId, resourceId, workId, page } = props.scope;

  const load = useCallback(async () => {
    const mine = ++request.current;
    const result = await attempt<DebugReport>("debug.context", { ...(sessionId ? { sessionId } : {}), ...(resourceId ? { resourceId } : {}), ...(workId ? { workId } : {}), page });
    if (mine !== request.current) return;
    if (!result.ok) { setError(result.error.message); return; }
    setError(undefined);
    setReport(result.value);
  }, [sessionId, resourceId, workId, page]);
  useEffect(() => { if (view.open) void load(); }, [view.open, load, props.version]);

  const document = redactForDebug({ generatedAt: report?.generatedAt ?? new Date().toISOString(), page, current: { ...props.live, scope: report?.scope, model: report?.model, tools: report?.tools, budget: report?.budget }, lastRun: report?.lastRun ?? null, events: props.events.slice(-30) });

  async function copy() {
    const text = JSON.stringify(document, null, 2);
    try { await navigator.clipboard.writeText(text); props.onNotice(t("debug.copied")); } catch { props.onNotice(t("debug.copyFailed")); }
  }

  const drag = useRef<{ y: number; height: number } | null>(null);
  const resize = (height: number) => props.onView({ ...view, height: Math.min(DEBUG_MAX, Math.max(DEBUG_MIN, Math.round(height))) });
  if (!view.open) return null;
  const last = report?.lastRun as (Record<string, unknown> & { materials?: unknown[]; notes?: unknown[]; history?: Record<string, unknown>; contextText?: string | null; question?: string }) | null | undefined;

  return (
    <section className="debug-panel" style={{ height: view.height }} data-testid="debug-panel" aria-label={t("debug.title")}>
      <div
        className="debug-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-valuemin={DEBUG_MIN}
        aria-valuemax={DEBUG_MAX}
        aria-valuenow={view.height}
        aria-label={t("debug.resize")}
        tabIndex={0}
        data-testid="debug-grip"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); drag.current = { y: event.clientY, height: view.height }; }}
        onPointerMove={(event) => { if (drag.current) resize(drag.current.height + (drag.current.y - event.clientY)); }}
        onPointerUp={() => { drag.current = null; }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") { event.preventDefault(); resize(view.height + 24); }
          if (event.key === "ArrowDown") { event.preventDefault(); resize(view.height - 24); }
        }}
      />
      <header className="debug-head">
        <div role="tablist" aria-label={t("debug.title")} className="debug-tabs">
          {(["current", "last", "events"] as const).map((tab) => (
            <button key={tab} type="button" role="tab" aria-selected={view.tab === tab} data-testid={`debug-tab-${tab}`} onClick={() => props.onView({ ...view, tab })}>{t(`debug.tab.${tab}` as never)}</button>
          ))}
        </div>
        <span className="flex-1" />
        <button type="button" className="secondary-button" data-testid="debug-copy" onClick={() => void copy()}><Copy size={13} />{t("debug.copy")}</button>
        <button type="button" className="icon-button" data-testid="debug-close" aria-label={t("debug.close")} title={t("debug.close")} onClick={() => props.onView({ ...view, open: false })}><X size={15} /></button>
      </header>
      <div className="debug-body" role="tabpanel" data-testid={`debug-body-${view.tab}`}>
        {error ? <p role="alert" className="chat-error">{error}</p> : null}
        {view.tab === "current" ? (
          <dl className="debug-list">
            {Object.entries(redactForDebug(props.live)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}
            {report?.scope ? <div><dt>{t("debug.scope")}</dt><dd>{JSON.stringify(report.scope)}</dd></div> : null}
            {report?.model ? <div><dt>{t("debug.model")}</dt><dd data-testid="debug-model">{JSON.stringify(report.model)}</dd></div> : <div><dt>{t("debug.model")}</dt><dd>{t("debug.none")}</dd></div>}
            <div><dt>{t("debug.tools")}</dt><dd>{(report?.tools ?? []).map((tool) => tool.id).join("、") || t("debug.none")}</dd></div>
            <div><dt>{t("debug.budget")}</dt><dd>{JSON.stringify(report?.budget ?? {})}</dd></div>
          </dl>
        ) : null}
        {view.tab === "last" ? (
          last ? (
            <dl className="debug-list" data-testid="debug-last">
              <div><dt>{t("debug.run")}</dt><dd>{`${String(last.status)} · ${String(last.runId)}`}</dd></div>
              <div><dt>{t("debug.question")}</dt><dd>{String(last.question ?? "")}</dd></div>
              <div><dt>{t("debug.materials")}</dt><dd>{JSON.stringify(last.materials ?? [])}</dd></div>
              <div><dt>{t("debug.notes")}</dt><dd>{JSON.stringify(last.notes ?? [])}</dd></div>
              <div><dt>{t("debug.selection")}</dt><dd>{JSON.stringify(last.selection ?? null)}</dd></div>
              <div><dt>{t("debug.media")}</dt><dd>{JSON.stringify(last.media ?? null)}</dd></div>
              <div><dt>{t("debug.history")}</dt><dd>{JSON.stringify(last.history ?? {})}</dd></div>
              <div><dt>{t("debug.usage")}</dt><dd>{`${String(last.modelId ?? "-")} · ${String(last.inputTokens ?? "-")} / ${String(last.outputTokens ?? "-")}`}</dd></div>
              {last.contextText ? <div><dt>{t("debug.context")}</dt><dd><pre>{String(last.contextText)}</pre></dd></div> : null}
            </dl>
          ) : <p className="detail-muted" data-testid="debug-last-none">{t("debug.lastNone")}</p>
        ) : null}
        {view.tab === "events" ? (
          props.events.length ? (
            <ol className="debug-events" data-testid="debug-events">
              {props.events.slice(-30).reverse().map((entry, index) => <li key={`${entry.at}:${index}`}><time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}</time> <strong>{entry.topic}</strong> <code>{JSON.stringify(redactForDebug(entry.payload)).slice(0, 240)}</code></li>)}
            </ol>
          ) : <p className="detail-muted">{t("debug.eventsNone")}</p>
        ) : null}
      </div>
    </section>
  );
}
