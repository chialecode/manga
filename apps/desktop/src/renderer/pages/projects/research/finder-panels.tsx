import { useEffect, useRef, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { CommandError, asArray, attempt } from "../../../lib/api.ts";
import { formatClockMs } from "../../../lib/format.ts";
import { useAsyncGuard } from "../../../hooks/use-async-guard.ts";
import { Modal } from "../../../components/modal.tsx";
import type { Material } from "../project-parts.tsx";
import { RESEARCH_SCOPES, fetchReason, hostOf, type FetchOutcome, type PageSummary, type ResearchScope, type ResultItem } from "./research-model.ts";

type T = Translator["t"];

/** The kind a search result is kept as when it is added to the project: a work is added as the work, a book not yet in any work as the resource. */
function materialKindOf(result: ResultItem): string | null {
  if (result.kind === "page") return null;
  if (result.kind === "work") return result.workId ? "work" : "resource";
  return result.kind;
}

/** Searching the person's own material, with the scopes to look in; each result can be opened or added to the project. */
export function SearchPanel(props: {
  t: T; formatDate: (iso: string) => string; projectId: string;
  onOpenMaterial: (material: Pick<Material, "kind" | "targetId" | "label" | "opens">) => void;
  onOpenExcerpt: (excerptId: string) => void;
  onOpenPage: (pageId: string) => void;
  onAdded: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [text, setText] = useState("");
  const [scopes, setScopes] = useState<ReadonlySet<ResearchScope>>(new Set(RESEARCH_SCOPES));
  const [searched, setSearched] = useState<{ text: string; results: ResultItem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const guard = useAsyncGuard();

  async function search(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    const query = text.trim();
    if (!query || !scopes.size || busy) return;
    const token = guard.next();
    setBusy(true);
    const result = await attempt<{ results: ResultItem[] }>("research.search", { text: query, projectId: props.projectId, ...(scopes.size < RESEARCH_SCOPES.length ? { scopes: RESEARCH_SCOPES.filter((scope) => scopes.has(scope)) } : {}) });
    if (!guard.isCurrent(token)) return;
    setBusy(false);
    if (!result.ok) { props.onError(result.error.message); return; }
    setSearched({ text: query, results: asArray<ResultItem>(result.value.results) });
  }

  function toggle(scope: ResearchScope) {
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope); else next.add(scope);
      return next;
    });
  }

  async function add(result: ResultItem) {
    const kind = materialKindOf(result);
    const key = `${result.kind}:${result.id}:${result.startMs ?? result.start ?? 0}`;
    if (!kind || addingKey !== null) return;
    setAddingKey(key);
    const added = await attempt("project.addMaterial", { projectId: props.projectId, kind, targetId: kind === "resource" ? (result.resourceId ?? result.id) : result.id });
    if (!guard.isAlive()) return;
    setAddingKey(null);
    if (!added.ok) { props.onError(added.error.message); return; }
    props.onNotice(t("research.result.added"));
    setSearched((current) => current ? { ...current, results: current.results.map((item) => item === result ? { ...item, inProject: true } : item) } : current);
    props.onAdded();
  }

  function open(result: ResultItem) {
    if (result.kind === "page") { props.onOpenPage(result.id); return; }
    if (result.kind === "excerpt") { props.onOpenExcerpt(result.id); return; }
    if (result.kind === "work" && !result.workId && result.resourceId) {
      props.onOpenMaterial({ kind: "resource", targetId: result.resourceId, label: result.title, opens: { resourceId: result.resourceId, mediaKind: result.mediaKind ?? "novel", workId: null } });
      return;
    }
    props.onOpenMaterial({ kind: result.kind, targetId: result.id, label: result.title });
  }

  return (
    <section className="research-panel" data-testid="research-search" aria-labelledby="research-search-title">
      <h3 id="research-search-title">{t("research.search.title")}</h3>
      <p className="detail-muted">{t("research.search.hint")}</p>
      <form className="research-form" onSubmit={(event) => void search(event)}>
        <input type="search" data-testid="research-search-input" aria-label={t("research.search.label")} value={text} maxLength={512} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="primary-button" data-testid="research-search-go" disabled={busy || !text.trim() || !scopes.size}><Search size={15} aria-hidden="true" /> {t("research.search.go")}</button>
      </form>
      <fieldset className="research-scopes" aria-label={t("research.search.scopes")}>
        {RESEARCH_SCOPES.map((scope) => (
          <label key={scope} className="chip-check">
            <input type="checkbox" data-testid={`research-scope-${scope}`} checked={scopes.has(scope)} onChange={() => toggle(scope)} />
            <span>{t(`research.scope.${scope}` as MessageKey)}</span>
          </label>
        ))}
      </fieldset>
      {searched ? (
        searched.results.length ? (
          <>
            <p className="detail-muted" role="status" data-testid="research-result-count">{t("research.search.count", { n: searched.results.length })}</p>
            <ul className="research-results" data-testid="research-results">
              {searched.results.map((result) => (
                <li key={`${result.kind}:${result.id}:${result.startMs ?? result.start ?? 0}`} data-testid={`research-result-${result.kind}`} data-id={result.id}>
                  <div className="research-result-head">
                    <span className="chip">{t(`research.scope.${result.kind}` as MessageKey)}</span>
                    <strong>{result.title}</strong>
                    {result.startMs !== undefined ? <span className="detail-muted">{t("research.result.at", { time: formatClockMs(result.startMs) })}</span> : null}
                  </div>
                  <p className="research-snippet">{result.snippet}</p>
                  <div className="research-result-actions">
                    <button type="button" className="link-button" data-testid="research-result-open" onClick={() => open(result)}>{t("research.result.open")}</button>
                    {materialKindOf(result) ? (result.inProject
                      ? <span className="detail-muted" data-testid="research-result-in">{t("research.result.inProject")}</span>
                      : <button type="button" className="link-button" data-testid="research-result-add" disabled={addingKey !== null} onClick={() => void add(result)}>{t("research.result.add")}</button>) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : <p className="detail-muted" data-testid="research-none">{t("research.search.none", { text: searched.text })}</p>
      ) : null}
    </section>
  );
}

/** Fetching the one address the person gave, and the pages kept so far. */
export function PagesPanel(props: {
  t: T; formatDate: (iso: string) => string;
  /** Changes whenever the pages kept changed somewhere else, so the list is read again. */
  version: number;
  openId: string | null;
  onOpen: (pageId: string) => void;
  onFetched: (outcome: FetchOutcome) => void;
  onDeleted: (pageId: string) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  const [confirming, setConfirming] = useState<PageSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const listGuard = useAsyncGuard();
  const onErrorRef = useRef(props.onError);
  onErrorRef.current = props.onError;

  useEffect(() => {
    const token = listGuard.next();
    void attempt<{ pages: PageSummary[] }>("webpage.list", {}).then((result) => {
      if (!listGuard.isCurrent(token)) return;
      if (result.ok) setPages(asArray<PageSummary>(result.value.pages)); else { setPages([]); onErrorRef.current(result.error.message); }
    });
  }, [props.version, listGuard]);

  async function fetchIt(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    const address = url.trim();
    if (!address || busy) return;
    setBusy(true);
    setProblem(null);
    const result = await attempt<FetchOutcome>("webpage.fetch", { url: address });
    if (!listGuard.isAlive()) return;
    setBusy(false);
    if (!result.ok) {
      const reason = fetchReason(result.error);
      setProblem(reason ? t(reason.key as MessageKey, reason.params) : result.error.message || t("research.fetch.failed"));
      return;
    }
    const { page, created, changed } = result.value;
    props.onNotice(created ? t("research.fetch.created", { title: page.title || hostOf(page.url) }) : changed ? t("research.fetch.changed", { title: page.title || hostOf(page.url), version: page.version }) : t("research.fetch.same", { title: page.title || hostOf(page.url) }));
    setUrl("");
    props.onFetched(result.value);
  }

  async function remove(page: PageSummary) {
    if (deleting) return;
    setDeleting(true);
    const result = await attempt("webpage.delete", { pageId: page.id });
    if (!listGuard.isAlive()) return;
    setDeleting(false);
    setConfirming(null);
    if (!result.ok) {
      const details = (result.error instanceof CommandError ? result.error.details : undefined) as { reason?: string; excerpts?: number } | undefined;
      props.onError(details?.reason === "inUse" ? t("research.pages.inUse", { n: details.excerpts ?? 0 }) : result.error.message);
      return;
    }
    props.onDeleted(page.id);
  }

  return (
    <section className="research-panel" data-testid="research-pages" aria-labelledby="research-fetch-title">
      <h3 id="research-fetch-title">{t("research.fetch.title")}</h3>
      <p className="detail-muted">{t("research.fetch.hint")}</p>
      <form className="research-form" onSubmit={(event) => void fetchIt(event)}>
        <input type="url" inputMode="url" data-testid="research-url" aria-label={t("research.fetch.label")} placeholder="https://" value={url} maxLength={2048} onChange={(event) => setUrl(event.target.value)} />
        <button type="submit" className="primary-button" data-testid="research-fetch" disabled={busy || !url.trim()}>{busy ? t("research.fetch.busy") : t("research.fetch.go")}</button>
      </form>
      {problem ? <p className="draft-warn-text" role="alert" data-testid="research-fetch-error">{problem}</p> : null}
      <h4>{t("research.pages.title")}</h4>
      {pages && !pages.length ? <p className="detail-muted" data-testid="research-pages-empty">{t("research.pages.empty")}</p> : null}
      <ul className="research-pages" data-testid="research-page-list">
        {(pages ?? []).map((page) => (
          <li key={page.id} className={page.id === props.openId ? "is-current" : ""} data-testid={`research-page-${page.id}`}>
            <button type="button" className="research-page-open" data-testid="research-page-open" aria-current={page.id === props.openId} onClick={() => props.onOpen(page.id)}>
              <span>{page.title || hostOf(page.url)}</span>
              <small>{hostOf(page.url)} · {t("research.pages.meta", { version: page.version, chars: page.chars, excerpts: page.excerpts })}</small>
            </button>
            <button type="button" className="icon-button" data-testid="research-page-delete" aria-label={t("research.pages.delete")} title={t("research.pages.delete")} onClick={() => setConfirming(page)}><Trash2 size={15} aria-hidden="true" /></button>
          </li>
        ))}
      </ul>
      {confirming ? (
        <Modal title={t("research.pages.delete")} closeLabel={t("whiteboard.cancel")} onClose={() => { if (!deleting) setConfirming(null); }} testId="research-page-delete-dialog"
          footer={<><button type="button" disabled={deleting} onClick={() => setConfirming(null)}>{t("whiteboard.cancel")}</button><button type="button" className="danger-button" data-testid="research-page-delete-confirm" disabled={deleting} onClick={() => void remove(confirming)}>{t("whiteboard.deleteDo")}</button></>}>
          <p>{t("research.pages.deleteConfirm", { name: confirming.title || hostOf(confirming.url) })}</p>
        </Modal>
      ) : null}
    </section>
  );
}

type WebResult = { title: string; url: string; site: string | null; publishedAt: string | null; snippet: string | null; summary: string | null };

/**
 * Searching the web through the provider's search service (计划 4.5): the results with their site, date and summary; each can be fetched and saved as a page
 * of the project (the usual `webpage.fetch`) or opened in the browser. Without a search service the panel says how to add one.
 */
export function WebSearchPanel(props: {
  t: T;
  /** A search service is configured. */
  available: boolean;
  onOpenSettings?: () => void;
  onFetched: (outcome: FetchOutcome) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ query: string; truncated: boolean; results: WebResult[] } | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const guard = useAsyncGuard();

  async function search(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    const words = query.trim();
    if (!words || busy) return;
    const token = guard.next();
    setBusy(true);
    setProblem(null);
    const result = await attempt<{ query: string; truncated: boolean; results: WebResult[] }>("web.search", { query: words });
    if (!guard.isCurrent(token)) return;
    setBusy(false);
    if (!result.ok) { setProblem(webSearchProblem(t, result.error)); setAnswer(null); return; }
    setAnswer({ query: result.value.query, truncated: result.value.truncated, results: asArray<WebResult>(result.value.results) });
  }

  async function save(item: WebResult) {
    if (fetching !== null) return;
    setFetching(item.url);
    const result = await attempt<FetchOutcome>("webpage.fetch", { url: item.url });
    if (!guard.isAlive()) return;
    setFetching(null);
    if (!result.ok) {
      const reason = fetchReason(result.error);
      setProblem(reason ? t(reason.key as MessageKey, reason.params) : result.error.message || t("research.fetch.failed"));
      return;
    }
    props.onNotice(t("research.fetch.created", { title: result.value.page.title || hostOf(result.value.page.url) }));
    props.onFetched(result.value);
  }

  return (
    <section className="research-panel" data-testid="research-web" aria-labelledby="research-web-title">
      <h3 id="research-web-title">{t("research.web.title")}</h3>
      {!props.available ? (
        <p className="detail-muted" data-testid="research-web-missing">
          {t("research.web.missing")}{" "}
          {props.onOpenSettings ? <button type="button" className="link-button" data-testid="research-web-settings" onClick={props.onOpenSettings}>{t("research.web.settings")}</button> : null}
        </p>
      ) : (
        <>
          <form className="research-form" onSubmit={(event) => void search(event)}>
            <input type="search" data-testid="research-web-query" aria-label={t("research.web.label")} value={query} maxLength={2000} onChange={(event) => setQuery(event.target.value)} />
            <button type="submit" className="primary-button" data-testid="research-web-go" disabled={busy || !query.trim()}>{busy ? t("research.web.busy") : t("research.web.go")}</button>
          </form>
          {problem ? <p className="draft-warn-text" role="alert" data-testid="research-web-error">{problem}</p> : null}
          {answer?.truncated ? <p className="detail-muted" data-testid="research-web-truncated">{t("research.web.truncated", { query: answer.query })}</p> : null}
          {answer && !answer.results.length ? <p className="detail-muted" data-testid="research-web-empty">{t("research.web.empty")}</p> : null}
          <ul className="research-pages" data-testid="research-web-results">
            {(answer?.results ?? []).map((item) => (
              <li key={item.url} data-testid="research-web-result">
                <div className="research-web-result">
                  <strong>{item.title || hostOf(item.url)}</strong>
                  <small>{[item.site ?? hostOf(item.url), item.publishedAt?.slice(0, 10)].filter(Boolean).join(" · ")}</small>
                  {item.snippet || item.summary ? <p className="detail-muted">{item.snippet ?? item.summary}</p> : null}
                  <span className="msettings-actions">
                    <button type="button" className="secondary-button" data-testid="research-web-save" disabled={fetching !== null} onClick={() => void save(item)}>{fetching === item.url ? t("research.fetch.busy") : t("research.web.save")}</button>
                    <button type="button" className="link-button" data-testid="research-web-open" onClick={() => { void window.manga.openExternal?.(item.url); }}>{t("research.web.open")}</button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** What a failed search says, by kind (计划 4.5): the key, the balance, the rate limit, the service, the time. */
function webSearchProblem(t: T, error: { code: string; message: string; details?: unknown }): string {
  const details = (error.details ?? {}) as { status?: number; kind?: string; reason?: string };
  if (details.reason === "plugin_disabled") return t("models.plain.reason.provider");
  if (error.code === "AUTHENTICATION_FAILED" || details.status === 401 || details.status === 403) return t("models.plain.reason.auth");
  if (details.kind === "billing" || details.status === 402) return t("models.plain.reason.billing");
  if (error.code === "RATE_LIMITED" || details.status === 429) return t("research.web.rateLimited");
  if (details.kind === "timeout") return t("research.web.timeout");
  if (details.kind === "busy" || (details.status ?? 0) >= 500) return t("models.plain.reason.busy");
  return error.message;
}
