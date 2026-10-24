import { DEFAULT_SHELL_PREFERENCE, type ShellPreference } from "@manga/contracts/reading";

export type ShellViewport = { width: number; height: number };
export type OverlaySide = "sidebar" | "dock" | null;

export type ShellChrome = {
  sidebar: "dock" | "overlay" | "hidden";
  dock: "dock" | "overlay" | "hidden";
  railWidth: number;
  sidebarWidth: number;
  dockWidth: number;
  /** The width the tabbed main area has, beside the icon rail and whichever columns are docked. */
  mainWidth: number;
  compact: boolean;
  showSidebarButton: boolean;
  showDockButton: boolean;
  measurePx: number;
};

/** The icon rail's width and the top row's height (A-94); the window's own buttons are as high as the top row. */
export const RAIL_WIDTH = 48;
export const TOP_ROW_HEIGHT = 36;

/** The narrowest the tabbed main area may be before a docked column folds into an overlay: one column of the split (320) with room to read beside it. */
export const MAIN_FLOOR = 560;

/** Below this window width every side column is an overlay. */
const NARROW_WINDOW = 960;

/** How wide each side column may be (A-94). The defaults are what a double click on a divider restores. */
export const SIDE_WIDTH = {
  sidebar: { min: 200, max: 400, initial: 260 },
  dock: { min: 320, max: 640, initial: 360 },
} as const;

export function clampSide(side: "sidebar" | "dock", width: number): number {
  return clamp(Math.round(width), SIDE_WIDTH[side].min, SIDE_WIDTH[side].max);
}

/** The widest a column can be dragged to while the main area keeps its floor beside the rail and the other column. */
export function dragLimit(side: "sidebar" | "dock", viewportWidth: number, otherDockedWidth: number, mainFloor = MAIN_FLOOR): number {
  return Math.max(SIDE_WIDTH[side].min, Math.min(SIDE_WIDTH[side].max, viewportWidth - RAIL_WIDTH - otherDockedWidth - mainFloor));
}

/**
 * Where the side columns go for a window of this size: a column that was asked for is docked when the main area keeps its floor, otherwise it
 * folds into an overlay, the dock first and then the sidebar (UI-01, narrow windows). A layout of several columns asks the main area for more than the
 * default floor (`mainFloor`), so the side columns fold before the columns of the split have to.
 */
export function deriveShell(input: {
  viewport: ShellViewport;
  preference: ShellPreference;
  hasDock: boolean;
  overlay: OverlaySide;
  mainFloor?: number;
}): ShellChrome {
  const { viewport, preference } = input;
  const floor = Math.max(MAIN_FLOOR, input.mainFloor ?? 0);
  const sidebarWidth = clampSide("sidebar", preference.sidebar.width);
  const dockWidth = input.hasDock ? clampSide("dock", preference.dock.width) : 0;
  const wantSidebar = preference.sidebar.visible;
  const wantDock = input.hasDock && preference.dock.visible;
  const room = viewport.width - RAIL_WIDTH;
  let dockSidebar = wantSidebar;
  let dockDock = wantDock;
  if (dockSidebar && dockDock && room - sidebarWidth - dockWidth < floor) {
    dockDock = false;
    if (room - sidebarWidth < floor) dockSidebar = false;
  } else if (dockSidebar && room - sidebarWidth < floor) dockSidebar = false;
  else if (dockDock && room - dockWidth < floor) dockDock = false;
  if (viewport.width < NARROW_WINDOW) {
    dockSidebar = false;
    dockDock = false;
  }
  const sidebar: ShellChrome["sidebar"] = dockSidebar ? "dock" : input.overlay === "sidebar" ? "overlay" : "hidden";
  let dock: ShellChrome["dock"] = dockDock ? "dock" : input.overlay === "dock" ? "overlay" : "hidden";
  if (sidebar === "overlay" && dock === "overlay") dock = "hidden";
  const usedSidebar = sidebar === "dock" ? sidebarWidth : 0;
  const usedDock = dock === "dock" ? dockWidth : 0;
  return {
    sidebar,
    dock,
    railWidth: RAIL_WIDTH,
    sidebarWidth: Math.min(sidebarWidth, Math.max(0, viewport.width - 32)),
    dockWidth: Math.min(dockWidth, Math.max(0, viewport.width - 32)),
    mainWidth: Math.max(0, viewport.width - RAIL_WIDTH - usedSidebar - usedDock),
    compact: viewport.height < 640,
    showSidebarButton: sidebar !== "dock",
    showDockButton: input.hasDock && dock !== "dock",
    measurePx: preference.reading.measurePx,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** What a hover or a pin brings out: the dock's overlay, or the card of one view of the rail (`card:<view>`, A-99). */
export type HoverTarget = "sidebar" | "dock" | `card:${string}`;
export type HoverState = {
  inside: boolean;
  overlay: HoverTarget | null;
  pinned: HoverTarget | null;
  closeAt: number | null;
  /** A card that waits for the pointer to stay (`openAt`) before it comes out. */
  pending: HoverTarget | null;
  openAt: number | null;
};

export function initialHover(): HoverState {
  return { inside: false, overlay: null, pinned: null, closeAt: null, pending: null, openAt: null };
}

/** The pointer stays on an icon this long before its card comes out, and this long when another card is out already (moving from icon to icon). */
export const CARD_OPEN_MS = 150;
export const CARD_SWAP_MS = 60;

export const cardOf = (view: string): HoverTarget => `card:${view}`;
export const viewOfCard = (target: HoverTarget | null): string | null => (target?.startsWith("card:") ? target.slice(5) : null);

type HoverEvent = { type: "enter" | "leave" | "pin" | "escape" | "tick"; side?: "sidebar" | "dock"; view?: string; now: number };

/**
 * The overlay a pointer or a key brings out, one at a time: a side column of the window (the dock) comes out at once, the card of a view of the rail
 * only after the pointer stays (at once when `openMs` is 0: the sidebar's own switch), sooner when another card is out. Leaving starts a short wait before it goes, and coming back (to the icon, or onto the
 * card) cancels it. A pinned overlay (the key, the button) stays until the next pin, Esc, or a choice.
 */
export function reduceHover(state: HoverState, event: HoverEvent, delayMs = 180, openMs = CARD_OPEN_MS): HoverState {
  const target: HoverTarget | null = event.view !== undefined ? cardOf(event.view) : (event.side ?? null);
  const card = target !== null && target.startsWith("card:");
  if (event.type === "pin" && target) {
    const pinned = state.pinned === target ? null : target;
    return { inside: true, overlay: pinned, pinned, closeAt: null, pending: null, openAt: null };
  }
  if (event.type === "escape") return initialHover();
  if (event.type === "enter" && target) {
    if (state.pinned && state.pinned !== target) return { ...state, inside: true, closeAt: null, pending: null, openAt: null };
    if (card && state.overlay !== target && !state.pinned) {
      const wait = state.overlay ? Math.min(CARD_SWAP_MS, openMs) : openMs;
      if (wait > 0) return { ...state, inside: true, closeAt: null, pending: target, openAt: event.now + wait };
    }
    return { ...state, inside: true, overlay: state.pinned ?? target, closeAt: null, pending: null, openAt: null };
  }
  if (event.type === "leave") {
    if (state.pinned) return { ...state, inside: false, overlay: state.pinned, closeAt: null, pending: null, openAt: null };
    return { ...state, inside: false, closeAt: event.now + delayMs, pending: null, openAt: null };
  }
  if (state.pending && state.openAt !== null && event.now >= state.openAt && state.inside) {
    return { ...state, overlay: state.pending, pending: null, openAt: null, closeAt: null };
  }
  if (state.closeAt !== null && event.now >= state.closeAt && !state.inside && !state.pinned) {
    return { ...state, overlay: null, closeAt: null };
  }
  return state;
}

// ------------------------------------------------------------------------------------------------------------------------ the icon rail

/** One icon's slot in the rail: a 36 px button and the 4 px gap under it; the rail pads its top (4) and bottom (8). */
export const RAIL_SLOT = 40;
const RAIL_PADDING = 12;

/**
 * Which icons the rail shows for a window of this height, and which go behind "…" (A-99): the ones the person took out, and the ones that do not fit.
 * `views` is the rail's order with the home first; the home is never taken out. Settings sits at the bottom and always has its slot; "…" has a slot of
 * its own whenever there is anything to list in it. A view kept as hidden whose module is off now is not in `views` and takes no part.
 */
export function railLayout(input: { height: number; views: readonly string[]; hidden: readonly string[]; settings: boolean }): { shown: string[]; more: Array<{ view: string; why: "hidden" | "space" }> } {
  const hiddenSet = new Set(input.hidden.filter((view) => view !== input.views[0] && input.views.includes(view)));
  const room = input.height - TOP_ROW_HEIGHT - RAIL_PADDING - (input.settings ? RAIL_SLOT : 0);
  const slots = Math.max(1, Math.floor(room / RAIL_SLOT));
  const candidates = input.views.filter((view) => !hiddenSet.has(view));
  const needsMore = hiddenSet.size > 0 || candidates.length > slots;
  const capacity = Math.max(1, needsMore ? slots - 1 : slots);
  const shown = candidates.slice(0, capacity);
  const kept = new Set(shown);
  const more = input.views.filter((view) => !kept.has(view)).map((view) => ({ view, why: (hiddenSet.has(view) ? "hidden" : "space") as "hidden" | "space" }));
  return { shown, more };
}

export function defaultShell(): ShellPreference {
  return structuredClone(DEFAULT_SHELL_PREFERENCE);
}
