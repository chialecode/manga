import { describe, expect, it } from "vitest";
import { expectedPlace, judgeDialogue, judgeTopCaption, type Measure } from "../../apps/desktop/src/main/smoke/subtitle-check.ts";
import { DEFAULT_SUBTITLE_STYLE, layoutSubtitles } from "../../apps/desktop/src/renderer/readers/subtitle-model.ts";

/** What the smoke would measure in a window that draws the layout the model gives: the judge must accept it and refuse what is off. */
function drawn(frame: { w: number; h: number }, video: { w: number; h: number }, lines: Array<{ text: string; small?: boolean }>, captions: string[] = []): Measure {
  const layout = layoutSubtitles(frame, video, DEFAULT_SUBTITLE_STYLE);
  const zone = layout.dialogue;
  return {
    frame: { x: 0, y: 0, ...frame },
    picture: layout.picture,
    layer: { x: 0, y: 0, ...frame },
    place: layout.place,
    zone,
    top: layout.top,
    video,
    lines: lines.map((line, index) => {
      const size = line.small ? layout.smallPx : layout.mainPx;
      const width = Math.min(zone.w, line.text.length * size);
      return { text: line.text, size, kind: line.small ? "small" : "main", box: { x: zone.x + (zone.w - width) / 2, y: zone.y + zone.h - (lines.length - index) * size * 1.15, w: width, h: size * 1.15 } };
    }),
    captions: captions.map((text) => ({ text, size: layout.topPx, box: { x: layout.top.x + (layout.top.w - text.length * layout.topPx) / 2, y: layout.top.y, w: text.length * layout.topPx, h: layout.topPx * 1.15 } })),
  };
}

describe("the subtitle smoke's judgement", () => {
  it("accepts the layout the model gives, for a 16:9 picture in the three window sizes and full screen", () => {
    for (const frame of [{ w: 1280, h: 720 }, { w: 360, h: 203 }, { w: 1100, h: 400 }, { w: 1920, h: 1080 }]) {
      const verdict = judgeDialogue(drawn(frame, { w: 1920, h: 1080 }, [{ text: "第一句台词" }]), { lines: 1 });
      expect(verdict, JSON.stringify(frame)).toMatchObject({ ok: true, failures: [] });
    }
  });

  it("accepts the dialogue under a widescreen picture exactly when the bar can hold it", () => {
    const tall = drawn({ w: 1280, h: 720 }, { w: 1024, h: 428 }, [{ text: "第一句台词" }]);
    expect(expectedPlace(tall)).toBe("below");
    expect(judgeDialogue(tall, { lines: 1 }).ok).toBe(true);
    const thin = drawn({ w: 1280, h: 560 }, { w: 1024, h: 428 }, [{ text: "第一句台词" }]);
    expect(expectedPlace(thin)).toBe("inside");
    expect(judgeDialogue(thin, { lines: 1 }).ok).toBe(true);
  });

  it("accepts a bilingual cue with the second language at three quarters of the height", () => {
    const measure = drawn({ w: 1280, h: 720 }, { w: 1920, h: 1080 }, [{ text: "第一句台词" }, { text: "The first line", small: true }]);
    expect(judgeDialogue(measure, { lines: 2, small: 1 }).ok).toBe(true);
  });

  it("refuses a zone in the wrong place, type that is too big or small, a line too wide, and the wrong number of lines", () => {
    const base = drawn({ w: 1280, h: 720 }, { w: 1920, h: 1080 }, [{ text: "第一句台词" }]);
    const shifted = { ...base, zone: { ...base.zone!, y: base.zone!.y - 30 } };
    expect(judgeDialogue(shifted, { lines: 1 }).failures.join()).toContain("5% above");
    const big = { ...base, lines: base.lines.map((line) => ({ ...line, size: line.size * 1.5 })) };
    expect(judgeDialogue(big, { lines: 1 }).failures.join()).toContain("type");
    const small = { ...base, lines: base.lines.map((line) => ({ ...line, size: line.size * 0.5 })) };
    expect(judgeDialogue(small, { lines: 1 }).ok).toBe(false);
    const wide = { ...base, lines: base.lines.map((line) => ({ ...line, box: { ...line.box, w: base.zone!.w + 40 } })) };
    expect(judgeDialogue(wide, { lines: 1 }).failures.join()).toContain("wider than the zone");
    expect(judgeDialogue(base, { lines: 2 }).failures.join()).toContain("lines showing");
    expect(judgeDialogue({ ...base, place: "below" }, { lines: 1 }).failures.join()).toContain("place is below");
    expect(judgeDialogue({ ...base, layer: { x: 0, y: 0, w: 1000, h: 700 } }, { lines: 1 }).failures.join()).toContain("frame");
  });

  it("accepts a top caption in the upper middle of the picture and refuses one that is not", () => {
    const measure = drawn({ w: 1280, h: 720 }, { w: 1920, h: 1080 }, [{ text: "第一句台词" }], ["区役所"]);
    expect(judgeTopCaption(measure).ok).toBe(true);
    const low = { ...measure, captions: measure.captions.map((caption) => ({ ...caption, box: { ...caption.box, y: 600 } })) };
    expect(judgeTopCaption(low).ok).toBe(false);
    expect(judgeTopCaption({ ...measure, captions: [] }).failures).toContain("no top caption showing");
    // The same text must not also be drawn as dialogue.
    expect(judgeTopCaption({ ...measure, lines: [{ ...measure.lines[0]!, text: "区役所" }] }).failures.join()).toContain("also drawn as dialogue");
  });
});
