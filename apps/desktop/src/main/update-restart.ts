import fs from "node:fs";
import path from "node:path";

/** Restart marker persisted in `runtime/` right before exiting for an update restart. */
export const UPDATE_RESTART_MARKER_FILE = "update-restart.json";

/** Bounded TTL (5 minutes) so a later manual launch still opens the window normally. */
export const UPDATE_RESTART_TTL_MS = 5 * 60 * 1000;

export type LaunchArgs = {
  quitForUpdate: boolean;
  background: boolean;
};

export type UpdateRestartReason = "update" | "dev-install";

export type UpdateRestartMarker = {
  reason: UpdateRestartReason;
  windowOpen: boolean;
  fromVersion?: string;
  at: string;
};

export type StartupWindowDecision = {
  openWindow: boolean;
  consumedValidMarker: boolean;
  restartReason: UpdateRestartReason | null;
};

/** Parses lifecycle CLI flags (`--quit-for-update`, `--background`) case-insensitively. */
export function parseLaunchArgs(argv: readonly string[]): LaunchArgs {
  let quitForUpdate = false;
  let background = false;
  for (const raw of argv) {
    const flag = raw.trim().toLowerCase();
    if (flag === "--quit-for-update") quitForUpdate = true;
    else if (flag === "--background") background = true;
  }
  return { quitForUpdate, background };
}

/** Reports whether the main desktop window is currently open (not hidden/parked in the tray). */
export function isMainWindowOpen(
  win: { isDestroyed(): boolean; isVisible(): boolean } | null | undefined,
): boolean {
  return Boolean(win && !win.isDestroyed() && win.isVisible());
}

function markerPath(runtimeDir: string): string {
  return path.join(runtimeDir, UPDATE_RESTART_MARKER_FILE);
}

/** Atomically writes the bounded-TTL restart marker before exiting for an update or dev reinstall. */
export function writeUpdateRestartMarker(
  runtimeDir: string,
  input: {
    reason: UpdateRestartReason;
    windowOpen: boolean;
    fromVersion?: string;
    nowMs?: number;
  },
): boolean {
  const file = markerPath(runtimeDir);
  const nowMs = input.nowMs ?? Date.now();
  const payload: UpdateRestartMarker = {
    reason: input.reason,
    windowOpen: input.windowOpen === true,
    ...(input.fromVersion ? { fromVersion: input.fromVersion } : {}),
    at: new Date(nowMs).toISOString(),
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(temp, body, "utf8");
    try {
      fs.renameSync(temp, file);
    } catch {
      fs.writeFileSync(file, body, "utf8");
      try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

/** Removes any pending update restart marker (e.g., on install-on-quit or aborted restart). */
export function clearUpdateRestartMarker(runtimeDir: string): void {
  try {
    fs.rmSync(markerPath(runtimeDir), { force: true });
  } catch {
    // best effort
  }
}

function parseMarker(raw: unknown): UpdateRestartMarker | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.reason !== "update" && record.reason !== "dev-install") return null;
  if (typeof record.windowOpen !== "boolean") return null;
  if (typeof record.at !== "string" || !record.at.trim()) return null;
  const fromVersion = typeof record.fromVersion === "string" && record.fromVersion.trim()
    ? record.fromVersion.trim()
    : undefined;
  return {
    reason: record.reason,
    windowOpen: record.windowOpen,
    ...(fromVersion ? { fromVersion } : {}),
    at: record.at,
  };
}

/** Reads and unconditionally clears the restart marker so it can only influence one launch. */
export function consumeUpdateRestartMarker(runtimeDir: string): UpdateRestartMarker | null {
  const file = markerPath(runtimeDir);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  } finally {
    clearUpdateRestartMarker(runtimeDir);
  }
  try {
    return parseMarker(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Decides whether startup opens the main window or parks in the tray:
 * - Default: open window unless `--background` was passed.
 * - Valid restart marker (`0 <= now - at <= ttlMs`):
 *   - `reason === "update"` restores `marker.windowOpen` (open -> open window; tray -> stay in tray).
 *   - `reason === "dev-install"` with `--background` always stays tray-only, even if the window was open.
 *   - `reason === "dev-install"` without `--background` restores `marker.windowOpen`.
 * - Expired, future-dated, or missing marker falls back to `!args.background`.
 */
export function decideStartupWindow(input: {
  args: LaunchArgs;
  marker: UpdateRestartMarker | null;
  nowMs?: number;
  ttlMs?: number;
}): StartupWindowDecision {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? UPDATE_RESTART_TTL_MS;
  let openWindow = !input.args.background;
  let consumedValidMarker = false;
  let restartReason: UpdateRestartReason | null = null;

  const marker = parseMarker(input.marker);
  if (marker) {
    const atMs = Date.parse(marker.at);
    const ageMs = nowMs - atMs;
    if (Number.isFinite(atMs) && ageMs >= 0 && ageMs <= ttlMs) {
      consumedValidMarker = true;
      restartReason = marker.reason;
      if (marker.reason !== "dev-install" || !input.args.background) {
        openWindow = marker.windowOpen;
      }
    }
  }

  return { openWindow, consumedValidMarker, restartReason };
}
