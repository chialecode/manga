/**
 * What a shelf remembers while the user is on a work's page and comes back (A-47): the tab, sort, search and filters, and how far the
 * list was scrolled. It lives for the session of the window; a shelf that was never opened starts from the defaults.
 */
export type ShelfMemory = {
  tab: string;
  sort: "recent" | "added" | "title" | "progress";
  text: string;
  linked: "any" | "yes" | "no";
  notes: "any" | "yes" | "no";
  format: string;
  scrollTop: number;
};

export const DEFAULT_SHELF_MEMORY: ShelfMemory = { tab: "all", sort: "recent", text: "", linked: "any", notes: "any", format: "", scrollTop: 0 };

const memory = new Map<string, ShelfMemory>();

export const shelfMemory = {
  get(key: string): ShelfMemory { return memory.get(key) ?? DEFAULT_SHELF_MEMORY; },
  patch(key: string, patch: Partial<ShelfMemory>): void { memory.set(key, { ...shelfMemory.get(key), ...patch }); },
  /** For tests. */
  reset(): void { memory.clear(); },
};
