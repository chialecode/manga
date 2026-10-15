import { useEffect, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { CommandError, asArray, attempt } from "../../../lib/api.ts";
import { Modal } from "../../../components/modal.tsx";
import { formatClockMs } from "../../../readers/video-model.ts";
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

  async function search(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    const query = text.trim();
    if (!query || !scopes.size || busy) return;
    setBusy(true);
    const result = await attempt<{ results: ResultItem[] }>("research.search", { text: query, projectId: props.projectId, ...(scopes.size < RESEARCH_SCOPES.length ? { scopes: RESEARCH_SCOPES.filter((scope) => scopes.has(scope)) } : {}) });
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
    if (!kind) return;
    const added = await attempt("project.addMaterial", { projectId: props.projectId, kind, targetId: kind === "resource" ? (result.resourceId ?? result.id) : result.id });
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
                    {result.startMs !== undefined ? <span className="detail-muted">{t("research.result.at", { time: formatClockMs(result.startMs).replace(/\.\d+$/, "") })}</span> : null}
                  </div>
                  <p className="research-snippet">{result.snippet}</p>
                  <div className="research-result-actions">
                    <button type="button" className="link-button" data-testid="research-result-open" onClick={() => open(result)}>{t("research.result.open")}</button>
                    {materialKindOf(result) ? (result.inProject
                      ? <span className="detail-muted" data-testid="research-result-in">{t("research.result.inProject")}</span>
                      : <button type="button" className="link-button" data-testid="research-result-add" onClick={() => void add(result)}>{t("research.result.add")}</button>) : null}
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

  useEffect(() => {
    let live = true;
    void attempt<{ pages: PageSummary[] }>("webpage.list", {}).then((result) => {
      if (!live) return;
      if (result.ok) setPages(asArray<PageSummary>(result.value.pages)); else { setPages([]); props.onError(result.error.message); }
    });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.version]);

  async function fetchIt(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    const address = url.trim();
    if (!address || busy) return;
    setBusy(true);
    setProblem(null);
    const result = await attempt<FetchOutcome>("webpage.fetch", { url: address });
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
    setConfirming(null);
    const result = await attempt("webpage.delete", { pageId: page.id });
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
        <Modal title={t("research.pages.delete")} closeLabel={t("whiteboard.cancel")} onClose={() => setConfirming(null)} testId="research-page-delete-dialog"
          footer={<><button type="button" onClick={() => setConfirming(null)}>{t("whiteboard.cancel")}</button><button type="button" className="danger-button" data-testid="research-page-delete-confirm" onClick={() => void remove(confirming)}>{t("whiteboard.deleteDo")}</button></>}>
          <p>{t("research.pages.deleteConfirm", { name: confirming.title || hostOf(confirming.url) })}</p>
        </Modal>
      ) : null}
    </section>
  );
}
