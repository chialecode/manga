import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UPDATE_RESTART_MARKER_FILE,
  UPDATE_RESTART_TTL_MS,
  clearUpdateRestartMarker,
  consumeUpdateRestartMarker,
  decideStartupWindow,
  isMainWindowOpen,
  parseLaunchArgs,
  writeUpdateRestartMarker,
  type LaunchArgs,
  type UpdateRestartMarker,
} from "../../apps/desktop/src/main/update-restart.ts";

const tempDirs: string[] = [];

function makeRuntimeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-update-restart-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("update restart marker and startup window decision", () => {
  it("parses --background and --quit-for-update case-insensitively", () => {
    expect(parseLaunchArgs([])).toEqual({ quitForUpdate: false, background: false });
    expect(parseLaunchArgs(["--background"])).toEqual({ quitForUpdate: false, background: true });
    expect(parseLaunchArgs(["  --BACKGROUND ", "--Quit-For-Update"])).toEqual({ quitForUpdate: true, background: true });
    expect(parseLaunchArgs(["--manga-smoke"])).toEqual({ quitForUpdate: false, background: false });
  });

  it("detects whether the main window is open versus hidden in the tray or destroyed", () => {
    expect(isMainWindowOpen(null)).toBe(false);
    expect(isMainWindowOpen(undefined)).toBe(false);
    expect(isMainWindowOpen({ isDestroyed: () => false, isVisible: () => true })).toBe(true);
    expect(isMainWindowOpen({ isDestroyed: () => false, isVisible: () => false })).toBe(false);
    expect(isMainWindowOpen({ isDestroyed: () => true, isVisible: () => true })).toBe(false);
  });

  it("writes, consumes once, and clears corrupt or stale markers atomically", () => {
    const runtimeDir = makeRuntimeDir();
    const fixedNow = Date.parse("2026-11-22T02:00:00.000Z");

    expect(
      writeUpdateRestartMarker(runtimeDir, {
        reason: "update",
        windowOpen: false,
        fromVersion: "0.1.1",
        nowMs: fixedNow,
      }),
    ).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, UPDATE_RESTART_MARKER_FILE))).toBe(true);

    const first = consumeUpdateRestartMarker(runtimeDir);
    expect(first).toEqual({
      reason: "update",
      windowOpen: false,
      fromVersion: "0.1.1",
      at: "2026-11-22T02:00:00.000Z",
    });
    expect(fs.existsSync(path.join(runtimeDir, UPDATE_RESTART_MARKER_FILE))).toBe(false);
    expect(consumeUpdateRestartMarker(runtimeDir)).toBeNull();

    // Corrupt JSON is deleted on consume and never blocks normal startup.
    fs.writeFileSync(path.join(runtimeDir, UPDATE_RESTART_MARKER_FILE), "{not-json", "utf8");
    expect(consumeUpdateRestartMarker(runtimeDir)).toBeNull();
    expect(fs.existsSync(path.join(runtimeDir, UPDATE_RESTART_MARKER_FILE))).toBe(false);

    // Invalid schema is also deleted on consume.
    fs.writeFileSync(
      path.join(runtimeDir, UPDATE_RESTART_MARKER_FILE),
      JSON.stringify({ reason: "unknown", windowOpen: false, at: "2026-11-22T02:00:00.000Z" }),
      "utf8",
    );
    expect(consumeUpdateRestartMarker(runtimeDir)).toBeNull();
    expect(fs.existsSync(path.join(runtimeDir, UPDATE_RESTART_MARKER_FILE))).toBe(false);

    // Explicit clear removes a pending marker (used by install-on-quit and failed restart).
    writeUpdateRestartMarker(runtimeDir, { reason: "update", windowOpen: false, nowMs: fixedNow });
    clearUpdateRestartMarker(runtimeDir);
    expect(fs.existsSync(path.join(runtimeDir, UPDATE_RESTART_MARKER_FILE))).toBe(false);
  });

  it("matches the full startup truth table across release update restarts, dev-install --background, and TTL bounds", () => {
    const baseMs = Date.parse("2026-11-22T02:00:00.000Z");
    const markerAt = (reason: UpdateRestartMarker["reason"], windowOpen: boolean, offsetMs = 0): UpdateRestartMarker => ({
      reason,
      windowOpen,
      fromVersion: "0.1.1",
      at: new Date(baseMs + offsetMs).toISOString(),
    });
    const args = (background: boolean): LaunchArgs => ({ quitForUpdate: false, background });

    // 1. Plain launch without marker opens the window; --background parks in the tray.
    expect(decideStartupWindow({ args: args(false), marker: null, nowMs: baseMs })).toEqual({
      openWindow: true,
      consumedValidMarker: false,
      restartReason: null,
    });
    expect(decideStartupWindow({ args: args(true), marker: null, nowMs: baseMs })).toEqual({
      openWindow: false,
      consumedValidMarker: false,
      restartReason: null,
    });

    // 2. Release update restart restores prior window state: open -> opens window, tray -> stays in tray.
    expect(
      decideStartupWindow({
        args: args(false),
        marker: markerAt("update", true),
        nowMs: baseMs + 10_000,
      }),
    ).toEqual({
      openWindow: true,
      consumedValidMarker: true,
      restartReason: "update",
    });
    expect(
      decideStartupWindow({
        args: args(false),
        marker: markerAt("update", false),
        nowMs: baseMs + 10_000,
      }),
    ).toEqual({
      openWindow: false,
      consumedValidMarker: true,
      restartReason: "update",
    });
    // Even if a release update relaunch carried --background, the recorded release update state wins.
    expect(
      decideStartupWindow({
        args: args(true),
        marker: markerAt("update", true),
        nowMs: baseMs + 10_000,
      }),
    ).toEqual({
      openWindow: true,
      consumedValidMarker: true,
      restartReason: "update",
    });

    // 3. Dev-install restart with --background ALWAYS stays tray-only, even when the window was open before.
    expect(
      decideStartupWindow({
        args: args(true),
        marker: markerAt("dev-install", true),
        nowMs: baseMs + 10_000,
      }),
    ).toEqual({
      openWindow: false,
      consumedValidMarker: true,
      restartReason: "dev-install",
    });
    expect(
      decideStartupWindow({
        args: args(true),
        marker: markerAt("dev-install", false),
        nowMs: baseMs + 10_000,
      }),
    ).toEqual({
      openWindow: false,
      consumedValidMarker: true,
      restartReason: "dev-install",
    });
    // Without --background (e.g., isolated test identity), dev-install restores the recorded window state.
    expect(
      decideStartupWindow({
        args: args(false),
        marker: markerAt("dev-install", true),
        nowMs: baseMs + 10_000,
      }),
    ).toEqual({
      openWindow: true,
      consumedValidMarker: true,
      restartReason: "dev-install",
    });

    // 4. Exact 5-minute TTL boundary stays valid; expired (> 5 min) or future-dated markers fall back to normal launch.
    expect(UPDATE_RESTART_TTL_MS).toBe(5 * 60 * 1000);
    expect(
      decideStartupWindow({
        args: args(false),
        marker: markerAt("update", false),
        nowMs: baseMs + UPDATE_RESTART_TTL_MS,
      }),
    ).toEqual({
      openWindow: false,
      consumedValidMarker: true,
      restartReason: "update",
    });
    expect(
      decideStartupWindow({
        args: args(false),
        marker: markerAt("update", false),
        nowMs: baseMs + UPDATE_RESTART_TTL_MS + 1,
      }),
    ).toEqual({
      openWindow: true,
      consumedValidMarker: false,
      restartReason: null,
    });
    expect(
      decideStartupWindow({
        args: args(false),
        marker: markerAt("update", false, 5_000),
        nowMs: baseMs,
      }),
    ).toEqual({
      openWindow: true,
      consumedValidMarker: false,
      restartReason: null,
    });
  });

  it("wires restart-marker capture, consumption, and install-on-quit isolation in the main entry and quit-for-update controller", () => {
    const mainSource = fs.readFileSync(new URL("../../apps/desktop/src/main/index.ts", import.meta.url), "utf8");
    const quitSource = fs.readFileSync(new URL("../../apps/desktop/src/main/quit-for-update.ts", import.meta.url), "utf8");

    // Marker is consumed only after the single-instance lock succeeds (never stolen by a second instance).
    const lockIndex = mainSource.indexOf("app.requestSingleInstanceLock(");
    const consumeIndex = mainSource.indexOf("consumeUpdateRestartMarker(");
    expect(lockIndex).toBeGreaterThan(0);
    expect(consumeIndex).toBeGreaterThan(lockIndex);

    // Release restart records windowOpen with reason "update"; install-on-quit clears any marker and does not reopen.
    expect(mainSource).toContain('reason: "update"');
    expect(mainSource).toContain("clearUpdateRestartMarker(layout.partitions.runtime)");
    expect(mainSource).toContain("quitting: quitting || preparingUpdate");
    expect(mainSource).toContain("if (startInTray && !windowTray.parkInTray())");

    // Dev quit-for-update captures windowOpen before teardown and records reason "dev-install".
    expect(quitSource).toContain("isMainWindowOpen(");
    expect(quitSource).toContain('reason: "dev-install"');
  });
});
