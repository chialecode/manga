import { DEFAULT_SHELL_PREFERENCE, type ShellPreference, type WorkMode } from "@manga/contracts/reading";

export type ShellViewport = { width: number; height: number };
export type OverlaySide = "left" | "right" | null;

export type ShellChrome = {
  left: "dock" | "overlay" | "hidden";
  right: "dock" | "overlay" | "hidden";
  leftWidth: number;
  rightWidth: number;
  mainWidth: number;
  compact: boolean;
  showLeftButton: boolean;
  showRightButton: boolean;
  measurePx: number;
};

const MAIN_TARGET = 640;

export function deriveShell(input: {
  viewport: ShellViewport;
  preference: ShellPreference;
  hasRight: boolean;
  overlay: OverlaySide;
}): ShellChrome {
  const mode = input.preference.layouts[input.preference.mode];
  const leftWidth = clamp(mode.left.width, 200, 280);
  const rightWidth = input.hasRight ? clamp(mode.right.width, 320, 480) : 0;
  const focus = mode.focus;
  const wantLeft = mode.left.visible && !focus;
  const wantRight = input.hasRight && mode.right.visible && !focus;
  let dockLeft = wantLeft;
  let dockRight = wantRight;
  if (dockLeft && dockRight && input.viewport.width - leftWidth - rightWidth < MAIN_TARGET) {
    dockRight = false;
    if (input.viewport.width - leftWidth < MAIN_TARGET) dockLeft = false;
  } else if (dockLeft && input.viewport.width - leftWidth < MAIN_TARGET) dockLeft = false;
  else if (dockRight && input.viewport.width - rightWidth < MAIN_TARGET) dockRight = false;
  if (input.viewport.width < 960) {
    dockLeft = false;
    dockRight = false;
  }
  const overlay = input.overlay;
  const left: ShellChrome["left"] = dockLeft ? "dock" : overlay === "left" ? "overlay" : "hidden";
  let right: ShellChrome["right"] = dockRight ? "dock" : overlay === "right" ? "overlay" : "hidden";
  if (left === "overlay" && right === "overlay") right = "hidden";
  const usedLeft = left === "dock" ? leftWidth : 0;
  const usedRight = right === "dock" ? rightWidth : 0;
  return {
    left,
    right,
    leftWidth: Math.min(leftWidth, Math.max(0, input.viewport.width - 32)),
    rightWidth: Math.min(rightWidth, Math.max(0, input.viewport.width - 32)),
    mainWidth: Math.max(0, input.viewport.width - usedLeft - usedRight),
    compact: input.viewport.height < 640,
    showLeftButton: left !== "dock",
    showRightButton: input.hasRight && right !== "dock",
    measurePx: input.preference.reading.measurePx,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export type HoverState = { inside: boolean; overlay: OverlaySide; pinned: OverlaySide; closeAt: number | null };

export function initialHover(): HoverState {
  return { inside: false, overlay: null, pinned: null, closeAt: null };
}

export function reduceHover(state: HoverState, event: { type: "enter" | "leave" | "pin" | "escape" | "tick"; side?: "left" | "right"; now: number }, delayMs = 180): HoverState {
  if (event.type === "pin" && event.side) {
    const pinned = state.pinned === event.side ? null : event.side;
    return { inside: true, overlay: pinned, pinned, closeAt: null };
  }
  if (event.type === "escape") return { ...state, inside: false, overlay: null, pinned: null, closeAt: null };
  if (event.type === "enter" && event.side) {
    if (state.pinned && state.pinned !== event.side) return { ...state, inside: true, closeAt: null };
    return { ...state, inside: true, overlay: state.pinned ?? event.side, closeAt: null };
  }
  if (event.type === "leave") {
    if (state.pinned) return { ...state, inside: false, overlay: state.pinned, closeAt: null };
    return { ...state, inside: false, closeAt: event.now + delayMs };
  }
  if (state.closeAt !== null && event.now >= state.closeAt && !state.inside && !state.pinned) {
    return { ...state, overlay: null, closeAt: null };
  }
  return state;
}

export function shellForMode(preference: ShellPreference, mode: WorkMode): ShellPreference {
  return { ...preference, mode };
}

export function defaultShell(): ShellPreference {
  return structuredClone(DEFAULT_SHELL_PREFERENCE);
}
