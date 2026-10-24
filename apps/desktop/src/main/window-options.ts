/** Electron-free window contract so tests can check the shell without starting Electron. */
export const productWindow = {
  width: 1280,
  height: 840,
  minWidth: 360,
  minHeight: 360,
  /** The window background is the app's own frame color (`--color-frame` in styles.css); a test keeps them equal. */
  backgroundColor: "#F3F4F7",
  /**
   * No system frame and no system caption buttons (`titleBarOverlay` is not set): the page draws minimize, maximize or restore, and close itself
   * (A-91), and the top row is the height of those buttons. macOS keeps its traffic lights, which the page leaves room for.
   */
  titleBarStyle: "hidden" as const,
  /** The height of the top row and so of the window's buttons (`TOP_ROW_HEIGHT` in the shell layout). */
  topHeightPx: 36,
};

/** What the window's own buttons can ask of the main process. Nothing else, such as moving or resizing, is offered to the page. */
export const WINDOW_ACTIONS = ["minimize", "toggle-maximize", "close"] as const;
export type WindowAction = (typeof WINDOW_ACTIONS)[number];

/** The action the page asked for, if it is one of the three; the value comes from the renderer, and anything else is refused. */
export function parseWindowAction(input: unknown): WindowAction | null {
  return typeof input === "string" && (WINDOW_ACTIONS as readonly string[]).includes(input) ? input as WindowAction : null;
}

/** What the page needs to draw the buttons: whether it draws them at all (not on macOS), and whether the window is maximized now. */
export type WindowState = { controls: boolean; maximized: boolean };

export function windowControlsDrawn(platform: string): boolean {
  return platform !== "darwin";
}
