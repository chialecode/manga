import { BrowserWindow, screen, type WebContents } from "electron";
import { overlayDocument, parseOverlayState, placeOverlay, type Rect, type SavedRect } from "./overlay-model.ts";

/**
 * The small always-on-top box that shows a recording is running, so it stays visible when the app is behind other windows.
 * It is opened when the app window publishes a recording state and closed when the recording ends; it takes no focus, and
 * its place and size are kept in the recording settings. It shows state it is given and can ask to stop: nothing more.
 */
export class RecordingOverlay {
  private win: BrowserWindow | undefined;
  private opening: Promise<void> | undefined;
  private latest: ReturnType<typeof parseOverlayState> = null;
  private moveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: {
    preload: string;
    readRect: () => Promise<SavedRect>;
    saveRect: (rect: Rect) => void;
    onStopRequest: () => void;
  }) {}

  owns(contents: WebContents): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.webContents === contents);
  }

  requestStop(): void {
    this.deps.onStopRequest();
  }

  /** A state to show, or `null` (or anything that is not a state) to close the box. */
  async publish(raw: unknown): Promise<void> {
    const state = raw === null ? null : parseOverlayState(raw);
    if (!state) {
      this.close();
      return;
    }
    this.latest = state;
    if (!this.win || this.win.isDestroyed()) {
      this.opening ??= this.open().finally(() => { this.opening = undefined; });
      await this.opening;
    }
    if (this.latest && this.win && !this.win.isDestroyed()) this.win.webContents.send("manga:overlay-state", this.latest);
  }

  close(): void {
    this.latest = null;
    clearTimeout(this.moveTimer);
    const win = this.win;
    this.win = undefined;
    if (win && !win.isDestroyed()) win.close();
  }

  private async open(): Promise<void> {
    const rect = placeOverlay(await this.deps.readRect(), screen.getAllDisplays().map((display) => display.workArea), screen.getPrimaryDisplay().workArea);
    const win = new BrowserWindow({
      ...rect,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      title: "MANGA",
      webPreferences: { preload: this.deps.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
    });
    this.win = win;
    win.setAlwaysOnTop(true, "screen-saver");
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("moved", () => {
      clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => {
        if (win.isDestroyed()) return;
        const bounds = win.getBounds();
        this.deps.saveRect({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
      }, 400);
    });
    win.on("closed", () => { if (this.win === win) this.win = undefined; });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayDocument())}`);
    if (!win.isDestroyed()) win.showInactive();
  }
}
