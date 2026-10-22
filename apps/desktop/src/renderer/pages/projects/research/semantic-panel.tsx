import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { attempt } from "../../../lib/api.ts";
import { SEMANTIC_KINDS, scorePercent, searchStateKey, type SemanticHitView, type SemanticKind, type SemanticSearchView } from "../../../lib/semantic-model.ts";
import { formatClockMs } from "../../../readers/video-model.ts";

type T = Translator["t"];

/**
 * Searching by meaning in a project's research tab: a sentence goes to the semantic index and passages of the person's own material that say
 * something close come back, nearest first, each with where it is and a way to open it there. When the index cannot answer (off, still being
 * built, out of date) the panel says why instead of showing an empty list.
 */
export function SemanticPanel(props: {
  t: T;
  /** The project the search can be narrowed to; none in "最近", where the search covers all of the person's material. */
  projectId: string | null;
  onOpen: (hit: SemanticHitView) => void;
  onOpenSettings?: () => void;
  onError: (message: string) => void;
}) {
  const { t } = props;
  const [text, setText] = useState("");
  const [kinds, setKinds] = useState<ReadonlySet<SemanticKind>>(new Set(SEMANTIC_KINDS));
  const [inProject, setInProject] = useState(Boolean(props.projectId));
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ text: string; search: SemanticSearchView } | null>(null);
  const latest = useRef(0);

  async function search(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    const query = text.trim();
    if (!query || !kinds.size || busy) return;
    setBusy(true);
    latest.current += 1;
    const mine = latest.current;
    const result = await attempt<SemanticSearchView>("semantic.search", {
      text: query,
      ...(inProject && props.projectId ? { projectId: props.projectId } : {}),
      ...(kinds.size < SEMANTIC_KINDS.length ? { kinds: SEMANTIC_KINDS.filter((kind) => kinds.has(kind)) } : {}),
      ...(readOnly ? { withinProgress: true } : {}),
    });
    if (mine !== latest.current) return;
    setBusy(false);
    if (!result.ok) { props.onError(result.error.message); return; }
    setFound({ text: query, search: result.value });
  }

  function toggle(kind: SemanticKind) {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  }

  const search_ = found?.search;
  const stateKey = search_ ? searchStateKey(search_.state) : null;

  return (
    <section className="research-panel" data-testid="semantic-search" aria-labelledby="semantic-search-title">
      <h3 id="semantic-search-title">{t("semantic.search.title")}</h3>
      <p className="detail-muted">{t("semantic.search.hint")}</p>
      <form className="research-form" onSubmit={(event) => void search(event)}>
        <input type="search" data-testid="semantic-search-input" aria-label={t("semantic.search.label")} value={text} maxLength={1000} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="primary-button" data-testid="semantic-search-go" disabled={busy || !text.trim() || !kinds.size}><Sparkles size={15} aria-hidden="true" /> {t("semantic.search.go")}</button>
      </form>
      <fieldset className="research-scopes" aria-label={t("semantic.search.kinds")}>
        {SEMANTIC_KINDS.map((kind) => (
          <label key={kind} className="chip-check">
            <input type="checkbox" data-testid={`semantic-kind-${kind}`} checked={kinds.has(kind)} onChange={() => toggle(kind)} />
            <span>{t(`semantic.kind.${kind}` as MessageKey)}</span>
          </label>
        ))}
        {props.projectId ? (
          <label className="chip-check">
            <input type="checkbox" data-testid="semantic-in-project" checked={inProject} onChange={(event) => setInProject(event.target.checked)} />
            <span>{t("semantic.search.inProject")}</span>
          </label>
        ) : null}
        <label className="chip-check">
          <input type="checkbox" data-testid="semantic-progress" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} />
          <span>{t("semantic.search.progress")}</span>
        </label>
      </fieldset>
      {stateKey ? (
        <div className="draft-warn" role="status" data-testid="semantic-state" data-state={search_!.state}>
          <p className="draft-warn-text">{t(stateKey)}</p>
          {props.onOpenSettings ? <button type="button" className="link-button" data-testid="semantic-open-settings" onClick={props.onOpenSettings}>{t("semantic.search.openSettings")}</button> : null}
        </div>
      ) : null}
      {search_ && !stateKey ? (
        search_.results.length ? (
          <>
            <p className="detail-muted" role="status" data-testid="semantic-count">{t("semantic.search.count", { n: search_.results.length })}</p>
            <ul className="research-results" data-testid="semantic-results">
              {search_.results.map((hit, index) => (
                <li key={`${hit.kind}:${index}`} data-testid={`semantic-result-${hit.kind}`} data-score={hit.score.toFixed(3)}>
                  <div className="research-result-head">
                    <span className="chip">{t(`semantic.kind.${hit.kind}` as MessageKey)}</span>
                    <strong>{hit.title}</strong>
                    {hit.startMs !== undefined ? <span className="detail-muted">{t("semantic.result.at", { time: formatClockMs(hit.startMs).replace(/\.\d+$/, "") })}</span> : null}
                    <span className="detail-muted" data-testid="semantic-score">{t("semantic.result.score", { pct: scorePercent(hit.score) })}</span>
                  </div>
                  <p className="research-snippet">{hit.text}</p>
                  <div className="research-result-actions">
                    <button type="button" className="link-button" data-testid="semantic-result-open" onClick={() => props.onOpen(hit)}>{t("semantic.result.open")}</button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : <p className="detail-muted" data-testid="semantic-none">{t("semantic.search.none")}</p>
      ) : null}
    </section>
  );
}
