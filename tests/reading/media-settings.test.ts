import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_SETTINGS, normalizeRates, readMediaSettings, writeMediaSettings } from "../../packages/app-core/src/voice/settings.ts";
import { MediaCommandInputs } from "@manga/contracts";

/** The two calls the settings make on a store. */
function memory() {
  const meta = new Map<string, string>();
  return { getMeta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: string) => { meta.set(key, value); } } as never;
}

describe("playback rates and the key table are kept with the media settings (AT-90)", () => {
  it("starts with the default rate list, the custom rate of Q-26 (1.5x) and no changed key", () => {
    const settings = readMediaSettings(memory());
    expect(settings.video.rates).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2, 3]);
    expect(settings.video.customRate).toBe(1.5);
    expect(settings.keys).toEqual({});
    expect(DEFAULT_MEDIA_SETTINGS.video.rates).toContain(1);
  });

  it("puts the subtitles of the picture into a screenshot unless the person turned that off, and keeps the choice (AT-109)", () => {
    const store = memory();
    expect(readMediaSettings(store).video.shotSubtitles).toBe(true);
    expect(writeMediaSettings(store, { video: { shotSubtitles: false } }).video.shotSubtitles).toBe(false);
    expect(readMediaSettings(store).video.shotSubtitles).toBe(false);
    // Another setting does not bring it back.
    expect(writeMediaSettings(store, { video: { autoNext: true } }).video.shotSubtitles).toBe(false);
  });

  it("sorts the rate list, drops repeats, keeps 1x in it and refuses a rate out of range or with three decimals", () => {
    expect(normalizeRates([2, 1.3, 0.75, 1.3])).toEqual([0.75, 1, 1.3, 2]);
    expect(normalizeRates([1.25])).toEqual([1, 1.25]);
    expect(() => normalizeRates([0.2])).toThrow(/between/);
    expect(() => normalizeRates([4.5])).toThrow(/between/);
    expect(() => normalizeRates([1.255])).toThrow(/two decimals/);
    const store = memory();
    // 1.25 replaced by 1.3, as in the report that asked for it.
    const saved = writeMediaSettings(store, { video: { rates: [0.5, 0.75, 1, 1.3, 1.5, 2, 3] } });
    expect(saved.video.rates).toEqual([0.5, 0.75, 1, 1.3, 1.5, 2, 3]);
    expect(readMediaSettings(store).video.rates).toContain(1.3);
    expect(readMediaSettings(store).video.rates).not.toContain(1.25);
    // The other video settings are untouched by the patch.
    expect(readMediaSettings(store).video.holdRate).toBe(2);
  });

  it("keeps a changed key, puts the default back on null, and refuses a key that two actions would share", () => {
    const store = memory();
    expect(writeMediaSettings(store, { keys: { "video.customRate": ["Y"] } }).keys).toEqual({ "video.customRate": ["Y"] });
    expect(readMediaSettings(store).keys).toEqual({ "video.customRate": ["Y"] });
    expect(() => writeMediaSettings(store, { keys: { "video.mute": ["Y"] } })).toThrow(/Y is used by/);
    // The refused change is not kept.
    expect(readMediaSettings(store).keys).toEqual({ "video.customRate": ["Y"] });
    expect(() => writeMediaSettings(store, { keys: { "video.nothing": ["Y"] } })).toThrow(/unknown/);
    expect(writeMediaSettings(store, { keys: { "video.customRate": null } }).keys).toEqual({});
    // An action given no key is allowed (it is turned off), and swapping two keys in one patch is a valid result.
    expect(writeMediaSettings(store, { keys: { "video.mute": [] } }).keys).toEqual({ "video.mute": [] });
    expect(writeMediaSettings(store, { keys: { "video.mute": ["R"], "video.customRate": ["M"] } }).keys).toEqual({ "video.mute": ["R"], "video.customRate": ["M"] });
    // Putting a default back where another action has taken that key is a conflict too.
    expect(() => writeMediaSettings(store, { keys: { "video.mute": null } })).toThrow(/M is used by/);
  });

  it("is checked at the command's edge: the rate list and the keys have their bounds", () => {
    const schema = MediaCommandInputs["settings.setMedia"];
    expect(schema.safeParse({ video: { rates: [1, 1.3], customRate: 1.75 }, keys: { "video.customRate": ["Y"], "video.mute": null } }).success).toBe(true);
    expect(schema.safeParse({ video: { rates: [] } }).success).toBe(false);
    expect(schema.safeParse({ video: { rates: [5] } }).success).toBe(false);
    expect(schema.safeParse({ video: { customRate: 0.1 } }).success).toBe(false);
    expect(schema.safeParse({ keys: { "Video.Mute": ["M"] } }).success).toBe(false);
    expect(schema.safeParse({ keys: { "video.mute": ["A", "B", "C", "D", "E"] } }).success).toBe(false);
  });
});
