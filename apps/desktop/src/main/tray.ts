import type { Menu, MenuItemConstructorOptions, Tray } from "electron";
import type { Channel } from "@manga/contracts";
import { createTranslator } from "@manga/i18n";
import { resolveAppIconPath } from "./window-assets.ts";

export { resolveAppIconPath };

export function trayTooltipForChannel(channel: Channel): string {
  return channel === "development" ? "MANGA Dev" : "MANGA";
}

export type TrayLike = {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: Menu | null): void;
  on(event: "click" | "double-click", listener: () => void): unknown;
  destroy(): void;
  isDestroyed(): boolean;
};

export type TrayWindowLike = {
  on(event: "minimize" | "restore" | "show" | "closed", listener: () => void): unknown;
  removeListener(event: "minimize" | "restore" | "show" | "closed", listener: () => void): unknown;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  restore(): void;
  show(): void;
  showInactive(): void;
  hide(): void;
  focus(): void;
  blur(): void;
  setSkipTaskbar(skip: boolean): void;
};

export type TraySnapshot = {
  active: boolean;
  iconPath: string | null;
  tooltip: string;
  menuLabels: string[];
};

export type WindowTrayController = {
  isActive(): boolean;
  /** Re-creates the tray icon if the window is still open and not disposed (e.g. after an aborted quit). */
  ensureActive(): boolean;
  snapshot(): TraySnapshot;
  restore(): boolean;
  /** Puts a window that was never shown straight into the tray (`--background`, A-135); false when no tray icon could be made. */
  parkInTray(): boolean;
  /** Hides the window into the tray, as its close button does when the person keeps MANGA there (A-136); false when there is no tray icon to come back from. */
  hideToTray(): boolean;
  dispose(): void;
};

export type WindowTrayOptions = {
  window: TrayWindowLike;
  channel: Channel;
  packaged: boolean;
  resourcesPath: string;
  baseDir?: string;
  hideWindow?: boolean;
  platform?: NodeJS.Platform;
  existsSync?: (file: string) => boolean;
  createTray: (iconPath: string) => Tray | TrayLike;
  buildMenu: (template: MenuItemConstructorOptions[]) => Menu | null;
  onQuit: () => void;
};

let currentController: WindowTrayController | null = null;

export function activeWindowTray(): WindowTrayController | null {
  return currentController;
}

function restoreWindowSurface(win: TrayWindowLike, hideWindow: boolean): void {
  if (!hideWindow) {
    win.setSkipTaskbar(false);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    win.showInactive();
    if (win.isMinimized()) win.restore();
    if (win.isFocused()) win.blur();
  }
}

/**
 * The main window's icon in the Windows notification area (A-136). It is there for as long as the window is, from the start: minimizing is the system's
 * own minimize to the taskbar, and the close button puts the window into the tray when the person keeps MANGA there (the main process asks
 * `hideToTray`). A click or a double click on the icon, or its "显示主窗口", brings the window back; "退出 MANGA" quits. Where no icon can be made, the
 * window keeps to the taskbar and closing it quits.
 */
export function createWindowTray(options: WindowTrayOptions): WindowTrayController {
  const i18n = createTranslator();
  const showLabel = i18n.t("tray.showWindow");
  const quitLabel = i18n.t("tray.quit");
  const tooltip = trayTooltipForChannel(options.channel);
  const hideWindow = options.hideWindow === true;
  const platform = options.platform ?? process.platform;
  const iconPath = resolveAppIconPath({
    channel: options.channel,
    packaged: options.packaged,
    resourcesPath: options.resourcesPath,
    baseDir: options.baseDir,
    existsSync: options.existsSync,
  }) ?? null;
  const enabled = platform === "win32" && iconPath !== null;

  let tray: TrayLike | null = null;
  let disposed = false;

  const destroyTray = (): void => {
    const existing = tray;
    tray = null;
    if (existing && !existing.isDestroyed()) {
      existing.destroy();
    }
  };

  const restore = (): boolean => {
    if (disposed || options.window.isDestroyed()) return false;
    restoreWindowSurface(options.window, hideWindow);
    return true;
  };

  const quitFromTray = (): void => {
    destroyTray();
    if (disposed) return;
    options.onQuit();
  };

  const ensureTray = (): boolean => {
    if (disposed || !enabled || !iconPath || options.window.isDestroyed()) return false;
    if (!tray || tray.isDestroyed()) {
      try {
        const next = options.createTray(iconPath);
        next.setToolTip(tooltip);
        const menu = options.buildMenu([
          { label: showLabel, click: () => { restore(); } },
          { type: "separator" },
          { label: quitLabel, click: () => { quitFromTray(); } },
        ]);
        next.setContextMenu(menu);
        next.on("click", () => { restore(); });
        next.on("double-click", () => { restore(); });
        tray = next;
      } catch {
        // Keep the window on the taskbar if the OS shell refuses tray icon creation.
        return false;
      }
    }
    return true;
  };

  const controller: WindowTrayController = {
    isActive(): boolean {
      return Boolean(tray && !tray.isDestroyed());
    },
    ensureActive(): boolean {
      return ensureTray();
    },
    snapshot(): TraySnapshot {
      const active = Boolean(tray && !tray.isDestroyed());
      return {
        active,
        iconPath: active ? iconPath : null,
        tooltip,
        menuLabels: [showLabel, quitLabel],
      };
    },
    restore,
    parkInTray(): boolean {
      if (!ensureTray()) return false;
      if (!hideWindow) options.window.setSkipTaskbar(true);
      return true;
    },
    hideToTray(): boolean {
      if (!ensureTray()) return false;
      options.window.hide();
      return true;
    },
    dispose(): void {
      if (disposed) {
        destroyTray();
        if (currentController === controller) currentController = null;
        return;
      }
      disposed = true;
      options.window.removeListener("closed", onClosed);
      destroyTray();
      if (currentController === controller) currentController = null;
    },
  };

  const onClosed = (): void => {
    controller.dispose();
  };

  if (!options.window.isDestroyed()) {
    options.window.on("closed", onClosed);
    ensureTray();
  }

  currentController = controller;
  return controller;
}

export function routeSecondInstance(input: {
  argv: readonly string[];
  additionalData?: unknown;
  hasQuitSignal?: () => boolean;
  onQuitForUpdate: () => void;
  tray?: Pick<WindowTrayController, "restore"> | null;
  window?: TrayWindowLike | null;
  hideWindow?: boolean;
}): "quit-for-update" | "restored" | "noop" {
  const extra = input.additionalData as { quitForUpdate?: boolean } | undefined;
  if (input.argv.includes("--quit-for-update") || extra?.quitForUpdate === true || input.hasQuitSignal?.() === true) {
    input.onQuitForUpdate();
    return "quit-for-update";
  }
  if (input.tray?.restore()) {
    return "restored";
  }
  if (input.window && !input.window.isDestroyed()) {
    restoreWindowSurface(input.window, input.hideWindow === true);
    return "restored";
  }
  return "noop";
}
