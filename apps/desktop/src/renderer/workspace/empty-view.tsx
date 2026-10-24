import type { WorkspaceView } from "@manga/contracts";
import type { MessageKey } from "@manga/i18n";
import { VIEW_LABEL } from "../sidebar.tsx";
import { useServices, type Openers } from "./services.tsx";

/** The management entry of a feature view (the sidebar's entry and the empty view's button): the shelf of a medium, the records, the objects, the downloads. */
export function manageAction(view: WorkspaceView, open: Openers): (() => void) | null {
  if (view === "conversation") return () => open.records({ type: "conversation" });
  if (view === "note") return () => open.records({ type: "note" });
  if (view === "novel" || view === "comic" || view === "video") return () => open.library(view);
  if (view === "whiteboard" || view === "mindmap" || view === "draft" || view === "roughcut") return () => open.objects(view);
  if (view === "downloads") return () => open.downloads();
  return null;
}

/**
 * The main area of a feature view that has no tab yet (A-107): one line that says so and the view's management entry, a little above the middle. Shown
 * by the empty dock of the view; a dock out of sight keeps it without its test names.
 */
export function EmptyView(props: { view: WorkspaceView; onScreen: boolean }) {
  const s = useServices();
  const { t } = s;
  const manage = manageAction(props.view, s.open);
  const line = props.view === "downloads" ? t("workspace.emptyDownloads") : t("workspace.emptyView", { name: t(VIEW_LABEL[props.view]) });
  return (
    <div className="workspace-empty view-empty" data-testid={props.onScreen ? "view-empty" : undefined} data-view={props.view}>
      <p>{line}</p>
      {manage ? (
        <button type="button" className="secondary-button" data-testid={props.onScreen ? "view-empty-manage" : undefined} onClick={manage}>{t(`sidebar.manage.${props.view}` as MessageKey)}</button>
      ) : null}
    </div>
  );
}
