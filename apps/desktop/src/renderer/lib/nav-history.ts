/**
 * The window's page history (A-70): what the title bar's back and forward walk through. A location says how to bring a page back, not what
 * was on it: a shelf, a work's page, an opened resource (it comes back at its saved place), a settings page, a note, a project.
 */
export type NavLocation =
  | { kind: "page"; page: string }
  | { kind: "work"; workId: string }
  | { kind: "resource"; resourceId: string; mediaKind: "novel" | "comic" | "video"; workId: string | null }
  | { kind: "settings"; page: string }
  | { kind: "note"; objectId: string }
  | { kind: "project"; projectId: string | null; tab: string };

export type NavHistory = { entries: NavLocation[]; index: number };

export const NAV_LIMIT = 60;

export const emptyHistory = (): NavHistory => ({ entries: [], index: -1 });

/** Two locations are the same place when they would bring back the same page. */
export function locationKey(location: NavLocation): string {
  switch (location.kind) {
    case "page": return `page:${location.page}`;
    case "work": return `work:${location.workId}`;
    case "resource": return `resource:${location.resourceId}`;
    case "settings": return `settings:${location.page}`;
    case "note": return `note:${location.objectId}`;
    case "project": return `project:${location.projectId ?? ""}`;
  }
}

/** A new place after the current one; whatever was ahead is dropped, and the same place twice in a row is one entry. */
export function visit(history: NavHistory, location: NavLocation): NavHistory {
  const current = history.entries[history.index];
  if (current && locationKey(current) === locationKey(location)) {
    // The same place with fresher facts (a resource whose work became known): keep the entry, take the newer description.
    const entries = history.entries.slice();
    entries[history.index] = location;
    return { entries, index: history.index };
  }
  const kept = history.entries.slice(0, history.index + 1);
  kept.push(location);
  const trimmed = kept.length > NAV_LIMIT ? kept.slice(kept.length - NAV_LIMIT) : kept;
  return { entries: trimmed, index: trimmed.length - 1 };
}

export const canBack = (history: NavHistory): boolean => history.index > 0;
export const canForward = (history: NavHistory): boolean => history.index >= 0 && history.index < history.entries.length - 1;

/** One step back or forward; the place to go to, and the history that is now at it. Null at either end. */
export function step(history: NavHistory, direction: -1 | 1): { to: NavLocation; history: NavHistory } | null {
  const index = history.index + direction;
  const to = history.entries[index];
  if (!to) return null;
  return { to, history: { entries: history.entries, index } };
}
