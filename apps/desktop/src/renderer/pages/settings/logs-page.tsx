import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageKey, Translator } from "@manga/i18n";
import { useAsyncGuard, useDebouncedSearch } from "../../hooks/use-async-guard.ts";
import { asArray, attempt } from "../../lib/api.ts";
import { dayBounds } from "../../lib/format.ts";
import { SettingsPage } from "./rows.tsx";

type T = Translator["t"];
export type LogEntry = {
  id: number;
  at: string;
  actorKind: "user" | "agent" | "system";
  actorId: string | null;
  runId: string | null;
  category: string;
  action: string;
  objectKind: string | null;
  objectId: string | null;
  objectLabel: string | null;
  summaryKey: string;
  summaryParams: Record<string, string | number>;
  outcome: "ok" | "error";
  errorCode: string | null;
  requestId: string | null;
};

type Found = { entries: LogEntry[]; nextBefore: number | null; total: number; categories: string[]; retention?: { days: number; rows: number } };
const PAGE = 50;

/** A line the person can read: the catalog's sentence for the entry, or the command's name when this build has no sentence for it. */
export function logSummary(t: T, entry: LogEntry): string {
  const key = entry.summaryKey as MessageKey;
  const text = t(key, entry.summaryParams);
  return text === entry.summaryKey ? entry.action : text;
}

const categoryLabel = (t: T, category: string) => {
  const key = `log.category.${category}` as MessageKey;
  const text = t(key);
  return text === key ? category : text;
};

/**
 * The operation log (A-49): what the user, the Agent and the app itself changed, newest first, with filters for the category, who did
 * it, how it ended, a keyword and a date range. It is read-only; entries carry no text of the user's notes and no credentials.
 */
export function LogsPage(props: { t: T; formatDate: (value: string) => string; onError: (message: string) => void }) {
  const { t } = props;
  const [category, setCategory] = useState("");
  const [actor, setActor] = useState("");
  const [outcome, setOutcome] = useState("");
  const search = useDebouncedSearch("", 250);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [retention, setRetention] = useState<Found["retention"]>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const guard = useAsyncGuard();
  const loadingMoreRef = useRef(false);
  const onErrorRef = useRef(props.onError);
  onErrorRef.current = props.onError;

  const input = useCallback((before?: number) => {
    const fromIso = from ? dayBounds(from).from : undefined;
    const toIso = to ? dayBounds(to).to : undefined;
    return {
      ...(category ? { category } : {}),
      ...(actor ? { actorKind: actor } : {}),
      ...(outcome ? { outcome } : {}),
      ...(search.query ? { q: search.query } : {}),
      ...(fromIso ? { from: fromIso } : {}),
      ...(toIso ? { to: toIso } : {}),
      limit: PAGE,
      ...(before ? { before } : {}),
    };
  }, [category, actor, outcome, search.query, from, to]);

  const load = useCallback(async () => {
    const request = guard.next();
    loadingMoreRef.current = false;
    setLoadingMore(false);
    const result = await attempt<Found>("log.query", input());
    if (!guard.isCurrent(request)) return;
    if (!result.ok) { setStatus("error"); onErrorRef.current(result.error.message); return; }
    setEntries(asArray<LogEntry>(result.value.entries));
    setNext(result.value.nextBefore ?? null);
    setTotal(Number(result.value.total ?? 0));
    setCategories(asArray<string>(result.value.categories));
    setRetention(result.value.retention);
    setStatus("ready");
  }, [input, guard]);

  useEffect(() => { void load(); }, [load]);

  async function more() {
    if (next === null || loadingMoreRef.current) return;
    const request = guard.next();
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await attempt<Found>("log.query", input(next));
      if (!guard.isCurrent(request)) return;
      if (!result.ok) { onErrorRef.current(result.error.message); return; }
      const incoming = asArray<LogEntry>(result.value.entries);
      setEntries((current) => {
        const seen = new Set(current.map((item) => item.id));
        const unique = incoming.filter((item) => !seen.has(item.id));
        return unique.length ? [...current, ...unique] : current;
      });
      setNext(result.value.nextBefore ?? null);
    } finally {
      if (guard.isCurrent(request)) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  const actorName = (entry: LogEntry) => entry.actorKind === "agent" ? t("logs.actorAgent") : entry.actorKind === "user" ? t("logs.actorUser") : t("logs.actorSystem");

  return (
    <SettingsPage id="logs" title={t("settings.page.logs")} hint={t("logs.hint", { days: retention?.days ?? 180, rows: retention?.rows ?? 50_000 })} wide>
      <div className="records-filters" role="search" data-testid="logs-filters">
        <select aria-label={t("logs.category")} data-testid="logs-category" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">{t("logs.categoryAll")}</option>
          {categories.map((item) => <option key={item} value={item}>{categoryLabel(t, item)}</option>)}
        </select>
        <select aria-label={t("logs.actor")} data-testid="logs-actor" value={actor} onChange={(event) => setActor(event.target.value)}>
          <option value="">{t("logs.actorAll")}</option>
          <option value="user">{t("logs.actorUser")}</option>
          <option value="agent">{t("logs.actorAgent")}</option>
          <option value="system">{t("logs.actorSystem")}</option>
        </select>
        <select aria-label={t("logs.outcome")} data-testid="logs-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
          <option value="">{t("logs.outcomeAll")}</option>
          <option value="ok">{t("logs.outcomeOk")}</option>
          <option value="error">{t("logs.outcomeError")}</option>
        </select>
        <input type="search" aria-label={t("logs.search")} placeholder={t("logs.search")} data-testid="logs-search" {...search.inputProps} />
        <label className="records-date"><span>{t("logs.from")}</span><input type="date" data-testid="logs-from" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="records-date"><span>{t("logs.to")}</span><input type="date" data-testid="logs-to" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
      </div>
      {status === "loading" && !entries.length ? <p role="status" className="detail-muted">{t("status.loading")}</p> : null}
      {status === "ready" && entries.length === 0 ? <p className="detail-muted settings-empty" data-testid="logs-empty">{t("logs.empty")}</p> : null}
      <ol className="logs-list" data-testid="logs-list" aria-busy={status === "loading" || loadingMore}>
        {entries.map((entry) => (
          <li key={entry.id} className="log-row" data-testid={`log-${entry.id}`} data-outcome={entry.outcome} data-actor={entry.actorKind} data-category={entry.category}>
            <time className="log-time detail-muted" dateTime={entry.at}>{props.formatDate(entry.at)}</time>
            <span className="chip" data-testid={`log-actor-${entry.id}`}>{actorName(entry)}</span>
            <span className="chip chip-quiet">{categoryLabel(t, entry.category)}</span>
            <span className="log-summary">{logSummary(t, entry)}</span>
            {entry.objectLabel ? <span className="log-object" title={entry.objectLabel}>{entry.objectLabel}</span> : null}
            {entry.outcome === "error" ? <span className="log-error" data-testid={`log-error-${entry.id}`}>{t("logs.failed", { code: entry.errorCode ?? "—" })}</span> : null}
          </li>
        ))}
      </ol>
      <div className="settings-pager">
        <span className="detail-muted" data-testid="logs-total">{t("logs.total", { shown: entries.length, total })}</span>
        {next !== null ? <button type="button" className="secondary-button" data-testid="logs-more" disabled={loadingMore} onClick={() => void more()}>{t("logs.more")}</button> : null}
      </div>
    </SettingsPage>
  );
}
