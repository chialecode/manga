import { useEffect, useState } from "react";
import { DownloadsPage } from "../../pages/downloads/downloads-page.tsx";
import { isKnownKind } from "../model.ts";
import { useServices } from "../services.tsx";
import { useTabEnv } from "../tab-env.tsx";
import { LibraryTab } from "./library-tab.tsx";
import { NoteTab } from "./note-tab.tsx";
import { ProjectObjectTab, ProjectTab } from "./project-tabs.tsx";
import { ReaderTab } from "./reader-tabs.tsx";
import { ObjectsTab } from "./objects-tab.tsx";
import { RecordsTab } from "./records-tab.tsx";
import { ConversationTab } from "./talk-tabs.tsx";

function DownloadsTab() {
  const s = useServices();
  return (
    <div className="page-host" data-testid="page-downloads-host">
      <DownloadsPage t={s.t} onOpenSettings={s.open.settings} onError={(message) => s.setError(message)} onNotice={s.setNotice} onLibraryChanged={s.bump} />
    </div>
  );
}

/** A tab of a kind this version does not know, kept as it was saved so a newer version can open it; nothing in it is lost or changed. */
function UnavailableTab(props: { kind: string }) {
  const s = useServices();
  const env = useTabEnv();
  return (
    <section className="page-pad tab-unavailable" role="status" data-testid="tab-unavailable" data-kind={props.kind}>
      <p>{s.t("tab.unavailable")}</p>
      <button type="button" className="secondary-button" data-testid="tab-unavailable-close" onClick={() => env.controller.closeTab(env.tabId)}>{s.t("tab.close")}</button>
    </section>
  );
}

function Body() {
  const env = useTabEnv();
  const kind = env.model?.kind;
  if (!env.model || !kind) return null;
  if (!isKnownKind(kind)) return <UnavailableTab kind={kind} />;
  switch (kind) {
    case "library": return <LibraryTab />;
    case "reader": return <ReaderTab />;
    case "note": return <NoteTab />;
    case "project": return <ProjectTab />;
    case "whiteboard": case "mindmap": case "draft": case "roughcut": return <ProjectObjectTab />;
    case "conversation": return <ConversationTab />;
    case "records": return <RecordsTab />;
    case "objects": return <ObjectsTab />;
    case "downloads": return <DownloadsTab />;
    default: return <UnavailableTab kind={kind} />;
  }
}

/**
 * What a tab shows. The content of a tab is made when the tab is first in view, not when the layout is restored: twenty tabs restored from the
 * last session cost the one that is on screen. Readers have their own, stricter rule about being loaded (see `ReaderTab`).
 */
export function TabView() {
  const env = useTabEnv();
  const [seen, setSeen] = useState(env.visible);
  useEffect(() => { if (env.visible) setSeen(true); }, [env.visible]);
  if (!seen) return null;
  return <Body />;
}
