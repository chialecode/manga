import { BrowserWindow, screen, type WebContents } from "electron";
import {
  OVERLAY_STOP_HIT_X,
  overlayDocument,
  parseOverlayState,
  placeOverlay,
  type OverlayPos,
  type SavedRect,
} from "./overlay-model.ts";

/**
 * The compact always-on-top 116×36 status pill shown while a recording is running, so it stays visible behind other windows.
 * It takes no focus (`focusable: false`), remembers only its `(x, y)` coordinates, flushes any pending position save on drag
 * end (`moved` / `mouseUp`) AND synchronously before closing, and exposes no capability beyond receiving state and asking to stop.
 */
export class RecordingOverlay {
  private win: BrowserWindow | undefined;
  private opening: Promise<void> | undefined;
  private latest: ReturnType<typeof parseOverlayState> = null;
  private moveTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPos: OverlayPos | undefined;
  private lastSaved: OverlayPos | undefined;
  private dirty = false;

  constructor(private readonly deps: {
    preload: string;
    readRect: () => Promise<SavedRect>;
    saveRect: (pos: OverlayPos) => void;
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

  private flushSave(): void {
    clearTimeout(this.moveTimer);
    this.moveTimer = undefined;
    if (!this.dirty || !this.lastPos) return;
    if (this.lastSaved && this.lastSaved.x === this.lastPos.x && this.lastSaved.y === this.lastPos.y) {
      this.dirty = false;
      return;
    }
    const next = { x: Math.round(this.lastPos.x), y: Math.round(this.lastPos.y) };
    this.lastSaved = next;
    this.dirty = false;
    this.deps.saveRect(next);
  }

  close(): void {
    this.latest = null;
    const win = this.win;
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      if (!this.lastPos || bounds.x !== this.lastPos.x || bounds.y !== this.lastPos.y) {
        if (!this.lastSaved || bounds.x !== this.lastSaved.x || bounds.y !== this.lastSaved.y) {
          this.lastPos = { x: bounds.x, y: bounds.y };
          this.dirty = true;
        }
      }
    }
    this.flushSave();
    this.win = undefined;
    if (win && !win.isDestroyed()) win.close();
  }

  private workAreas() {
    return {
      areas: screen.getAllDisplays().map((display) => display.workArea),
      primary: screen.getPrimaryDisplay().workArea,
    };
  }

  private async open(): Promise<void> {
    const { areas, primary } = this.workAreas();
    const rect = placeOverlay(await this.deps.readRect(), areas, primary);
    this.lastPos = { x: rect.x, y: rect.y };
    this.lastSaved = { x: rect.x, y: rect.y };
    this.dirty = false;
    const win = new BrowserWindow({
      ...rect,
      minWidth: 1,
      minHeight: 1,
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
    win.setMinimumSize(1, 1);
    win.setBounds(rect);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());

    const notePosition = (x: number, y: number) => {
      if (!this.lastPos || x !== this.lastPos.x || y !== this.lastPos.y) {
        this.lastPos = { x, y };
        this.dirty = !this.lastSaved || x !== this.lastSaved.x || y !== this.lastSaved.y;
      }
    };

    let grab: { x: number; y: number; moved: boolean } | null = null;
    win.webContents.on("input-event", (_event, input) => {
      if (win.isDestroyed()) return;
      const ev = input as { type?: string; button?: string; x?: number; y?: number };
      if (ev.type === "mouseDown" && ev.button === "left" && typeof ev.x === "number" && typeof ev.y === "number") {
        grab = ev.x < OVERLAY_STOP_HIT_X ? { x: ev.x, y: ev.y, moved: false } : null;
      } else if (ev.type === "mouseMove" && grab && typeof ev.x === "number" && typeof ev.y === "number") {
        const dx = ev.x - grab.x;
        const dy = ev.y - grab.y;
        if (grab.moved || Math.hypot(dx, dy) >= 2) {
          grab.moved = true;
          const bounds = win.getBounds();
          const nextX = Math.round(bounds.x + dx);
          const nextY = Math.round(bounds.y + dy);
          if (nextX !== bounds.x || nextY !== bounds.y) {
            win.setPosition(nextX, nextY);
            notePosition(nextX, nextY);
          }
        }
      } else if (ev.type === "mouseUp" && grab) {
        const moved = grab.moved;
        grab = null;
        if (moved && !win.isDestroyed()) {
          const bounds = win.getBounds();
          const current = this.workAreas();
          const clamped = placeOverlay({ x: bounds.x, y: bounds.y }, current.areas, current.primary);
          if (clamped.x !== bounds.x || clamped.y !== bounds.y) win.setPosition(clamped.x, clamped.y);
          notePosition(clamped.x, clamped.y);
          this.flushSave();
        }
      }
    });

    win.on("move", () => {
      if (win.isDestroyed()) return;
      const bounds = win.getBounds();
      notePosition(bounds.x, bounds.y);
      if (!this.dirty) return;
      clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => {
        if (!win.isDestroyed()) this.flushSave();
      }, 150);
    });
    win.on("moved", () => {
      if (win.isDestroyed()) return;
      const bounds = win.getBounds();
      notePosition(bounds.x, bounds.y);
      this.flushSave();
    });
    win.on("closed", () => {
      this.flushSave();
      if (this.win === win) this.win = undefined;
    });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayDocument())}`);
    if (!win.isDestroyed()) win.showInactive();
  }
}
