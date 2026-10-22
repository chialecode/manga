import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { attempt } from "../../lib/api.ts";
import type { SemanticHitView } from "../../lib/semantic-model.ts";
import { MaterialsTab, ProjectSettingsTab, TermsTab, type Material, type ProjectDetail } from "./project-parts.tsx";

type T = Translator["t"];

/** The tabs of a project, with the module that provides each one; a tab whose module is turned off is not offered. */
export const PROJECT_TABS = [
  { id: "materials", facet: null },
  { id: "whiteboard", facet: "whiteboard" },
  { id: "mindmap", facet: "mindmap" },
  { id: "draft", facet: "copywriting" },
  { id: "excerpt", facet: "research" },
  { id: "roughcut", facet: "roughcut" },
  { id: "terms", facet: null },
  { id: "settings", facet: null },
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number]["id"];

/** What a tab provided by another module gets to draw with: the project, the shared version counter and the ways back into the app. */
export type ProjectTabContext = {
  t: T;
  formatDate: (value: string) => string;
  detail: ProjectDetail;
  /** Reads the project again (counts, materials) after the tab changed something. */
  reload: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  /** An object of this project that another tab was asked to show (a material that is a board, a map or a draft). */
  focus: { kind: string; id: string } | null;
  onFocus: (focus: { kind: string; id: string } | null) => void;
  /** The tab of this module for another module to switch to. */
  onTab: (tab: ProjectTab) => void;
  onOpenMaterial: (material: Pick<Material, "kind" | "targetId" | "label" | "opens">) => void;
  /** The modules that are on, for a tab to offer what depends on another one (searching by meaning needs the semantic index). */
  facets: ReadonlySet<string>;
  /** A passage the semantic search found, opened at its place: the book at the locator, the note at its block, the recording at its review. */
  onOpenHit?: (hit: SemanticHitView) => void;
  /** The settings page of the module, for a tab that finds it is not set up yet. */
  onOpenSettings?: (page: "semantic") => void;
};

/**
 * One project: its name and goal, the tabs, and the tab on show. The boards and maps fill the whole main panel; the Agent stays in the
 * right pane and is bound to this project's conversation, which reads only what the project refers to.
 */
export function ProjectPage(props: {
  t: T;
  formatDate: (value: string) => string;
  projectId: string;
  tab: ProjectTab;
  facets: ReadonlySet<string>;
  connections: Array<{ id: string; label: string; purpose: string; modelId?: string }>;
  /** Changes when something outside the page may have changed the project (a material added from another page). */
  version: number;
  focus: { kind: string; id: string } | null;
  onFocus: (focus: { kind: string; id: string } | null) => void;
  onTab: (tab: ProjectTab) => void;
  /** Back to the list of projects; a project that is a tab of its own has no list to go back to and asks for none. */
  onBack?: () => void;
  /** The page shows this one tab of the project and nothing else — no name, no strip of tabs: a board, a map, a draft or a cut that stands as a tab of its own. */
  only?: ProjectTab;
  onChanged: () => void;
  onOpenMaterial: (material: Pick<Material, "kind" | "targetId" | "label" | "opens">) => void;
  onOpenHit?: (hit: SemanticHitView) => void;
  onOpenSettings?: (page: "semantic") => void;
  /** Told once the project is read, so the title bar and the conversation can name it. */
  onLoaded?: (project: { id: string; name: string }) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  /** The tabs other modules provide, drawn by the app so the page needs no knowledge of them. */
  renderTab?: (tab: ProjectTab, context: ProjectTabContext) => ReactNode;
}) {
  const { t } = props;
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const result = await attempt<ProjectDetail>("project.get", { projectId: props.projectId });
    if (result.ok) { setDetail(result.value); setMissing(false); }
    else if (result.error.code === "NOT_FOUND") setMissing(true);
    else props.onError(result.error.message);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId]);
  useEffect(() => { void load(); }, [load, props.version]);

  const { onLoaded } = props;
  useEffect(() => { if (detail) onLoaded?.({ id: detail.project.id, name: detail.project.name }); }, [detail?.project.id, detail?.project.name, onLoaded]);
  const reload = () => { void load(); props.onChanged(); };
  const tabs = PROJECT_TABS.filter((item) => !item.facet || props.facets.has(item.facet));
  const tab = props.only ?? (tabs.some((item) => item.id === props.tab) ? props.tab : "materials");

  if (missing) {
    return (
      <section className="project-page" data-testid="page-project">
        {props.onBack ? <button type="button" className="link-button" data-testid="project-back" onClick={props.onBack}><ArrowLeft size={15} aria-hidden="true" /> {t("projects.back")}</button> : null}
        <p className="detail-muted" data-testid="project-missing">{t("projects.missing")}</p>
      </section>
    );
  }
  if (!detail) return <section className="project-page" data-testid="page-project" aria-busy="true" />;

  const context: ProjectTabContext = {
    t, formatDate: props.formatDate, detail, reload, onError: props.onError, onNotice: props.onNotice,
    focus: props.focus, onFocus: props.onFocus, onTab: props.onTab, onOpenMaterial: props.onOpenMaterial,
    facets: props.facets, onOpenHit: props.onOpenHit, onOpenSettings: props.onOpenSettings,
  };
  const body = tab === "materials"
    ? <MaterialsTab t={t} projectId={detail.project.id} materials={detail.materials} onChanged={reload} onOpen={props.onOpenMaterial} onError={props.onError} onNotice={props.onNotice} />
    : tab === "terms"
      ? <TermsTab t={t} projectId={detail.project.id} terms={detail.terms} onChanged={reload} onError={props.onError} onNotice={props.onNotice} />
      : tab === "settings"
        ? <ProjectSettingsTab t={t} detail={detail} connections={props.connections} onChanged={reload} onError={props.onError} onNotice={props.onNotice} />
        : props.renderTab?.(tab, context) ?? null;
  const wide = tab === "whiteboard" || tab === "mindmap";

  if (props.only) {
    return (
      <section className={`project-page project-page-only${wide ? " project-page-wide" : ""}`} data-testid="page-project" data-project={detail.project.id} data-tab={tab}>
        <div className="project-body" data-testid="project-body">{body}</div>
      </section>
    );
  }
  return (
    <section className={`project-page${wide ? " project-page-wide" : ""}`} data-testid="page-project" data-project={detail.project.id} data-tab={tab} aria-labelledby="project-title">
      <header className="project-head">
        {props.onBack ? <button type="button" className="link-button" data-testid="project-back" onClick={props.onBack}><ArrowLeft size={15} aria-hidden="true" /> {t("projects.back")}</button> : null}
        <h2 id="project-title" data-testid="project-title">{detail.project.name}</h2>
        {detail.project.status === "archived" ? <span className="chip">{t("projects.archived")}</span> : null}
        {detail.project.goal ? <p className="detail-muted project-goal" data-testid="project-goal-text">{detail.project.goal}</p> : null}
      </header>
      <div className="project-tabs" role="tablist" aria-label={detail.project.name} data-testid="project-tabs">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" id={`project-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="project-tabpanel" data-testid={`project-tab-${item.id}`} onClick={() => props.onTab(item.id)}>{t(`projects.tab.${item.id}`)}</button>
        ))}
      </div>
      <div className="project-body" role="tabpanel" id="project-tabpanel" aria-labelledby={`project-tab-${tab}`} data-testid="project-body">{body}</div>
    </section>
  );
}
