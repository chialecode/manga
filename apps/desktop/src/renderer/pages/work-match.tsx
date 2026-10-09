import { useEffect, useRef, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Modal } from "../components/modal.tsx";
import { asArray, attempt } from "../lib/api.ts";
import type { WorkDetail } from "../lib/works.ts";
import { classifySearchInput, REF_FAILURE_MESSAGES } from "../../../../../packages/app-core/src/metadata/ref.ts";

type T = Translator["t"];

export type Candidate = {
  id: string;
  providerId: string;
  externalId: string;
  title: string;
  titleOriginal?: string;
  summary?: string;
  date?: string;
  platform?: string;
  subjectType: number;
  kindGuess: string | null;
  sourceUrl: string;
  state: string;
  image: { url: string; mediaType: string } | null;
  linkedElsewhere: string | null;
};

type Outcome = {
  searchId: string;
  results: Candidate[];
  failures: Array<{ providerId: string; code: string; message: string; retryable: boolean }>;
  partial: boolean;
  searchedAt: string;
};

type Mode = "fallback" | "multi";
type Value = string | number | string[] | null;

export type FieldPreview = {
  key: string;
  current: { value: Value; source: string | null; policy: string } | null;
  incoming: Value;
  status: "same" | "new" | "differs" | "remote-missing";
  protected: boolean;
  keepByDefault: boolean;
};

export type Preview = {
  workId: string;
  mode: "link" | "refresh";
  providerId: string;
  externalId: string;
  sourceUrl: string | null;
  entry: { title: string | null; titleOriginal: string | null; subjectType: number; episodes: number; related: number };
  kindMismatch: { expected: string; actual: string | null; subjectType: number } | null;
  linkedElsewhere: string | null;
  alreadyLinked: boolean;
  replacesLink: string | null;
  fields: FieldPreview[];
  cover: { current: { coverId: string; source: string } | null; state: string; incoming: { url: string; mediaType: string } | null; protected: boolean; willReplace: boolean };
  warnings: string[];
};

type Resolved = {
  providerId: string;
  externalId: string;
  entry: { title: string; titleOriginal?: string; date?: string; platform?: string; subjectType: number; sourceUrl: string; summary?: string };
  image: { url: string; mediaType: string } | null;
  kindMismatch: { expected: string; actual: string | null; subjectType: number } | null;
  linkedElsewhere: string | null;
  alreadyLinked: boolean;
};

const PROVIDER_NAME: Record<string, string> = { bangumi: "Bangumi", "local-file": "local-file" };
export const providerName = (id: string): string => PROVIDER_NAME[id] ?? id;

const show = (value: Value | undefined): string => (Array.isArray(value) ? value.join("、") : value === null || value === undefined ? "" : String(value));

/** Why a reference was refused. A badly formed reference comes back from the main process with its reason already in words. */
export function refFailureText(t: T, error: { code: string; message: string; details?: unknown }): string {
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  if (error.code === "NOT_FOUND") return t("match.ref.notFound");
  if (error.code === "VALIDATION_ERROR" && reason) return error.message;
  if (error.code === "CAPABILITY_UNAVAILABLE") return t("match.off");
  if (error.code === "PROVIDER_UNAVAILABLE" || error.code === "RATE_LIMITED") return t("match.offline");
  return t("match.ref.failed", { message: error.message });
}

/**
 * Matching a work with an online entry (A-51, A-62). One box takes a name, an entry number or an entry link: a name is searched, a
 * number gives the entry with that number and the search by that text (a title can be a number), a link or `subject/<number>`
 * names the entry. Before anything is written the dialog shows what would change, field by field and the cover, and the user keeps
 * the local value wherever they want. Nothing is linked or refreshed until "confirm"; closing the dialog writes nothing.
 */
export function MatchDialog(props: {
  t: T;
  detail: WorkDetail;
  /** Start straight at the preview of the entry the work is linked to (refresh). */
  refresh?: boolean;
  formatDate: (value: string | Date) => string;
  onClose: () => void;
  onApplied: (message: string) => void;
  onOpenExternal: (url: string) => void;
  onError: (message: string) => void;
}) {
  const { t, detail } = props;
  const linked = detail.linkedSource ?? null;
  const [query, setQuery] = useState(detail.suggestedQuery ?? detail.title);
  const [mode, setMode] = useState<Mode>("fallback");
  const [state, setState] = useState<"idle" | "searching" | "done" | "failed">("idle");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The entry a number, path or link names, looked up directly; shown above the name search results.
  const [direct, setDirect] = useState<{ state: "looking" | "found" | "failed"; externalId: string; value?: Resolved; error?: string } | null>(null);
  const [searchedName, setSearchedName] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [keepCover, setKeepCover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [candidateId, setCandidateId] = useState<string | undefined>();
  const composing = useRef(false);
  const alive = useRef(true);
  const token = useRef(0);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Candidates kept from an earlier "find missing" run are shown before the user searches.
  useEffect(() => {
    if (linked || props.refresh) return;
    let cancelled = false;
    void attempt<{ candidates: Candidate[] }>("metadata.candidates", { workId: detail.id }).then((result) => {
      if (cancelled || !result.ok) return;
      const open = asArray<Candidate>(result.value.candidates).filter((candidate) => candidate.state === "open");
      if (open.length) setOutcome({ searchId: "", results: open, failures: [], partial: false, searchedAt: "" });
    });
    return () => { cancelled = true; };
  }, [detail.id, linked, props.refresh]);

  async function showPreview(providerId: string, externalId: string, candidate?: string) {
    setPreviewing(true);
    setCandidateId(candidate);
    const result = await attempt<Preview>("metadata.preview", { workId: detail.id, providerId: providerId as "bangumi", externalId });
    if (!alive.current) return;
    setPreviewing(false);
    if (!result.ok) { props.onError(refFailureText(t, result.error)); return; }
    setPreview(result.value);
    // Fields the user already owns, and ones the source left out, start as kept: the dialog never offers to overwrite them silently.
    setKeep(new Set(result.value.fields.filter((field) => field.keepByDefault).map((field) => field.key)));
    setKeepCover(result.value.cover.protected);
  }

  useEffect(() => {
    if (props.refresh && linked) void showPreview(linked.providerId, linked.externalId);
    // The preview for a refresh is requested once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The entry with this number, looked up directly. A failure here never hides the name search that runs beside it. */
  async function lookupEntry(text: string, externalId: string, mine: number) {
    setDirect({ state: "looking", externalId });
    const result = await attempt<Resolved>("metadata.resolveRef", { ref: text, workId: detail.id });
    if (!alive.current || mine !== token.current) return;
    setDirect(result.ok ? { state: "found", externalId, value: result.value } : { state: "failed", externalId, error: refFailureText(t, result.error) });
  }

  async function searchByName(text: string, mine: number) {
    setState("searching");
    setFailure(null);
    setSearchedName(text);
    const result = await attempt<Outcome>("metadata.search", { workId: detail.id, query: text, kind: detail.mediaKind === "novel" || detail.mediaKind === "comic" || detail.mediaKind === "video" ? detail.mediaKind : undefined, mode, limit: 12 });
    if (!alive.current || mine !== token.current) return;
    if (!result.ok) {
      // A failure is not an empty result: the user is told which, and the cached data stays on screen.
      setState("failed");
      setFailure(result.error.code === "CAPABILITY_UNAVAILABLE" ? t("match.off") : result.error.code === "PROVIDER_UNAVAILABLE" || result.error.code === "RATE_LIMITED" ? t("match.offline") : t("match.failed", { message: result.error.message }));
      return;
    }
    setOutcome(result.value);
    setState("done");
  }

  /** The one box: what it holds decides whether to search, look the entry up, or both (see `classifySearchInput`). */
  async function submit() {
    if (composing.current) return;
    const intent = classifySearchInput(query);
    if (intent.type === "empty") return;
    const mine = ++token.current;
    setDirect(null);
    if (intent.type === "refused") {
      setSearchedName(null);
      setState("idle");
      setOutcome(null);
      setDirect({ state: "failed", externalId: "", error: REF_FAILURE_MESSAGES[intent.reason] });
      return;
    }
    if (intent.type === "entry") {
      setSearchedName(null);
      setState("idle");
      setOutcome(null);
      await lookupEntry(query.trim(), intent.externalId, mine);
      return;
    }
    if (intent.type === "number") void lookupEntry(intent.externalId, intent.externalId, mine);
    await searchByName(intent.query, mine);
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    const common = { workId: detail.id, providerId: preview.providerId as "bangumi", keepFields: [...keep] as never[], ...(keepCover ? { keepCover: true } : {}) };
    const result = preview.mode === "refresh"
      ? await attempt("metadata.refresh", common)
      : await attempt("metadata.link", { ...common, externalId: preview.externalId, ...(candidateId ? { candidateId } : {}) });
    if (!alive.current) return;
    setBusy(false);
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onApplied(preview.mode === "refresh" ? t("match.refreshed") : t("match.linkedDone", { title: preview.entry.title ?? preview.externalId }));
  }

  const toggle = (key: string, checked: boolean) => setKeep((current) => { const next = new Set(current); if (checked) next.add(key); else next.delete(key); return next; });

  return (
    <Modal variant="dialog" testId="work-match" title={t("match.dialogTitle", { title: detail.title })} closeLabel={t("common.close")} onClose={props.onClose}>
      {preview ? (
        <section className="match-preview" data-testid="match-preview" data-mode={preview.mode}>
          <p><strong>{preview.entry.title ?? preview.externalId}</strong>{preview.entry.titleOriginal && preview.entry.titleOriginal !== preview.entry.title ? <span className="detail-muted"> · {preview.entry.titleOriginal}</span> : null}</p>
          <p className="detail-muted">{t("match.preview.intro", { provider: providerName(preview.providerId) })}</p>
          {preview.kindMismatch ? <p role="status" className="match-warn" data-testid="match-kind-mismatch">{t("match.kindMismatch")}</p> : null}
          {preview.linkedElsewhere ? <p role="status" className="match-warn" data-testid="match-elsewhere">{t("match.confirmElsewhere")}</p> : null}
          {preview.replacesLink ? <p role="status" className="match-warn" data-testid="match-replaces">{t("match.replacesLink")}</p> : null}
          {preview.warnings.map((warning) => <p key={warning} className="detail-muted">{warning}</p>)}
          <div className="match-table-wrap">
            <table className="match-table" data-testid="match-diff">
              <thead><tr><th>{t("match.col.field")}</th><th>{t("match.col.current")}</th><th>{t("match.col.incoming")}</th><th>{t("match.col.keep")}</th></tr></thead>
              <tbody>
                {preview.fields.filter((field) => field.status !== "same").map((field) => (
                  <tr key={field.key} data-testid={`match-field-${field.key}`} data-status={field.status} data-protected={field.protected ? "true" : "false"}>
                    <th scope="row">{t(`detail.field.${field.key}` as "detail.field.title")}</th>
                    <td>{show(field.current?.value) || t("detail.fieldEmpty")}{field.protected ? <span className="chip chip-muted">{t("match.protected")}</span> : null}</td>
                    <td>{field.status === "remote-missing" ? <span className="detail-muted">{t("match.remoteMissing")}</span> : show(field.incoming)}</td>
                    <td>
                      <label className="rp-check">
                        <input type="checkbox" data-testid={`match-keep-${field.key}`} checked={field.protected || field.status === "remote-missing" || keep.has(field.key)} disabled={field.protected || field.status === "remote-missing"} onChange={(event) => toggle(field.key, event.target.checked)} />
                        <span>{t("match.keepLocal")}</span>
                      </label>
                    </td>
                  </tr>
                ))}
                <tr data-testid="match-field-cover" data-protected={preview.cover.protected ? "true" : "false"}>
                  <th scope="row">{t("card.cover")}</th>
                  <td>{preview.cover.current ? t("match.cover.current", { source: preview.cover.current.source }) : t("detail.fieldEmpty")}{preview.cover.protected ? <span className="chip chip-muted">{t("match.protected")}</span> : null}</td>
                  <td>{preview.cover.incoming ? <img className="match-cover" src={preview.cover.incoming.url} alt="" width={48} /> : <span className="detail-muted">{t("match.remoteMissing")}</span>}</td>
                  <td>
                    <label className="rp-check">
                      <input type="checkbox" data-testid="match-keep-cover" checked={preview.cover.protected || keepCover || !preview.cover.willReplace} disabled={preview.cover.protected || !preview.cover.willReplace} onChange={(event) => setKeepCover(event.target.checked)} />
                      <span>{t("match.keepLocal")}</span>
                    </label>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {preview.fields.every((field) => field.status === "same") ? <p className="detail-muted" data-testid="match-nochange">{t("match.nochange")}</p> : null}
          <div className="match-actions">
            <button type="button" className="primary-button" data-testid="match-apply" disabled={busy} onClick={() => void apply()}>{preview.mode === "refresh" ? t("match.refresh") : t("match.confirm")}</button>
            <button type="button" className="secondary-button" data-testid="match-preview-back" disabled={busy} onClick={() => (props.refresh ? props.onClose() : setPreview(null))}>{props.refresh ? t("common.cancel") : t("match.back")}</button>
            {preview.sourceUrl ? <button type="button" className="link-button" onClick={() => props.onOpenExternal(preview.sourceUrl!)}>{t("match.openPage")}<ExternalLink size={12} /></button> : null}
          </div>
        </section>
      ) : (
        <section data-testid="match-choose">
          {previewing ? <p role="status" data-testid="match-previewing">{t("match.previewing")}</p> : null}
          <form className="match-search" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <label className="search-box">
              <Search size={14} />
              <input data-testid="match-query" value={query} placeholder={t("match.input.placeholder")} aria-label={t("match.input.label")} onChange={(event) => setQuery(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
            </label>
            <select data-testid="match-mode" aria-label={t("match.mode")} value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
              <option value="fallback">{t("match.mode.fallback")}</option>
              <option value="multi">{t("match.mode.multi")}</option>
            </select>
            <button type="submit" className="primary-button" data-testid="match-search" disabled={state === "searching" || direct?.state === "looking" || !query.trim()}>{t("match.search")}</button>
          </form>
          <p className="detail-muted" data-testid="match-input-hint">{t("match.input.hint")}</p>

          {direct?.state === "failed" ? <p role="alert" className="shelf-error" data-testid="match-direct-error">{direct.error}</p> : null}
          {direct?.state === "looking" ? <p role="status" data-testid="match-direct-looking">{t("match.searching")}</p> : null}
          {direct?.state === "found" && direct.value ? (
            <div className="match-row" data-testid="match-direct">
              <span className="match-thumb" aria-hidden="true">{direct.value.image ? <img src={direct.value.image.url} alt="" /> : null}</span>
              <span className="match-text">
                <span className="chip chip-muted" data-testid="match-direct-tag">{t("match.direct.tag", { id: direct.value.externalId })}</span>
                <strong>{direct.value.entry.title}</strong>
                {direct.value.entry.titleOriginal && direct.value.entry.titleOriginal !== direct.value.entry.title ? <span className="detail-muted"> · {direct.value.entry.titleOriginal}</span> : null}
                <span className="detail-muted">{[direct.value.entry.date, direct.value.entry.platform, providerName(direct.value.providerId)].filter(Boolean).join(" · ")}</span>
                {direct.value.kindMismatch ? <span className="match-warn" data-testid="match-direct-mismatch">{t("match.kindMismatch")}</span> : null}
                {direct.value.alreadyLinked ? <span className="chip chip-muted">{t("match.alreadyLinked")}</span> : null}
                {direct.value.linkedElsewhere ? <span className="chip chip-muted">{t("match.linkedElsewhere")}</span> : null}
              </span>
              <span className="match-buttons">
                <button type="button" className="primary-button" data-testid="match-direct-choose" disabled={previewing} onClick={() => void showPreview(direct.value!.providerId, direct.value!.externalId)}>{t("match.preview.show")}</button>
                {direct.value.entry.sourceUrl ? <button type="button" className="link-button" onClick={() => props.onOpenExternal(direct.value!.entry.sourceUrl)}>{t("match.openPage")}<ExternalLink size={12} /></button> : null}
              </span>
            </div>
          ) : null}

          {state === "searching" ? <p role="status" data-testid="match-searching">{t("match.searching")}</p> : null}
          {state === "failed" && failure ? <p role="alert" className="shelf-error" data-testid="match-failed">{failure}{linked ? ` ${t("match.cachedKept")}` : ""}</p> : null}
          {outcome && outcome.failures.length ? <p role="status" className="detail-muted" data-testid="match-partial">{t("match.partial", { sources: outcome.failures.map((item) => `${providerName(item.providerId)}（${item.message}）`).join("、") })}</p> : null}
          {outcome && outcome.results.length === 0 && state === "done" && outcome.failures.length === 0 ? <p data-testid="match-empty">{t("match.empty")}</p> : null}
          {direct && searchedName !== null && outcome && outcome.results.length ? <h4 className="match-by-name" data-testid="match-by-name">{t("match.byName", { query: searchedName })}</h4> : null}
          {outcome && outcome.results.length ? (
            <ul className="match-results" data-testid="match-results">
              {outcome.results.map((candidate) => (
                <li key={`${candidate.providerId}:${candidate.externalId}`} className="match-row" data-testid={`match-candidate-${candidate.externalId}`}>
                  <span className="match-thumb" aria-hidden="true">{candidate.image ? <img src={candidate.image.url} alt="" loading="lazy" /> : null}</span>
                  <span className="match-text">
                    <strong>{candidate.title}</strong>
                    {candidate.titleOriginal && candidate.titleOriginal !== candidate.title ? <span className="detail-muted"> · {candidate.titleOriginal}</span> : null}
                    <span className="detail-muted">{[candidate.date, candidate.platform, providerName(candidate.providerId)].filter(Boolean).join(" · ")}</span>
                    {candidate.summary ? <span className="match-summary">{candidate.summary}</span> : null}
                    {candidate.linkedElsewhere ? <span className="chip chip-muted">{t("match.linkedElsewhere")}</span> : null}
                  </span>
                  <span className="match-buttons">
                    <button type="button" className="primary-button" data-testid={`match-choose-${candidate.externalId}`} disabled={previewing} onClick={() => void showPreview(candidate.providerId, candidate.externalId, candidate.id || undefined)}>{t("match.choose")}</button>
                    {candidate.sourceUrl ? <button type="button" className="link-button" onClick={() => props.onOpenExternal(candidate.sourceUrl)}>{t("match.openPage")}<ExternalLink size={12} /></button> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
    </Modal>
  );
}

/**
 * The dialog for a work that is not on screen: the reader's "match" button and the import notice open it from anywhere. It loads the
 * work's own record first, and shows nothing until that has arrived.
 */
export function MatchHost(props: {
  t: T;
  workId: string;
  formatDate: (value: string | Date) => string;
  onClose: () => void;
  onApplied: (message: string) => void;
  onOpenExternal: (url: string) => void;
  onError: (message: string) => void;
}) {
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  useEffect(() => {
    let cancelled = false;
    void attempt<WorkDetail>("works.get", { workId: props.workId }).then((result) => {
      if (cancelled) return;
      if (result.ok) setDetail(result.value);
      else { props.onError(result.error.message); props.onClose(); }
    });
    return () => { cancelled = true; };
    // The record is loaded once for the work the dialog was opened for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workId]);
  if (!detail) return null;
  return <MatchDialog t={props.t} detail={detail} formatDate={props.formatDate} onClose={props.onClose} onApplied={props.onApplied} onOpenExternal={props.onOpenExternal} onError={props.onError} />;
}
