import { RAIL_VIEWS, type RailView } from "@manga/contracts";
export type SettingsGroupId = "basic" | "agent" | "logs";
export type SettingsPageId =
  | "general" | "appearance" | "reading" | "recording" | "library" | "semantic" | "sources" | "danmaku" | "storage" | "plugins" | "modules" | "shortcuts"
  | "models" | "agent" | "quick" | "usage"
  | "logs";

/**
 * The settings directory (交互设计 2.12): which pages exist and how they are grouped. The records are not a settings page (A-101): the conversations and notes
 * are managed in tabs of their own.
 */
export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId; pages: readonly SettingsPageId[] }> = [
  { id: "basic", pages: ["general", "appearance", "reading", "recording", "library", "semantic", "sources", "danmaku", "storage", "plugins", "modules", "shortcuts"] },
  { id: "agent", pages: ["models", "agent", "quick", "usage"] },
  { id: "logs", pages: ["logs"] },
];

export const SETTINGS_PAGES: readonly SettingsPageId[] = SETTINGS_GROUPS.flatMap((group) => group.pages);

/**
 * The modules (UI facets) a view of the icon rail needs, any one of them (A-99): a view whose module is turned off is not in the rail, and the home is
 * always there. Whiteboards, maps, drafts and cuts live in projects, so they need the projects too.
 */
export const RAIL_FACETS: Record<RailView, readonly string[] | null> = {
  home: null,
  conversation: ["agent"],
  novel: ["library", "inventory"],
  comic: ["comic"],
  video: ["video"],
  note: ["notes"],
  whiteboard: ["whiteboard"],
  mindmap: ["mindmap"],
  draft: ["copywriting"],
  roughcut: ["roughcut"],
  downloads: ["acquisition"],
};

/** The views of the rail for the modules that are on, in the rail's order. */
export function railViewsFor(facets: ReadonlySet<string>): RailView[] {
  return RAIL_VIEWS.filter((view) => {
    const needs = RAIL_FACETS[view];
    return needs === null || needs.some((facet) => facets.has(facet));
  });
}
