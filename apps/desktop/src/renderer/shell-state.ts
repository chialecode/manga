import { createContext, useContext, useSyncExternalStore } from "react";
import type { SettingsPageId } from "./lib/shell-model.ts";

/**
 * What the window is showing beside its tabs (A-100, A-101): the settings view, which takes the sidebar and the main area, and the search box, which floats
 * over the window. Neither is a tab and neither belongs to a project; the workspace stays mounted behind them. A small store, so the openers (which are made
 * once, outside any component) and the frame (which draws it) read and change the same state.
 */
export type SettingsShell = { on: boolean; page: SettingsPageId; trail: SettingsPageId[]; index: number };
export type SearchShell = { open: boolean; query: string; scope: string | null; n: number };
export type ShellSnapshot = { settings: SettingsShell; search: SearchShell };

const OFF: SettingsShell = { on: false, page: "general", trail: [], index: -1 };

export class ShellState {
  private snapshot: ShellSnapshot = { settings: OFF, search: { open: false, query: "", scope: null, n: 0 } };
  private readonly listeners = new Set<() => void>();
  private readonly env: {
    /** The page the settings were on last, for a way in that names none. */
    lastPage: () => SettingsPageId | null;
    /** The settings came up or went away: the workspace is told it is out of sight or back. */
    onSettings: (on: boolean) => void;
    /** The view of the rail on screen, which is the scope of a search opened from it. */
    railView: () => string | null;
    onPage?: (page: SettingsPageId) => void;
  };

  constructor(env: ShellState["env"]) {
    this.env = env;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): ShellSnapshot => this.snapshot;
  private set(next: Partial<ShellSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of [...this.listeners]) listener();
  }

  // ------------------------------------------------------------------------------------------------------------------ the settings

  /** Brings the settings up on a page (or the one used last); already up, it goes to the page. */
  enterSettings(page?: SettingsPageId): void {
    const current = this.snapshot.settings;
    if (current.on) { if (page) this.goTo(page); return; }
    const first = page ?? this.env.lastPage() ?? "general";
    this.env.onSettings(true);
    this.set({ settings: { on: true, page: first, trail: [first], index: 0 }, search: { ...this.snapshot.search, open: false } });
    this.env.onPage?.(first);
  }

  /** Another page, after the ones visited: back and forward walk through them. */
  goTo(page: SettingsPageId): void {
    const current = this.snapshot.settings;
    if (!current.on) { this.enterSettings(page); return; }
    if (current.page === page) return;
    const trail = [...current.trail.slice(0, current.index + 1), page].slice(-50);
    this.set({ settings: { on: true, page, trail, index: trail.length - 1 } });
    this.env.onPage?.(page);
  }

  /** Back goes to the page before; from the first page it leaves the settings, to the workspace as it was. */
  back(): void {
    const current = this.snapshot.settings;
    if (!current.on) return;
    if (current.index <= 0) { this.leaveSettings(); return; }
    const index = current.index - 1;
    const page = current.trail[index]!;
    this.set({ settings: { ...current, page, index } });
    this.env.onPage?.(page);
  }

  forward(): void {
    const current = this.snapshot.settings;
    if (!current.on || current.index >= current.trail.length - 1) return;
    const index = current.index + 1;
    const page = current.trail[index]!;
    this.set({ settings: { ...current, page, index } });
    this.env.onPage?.(page);
  }

  canForward(): boolean {
    const current = this.snapshot.settings;
    return current.on && current.index < current.trail.length - 1;
  }

  leaveSettings(): void {
    if (!this.snapshot.settings.on) return;
    this.set({ settings: { ...OFF, page: this.snapshot.settings.page } });
    this.env.onSettings(false);
  }

  // --------------------------------------------------------------------------------------------------------------------- the search

  /** The search box opens with the scope of the view on screen (none from the home or from the settings), unless a scope is given. */
  openSearch(options: { query?: string; scope?: string | null } = {}): void {
    const view = this.snapshot.settings.on ? null : this.env.railView();
    const scope = options.scope !== undefined ? options.scope : view && view !== "home" ? view : null;
    this.set({ search: { open: true, query: options.query ?? "", scope, n: this.snapshot.search.n + 1 } });
  }

  closeSearch(): void {
    if (!this.snapshot.search.open) return;
    this.set({ search: { ...this.snapshot.search, open: false } });
  }
}

const Context = createContext<ShellState | null>(null);
export const ShellStateProvider = Context.Provider;

/** The store the window's own state (the settings view, the search box) lives in, and what it holds now. */
export function useShellState(): { state: ShellState; snapshot: ShellSnapshot } {
  const state = useContext(Context);
  if (!state) throw new Error("no shell state around this component");
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  return { state, snapshot };
}
