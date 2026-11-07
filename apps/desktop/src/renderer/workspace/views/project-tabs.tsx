import { useCallback, useEffect, useState } from "react";
import { renderCreativeTab } from "../../pages/projects/creative-tabs.tsx";
import { ProjectPage, type ProjectTab } from "../../pages/projects/project-page.tsx";
import { ProjectsPage } from "../../pages/projects/projects-page.tsx";
import { str } from "../model.ts";
import { useServices } from "../services.tsx";
import { useTabEnv, type TabEnv } from "../tab-env.tsx";

type Focus = { kind: string; id: string };

/** The project tab (A-94): a project's home, or — with no project named — the list of projects. */
export function ProjectTab() {
  const env = useTabEnv();
  const projectId = str(env.model?.target.projectId);
  return projectId ? <ProjectHome env={env} projectId={projectId} /> : <ProjectList />;
}

function ProjectList() {
  const s = useServices();
  return (
    <ProjectsPage
      t={s.t}
      formatDate={s.i18n.formatDate}
      version={s.projectsVersion}
      onOpen={(projectId) => void s.open.project(projectId)}
      onChanged={s.changedProjects}
      onError={(message) => s.setError(message)}
      onNotice={s.setNotice}
    />
  );
}

const connectionsOf = (settings: Record<string, unknown> | null) => (settings?.connections as Array<{ id: string; label: string; purpose: string; modelId?: string }> | undefined) ?? [];

function ProjectHome({ env, projectId }: { env: TabEnv; projectId: string }) {
  const s = useServices();
  const saved = str(env.model?.view.tab);
  const [tab, setTabState] = useState<ProjectTab>((saved || "materials") as ProjectTab);
  const [focus, setFocus] = useState<Focus | null>(null);
  // A request to show a tab of the project, or one of its objects: from a material, an embed, a search hit.
  useEffect(() => {
    const launch = env.takeLaunch();
    if (!launch) return;
    if (typeof launch.tab === "string") { setTabState(launch.tab as ProjectTab); env.controller.setView(env.tabId, { tab: launch.tab }); }
    if (launch.focus) setFocus(launch.focus as Focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.launchN]);
  const onLoaded = useCallback((project: { id: string; name: string }) => env.controller.retitle(env.tabId, project.name), [env.controller, env.tabId]);
  return (
    <ProjectPage
      t={s.t}
      formatDate={s.i18n.formatDate}
      projectId={projectId}
      tab={tab}
      facets={s.facets}
      connections={connectionsOf(s.settings)}
      version={s.projectsVersion}
      focus={focus}
      onFocus={setFocus}
      onTab={(next) => { setTabState(next); setFocus(null); env.controller.setView(env.tabId, { tab: next }); }}
      onChanged={s.changedProjects}
      onLoaded={onLoaded}
      onOpenMaterial={s.open.projectMaterial}
      onOpenHit={s.open.semanticHit}
      onOpenSettings={s.open.settings}
      onError={(message) => s.setError(message)}
      onNotice={s.setNotice}
      renderTab={renderCreativeTab}
    />
  );
}

const OBJECT_TAB: Record<string, ProjectTab> = { whiteboard: "whiteboard", mindmap: "mindmap", draft: "draft", roughcut: "roughcut" };

/**
 * A board, a map, a draft or a rough cut of a project as a tab of its own, so it can stand beside a video in the next column. The page is the project's
 * tab for that kind with nothing around it; the object the tab was opened for is the one shown, and the one picked inside is the one the tab keeps.
 */
export function ProjectObjectTab() {
  const env = useTabEnv();
  const s = useServices();
  const kind = env.model?.kind ?? "";
  const tab = OBJECT_TAB[kind] ?? "whiteboard";
  const projectId = str(env.model?.target.projectId) || env.contextId || "";
  const objectId = str(env.model?.target.objectId);
  const [focus, setFocus] = useState<Focus | null>(objectId ? { kind, id: objectId } : null);
  const onLoaded = useCallback(
    (project: { id: string; name: string }) => env.controller.retitle(env.tabId, `${s.t(`tab.${tab}` as never)} · ${project.name}`),
    [env.controller, env.tabId, s.t, tab],
  );
  if (!projectId) return null;
  return (
    <ProjectPage
      t={s.t}
      formatDate={s.i18n.formatDate}
      projectId={projectId}
      tab={tab}
      only={tab}
      facets={s.facets}
      connections={connectionsOf(s.settings)}
      version={s.projectsVersion}
      focus={focus}
      onFocus={(next) => { setFocus(next); if (next) env.controller.retarget(env.tabId, { objectId: next.id }); }}
      onTab={() => undefined}
      onChanged={s.changedProjects}
      onLoaded={onLoaded}
      onOpenMaterial={s.open.projectMaterial}
      onOpenHit={s.open.semanticHit}
      onOpenSettings={s.open.settings}
      onError={(message) => s.setError(message)}
      onNotice={s.setNotice}
      renderTab={renderCreativeTab}
    />
  );
}
