import { useCallback, useEffect, useState } from "react";
import { FolderKanban, Plus } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../../lib/api.ts";
import { NewProjectDialog, type ProjectSummary } from "./projects-page.tsx";
import type { ProjectTab } from "./project-page.tsx";

type T = Translator["t"];

export type OverviewObject = { kind: "whiteboard" | "mindmap" | "draft" | "roughcut"; id: string; title: string; projectId: string; projectName: string; updatedAt: string };
export type OverviewSuggestion = { id: string; draftId: string; draftTitle: string; projectId: string; projectName: string; kind: string; createdAt: string };
type Overview = { recent: ProjectSummary[]; objects: OverviewObject[]; suggestions: OverviewSuggestion[]; totals: { active: number; archived: number } };

/** The project tab an object is edited on. */
const TAB_OF: Record<OverviewObject["kind"], ProjectTab> = { whiteboard: "whiteboard", mindmap: "mindmap", draft: "draft", roughcut: "roughcut" };

/**
 * The work mode's first page (A-77): the projects touched last, the objects edited last across them and the suggestions waiting to be
 * taken. It replaces the shelves of the entertainment mode, which the work mode does not have.
 */
export function ProjectOverviewPage(props: {
  t: T;
  formatDate: (value: string) => string;
  /** Changes when a project may have changed elsewhere. */
  version: number;
  onOpenProject: (projectId: string, tab?: ProjectTab, focus?: { kind: string; id: string }) => void;
  onAll: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const result = await attempt<Overview>("project.overview");
    if (result.ok) setOverview({ ...result.value, recent: asArray<ProjectSummary>(result.value.recent), objects: asArray<OverviewObject>(result.value.objects), suggestions: asArray<OverviewSuggestion>(result.value.suggestions) });
    else props.onError(result.error.message);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load, props.version]);

  return (
    <section className="projects-page project-overview" data-testid="page-project-overview" aria-labelledby="overview-title">
      <header className="projects-head">
        <h2 id="overview-title">{t("overview.title")}</h2>
        <div className="projects-head-actions">
          <button type="button" className="secondary-button" data-testid="overview-all" onClick={props.onAll}>{t("overview.all")}{overview ? ` (${overview.totals.active})` : ""}</button>
          <button type="button" className="primary-button" data-testid="overview-new" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" /> {t("projects.new")}</button>
        </div>
      </header>

      <section aria-labelledby="overview-recent-title" data-testid="overview-recent">
        <h3 id="overview-recent-title">{t("overview.recent")}</h3>
        {overview === null ? null : overview.recent.length === 0 ? <p className="detail-muted" data-testid="overview-recent-empty">{t("overview.recent.empty")}</p> : (
          <ul className="projects-list">
            {overview.recent.map((project) => (
              <li key={project.id} data-testid={`overview-project-${project.id}`}>
                <button type="button" className="project-open" data-testid={`overview-open-${project.id}`} onClick={() => props.onOpenProject(project.id)}>
                  <FolderKanban size={20} aria-hidden="true" />
                  <span className="project-text">
                    <strong className="truncate">{project.name}</strong>
                    {project.goal ? <span className="detail-muted project-goal">{project.goal}</span> : null}
                    <span className="detail-muted">{t("overview.counts", { materials: project.counts.materials, whiteboards: project.counts.whiteboards, mindmaps: project.counts.mindmaps, drafts: project.counts.drafts, roughCuts: project.counts.roughCuts })} · {props.formatDate(project.updatedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {overview && overview.totals.archived > 0 ? <p className="detail-muted" data-testid="overview-archived">{t("overview.archivedHint", { n: overview.totals.archived })}</p> : null}
      </section>

      <section aria-labelledby="overview-objects-title" data-testid="overview-objects">
        <h3 id="overview-objects-title">{t("overview.objects")}</h3>
        {overview === null ? null : overview.objects.length === 0 ? <p className="detail-muted" data-testid="overview-objects-empty">{t("overview.objects.empty")}</p> : (
          <ul className="overview-rows">
            {overview.objects.map((object) => (
              <li key={`${object.kind}:${object.id}`}>
                <button type="button" className="overview-row" data-testid={`overview-object-${object.id}`} onClick={() => props.onOpenProject(object.projectId, TAB_OF[object.kind], { kind: object.kind, id: object.id })}>
                  <span className="chip">{t(`overview.kind.${object.kind}`)}</span>
                  <strong className="truncate">{object.title}</strong>
                  <span className="detail-muted truncate">{object.projectName} · {props.formatDate(object.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="overview-suggestions-title" data-testid="overview-suggestions">
        <h3 id="overview-suggestions-title">{t("overview.suggestions")}</h3>
        {overview === null ? null : overview.suggestions.length === 0 ? <p className="detail-muted" data-testid="overview-suggestions-empty">{t("overview.suggestions.empty")}</p> : (
          <ul className="overview-rows">
            {overview.suggestions.map((suggestion) => (
              <li key={suggestion.id}>
                <button type="button" className="overview-row" data-testid={`overview-suggestion-${suggestion.id}`} onClick={() => props.onOpenProject(suggestion.projectId, "draft", { kind: "draft", id: suggestion.draftId })}>
                  <span className="chip">{t("overview.suggestion.of", { kind: t(`draft.kind.${suggestion.kind}` as never), project: suggestion.projectName })}</span>
                  <strong className="truncate">{suggestion.draftTitle}</strong>
                  <span className="detail-muted">{props.formatDate(suggestion.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {creating ? (
        <NewProjectDialog
          t={t}
          onClose={() => setCreating(false)}
          onError={props.onError}
          onCreated={(project) => {
            setCreating(false);
            props.onNotice(t("projects.created", { name: project.name }));
            props.onChanged();
            props.onOpenProject(project.id);
          }}
        />
      ) : null}
    </section>
  );
}
