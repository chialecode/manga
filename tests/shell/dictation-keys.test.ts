import { describe, expect, it } from "vitest";
import {
  KEY_ACTIONS,
  actionOf,
  checkOverrides,
  chordLabel,
  chordOf,
  conflictsWith,
  findConflicts,
  isChord,
  keyAction,
  parseChord,
  recordingCodeToChord,
  resolveKeys,
} from "@manga/contracts/keys";

describe("dictation shortcut and recording key conflict rules", () => {
  it("registers global.dictationHold with RightAlt default and renders 右 Alt", () => {
    const def = keyAction("global.dictationHold");
    expect(def).toBeDefined();
    expect(def?.group).toBe("global");
    expect(def?.defaults).toEqual(["RightAlt"]);
    expect(isChord("RightAlt")).toBe(true);
    expect(parseChord("RightAlt")).toEqual({ ctrl: false, alt: false, shift: false, key: "RightAlt" });
    expect(chordLabel("RightAlt")).toBe("右 Alt");

    // Modifier-prefixed RightAlt is rejected so RightAlt is only bound as a standalone key.
    expect(isChord("Ctrl+RightAlt")).toBe(false);
    expect(isChord("Alt+RightAlt")).toBe(false);
    expect(isChord("Shift+RightAlt")).toBe(false);

    const resolved = resolveKeys(null);
    expect(resolved["global.dictationHold"]).toEqual(["RightAlt"]);
    expect(findConflicts(resolved)).toEqual([]);
  });

  it("recognizes standalone AltRight without breaking LeftAlt+Arrow or AltGr combinations", () => {
    // Standalone physical RightAlt press
    expect(chordOf({ key: "Alt", code: "AltRight", altKey: true })).toBe("RightAlt");
    expect(actionOf({ key: "Alt", code: "AltRight", altKey: true }, resolveKeys(null), "global")).toBe("global.dictationHold");

    // Standalone LeftAlt remains a pure modifier (null)
    expect(chordOf({ key: "Alt", code: "AltLeft", altKey: true })).toBeNull();
    expect(chordOf({ key: "Alt", altKey: true })).toBeNull();

    // LeftAlt + Arrow navigation remains intact
    expect(chordOf({ key: "ArrowLeft", code: "ArrowLeft", altKey: true })).toBe("Alt+ArrowLeft");
    expect(chordOf({ key: "ArrowRight", code: "ArrowRight", altKey: true })).toBe("Alt+ArrowRight");

    // AltGr (reported as AltGraph or Ctrl+Alt) and Shift+AltRight never trigger solo RightAlt
    expect(chordOf({ key: "AltGraph", code: "AltRight" })).toBeNull();
    expect(chordOf({ key: "Alt", code: "AltRight", ctrlKey: true, altKey: true })).toBeNull();
    expect(chordOf({ key: "Alt", code: "AltRight", shiftKey: true, altKey: true })).toBeNull();
    expect(chordOf({ key: "Alt", code: "AltRight", metaKey: true, altKey: true })).toBeNull();
    expect(chordOf({ key: "e", code: "KeyE", ctrlKey: true, altKey: true })).toBe("Ctrl+Alt+E");
  });

  it("checks conflicts against recording holdKey (F9) and toggleKey (F8)", () => {
    expect(recordingCodeToChord("F9")).toBe("F9");
    expect(recordingCodeToChord("F8")).toBe("F8");
    expect(recordingCodeToChord("AltRight")).toBe("RightAlt");
    expect(recordingCodeToChord("KeyV")).toBe("V");

    const base = resolveKeys(null);
    expect(conflictsWith(base, "global.dictationHold", "F9")).toEqual(["recording.holdKey"]);
    expect(conflictsWith(base, "global.dictationHold", "F8")).toEqual(["recording.toggleKey"]);
    expect(conflictsWith(base, "video.customRate", "F9")).toEqual(["recording.holdKey"]);

    expect(checkOverrides({ "global.dictationHold": ["F9"] })).toMatch(/F9 is used by/);
    expect(checkOverrides({ "global.dictationHold": ["F8"] })).toMatch(/F8 is used by/);
    expect(checkOverrides({ "global.dictationHold": ["F7"] })).toBeNull();

    // Custom recording keys are also respected when passed in
    expect(conflictsWith(base, "global.dictationHold", "F7", { holdKey: "F7", toggleKey: "F6" })).toEqual(["recording.holdKey"]);
    expect(findConflicts(resolveKeys({ "global.dictationHold": ["F6"] }), { holdKey: "F7", toggleKey: "F6" })).toEqual([
      { chord: "F6", actions: ["global.dictationHold", "recording.toggleKey"] },
    ]);
    expect(KEY_ACTIONS.some((item) => item.id === "global.dictationHold")).toBe(true);
  });
});
