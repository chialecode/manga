import { useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../../lib/api.ts";
import type { NoteSummary } from "../../lib/types.ts";
import { WorkPicker } from "../../components/work-picker.tsx";
import { ExportProjectPackage } from "./project-package.tsx";

type T = Translator["t"];
export type Material = { id: string; kind: string; targetId: string; label: string; state: "ok" | "missing" | "disabled"; addedAt: string; opens?: { resourceId: string; mediaKind: string; workId: string | null };
  /** What a package recorded of a reference that is not in this profile: enough to read what it was. */
  snapshot?: { text: string; takenAt: string } };
export type Term = { id: string; term: string; heard: string | null; note: string | null };
export type ProjectDetail = {
  project: { id: string; name: string; goal: string; status: "active" | "archived"; modelConnectionId: string | null; counts: Record<string, number> };
  materials: Material[];
  terms: Term[];
  sessions: Array<{ sessionId: string; title: string; updatedAt: string }>;
};
type Recording = { id: string; title?: string; createdAt?: string; state?: string };

/** What can be picked from a list here; the other kinds are added from their own pages with "加入项目". */
const PICKABLE = ["work", "note", "recording"] as const;
type Pickable = (typeof PICKABLE)[number];

/**
 * The project's materials: references to works, resources, notes, recordings and its own objects. Nothing is copied. A reference whose target
 * has gone keeps its name and says so; one whose module is turned off says that, and both can be removed.
 */
export function MaterialsTab(props: {
  t: T;
  projectId: string;
  materials: Material[];
  onChanged: () => void;
  onOpen: (material: Material) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [kind, setKind] = useState<Pickable>("work");
  const [target, setTarget] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);

  useEffect(() => {
    setTarget(null);
    let live = true;
    if (kind === "note") void attempt<NoteSummary[]>("notes.list", { limit: 200 }).then((result) => { if (live && result.ok) setNotes(asArray<NoteSummary>(result.value)); });
    if (kind === "recording") void attempt<{ sessions: Recording[] }>("capture.list", { limit: 100 }).then((result) => { if (live && result.ok) setRecordings(asArray<Recording>(result.value.sessions)); });
    return () => { live = false; };
  }, [kind]);

  async function add() {
    if (!target) return;
    const result = await attempt("project.addMaterial", { projectId: props.projectId, kind, targetId: target });
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("projects.materials.added"));
    setTarget(null);
    props.onChanged();
  }

  async function remove(material: Material) {
    const result = await attempt("project.removeMaterial", { projectId: props.projectId, materialId: material.id });
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onChanged();
  }

  return (
    <div className="project-materials" data-testid="project-materials">
      <form className="project-add" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <label className="msettings-field">
          <span>{t("projects.materials.kind")}</span>
          <select data-testid="material-kind" value={kind} onChange={(event) => setKind(event.target.value as Pickable)}>
            {PICKABLE.map((item) => <option key={item} value={item}>{t(`projects.materials.kind.${item}`)}</option>)}
          </select>
        </label>
        {kind === "work" ? <WorkPicker t={t} value={target} onChange={setTarget} label={t("projects.pickWork")} placeholder={t("projects.pickWork")} testId="material-work" /> : null}
        {kind === "note" ? (
          <select aria-label={t("projects.materials.pick")} data-testid="material-note" value={target ?? ""} onChange={(event) => setTarget(event.target.value || null)}>
            <option value="">{t("projects.materials.pick")}</option>
            {notes.map((note) => <option key={note.objectId} value={note.objectId}>{note.title}</option>)}
          </select>
        ) : null}
        {kind === "recording" ? (
          <select aria-label={t("projects.materials.pick")} data-testid="material-recording" value={target ?? ""} onChange={(event) => setTarget(event.target.value || null)}>
            <option value="">{t("projects.materials.pick")}</option>
            {recordings.map((item) => <option key={item.id} value={item.id}>{item.title || item.createdAt || item.id}</option>)}
          </select>
        ) : null}
        <button type="submit" className="primary-button" data-testid="material-add" disabled={!target}>{t("projects.materials.add")}</button>
      </form>
      {props.materials.length === 0 ? <p className="detail-muted" data-testid="materials-empty">{t("projects.materials.empty")}</p> : (
        <ul className="material-list" data-testid="material-list">
          {props.materials.map((material) => (
            <li key={material.id} data-testid={`material-${material.id}`} data-state={material.state} data-kind={material.kind}>
              <span className="chip">{t(`projects.materials.kind.${material.kind}` as "projects.materials.kind.work")}</span>
              {material.state === "ok"
                ? <button type="button" className="link-button" data-testid={`material-open-${material.id}`} onClick={() => props.onOpen(material)}>{material.label}</button>
                : <span className="material-gone">{material.label}</span>}
              {material.snapshot ? (
                <details className="material-snapshot" data-testid={`material-snapshot-${material.id}`}>
                  <summary>{t("projects.materials.snapshot")}</summary>
                  <p className="material-snapshot-text" data-testid={`material-snapshot-text-${material.id}`}>{material.snapshot.text}</p>
                  <p className="detail-muted">{t("projects.materials.snapshotAt", { date: material.snapshot.takenAt.slice(0, 10) })}</p>
                </details>
              ) : null}
              {material.state === "missing" ? <span className="chip chip-warn" data-testid={`material-state-${material.id}`}>{t("projects.materials.missing")}</span> : null}
              {material.state === "disabled" ? <span className="chip chip-warn" data-testid={`material-state-${material.id}`}>{t("projects.materials.disabled")}</span> : null}
              <button type="button" className="icon-button" data-testid={`material-remove-${material.id}`} aria-label={t("projects.materials.remove")} title={t("projects.materials.remove")} onClick={() => void remove(material)}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The project's own glossary: kept apart from the voice dictionary, given to the model with the project, and filled from a work's dictionary on request. */
export function TermsTab(props: { t: T; projectId: string; terms: Term[]; onChanged: () => void; onError: (message: string) => void; onNotice: (message: string) => void }) {
  const { t } = props;
  const [draft, setDraft] = useState({ term: "", heard: "", note: "" });
  const [editing, setEditing] = useState<{ id: string; term: string; heard: string; note: string } | null>(null);
  const [work, setWork] = useState<string | null>(null);

  async function run(commandId: string, input: Record<string, unknown>): Promise<boolean> {
    const result = await attempt(commandId, { projectId: props.projectId, ...input });
    if (!result.ok) { props.onError(result.error.message); return false; }
    props.onChanged();
    return true;
  }

  async function add() {
    if (!draft.term.trim()) return;
    if (await run("project.addTerm", { term: draft.term.trim(), ...(draft.heard.trim() ? { heard: draft.heard.trim() } : {}), ...(draft.note.trim() ? { note: draft.note.trim() } : {}) })) setDraft({ term: "", heard: "", note: "" });
  }

  async function save() {
    if (!editing?.term.trim()) return;
    if (await run("project.updateTerm", { termId: editing.id, term: editing.term.trim(), heard: editing.heard.trim() || null, note: editing.note.trim() || null })) setEditing(null);
  }

  async function importTerms() {
    if (!work) return;
    const result = await attempt<{ added: number; skipped: number }>("project.importTerms", { projectId: props.projectId, workId: work });
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("projects.terms.imported", result.value));
    props.onChanged();
  }

  return (
    <div className="project-terms" data-testid="project-terms">
      <p className="detail-muted">{t("projects.terms.hint")}</p>
      <form className="dictionary-add" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <input data-testid="pterm-term" aria-label={t("projects.terms.term")} placeholder={t("projects.terms.term")} maxLength={128} value={draft.term} onChange={(event) => setDraft({ ...draft, term: event.target.value })} />
        <input data-testid="pterm-heard" aria-label={t("projects.terms.heard")} placeholder={t("projects.terms.heard")} maxLength={128} value={draft.heard} onChange={(event) => setDraft({ ...draft, heard: event.target.value })} />
        <input data-testid="pterm-note" aria-label={t("projects.terms.note")} placeholder={t("projects.terms.note")} maxLength={500} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
        <button type="submit" className="primary-button" data-testid="pterm-add" disabled={!draft.term.trim()}>{t("projects.terms.add")}</button>
      </form>
      <div className="dictionary-add">
        <WorkPicker t={t} value={work} onChange={setWork} label={t("projects.pickWork")} placeholder={t("projects.pickWork")} testId="pterm-work" />
        <button type="button" className="secondary-button" data-testid="pterm-import" disabled={!work} onClick={() => void importTerms()}>{t("projects.terms.import")}</button>
      </div>
      {props.terms.length === 0 ? <p className="detail-muted" data-testid="pterm-empty">{t("projects.terms.empty")}</p> : (
        <ul className="dictionary-list" data-testid="pterm-list">
          {props.terms.map((item) => (
            <li key={item.id} data-testid={`pterm-${item.id}`}>
              {editing?.id === item.id ? (
                <form className="dictionary-edit" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                  <input data-testid="pterm-edit-term" aria-label={t("projects.terms.term")} maxLength={128} value={editing.term} onChange={(event) => setEditing({ ...editing, term: event.target.value })} />
                  <input data-testid="pterm-edit-heard" aria-label={t("projects.terms.heard")} maxLength={128} value={editing.heard} onChange={(event) => setEditing({ ...editing, heard: event.target.value })} />
                  <input data-testid="pterm-edit-note" aria-label={t("projects.terms.note")} maxLength={500} value={editing.note} onChange={(event) => setEditing({ ...editing, note: event.target.value })} />
                  <button type="submit" className="primary-button" data-testid="pterm-edit-save" disabled={!editing.term.trim()}>{t("voice.dictionary.save")}</button>
                  <button type="button" className="secondary-button" onClick={() => setEditing(null)}>{t("voice.dictionary.cancel")}</button>
                </form>
              ) : (
                <>
                  <strong>{item.term}</strong>
                  {item.heard ? <span className="detail-muted"> ← {item.heard}</span> : null}
                  {item.note ? <span className="detail-muted"> · {item.note}</span> : null}
                  <span className="dictionary-actions">
                    <button type="button" className="icon-button" aria-label={t("voice.dictionary.edit")} title={t("voice.dictionary.edit")} data-testid={`pterm-edit-${item.id}`} onClick={() => setEditing({ id: item.id, term: item.term, heard: item.heard ?? "", note: item.note ?? "" })}><Pencil size={15} /></button>
                    <button type="button" className="icon-button" aria-label={t("projects.terms.remove")} title={t("projects.terms.remove")} data-testid={`pterm-remove-${item.id}`} onClick={() => void run("project.removeTerm", { termId: item.id })}><Trash2 size={15} /></button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The project's name, goal and the model its conversations use. */
export function ProjectSettingsTab(props: {
  t: T;
  detail: ProjectDetail;
  connections: Array<{ id: string; label: string; purpose: string; modelId?: string }>;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t, detail } = props;
  const [name, setName] = useState(detail.project.name);
  const [goal, setGoal] = useState(detail.project.goal);
  useEffect(() => { setName(detail.project.name); setGoal(detail.project.goal); }, [detail.project.id, detail.project.name, detail.project.goal]);
  const texts = props.connections.filter((connection) => connection.purpose === "text");
  const dirty = name.trim() !== detail.project.name || goal !== detail.project.goal;

  async function patch(input: Record<string, unknown>) {
    const result = await attempt("project.update", { projectId: detail.project.id, ...input });
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onChanged();
  }

  return (
    <form className="project-settings" data-testid="project-settings" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void patch({ name: name.trim(), goal }); }}>
      <label className="msettings-field"><span>{t("projects.name")}</span><input data-testid="psettings-name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="msettings-field msettings-field-stack"><span>{t("projects.goal")}</span><textarea data-testid="psettings-goal" rows={5} maxLength={2000} placeholder={t("projects.goalHint")} value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
      <div><button type="submit" className="primary-button" data-testid="psettings-save" disabled={!dirty || !name.trim()}>{t("common.save")}</button></div>
      <label className="msettings-field">
        <span>{t("projects.model")}</span>
        <select data-testid="psettings-model" value={detail.project.modelConnectionId ?? ""} onChange={(event) => void patch({ modelConnectionId: event.target.value || null })}>
          <option value="">{t("projects.model.default")}</option>
          {texts.map((connection) => <option key={connection.id} value={connection.id}>{connection.label}{connection.modelId ? ` · ${connection.modelId}` : ""}</option>)}
        </select>
      </label>
      <p className="detail-muted">{t("projects.model.hint")}</p>
      <ExportProjectPackage t={t} projectId={detail.project.id} onError={props.onError} onNotice={props.onNotice} />
    </form>
  );
}
