import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, FolderKanban, Plus, Trash2 } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../../lib/api.ts";
import { Modal } from "../../components/modal.tsx";
import { ImportProjectPackage } from "./project-package.tsx";

type T = Translator["t"];
export type ProjectSummary = {
  id: string; name: string; goal: string; status: "active" | "archived"; modelConnectionId: string | null; createdAt: string; updatedAt: string;
  counts: { materials: number; terms: number; sessions: number; whiteboards: number; mindmaps: number; drafts: number; excerpts: number; roughCuts: number };
};

/** How many creative objects a project owns, which the delete confirmation names. */
export const ownedObjects = (counts: ProjectSummary["counts"]): number => counts.whiteboards + counts.mindmaps + counts.drafts + counts.excerpts + counts.roughCuts;

/** The dialog that names a new project; the work mode's overview opens the same one. */
export function NewProjectDialog(props: {
  t: T;
  onClose: () => void;
  onError: (message: string) => void;
  /** The project exists; the caller opens it. */
  onCreated: (project: ProjectSummary) => void;
}) {
  const { t } = props;
  const [draft, setDraft] = useState({ name: "", goal: "" });
  const [busy, setBusy] = useState(false);

  async function create() {
    const name = draft.name.trim();
    if (!name) return;
    setBusy(true);
    const result = await attempt<ProjectSummary>("project.create", { name, ...(draft.goal.trim() ? { goal: draft.goal.trim() } : {}) });
    setBusy(false);
    if (!result.ok) { props.onError(result.error.code === "VALIDATION_ERROR" ? t("projects.limit") : result.error.message); return; }
    props.onCreated(result.value);
  }

  return (
    <Modal testId="project-create" title={t("projects.new")} closeLabel={t("common.close")} onClose={props.onClose}
      footer={<>
        <button type="button" className="secondary-button" onClick={props.onClose}>{t("projects.cancel")}</button>
        <button type="submit" form="project-create-form" className="primary-button" data-testid="project-create-submit" disabled={busy || !draft.name.trim()}>{t("projects.create")}</button>
      </>}>
      <form id="project-create-form" className="project-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label className="msettings-field"><span>{t("projects.name")}</span><input data-testid="project-name" autoFocus maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="msettings-field msettings-field-stack"><span>{t("projects.goal")}</span><textarea data-testid="project-goal" rows={4} maxLength={2000} placeholder={t("projects.goalHint")} value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} /></label>
      </form>
    </Modal>
  );
}

/**
 * The projects page (CRE-01): a project gathers one piece of creative work: the materials it refers to, its boards, maps, drafts, excerpts
 * and cuts, its own glossary and its conversations. Deleting one asks first and says what goes with it.
 */
export function ProjectsPage(props: {
  t: T;
  formatDate: (value: string) => string;
  /** Changes when a project may have changed elsewhere. */
  version: number;
  onOpen: (projectId: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await attempt<{ projects: ProjectSummary[] }>("project.list", { status: archived ? "archived" : "active" });
    if (result.ok) setProjects(asArray<ProjectSummary>(result.value.projects));
    else props.onError(result.error.message);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archived]);
  useEffect(() => { void load(); }, [load, props.version]);

  function created(project: ProjectSummary) {
    setCreating(false);
    props.onNotice(t("projects.created", { name: project.name }));
    props.onChanged();
    props.onOpen(project.id);
  }

  async function setStatus(project: ProjectSummary, status: "active" | "archived") {
    const result = await attempt("project.update", { projectId: project.id, status });
    if (!result.ok) { props.onError(result.error.message); return; }
    await load();
    props.onChanged();
  }

  async function remove(project: ProjectSummary) {
    setBusy(true);
    const result = await attempt("project.delete", { projectId: project.id });
    setBusy(false);
    setDeleting(null);
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("projects.deleted", { name: project.name }));
    await load();
    props.onChanged();
  }

  return (
    <section className="projects-page" data-testid="page-projects" aria-labelledby="projects-title">
      <header className="projects-head">
        <h2 id="projects-title">{t("projects.title")}</h2>
        <div className="projects-head-actions">
          <div className="projects-filter" role="group" aria-label={t("projects.title")}>
            <button type="button" className="secondary-button" aria-pressed={!archived} data-testid="projects-filter-active" onClick={() => setArchived(false)}>{t("projects.active")}</button>
            <button type="button" className="secondary-button" aria-pressed={archived} data-testid="projects-filter-archived" onClick={() => setArchived(true)}>{t("projects.archived")}</button>
          </div>
          <ImportProjectPackage t={t} formatDate={props.formatDate} onError={props.onError} onNotice={props.onNotice} onImported={(projectId) => { props.onChanged(); void load(); props.onOpen(projectId); }} />
          <button type="button" className="primary-button" data-testid="projects-new" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> {t("projects.new")}</button>
        </div>
      </header>

      {projects === null ? null : projects.length === 0 ? <p className="detail-muted" data-testid="projects-empty">{archived ? t("projects.archivedEmpty") : t("projects.empty")}</p> : (
        <ul className="projects-list" data-testid="projects-list">
          {projects.map((project) => (
            <li key={project.id} data-testid={`project-${project.id}`} data-status={project.status}>
              <button type="button" className="project-open" data-testid={`project-open-${project.id}`} onClick={() => props.onOpen(project.id)}>
                <FolderKanban size={20} aria-hidden="true" />
                <span className="project-text">
                  <strong className="truncate">{project.name}</strong>
                  {project.goal ? <span className="detail-muted project-goal">{project.goal}</span> : null}
                  <span className="detail-muted">{t("projects.counts", { materials: project.counts.materials, sessions: project.counts.sessions })} · {props.formatDate(project.updatedAt)}</span>
                </span>
              </button>
              <span className="project-actions">
                <button type="button" className="icon-button" data-testid={`project-archive-${project.id}`} aria-label={project.status === "active" ? t("projects.archive") : t("projects.unarchive")} title={project.status === "active" ? t("projects.archive") : t("projects.unarchive")} onClick={() => void setStatus(project, project.status === "active" ? "archived" : "active")}>
                  {project.status === "active" ? <Archive size={16} /> : <ArchiveRestore size={16} />}
                </button>
                <button type="button" className="icon-button" data-testid={`project-delete-${project.id}`} aria-label={t("projects.delete")} title={t("projects.delete")} onClick={() => setDeleting(project)}><Trash2 size={16} /></button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {creating ? <NewProjectDialog t={t} onClose={() => setCreating(false)} onError={props.onError} onCreated={created} /> : null}

      {deleting ? (
        <Modal testId="project-delete-confirm" title={t("projects.delete")} closeLabel={t("common.close")} onClose={() => setDeleting(null)}
          footer={<>
            <button type="button" className="secondary-button" data-testid="project-delete-cancel" onClick={() => setDeleting(null)}>{t("projects.cancel")}</button>
            <button type="button" className="primary-button danger-button" data-testid="project-delete-do" disabled={busy} onClick={() => void remove(deleting)}>{t("projects.deleteDo")}</button>
          </>}>
          <p data-testid="project-delete-text">{t("projects.deleteConfirm", { name: deleting.name, objects: ownedObjects(deleting.counts) })}</p>
        </Modal>
      ) : null}
    </section>
  );
}
