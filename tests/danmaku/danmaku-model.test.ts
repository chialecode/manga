import { describe, expect, it } from "vitest";
import { DEFAULT_DANMAKU_SETTINGS, validPattern, type DanmakuItem, type DanmakuSettings } from "@manga/contracts/danmaku";
import { compilePatterns, crossingSeconds, danmakuMetrics, offsetSeconds, pictureRect, prepareDanmaku, shownCount, sourcesOf, visibleFilter } from "../../apps/desktop/src/renderer/readers/danmaku-model.ts";

const settings = (patch: Partial<DanmakuSettings> = {}): DanmakuSettings => ({ ...DEFAULT_DANMAKU_SETTINGS, bottom: true, ...patch });
const item = (at: number, text: string, patch: Partial<DanmakuItem> = {}): DanmakuItem => ({ at, mode: "scroll", color: 0xffffff, source: "", text, ...patch });

describe("danmaku model: what the settings show", () => {
  it("leaves out kinds, sources, words and patterns the person blocked", () => {
    const items = [
      item(1000, "好看"),
      item(2000, "顶部", { mode: "top" }),
      item(3000, "底部", { mode: "bottom" }),
      item(4000, "来自别处", { source: "BiliBili" }),
      item(5000, "剧透 前方"),
      item(6000, "233333"),
    ];
    const all = settings({ merge: false });
    expect(prepareDanmaku(items, all, 0).map((entry) => entry.text)).toEqual(["好看", "顶部", "底部", "来自别处", "剧透 前方", "233333"]);
    expect(prepareDanmaku(items, { ...all, top: false, bottom: false }, 0).map((entry) => entry.text)).toEqual(["好看", "来自别处", "剧透 前方", "233333"]);
    expect(prepareDanmaku(items, { ...all, sourcesOff: ["BiliBili"] }, 0).map((entry) => entry.text)).not.toContain("来自别处");
    expect(prepareDanmaku(items, { ...all, blockWords: ["剧透"] }, 0).map((entry) => entry.text)).not.toContain("剧透 前方");
    expect(prepareDanmaku(items, { ...all, blockPatterns: ["^\\d+$"] }, 0).map((entry) => entry.text)).not.toContain("233333");
  });

  it("compares words without caring for case, and keeps working when one pattern is bad", () => {
    const filter = visibleFilter({ ...settings(), blockWords: ["SPOILER"], blockPatterns: ["(a+)+", "[", "^w+$"] });
    expect(filter(item(0, "a spoiler here"))).toBe(false);
    expect(filter(item(0, "wwww"))).toBe(false);
    expect(filter(item(0, "fine"))).toBe(true);
    expect(compilePatterns(["(a+)+", "[", "ok"]).map((pattern) => pattern.source)).toEqual(["ok"]);
  });

  it("refuses a pattern that can make the screen wait", () => {
    expect(validPattern("(a+)+")).toBe(false);
    expect(validPattern("(a*)*b")).toBe(false);
    expect(validPattern("(x|y+)*")).toBe(false);
    expect(validPattern("[")).toBe(false);
    expect(validPattern("^哈+$")).toBe(true);
    expect(validPattern("a+b+")).toBe(true);
  });

  it("counts the comments that are shown for the panel", () => {
    const items = [item(0, "a"), item(1, "b", { mode: "top" }), item(2, "c", { mode: "bottom" })];
    expect(shownCount(items, settings({ bottom: false }))).toBe(2);
    expect(shownCount(items, settings())).toBe(3);
  });
});

describe("danmaku model: merging and time", () => {
  it("merges the same comment within ten seconds into one that says how many there were", () => {
    const items = [item(1000, "哈哈哈"), item(3000, "哈哈哈"), item(5000, "哈哈哈"), item(9000, "ＨＡＨＡ"), item(9500, "haha"), item(11_500, "哈哈哈"), item(12_000, "别的")];
    const merged = prepareDanmaku(items, settings(), 0);
    expect(merged.map((entry) => entry.text)).toEqual(["哈哈哈 ×3", "ＨＡＨＡ ×2", "哈哈哈", "别的"]);
    expect(merged.map((entry) => entry.time)).toEqual([1, 9, 11.5, 12]);
    // Another mode with the same words is another comment, and merging can be switched off.
    expect(prepareDanmaku([item(0, "同"), item(1000, "同", { mode: "top" })], settings(), 0)).toHaveLength(2);
    expect(prepareDanmaku(items, settings({ merge: false }), 0)).toHaveLength(7);
  });

  it("puts the offset and the file's own start on the video element's clock", () => {
    const prepared = prepareDanmaku([item(10_000, "x")], settings(), 2500, 1000);
    expect(prepared[0]!.time).toBeCloseTo(13.5, 5);
    expect(prepareDanmaku([item(10_000, "x")], settings(), -2500)[0]!.time).toBeCloseTo(7.5, 5);
  });

  it("names the modes for the engine and takes the colour only when asked", () => {
    const items = [item(0, "a", { color: 0xff0000 }), item(1, "b", { mode: "top", color: 0x00ff00 }), item(2, "c", { mode: "bottom", color: 0x0000ff })];
    const on = prepareDanmaku(items, settings({ merge: false }), 0);
    expect(on.map((entry) => [entry.mode, entry.color])).toEqual([["rtl", "#ff0000"], ["top", "#00ff00"], ["bottom", "#0000ff"]]);
    expect(prepareDanmaku(items, settings({ merge: false, color: false }), 0).every((entry) => entry.color === "#ffffff")).toBe(true);
  });

  it("lists the sources with their counts, the network's own first", () => {
    const items = [item(0, "a", { source: "BiliBili" }), item(1, "b", { source: "BiliBili" }), item(2, "c", { source: "" }), item(3, "d", { source: "Gamer" })];
    expect(sourcesOf(items)).toEqual([{ source: "", count: 1 }, { source: "BiliBili", count: 2 }, { source: "Gamer", count: 1 }]);
  });
});

describe("danmaku model: size and place", () => {
  it("scales the text with the picture's height and the speed with its width", () => {
    expect(danmakuMetrics(1920, 1080, { size: 100, speed: 192 })).toEqual({ fontPx: 25, speedPxPerS: 192 });
    expect(danmakuMetrics(960, 540, { size: 100, speed: 192 })).toEqual({ fontPx: 13, speedPxPerS: 96 });
    expect(danmakuMetrics(1920, 1080, { size: 200, speed: 192 }).fontPx).toBe(50);
    // A comment always takes the same time to cross, whatever the size of the picture.
    const a = danmakuMetrics(1280, 720, { size: 100, speed: 240 });
    const b = danmakuMetrics(3840, 2160, { size: 100, speed: 240 });
    expect(1280 / a.speedPxPerS).toBeCloseTo(3840 / b.speedPxPerS, 5);
    expect(crossingSeconds(192)).toBe(10);
    expect(crossingSeconds(240)).toBe(8);
    // Tiny and huge pictures keep a readable size.
    expect(danmakuMetrics(100, 50, { size: 50, speed: 192 }).fontPx).toBe(12);
    expect(danmakuMetrics(7680, 4320, { size: 200, speed: 192 }).fontPx).toBe(72);
  });

  it("covers the picture and not the bars around it", () => {
    // A 16:9 picture in a 4:3 stage has bars above and below.
    expect(pictureRect(1200, 900, 1920, 1080)).toEqual({ left: 0, top: 113, width: 1200, height: 675 });
    // A 4:3 picture in a 16:9 stage has bars at the sides.
    expect(pictureRect(1920, 1080, 1440, 1080)).toEqual({ left: 240, top: 0, width: 1440, height: 1080 });
    // Before the size of the video is known the whole stage is used.
    expect(pictureRect(800, 450, 0, 0)).toEqual({ left: 0, top: 0, width: 800, height: 450 });
    expect(pictureRect(0, 0, 1920, 1080)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });

  it("writes the offset in whole tenths of a second with its sign", () => {
    expect(offsetSeconds(0)).toBe("0");
    expect(offsetSeconds(2500)).toBe("+2.5");
    expect(offsetSeconds(-5000)).toBe("-5");
  });
});
