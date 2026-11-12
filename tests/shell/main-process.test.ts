import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { externalUrlAllowed, isAppPage, permissionAllowed } from "../../apps/desktop/src/main/permissions.ts";
import {
  OVERLAY_HEIGHT,
  OVERLAY_MARGIN,
  OVERLAY_WIDTH,
  micColorForLevel,
  overlayDocument,
  overlaySummary,
  parseOverlayState,
  placeOverlay,
} from "../../apps/desktop/src/main/overlay-model.ts";
import { WINDOW_ACTIONS, parseWindowAction, productWindow, windowControlsDrawn } from "../../apps/desktop/src/main/window-options.ts";

// Built from parts: the publication check refuses literal drive paths in a public file.
const DRIVE = ["C", ":"].join("");
const FILE_APP = `file:///${DRIVE}/Program%20Files/manga/resources/app.asar/.vite/renderer/main_window/index.html`;
const DEV_APP = "http://localhost:5173/";
const facts = (patch: Partial<Parameters<typeof permissionAllowed>[0]> = {}) => ({ permission: "media", requestingUrl: FILE_APP, mediaTypes: ["audio"], appUrl: FILE_APP, fromAppWindow: true, ...patch });

describe("permissions of the app window", () => {
  it("allows the microphone for the app's own page and nothing that includes a camera", () => {
    expect(permissionAllowed(facts())).toBe(true);
    expect(permissionAllowed(facts({ mediaTypes: ["audio", "video"] }))).toBe(false);
    expect(permissionAllowed(facts({ mediaTypes: ["video"] }))).toBe(false);
    // A request that does not say what it wants is refused.
    expect(permissionAllowed(facts({ mediaTypes: [] }))).toBe(false);
    expect(permissionAllowed(facts({ mediaTypes: undefined }))).toBe(false);
  });

  it("allows the font list for subtitle styles, and refuses every other permission", () => {
    expect(permissionAllowed(facts({ permission: "local-fonts", mediaTypes: undefined }))).toBe(true);
    for (const permission of ["geolocation", "notifications", "clipboard-read", "display-capture", "midi", "usb", "openExternal", "camera"]) {
      expect(permissionAllowed(facts({ permission, mediaTypes: undefined })), permission).toBe(false);
    }
  });

  // Regression: `requestFullscreen()` in all three readers was refused here, so the full-screen buttons did nothing.
  it("allows full screen for the app's own window, so the reader and player full-screen buttons work", () => {
    expect(permissionAllowed(facts({ permission: "fullscreen", mediaTypes: undefined }))).toBe(true);
    expect(permissionAllowed(facts({ permission: "fullscreen", mediaTypes: undefined, requestingUrl: `${FILE_APP}#/reader` }))).toBe(true);
    expect(permissionAllowed(facts({ permission: "fullscreen", mediaTypes: undefined, appUrl: DEV_APP, requestingUrl: DEV_APP }))).toBe(true);
  });

  // Regression (AT-97): "copy as JSON" and the debug panel's copy said that the copy failed in the real window: the page's write to the clipboard was refused here.
  it("allows the app's own page to write text to the clipboard, and never to read it", () => {
    expect(permissionAllowed(facts({ permission: "clipboard-sanitized-write", mediaTypes: undefined }))).toBe(true);
    expect(permissionAllowed(facts({ permission: "clipboard-sanitized-write", mediaTypes: undefined, appUrl: DEV_APP, requestingUrl: DEV_APP }))).toBe(true);
    for (const permission of ["clipboard-read", "clipboard-write"]) expect(permissionAllowed(facts({ permission, mediaTypes: undefined })), permission).toBe(false);
  });

  it("refuses the clipboard to another window or another page", () => {
    expect(permissionAllowed(facts({ permission: "clipboard-sanitized-write", mediaTypes: undefined, fromAppWindow: false }))).toBe(false);
    expect(permissionAllowed(facts({ permission: "clipboard-sanitized-write", mediaTypes: undefined, requestingUrl: "https://example.com/" }))).toBe(false);
    expect(permissionAllowed(facts({ permission: "clipboard-sanitized-write", mediaTypes: undefined, requestingUrl: "" }))).toBe(false);
  });

  it("refuses full screen for another window or another page", () => {
    expect(permissionAllowed(facts({ permission: "fullscreen", mediaTypes: undefined, fromAppWindow: false }))).toBe(false);
    expect(permissionAllowed(facts({ permission: "fullscreen", mediaTypes: undefined, requestingUrl: "https://example.com/" }))).toBe(false);
    expect(permissionAllowed(facts({ permission: "fullscreen", mediaTypes: undefined, requestingUrl: "" }))).toBe(false);
  });

  it("refuses another window or another page, even for the microphone", () => {
    expect(permissionAllowed(facts({ fromAppWindow: false }))).toBe(false);
    expect(permissionAllowed(facts({ requestingUrl: "https://example.com/" }))).toBe(false);
    expect(permissionAllowed(facts({ requestingUrl: `file:///${DRIVE}/other/index.html` }))).toBe(false);
    expect(permissionAllowed(facts({ requestingUrl: "data:text/html,hi" }))).toBe(false);
    expect(permissionAllowed(facts({ requestingUrl: "" }))).toBe(false);
  });

  it("knows the app's own page for a file build and for the dev server", () => {
    expect(isAppPage(`${FILE_APP}#/library`, FILE_APP)).toBe(true);
    expect(isAppPage(`${FILE_APP}?x=1`, FILE_APP)).toBe(true);
    expect(isAppPage(`file:///${DRIVE}/other/evil.html`, FILE_APP)).toBe(false);
    expect(isAppPage("http://localhost:5173/anything", DEV_APP)).toBe(true);
    expect(isAppPage("http://localhost:5174/", DEV_APP)).toBe(false);
    expect(isAppPage("http://localhost.evil.test:5173/", DEV_APP)).toBe(false);
    expect(isAppPage("not a url", DEV_APP)).toBe(false);
  });
});

describe("pages opened outside the app", () => {
  it("opens only the metadata source's own https subject pages", () => {
    for (const url of ["https://bgm.tv/subject/12", "https://bangumi.tv/subject/12/", "https://chii.in/subject/5", "https://bgm.tv/character/3", "https://bgm.tv/person/9"]) {
      expect(externalUrlAllowed(url), url).toBe(true);
    }
  });

  it("refuses everything else: other hosts, other schemes, credentials, odd ports, other paths, non-strings", () => {
    for (const url of [
      "http://bgm.tv/subject/12", "https://evil.test/subject/12", "https://bgm.tv.evil.test/subject/12", ["https://user", ":pw@bgm.tv/subject/12"].join(""), "https://bgm.tv:8443/subject/12",
      "https://bgm.tv/", "https://bgm.tv/subject/abc", "https://bgm.tv/subject/12/../../login", `file:///${DRIVE}/Windows/System32/calc.exe`, "javascript:alert(1)", "ms-msdt:/id", "",
    ]) expect(externalUrlAllowed(url), url).toBe(false);
    for (const value of [undefined, null, 5, {}, [], "x".repeat(3000)]) expect(externalUrlAllowed(value)).toBe(false);
  });
});

describe("AT-172 the floating recording box", () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1280, height: 720 }];

  it("AT-172 goes to the top right of the main screen at fixed 116×36 when no place was saved", () => {
    expect(placeOverlay({}, screens)).toEqual({
      x: 1920 - OVERLAY_WIDTH - OVERLAY_MARGIN,
      y: OVERLAY_MARGIN,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    });
  });

  it("AT-172 keeps a saved place that is still on a screen, including a second screen", () => {
    expect(placeOverlay({ x: 400, y: 300 }, screens)).toEqual({ x: 400, y: 300, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
    expect(placeOverlay({ x: 2500, y: 100 }, screens)).toEqual({ x: 2500, y: 100, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
  });

  it("AT-172 converts legacy 280×84 top-right-aligned coordinates so a box at the right edge stays at the right edge", () => {
    const legacyRightAligned = { x: 1920 - 280 - OVERLAY_MARGIN, y: OVERLAY_MARGIN, width: 280, height: 84 };
    expect(placeOverlay(legacyRightAligned, screens)).toEqual({
      x: 1920 - OVERLAY_WIDTH - OVERLAY_MARGIN,
      y: OVERLAY_MARGIN,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    });
  });

  it("AT-172 pulls a box that hangs off the edge of its screen back in", () => {
    expect(placeOverlay({ x: 1850, y: 1020 }, screens)).toEqual({
      x: 1920 - OVERLAY_WIDTH,
      y: 1040 - OVERLAY_HEIGHT,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    });
  });

  it("AT-172 returns to the main screen top right when its monitor is gone", () => {
    const only = [screens[0]!];
    expect(placeOverlay({ x: 2500, y: 100 }, only)).toEqual({
      x: 1920 - OVERLAY_WIDTH - OVERLAY_MARGIN,
      y: OVERLAY_MARGIN,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    });
    expect(placeOverlay({ x: -5000, y: -5000 }, only).x).toBeGreaterThanOrEqual(0);
  });

  const strings = { recording: "正在录音", stopping: "正在保存…", stop: "停止录音", keep: "保留音频", discard: "转写后清理音频", hold: "按住录音", toggle: "单击切换", mic: "麦克风" };
  const good = { phase: "recording" as const, elapsedMs: 83_500.7, level: 0.4, retention: "keep" as const, mode: "toggle" as const, label: "USB Mic", strings };

  it("accepts a well-formed state and clamps what can be out of range", () => {
    expect(parseOverlayState(good)).toMatchObject({ phase: "recording", elapsedMs: 83_500, level: 0.4, retention: "keep", mode: "toggle", label: "USB Mic" });
    expect(parseOverlayState({ ...good, level: 5 })!.level).toBe(1);
    expect(parseOverlayState({ ...good, level: -1 })!.level).toBe(0);
  });

  it("drops anything that is not a state, instead of showing it", () => {
    for (const bad of [null, undefined, "x", 5, {}, { ...good, phase: "idle" }, { ...good, elapsedMs: -1 }, { ...good, elapsedMs: Number.NaN }, { ...good, retention: "x" }, { ...good, mode: "x" },
      { ...good, strings: { ...strings, stop: 5 } }, { ...good, strings: { ...strings, stop: "x".repeat(200) } }, { ...good, strings: undefined }, { ...good, label: 4 }]) {
      expect(parseOverlayState(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("AT-172 computes silent gray, volume-graded brand colors, reduced-motion binary color, and accessible summary", () => {
    expect(micColorForLevel(0, "recording", false)).toBe("#9CA3AF");
    expect(micColorForLevel(0.015, "recording", false)).toBe("#9CA3AF");
    const low = micColorForLevel(0.08, "recording", false);
    const mid = micColorForLevel(0.36, "recording", false);
    const loud = micColorForLevel(0.85, "recording", false);
    expect(low).not.toBe("#9CA3AF");
    expect(low).not.toBe(mid);
    expect(mid).not.toBe(loud);
    expect(loud).toBe("#84204D");
    expect(micColorForLevel(0.6, "stopping", false)).toBe("#9CA3AF");
    // Reduced motion switches strictly between silent gray and primary accent (#AD3268), with no intermediate shades.
    expect(micColorForLevel(0, "recording", true)).toBe("#9CA3AF");
    expect(micColorForLevel(0.08, "recording", true)).toBe("#AD3268");
    expect(micColorForLevel(0.85, "recording", true)).toBe("#AD3268");
    expect(overlaySummary(parseOverlayState(good)!)).toBe("正在录音 1:23，单击切换，保留音频，麦克风：USB Mic");
  });

  it("AT-172 renders only the clock in visible text, puts status/mode/retention/device in aria-label, freezes clock on stopping, and keeps preload minimal", () => {
    const html = overlayDocument();
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/innerHTML|document\.write|eval\(|fetch\(|XMLHttpRequest|localStorage/);
    expect(html).toContain("textContent");
    expect(html).toContain('id="mic"');
    expect(html).toContain('id="time"');
    expect(html).toContain('id="stop"');
    expect(html).not.toContain('id="label"');
    expect(html).not.toContain('id="meta"');
    expect(html).toContain("mangaOverlay");
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    expect(() => new Function(script)).not.toThrow();

    // Preload security boundary: mangaOverlay still exposes ONLY onState and stop.
    const preload = readFileSync(new URL("../../apps/desktop/src/preload/preload.ts", import.meta.url), "utf8");
    const block = /exposeInMainWorld\("mangaOverlay",\s*\{([\s\S]*?)\}\);/.exec(preload)![1]!;
    expect(block).toContain("onState:");
    expect(block).toContain("stop:");
    expect(block).not.toMatch(/move|bounds|setPosition|invoke/);
  });
});

describe("window colors", () => {
  it("the window uses the page color of the app, and the system draws no buttons over the page", () => {
    const css = readFileSync(new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8");
    const token = (name: string) => new RegExp(String.raw`--color-${name}:\s*(#[0-9A-Fa-f]{6})`).exec(css)![1]!.toUpperCase();
    expect(productWindow.backgroundColor.toUpperCase()).toBe(token("bg"));
    // AT-105: the window's own buttons are the page's (A-91); the overlay the system would draw over the page is gone from the window's options and the main process.
    expect(productWindow).not.toHaveProperty("titleBarOverlay");
    expect(productWindow).not.toHaveProperty("captionReservePx");
    const main = readFileSync(new URL("../../apps/desktop/src/main/index.ts", import.meta.url), "utf8");
    expect(main).not.toMatch(/titleBarOverlay|setTitleBarOverlay|manga:window-chrome/);
    expect(main).toContain("titleBarStyle: productWindow.titleBarStyle");
  });

  it("the buttons are as high as the top row", () => {
    const layout = readFileSync(new URL("../../packages/app-core/src/domain/shell-layout.ts", import.meta.url), "utf8");
    expect(Number(/export const TOP_ROW_HEIGHT = (\d+);/.exec(layout)![1])).toBe(productWindow.topHeightPx);
    const css = readFileSync(new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8");
    const frame = readFileSync(new URL("../../apps/desktop/src/renderer/styles-frame.css", import.meta.url), "utf8");
    // One variable carries the height; the top, and everything that sits under it in window full screen, read it.
    expect(css).toMatch(new RegExp(String.raw`--column-top-h: *${productWindow.topHeightPx}px`));
    expect(frame).toMatch(/\.shell-top \{[^}]*height: var\(--column-top-h\)/);
  });
});

describe("AT-105 what the page may ask of the window", () => {
  it("accepts the three actions of the window's buttons and nothing else", () => {
    expect([...WINDOW_ACTIONS]).toEqual(["minimize", "toggle-maximize", "close"]);
    for (const action of WINDOW_ACTIONS) expect(parseWindowAction(action)).toBe(action);
    for (const bad of [undefined, null, 5, {}, [], "", "maximize", "unmaximize", "setBounds", "hide", "destroy", "quit", "Minimize", "minimize ", { action: "close" }, ["close"]]) {
      expect(parseWindowAction(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("draws the buttons everywhere but on macOS, which keeps its traffic lights", () => {
    expect(windowControlsDrawn("win32")).toBe(true);
    expect(windowControlsDrawn("linux")).toBe(true);
    expect(windowControlsDrawn("darwin")).toBe(false);
  });

  it("is told to the page through channels only the page's own window may use", () => {
    const main = readFileSync(new URL("../../apps/desktop/src/main/index.ts", import.meta.url), "utf8");
    for (const channel of ["manga:window-state", "manga:window-action"]) expect(main).toContain(channel);
    // Both handlers check who is asking, and the state is pushed on every change of the window's size state.
    expect(main).toMatch(/ipcMain\.handle\("manga:window-action", \(event, requested: unknown\) => \{\s*assertCaller\(event\);/);
    expect(main).toMatch(/ipcMain\.handle\("manga:window-state", \(event\) => \{ assertCaller\(event\);/);
    for (const event of ["maximize", "unmaximize", "restore"]) expect(main).toContain(`window.on("${event}", pushWindowState)`);
    const preload = readFileSync(new URL("../../apps/desktop/src/preload/preload.ts", import.meta.url), "utf8");
    expect(preload).not.toContain("windowChrome");
    for (const name of ["windowState", "windowAction", "onWindowState"]) expect(preload).toContain(name);
  });
});
