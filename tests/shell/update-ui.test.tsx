/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { SETTINGS_GROUPS } from "../../apps/desktop/src/renderer/lib/shell-model.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { tabMarks } from "../../apps/desktop/src/renderer/workspace/marks.ts";
import { installHost } from "../helpers/app-host.ts";
import { installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

Element.prototype.scrollIntoView = () => {};

let media: ReturnType<typeof installMediaElement>;
beforeEach(() => {
  window.innerWidth = 1600;
  media = installMediaElement();
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetCovers();
  shelfMemory.reset();
  readerContext.reset();
  tabMarks.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(() => {
  cleanup();
  media.restore();
  vi.restoreAllMocks();
  removeMatchMedia();
  readerContext.reset();
  tabMarks.reset();
});

const FACETS = ["agent", "library", "settings", "comic", "video", "notes", "projects", "voice"];

describe("Section 6 UI: About MANGA, Settings › Update, Top-Bar Ready Banner & Post-Update Notice (AT-157, AT-159, AT-160)", () => {
  it("offers a manual download after autoDownload is disabled without changing that policy (AT-159)", async () => {
    let status = {
      version: "0.1.1", channel: "release", commit: "1111111", builtAt: "2026-11-08T08:00:00.000Z", schemaVersion: 14,
      state: "idle", lastCheckedAt: null, availableVersion: null as string | null, releaseNotes: "更新说明", targetSchemaVersion: 14,
      willUpgradeSchema: false, downloadedBytes: 0, totalBytes: 0, usedDifferential: false, error: null, errorCode: null,
      settings: { autoCheck: true, autoDownload: false }, justUpdated: null,
    };
    const host = installHost({ facets: FACETS, channel: "release", overrides: {
      "update.status": () => status,
      "update.check": (input) => {
        status = { ...status, availableVersion: "0.1.2", state: input.download === true ? "ready" : "idle" };
        return status;
      },
    } });
    render(<App />);
    fireEvent.click(await screen.findByTestId("nav-settings"));
    fireEvent.click(await screen.findByTestId("settings-nav-update"));
    fireEvent.click(await screen.findByTestId("update-check-now"));
    fireEvent.click(await screen.findByTestId("update-download-now"));
    await screen.findByTestId("update-page-restart");
    expect(host.of("update.check")).toContainEqual({ commandId: "update.check", input: { download: true } });
    expect((screen.getByTestId("update-auto-download") as HTMLInputElement).checked).toBe(false);
    expect(host.of("update.settings.set")).toEqual([]);
  });

  it("places 'update' right after 'general' in SETTINGS_GROUPS", () => {
    const basic = SETTINGS_GROUPS.find((g) => g.id === "basic")!;
    expect(basic.pages.slice(0, 2)).toEqual(["general", "update"]);
  });

  it("renders '关于 MANGA' in release vs development channels and copies version summary without local paths (AT-157, AT-159)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    // 1. Release channel
    const releaseHost = installHost({
      facets: FACETS,
      channel: "release",
      appVersion: "0.1.3",
      buildInfo: {
        version: "0.1.3",
        channel: "release",
        commit: "c79f49a",
        builtAt: "2026-11-08T08:00:00.000Z",
        schemaVersion: 14,
      },
    });
    render(<App />);
    await screen.findByTestId("sidebar");

    fireEvent.click(screen.getByTestId("menu-help"));
    expect(await screen.findByTestId("menu-help-check-update")).toBeTruthy();
    fireEvent.click(screen.getByTestId("menu-help-about"));

    const dialog = await screen.findByTestId("about-dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId("about-name").textContent).toBe("MANGA");
    expect(screen.getByTestId("about-version").textContent).toBe("0.1.3");
    expect(screen.getByTestId("about-channel").textContent).toBe("正式版");
    expect(screen.getByTestId("about-commit").textContent).toBe("c79f49a");
    expect(screen.getByTestId("about-built-at").textContent).toContain("2026");
    expect(screen.getByTestId("about-license").textContent).toBe("Apache-2.0");
    expect(screen.queryByTestId("about-dev-hint")).toBeNull();
    expect(screen.getByTestId("about-check-update")).toBeTruthy();

    fireEvent.click(screen.getByTestId("about-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]![0]);
    expect(copied).toContain("MANGA 0.1.3");
    expect(copied).toContain("正式版");
    expect(copied).toContain("c79f49a");
    expect(copied).toContain("Apache-2.0");
    expect(copied).not.toMatch(/[A-Za-z]:\\|\/Users\/|AppData/);

    // Clicking "检查更新…" in About opens "设置 › 更新" and triggers update.check
    fireEvent.click(screen.getByTestId("about-check-update"));
    await waitFor(() => expect(screen.queryByTestId("about-dialog")).toBeNull());
    expect(await screen.findByTestId("settings-page-update")).toBeTruthy();
    expect(releaseHost.of("update.check").length).toBeGreaterThanOrEqual(1);

    cleanup();

    // 2. Development channel
    installHost({
      facets: FACETS,
      channel: "development",
      appVersion: "0.1.4-dev.202611081530",
      buildInfo: {
        version: "0.1.4-dev.202611081530",
        channel: "development",
        commit: "d00d777",
        builtAt: "2026-11-08T15:30:00.000Z",
        schemaVersion: 14,
      },
    });
    render(<App />);
    await screen.findByTestId("sidebar");

    fireEvent.click(screen.getByTestId("menu-help"));
    await screen.findByTestId("menu-help-about");
    expect(screen.queryByTestId("menu-help-check-update")).toBeNull();
    fireEvent.click(screen.getByTestId("menu-help-about"));

    await screen.findByTestId("about-dialog");
    expect(screen.getByTestId("about-version").textContent).toBe("0.1.4-dev.202611081530");
    expect(screen.getByTestId("about-channel").textContent).toBe("开发版");
    expect(screen.getByTestId("about-dev-hint").textContent).toBe("开发版：由本机构建自动更新");
    expect(screen.queryByTestId("about-check-update")).toBeNull();
  });

  it("renders '设置 › 更新' in release vs development channels, toggles autoCheck/autoDownload, and shows verification errors (AT-159, AT-160)", async () => {
    let currentState = {
      version: "0.1.1",
      channel: "release" as const,
      commit: "c79f49a",
      builtAt: "2026-11-08T08:00:00.000Z",
      schemaVersion: 14,
      state: "idle" as "idle" | "error",
      lastCheckedAt: "2026-11-08T09:00:00.000Z",
      availableVersion: null as string | null,
      releaseNotes: null as string | null,
      targetSchemaVersion: null as number | null,
      willUpgradeSchema: false,
      downloadedBytes: 0,
      totalBytes: 0,
      usedDifferential: false,
      error: null as string | null,
      errorCode: null as string | null,
      settings: { autoCheck: true, autoDownload: true },
      justUpdated: null,
    };

    const host = installHost({
      facets: FACETS,
      channel: "release",
      appVersion: "0.1.1",
      buildInfo: {
        version: "0.1.1",
        channel: "release",
        commit: "c79f49a",
        builtAt: "2026-11-08T08:00:00.000Z",
        schemaVersion: 14,
      },
      overrides: {
        "update.status": () => currentState,
        "update.settings.set": (input) => {
          currentState = {
            ...currentState,
            settings: { ...currentState.settings, ...input },
          };
          return currentState.settings;
        },
        "update.check": () => {
          currentState = {
            ...currentState,
            state: "error",
            errorCode: "UPDATE_VERIFY_FAILED",
            error: "更新包校验失败，已保留当前版本",
          };
          return currentState;
        },
      },
    });

    render(<App />);
    fireEvent.click(await screen.findByTestId("nav-settings"));
    await screen.findByTestId("settings-nav");
    fireEvent.click(screen.getByTestId("settings-nav-update"));
    await screen.findByTestId("settings-page-update");

    expect(screen.getByTestId("update-current-version").textContent).toBe("0.1.1");
    expect(screen.getByTestId("update-current-channel").textContent).toBe("正式版");
    expect(screen.getByTestId("update-current-commit").textContent).toBe("c79f49a");
    expect(screen.getByTestId("update-state-label").textContent).toBe("已是最新版本");

    const autoCheckBox = screen.getByTestId("update-auto-check") as HTMLInputElement;
    const autoDownloadBox = screen.getByTestId("update-auto-download") as HTMLInputElement;
    expect(autoCheckBox.checked).toBe(true);
    expect(autoDownloadBox.checked).toBe(true);

    fireEvent.click(autoCheckBox);
    await waitFor(() => expect(host.of("update.settings.set")).toContainEqual({ commandId: "update.settings.set", input: { autoCheck: false } }));

    fireEvent.click(screen.getByTestId("update-check-now"));
    await waitFor(() => expect(screen.getByTestId("update-state-label").textContent).toContain("更新包校验失败，已保留当前版本"));

    cleanup();

    // Development channel in "设置 › 更新"
    installHost({
      facets: FACETS,
      channel: "development",
      appVersion: "0.1.2-dev.202611081530",
    });
    render(<App />);
    fireEvent.click(await screen.findByTestId("nav-settings"));
    await screen.findByTestId("settings-nav");
    fireEvent.click(screen.getByTestId("settings-nav-update"));
    await screen.findByTestId("settings-page-update");

    expect(screen.getByTestId("update-dev-mode").textContent).toBe("开发版：由本机构建自动更新");
    expect(screen.queryByTestId("update-check-now")).toBeNull();
  });

  it("shows top-bar ready banner, release notes with schema upgrade notice, busy confirmation dialog when recording, and post-update notice (AT-159)", async () => {
    let statusPayload = {
      version: "0.1.1",
      channel: "release" as const,
      commit: "c79f49a",
      builtAt: "2026-11-08T08:00:00.000Z",
      schemaVersion: 14,
      state: "ready" as const,
      lastCheckedAt: "2026-11-08T10:00:00.000Z",
      availableVersion: "0.1.2",
      releaseNotes: "1. 新增每周自动发布\n2. 优化下载体验",
      targetSchemaVersion: 15,
      willUpgradeSchema: true,
      downloadedBytes: 4096,
      totalBytes: 32768,
      usedDifferential: true,
      error: null,
      errorCode: null,
      settings: { autoCheck: true, autoDownload: true },
      justUpdated: null as { version: string; previousVersion: string; releaseNotes: string } | null,
    };

    const host = installHost({
      facets: FACETS,
      channel: "release",
      appVersion: "0.1.1",
      overrides: {
        "update.status": (input) => {
          if (input.dismissJustUpdated) {
            statusPayload = { ...statusPayload, justUpdated: null };
          }
          return statusPayload;
        },
        "update.restartToUpdate": (input) => {
          const busy = (input.busyReasons as string[] | undefined) ?? [];
          if (!input.force && busy.length > 0) {
            return { status: "busy", restarted: false, busyReasons: busy, version: "0.1.2" };
          }
          return { status: "restarting", restarted: true, busyReasons: [], version: "0.1.2" };
        },
      },
    });

    render(<App />);
    const banner = await screen.findByTestId("update-banner");
    expect(banner.textContent).toContain("新版本 0.1.2 已就绪");

    // Expand release notes popover and verify schema upgrade notice
    fireEvent.click(screen.getByTestId("update-notes-button"));
    const popover = await screen.findByTestId("update-notes-popover");
    expect(popover.textContent).toContain("新增每周自动发布");
    expect(screen.getByTestId("update-schema-notice").textContent).toBe("这次更新会升级资料库，升级前会自动备份");

    // Mark a tab as recording so clicking "重启以更新" prompts for confirmation first
    tabMarks.set("tab-1", "recording", true);
    fireEvent.click(screen.getByTestId("update-restart-button"));

    const busyDialog = await screen.findByTestId("update-busy-dialog");
    expect(busyDialog).toBeTruthy();
    expect(screen.getByTestId("update-busy-body").textContent).toContain("正在录音，现在重启会中断录音。确定要重启并更新吗？");

    // Cancel keeps app running
    fireEvent.click(screen.getByTestId("update-busy-cancel"));
    await waitFor(() => expect(screen.queryByTestId("update-busy-dialog")).toBeNull());

    // Click restart again and confirm -> calls update.restartToUpdate with force: true
    fireEvent.click(screen.getByTestId("update-restart-button"));
    await screen.findByTestId("update-busy-dialog");
    fireEvent.click(screen.getByTestId("update-busy-confirm"));
    await waitFor(() =>
      expect(host.of("update.restartToUpdate")).toContainEqual({
        commandId: "update.restartToUpdate",
        input: { force: true, busyReasons: ["recording"] },
      }),
    );

    // Clicking "稍后" snoozes the top-bar banner for the session
    fireEvent.click(screen.getByTestId("update-later-button"));
    await waitFor(() => expect(screen.queryByTestId("update-banner")).toBeNull());

    // First launch after update: justUpdated notice in top bar
    statusPayload = {
      ...statusPayload,
      version: "0.1.2",
      state: "idle" as never,
      availableVersion: null as never,
      justUpdated: {
        version: "0.1.2",
        previousVersion: "0.1.1",
        releaseNotes: "1. 新增每周自动发布",
      },
    };
    host.emitNotice("update.changed", statusPayload as unknown as Record<string, unknown>);

    const justUpdatedEl = await screen.findByTestId("update-just-updated");
    expect(justUpdatedEl.textContent).toContain("已更新到 0.1.2");

    fireEvent.click(screen.getByTestId("update-just-updated-notes"));
    expect((await screen.findByTestId("update-notes-popover")).textContent).toContain("新增每周自动发布");

    fireEvent.click(screen.getByTestId("update-just-updated-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("update-just-updated")).toBeNull());
  });
});
