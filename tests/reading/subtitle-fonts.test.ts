import { describe, expect, it } from "vitest";
import { jassubFonts, SYSTEM_CJK_FAMILIES } from "../../apps/desktop/src/renderer/readers/subtitle-fonts.ts";
import { assFontNames } from "../../apps/desktop/src/renderer/readers/subtitle-model.ts";

const fallback = { family: "Noto Sans SC", url: "manga-media://font/fallback" };

describe("AT-84 subtitle fonts: the default font has Chinese and Japanese glyphs", () => {
  it("uses the bundled font as the default, and loads it up front, whatever the machine has: a machine font is read after the first frame and that frame is not drawn again", () => {
    const options = jassubFonts({ embedded: ["e1", "e2"], fallback, systemFamilies: new Set(["arial", "consolas"]) });
    expect(options.source).toBe("bundled");
    expect(options.defaultFont).toBe("noto sans sc");
    expect(options.availableFonts).toEqual({ "noto sans sc": fallback.url });
    // The video's own fonts first, the fallback after them: a style that finds its own font keeps it.
    expect(options.fonts).toEqual(["e1", "e2", fallback.url]);
    const machine = jassubFonts({ embedded: [], fallback, systemFamilies: new Set(["microsoft yahei", "simhei"]) });
    expect(machine).toMatchObject({ source: "bundled", defaultFont: "noto sans sc", fonts: [fallback.url] });
    expect(jassubFonts({ embedded: [], fallback, systemFamilies: null }).source).toBe("bundled");
  });

  it("uses a machine font as the default only when the app has no bundled one, in the order Microsoft YaHei, SimHei, Source Han Sans", () => {
    const some = jassubFonts({ embedded: [], fallback: null, systemFamilies: new Set(["simhei", "arial", "source han sans sc"]) });
    expect(some).toMatchObject({ source: "system", defaultFont: "simhei", fonts: [], availableFonts: {} });
    const yahei = jassubFonts({ embedded: ["e"], fallback: null, systemFamilies: new Set(["microsoft yahei", "simhei"]) });
    expect(yahei).toMatchObject({ source: "system", defaultFont: "microsoft yahei", fonts: ["e"] });
    expect(SYSTEM_CJK_FAMILIES.slice(0, 3)).toEqual(["microsoft yahei", "simhei", "source han sans sc"]);
  });

  it("leaves the renderer's own default only when there is nothing", () => {
    const none = jassubFonts({ embedded: ["e"], fallback: null, systemFamilies: new Set() });
    expect(none).toEqual({ fonts: ["e"], availableFonts: {}, defaultFont: undefined, source: "none" });
    expect(jassubFonts({ embedded: [], fallback: null, systemFamilies: null }).source).toBe("none");
  });
});

describe("AT-84 subtitle fonts: which fonts a script asks for", () => {
  const script = [
    "[Script Info]", "ScriptType: v4.00+", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour",
    "Style: Default,Arial,28,&H00FFFFFF",
    "Style: Sign,@方正黑体_GBK,36,&H0000FFFF",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\fnMicrosoft YaHei\\b1}你好{\\fn华文楷体}世界",
    "Comment: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\fnNot A Dialogue}x",
  ].join("\r\n");

  it("lists the style table's fonts and the \\fn overrides of the lines, lower case and without the vertical-writing mark", () => {
    expect(assFontNames(script).sort()).toEqual(["arial", "microsoft yahei", "华文楷体", "方正黑体_gbk"].sort());
  });

  it("knows nothing from a script without styles", () => {
    expect(assFontNames("1\n00:00:01,000 --> 00:00:02,000\n字幕")).toEqual([]);
  });
});
