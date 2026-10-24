/**
 * What the sidebar lists can change without the sidebar's doing (交互设计 2.10: the lists follow the data): a reader that opens a resource inside a project
 * adds it to the project's materials, a note is written, renamed or deleted, an object is renamed in its own tab, and a resource read in "最近" goes to the
 * top of its list there. The commands that do so are named here; when one of them succeeds the window is told, once for a burst of them, and what lists
 * these things asks again. The conversations, the projects and the shelf have words of their own (`conversationsChanged`, `changedProjects`, `bump`).
 */
const CHANGING = new Set<string>([
  "project.addMaterial", "project.removeMaterial",
  "notes.create", "notes.rename", "notes.delete", "notes.undelete",
  "whiteboard.create", "whiteboard.rename", "whiteboard.delete",
  "mindmap.create", "mindmap.rename", "mindmap.delete",
  "draft.create", "draft.rename", "draft.delete",
  "roughcut.create", "roughcut.rename", "roughcut.delete",
]);

/** A position saved in "最近" (a project's resources are its materials, not its positions); only a resource other than the last one moves its list. */
const PROGRESS = new Set<string>(["progress.set", "progress.setPage", "progress.setTime"]);
let lastRecent: string | null = null;

export const LISTS_CHANGED_EVENT = "manga:lists-changed";
/** How long the window waits after the last change of a burst before it asks again. */
export const LISTS_CHANGED_WAIT_MS = 250;

function changes(commandId: string, input: unknown): boolean {
  if (CHANGING.has(commandId)) return true;
  if (!PROGRESS.has(commandId)) return false;
  const value = input as { contextId?: unknown; resourceId?: unknown } | null | undefined;
  if (!value || value.contextId !== null) return false;
  const resourceId = String(value.resourceId ?? "");
  if (resourceId === lastRecent) return false;
  lastRecent = resourceId;
  return true;
}

/** A command succeeded: if it changed what the lists show, the window hears of it. */
export function announceCommand(commandId: string, input: unknown): void {
  if (!changes(commandId, input) || typeof window === "undefined") return;
  window.dispatchEvent(new Event(LISTS_CHANGED_EVENT));
}

/** Called once after a burst of changes has settled. Returns the function that stops listening. */
export function onListsChanged(listener: () => void, waitMs = LISTS_CHANGED_WAIT_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const heard = () => {
    clearTimeout(timer);
    timer = setTimeout(listener, waitMs);
  };
  window.addEventListener(LISTS_CHANGED_EVENT, heard);
  return () => { clearTimeout(timer); window.removeEventListener(LISTS_CHANGED_EVENT, heard); };
}

/** Forgets the last resource read in "最近" (tests start from nothing). */
export function resetListsChanged(): void {
  lastRecent = null;
}
