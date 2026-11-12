import fs from "node:fs";
import path from "node:path";

/** Where light windows open (6 界面要点): 960×600 the first time, then the size and place of the last one, in light open's own folder. */
export type LightWindowState = { x?: number; y?: number; width: number; height: number; maximized: boolean };
export type Area = { x: number; y: number; width: number; height: number };

export const DEFAULT_LIGHT_BOUNDS: LightWindowState = { width: 960, height: 600, maximized: false };
const CASCADE_PX = 28;
const MIN_VISIBLE_PX = 120;

export function readWindowState(file: string): LightWindowState | null {
  try {
    const body = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LightWindowState>;
    if (typeof body.width !== "number" || typeof body.height !== "number" || body.width < 200 || body.height < 150) return null;
    return {
      width: Math.round(body.width), height: Math.round(body.height), maximized: body.maximized === true,
      ...(typeof body.x === "number" && typeof body.y === "number" ? { x: Math.round(body.x), y: Math.round(body.y) } : {}),
    };
  } catch {
    return null;
  }
}

export function writeWindowState(file: string, state: LightWindowState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* the next move writes it again */ }
}

/**
 * The bounds of a new window: the remembered ones, moved down and right for each window already open, and brought back onto a screen when the
 * remembered place is on a display that is gone. Without a remembered place Electron centres the window.
 */
export function placeWindow(state: LightWindowState, displays: readonly Area[], open: number): { x?: number; y?: number; width: number; height: number } {
  const width = state.width;
  const height = state.height;
  if (state.x === undefined || state.y === undefined) {
    const area = displays[0];
    if (!area || open === 0) return { width, height };
    return { x: area.x + Math.round((area.width - width) / 2) + open * CASCADE_PX, y: area.y + Math.round((area.height - height) / 2) + open * CASCADE_PX, width, height };
  }
  let x = state.x + open * CASCADE_PX;
  let y = state.y + open * CASCADE_PX;
  const visible = displays.some((area) => x + MIN_VISIBLE_PX <= area.x + area.width && x + width - MIN_VISIBLE_PX >= area.x && y >= area.y - 8 && y + MIN_VISIBLE_PX <= area.y + area.height);
  if (!visible && displays[0]) {
    const area = displays[0];
    x = area.x + Math.max(0, Math.round((area.width - width) / 2));
    y = area.y + Math.max(0, Math.round((area.height - height) / 2));
  }
  return { x, y, width, height };
}

/** The file named after `--manga-light`, or null for an empty window. Chromium's own switches are skipped. */
export function fileArgument(argv: readonly string[]): string | null {
  const at = argv.indexOf("--manga-light");
  if (at < 0) return null;
  const rest = argv.slice(at + 1).filter((arg) => !arg.startsWith("--"));
  return rest[0] ? path.resolve(rest[0]) : null;
}
