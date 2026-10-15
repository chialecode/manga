import type { WorkMode } from "@manga/contracts/reading";
import { emptyHistory, type NavHistory } from "./nav-history.ts";
import type { WorkMediaKind } from "./works.ts";

/**
 * The two modes are two workspaces (A-77): each keeps its own page, the work page or project it was on, its note, the resource it had open and
 * the back/forward history. Switching puts the other mode's view back instead of showing the page the first mode was on.
 */

export type WorkPageState = { workId: string; kind: WorkMediaKind | null; tab?: "cover" | "match"; from: string };
export type ProjectViewState = { projectId: string | null; tab: string; focus: { kind: string; id: string } | null };
export type OpenedResource = { resourceId: string; mediaKind: WorkMediaKind; workId: string | null };

export type ModeView = {
  page: string;
  workPage: WorkPageState | null;
  projectView: ProjectViewState;
  projectName: string;
  /** The resource the reader held when the mode was left; it is opened again if another resource took the reader's place meanwhile. */
  opened: OpenedResource | null;
  noteId: string | null;
  notesReturn: { page: string; workPage: WorkPageState | null } | null;
  history: NavHistory;
};

export const READER_PAGES: ReadonlySet<string> = new Set(["reading", "comic", "video"]);

/** A mode that has not been used yet starts on its overview. */
export const initialView = (): ModeView => ({
  page: "library",
  workPage: null,
  projectView: { projectId: null, tab: "materials", focus: null },
  projectName: "",
  opened: null,
  noteId: null,
  notesReturn: null,
  history: emptyHistory(),
});

/**
 * Whether the work mode is the project workspace. With the projects module off it has nothing of its own and is the same pages as the
 * entertainment mode, as it was before the modes were separated.
 */
export const projectWorkspace = (mode: WorkMode, facets: ReadonlySet<string>): boolean => mode === "creator" && facets.has("projects");

/** The pages a mode's navigation offers. A reader page is also reachable in the work mode, from a project's materials, without a nav entry. */
export function navigablePages(mode: WorkMode, facets: ReadonlySet<string>): string[] {
  const workspace = projectWorkspace(mode, facets);
  const pages: string[] = [];
  if (facets.has("library") || facets.has("inventory")) pages.push("library");
  if (facets.has("agent") && !workspace) pages.push("agent");
  if (workspace) pages.push("projects");
  if (!workspace) {
    if (facets.has("library")) pages.push("reading");
    if (facets.has("comic")) pages.push("comic");
    if (facets.has("video")) pages.push("video");
    if (facets.has("acquisition")) pages.push("downloads");
  }
  if (facets.has("settings")) pages.push("settings");
  return pages;
}

/** A saved view whose page the mode no longer has (a module was switched off) is shown from the overview. */
export function usableView(view: ModeView, mode: WorkMode, facets: ReadonlySet<string>): ModeView {
  const workspace = projectWorkspace(mode, facets);
  const page = view.page;
  const allowed = page === "library" || page === "work" || page === "notes"
    || (page === "projects" && workspace)
    || (page === "agent" && !workspace)
    || (page === "downloads" && !workspace && facets.has("acquisition"))
    || (READER_PAGES.has(page) && (!workspace || view.opened !== null));
  return allowed ? view : { ...initialView(), history: view.history };
}
