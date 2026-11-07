import { useEffect, useMemo, useState } from "react";
import type { Translator } from "@manga/i18n";
import type { DraftSuggestionKind } from "@manga/contracts/copy";
import { asArray, attempt, type CommandError } from "../../../lib/api.ts";
import { DiffText } from "./diff-text.tsx";
import { QUOTABLE_KINDS, SUGGEST_KINDS, type DraftDoc, type Range, type SuggestionDetail, type SuggestionItem } from "./draft-model.ts";

type T = Translator["t"];
type Candidate = { kind: string; id: string; label: string; state: string };

/** The friendly wording of a refusal; anything unexpected shows the message the app gave. */
export function suggestError(t: T, error: CommandError): string {
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  const known: Record<string, Parameters<T>[0]> = { noTextModel: "draft.suggest.noModel", noSources: "draft.suggest.needSources", noTerms: "draft.suggest.noTerms", busy: "draft.suggest.busy" };
  return reason && known[reason] ? t(known[reason]) : t("draft.suggest.failed", { message: error.message });
}

/** Ask for a suggestion: what to do, any extra wishes, the selected part of the text, and the material to quote. */
export function SuggestForm(props: { t: T; projectId: string; draftId: string; selection: Range | null; flush: () => Promise<boolean>; onStarted: (suggestion: SuggestionItem) => void; onError: (message: string) => void }) {
  const { t } = props;
  const [kind, setKind] = useState<DraftSuggestionKind>("continue");
  const [instruction, setInstruction] = useState("");
  const [language, setLanguage] = useState("");
  const [useSelection, setUseSelection] = useState(false);
  const [withTerms, setWithTerms] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [objects, setObjects] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void attempt<{ objects: Candidate[] }>("project.objects", { projectId: props.projectId }).then((result) => {
      if (live && result.ok) setObjects(asArray<Candidate>(result.value.objects).filter((item) => QUOTABLE_KINDS.has(item.kind) && item.state === "ok" && !(item.kind === "draft" && item.id === props.draftId)));
    });
    return () => { live = false; };
  }, [props.projectId, props.draftId]);

  const partOnly = kind === "polish" || kind === "translate" || kind === "terms";
  const quotes = useMemo(() => objects.map((item) => ({ ...item, key: `${item.kind}:${item.id}` })), [objects]);

  async function go() {
    setBusy(true);
    try {
      // What is on screen is what the suggestion is made from, so it is saved first.
      if (!(await props.flush())) return;
      const sources = [...picked].map((key) => { const [sourceKind, ...rest] = key.split(":"); return { kind: sourceKind, targetId: rest.join(":") }; });
      if (withTerms && kind !== "terms") sources.push({ kind: "terms", targetId: props.projectId });
      const result = await attempt<{ suggestion: SuggestionItem }>("draft.suggest", {
        draftId: props.draftId, kind,
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        ...(kind === "translate" && language.trim() ? { language: language.trim() } : {}),
        ...(sources.length ? { sources } : {}),
        ...(partOnly && useSelection && props.selection ? { range: props.selection } : {}),
      });
      if (!result.ok) { props.onError(suggestError(t, result.error)); return; }
      setInstruction("");
      props.onStarted(result.value.suggestion);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="draft-suggest" data-testid="suggest-form" onSubmit={(event) => { event.preventDefault(); void go(); }}>
      <h3>{t("draft.suggest.title")}</h3>
      <p className="detail-muted">{t("draft.suggest.hint")}</p>
      <label>{t("draft.suggest.kind")}
        <select data-testid="suggest-kind" value={kind} onChange={(event) => setKind(event.target.value as DraftSuggestionKind)}>
          {SUGGEST_KINDS.map((item) => <option key={item} value={item}>{t(`draft.kind.${item}` as never)}</option>)}
        </select>
      </label>
      {kind === "translate" ? (
        <label>{t("draft.suggest.language")}
          <input data-testid="suggest-language" value={language} placeholder={t("draft.suggest.languagePlaceholder")} maxLength={40} onChange={(event) => setLanguage(event.target.value)} />
        </label>
      ) : null}
      <label>{t("draft.suggest.instruction")}
        <input data-testid="suggest-instruction" value={instruction} maxLength={1000} onChange={(event) => setInstruction(event.target.value)} />
      </label>
      {partOnly ? (
        <label className="draft-check">
          <input type="checkbox" data-testid="suggest-selection" checked={useSelection && Boolean(props.selection)} disabled={!props.selection} onChange={(event) => setUseSelection(event.target.checked)} />
          {t("draft.suggest.selection")}{props.selection ? "" : ` ${t("draft.suggest.selectionNone")}`}
        </label>
      ) : null}
      <fieldset className="draft-sources">
        <legend>{t("draft.suggest.sources")}</legend>
        {quotes.length === 0 ? <p className="detail-muted">{t("draft.suggest.sourcesNone")}</p> : null}
        {quotes.map((item) => (
          <label key={item.key} className="draft-check">
            <input type="checkbox" data-testid={`suggest-source-${item.id}`} checked={picked.has(item.key)}
              onChange={(event) => setPicked((current) => { const next = new Set(current); if (event.target.checked) next.add(item.key); else next.delete(item.key); return next; })} />
            <span className="chip">{t(`whiteboard.ref.kind.${item.kind}` as never)}</span> {item.label}
          </label>
        ))}
        {kind !== "terms" ? (
          <label className="draft-check"><input type="checkbox" data-testid="suggest-terms" checked={withTerms} onChange={(event) => setWithTerms(event.target.checked)} /> {t("draft.suggest.withTerms")}</label>
        ) : null}
      </fieldset>
      <button type="submit" className="primary-button" data-testid="suggest-go" disabled={busy}>{t("draft.suggest.go")}</button>
    </form>
  );
}

export function SuggestionList(props: { t: T; formatDate: (iso: string) => string; items: SuggestionItem[]; onOpen: (id: string) => void }) {
  const { t } = props;
  return (
    <div className="draft-suggestions">
      <h3>{t("draft.suggestions")}</h3>
      {props.items.length === 0 ? <p className="detail-muted" data-testid="suggestions-empty">{t("draft.suggestions.empty")}</p> : null}
      <ul>
        {props.items.map((item) => (
          <li key={item.id}>
            <button type="button" data-testid={`suggestion-${item.id}`} data-status={item.status} onClick={() => props.onOpen(item.id)}>
              <span className="draft-s-head">
                <strong>{t(`draft.kind.${item.kind}` as never)}</strong>
                <span className="chip" data-testid={`suggestion-status-${item.id}`}>{t(`draft.status.${item.status}` as never)}</span>
                {item.stale ? <span className="chip draft-warn" data-testid={`suggestion-stale-${item.id}`}>{t("draft.stale")}</span> : null}
                {item.baseChanged ? <span className="chip draft-warn" data-testid={`suggestion-base-${item.id}`}>{t("draft.baseChanged")}</span> : null}
              </span>
              <span className="draft-s-preview">{item.status === "failed" ? item.error?.message : item.preview}</span>
              <small className="detail-muted">{props.formatDate(item.createdAt)}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One suggestion: what it quoted (original text, marked as such) apart from what the model wrote (marked as generated), the difference it
 * would make to the draft, and what to do with it. When its sources changed, the old and the new text are shown side by side.
 */
export function SuggestionView(props: {
  t: T; id: string; draft: DraftDoc; stamp: string;
  onBack: () => void; onChanged: () => Promise<void>; onDraft: (draft: DraftDoc) => void; onOpen: (id: string) => void; onError: (message: string) => void; flush: () => Promise<boolean>;
}) {
  const { t } = props;
  const [detail, setDetail] = useState<SuggestionDetail | null>(null);
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    let live = true;
    void attempt<{ suggestion: SuggestionDetail }>("draft.suggestion", { suggestionId: props.id }).then((result) => {
      if (!live) return;
      if (result.ok) setDetail(result.value.suggestion); else props.onError(result.error.message);
    });
    return () => { live = false; };
  }, [props.id, props.stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(commandId: string, input: Record<string, unknown>, after?: (value: Record<string, unknown>) => void) {
    const result = await attempt<Record<string, unknown>>(commandId, { suggestionId: props.id, ...input });
    if (!result.ok) { props.onError(result.error.message); return; }
    after?.(result.value);
    await props.onChanged();
  }
  /** The same suggestion made again from what the sources say now; it opens when it is under way. */
  async function redo() {
    if (!(await props.flush())) return;
    const result = await attempt<{ suggestion: SuggestionItem }>("draft.suggest", { draftId: props.draft.id, kind: detail?.kind, redoOf: props.id });
    if (!result.ok) { props.onError(suggestError(t, result.error)); return; }
    await props.onChanged();
    props.onOpen(result.value.suggestion.id);
  }
  async function adopt(force: boolean) {
    // The draft on the server must be what is on screen before a suggestion is laid over it.
    if (!(await props.flush())) return;
    await act("draft.adopt", force ? { force: true } : {}, (value) => props.onDraft(value.draft as DraftDoc));
  }

  if (!detail) return <div className="draft-detail" aria-busy="true" />;
  const open = detail.status === "pending";
  return (
    <div className="draft-detail" data-testid="suggestion-detail" data-status={detail.status}>
      <button type="button" className="link-button" data-testid="suggestion-back" onClick={props.onBack}>{t("draft.back")}</button>
      <h3>{t(`draft.kind.${detail.kind}` as never)} <span className="chip">{t(`draft.status.${detail.status}` as never)}</span></h3>
      <p className="detail-muted">
        {detail.by === "agent" ? <span data-testid="suggestion-by-agent">{t("draft.s.byAgent")}</span> : detail.model ? t("draft.s.model", { model: detail.model }) : null}{detail.range ? ` · ${t("draft.s.range")}` : ""}{detail.instruction ? ` · ${detail.instruction}` : ""}
      </p>
      {detail.status === "failed" ? <p role="alert" data-testid="suggestion-error">{t("draft.s.failed", { message: detail.error?.message ?? "" })}</p> : null}
      {detail.status === "running" ? <button type="button" data-testid="suggestion-cancel" onClick={() => void act("draft.cancelSuggestion", {})}>{t("draft.cancel")}</button> : null}

      {detail.stale ? (
        <section className="draft-stale" role="status" data-testid="suggestion-stale">
          <strong>{t("draft.s.staleTitle")}</strong>
          <p>{t("draft.s.staleHint")}</p>
          <div className="draft-actions">
            <button type="button" data-testid="stale-compare" aria-pressed={comparing} onClick={() => setComparing((value) => !value)}>{t("draft.s.compare")}</button>
            <button type="button" data-testid="stale-keep" onClick={() => void act("draft.keepSuggestion", {})}>{t("draft.s.keep")}</button>
            <button type="button" data-testid="stale-redo" onClick={() => void redo()}>{t("draft.s.redo")}</button>
          </div>
        </section>
      ) : null}

      {detail.quoted.length ? (
        <section className="draft-quoted" data-testid="suggestion-quoted">
          <h4>{t("draft.s.quoted")}</h4>
          <p className="detail-muted">{t("draft.s.quotedHint")}</p>
          {detail.sources.map((source) => (
            <figure key={`${source.kind}:${source.targetId}`} className="draft-quote" data-state={source.state}>
              <figcaption>
                <span className="chip">{t("draft.s.quotedTag")}</span> {source.label}
                {source.state !== "same" ? <span className="chip draft-warn" data-testid={`source-state-${source.targetId}`}>{t(`draft.s.source.${source.state}` as never)}</span> : null}
              </figcaption>
              <blockquote data-testid={`quote-${source.targetId}`}>{source.before}</blockquote>
              {comparing && source.state === "changed" && source.after !== null ? (
                <div className="draft-compare" data-testid={`compare-${source.targetId}`}>
                  <div><strong>{t("draft.s.before")}</strong><p>{source.before}</p></div>
                  <div><strong>{t("draft.s.after")}</strong><p>{source.after}</p></div>
                  <DiffText t={t} before={source.before} after={source.after} />
                </div>
              ) : null}
            </figure>
          ))}
        </section>
      ) : null}

      {detail.generated ? (
        <section className="draft-generated" data-testid="suggestion-generated">
          <h4>{t("draft.s.generated")} <span className="chip draft-generated-tag">{t("draft.s.generatedTag")}</span></h4>
          <div className="draft-generated-text" data-testid="generated-text">{detail.generated}</div>
        </section>
      ) : null}

      {detail.generated ? (
        <section data-testid="suggestion-diff">
          <h4>{t("draft.s.diff")}</h4>
          <DiffText t={t} before={detail.baseText} after={detail.resultText} testId="suggestion-diff-text" />
        </section>
      ) : null}

      {open && detail.baseChanged ? <p className="draft-warn-text" role="status" data-testid="suggestion-base-changed">{t("draft.s.baseChangedHint")}</p> : null}
      <div className="draft-actions">
        {open ? <button type="button" className="primary-button" data-testid="suggestion-adopt" onClick={() => void adopt(detail.baseChanged)}>{detail.baseChanged ? t("draft.s.adoptForce") : t("draft.s.adopt")}</button> : null}
        {detail.status === "adopted" ? <button type="button" data-testid="suggestion-undo" onClick={() => void act("draft.undoAdopt", {}, (value) => props.onDraft(value.draft as DraftDoc))}>{t("draft.s.undo")}</button> : null}
        {detail.status === "pending" || detail.status === "failed" || detail.status === "cancelled" ? <button type="button" data-testid="suggestion-discard" onClick={() => void act("draft.discardSuggestion", {}, () => props.onBack())}>{t("draft.s.discard")}</button> : null}
      </div>
      {detail.status === "adopted" ? <p className="detail-muted" data-testid="suggestion-adopted">{t("draft.s.adopted", { version: detail.adoptedVersion ?? props.draft.version })}</p> : null}
    </div>
  );
}
