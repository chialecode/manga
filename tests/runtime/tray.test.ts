import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Menu, MenuItemConstructorOptions } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeWindowTray,
  createWindowTray,
  resolveAppIconPath,
  routeSecondInstance,
  trayTooltipForChannel,
  type TrayLike,
  type TrayWindowLike,
} from "../../apps/desktop/src/main/tray.ts";

type FakeTrayRecord = TrayLike & {
  iconPath: string;
  tooltip: string;
  menuItems: MenuItemConstructorOptions[];
  trigger(event: "click" | "double-click"): void;
  clickMenuItem(label: string): void;
};

function createFakeTrayHarness() {
  const instances: FakeTrayRecord[] = [];
  let lastMenuItems: MenuItemConstructorOptions[] = [];

  const buildMenu = (template: MenuItemConstructorOptions[]): Menu | null => {
    lastMenuItems = template;
    return { items: template } as unknown as Menu;
  };

  const createTray = (iconPath: string): FakeTrayRecord => {
    const emitter = new EventEmitter();
    let destroyed = false;
    let tooltip = "";
    let menuItems: MenuItemConstructorOptions[] = [];
    const record: FakeTrayRecord = {
      iconPath,
      get tooltip() {
        return tooltip;
      },
      get menuItems() {
        return menuItems;
      },
      setToolTip(nextTooltip: string) {
        tooltip = nextTooltip;
      },
      setContextMenu(_menu: Menu | null) {
        menuItems = lastMenuItems;
      },
      on(event: "click" | "double-click", listener: () => void) {
        emitter.on(event, listener);
        return record;
      },
      destroy() {
        destroyed = true;
        emitter.removeAllListeners();
      },
      isDestroyed() {
        return destroyed;
      },
      trigger(event: "click" | "double-click") {
        if (!destroyed) emitter.emit(event);
      },
      clickMenuItem(label: string) {
        const item = menuItems.find((entry) => entry.label === label);
        if (!item || typeof item.click !== "function") {
          throw new Error(`menu item not found: ${label}`);
        }
        (item.click as () => void)();
      },
    };
    instances.push(record);
    return record;
  };

  return { instances, createTray, buildMenu };
}

type FakeWindow = TrayWindowLike & {
  skipTaskbar: boolean;
  calls: string[];
  minimize(): void;
  hide(): void;
  closeWindow(): void;
  listenerTotal(): number;
};

function createFakeWindow(initial?: { visible?: boolean; skipTaskbar?: boolean; focused?: boolean }): FakeWindow {
  const emitter = new EventEmitter();
  let destroyed = false;
  let minimized = false;
  let visible = initial?.visible ?? true;
  let focused = initial?.focused ?? (initial?.visible ?? true);
  let skipTaskbar = initial?.skipTaskbar ?? false;
  const calls: string[] = [];

  return {
    get skipTaskbar() {
      return skipTaskbar;
    },
    calls,
    on(event, listener) {
      emitter.on(event, listener);
      return this;
    },
    removeListener(event, listener) {
      emitter.removeListener(event, listener);
      return this;
    },
    isDestroyed() {
      return destroyed;
    },
    isMinimized() {
      return minimized;
    },
    isVisible() {
      return visible;
    },
    isFocused() {
      return focused;
    },
    minimize() {
      if (destroyed) return;
      calls.push("minimize");
      minimized = true;
      focused = false;
      emitter.emit("minimize");
    },
    restore() {
      if (destroyed) return;
      calls.push("restore");
      const wasMinimized = minimized;
      minimized = false;
      if (wasMinimized) emitter.emit("restore");
    },
    show() {
      if (destroyed) return;
      calls.push("show");
      visible = true;
      emitter.emit("show");
    },
    showInactive() {
      if (destroyed) return;
      calls.push("showInactive");
      visible = true;
      emitter.emit("show");
    },
    hide() {
      if (destroyed) return;
      calls.push("hide");
      visible = false;
      focused = false;
    },
    focus() {
      if (destroyed) return;
      calls.push("focus");
      focused = true;
    },
    blur() {
      if (destroyed) return;
      calls.push("blur");
      focused = false;
    },
    setSkipTaskbar(skip: boolean) {
      calls.push(`setSkipTaskbar:${String(skip)}`);
      skipTaskbar = skip;
    },
    closeWindow() {
      destroyed = true;
      visible = false;
      focused = false;
      emitter.emit("closed");
    },
    listenerTotal() {
      return (
        emitter.listenerCount("minimize") +
        emitter.listenerCount("restore") +
        emitter.listenerCount("show") +
        emitter.listenerCount("closed")
      );
    },
  };
}

const tempDirs: string[] = [];
const activeControllers: Array<{ dispose(): void }> = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-tray-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (activeControllers.length > 0) {
    activeControllers.pop()?.dispose();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("system tray icon & channel resolution", () => {
  it("resolves channel-appropriate icons and tooltips in unpackaged dev and release modes", () => {
    const emptyResources = makeTempDir();
    const devIcon = resolveAppIconPath({
      channel: "development",
      packaged: false,
      resourcesPath: emptyResources,
    });
    const releaseIcon = resolveAppIconPath({
      channel: "release",
      packaged: false,
      resourcesPath: emptyResources,
    });

    expect(devIcon).toBeDefined();
    expect(path.basename(devIcon!)).toBe("icon-dev.ico");
    expect(fs.existsSync(devIcon!)).toBe(true);

    expect(releaseIcon).toBeDefined();
    expect(path.basename(releaseIcon!)).toBe("icon.ico");
    expect(fs.existsSync(releaseIcon!)).toBe(true);

    expect(trayTooltipForChannel("development")).toBe("MANGA Dev");
    expect(trayTooltipForChannel("release")).toBe("MANGA");
  });

  it("resolves packaged resources icons cleanly for both release and development channels", () => {
    const resourcesDir = makeTempDir();
    const emptyBase = path.join(resourcesDir, "nested", "build");
    fs.mkdirSync(emptyBase, { recursive: true });
    const installedIcon = path.join(resourcesDir, "icon.ico");
    fs.writeFileSync(installedIcon, "ico");

    expect(
      resolveAppIconPath({
        channel: "release",
        packaged: true,
        resourcesPath: resourcesDir,
        baseDir: emptyBase,
      }),
    ).toBe(installedIcon);

    // Development installer writes icon-dev.ico to resources/icon.ico, or resources/icon-dev.ico when staged directly.
    expect(
      resolveAppIconPath({
        channel: "development",
        packaged: true,
        resourcesPath: resourcesDir,
        baseDir: emptyBase,
      }),
    ).toBe(installedIcon);

    const explicitDevIcon = path.join(resourcesDir, "icon-dev.ico");
    fs.writeFileSync(explicitDevIcon, "dev-ico");
    expect(
      resolveAppIconPath({
        channel: "development",
        packaged: true,
        resourcesPath: resourcesDir,
        baseDir: emptyBase,
      }),
    ).toBe(explicitDevIcon);
  });
});

const trayFor = (win: FakeWindow, harness: ReturnType<typeof createFakeTrayHarness>, extra: { channel?: "release" | "development"; onQuit?: () => void; hideWindow?: boolean } = {}) => {
  const tray = createWindowTray({
    window: win,
    channel: extra.channel ?? "release",
    packaged: false,
    resourcesPath: makeTempDir(),
    platform: "win32",
    ...(extra.hideWindow ? { hideWindow: true } : {}),
    createTray: harness.createTray,
    buildMenu: harness.buildMenu,
    onQuit: extra.onQuit ?? (() => {}),
  });
  activeControllers.push(tray);
  return tray;
};

describe("the tray icon is always there; minimize is the taskbar's, the close button the tray's (A-136)", () => {
  it("shows one tray icon from the start, keeps it through minimizing and restoring, and leaves the window on the taskbar", () => {
    const win = createFakeWindow();
    const harness = createFakeTrayHarness();
    const tray = trayFor(win, harness, { channel: "development" });

    expect(activeWindowTray()).toBe(tray);
    expect(tray.isActive()).toBe(true);
    expect(harness.instances).toHaveLength(1);
    expect(path.basename(harness.instances[0]!.iconPath)).toBe("icon-dev.ico");
    expect(harness.instances[0]!.tooltip).toBe("MANGA Dev");
    expect(tray.snapshot().menuLabels).toEqual(["显示主窗口", "退出 MANGA"]);

    // Minimizing is the system's own: the window stays on the taskbar, and the icon is the same one.
    win.minimize();
    expect(win.isMinimized()).toBe(true);
    expect(win.skipTaskbar).toBe(false);
    expect(win.calls).not.toContain("setSkipTaskbar:true");
    win.restore();
    win.minimize();
    expect(harness.instances).toHaveLength(1);
    expect(tray.isActive()).toBe(true);
  });

  it("hides the window into the tray for the close button, and the icon's click, double click or menu brings it back without removing the icon", () => {
    const win = createFakeWindow();
    const harness = createFakeTrayHarness();
    const tray = trayFor(win, harness);
    const icon = harness.instances[0]!;
    expect(icon.tooltip).toBe("MANGA");
    expect(path.basename(icon.iconPath)).toBe("icon.ico");

    expect(tray.hideToTray()).toBe(true);
    expect(win.isVisible()).toBe(false);
    icon.trigger("click");
    expect(win.isVisible()).toBe(true);
    expect(win.isFocused()).toBe(true);
    expect(win.skipTaskbar).toBe(false);
    expect(icon.isDestroyed()).toBe(false);

    tray.hideToTray();
    icon.trigger("double-click");
    expect(win.isVisible()).toBe(true);

    // A minimized window comes back up as well.
    win.minimize();
    icon.clickMenuItem("显示主窗口");
    expect(win.isMinimized()).toBe(false);
    expect(win.isFocused()).toBe(true);
    expect(harness.instances).toHaveLength(1);
    expect(tray.isActive()).toBe(true);
  });

  it("wires the Chinese context menu items for showing the window and quitting MANGA", () => {
    const win = createFakeWindow();
    const harness = createFakeTrayHarness();
    let quitCount = 0;
    const tray = trayFor(win, harness, { onQuit: () => { quitCount += 1; } });
    const icon = harness.instances[0]!;
    expect(icon.menuItems.map((item) => item.label ?? item.type)).toEqual(["显示主窗口", "separator", "退出 MANGA"]);
    tray.hideToTray();
    icon.clickMenuItem("显示主窗口");
    expect(win.isVisible()).toBe(true);
    expect(quitCount).toBe(0);
    icon.clickMenuItem("退出 MANGA");
    expect(icon.isDestroyed()).toBe(true);
    expect(tray.isActive()).toBe(false);
    expect(quitCount).toBe(1);
  });

  it("brings a hidden smoke window back without taking the focus", () => {
    const win = createFakeWindow({ visible: false, skipTaskbar: true, focused: false });
    const harness = createFakeTrayHarness();
    const tray = trayFor(win, harness, { channel: "development", hideWindow: true });
    expect(tray.isActive()).toBe(true);
    win.showInactive();
    expect(tray.hideToTray()).toBe(true);
    expect(win.isVisible()).toBe(false);
    expect(tray.restore()).toBe(true);
    expect(win.isVisible()).toBe(true);
    expect(win.isFocused()).toBe(false);
    expect(win.skipTaskbar).toBe(true);
  });

  it("keeps the window on the taskbar if tray icon creation throws, and then the close button cannot hide it", () => {
    const win = createFakeWindow();
    const tray = createWindowTray({
      window: win,
      channel: "release",
      packaged: false,
      resourcesPath: makeTempDir(),
      platform: "win32",
      createTray: () => { throw new Error("shell unavailable"); },
      buildMenu: () => null,
      onQuit: () => {},
    });
    activeControllers.push(tray);

    expect(tray.isActive()).toBe(false);
    win.minimize();
    expect(win.skipTaskbar).toBe(false);
    // With no icon to come back from, closing closes and `--background` cannot park a window (A-135): the main process shows it instead.
    expect(tray.hideToTray()).toBe(false);
    expect(win.isVisible()).toBe(true);
    expect(tray.parkInTray()).toBe(false);
  });

  it("has no icon on a system without a tray of this kind", () => {
    const win = createFakeWindow();
    const harness = createFakeTrayHarness();
    const tray = createWindowTray({ window: win, channel: "release", packaged: false, resourcesPath: makeTempDir(), platform: "darwin", createTray: harness.createTray, buildMenu: harness.buildMenu, onQuit: () => {} });
    activeControllers.push(tray);
    expect(tray.isActive()).toBe(false);
    expect(harness.instances).toHaveLength(0);
    expect(tray.hideToTray()).toBe(false);
  });

  it("parks a never-shown window in the tray for --background, and the tray icon shows it on the taskbar again (A-135)", () => {
    const harness = createFakeTrayHarness();
    const win = createFakeWindow({ visible: false, skipTaskbar: true, focused: false });
    const tray = trayFor(win, harness, { channel: "development" });

    expect(tray.parkInTray()).toBe(true);
    expect(tray.parkInTray()).toBe(true);
    expect(harness.instances).toHaveLength(1);
    expect(tray.snapshot()).toMatchObject({ active: true, tooltip: "MANGA Dev" });
    expect(win.isVisible()).toBe(false);
    expect(win.skipTaskbar).toBe(true);

    harness.instances[0]!.trigger("click");
    expect(tray.isActive()).toBe(true);
    expect(win.isVisible()).toBe(true);
    expect(win.isFocused()).toBe(true);
    expect(win.skipTaskbar).toBe(false);
  });

  it("decides the close in the main process: into the tray unless the person chose that it quits, never on the way out", () => {
    const source = fs.readFileSync(new URL("../../apps/desktop/src/main/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/if \(!quitting && !closeChosen && windowTray\?\.isActive\(\)/);
    expect(source).toMatch(/closeToTray \?\? true/);
    expect(source).toMatch(/app\.on\("before-quit", \(\) => \{\n  quitting = true;/);
    expect(source).toMatch(/window\.on\("session-end", \(\) => \{ quitting = true; \}\)/);
  });
});

describe("single-instance restore and quit-for-update lifecycle", () => {
  it("restores and focuses from tray on second-instance, and also brings up an unfocused/hidden window", () => {
    const win = createFakeWindow();
    const harness = createFakeTrayHarness();
    const tray = createWindowTray({
      window: win,
      channel: "release",
      packaged: false,
      resourcesPath: makeTempDir(),
      platform: "win32",
      createTray: harness.createTray,
      buildMenu: harness.buildMenu,
      onQuit: () => {},
    });
    activeControllers.push(tray);

    win.minimize();
    expect(tray.isActive()).toBe(true);

    let updateQuits = 0;
    const outcome = routeSecondInstance({
      argv: ["manga.exe"],
      onQuitForUpdate: () => { updateQuits += 1; },
      tray,
      window: win,
    });

    expect(outcome).toBe("restored");
    expect(updateQuits).toBe(0);
    expect(tray.isActive()).toBe(true);
    expect(harness.instances[0]!.isDestroyed()).toBe(false);
    expect(win.isMinimized()).toBe(false);
    expect(win.isVisible()).toBe(true);
    expect(win.isFocused()).toBe(true);
    expect(win.skipTaskbar).toBe(false);

    // A window hidden into the tray also comes back on second-instance.
    win.hide();
    expect(win.isVisible()).toBe(false);
    const secondOutcome = routeSecondInstance({
      argv: ["manga.exe"],
      onQuitForUpdate: () => { updateQuits += 1; },
      tray,
      window: win,
    });
    expect(secondOutcome).toBe("restored");
    expect(win.isVisible()).toBe(true);
    expect(win.isFocused()).toBe(true);
  });

  it("stays silent on second-instance --background or while quitting without popping a tray-parked window", () => {
    const win = createFakeWindow({ visible: false, skipTaskbar: true, focused: false });
    const harness = createFakeTrayHarness();
    const tray = trayFor(win, harness, { channel: "development" });
    expect(tray.parkInTray()).toBe(true);

    let updateQuits = 0;
    const bgOutcome = routeSecondInstance({
      argv: ["manga-dev.exe", "--BACKGROUND"],
      onQuitForUpdate: () => { updateQuits += 1; },
      tray,
      window: win,
    });
    expect(bgOutcome).toBe("noop");
    expect(updateQuits).toBe(0);
    expect(win.isVisible()).toBe(false);
    expect(win.isFocused()).toBe(false);

    const quittingOutcome = routeSecondInstance({
      argv: ["manga-dev.exe"],
      onQuitForUpdate: () => { updateQuits += 1; },
      quitting: true,
      tray,
      window: win,
    });
    expect(quittingOutcome).toBe("noop");
    expect(win.isVisible()).toBe(false);
  });

  it("destroys the tray icon without restoring on --quit-for-update and detaches cleanly on dispose/close", () => {
    const win = createFakeWindow();
    const harness = createFakeTrayHarness();
    const tray = createWindowTray({
      window: win,
      channel: "development",
      packaged: false,
      resourcesPath: makeTempDir(),
      platform: "win32",
      createTray: harness.createTray,
      buildMenu: harness.buildMenu,
      onQuit: () => {},
    });
    activeControllers.push(tray);

    win.minimize();
    const icon = harness.instances[0]!;
    expect(tray.isActive()).toBe(true);

    let quitHandled = false;
    const outcome = routeSecondInstance({
      argv: ["manga-dev.exe", "--quit-for-update"],
      additionalData: { quitForUpdate: true },
      onQuitForUpdate: () => {
        quitHandled = true;
        tray.dispose();
      },
      tray,
      window: win,
    });

    expect(outcome).toBe("quit-for-update");
    expect(quitHandled).toBe(true);
    expect(icon.isDestroyed()).toBe(true);
    expect(tray.isActive()).toBe(false);
    expect(activeWindowTray()).toBeNull();
    expect(win.isMinimized()).toBe(true);
    expect(win.listenerTotal()).toBe(0);

    // Further minimize or dispose calls during shutdown never recreate ghost tray icons.
    win.minimize();
    tray.dispose();
    expect(harness.instances).toHaveLength(1);
    expect(tray.isActive()).toBe(false);
  });

  it("auto-disposes when the window closes and keeps main/light entry wiring clean", () => {
    const win = createFakeWindow();
    const harness = createFakeTrayHarness();
    const tray = createWindowTray({
      window: win,
      channel: "release",
      packaged: false,
      resourcesPath: makeTempDir(),
      platform: "win32",
      createTray: harness.createTray,
      buildMenu: harness.buildMenu,
      onQuit: () => {},
    });
    activeControllers.push(tray);

    win.minimize();
    const icon = harness.instances[0]!;
    win.closeWindow();
    expect(icon.isDestroyed()).toBe(true);
    expect(tray.isActive()).toBe(false);
    expect(win.listenerTotal()).toBe(0);

    const mainSource = fs.readFileSync(
      new URL("../../apps/desktop/src/main/index.ts", import.meta.url),
      "utf8",
    );
    expect(mainSource).toContain("createWindowTray(");
    expect(mainSource).toContain("routeSecondInstance(");
    expect(mainSource).toContain("destroyWindowTray()");

    const lightSource = fs.readFileSync(
      new URL("../../apps/desktop/src/main/light/main.ts", import.meta.url),
      "utf8",
    );
    expect(lightSource).not.toContain("tray");
  });
});
