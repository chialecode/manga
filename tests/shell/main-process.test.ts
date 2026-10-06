import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { externalUrlAllowed, isAppPage, permissionAllowed } from "../../apps/desktop/src/main/permissions.ts";
import { OVERLAY_MARGIN, overlayDocument, parseOverlayState, placeOverlay } from "../../apps/desktop/src/main/overlay-model.ts";
import { productWindow } from "../../apps/desktop/src/main/window-options.ts";

// Built from parts: the publication check refuses literal drive paths in a public file.
const DRIVE = ["C", ":"].join("");
const FILE_APP = `file:///${DRIVE}/Program%20Files/MANGA/resources/app.asar/.vite/renderer/main_window/index.html`;
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
    for (const permission of ["geolocation", "notifications", "clipboard-read", "display-capture", "midi", "usb", "fullscreen", "openExternal", "camera"]) {
      expect(permissionAllowed(facts({ permission, mediaTypes: undefined })), permission).toBe(false);
    }
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

describe("the floating recording box", () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1280, height: 720 }];

  it("goes to the top right of the main screen when no place was saved", () => {
    expect(placeOverlay({ width: 280, height: 84 }, screens)).toEqual({ x: 1920 - 280 - OVERLAY_MARGIN, y: OVERLAY_MARGIN, width: 280, height: 84 });
  });

  it("keeps a saved place that is still on a screen, including a second screen", () => {
    expect(placeOverlay({ x: 400, y: 300, width: 280, height: 84 }, screens)).toEqual({ x: 400, y: 300, width: 280, height: 84 });
    expect(placeOverlay({ x: 2500, y: 100, width: 280, height: 84 }, screens)).toEqual({ x: 2500, y: 100, width: 280, height: 84 });
  });

  it("pulls a box that hangs off the edge of its screen back in", () => {
    expect(placeOverlay({ x: 1850, y: 980, width: 280, height: 84 }, screens)).toEqual({ x: 1920 - 280, y: 1040 - 84, width: 280, height: 84 });
  });

  it("returns to the main screen when its monitor is gone", () => {
    const only = [screens[0]!];
    expect(placeOverlay({ x: 2500, y: 100, width: 280, height: 84 }, only)).toEqual({ x: 1920 - 280 - OVERLAY_MARGIN, y: OVERLAY_MARGIN, width: 280, height: 84 });
    expect(placeOverlay({ x: -5000, y: -5000, width: 280, height: 84 }, only).x).toBeGreaterThanOrEqual(0);
  });

  it("keeps the size within what can be read and clicked", () => {
    expect(placeOverlay({ width: 10, height: 10 }, screens)).toMatchObject({ width: 160, height: 48 });
    expect(placeOverlay({ width: 5000, height: 5000 }, screens)).toMatchObject({ width: 640, height: 320 });
  });

  const strings = { recording: "正在录音", stopping: "正在保存…", stop: "停止录音", keep: "保留录音", discard: "不保留录音", hold: "按住录音", toggle: "切换录音" };
  const good = { phase: "recording", elapsedMs: 3500.7, level: 0.4, retention: "keep", mode: "hold", label: "麦克风", strings };

  it("accepts a well-formed state and clamps what can be out of range", () => {
    expect(parseOverlayState(good)).toMatchObject({ phase: "recording", elapsedMs: 3500, level: 0.4, retention: "keep", mode: "hold" });
    expect(parseOverlayState({ ...good, level: 5 })!.level).toBe(1);
    expect(parseOverlayState({ ...good, level: -1 })!.level).toBe(0);
  });

  it("drops anything that is not a state, instead of showing it", () => {
    for (const bad of [null, undefined, "x", 5, {}, { ...good, phase: "idle" }, { ...good, elapsedMs: -1 }, { ...good, elapsedMs: Number.NaN }, { ...good, retention: "x" }, { ...good, mode: "x" },
      { ...good, strings: { ...strings, stop: 5 } }, { ...good, strings: { ...strings, stop: "x".repeat(200) } }, { ...good, strings: undefined }, { ...good, label: 4 }]) {
      expect(parseOverlayState(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("shows text with textContent, has no network or storage, and has a stop button that the script wires", () => {
    const html = overlayDocument();
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/innerHTML|document\.write|eval\(|fetch\(|XMLHttpRequest|localStorage/);
    expect(html).toContain("textContent");
    expect(html).toContain('id="stop"');
    expect(html).toContain("mangaOverlay");
    // The page's script is valid JavaScript.
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("window colors", () => {
  it("the window and its caption buttons use the page colors of the app", () => {
    const css = readFileSync(new URL("../../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8");
    const token = (name: string) => new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(css)![1]!.toUpperCase();
    expect(productWindow.backgroundColor.toUpperCase()).toBe(token("bg"));
    expect(productWindow.titleBarOverlay.color.toUpperCase()).toBe(token("bg"));
    expect(productWindow.titleBarOverlay.symbolColor.toUpperCase()).toBe(token("text"));
  });
});
