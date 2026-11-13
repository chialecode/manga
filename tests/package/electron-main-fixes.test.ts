import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  openPath: vi.fn(async () => ""),
  showItemInFolder: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0" },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {
    openPath: electronMocks.openPath,
    showItemInFolder: electronMocks.showItemInFolder,
  },
}));

import { parsePickRequest, revealResolvedPath } from "../../apps/desktop/src/main/ipc-handlers.ts";
import { beginLaunch, guardPaths, prepareRollback, type RollbackPlan } from "../../apps/desktop/src/main/launch-guard.ts";
import { createNetFetch, type NetLike } from "../../apps/desktop/src/main/net-fetch.ts";
import { createWindowTray, type TrayLike, type TrayWindowLike } from "../../apps/desktop/src/main/tray.ts";
import { createOpenTracker, createSecondInstanceQueue } from "../../apps/desktop/src/main/light/open-queue.ts";
import { pruneStaleUpdateHelperFiles } from "../../apps/desktop/src/main/detached-installer.ts";
import { runInstallDev } from "../../scripts/stage/install-dev.mjs";

const tempDirs: string[] = [];
function makeTemp(prefix = "manga-elec-fix-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  electronMocks.openPath.mockClear();
  electronMocks.showItemInFolder.mockClear();
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("IPC pick validation and file reveal safety", () => {
  it("parsePickRequest rejects malformed payloads and ignores prototype filter keys", () => {
    expect(parsePickRequest(null)).toBeNull();
    expect(parsePickRequest("file")).toBeNull();
    expect(parsePickRequest({ mode: "other" })).toBeNull();

    // Prototype keys must not resolve to inherited Object.prototype properties.
    expect(parsePickRequest({ mode: "file", filter: "constructor" })).toEqual({
      mode: "file",
      filters: undefined,
      defaultPath: undefined,
    });
    expect(parsePickRequest({ mode: "file", filter: "toString" })?.filters).toBeUndefined();
    expect(parsePickRequest({ mode: "file", filter: "__proto__" })?.filters).toBeUndefined();

    const bookPick = parsePickRequest({ mode: "file", filter: "book", defaultPath: "books" });
    expect(bookPick?.mode).toBe("file");
    expect(bookPick?.defaultPath).toBe("books");
    expect(bookPick?.filters?.[0]?.name).toBe("Book");

    expect(parsePickRequest({ mode: "directory", defaultPath: 123 })).toEqual({
      mode: "directory",
      filters: undefined,
      defaultPath: undefined,
    });
  });

  it("revealResolvedPath opens directories with openPath and reveals files with showItemInFolder", async () => {
    const dir = makeTemp();
    const file = path.join(dir, "sample.exe");
    fs.writeFileSync(file, "not-executed");

    await expect(revealResolvedPath(dir)).resolves.toBe("directory");
    expect(electronMocks.openPath).toHaveBeenCalledWith(dir);
    expect(electronMocks.showItemInFolder).not.toHaveBeenCalled();

    electronMocks.openPath.mockClear();
    await expect(revealResolvedPath(file)).resolves.toBe("file");
    expect(electronMocks.showItemInFolder).toHaveBeenCalledWith(file);
    expect(electronMocks.openPath).not.toHaveBeenCalled();

    await expect(revealResolvedPath(path.join(dir, "missing.txt"))).resolves.toBe("missing");
  });
});

describe("launch-guard rollback atomicity and concurrent-PID isolation", () => {
  it("prepareRollback stages backup before touching the live database", () => {
    const root = makeTemp();
    const paths = guardPaths(root);
    fs.mkdirSync(paths.data, { recursive: true });
    fs.mkdirSync(paths.runtime, { recursive: true });
    fs.mkdirSync(paths.updaterCache, { recursive: true });
    const live = path.join(paths.data, "manga.sqlite");
    const keptAs = path.join(paths.data, "manga.sqlite.rolledback-test");
    fs.writeFileSync(live, "live-db-bytes");
    fs.writeFileSync(`${live}-wal`, "live-wal");

    const previous = {
      version: "0.1.0",
      sha512Hex: "deadbeef",
      file: path.join(paths.updaterCache, "prev.exe"),
      schemaVersion: 13,
      targetVersion: "0.2.0",
      targetSchemaVersion: 14,
      database: live,
      backup: null,
      keptAt: "2026-11-20T00:00:00Z",
    };

    const brokenPlan: RollbackPlan = {
      previous,
      from: "0.2.0",
      database: { restoreFrom: path.join(root, "missing-backup.sqlite"), current: live, keptAs },
    };
    expect(() => prepareRollback(paths, brokenPlan)).toThrow();
    expect(fs.readFileSync(live, "utf8")).toBe("live-db-bytes");
    expect(fs.readFileSync(`${live}-wal`, "utf8")).toBe("live-wal");
    expect(fs.existsSync(keptAs)).toBe(false);

    const validBackup = path.join(root, "backup.sqlite");
    fs.writeFileSync(validBackup, "backup-db-bytes");
    const validPlan: RollbackPlan = {
      previous,
      from: "0.2.0",
      database: { restoreFrom: validBackup, current: live, keptAs },
    };
    const outcome = prepareRollback(paths, validPlan);
    expect(outcome.databaseRestored).toBe(true);
    expect(outcome.keptAs).toBe(keptAs);
    expect(fs.readFileSync(live, "utf8")).toBe("backup-db-bytes");
    expect(fs.readFileSync(keptAs, "utf8")).toBe("live-db-bytes");
    expect(fs.readFileSync(`${keptAs}-wal`, "utf8")).toBe("live-wal");
  });

  it("beginLaunch ignores a secondary start while another PID is still alive", () => {
    const root = makeTemp();
    const paths = guardPaths(root);
    fs.mkdirSync(paths.runtime, { recursive: true });
    fs.mkdirSync(paths.updaterCache, { recursive: true });
    fs.writeFileSync(path.join(paths.updaterCache, "last-installed.json"), JSON.stringify({
      status: "installed",
      version: "0.2.0",
    }));

    // First watched start from PID 1001 writes launch-attempt.json.
    const first = beginLaunch(paths, "0.2.0", new Date("2026-11-20T00:00:00Z"), {
      pid: 1001,
      isPidAlive: (pid) => pid === 1001,
    });
    expect(first).toEqual({ kind: "watched", attempt: 1 });

    // Concurrent start from PID 2002 while PID 1001 is alive must NOT count as a crash or advance launches.
    const concurrent = beginLaunch(paths, "0.2.0", new Date("2026-11-20T00:00:01Z"), {
      pid: 2002,
      isPidAlive: (pid) => pid === 1001,
    });
    expect(concurrent).toEqual({ kind: "ordinary" });
    const historyAfterConcurrent = JSON.parse(fs.readFileSync(path.join(paths.runtime, "launch-history.json"), "utf8"));
    expect(historyAfterConcurrent.failures).toBe(0);
    expect(historyAfterConcurrent.launches).toBe(1);

    // Once PID 1001 dies without removing launch-attempt.json, the next start records the crash.
    const afterCrash = beginLaunch(paths, "0.2.0", new Date("2026-11-20T00:00:02Z"), {
      pid: 2003,
      isPidAlive: () => false,
    });
    expect(afterCrash).toEqual({ kind: "watched", attempt: 2 });
    const historyAfterCrash = JSON.parse(fs.readFileSync(path.join(paths.runtime, "launch-history.json"), "utf8"));
    expect(historyAfterCrash.failures).toBe(1);
    expect(historyAfterCrash.launches).toBe(2);
  });
});

describe("net-fetch stream safety and header filtering", () => {
  it("ignores late data chunks after stream cancellation without throwing and drops undefined headers", async () => {
    const req = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      abort: vi.fn(),
    });
    const fakeNet: NetLike = {
      fetch: vi.fn(),
      request: vi.fn(() => req as never),
    };
    const netFetch = createNetFetch(fakeNet);
    const pending = netFetch("https://example.test/stream", { redirect: "manual" });
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      statusMessage: "OK",
      headers: {
        "content-type": "text/plain",
        "x-empty": undefined,
        "x-multi": ["a", "b"],
      },
    });
    req.emit("response", res);
    const response = await pending;
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.has("x-empty")).toBe(false);
    expect(response.headers.get("x-multi")).toContain("a");

    const reader = response.body!.getReader();
    await reader.cancel();
    expect(req.abort).toHaveBeenCalled();
    // Late data/end/error events after cancellation must not throw ERR_INVALID_STATE.
    expect(() => {
      res.emit("data", Buffer.from("late-chunk"));
      res.emit("end");
      res.emit("error", new Error("late-error"));
    }).not.toThrow();
  });
});

describe("tray restoration on aborted quit", () => {
  it("ensureActive recreates tray after menu quit when quit is aborted, and stops after dispose", () => {
    let created = 0;
    let destroyed = 0;
    let quitClick: (() => void) | undefined;
    const win: TrayWindowLike = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      isFocused: () => true,
      show: vi.fn(),
      showInactive: vi.fn(),
      hide: vi.fn(),
      restore: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
      setSkipTaskbar: vi.fn(),
    });
    const tray = createWindowTray({
      window: win,
      channel: "release",
      packaged: true,
      resourcesPath: "resources",
      platform: "win32",
      existsSync: () => true,
      createTray: () => {
        created += 1;
        let isDestroyed = false;
        const instance: TrayLike = {
          setToolTip: vi.fn(),
          setContextMenu: vi.fn(),
          on: vi.fn(),
          destroy: () => { isDestroyed = true; destroyed += 1; },
          isDestroyed: () => isDestroyed,
        };
        return instance;
      },
      buildMenu: (template) => {
        const quitItem = template.find((item) => typeof item.click === "function" && item.label?.includes("退出"));
        quitClick = quitItem?.click as (() => void) | undefined;
        return null;
      },
      onQuit: vi.fn(),
    });

    expect(tray.isActive()).toBe(true);
    expect(created).toBe(1);
    expect(quitClick).toBeTypeOf("function");
    quitClick!();
    expect(tray.isActive()).toBe(false);
    expect(destroyed).toBe(1);

    // Quit aborted (e.g. install-on-quit failed): ensureActive restores the tray icon.
    expect(tray.ensureActive()).toBe(true);
    expect(tray.isActive()).toBe(true);
    expect(created).toBe(2);

    // Permanent disposal prevents recreation.
    tray.dispose();
    expect(tray.isActive()).toBe(false);
    expect(tray.ensureActive()).toBe(false);
    expect(created).toBe(2);
  });
});

describe("light open queue and async open superseding", () => {
  it("buffers pre-ready second-instance payloads and drains them in order once ready", () => {
    const handled: Array<{ argv: string[]; cwd: string }> = [];
    const queue = createSecondInstanceQueue<{ argv: string[]; cwd: string }>();
    queue.push({ argv: ["--manga-light", "a.mp4"], cwd: "dir-a" });
    queue.push({ argv: ["--manga-light", "b.cbz"], cwd: "dir-b" });
    expect(queue.isReady).toBe(false);
    expect(queue.pendingCount).toBe(2);
    expect(handled).toEqual([]);

    queue.markReady((item) => handled.push(item));
    expect(queue.isReady).toBe(true);
    expect(queue.pendingCount).toBe(0);
    expect(handled).toEqual([
      { argv: ["--manga-light", "a.mp4"], cwd: "dir-a" },
      { argv: ["--manga-light", "b.cbz"], cwd: "dir-b" },
    ]);

    queue.push({ argv: ["--manga-light", "c.png"], cwd: "dir-c" });
    expect(handled).toHaveLength(3);
  });

  it("tracks monotonic open generations and invalidates superseded or closed opens", () => {
    const tracker = createOpenTracker();
    const g1 = tracker.next();
    expect(tracker.isCurrent(g1)).toBe(true);
    const g2 = tracker.next();
    expect(tracker.isCurrent(g1)).toBe(false);
    expect(tracker.isCurrent(g2)).toBe(true);
    tracker.invalidate();
    expect(tracker.isCurrent(g2)).toBe(false);
  });
});

describe("detached update helper pruning and install-dev lock recovery", () => {
  it("removes stale update-install helper files while preserving last-installed metadata", () => {
    const dir = makeTemp();
    fs.writeFileSync(path.join(dir, "update-install_1111.json"), "{}");
    fs.writeFileSync(path.join(dir, "update-install_1111.ready"), "ok");
    fs.writeFileSync(path.join(dir, "update-install_1111.cancel"), "1");
    fs.writeFileSync(path.join(dir, "last-installed.json"), "{}");

    pruneStaleUpdateHelperFiles(dir);
    expect(fs.readdirSync(dir)).toEqual(["last-installed.json"]);
  });

  it("runInstallDev recovers from a corrupt install-dev.lock file", async () => {
    const home = makeTemp("manga-lock-recover-");
    const places = {
      programs: path.join(home, "Programs"),
      local: path.join(home, "local"),
      documents: path.join(home, "documents"),
      downloads: path.join(home, "downloads"),
    };
    for (const dir of Object.values(places)) fs.mkdirSync(dir, { recursive: true });
    const installDir = path.join(places.programs, "manga-dev-test");
    fs.mkdirSync(path.join(installDir, "resources"), { recursive: true });
    fs.writeFileSync(path.join(installDir, "manga-dev-test.exe"), "stub");
    const writeBuild = (version: string) => fs.writeFileSync(
      path.join(installDir, "resources", "build.json"),
      JSON.stringify({ version, channel: "development", commit: "1111111", builtAt: "2026-11-20T00:00:00Z", schemaVersion: 14 }),
    );
    writeBuild("0.1.2-dev.202611200001");
    const installerPath = path.join(home, "manga-dev-test-setup.exe");
    fs.writeFileSync(installerPath, "installer-stub");
    const runtimeDir = path.join(places.local, "manga-dev-test", "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "install-dev.lock"), "{corrupt-json");

    const snapshotOptions = {
      registryEntries: [],
      localAppDataDir: path.join(home, "real-local"),
      roamingAppDataDir: path.join(home, "real-roaming"),
      desktopDir: path.join(home, "real-desktop"),
      programsDir: path.join(home, "real-programs"),
      registry: () => null,
    };
    let ran = 0;
    const outcome = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" },
      testIdentity: true,
      places,
      installDir,
      installerPath,
      newVersion: "0.1.2-dev.202611200002",
      evidenceDir: null,
      registryEntries: [],
      runningProcessesFn: () => [],
      snapshotOptions,
      spawnInstallerFn: async () => {
        ran += 1;
        writeBuild("0.1.2-dev.202611200002");
        return { status: 0 };
      },
    });
    expect(outcome.status).toBe("passed");
    expect(outcome.installed).toBe(true);
    expect(ran).toBe(1);
    expect(fs.existsSync(path.join(runtimeDir, "install-dev.lock"))).toBe(false);
  });
});
