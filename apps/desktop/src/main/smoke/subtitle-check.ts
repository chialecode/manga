/**
 * What the subtitle smoke measures in the packaged window, and how it judges it (A-59, AT-69). The numbers are measured from the DOM the person
 * sees (the video element's own rectangle and size, the zones and lines as laid out), and compared with what the standard says about the picture:
 * the dialogue zone is 90% of the picture wide and a tenth high with its lower edge 5% above the picture's bottom, the type is 5% of the picture's
 * height, a top caption sits in the upper part of the middle 80%. The picture is worked out here from the video's size, not read from the layer
 * under test.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Measure = {
  frame: Rect;
  picture: Rect;
  layer: Rect | null;
  place: string | null;
  zone: Rect | null;
  top: Rect | null;
  lines: Array<{ text: string; size: number; kind: string | null; box: Rect }>;
  captions: Array<{ text: string; size: number; box: Rect }>;
  video: { w: number; h: number };
};

/** A renderer expression that returns a `Measure`, or null when there is no video yet. */
export const MEASURE = `(() => {
  const video = document.querySelector('[data-testid="video-element"]');
  if (!video || !video.videoWidth) return null;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const frame = rect(video);
  const scale = Math.min(frame.w / video.videoWidth, frame.h / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  const picture = { x: frame.x + (frame.w - w) / 2, y: frame.y + (frame.h - h) / 2, w, h };
  const find = (id) => document.querySelector('[data-testid="' + id + '"]');
  const layer = find("subtitle-layer");
  const zone = find("subtitle-zone-dialogue");
  const top = find("subtitle-zone-top");
  const text = (el) => { const span = el.querySelector("span"); return span ? rect(span) : rect(el); };
  // A caption is judged by its line box (what the layout gave it), not by the inline box of its text, which reaches past the line box by the font's own leading.
  const lineBox = (el) => { const own = rect(el); const inner = text(el); return { x: inner.x, y: own.y, w: inner.w, h: own.h }; };
  const lines = [...document.querySelectorAll('[data-testid="subtitle-line"]')].map((el) => ({ text: el.textContent, size: parseFloat(getComputedStyle(el).fontSize), kind: el.getAttribute("data-size"), box: text(el) }));
  const captions = [...document.querySelectorAll('[data-testid="subtitle-caption"]')].map((el) => ({ text: el.textContent, size: parseFloat(getComputedStyle(el).fontSize), box: lineBox(el) }));
  return { frame, picture, layer: layer ? rect(layer) : null, place: zone ? zone.getAttribute("data-place") : null, zone: zone ? rect(zone) : null, top: top ? rect(top) : null, lines, captions, video: { w: video.videoWidth, h: video.videoHeight } };
})()`;

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

/** What place the standard's rule gives the dialogue: below a widescreen picture when the black bar under it holds the zone. */
export function expectedPlace(measure: Measure, placement: "auto" | "inside" = "auto"): "inside" | "below" {
  const ratio = measure.video.w / measure.video.h;
  const bar = measure.frame.y + measure.frame.h - (measure.picture.y + measure.picture.h);
  return placement === "auto" && ratio >= 2.2 && bar >= measure.picture.h * 0.1 - 0.5 ? "below" : "inside";
}

export type Verdict = { ok: boolean; failures: string[]; numbers: Record<string, number | string | null> };

/**
 * The dialogue at its standard place and size. `expect.lines` is how many lines the cue showing should have (the Chinese and the other language of
 * a bilingual cue count as two); `small` lines are checked against 75% of the standard height.
 */
export function judgeDialogue(measure: Measure, expect: { lines: number; small?: number }): Verdict {
  const failures: string[] = [];
  const { picture, zone, frame } = measure;
  const place = expectedPlace(measure);
  const pixel = Math.max(1.5, picture.h * 0.004);
  if (!measure.layer || !near(measure.layer.w, frame.w, 1) || !near(measure.layer.h, frame.h, 1)) failures.push("the layer is not the video's frame");
  if (measure.place !== place) failures.push(`place is ${measure.place}, the rule says ${place}`);
  if (!zone) failures.push("no dialogue zone");
  if (zone) {
    if (!near(zone.w, picture.w * 0.9, pixel)) failures.push(`zone width ${zone.w.toFixed(1)} is not 90% of ${picture.w.toFixed(1)}`);
    if (!near(zone.h, picture.h * 0.1, pixel)) failures.push(`zone height ${zone.h.toFixed(1)} is not a tenth of ${picture.h.toFixed(1)}`);
    if (!near(zone.x + zone.w / 2, picture.x + picture.w / 2, pixel)) failures.push("zone is not centred on the picture");
    if (place === "inside" && !near(zone.y + zone.h, picture.y + picture.h - picture.h * 0.05, pixel)) failures.push("zone's lower edge is not 5% above the picture's bottom");
    if (place === "below" && !near(zone.y, picture.y + picture.h, pixel)) failures.push("zone does not start at the picture's bottom edge");
    if (place === "below" && zone.y + zone.h > frame.y + frame.h + pixel) failures.push("zone runs past the black bar");
  }
  if (measure.lines.length !== expect.lines) failures.push(`${measure.lines.length} lines showing, expected ${expect.lines}`);
  const standard = picture.h * 0.05;
  for (const line of measure.lines) {
    const want = line.kind === "small" ? standard * 0.75 : standard;
    // The standard asks for a tenth of the picture's height of room either way (1% of the height).
    if (!near(line.size, want, picture.h * 0.01)) failures.push(`type ${line.size.toFixed(1)} is not ${want.toFixed(1)} (${line.text})`);
    if (zone && line.box.w > zone.w + 1) failures.push(`line "${line.text}" is wider than the zone`);
    if (!near(line.box.x + line.box.w / 2, picture.x + picture.w / 2, pixel + 1)) failures.push(`line "${line.text}" is not centred`);
    // The text stays on the screen's frame whatever the window.
    if (line.box.y < frame.y - 1 || line.box.y + line.box.h > frame.y + frame.h + 1) failures.push(`line "${line.text}" is outside the frame`);
  }
  if (expect.small !== undefined && measure.lines.filter((line) => line.kind === "small").length !== expect.small) failures.push("wrong number of small lines");
  return {
    ok: failures.length === 0,
    failures,
    numbers: {
      pictureW: Math.round(picture.w * 10) / 10, pictureH: Math.round(picture.h * 10) / 10, place: measure.place, zoneW: zone ? Math.round(zone.w * 10) / 10 : null,
      zoneH: zone ? Math.round(zone.h * 10) / 10 : null, zoneBottomGap: zone ? Math.round((picture.y + picture.h - (zone.y + zone.h)) * 10) / 10 : null,
      typeSize: measure.lines[0] ? Math.round(measure.lines[0].size * 10) / 10 : null, typeShare: measure.lines[0] ? Math.round((measure.lines[0].size / picture.h) * 1000) / 1000 : null,
    },
  };
}

/** A caption marked for the top: in the upper part of the picture's middle 80%, at 3.7% of the picture's height. */
export function judgeTopCaption(measure: Measure): Verdict {
  const failures: string[] = [];
  const { picture } = measure;
  const pixel = Math.max(1.5, picture.h * 0.004);
  const caption = measure.captions[0];
  if (!caption) failures.push("no top caption showing");
  if (caption) {
    if (!near(caption.size, picture.h * 0.037, picture.h * 0.01)) failures.push(`caption type ${caption.size.toFixed(1)} is not 3.7% of ${picture.h.toFixed(1)}`);
    if (caption.box.y < picture.y + picture.h * 0.1 - pixel) failures.push("caption starts above the top margin");
    if (caption.box.y + caption.box.h > picture.y + picture.h * 0.5) failures.push("caption is not in the upper half");
    if (caption.box.x < picture.x + picture.w * 0.1 - pixel || caption.box.x + caption.box.w > picture.x + picture.w * 0.9 + pixel) failures.push("caption is outside the middle 80%");
  }
  if (measure.lines.some((line) => caption && line.text === caption.text)) failures.push("the caption is also drawn as dialogue");
  return { ok: failures.length === 0, failures, numbers: { captionSize: caption ? Math.round(caption.size * 10) / 10 : null, captionTop: caption ? Math.round((caption.box.y - picture.y) * 10) / 10 : null } };
}
