import { describe, expect, it } from "vitest";
import {
  activeCues, arrangeLines, cueLines, DEFAULT_SUBTITLE_STYLE, layoutSubtitles, liftDialogue, normalizeStyle, overrideAssStyles, parseSubtitleCues, pictureBox, scriptOf,
} from "../../apps/desktop/src/renderer/readers/subtitle-model.ts";

describe("subtitle cues", () => {
  it("reads an SRT file into cues with the times in milliseconds", () => {
    const cues = parseSubtitleCues(["1", "00:00:01,500 --> 00:00:03,000", "你好", "世界", "", "2", "01:02:03,004 --> 01:02:04,000", "再见"].join("\n"));
    expect(cues).toEqual([
      { startMs: 1500, endMs: 3000, lines: ["你好", "世界"], top: false },
      { startMs: 3_723_004, endMs: 3_724_000, lines: ["再见"], top: false },
    ]);
  });

  it("reads WebVTT: the header, ids, short times, settings, and a byte-order mark", () => {
    const cues = parseSubtitleCues(["﻿WEBVTT", "", "NOTE a comment", "", "intro", "00:01.000 --> 00:02.000 align:start position:10%", "第一句", "", "00:00:03.000 --> 00:00:04.000", "<i>第二句</i>"].join("\r\n"));
    expect(cues.map((cue) => [cue.startMs, cue.endMs, cue.lines])).toEqual([[1000, 2000, ["第一句"]], [3000, 4000, ["第二句"]]]);
  });

  it("skips a block with no readable time, an end before its start, or no text, and keeps the rest", () => {
    const cues = parseSubtitleCues(["1", "00:00:05,000 --> 00:00:04,000", "backwards", "", "2", "not a time --> 00:00:04,000", "garbled", "", "3", "00:00:01,000 --> 00:00:02,000", "", "", "4", "00:00:06,000 --> 00:00:07,000", "kept"].join("\n"));
    expect(cues.map((cue) => cue.lines)).toEqual([["kept"]]);
  });

  it("returns the cues in order of start", () => {
    const cues = parseSubtitleCues(["1", "00:00:05,000 --> 00:00:06,000", "b", "", "2", "00:00:01,000 --> 00:00:02,000", "a"].join("\n"));
    expect(cues.map((cue) => cue.lines[0])).toEqual(["a", "b"]);
  });

  it("removes markup, override blocks and entities, and keeps line breaks", () => {
    expect(cueLines("<b>Bold</b> &amp; <font color=\"#fff\">plain</font>")).toEqual(["Bold & plain"]);
    expect(cueLines("{\\an8}{\\pos(100,50)}Top\\Nsecond")).toEqual(["Top", "second"]);
    expect(cueLines("  padded  \n\n  lines ")).toEqual(["padded", "lines"]);
  });

  it("marks a cue at the top by an alignment tag or a WebVTT line near the top", () => {
    const srt = parseSubtitleCues(["1", "00:00:01,000 --> 00:00:02,000", "{\\an8}sign", "", "2", "00:00:03,000 --> 00:00:04,000", "{\\an7}corner", "", "3", "00:00:05,000 --> 00:00:06,000", "{\\an2}low", "", "4", "00:00:07,000 --> 00:00:08,000", "{\\a6}old top", "", "5", "00:00:09,000 --> 00:00:10,000", "plain"].join("\n"));
    expect(srt.map((cue) => cue.top)).toEqual([true, true, false, true, false]);
    const vtt = parseSubtitleCues(["WEBVTT", "", "00:01.000 --> 00:02.000 line:10%", "near the top", "", "00:03.000 --> 00:04.000 line:85%", "low", "", "00:05.000 --> 00:06.000 line:1", "line one", "", "00:07.000 --> 00:08.000 line:-1", "last line"].join("\n"));
    expect(vtt.map((cue) => cue.top)).toEqual([true, false, true, false]);
  });
});

describe("the cues showing at a time", () => {
  const cues = parseSubtitleCues(["1", "00:00:01,000 --> 00:00:03,000", "a", "", "2", "00:00:02,000 --> 00:00:04,000", "b", "", "3", "00:00:06,000 --> 00:00:07,000", "c"].join("\n"));

  it("finds the cues that have started and not ended, including two at once", () => {
    expect(activeCues(cues, 500)).toEqual([]);
    expect(activeCues(cues, 1500).map((cue) => cue.lines[0])).toEqual(["a"]);
    expect(activeCues(cues, 2500).map((cue) => cue.lines[0])).toEqual(["a", "b"]);
    expect(activeCues(cues, 3500).map((cue) => cue.lines[0])).toEqual(["b"]);
    expect(activeCues(cues, 5000)).toEqual([]);
    expect(activeCues(cues, 6000).map((cue) => cue.lines[0])).toEqual(["c"]);
  });

  it("treats a cue as ending at its end time, not including it", () => {
    expect(activeCues(cues, 3000).map((cue) => cue.lines[0])).toEqual(["b"]);
    expect(activeCues(cues, 7000)).toEqual([]);
  });

  it("is quick over a long file", () => {
    const many = Array.from({ length: 20_000 }, (_, index) => ({ startMs: index * 1000, endMs: index * 1000 + 800, lines: [String(index)], top: false }));
    const started = performance.now();
    for (let index = 0; index < 2000; index += 1) activeCues(many, (index * 9973) % 20_000_000);
    expect(performance.now() - started).toBeLessThan(200);
    expect(activeCues(many, 12_345_300).map((cue) => cue.lines[0])).toEqual(["12345"]);
  });
});

describe("which lines of a cue go where", () => {
  it("tells Chinese from other scripts; Japanese counts as another script, and digits and signs follow the line before", () => {
    expect(scriptOf("你好")).toBe("zh");
    expect(scriptOf("Hello")).toBe("other");
    expect(scriptOf("こんにちは世界")).toBe("other");
    expect(scriptOf("♪ 12 ♪")).toBe("none");
  });

  it("keeps one language's lines in order at the standard height, two speakers included", () => {
    expect(arrangeLines(["- 去吗？", "- 去。"])).toEqual([{ text: "- 去吗？", small: false }, { text: "- 去。", small: false }]);
    expect(arrangeLines(["- Going?", "- Going."])).toEqual([{ text: "- Going?", small: false }, { text: "- Going.", small: false }]);
  });

  it("puts the Chinese of a bilingual cue first at the standard height and the other language after it at the small one", () => {
    expect(arrangeLines(["Where are you going?", "你要去哪里？"])).toEqual([{ text: "你要去哪里？", small: false }, { text: "Where are you going?", small: true }]);
    expect(arrangeLines(["你要去哪里？", "どこへ行くの？"])).toEqual([{ text: "你要去哪里？", small: false }, { text: "どこへ行くの？", small: true }]);
  });

  it("lets a line with no letters stay with the line before it", () => {
    expect(arrangeLines(["你好", "♪"])).toEqual([{ text: "你好", small: false }, { text: "♪", small: false }]);
  });
});

describe("where the subtitle zones are", () => {
  const frame = { w: 1920, h: 1080 };

  it("fits the picture in the frame as the video is drawn, with the bars around it", () => {
    expect(pictureBox(frame, { w: 1920, h: 1080 })).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    const wide = pictureBox(frame, { w: 1920, h: 804 });
    expect(wide.w).toBe(1920);
    expect(wide.h).toBeCloseTo(804, 5);
    expect(wide.y).toBeCloseTo(138, 5);
    const tall = pictureBox(frame, { w: 1440, h: 1080 });
    expect(tall).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
    expect(pictureBox({ w: 0, h: 0 }, { w: 1920, h: 1080 })).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    // Before the video knows its size the frame stands in for the picture.
    expect(pictureBox(frame, { w: 0, h: 0 })).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it("sets the dialogue zone 90% wide, a tenth high, its lower edge 5% above the picture's bottom, with type 5% of the picture's height", () => {
    const layout = layoutSubtitles(frame, { w: 1920, h: 1080 }, DEFAULT_SUBTITLE_STYLE);
    expect(layout.place).toBe("inside");
    expect(layout.dialogue).toEqual({ x: 96, y: 1080 - 54 - 108, w: 1728, h: 108 });
    expect(layout.mainPx).toBe(54);
    expect(layout.smallPx).toBe(40.5);
    expect(layout.topPx).toBeCloseTo(39.96, 5);
    expect(layout.top).toEqual({ x: 192, y: 108, w: 1536, h: 864 });
  });

  it("lifts only the dialogue above controls laid over the bottom, and leaves the picture and the type size where they are (AT-89)", () => {
    const base = layoutSubtitles(frame, { w: 1920, h: 1080 }, DEFAULT_SUBTITLE_STYLE);
    // The zone ends 54 px above the bottom; a bar 84 px high covers it, so the zone moves up by 30 px.
    const lifted = liftDialogue(base, 1080, 84);
    expect(lifted.dialogue).toEqual({ ...base.dialogue, y: base.dialogue.y - 30 });
    expect(lifted.picture).toEqual(base.picture);
    expect(lifted.mainPx).toBe(base.mainPx);
    expect(lifted.top).toEqual(base.top);
    // A bar that does not reach the zone, or no bar, moves nothing.
    expect(liftDialogue(base, 1080, 40)).toBe(base);
    expect(liftDialogue(base, 1080, 0)).toBe(base);
    // A dialogue under a widescreen picture is lifted too, and never above the top of the frame.
    const wide = layoutSubtitles(frame, { w: 1920, h: 804 }, DEFAULT_SUBTITLE_STYLE);
    expect(liftDialogue(wide, 1080, 84).dialogue.y + wide.dialogue.h).toBeLessThanOrEqual(1080 - 84);
    expect(liftDialogue(base, 1080, 5000).dialogue.y).toBe(0);
  });

  it("scales with the picture, not with the frame", () => {
    const small = layoutSubtitles({ w: 960, h: 540 }, { w: 1920, h: 1080 }, DEFAULT_SUBTITLE_STYLE);
    expect(small.mainPx).toBe(27);
    expect(small.dialogue.w).toBe(864);
    const barred = layoutSubtitles({ w: 1920, h: 1080 }, { w: 1440, h: 1080 }, DEFAULT_SUBTITLE_STYLE);
    expect(barred.mainPx).toBe(54);
    expect(barred.dialogue.x).toBe(240 + 72);
    expect(barred.dialogue.w).toBe(1296);
  });

  it("puts the dialogue below a widescreen picture when the black bar can hold it, and keeps it inside when told to", () => {
    const wide = layoutSubtitles(frame, { w: 1920, h: 804 }, DEFAULT_SUBTITLE_STYLE);
    expect(wide.place).toBe("below");
    expect(wide.dialogue.y).toBeCloseTo(138 + 804, 5);
    expect(wide.dialogue.h).toBeCloseTo(80.4, 5);
    expect(wide.mainPx).toBeCloseTo(40.2, 5);
    expect(layoutSubtitles(frame, { w: 1920, h: 804 }, { ...DEFAULT_SUBTITLE_STYLE, placement: "inside" }).place).toBe("inside");
  });

  it("keeps it inside when the bar is thinner than the zone, or the picture is not that wide", () => {
    expect(layoutSubtitles({ w: 1920, h: 830 }, { w: 1920, h: 804 }, DEFAULT_SUBTITLE_STYLE).place).toBe("inside");
    expect(layoutSubtitles(frame, { w: 1920, h: 800 }, DEFAULT_SUBTITLE_STYLE).place).toBe("below");
    // 2.1:1 is wider than 16:9 but not widescreen as the standard counts it.
    expect(layoutSubtitles(frame, { w: 2100, h: 1000 }, DEFAULT_SUBTITLE_STYLE).place).toBe("inside");
  });
});

describe("the subtitle style", () => {
  it("fills what is missing with the standard's default and keeps the size in range", () => {
    expect(normalizeStyle(undefined)).toEqual(DEFAULT_SUBTITLE_STYLE);
    expect(normalizeStyle({ sizePct: 12 }).sizePct).toBe(8);
    expect(normalizeStyle({ sizePct: 1 }).sizePct).toBe(3);
    expect(normalizeStyle({ sizePct: Number.NaN }).sizePct).toBe(5);
    expect(normalizeStyle({ sizePct: 5.04 }).sizePct).toBe(5);
    expect(normalizeStyle({ font: "gothic" as never, placement: "other" as never, assStyle: "x" as never })).toMatchObject({ font: "sans", placement: "auto", assStyle: "keep" });
    expect(normalizeStyle({ outline: false }).outline).toBe(false);
  });
});

describe("an ASS file styled by the standard", () => {
  const ass = [
    "[Script Info]", "PlayResX: 1280", "PlayResY: 720", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,60,&H00FFFF00,&H000000FF,&H00FF0000,&H00000000,-1,-1,0,0,90,90,2,0,1,5,3,8,10,10,10,1",
    "Style: Sign,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8\\pos(640,100)\\fs80\\fnComic Sans MS\\b1}Hello, world",
    "Dialogue: 0,0:00:01.00,0:00:03.00,Sign,,0,0,0,,{\\p1\\pos(0,0)}m 0 0 l 10 0 10 10",
    "Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,Plain, with commas",
  ].join("\r\n");

  const styleOf = (text: string, name: string) => text.split("\n").find((line) => line.startsWith(`Style: ${name},`))!.replace("Style: ", "").split(",");

  it("replaces font, size, colour, outline, alignment and margins of every style, keeping the names", () => {
    const out = overrideAssStyles(ass, { fontName: "Microsoft YaHei", sizePct: 5 });
    const fields = styleOf(out, "Default");
    // Name, Fontname, Fontsize ... in the file's own order.
    expect(fields[0]).toBe("Default");
    expect(fields[1]).toBe("Microsoft YaHei");
    expect(fields[2]).toBe("36");
    expect(fields[3]).toBe("&H00FFFFFF");
    expect(fields[7]).toBe("0");
    expect(fields[8]).toBe("0");
    expect(fields[11]).toBe("100");
    expect(fields[15]).toBe("1");
    expect(fields[16]).toBe("2");
    expect(fields[17]).toBe("1");
    // A top-aligned style (a sign) stays at the top with a tenth of the height as margin, the rest go to the bottom with a twentieth.
    expect(fields[18]).toBe("8");
    expect(fields[19]).toBe("64");
    expect(fields[20]).toBe("64");
    expect(fields[21]).toBe("72");
    expect(styleOf(out, "Sign")[21]).toBe("72");
    expect(styleOf(out, "Sign")[1]).toBe("Microsoft YaHei");
  });

  it("takes the size from the script's own height so the picture's 5% holds at any script resolution", () => {
    expect(styleOf(overrideAssStyles(ass, { fontName: "SimSun", sizePct: 5 }), "Default")[2]).toBe("36");
    expect(styleOf(overrideAssStyles(ass.replace("PlayResY: 720", "PlayResY: 360"), { fontName: "SimSun", sizePct: 5 }), "Default")[2]).toBe("18");
    expect(styleOf(overrideAssStyles(ass, { fontName: "SimSun", sizePct: 6 }), "Default")[2]).toBe("43");
  });

  it("removes position and size tags from dialogue and keeps the text, the times and the commas in it", () => {
    const lines = overrideAssStyles(ass, { fontName: "SimSun", sizePct: 5 }).split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(lines[0]).toBe("Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8\\b1}Hello, world");
    expect(lines[2]).toBe("Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,Plain, with commas");
  });

  it("leaves a line that draws shapes alone: it is a sign, not a subtitle", () => {
    const lines = overrideAssStyles(ass, { fontName: "SimSun", sizePct: 5 }).split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(lines[1]).toContain("{\\p1\\pos(0,0)}m 0 0 l 10 0 10 10");
  });

  it("is a no-op on text that is not an ASS file", () => {
    expect(overrideAssStyles("1\n00:00:01,000 --> 00:00:02,000\nhi", { fontName: "SimSun", sizePct: 5 })).toBe("1\n00:00:01,000 --> 00:00:02,000\nhi");
  });
});
