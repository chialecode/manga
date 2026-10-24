import { attempt } from "../../lib/api.ts";
import { Shelf } from "../../pages/shelf.tsx";
import { WorkHome } from "../../pages/work-home.tsx";
import type { WorkMediaKind } from "../../lib/works.ts";
import { canStep, str } from "../model.ts";
import { libraryTitle } from "../openers.ts";
import { useServices } from "../services.tsx";
import { useTab } from "../tab-context.tsx";
import { useTabEnv } from "../tab-env.tsx";

const SHELVES: ReadonlySet<string> = new Set(["novel", "comic", "video"]);

/**
 * The library tab (UI-01, A-94): the overview, the shelf of one medium and a work's page are places in one tab, and the tab's own history walks
 * between them. There can be several library tabs; opening a book from one leaves it where it was.
 */
export function LibraryTab() {
  const env = useTabEnv();
  const tab = useTab();
  const s = useServices();
  const { t } = s;
  const target = env.model?.target ?? {};
  const page = str(target.page) || "overview";
  const workId = str(target.workId);
  const go = (next: Record<string, unknown>, title: string) => env.controller.navigate(env.tabId, next, title);
  async function setShelf(id: string, state: string) {
    const result = await attempt("works.setShelf", { workId: id, state });
    if (!result.ok) s.setError(result.error.message);
    else s.bump();
  }

  if (page === "work" && workId) {
    const leave = () => {
      if (canStep(env.model, -1)) env.controller.back(env.tabId);
      else go({ page: "overview" }, libraryTitle(t, "overview"));
    };
    return (
      <WorkHome
        t={t}
        workId={workId}
        facets={s.facets}
        formatDate={s.i18n.formatDate}
        initialTab={target.tab === "cover" || target.tab === "match" ? target.tab : undefined}
        onBack={leave}
        onOpenResource={(resourceId, kind) => void s.open.resource({ resourceId, mediaKind: kind, workId })}
        onOpenNote={(objectId) => s.open.note(objectId)}
        onOpenWork={(id) => s.open.work(id)}
        onOpenRecording={s.voiceOn ? (sessionId) => s.reviewRecording({ sessionId, workId }) : undefined}
        onOpenConversation={(sessionId) => void s.open.conversation(sessionId)}
        onAddPath={() => s.open.settings("library")}
        onLoaded={(info) => {
          env.controller.retarget(env.tabId, { author: info.author ?? "", kind: info.mediaKind });
          if (info.title) env.controller.retitle(env.tabId, info.title);
        }}
        onChanged={s.bump}
        onError={(message) => s.setError(message)}
        onNotice={s.setNotice}
      />
    );
  }

  const kind = SHELVES.has(page) ? (page as WorkMediaKind) : null;
  return (
    <div className="page-host" data-testid={`page-${kind ?? "library"}`}>
      <Shelf
        t={t}
        kind={kind}
        refreshKey={s.shelfKey}
        facets={s.facets}
        onOpen={(summary) => s.open.work(summary.id, { kind: summary.mediaKind as WorkMediaKind, title: summary.title })}
        onContinue={(summary) => s.open.continueWork(summary)}
        onDetail={(id, tab) => s.open.work(id, { tab })}
        onAddPath={() => s.open.settings("library")}
        onViewAll={(next) => s.open.library(next)}
        onSetShelf={(id, state) => void setShelf(id, state)}
        onOpenResource={(resourceId, mediaKind) => void s.open.resource({ resourceId, mediaKind, workId: null })}
        onMatchWork={(id, mediaKind) => s.open.work(id, { kind: mediaKind, tab: "match" })}
        onChanged={s.bump}
        onNotice={s.setNotice}
        onError={(message) => s.setError(message)}
        context={tab.contextId}
      />
    </div>
  );
}
