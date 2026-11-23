import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Channel } from "@manga/contracts";
import type { MangaProductApp } from "@manga/app-core";
import { launchSucceeded } from "./launch-guard.ts";
import { isMainWindowOpen, writeUpdateRestartMarker } from "./update-restart.ts";

/**
 * Coordinates `running-instance.json`, `--quit-for-update` handshakes, and background polling
 * for dev/release installer handoffs (`apps/desktop/src/main/index.ts`).
 */

export type QuitForUpdateController = {
  readonly quitSignalFile: string;
  readonly quitAckFile: string;
  readonly releaseBlockingFile: string;
  writeRunningInstance(state: "starting" | "ready", extras?: Record<string, unknown>): void;
  cleanupInstanceFiles(): void;
  handleQuitForUpdate(): Promise<void>;
  clearStaleSignalFiles(): void;
  startPolling(isUpdateDriver: () => boolean): void;
};

/** Writes the `--quit-for-update` signal file and notifies any running instance via single-instance lock. */
export function signalQuitForUpdateAndExit(input: {
  runtimeDir: string;
  channel: Channel;
  testIdentity: boolean;
}): void {
  const quitSignalFile = path.join(input.runtimeDir, "quit-for-update.json");
  try {
    fs.mkdirSync(input.runtimeDir, { recursive: true });
    if (!fs.existsSync(quitSignalFile) && !process.env.MANGA_DEV_QUIT_REQUEST_ID) {
      fs.writeFileSync(
        quitSignalFile,
        `${JSON.stringify({ requestedAt: new Date().toISOString(), pid: process.pid, channel: input.channel, testIdentity: input.testIdentity })}\n`,
      );
    }
  } catch {
    // ignore if runtime directory is not writable
  }
  try {
    app.requestSingleInstanceLock({ quitForUpdate: true, channel: input.channel, testIdentity: input.testIdentity });
  } catch {
    // ignore
  }
  app.exit(0);
}

export function createQuitForUpdateController(input: {
  runtimeDir: string;
  writable: boolean;
  quitForUpdateFlag: boolean;
  channel: Channel;
  testIdentity: boolean;
  version: string;
  getAppService: () => MangaProductApp | undefined;
  clearAppService: () => void;
  getWindow: () => Electron.BrowserWindow | undefined;
  flushWindowSaves: (options?: { strict?: boolean; signal?: AbortSignal }) => Promise<void>;
  setPreparingUpdate: (value: boolean) => void;
  resetSaved: () => void;
  destroyWindowTray: () => void;
  disposeAsr: () => void;
}): QuitForUpdateController {
  const runningInstanceFile = path.join(input.runtimeDir, "running-instance.json");
  const quitSignalFile = path.join(input.runtimeDir, "quit-for-update.json");
  const quitAckFile = path.join(input.runtimeDir, "quit-for-update-ack.json");
  const releaseBlockingFile = path.join(input.runtimeDir, "release-blocking-write.json");
  const instanceStartedAt = new Date().toISOString();

  let instanceReady = false;
  let quittingForUpdate: Promise<void> | null = null;
  let quitPollTimer: ReturnType<typeof setInterval> | null = null;

  function writeRunningInstance(state: "starting" | "ready", extras: Record<string, unknown> = {}): void {
    if (input.quitForUpdateFlag) return;
    instanceReady = state === "ready";
    // Clear the launch-guard marker as soon as the window is ready, even in recovery mode (`!writable`),
    // so an unplugged/unwritable data drive does not count as a launch crash and trigger rollback.
    if (instanceReady && process.env.MANGA_LAUNCH_ATTEMPT_FILE) {
      launchSucceeded(process.env.MANGA_LAUNCH_ATTEMPT_FILE);
    }
    if (!input.writable) return;
    try {
      fs.mkdirSync(input.runtimeDir, { recursive: true });
      fs.writeFileSync(
        runningInstanceFile,
        `${JSON.stringify({
          pid: process.pid,
          state,
          version: input.version,
          channel: input.channel,
          testIdentity: input.testIdentity,
          execPath: process.execPath,
          startedAt: instanceStartedAt,
          updatedAt: new Date().toISOString(),
          ...extras,
        }, null, 2)}\n`,
      );
    } catch {
      // ignore
    }
  }

  function cleanupInstanceFiles(): void {
    if (quitPollTimer) {
      clearInterval(quitPollTimer);
      quitPollTimer = null;
    }
    try {
      if (fs.existsSync(runningInstanceFile)) {
        const current = JSON.parse(fs.readFileSync(runningInstanceFile, "utf8")) as { pid?: number };
        if (current.pid === process.pid) fs.rmSync(runningInstanceFile, { force: true });
      }
    } catch {
      // ignore
    }
    try { fs.rmSync(quitSignalFile, { force: true }); } catch { /* ignore */ }
  }

  function handleQuitForUpdate(): Promise<void> {
    if (quittingForUpdate) return quittingForUpdate;
    quittingForUpdate = (async () => {
      let requestText: string;
      let expiresAt: number;
      try {
        requestText = fs.readFileSync(quitSignalFile, "utf8");
        const request = JSON.parse(requestText) as { channel?: string; testIdentity?: boolean; expiresAt?: number };
        if (request.channel !== input.channel || Boolean(request.testIdentity) !== input.testIdentity) return;
        expiresAt = Math.min(request.expiresAt ?? Date.now() + 28_000, Date.now() + 28_000);
        if (!(expiresAt > Date.now())) { fs.rmSync(quitSignalFile, { force: true }); return; }
      } catch { return; }
      const cancelled = new AbortController();
      const timeout = setTimeout(() => cancelled.abort(new Error("update quit timed out")), expiresAt - Date.now());
      const requestStillCurrent = () => {
        try { return fs.readFileSync(quitSignalFile, "utf8") === requestText; } catch { return false; }
      };
      const poll = setInterval(() => { if (!requestStillCurrent()) cancelled.abort(new Error("update quit cancelled")); }, 100);
      try {
        fs.mkdirSync(input.runtimeDir, { recursive: true });
        fs.writeFileSync(
          quitAckFile,
          `${JSON.stringify({
            pid: process.pid,
            receivedAt: new Date().toISOString(),
            blockingWrites: input.getAppService()?.hasBlockingWrites() ?? false,
          }, null, 2)}\n`,
        );
      } catch {
        // ignore
      }
      try {
        input.setPreparingUpdate(true);
        const win = input.getWindow();
        const windowOpen = isMainWindowOpen(win);
        win?.setEnabled(false);
        await input.flushWindowSaves({ strict: true, signal: cancelled.signal });
        await input.getAppService()?.prepareQuitForUpdate({ signal: cancelled.signal });
        cancelled.signal.throwIfAborted();
        if (!requestStillCurrent()) throw new Error("update quit request withdrawn");
        writeUpdateRestartMarker(input.runtimeDir, {
          reason: "dev-install",
          windowOpen,
          fromVersion: input.version,
        });
        input.destroyWindowTray();
        cleanupInstanceFiles();
        input.disposeAsr();
        input.getAppService()?.close();
        input.clearAppService();
        app.exit(0);
      } catch {
        // An abandoned install request must never close the instance later when a blocked write completes.
        input.resetSaved();
        input.setPreparingUpdate(false);
        const win = input.getWindow();
        if (win && !win.isDestroyed()) win.setEnabled(true);
        try { fs.writeFileSync(quitAckFile, JSON.stringify({ pid: process.pid, status: "busy" })); } catch { /* ignore */ }
        if (requestStillCurrent()) { try { fs.rmSync(quitSignalFile, { force: true }); } catch { /* ignore */ } }
      } finally {
        clearTimeout(timeout);
        clearInterval(poll);
      }
    })().finally(() => { quittingForUpdate = null; });
    return quittingForUpdate;
  }

  function clearStaleSignalFiles(): void {
    for (const stale of [quitSignalFile, quitAckFile, releaseBlockingFile]) {
      try { fs.rmSync(stale, { force: true }); } catch { /* ignore */ }
    }
  }

  function startPolling(isUpdateDriver: () => boolean): void {
    let lastBlockingState: boolean | undefined;
    quitPollTimer = setInterval(() => {
      const service = input.getAppService();
      if (instanceReady && isUpdateDriver() && service) {
        const blockingWrites = service.hasBlockingWrites();
        if (blockingWrites !== lastBlockingState) {
          lastBlockingState = blockingWrites;
          writeRunningInstance("ready", { blockingWrites, justUpdated: service.update.status().justUpdated });
        }
      }
      if (fs.existsSync(quitSignalFile)) {
        void handleQuitForUpdate();
      }
    }, 120);
    quitPollTimer.unref?.();
  }

  return {
    quitSignalFile,
    quitAckFile,
    releaseBlockingFile,
    writeRunningInstance,
    cleanupInstanceFiles,
    handleQuitForUpdate,
    clearStaleSignalFiles,
    startPolling,
  };
}
