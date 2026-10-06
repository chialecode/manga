import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { QUICK_NAME_MAX, QUICK_PAGES, QUICK_PLACEHOLDERS, QUICK_TEMPLATE_MAX, unknownPlaceholders, type QuickPage, type QuickTask } from "@manga/contracts/quick-tasks";
import { asArray, attempt } from "../../lib/api.ts";
import { Modal } from "../../components/modal.tsx";
import { SettingsPage, SettingsSection } from "./rows.tsx";

type T = Translator["t"];
type Draft = { id?: string; name: string; template: string; pages: QuickPage[]; includeFrame: boolean; sendMode: "send" | "fill"; enabled: boolean };

const blank = (): Draft => ({ name: "", template: "", pages: ["library", "work", "novel", "comic", "video", "chat"], includeFrame: false, sendMode: "send", enabled: true });
const draftOf = (task: QuickTask): Draft => ({ id: task.id, name: task.name, template: task.template, pages: [...task.pages], includeFrame: task.includeFrame, sendMode: task.sendMode, enabled: task.enabled });

/** Why a draft cannot be saved yet, in words; null when it can. */
export function draftProblem(t: T, draft: Draft): string | null {
  if (!draft.name.trim()) return t("quick.errName");
  if (!draft.template.trim()) return t("quick.errTemplate");
  const unknown = unknownPlaceholders(draft.template);
  if (unknown.length) return t("quick.errUnknown", { names: unknown.join("、") });
  if (!draft.pages.length) return t("quick.errPages");
  return null;
}

function Editor(props: { t: T; draft: Draft; onChange: (draft: Draft) => void; onSave: () => void; onClose: () => void; saving: boolean }) {
  const { t, draft } = props;
  const area = useRef<HTMLTextAreaElement>(null);
  const problem = draftProblem(t, draft);

  function insert(name: string) {
    const element = area.current;
    const slot = `{${name}}`;
    if (!element) { props.onChange({ ...draft, template: draft.template + slot }); return; }
    const start = element.selectionStart ?? draft.template.length;
    const end = element.selectionEnd ?? start;
    const next = draft.template.slice(0, start) + slot + draft.template.slice(end);
    props.onChange({ ...draft, template: next });
    window.requestAnimationFrame(() => { element.focus(); element.setSelectionRange(start + slot.length, start + slot.length); });
  }

  return (
    <Modal testId="quick-editor" title={draft.id ? t("quick.edit") : t("quick.new")} closeLabel={t("common.close")} onClose={props.onClose}
      footer={
        <>
          <button type="button" className="secondary-button" onClick={props.onClose}>{t("common.cancel")}</button>
          <button type="button" className="primary-button" data-testid="quick-save" disabled={Boolean(problem) || props.saving} onClick={props.onSave}>{t("common.save")}</button>
        </>
      }
    >
      <form className="quick-form" onSubmit={(event) => { event.preventDefault(); if (!problem) props.onSave(); }}>
        <label className="msettings-field">
          <span>{t("quick.name")}</span>
          <input data-testid="quick-name" maxLength={QUICK_NAME_MAX} value={draft.name} onChange={(event) => props.onChange({ ...draft, name: event.target.value })} />
        </label>
        <label className="msettings-field msettings-field-stack">
          <span>{t("quick.template")}</span>
          <textarea ref={area} data-testid="quick-template" rows={6} maxLength={QUICK_TEMPLATE_MAX} value={draft.template} onChange={(event) => props.onChange({ ...draft, template: event.target.value })} />
        </label>
        <div className="quick-slots" role="group" aria-label={t("quick.placeholders")} data-testid="quick-slots">
          <span className="detail-muted">{t("quick.placeholders")}</span>
          {QUICK_PLACEHOLDERS.map((name) => <button key={name} type="button" className="chip chip-button" data-testid={`quick-slot-${name}`} onClick={() => insert(name)}>{`{${name}}`}</button>)}
        </div>
        <p className="detail-muted">{t("quick.slotsHint")}</p>
        <fieldset className="quick-pages" data-testid="quick-pages">
          <legend>{t("quick.pages")}</legend>
          {QUICK_PAGES.map((page) => (
            <label key={page} className="msettings-check">
              <input type="checkbox" data-testid={`quick-page-${page}`} checked={draft.pages.includes(page)} onChange={(event) => props.onChange({ ...draft, pages: event.target.checked ? [...draft.pages, page] : draft.pages.filter((item) => item !== page) })} />
              {t(`quick.page.${page}`)}
            </label>
          ))}
        </fieldset>
        <label className="msettings-check"><input type="checkbox" data-testid="quick-frame" checked={draft.includeFrame} onChange={(event) => props.onChange({ ...draft, includeFrame: event.target.checked })} />{t("quick.includeFrame")}</label>
        <label className="msettings-field">
          <span>{t("quick.sendMode")}</span>
          <select data-testid="quick-send-mode" value={draft.sendMode} onChange={(event) => props.onChange({ ...draft, sendMode: event.target.value as Draft["sendMode"] })}>
            <option value="send">{t("quick.sendNow")}</option>
            <option value="fill">{t("quick.sendFill")}</option>
          </select>
        </label>
        <p className="detail-muted">{t("quick.authorityHint")}</p>
        {problem ? <p role="alert" className="review-error" data-testid="quick-error">{problem}</p> : null}
      </form>
    </Modal>
  );
}

/**
 * Quick tasks (A-52): the prompt templates the right pane and the chat page offer. They can be made, edited, copied, deleted, put in
 * order, switched off and brought back to the defaults. A template can only use the listed placeholders, and cannot change what the
 * Agent may do.
 */
export function QuickTasksPage(props: { t: T; onChanged: () => void; onError: (message: string) => void; onNotice: (message: string) => void }) {
  const { t } = props;
  const [tasks, setTasks] = useState<QuickTask[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await attempt<{ tasks: QuickTask[] }>("quickTasks.list", { includeDisabled: true });
    if (result.ok) setTasks(asArray<QuickTask>(result.value.tasks));
    else props.onError(result.error.message);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(next: Draft, done?: string) {
    setSaving(true);
    const result = await attempt("quickTasks.save", { ...(next.id ? { id: next.id } : {}), name: next.name.trim(), template: next.template.trim(), pages: next.pages, includeFrame: next.includeFrame, sendMode: next.sendMode, enabled: next.enabled });
    setSaving(false);
    if (!result.ok) { props.onError(result.error.message); return false; }
    if (done) props.onNotice(done);
    await load();
    props.onChanged();
    return true;
  }

  async function move(index: number, by: -1 | 1) {
    if (!tasks) return;
    const target = index + by;
    if (target < 0 || target >= tasks.length) return;
    const ids = tasks.map((task) => task.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    const result = await attempt<{ tasks: QuickTask[] }>("quickTasks.reorder", { ids });
    if (!result.ok) { props.onError(result.error.message); return; }
    setTasks(asArray<QuickTask>(result.value.tasks));
    props.onChanged();
  }

  async function remove(task: QuickTask) {
    setRemoving(null);
    const result = await attempt("quickTasks.delete", { id: task.id });
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("quick.deleted"));
    await load();
    props.onChanged();
  }

  async function restore() {
    const result = await attempt<{ restored?: string[] }>("quickTasks.restore", {});
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("quick.restored", { count: asArray<string>(result.value.restored).length }));
    await load();
    props.onChanged();
  }

  return (
    <SettingsPage id="quick" title={t("settings.page.quick")} hint={t("quick.hint")}>
      <SettingsSection
        testId="quick-list"
        actions={
          <>
            <button type="button" className="primary-button" data-testid="quick-new" onClick={() => setDraft(blank())}><Plus size={16} aria-hidden="true" />{t("quick.new")}</button>
            <button type="button" className="secondary-button" data-testid="quick-restore" onClick={() => void restore()}><RotateCcw size={14} aria-hidden="true" />{t("quick.restore")}</button>
          </>
        }
      >
        {tasks && tasks.length === 0 ? <p className="detail-muted settings-empty" data-testid="quick-empty">{t("quick.empty")}</p> : null}
        <ul className="quick-tasks">
          {(tasks ?? []).map((task, index) => (
            <li key={task.id} className="quick-task" data-testid={`quick-task-${task.builtinKey ?? task.id}`} data-enabled={task.enabled ? "true" : "false"}>
              <div className="quick-task-main">
                <strong>{task.name}</strong>
                <span className="detail-muted quick-task-template">{task.template}</span>
                <span className="record-chips">
                  {task.pages.map((page) => <span key={page} className="chip chip-quiet">{t(`quick.page.${page}`)}</span>)}
                  {task.includeFrame ? <span className="chip chip-quiet">{t("quick.includeFrameShort")}</span> : null}
                  {task.sendMode === "fill" ? <span className="chip chip-quiet">{t("quick.sendFillShort")}</span> : null}
                  {task.builtin ? <span className="chip chip-quiet">{t("quick.builtin")}</span> : null}
                </span>
              </div>
              <div className="quick-task-actions">
                <label className="msettings-check"><input type="checkbox" role="switch" aria-label={t("quick.enabled", { name: task.name })} data-testid={`quick-enabled-${task.builtinKey ?? task.id}`} checked={task.enabled} onChange={(event) => void save({ ...draftOf(task), enabled: event.target.checked })} />{t("quick.enabledShort")}</label>
                <button type="button" className="icon-button" aria-label={t("quick.up", { name: task.name })} data-testid={`quick-up-${task.builtinKey ?? task.id}`} disabled={index === 0} onClick={() => void move(index, -1)}><ArrowUp size={15} /></button>
                <button type="button" className="icon-button" aria-label={t("quick.down", { name: task.name })} data-testid={`quick-down-${task.builtinKey ?? task.id}`} disabled={index === tasks!.length - 1} onClick={() => void move(index, 1)}><ArrowDown size={15} /></button>
                <button type="button" className="icon-button" aria-label={t("quick.edit")} title={t("quick.edit")} data-testid={`quick-edit-${task.builtinKey ?? task.id}`} onClick={() => setDraft(draftOf(task))}><Pencil size={15} /></button>
                <button type="button" className="icon-button" aria-label={t("quick.copy")} title={t("quick.copy")} data-testid={`quick-copy-${task.builtinKey ?? task.id}`} onClick={() => { const { id: _id, ...rest } = draftOf(task); void _id; void save({ ...rest, name: `${task.name} ${t("quick.copySuffix")}`.slice(0, QUICK_NAME_MAX) }, t("quick.copied")); }}><Copy size={15} /></button>
                {removing === task.id ? (
                  <span role="group" aria-label={t("quick.deleteConfirm", { name: task.name })} className="library-path-confirm">
                    <button type="button" className="danger-button" data-testid={`quick-delete-confirm-${task.builtinKey ?? task.id}`} onClick={() => void remove(task)}>{t("quick.delete")}</button>
                    <button type="button" className="link-button" onClick={() => setRemoving(null)}>{t("common.cancel")}</button>
                  </span>
                ) : (
                  <button type="button" className="icon-button" aria-label={t("quick.delete")} title={t("quick.delete")} data-testid={`quick-delete-${task.builtinKey ?? task.id}`} onClick={() => setRemoving(task.id)}><Trash2 size={15} /></button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </SettingsSection>
      {draft ? (
        <Editor t={t} draft={draft} saving={saving} onChange={setDraft} onClose={() => setDraft(null)} onSave={() => void save(draft, t("quick.saved")).then((ok) => { if (ok) setDraft(null); })} />
      ) : null}
    </SettingsPage>
  );
}
