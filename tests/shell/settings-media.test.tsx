/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { MediaPrefs, Modules, Providers, Recording, keyLabel } from "../../apps/desktop/src/renderer/pages/settings-media.tsx";
import { SettingsNav } from "../../apps/desktop/src/renderer/pages/settings/settings-nav.tsx";
import { hiddenSettingsPages } from "../../apps/desktop/src/renderer/pages/settings/settings-view.tsx";
import { DEFAULT_SHELL_PREFERENCE } from "@manga/contracts";
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from "../../apps/desktop/src/renderer/voice/use-recorder.ts";

const i18n = createTranslator("zh-CN");

type Call = { commandId: string; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => unknown;

const module = (featureId: string, wanted = true, extra: Record<string, unknown> = {}) => ({ featureId, moduleId: `manga.${featureId}`, displayName: featureId, wanted, state: wanted ? "active" : "disabled", core: false, ...extra });

function installHost(overrides: Record<string, Handler> = {}, secrets: string[] = []) {
  const calls: Call[] = [];
  let modules = [module("comic"), module("video"), module("metadata"), module("voice"), module("notes"), { ...module("settings"), core: true }];
  const handlers: Record<string, Handler> = {
    "settings.getModules": () => ({ modules }),
    "settings.setModule": (input) => {
      modules = modules.map((item) => item.featureId === input.featureId ? { ...item, wanted: input.enabled as boolean, state: input.enabled ? "active" : "disabled" } : item);
      return { modules };
    },
    "metadata.providers": () => ({ providers: [{ id: "bangumi", displayName: "Bangumi", kind: "online", namespace: "bangumi", enabled: true, credentialConfigured: false }, { id: "local-file", displayName: "文件内置资料", kind: "local", namespace: "local-file", enabled: true, credentialConfigured: false }] }),
    ...overrides,
  };
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = handlers[payload.commandId];
      if (!handler) return { status: "ok", value: {} };
      try { return { status: "ok", value: handler(input) }; } catch (error) {
        const failure = error as { code?: string; message?: string };
        return { status: "error", error: { code: failure.code ?? "INTERNAL", message: failure.message ?? "failed" } };
      }
    },
    async stashSecret(value: string) { secrets.push(value); return `secret_${secrets.length}`; },
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

const comicDefaults = { direction: "rtl", layout: "single", coverAlone: true, fit: "page", zoom: 1, autoFlipSeconds: 0, animation: "fade" } as const;
const videoDefaults = { rate: 1, holdRate: 2, volume: 1, muted: false, seekStepSeconds: 5, autoNext: false };

/**
 * Settings are separate pages now (modules, reading, recording, sources); each is rendered by its own component and shown by the
 * navigation. This puts the four components side by side, as the one old panel did, so every choice is exercised the same way. Which
 * pages the navigation offers for a set of modules is checked on its own below.
 */
function renderSettings(options: { facets?: string[]; recording?: Partial<RecordingSettings>; save?: (patch: Partial<RecordingSettings>) => Promise<void>; onModulesChanged?: () => void; onError?: (message: string) => void; onNotice?: (message: string) => void; comic?: (patch: unknown) => void; video?: (patch: unknown) => void } = {}) {
  const facets = new Set(options.facets ?? ["comic", "video", "metadata", "voice", "notes"]);
  const hidden = hiddenSettingsPages(facets);
  return render(
    <>
      <Modules t={i18n.t} onChanged={options.onModulesChanged ?? (() => undefined)} />
      <MediaPrefs
        t={i18n.t}
        facets={facets}
        reading={DEFAULT_SHELL_PREFERENCE.reading}
        onReading={() => undefined}
        comic={comicDefaults}
        onComic={(options.comic ?? (() => undefined)) as never}
        video={videoDefaults}
        onVideo={(options.video ?? (() => undefined)) as never}
      />
      {hidden.has("recording") ? null : <Recording t={i18n.t} settings={{ ...DEFAULT_RECORDING_SETTINGS, ...options.recording }} save={options.save ?? (async () => undefined)} onNotice={options.onNotice ?? (() => undefined)} />}
      {hidden.has("sources") ? null : <Providers t={i18n.t} onError={options.onError ?? (() => undefined)} onNotice={options.onNotice ?? (() => undefined)} />}
    </>,
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("settings for media, recording and metadata", () => {
  it("lists the optional modules as switches and leaves out the ones the app cannot run without", async () => {
    installHost();
    renderSettings();
    await waitFor(() => expect(screen.getByTestId("module-comic")).toBeTruthy());
    expect((screen.getByTestId("module-voice") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId("module-settings")).toBeNull();
    expect(screen.getByTestId("msettings-modules").textContent).toContain("录音");
    expect(screen.getByTestId("module-state-video").textContent).toBe("已开启");
  });

  it("turns a module off, shows it as off, and tells the app to reload what is on", async () => {
    const host = installHost();
    const changed = vi.fn();
    renderSettings({ onModulesChanged: changed });
    await waitFor(() => expect(screen.getByTestId("module-video")).toBeTruthy());
    fireEvent.click(screen.getByTestId("module-video"));
    await waitFor(() => expect((screen.getByTestId("module-video") as HTMLInputElement).checked).toBe(false));
    expect(host.of("settings.setModule")[0]!.input).toEqual({ featureId: "video", enabled: false });
    expect(screen.getByTestId("module-state-video").textContent).toBe("已关闭");
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it("says why a module could not be turned off and leaves the switch as it was", async () => {
    installHost({ "settings.setModule": () => { throw Object.assign(new Error("required feature comic is explicitly disabled"), { code: "DEPENDENCY_UNSATISFIED" }); } });
    renderSettings();
    await waitFor(() => expect(screen.getByTestId("module-comic")).toBeTruthy());
    fireEvent.click(screen.getByTestId("module-comic"));
    await waitFor(() => expect(screen.getByTestId("msettings-module-error").textContent).toContain("comic is explicitly disabled"));
    expect((screen.getByTestId("module-comic") as HTMLInputElement).checked).toBe(true);
  });

  it("shows only the sections of the modules that are on", async () => {
    installHost();
    renderSettings({ facets: ["comic", "notes"] });
    await waitFor(() => expect(screen.getByTestId("msettings-modules")).toBeTruthy());
    expect(screen.getByTestId("msettings-comic")).toBeTruthy();
    expect(screen.queryByTestId("msettings-video")).toBeNull();
    expect(screen.queryByTestId("msettings-recording")).toBeNull();
    expect(screen.queryByTestId("msettings-metadata")).toBeNull();
  });

  it("leaves a page out of the settings navigation only when its module is off, and keeps the others reachable", () => {
    const listed = (facets: string[]) => {
      const view = render(<SettingsNav t={i18n.t} page="general" hidden={hiddenSettingsPages(new Set(facets))} onPage={() => undefined} onBack={() => undefined} />);
      const ids = [...view.container.querySelectorAll("[data-testid^='settings-nav-']")].map((node) => node.getAttribute("data-testid")!.replace("settings-nav-", ""));
      view.unmount();
      return ids;
    };
    const everything = listed(["agent", "comic", "video", "metadata", "voice", "notes"]);
    expect(everything).toEqual(expect.arrayContaining(["general", "appearance", "reading", "recording", "library", "sources", "storage", "modules", "shortcuts", "models", "quick", "usage", "records", "logs"]));
    const minimal = listed(["agent"]);
    expect(minimal).not.toContain("recording");
    expect(minimal).not.toContain("sources");
    // The pages that hold the switches and the records stay, so a module that was turned off can always be turned on again.
    expect(minimal).toEqual(expect.arrayContaining(["general", "library", "modules", "records", "logs"]));
    expect(listed([])).not.toEqual(expect.arrayContaining(["models", "quick", "usage"]));
  });

  it("changes recording choices one at a time", async () => {
    installHost();
    const save = vi.fn(async () => undefined);
    renderSettings({ save });
    fireEvent.change(screen.getByTestId("msettings-retention"), { target: { value: "discard" } });
    fireEvent.change(screen.getByTestId("msettings-duck"), { target: { value: "pause" } });
    fireEvent.change(screen.getByTestId("msettings-margin"), { target: { value: "450" } });
    fireEvent.change(screen.getByTestId("msettings-margin"), { target: { value: "99999" } });
    expect(save.mock.calls.map((call) => call[0])).toEqual([{ retention: "discard" }, { duckPlayback: "pause" }, { boundaryMarginMs: 450 }, { boundaryMarginMs: 2000 }]);
  });

  it("lists the microphones and chooses one, or the system default", async () => {
    installHost();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [
      { kind: "audioinput", deviceId: "default", label: "默认" }, { kind: "audioinput", deviceId: "mic1", label: "耳机麦克风" }, { kind: "videoinput", deviceId: "cam", label: "相机" },
    ] } });
    const save = vi.fn(async () => undefined);
    renderSettings({ save });
    await waitFor(() => expect(screen.getByRole("option", { name: "耳机麦克风" })).toBeTruthy());
    expect(screen.queryByRole("option", { name: "相机" })).toBeNull();
    fireEvent.change(screen.getByTestId("msettings-device"), { target: { value: "mic1" } });
    fireEvent.change(screen.getByTestId("msettings-device"), { target: { value: "" } });
    expect(save.mock.calls.map((call) => call[0])).toEqual([{ deviceId: "mic1" }, { deviceId: null }]);
  });

  it("keeps a chosen microphone that is no longer plugged in, so the choice is visible", async () => {
    installHost();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [] } });
    renderSettings({ recording: { deviceId: "gone" } });
    await waitFor(() => expect((screen.getByTestId("msettings-device") as HTMLSelectElement).value).toBe("gone"));
  });

  it("picks a key by pressing it, refuses the other action's key, and lets Escape back out", async () => {
    installHost();
    const save = vi.fn(async () => undefined);
    renderSettings({ save });
    const hold = screen.getByTestId("msettings-hold-key");
    expect(hold.textContent).toBe("F9");
    fireEvent.click(hold);
    expect(hold.textContent).toBe("请按键…");
    fireEvent.keyDown(window, { code: "KeyR" });
    expect(save).toHaveBeenLastCalledWith({ holdKey: "KeyR" });
    // The toggle key is F8: choosing it for the hold key is refused.
    fireEvent.click(hold);
    fireEvent.keyDown(window, { code: "F8" });
    expect(screen.getByTestId("msettings-key-clash")).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(hold);
    fireEvent.keyDown(window, { code: "Escape" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(hold.textContent).toBe("F9");
    expect(keyLabel("KeyR")).toBe("R");
    expect(keyLabel("Digit5")).toBe("5");
  });

  it("restores the floating box's place and size", async () => {
    installHost();
    const save = vi.fn(async () => undefined);
    const notices: string[] = [];
    renderSettings({ save, onNotice: (message) => notices.push(message) });
    fireEvent.click(screen.getByTestId("msettings-overlay-reset"));
    await waitFor(() => expect(notices).toHaveLength(1));
    expect(save).toHaveBeenCalledWith({ overlay: { width: 280, height: 84 } });
  });

  it("changes the comic and video preferences", async () => {
    installHost();
    const comic = vi.fn();
    const video = vi.fn();
    renderSettings({ comic, video });
    fireEvent.change(screen.getByTestId("msettings-comic-direction"), { target: { value: "ltr" } });
    fireEvent.click(screen.getByTestId("msettings-comic-cover"));
    fireEvent.change(screen.getByTestId("msettings-video-step"), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("msettings-video-step"), { target: { value: "500" } });
    fireEvent.change(screen.getByTestId("msettings-video-hold"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("msettings-video-autonext"));
    expect(comic.mock.calls.map((call) => call[0])).toEqual([{ direction: "ltr" }, { coverAlone: false }]);
    expect(video.mock.calls.map((call) => call[0])).toEqual([{ seekStepSeconds: 10 }, { holdRate: 3 }, { autoNext: true }]);
  });

  it("turns the online source off and on", async () => {
    const host = installHost();
    renderSettings();
    await waitFor(() => expect(screen.getByTestId("provider-enabled-bangumi")).toBeTruthy());
    expect(screen.queryByTestId("provider-local-file")).toBeNull();
    fireEvent.click(screen.getByTestId("provider-enabled-bangumi"));
    await waitFor(() => expect(host.of("metadata.setProvider")).toHaveLength(1));
    expect(host.of("metadata.setProvider")[0]!.input).toEqual({ providerId: "bangumi", enabled: false });
  });

  it("stores a token through the credential handle and never sends the token itself in the command", async () => {
    const secrets: string[] = [];
    const host = installHost({}, secrets);
    renderSettings();
    await waitFor(() => expect(screen.getByTestId("provider-token-bangumi")).toBeTruthy());
    expect((screen.getByTestId("provider-token-save-bangumi") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("provider-token-bangumi"), { target: { value: "合成令牌-123" } });
    fireEvent.click(screen.getByTestId("provider-token-save-bangumi"));
    await waitFor(() => expect(host.of("metadata.setProvider")).toHaveLength(1));
    expect(secrets).toEqual(["合成令牌-123"]);
    expect(host.of("metadata.setProvider")[0]!.input).toEqual({ providerId: "bangumi", enabled: true, credentialHandle: "secret_1" });
    expect(JSON.stringify(host.calls)).not.toContain("合成令牌-123");
    // The field is emptied: the token is not kept on screen.
    await waitFor(() => expect((screen.getByTestId("provider-token-bangumi") as HTMLInputElement).value).toBe(""));
  });

  it("shows that a token is saved and clears it on request", async () => {
    const host = installHost({ "metadata.providers": () => ({ providers: [{ id: "bangumi", displayName: "Bangumi", kind: "online", namespace: "bangumi", enabled: true, credentialConfigured: true }] }) });
    renderSettings();
    await waitFor(() => expect(screen.getByTestId("provider-token-set-bangumi")).toBeTruthy());
    fireEvent.click(screen.getByTestId("provider-token-clear-bangumi"));
    await waitFor(() => expect(host.of("metadata.setProvider")).toHaveLength(1));
    expect(host.of("metadata.setProvider")[0]!.input).toEqual({ providerId: "bangumi", enabled: true, clearCredential: true });
  });
});
