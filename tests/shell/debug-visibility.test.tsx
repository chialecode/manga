/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KEY_ACTIONS, findConflicts, resolveKeys } from "@manga/contracts/keys";
import { createTranslator } from "@manga/i18n";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { TitleActions } from "../../apps/desktop/src/renderer/components/title-actions.tsx";
import { useKeyBindings } from "../../apps/desktop/src/renderer/hooks/use-key-bindings.ts";
import { effectiveChannel, isContextDebugEnabled } from "../../apps/desktop/src/renderer/lib/api.ts";
import { DebugPanel, DEFAULT_DEBUG_VIEW } from "../../apps/desktop/src/renderer/pages/debug-panel.tsx";
import { ShortcutsPage } from "../../apps/desktop/src/renderer/pages/settings/shortcuts-page.tsx";
import { installHost } from "../helpers/app-host.ts";
import { installMatchMedia, removeMatchMedia } from "../helpers/dom.ts";

Element.prototype.scrollIntoView = () => {};

const i18n = createTranslator("zh-CN");
const t = i18n.t;

beforeEach(() => {
  window.innerWidth = 1600;
  installMatchMedia({ reducedMotion: true });
  try { window.localStorage.clear(); } catch { /* none */ }
  delete (window as unknown as { manga?: unknown }).manga;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  removeMatchMedia();
  delete (window as unknown as { manga?: unknown }).manga;
});

describe("context debug channel resolution (#124)", () => {
  it("defaults to development when neither host nor preload provides a channel, uses preload synchronously before host loads, and prefers host state", () => {
    expect(effectiveChannel()).toBe("development");
    expect(isContextDebugEnabled()).toBe(true);

    (window as unknown as { manga: { channel: "release" | "development" | "test" } }).manga = { channel: "release" };
    expect(effectiveChannel(null)).toBe("release");
    expect(isContextDebugEnabled(null)).toBe(false);

    // Authoritative host state overrides preload (e.g. dynamic channel switch in tests or update-walk).
    expect(effectiveChannel({ layout: { channel: "development" } as never })).toBe("development");
    expect(isContextDebugEnabled({ layout: { channel: "development" } as never })).toBe(true);
    expect(isContextDebugEnabled({ layout: { channel: "test" } as never })).toBe(true);
    expect(isContextDebugEnabled({
      layout: { channel: "development" } as never,
      buildInfo: { version: "0.1.1", channel: "release", commit: "abc1234", builtAt: "2026-11-28T00:00:00.000Z", schemaVersion: 17 },
    })).toBe(false);
  });
});

describe("context debug visibility in development vs release builds (#124)", () => {
  const debugReport = () => ({
    generatedAt: "2026-11-28T00:00:00.000Z",
    scope: { page: "library" },
    model: null,
    tools: [],
    budget: {},
    lastRun: null,
  });

  it("shows the beetle button, supports Ctrl+Shift+D, renders DebugPanel, and lists global.debug in development builds", async () => {
    const host = installHost({
      channel: "development",
      overrides: { "debug.context": debugReport },
    });
    render(<App />);

    // Wait for the workspace and dock to settle so TitleEnd is mounted in its steady position.
    await waitFor(() => expect(screen.getByTestId("shell-dock")).toBeTruthy());
    const toggle = screen.getByTestId("debug-toggle");
    expect(screen.getByTestId("shell-title-actions").contains(toggle)).toBe(true);
    expect(screen.queryByTestId("debug-panel")).toBeNull();

    // Clicking the titlebar button opens and closes the debug panel.
    fireEvent.click(screen.getByTestId("debug-toggle"));
    await waitFor(() => expect(screen.getByTestId("debug-panel")).toBeTruthy());
    expect(host.of("debug.context").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("debug-toggle"));
    await waitFor(() => expect(screen.queryByTestId("debug-panel")).toBeNull());

    // Ctrl+Shift+D toggles the debug panel in development builds.
    const openEvent = new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(openEvent);
    expect(openEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByTestId("debug-panel")).toBeTruthy());

    const closeEvent = new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(closeEvent);
    await waitFor(() => expect(screen.queryByTestId("debug-panel")).toBeNull());

    // Settings › 键盘快捷键 shows global.debug in development builds.
    fireEvent.click(screen.getByTestId("nav-settings"));
    fireEvent.click(await screen.findByTestId("settings-nav-shortcuts"));
    await waitFor(() => expect(screen.getByTestId("settings-page-shortcuts")).toBeTruthy());
    expect(screen.getByTestId("key-row-global.debug")).toBeTruthy();
  });

  it("hides the beetle button, blocks Ctrl+Shift+D, never renders DebugPanel (even with persisted open state), and hides global.debug in release builds", async () => {
    // Even if a prior dev run left manga.debug.view open in localStorage, release must never render DebugPanel.
    window.localStorage.setItem("manga.debug.view", JSON.stringify({
      ses_shared: { open: true, height: 260, tab: "current" },
      "recent:library": { open: true, height: 260, tab: "current" },
    }));

    const host = installHost({
      channel: "release",
      overrides: { "debug.context": debugReport },
    });
    render(<App />);

    // Wait for Workbench shell to finish mounting.
    await waitFor(() => expect(screen.getByTestId("shell-root")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("nav-settings")).toBeTruthy());

    // Beetle button and debug panel must not exist, and debug.context must not be called.
    expect(screen.queryByTestId("debug-toggle")).toBeNull();
    expect(screen.queryByTestId("debug-panel")).toBeNull();
    expect(host.of("debug.context")).toHaveLength(0);

    // Pressing Ctrl+Shift+D in release must do nothing and must not claim the event.
    const keyEvent = new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(keyEvent);
    expect(keyEvent.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("debug-panel")).toBeNull();
    expect(host.of("debug.context")).toHaveLength(0);

    // Settings › 键盘快捷键 hides global.debug while keeping all other shortcut actions intact.
    fireEvent.click(screen.getByTestId("nav-settings"));
    fireEvent.click(await screen.findByTestId("settings-nav-shortcuts"));
    await waitFor(() => expect(screen.getByTestId("settings-page-shortcuts")).toBeTruthy());
    expect(screen.queryByTestId("key-row-global.debug")).toBeNull();
    for (const entry of KEY_ACTIONS.filter((action) => action.id !== "global.debug")) {
      expect(screen.getByTestId(`key-row-${entry.id}`), entry.id).toBeTruthy();
    }
    expect(findConflicts(resolveKeys(null))).toEqual([]);
  });

  it("prevents any startup flash in release via synchronous preload channel and preserves dev default in isolated component tests", () => {
    // 1. Synchronous preload channel === "release" (before host state() exists): TitleActions & DebugPanel hide immediately on first render.
    const host = installHost({ channel: "release", overrides: { "debug.context": debugReport } });
    (window as unknown as { manga: { channel?: string } }).manga.channel = "release";
    const actionsRelease = render(
      <TitleActions t={t} debugOpen={false} onDebug={vi.fn()} recorder={null} onStopRecording={vi.fn()} scan={null} onScan={vi.fn()} />,
    );
    expect(screen.queryByTestId("debug-toggle")).toBeNull();
    actionsRelease.unmount();

    const panelRelease = render(
      <DebugPanel
        t={t}
        view={{ ...DEFAULT_DEBUG_VIEW, open: true }}
        onView={vi.fn()}
        scope={{ page: "library" }}
        live={{ page: "library" }}
        events={[]}
        version={0}
        onNotice={vi.fn()}
      />,
    );
    expect(panelRelease.container.firstChild).toBeNull();
    expect(host.of("debug.context")).toHaveLength(0);
    panelRelease.unmount();

    // 2. Without window.manga (isolated unit test without build.json): defaults to development (visible).
    delete (window as unknown as { manga?: unknown }).manga;
    render(
      <TitleActions t={t} debugOpen={false} onDebug={vi.fn()} recorder={null} onStopRecording={vi.fn()} scan={null} onScan={vi.fn()} />,
    );
    expect(screen.getByTestId("debug-toggle")).toBeTruthy();
  });

  it("hides global.debug in standalone ShortcutsPage when showDebug is false without mutating KEY_ACTIONS", () => {
    installHost({ channel: "release" });
    function ReleaseShortcuts() {
      const keys = useKeyBindings();
      return <ShortcutsPage t={t} keys={keys} recording={{ holdKey: "F9", toggleKey: "F8" }} showDebug={false} onGoto={() => undefined} />;
    }
    render(<ReleaseShortcuts />);
    expect(screen.queryByTestId("key-row-global.debug")).toBeNull();
    expect(screen.getByTestId("key-row-global.windowFullscreen")).toBeTruthy();
    expect(KEY_ACTIONS.some((action) => action.id === "global.debug")).toBe(true);
  });
});
