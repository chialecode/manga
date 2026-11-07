/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drawTextSubtitles, DEFAULT_SUBTITLE_INK, shownLines, wrapText } from "../../apps/desktop/src/renderer/readers/subtitle-raster.ts";
import { DEFAULT_SUBTITLE_STYLE, layoutSubtitles, SUBTITLE_FONT_STACKS, type SubtitleCue, type SubtitleStyle } from "../../apps/desktop/src/renderer/readers/subtitle-model.ts";
import { installCapture } from "../helpers/dom.ts";

/**
 * The text subtitles of a screenshot (AT-109): where the lines go on a picture of the file's own size, what size they are, and that they follow the
 * player's layout. A canvas that only records stands in for the real one (jsdom has none); the real pixels are looked at in the packaged app.
 */
let capture: ReturnType<typeof installCapture>;
beforeEach(() => { capture = installCapture(); });
afterEach(() => { capture.restore(); });

const W = 1920;
const H = 1080;
const cue = (startMs: number, endMs: number, lines: string[], top = false): SubtitleCue => ({ startMs, endMs, lines, top });
const style = (patch: Partial<SubtitleStyle> = {}): SubtitleStyle => ({ ...DEFAULT_SUBTITLE_STYLE, ...patch });

function draw(input: { main?: SubtitleCue[]; second?: SubtitleCue[]; timeMs?: number; style?: SubtitleStyle; width?: number; height?: number }) {
  const canvas = document.createElement("canvas");
  canvas.width = input.width ?? W;
  canvas.height = input.height ?? H;
  const context = canvas.getContext("2d")!;
  capture.texts.length = 0;
  const lines = drawTextSubtitles(context, canvas.width, canvas.height, { main: input.main ?? [], second: input.second ?? [], timeMs: input.timeMs ?? 1000, style: input.style ?? style() });
  return { lines, fills: capture.texts.filter((item) => item.op === "fill"), strokes: capture.texts.filter((item) => item.op === "stroke") };
}
const sizeOf = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]);

describe("which lines show at a moment", () => {
  it("gives the lines of the cues showing, in order, and nothing outside them", () => {
    const cues = [cue(0, 1000, ["一"]), cue(500, 2000, ["二", "三"]), cue(3000, 4000, ["四"])];
    expect(shownLines(cues, 700)).toEqual(["一", "二", "三"]);
    expect(shownLines(cues, 2500)).toEqual([]);
    expect(shownLines(cues, 3000)).toEqual(["四"]);
  });
});

describe("wrapping a line to the width of the zone", () => {
  const measure = (text: string) => Array.from(text).length * 10;
  it("leaves a line that fits alone", () => {
    expect(wrapText(measure, "short", 100)).toEqual(["short"]);
  });
  it("breaks between words, and does not start a line with the space it broke at", () => {
    expect(wrapText(measure, "aaa bbb ccc", 70)).toEqual(["aaa bbb", "ccc"]);
  });
  it("breaks Chinese text between any two characters", () => {
    expect(wrapText(measure, "这是一句很长的中文字幕", 50)).toEqual(["这是一句很", "长的中文字", "幕"]);
  });
  it("cuts a word that is wider than a line where it stops fitting", () => {
    expect(wrapText(measure, "abcdefghijkl", 50)).toEqual(["abcde", "fghij", "kl"]);
  });
});

describe("text subtitles drawn on a screenshot (AT-109)", () => {
  it("draws nothing, and says so, when no cue shows at that moment", () => {
    const result = draw({ main: [cue(0, 500, ["早"])], timeMs: 900 });
    expect(result.lines).toBe(0);
    expect(capture.texts).toHaveLength(0);
  });

  it("draws the dialogue centred in the zone the player uses, its lower edge 5% above the bottom, at 5% of the picture's height", () => {
    const { lines, fills } = draw({ main: [cue(0, 2000, ["你好"])] });
    const layout = layoutSubtitles({ w: W, h: H }, { w: W, h: H }, style());
    expect(lines).toBe(1);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.text).toBe("你好");
    expect(fills[0]!.x).toBeCloseTo(W / 2, 3);
    expect(sizeOf(fills[0]!.font)).toBeCloseTo(layout.mainPx, 1);
    expect(sizeOf(fills[0]!.font)).toBeCloseTo(H * 0.05, 1);
    // The line's box ends at the bottom of the zone: centre of a box 1.15 times the type high.
    const bottom = layout.dialogue.y + layout.dialogue.h;
    expect(bottom).toBeCloseTo(H * 0.95, 3);
    expect(fills[0]!.y).toBeCloseTo(bottom - (layout.mainPx * 1.15) / 2, 2);
    expect(fills[0]!.font).toContain(SUBTITLE_FONT_STACKS.sans.split(",")[0]!.replace(/"/g, ""));
  });

  it("stacks two lines of a cue upward from the bottom, the first above the second", () => {
    const { fills } = draw({ main: [cue(0, 2000, ["上一行", "下一行"])] });
    expect(fills.map((item) => item.text)).toEqual(["下一行", "上一行"]);
    expect(fills[1]!.y).toBeLessThan(fills[0]!.y);
    expect(fills[0]!.y - fills[1]!.y).toBeCloseTo(H * 0.05 * 1.15, 2);
  });

  it("puts the Chinese of a bilingual cue on top at full size and the other language under it at three quarters", () => {
    const { fills } = draw({ main: [cue(0, 2000, ["Hello there", "你好"])] });
    const chinese = fills.find((item) => item.text === "你好")!;
    const english = fills.find((item) => item.text === "Hello there")!;
    expect(english.y).toBeGreaterThan(chinese.y);
    expect(sizeOf(english.font) / sizeOf(chinese.font)).toBeCloseTo(0.75, 2);
  });

  it("draws a secondary track under the main one, at the smaller size", () => {
    const { fills } = draw({ main: [cue(0, 2000, ["主字幕"])], second: [cue(0, 2000, ["Second line"])] });
    const main = fills.find((item) => item.text === "主字幕")!;
    const second = fills.find((item) => item.text === "Second line")!;
    expect(second.y).toBeGreaterThan(main.y);
    expect(sizeOf(second.font) / sizeOf(main.font)).toBeCloseTo(0.75, 2);
  });

  it("draws a secondary track alone when the main one shows nothing", () => {
    const { lines, fills } = draw({ main: [cue(5000, 6000, ["晚"])], second: [cue(0, 2000, ["only second"])] });
    expect(lines).toBe(1);
    expect(fills[0]!.text).toBe("only second");
  });

  it("puts a caption marked as top in the top zone, from its upper edge down", () => {
    const { fills } = draw({ main: [cue(0, 2000, ["（门铃声）"], true), cue(0, 2000, ["对白"])] });
    const layout = layoutSubtitles({ w: W, h: H }, { w: W, h: H }, style());
    const caption = fills.find((item) => item.text === "（门铃声）")!;
    const dialogue = fills.find((item) => item.text === "对白")!;
    expect(caption.y).toBeGreaterThan(layout.top.y);
    expect(caption.y).toBeLessThan(layout.top.y + layout.topPx * 1.15);
    expect(sizeOf(caption.font)).toBeCloseTo(layout.topPx, 1);
    expect(dialogue.y).toBeGreaterThan(H * 0.8);
  });

  it("keeps the dialogue on the picture even where the player would put it on a black bar", () => {
    // 2.4:1 with the default placement: on screen the dialogue goes on the black bar under the picture; a screenshot has no bar.
    const { fills } = draw({ main: [cue(0, 2000, ["宽银幕"])], width: 2400, height: 1000 });
    expect(fills[0]!.y).toBeLessThan(1000);
    expect(fills[0]!.y).toBeGreaterThan(1000 * 0.8);
  });

  it("follows the size, the font and the outline of the style", () => {
    const small = draw({ main: [cue(0, 2000, ["字"])], style: style({ sizePct: 8, font: "kai" }) });
    expect(sizeOf(small.fills[0]!.font)).toBeCloseTo(H * 0.08, 1);
    expect(small.fills[0]!.font).toContain("KaiTi");
  });

  it("outlines the type with the edge colour before filling it with the ink, and leaves the outline out when it is off", () => {
    const on = draw({ main: [cue(0, 2000, ["描边"])] });
    expect(on.strokes.map((item) => item.text)).toEqual(["描边"]);
    expect(on.strokes[0]!.fillStyle).toBe(DEFAULT_SUBTITLE_INK.edge);
    expect(on.fills[0]!.fillStyle).toBe(DEFAULT_SUBTITLE_INK.ink);
    const order = capture.texts.map((item) => item.op);
    expect(order).toEqual(["stroke", "fill"]);
    const off = draw({ main: [cue(0, 2000, ["无描边"])], style: style({ outline: false }) });
    expect(off.strokes).toHaveLength(0);
    expect(off.fills).toHaveLength(1);
  });

  it("breaks a line that is wider than the zone into lines that fit, the lines kept in order", () => {
    const long = "这是一句非常非常长的对白，长到一行放不下，所以要折成两行或者更多行来显示在画面的下方。".repeat(2);
    const { fills } = draw({ main: [cue(0, 2000, [long])] });
    expect(fills.length).toBeGreaterThan(1);
    expect(fills.map((item) => item.text).reverse().join("")).toBe(long);
    const layout = layoutSubtitles({ w: W, h: H }, { w: W, h: H }, style());
    for (const item of fills) expect(Array.from(item.text).length * layout.mainPx * 0.5).toBeLessThanOrEqual(layout.dialogue.w + 0.001);
    // The last line of the cue is the one that sits at the bottom.
    expect(fills[0]!.y).toBeGreaterThan(fills[1]!.y);
  });

  it("keeps the same share of the picture at any size of the file", () => {
    const big = draw({ main: [cue(0, 2000, ["同比例"])], width: 3840, height: 2160 }).fills[0]!;
    const small = draw({ main: [cue(0, 2000, ["同比例"])], width: 960, height: 540 }).fills[0]!;
    expect(sizeOf(big.font) / 2160).toBeCloseTo(sizeOf(small.font) / 540, 3);
    expect(big.y / 2160).toBeCloseTo(small.y / 540, 3);
  });
});
