import type { ReactNode } from "react";
import type { ProjectTab, ProjectTabContext } from "./project-page.tsx";
import { WhiteboardTab } from "./canvas/whiteboard-tab.tsx";
import { MindmapTab } from "./canvas/mindmap-tab.tsx";
import { DraftTab } from "./copy/draft-tab.tsx";
import { ResearchTab } from "./research/research-tab.tsx";
import { RoughcutTab } from "./roughcut/roughcut-tab.tsx";

/** The tabs the project page leaves to other modules. A tab whose module is off never reaches here (the page does not offer it). */
export function renderCreativeTab(tab: ProjectTab, context: ProjectTabContext): ReactNode {
  switch (tab) {
    case "whiteboard": return <WhiteboardTab ctx={context} />;
    case "mindmap": return <MindmapTab ctx={context} />;
    case "draft": return <DraftTab ctx={context} />;
    case "excerpt": return <ResearchTab ctx={context} />;
    case "roughcut": return <RoughcutTab ctx={context} />;
    default: return null;
  }
}
