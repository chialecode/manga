import { useCallback, useEffect, useState } from "react";
import { Ban, Check, Pencil, Trash2 } from "lucide-react";
import {
  DICTIONARY_CATEGORIES,
  type DictionaryAliasKind,
  type DictionaryCategory,
  type DictionarySuggestionItem,
} from "@manga/contracts";
import type { MessageKey, Translator } from "@manga/i18n";
import { asArray, attempt } from "../../lib/api.ts";
import { WorkPicker } from "../../components/work-picker.tsx";
import { SettingsEmpty } from "./rows.tsx";

type T = Translator["t"];

export type DictionaryTerm = {
  id: string;
  scope: "global" | "work";
  workId: string | null;
  term: string;
  heard: string | null;
  source: string;
  auto: boolean;
  category?: DictionaryCategory | null;
  disabled?: boolean;
  blocked?: string[];
  aliases?: Array<{ alias: string; kind: DictionaryAliasKind }>;
};

/** `metadata:bangumi:character:123` -> "character"; a hand-written term uses its explicit category if set. */
export function sourceCategory(source: string): string | null {
  const parts = source.split(":");
  return parts[0] === "metadata" && parts[2] ? parts[2] : null;
}

function parseCommaList(raw: string): string[] {
  return raw
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function categoryLabel(t: T, category: DictionaryCategory): string {
  return t(`voice.dictionary.category.${category}` as MessageKey);
}

/**
 * The voice dictionary (A-66, X1, H1): global and per-work terms, aliases, categories, disabled toggle, blocked forms,
 * batch import, Bangumi detail enrichment with cancellation, and learned-from-edit suggestions.
 */
export function DictionaryEditor(props: {
  t: T;
  initialWorkId?: string | null;
  onChanged?: () => void;
  onWork?: (workId: string | null) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [scope, setScope] = useState<"global" | "work">(props.initialWorkId ? "work" : "global");
  const [workId, setWorkId] = useState<string | null>(props.initialWorkId ?? null);
  const [terms, setTerms] = useState<DictionaryTerm[] | null>(null);
  const [suggestions, setSuggestions] = useState<DictionarySuggestionItem[]>([]);
  const [draft, setDraft] = useState<{ term: string; heard: string; category: string; aliases: string; blocked: string }>({
    term: "",
    heard: "",
    category: "",
    aliases: "",
    blocked: "",
  });
  const [editing, setEditing] = useState<{
    id: string;
    term: string;
    heard: string;
    category: string;
    aliases: string;
    blocked: string;
    hadExtra: boolean;
  } | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchCategory, setBatchCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [enriching, setEnriching] = useState<{ done: number; total: number } | null>(null);
  const [removed, setRemoved] = useState<Array<{ workId: string; title: string; terms: number }>>([]);
  const ready = scope === "global" || Boolean(workId);
  const { onWork } = props;

  useEffect(() => {
    onWork?.(scope === "work" ? workId : null);
  }, [scope, workId, onWork]);

  useEffect(() => {
    if (scope !== "work") return;
    let live = true;
    void attempt<{ works: Array<{ workId: string; title: string; terms: number }> }>("dictionary.removedWorks", {}).then((result) => {
      if (live && result.ok) setRemoved(asArray(result.value.works));
    });
    return () => { live = false; };
  }, [scope, terms?.length]);

  const loadSuggestions = useCallback(async () => {
    const result = await attempt<{ suggestions?: DictionarySuggestionItem[]; items?: DictionarySuggestionItem[] } | DictionarySuggestionItem[]>(
      "dictionary.suggestions.list",
      scope === "work" && workId ? { workId, status: "pending" } : { status: "pending" },
    );
    if (result.ok) {
      const list = Array.isArray(result.value) ? result.value : (result.value.suggestions ?? result.value.items);
      setSuggestions(asArray<DictionarySuggestionItem>(list));
    }
  }, [scope, workId]);

  const load = useCallback(async () => {
    if (!ready) {
      setTerms([]);
      setSuggestions([]);
      return;
    }
    const result = await attempt<{ terms: DictionaryTerm[] }>("dictionary.list", scope === "global" ? { scope } : { scope, workId: workId! });
    if (result.ok) setTerms(asArray<DictionaryTerm>(result.value.terms));
    else props.onError(result.error.message);
    void loadSuggestions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, workId, ready, loadSuggestions]);

  useEffect(() => {
    setTerms(null);
    void load();
  }, [load]);

  // Listen for Bangumi enrichment progress or suggestion updates.
  useEffect(() => {
    const off = window.manga?.onNotice?.((notice) => {
      if (notice.topic === "dictionary.importProgress") {
        const targetWork = typeof notice.payload.workId === "string" ? notice.payload.workId : null;
        if (!targetWork || targetWork === workId) {
          const done = Number(notice.payload.done ?? notice.payload.completed ?? 0);
          const total = Number(notice.payload.total ?? 0);
          setEnriching(total > 0 && done < total ? { done, total } : null);
        }
      }
      if (notice.topic === "dictionary.changed") {
        void load();
      }
    });
    return () => { off?.(); };
  }, [load, workId]);

  async function run(commandId: string, input: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    const result = await attempt(commandId, input);
    setBusy(false);
    if (!result.ok) {
      props.onError(result.error.message);
      return false;
    }
    await load();
    props.onChanged?.();
    return true;
  }

  async function add() {
    const term = draft.term.trim();
    if (!term || !ready) return;
    const aliases = parseCommaList(draft.aliases).map((alias) => ({ alias, kind: "alias" as const }));
    const blocked = parseCommaList(draft.blocked);
    const input: Record<string, unknown> = {
      scope,
      ...(scope === "work" ? { workId } : {}),
      term,
      ...(draft.heard.trim() ? { heard: draft.heard.trim() } : {}),
      ...(draft.category ? { category: draft.category } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(blocked.length > 0 ? { blocked } : {}),
    };
    const done = await run("dictionary.add", input);
    if (done) setDraft({ term: "", heard: "", category: "", aliases: "", blocked: "" });
  }

  async function importFromSource(options?: { enrichDetails?: boolean; refresh?: boolean }) {
    if (!workId) return;
    setBusy(true);
    if (options?.enrichDetails) setEnriching({ done: 0, total: 1 });
    const input: Record<string, unknown> = {
      workId,
      ...(options?.enrichDetails ? { enrichDetails: true } : {}),
      ...(options?.refresh ? { refresh: true } : {}),
    };
    const result = await attempt<{ added: number; removed: number; kept: number; manualWins: number }>("dictionary.importMetadata", input);
    setBusy(false);
    setEnriching(null);
    if (!result.ok) {
      props.onError(result.error.code === "VALIDATION_ERROR" ? t("voice.dictionary.importUnlinked") : result.error.message);
      return;
    }
    props.onNotice(t("voice.dictionary.importDone", result.value));
    await load();
    props.onChanged?.();
  }

  async function cancelEnrich() {
    if (!workId) return;
    await attempt("dictionary.cancelImportMetadata", { workId });
    setEnriching(null);
  }

  async function submitBatch() {
    const text = batchText.trim();
    if (!text || !ready) return;
    setBusy(true);
    const result = await attempt<{ added?: number; skipped?: number }>("dictionary.importBatch", {
      scope,
      ...(scope === "work" && workId ? { workId } : {}),
      text,
      ...(batchCategory ? { category: batchCategory } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      props.onError(result.error.message);
      return;
    }
    const added = Number(result.value.added ?? 0);
    const skipped = Number(result.value.skipped ?? 0);
    props.onNotice(t("voice.dictionary.batchDone", { added, skipped }));
    setBatchText("");
    setBatchOpen(false);
    await load();
    props.onChanged?.();
  }

  async function saveEdit() {
    if (!editing || !editing.term.trim()) return;
    const aliases = parseCommaList(editing.aliases).map((alias) => ({ alias, kind: "alias" as const }));
    const blocked = parseCommaList(editing.blocked);
    const includeExtra = editing.hadExtra || Boolean(editing.category) || aliases.length > 0 || blocked.length > 0;
    const input: Record<string, unknown> = {
      termId: editing.id,
      term: editing.term.trim(),
      heard: editing.heard.trim() || null,
      ...(includeExtra
        ? {
          ...(editing.category ? { category: editing.category } : {}),
          aliases,
          blocked,
        }
        : {}),
    };
    const done = await run("dictionary.update", input);
    if (done) setEditing(null);
  }

  async function decideSuggestion(suggestionId: string, action: "accept" | "ignore") {
    const result = await attempt("dictionary.suggestions.decide", { suggestionId, action });
    if (!result.ok) {
      props.onError(result.error.message);
      return;
    }
    await load();
    props.onChanged?.();
  }

  return (
    <div className="dictionary-editor" data-testid="dictionary-editor">
      <div className="dictionary-scope" role="group" aria-label={t("voice.dictionary")}>
        <button type="button" className="secondary-button" aria-pressed={scope === "global"} data-testid="dictionary-scope-global" onClick={() => setScope("global")}>{t("voice.dictionary.global")}</button>
        <button type="button" className="secondary-button" aria-pressed={scope === "work"} data-testid="dictionary-scope-work" onClick={() => setScope("work")}>{t("voice.dictionary.work")}</button>
        {scope === "work" ? <WorkPicker t={t} value={workId} onChange={setWorkId} label={t("voice.dictionary.pickWork")} placeholder={t("voice.dictionary.pickWork")} testId="dictionary-work" /> : null}
        {scope === "work" && removed.length ? (
          <select aria-label={t("voice.dictionary.removedWorks")} data-testid="dictionary-removed" value={removed.some((item) => item.workId === workId) ? workId ?? "" : ""} onChange={(event) => setWorkId(event.target.value || null)}>
            <option value="">{t("voice.dictionary.removedWorks")}</option>
            {removed.map((item) => <option key={item.workId} value={item.workId}>{t("voice.dictionary.removedOption", { title: item.title, count: item.terms })}</option>)}
          </select>
        ) : null}
      </div>

      {suggestions.length > 0 ? (
        <div className="dictionary-suggestions" data-testid="dictionary-suggestions">
          <strong>{t("voice.dictionary.suggestionsTitle")}</strong>
          <ul className="msettings-list">
            {suggestions.map((item) => (
              <li key={item.id} className="msettings-row" data-testid={`dictionary-suggestion-${item.id}`}>
                <span>{t("voice.dictionary.suggestionRow", { heard: item.heard, term: item.term })}</span>
                <span className="msettings-actions">
                  <button type="button" className="secondary-button" data-testid={`dictionary-suggestion-accept-${item.id}`} onClick={() => void decideSuggestion(item.id, "accept")}>{t("voice.dictionary.suggestionAccept")}</button>
                  <button type="button" className="link-button" data-testid={`dictionary-suggestion-ignore-${item.id}`} onClick={() => void decideSuggestion(item.id, "ignore")}>{t("voice.dictionary.suggestionIgnore")}</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!ready ? <SettingsEmpty text={t("voice.dictionary.noWork")} testId="dictionary-no-work" /> : (
        <>
          <form className="dictionary-add" onSubmit={(event) => { event.preventDefault(); void add(); }}>
            <input data-testid="dictionary-term" aria-label={t("voice.dictionary.term")} placeholder={t("voice.dictionary.term")} maxLength={128} value={draft.term} onChange={(event) => setDraft({ ...draft, term: event.target.value })} />
            <input data-testid="dictionary-heard" aria-label={t("voice.dictionary.heard")} placeholder={t("voice.dictionary.heard")} maxLength={128} value={draft.heard} onChange={(event) => setDraft({ ...draft, heard: event.target.value })} />
            <button type="submit" className="primary-button" data-testid="dictionary-add" disabled={busy || !draft.term.trim()}>{t("voice.dictionary.add")}</button>
            <button type="button" className="secondary-button" data-testid="dictionary-batch-toggle" aria-expanded={batchOpen} onClick={() => setBatchOpen((open) => !open)}>{t("voice.dictionary.batchToggle")}</button>
            {scope === "work" ? (
              <>
                <button type="button" className="secondary-button" data-testid="dictionary-import" title={t("voice.dictionary.importHint")} disabled={busy} onClick={() => void importFromSource()}>{t("voice.dictionary.import")}</button>
                <button type="button" className="secondary-button" data-testid="dictionary-import-enrich" disabled={busy} onClick={() => void importFromSource({ enrichDetails: true })}>{t("voice.dictionary.enrich")}</button>
                <button type="button" className="secondary-button" data-testid="dictionary-import-refresh" disabled={busy} onClick={() => void importFromSource({ enrichDetails: true, refresh: true })}>{t("voice.dictionary.refresh")}</button>
              </>
            ) : null}
            <div className="dictionary-extra">
              <select aria-label={t("voice.dictionary.category")} data-testid="dictionary-category" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
                <option value="">{t("voice.dictionary.category.none")}</option>
                {DICTIONARY_CATEGORIES.map((cat) => <option key={cat} value={cat}>{categoryLabel(t, cat)}</option>)}
              </select>
              <input data-testid="dictionary-aliases" aria-label={t("voice.dictionary.aliases")} placeholder={t("voice.dictionary.aliases")} value={draft.aliases} onChange={(event) => setDraft({ ...draft, aliases: event.target.value })} />
              <input data-testid="dictionary-blocked" aria-label={t("voice.dictionary.blocked")} placeholder={t("voice.dictionary.blocked")} value={draft.blocked} onChange={(event) => setDraft({ ...draft, blocked: event.target.value })} />
            </div>
          </form>

          {enriching ? (
            <div className="msettings-actions" role="status" data-testid="dictionary-import-progress">
              <span className="detail-muted">{t("voice.dictionary.importProgress", { done: enriching.done, total: enriching.total })}</span>
              <button type="button" className="secondary-button" data-testid="dictionary-import-cancel" onClick={() => void cancelEnrich()}>{t("voice.dictionary.cancelImport")}</button>
            </div>
          ) : null}

          {batchOpen ? (
            <div className="dictionary-batch msettings-subgroup" data-testid="dictionary-batch">
              <p className="detail-muted">{t("voice.dictionary.batchHint")}</p>
              <textarea
                data-testid="dictionary-batch-text"
                aria-label={t("voice.dictionary.batchToggle")}
                placeholder={t("voice.dictionary.batchPlaceholder")}
                value={batchText}
                onChange={(event) => setBatchText(event.target.value)}
              />
              <div className="msettings-actions">
                <select aria-label={t("voice.dictionary.category")} data-testid="dictionary-batch-category" value={batchCategory} onChange={(event) => setBatchCategory(event.target.value)}>
                  <option value="">{t("voice.dictionary.category.none")}</option>
                  {DICTIONARY_CATEGORIES.map((cat) => <option key={cat} value={cat}>{categoryLabel(t, cat)}</option>)}
                </select>
                <button type="button" className="primary-button" data-testid="dictionary-batch-submit" disabled={busy || !batchText.trim()} onClick={() => void submitBatch()}>{t("voice.dictionary.batchSubmit")}</button>
                <button type="button" className="secondary-button" onClick={() => setBatchOpen(false)}>{t("voice.dictionary.cancel")}</button>
              </div>
            </div>
          ) : null}

          {terms === null ? null : terms.length === 0 ? <SettingsEmpty text={t("voice.dictionary.empty")} testId="dictionary-empty" /> : (
            <ul className="dictionary-list" data-testid="dictionary-list">
              {terms.map((item) => {
                const srcCategory = sourceCategory(item.source);
                const open = editing?.id === item.id;
                const aliasList = asArray<{ alias: string; kind: DictionaryAliasKind }>(item.aliases).map((entry) => entry.alias);
                const blockedList = asArray<string>(item.blocked);
                const isDisabled = item.disabled === true;
                return (
                  <li key={item.id} data-testid={`dictionary-term-${item.id}`} data-auto={item.auto ? "true" : "false"} data-disabled={isDisabled ? "true" : "false"}>
                    {open ? (
                      <form className="dictionary-edit" onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}>
                        <input data-testid="dictionary-edit-term" aria-label={t("voice.dictionary.term")} maxLength={128} value={editing.term} onChange={(event) => setEditing({ ...editing, term: event.target.value })} />
                        <input data-testid="dictionary-edit-heard" aria-label={t("voice.dictionary.heard")} maxLength={128} value={editing.heard} onChange={(event) => setEditing({ ...editing, heard: event.target.value })} />
                        <select aria-label={t("voice.dictionary.category")} data-testid="dictionary-edit-category" value={editing.category} onChange={(event) => setEditing({ ...editing, category: event.target.value })}>
                          <option value="">{t("voice.dictionary.category.none")}</option>
                          {DICTIONARY_CATEGORIES.map((cat) => <option key={cat} value={cat}>{categoryLabel(t, cat)}</option>)}
                        </select>
                        <input data-testid="dictionary-edit-aliases" aria-label={t("voice.dictionary.aliases")} placeholder={t("voice.dictionary.aliases")} value={editing.aliases} onChange={(event) => setEditing({ ...editing, aliases: event.target.value })} />
                        <input data-testid="dictionary-edit-blocked" aria-label={t("voice.dictionary.blocked")} placeholder={t("voice.dictionary.blocked")} value={editing.blocked} onChange={(event) => setEditing({ ...editing, blocked: event.target.value })} />
                        <button type="submit" className="primary-button" data-testid="dictionary-edit-save" disabled={busy || !editing.term.trim()}>{t("voice.dictionary.save")}</button>
                        <button type="button" className="secondary-button" onClick={() => setEditing(null)}>{t("voice.dictionary.cancel")}</button>
                        {item.auto ? <span className="detail-muted">{t("voice.dictionary.editedManual")}</span> : null}
                      </form>
                    ) : (
                      <>
                        <strong>{item.term}</strong>
                        {item.heard ? <span className="detail-muted">{` ← ${item.heard}`}</span> : null}
                        {aliasList.length > 0 ? <span className="detail-muted" data-testid={`dictionary-aliases-${item.id}`}>{` · ${aliasList.join(", ")}`}</span> : null}
                        {blockedList.length > 0 ? <span className="chip" data-testid={`dictionary-blocked-${item.id}`}>{t("voice.dictionary.blockedBadge", { list: blockedList.join(", ") })}</span> : null}
                        {item.category && !srcCategory ? <span className="chip">{categoryLabel(t, item.category)}</span> : null}
                        {isDisabled ? <span className="chip" data-testid={`dictionary-disabled-${item.id}`}>{t("voice.dictionary.disabledBadge")}</span> : null}
                        <span className={`chip${item.auto ? " chip-info" : ""}`} data-testid={`dictionary-source-${item.id}`}>
                          {item.auto ? `${t("voice.dictionary.auto")}${srcCategory ? ` · ${t(`voice.dictionary.source.${srcCategory}` as "voice.dictionary.source.work")}` : ""}` : t("voice.dictionary.manual")}
                        </span>
                        <span className="dictionary-actions">
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={isDisabled ? t("voice.dictionary.enable") : t("voice.dictionary.disable")}
                            title={isDisabled ? t("voice.dictionary.enable") : t("voice.dictionary.disable")}
                            data-testid={`dictionary-toggle-${item.id}`}
                            disabled={busy}
                            onClick={() => void run("dictionary.update", { termId: item.id, disabled: !isDisabled })}
                          >
                            {isDisabled ? <Check size={15} /> : <Ban size={15} />}
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={t("voice.dictionary.edit")}
                            title={t("voice.dictionary.edit")}
                            data-testid={`dictionary-edit-${item.id}`}
                            onClick={() => setEditing({
                              id: item.id,
                              term: item.term,
                              heard: item.heard ?? "",
                              category: item.category ?? "",
                              aliases: aliasList.join(", "),
                              blocked: blockedList.join(", "),
                              hadExtra: Boolean(item.category) || aliasList.length > 0 || blockedList.length > 0,
                            })}
                          >
                            <Pencil size={15} />
                          </button>
                          <button type="button" className="icon-button" aria-label={t("voice.dictionary.remove")} title={t("voice.dictionary.remove")} data-testid={`dictionary-remove-${item.id}`} disabled={busy} onClick={() => void run("dictionary.remove", { termId: item.id })}><Trash2 size={15} /></button>
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
