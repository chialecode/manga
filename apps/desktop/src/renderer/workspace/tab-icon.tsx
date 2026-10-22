import { BookOpen, CircleHelp, Download, FileText, Film, FolderKanban, GalleryVertical, History, Home, MessageCircle, Network, NotebookPen, PenTool, Scissors, SquareStack } from "lucide-react";

/**
 * The picture of a tab's kind (A-95). A reader's picture is its medium's; the management of a project's objects has the picture of the sidebar's
 * "管理" entries. A kind this version does not open (one saved by a newer version) has the question mark.
 */
export function TabIcon(props: { kind: string; mediaKind?: string; size?: number }) {
  const size = props.size ?? 15;
  const common = { size, "aria-hidden": true as const, className: "tab-icon" };
  switch (props.kind) {
    case "library": return <Home {...common} />;
    case "reader": return props.mediaKind === "comic" ? <GalleryVertical {...common} /> : props.mediaKind === "video" ? <Film {...common} /> : <BookOpen {...common} />;
    case "note": return <NotebookPen {...common} />;
    case "project": return <FolderKanban {...common} />;
    case "whiteboard": return <PenTool {...common} />;
    case "mindmap": return <Network {...common} />;
    case "draft": return <FileText {...common} />;
    case "roughcut": return <Scissors {...common} />;
    case "conversation": return <MessageCircle {...common} />;
    case "records": return <History {...common} />;
    case "objects": return <SquareStack {...common} />;
    case "downloads": return <Download {...common} />;
    default: return <CircleHelp {...common} />;
  }
}
