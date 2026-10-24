import { describe, expect, it } from "vitest";
import {
  KEY_ACTIONS, actionOf, checkOverrides, chordLabel, chordOf, conflictsWith, findConflicts, isChord, keyAction, parseChord, resolveKeys,
} from "@manga/contracts/keys";

const press = (key: string, extra: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({ key, ...extra });

describe("the key table (AT-90)", () => {
  it("holds one entry for each action, every default a valid chord, and no two actions of a scope on one key", () => {
    expect(new Set(KEY_ACTIONS.map((entry) => entry.id)).size).toBe(KEY_ACTIONS.length);
    for (const entry of KEY_ACTIONS) {
      expect(entry.defaults.length, entry.id).toBeGreaterThan(0);
      for (const chord of entry.defaults) expect(isChord(chord), `${entry.id} ${chord}`).toBe(true);
      expect(entry.id.startsWith(`${entry.group}.`)).toBe(true);
    }
    expect(findConflicts(resolveKeys(null))).toEqual([]);
  });

  it("has the defaults of Q-26: R switches the custom rate, S takes a picture, W fills the window; and no comic or novel key is R or W", () => {
    const keys = resolveKeys(null);
    expect(keys["video.customRate"]).toEqual(["R"]);
    expect(keys["video.screenshot"]).toEqual(["S"]);
    expect(keys["video.danmaku"]).toEqual(["D"]);
    expect(keys["global.windowFullscreen"]).toEqual(["W"]);
    // W is global, so no reader may use it; R is free in the comic and the novel reader.
    for (const entry of KEY_ACTIONS) if (entry.group !== "global") expect(keys[entry.id], entry.id).not.toContain("W");
    expect(KEY_ACTIONS.filter((entry) => entry.group === "comic" || entry.group === "novel").flatMap((entry) => keys[entry.id]!)).not.toContain("R");
  });

  it("has the workspace keys of Q-33 as global actions: tabs, columns, the side columns, conversations and projects, none of them a reader's key", () => {
    const keys = resolveKeys(null);
    expect(keys["global.newTab"]).toEqual(["Ctrl+T"]);
    expect(keys["global.closeTab"]).toEqual(["Ctrl+W"]);
    expect(keys["global.reopenTab"]).toEqual(["Ctrl+Shift+T"]);
    expect(keys["global.nextTab"]).toEqual(["Ctrl+Tab"]);
    expect(keys["global.prevTab"]).toEqual(["Ctrl+Shift+Tab"]);
    expect([1, 2, 3, 4].map((n) => keys[`global.column${n}`])).toEqual([["Ctrl+1"], ["Ctrl+2"], ["Ctrl+3"], ["Ctrl+4"]]);
    expect(keys["global.splitToggle"]).toEqual(["Ctrl+\\"]);
    expect(keys["global.sidebar"]).toEqual(["Ctrl+B"]);
    expect(keys["global.dock"]).toEqual(["Ctrl+Alt+B"]);
    expect(keys["global.newConversation"]).toEqual(["Ctrl+N"]);
    expect(keys["global.newProject"]).toEqual(["Ctrl+Shift+N"]);
    // Each is found by its own key event, and a reader's keys (which have no Ctrl+letter) are untouched by them.
    expect(actionOf(press("t", { ctrlKey: true }), keys, "global")).toBe("global.newTab");
    expect(actionOf(press("T", { ctrlKey: true, shiftKey: true }), keys, "global")).toBe("global.reopenTab");
    expect(actionOf(press("Tab", { ctrlKey: true }), keys, "global")).toBe("global.nextTab");
    expect(actionOf(press("Tab", { ctrlKey: true, shiftKey: true }), keys, "global")).toBe("global.prevTab");
    expect(actionOf(press("b", { ctrlKey: true, altKey: true }), keys, "global")).toBe("global.dock");
    expect(actionOf(press("\\", { ctrlKey: true }), keys, "global")).toBe("global.splitToggle");
    expect(actionOf(press("w", { metaKey: true }), keys, "global")).toBe("global.closeTab");
    // A plain W still fills the window; Ctrl + W no longer does anything else than close the tab.
    expect(actionOf(press("w"), keys, "global")).toBe("global.windowFullscreen");
    expect(findConflicts(keys)).toEqual([]);
    const readers = KEY_ACTIONS.filter((entry) => entry.group !== "global").flatMap((entry) => keys[entry.id]!);
    for (const entry of KEY_ACTIONS.filter((item) => item.group === "global")) for (const chord of keys[entry.id]!) expect(readers, `${entry.id} ${chord}`).not.toContain(chord);
  });

  it("names a key event the way the table spells it", () => {
    expect(chordOf(press("w"))).toBe("W");
    expect(chordOf(press("W", { shiftKey: true }))).toBe("W");
    expect(chordOf(press(" "))).toBe("Space");
    expect(chordOf(press(" ", { shiftKey: true }))).toBe("Shift+Space");
    expect(chordOf(press("ArrowLeft"))).toBe("ArrowLeft");
    expect(chordOf(press("Escape"))).toBe("Esc");
    expect(chordOf(press("["))).toBe("[");
    expect(chordOf(press("d", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+D");
    expect(chordOf(press("+", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift++");
    expect(chordOf(press("=", { ctrlKey: true }))).toBe("Ctrl+=");
    expect(chordOf(press("Shift", { shiftKey: true }))).toBeNull();
    expect(chordOf(press("Control", { ctrlKey: true }))).toBeNull();
    expect(chordOf(press("Dead"))).toBeNull();
    // Cmd is Ctrl, so a chord is written once.
    expect(chordOf(press("-", { metaKey: true }))).toBe("Ctrl+-");
  });

  it("reads back what it writes, accepts only one spelling of a chord, and rejects what is not a key", () => {
    for (const chord of ["W", "Ctrl+Shift+D", "Ctrl++", "Shift+Space", "F11", "ArrowLeft", "Esc", "[", ","]) expect(parseChord(chord), chord).not.toBeNull();
    for (const bad of ["", "w", "Shift+Ctrl+D", "Ctrl+", "Hello", "Ctrl+Hello", "F25", "Ctrl+d", " "]) expect(parseChord(bad), JSON.stringify(bad)).toBeNull();
    expect(chordLabel("ArrowLeft")).toBe("←");
    expect(chordLabel("Ctrl+Shift+D")).toBe("Ctrl + Shift + D");
    expect(chordLabel("Ctrl++")).toBe("Ctrl + +");
  });

  it("finds the action of a key in its group, and takes the person's own keys over the defaults", () => {
    const keys = resolveKeys({ "video.customRate": ["Y"], "video.toggle": [] });
    expect(actionOf(press("y"), keys, "video")).toBe("video.customRate");
    expect(actionOf(press("r"), keys, "video")).toBeNull();
    // An action with no key answers to none, not to its default.
    expect(actionOf(press(" "), keys, "video")).toBeNull();
    expect(actionOf(press("k"), keys, "video")).toBeNull();
    expect(actionOf(press("w"), keys, "global")).toBe("global.windowFullscreen");
    expect(actionOf(press(" "), resolveKeys(null), "comic")).toBe("comic.next");
    expect(actionOf(press(" ", { shiftKey: true }), resolveKeys(null), "comic")).toBe("comic.prev");
    expect(actionOf(press("Escape"), resolveKeys({ "global.escape": ["Q"] }), "global")).toBe("global.escape");
  });

  it("calls two actions of one group, or one of them global, a conflict, and not two readers' actions", () => {
    const keys = resolveKeys({ "video.customRate": ["S"] });
    expect(findConflicts(keys)).toEqual([{ chord: "S", actions: expect.arrayContaining(["video.screenshot", "video.customRate"]) }]);
    expect(conflictsWith(resolveKeys(null), "video.customRate", "S")).toEqual(["video.screenshot"]);
    // A global key is taken in every reader.
    expect(conflictsWith(resolveKeys(null), "comic.zoomReset", "W")).toEqual(["global.windowFullscreen"]);
    // The comic's F and the video's F are different readers' keys.
    expect(conflictsWith(resolveKeys(null), "comic.fullscreen", "F")).toEqual([]);
    expect(findConflicts(resolveKeys({ "comic.fullscreen": ["F"], "video.fullscreen": ["F"] }))).toEqual([]);
  });

  it("refuses overrides that name no action, name a fixed one, hold a bad chord, repeat one, or share a key", () => {
    expect(checkOverrides({ "video.customRate": ["Y"] })).toBeNull();
    expect(checkOverrides({ "video.nothing": ["Y"] })).toMatch(/unknown/);
    expect(checkOverrides({ "global.escape": ["Q"] })).toMatch(/cannot be changed/);
    expect(checkOverrides({ "video.customRate": ["y"] })).toMatch(/not a key/);
    expect(checkOverrides({ "video.customRate": ["Y", "Y"] })).toMatch(/twice/);
    expect(checkOverrides({ "video.customRate": ["S"] })).toMatch(/S is used by/);
    expect(checkOverrides({ "video.customRate": ["W"] })).toMatch(/W is used by/);
    expect(keyAction("global.escape")?.fixed).toBe(true);
  });
});
