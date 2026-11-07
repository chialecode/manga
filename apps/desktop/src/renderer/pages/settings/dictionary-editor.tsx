import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../../lib/api.ts";
import { WorkPicker } from "../../components/work-picker.tsx";
import { SettingsEmpty } from "./rows.tsx";

type T = Translator["t"];
export type DictionaryTerm = { id: string; scope: "global" | "work"; workId: string | null; term: string; heard: string | null; source: string; auto: boolean };

/** `metadata:bangumi:character:123` → "character"; a hand-written term has no category. */
export function sourceCategory(source: string): string | null {
  const parts = source.split(":");
  return parts[0] === "metadata" && parts[2] ? parts[2] : null;
}

/**
 * The voice dictionary (A-66): the terms every recording is sent with, and the terms of one work. A term from a linked source says where it
 * came from; changing one makes it a hand-written term, which a refresh of the work's data then leaves alone.
 */
export function DictionaryEditor(props: { t: T; initialWorkId?: string | null; onChanged?: () => void; onWork?: (workId: string | null) => void; onError: (message: string) => void; onNotice: (message: string) => void }) {
  const { t } = props;
  const [scope, setScope] = useState<"global" | "work">(props.initialWorkId ? "work" : "global");
  const [workId, setWorkId] = useState<string | null>(props.initialWorkId ?? null);
  const [terms, setTerms] = useState<DictionaryTerm[] | null>(null);
  const [draft, setDraft] = useState({ term: "", heard: "" });
  const [editing, setEditing] = useState<{ id: string; term: string; heard: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Works whose entry was deleted and that still have terms: what was written for them is found here (A-87). */
  const [removed, setRemoved] = useState<Array<{ workId: string; title: string; terms: number }>>([]);
  const ready = scope === "global" || Boolean(workId);
  const { onWork } = props;
  useEffect(() => { onWork?.(scope === "work" ? workId : null); }, [scope, workId, onWork]);

  useEffect(() => {
    if (scope !== "work") return;
    let live = true;
    void attempt<{ works: Array<{ workId: string; title: string; terms: number }> }>("dictionary.removedWorks", {}).then((result) => { if (live && result.ok) setRemoved(asArray(result.value.works)); });
    return () => { live = false; };
  }, [scope, terms?.length]);

  const load = useCallback(async () => {
    if (!ready) { setTerms([]); return; }
    const result = await attempt<{ terms: DictionaryTerm[] }>("dictionary.list", scope === "global" ? { scope } : { scope, workId: workId! });
    if (result.ok) setTerms(asArray<DictionaryTerm>(result.value.terms));
    else props.onError(result.error.message);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, workId, ready]);
  useEffect(() => { setTerms(null); void load(); }, [load]);

  async function run(commandId: string, input: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    const result = await attempt(commandId, input);
    setBusy(false);
    if (!result.ok) { props.onError(result.error.message); return false; }
    await load();
    props.onChanged?.();
    return true;
  }

  async function add() {
    const term = draft.term.trim();
    if (!term || !ready) return;
    const done = await run("dictionary.add", { scope, ...(scope === "work" ? { workId } : {}), term, ...(draft.heard.trim() ? { heard: draft.heard.trim() } : {}) });
    if (done) setDraft({ term: "", heard: "" });
  }

  async function importFromSource() {
    if (!workId) return;
    setBusy(true);
    const result = await attempt<{ added: number; removed: number; kept: number; manualWins: number }>("dictionary.importMetadata", { workId });
    setBusy(false);
    if (!result.ok) {
      props.onError(result.error.code === "VALIDATION_ERROR" ? t("voice.dictionary.importUnlinked") : result.error.message);
      return;
    }
    props.onNotice(t("voice.dictionary.importDone", result.value));
    await load();
    props.onChanged?.();
  }

  async function saveEdit() {
    if (!editing || !editing.term.trim()) return;
    const done = await run("dictionary.update", { termId: editing.id, term: editing.term.trim(), heard: editing.heard.trim() || null });
    if (done) setEditing(null);
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
      {!ready ? <SettingsEmpty text={t("voice.dictionary.noWork")} testId="dictionary-no-work" /> : (
        <>
          <form className="dictionary-add" onSubmit={(event) => { event.preventDefault(); void add(); }}>
            <input data-testid="dictionary-term" aria-label={t("voice.dictionary.term")} placeholder={t("voice.dictionary.term")} maxLength={128} value={draft.term} onChange={(event) => setDraft({ ...draft, term: event.target.value })} />
            <input data-testid="dictionary-heard" aria-label={t("voice.dictionary.heard")} placeholder={t("voice.dictionary.heard")} maxLength={128} value={draft.heard} onChange={(event) => setDraft({ ...draft, heard: event.target.value })} />
            <button type="submit" className="primary-button" data-testid="dictionary-add" disabled={busy || !draft.term.trim()}>{t("voice.dictionary.add")}</button>
            {scope === "work" ? <button type="button" className="secondary-button" data-testid="dictionary-import" title={t("voice.dictionary.importHint")} disabled={busy} onClick={() => void importFromSource()}>{t("voice.dictionary.import")}</button> : null}
          </form>
          {terms === null ? null : terms.length === 0 ? <SettingsEmpty text={t("voice.dictionary.empty")} testId="dictionary-empty" /> : (
            <ul className="dictionary-list" data-testid="dictionary-list">
              {terms.map((item) => {
                const category = sourceCategory(item.source);
                const open = editing?.id === item.id;
                return (
                  <li key={item.id} data-testid={`dictionary-term-${item.id}`} data-auto={item.auto ? "true" : "false"}>
                    {open ? (
                      <form className="dictionary-edit" onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}>
                        <input data-testid="dictionary-edit-term" aria-label={t("voice.dictionary.term")} maxLength={128} value={editing.term} onChange={(event) => setEditing({ ...editing, term: event.target.value })} />
                        <input data-testid="dictionary-edit-heard" aria-label={t("voice.dictionary.heard")} maxLength={128} value={editing.heard} onChange={(event) => setEditing({ ...editing, heard: event.target.value })} />
                        <button type="submit" className="primary-button" data-testid="dictionary-edit-save" disabled={busy || !editing.term.trim()}>{t("voice.dictionary.save")}</button>
                        <button type="button" className="secondary-button" onClick={() => setEditing(null)}>{t("voice.dictionary.cancel")}</button>
                        {item.auto ? <span className="detail-muted">{t("voice.dictionary.editedManual")}</span> : null}
                      </form>
                    ) : (
                      <>
                        <strong>{item.term}</strong>
                        {item.heard ? <span className="detail-muted"> ← {item.heard}</span> : null}
                        <span className={`chip${item.auto ? " chip-info" : ""}`} data-testid={`dictionary-source-${item.id}`}>
                          {item.auto ? `${t("voice.dictionary.auto")}${category ? ` · ${t(`voice.dictionary.source.${category}` as "voice.dictionary.source.work")}` : ""}` : t("voice.dictionary.manual")}
                        </span>
                        <span className="dictionary-actions">
                          <button type="button" className="icon-button" aria-label={t("voice.dictionary.edit")} title={t("voice.dictionary.edit")} data-testid={`dictionary-edit-${item.id}`} onClick={() => setEditing({ id: item.id, term: item.term, heard: item.heard ?? "" })}><Pencil size={15} /></button>
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
