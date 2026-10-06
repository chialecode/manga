import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../apps/desktop/src/renderer/${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tokens = read("styles.css");
const video = read("styles-video.css");

/** The channel value of `#RRGGBB` (the first six hex digits of a token). */
function channels(name: string): [number, number, number] {
  const match = new RegExp(`--${name}:\\s*#([0-9A-Fa-f]{6})`).exec(tokens);
  if (!match) throw new Error(`token --${name} is not defined as a hex colour`);
  const hex = match[1]!;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
const luminance = ([r, g, b]: [number, number, number]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const rgbOf = (value: [number, number, number]) => value;
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c: [number, number, number]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("M2 player light controls (A-47 W9)", () => {
  it("defines the control bar as light roles: a white bar, gray icons, a pink progress and a pink selected state", () => {
    expect(luminance(channels("color-player-bar"))).toBeGreaterThan(0.95);
    const ink = channels("color-player-ink");
    expect(Math.abs(ink[0] - ink[1])).toBeLessThan(40);
    expect(luminance(ink)).toBeLessThan(0.5);
    const [r, g, b] = channels("color-player-progress");
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b - 1);
    const selected = channels("color-player-selected");
    expect(luminance(selected)).toBeGreaterThan(0.85);
    expect(selected[0]).toBeGreaterThanOrEqual(selected[1]);
  });

  it("keeps the icons, the time and the selected state readable on the bar (contrast of at least 4.5 : 1)", () => {
    const bar = channels("color-player-bar");
    expect(contrast(channels("color-player-ink"), bar)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(channels("color-player-ink-strong"), bar)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(channels("color-player-selected-ink"), channels("color-player-selected"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgbOf(channels("color-player-ink-strong")), channels("color-player-hover"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the picture itself black, and the full-screen bar light", () => {
    expect(channels("color-player-stage")).toEqual([0, 0, 0]);
    expect(video).toMatch(/\.video-stage \{[^}]*background: var\(--color-player-stage\)/);
    expect(video).toMatch(/\.video-shell:fullscreen \.video-controls \{[^}]*background: var\(--color-player-bar-overlay\)/);
    expect(luminance(channels("color-player-bar-overlay"))).toBeGreaterThan(0.95);
  });

  it("names every colour of the player's style sheet as a token: no literal colour in styles-video.css", () => {
    expect(video.match(/#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(/g) ?? []).toEqual([]);
    const used = new Set([...video.matchAll(/var\(--(color-[a-z-]+)\)/g)].map((match) => match[1]!));
    const defined = new Set([...tokens.matchAll(/--(color-[a-z0-9-]+):/g)].map((match) => match[1]!));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
    expect(used.has("color-player-progress")).toBe(true);
    expect(used.has("color-player-ink")).toBe(true);
  });

  it("puts the controls on the light bar and the secondary ones in the 'more' panel above it, capped to the window", () => {
    expect(video).toMatch(/\.video-controls \{[^}]*background: var\(--color-player-bar\)/);
    expect(video).toMatch(/\.video-more-panel \{[^}]*bottom: calc\(100% \+ 6px\)[^}]*max-height: calc\(100vh - 160px\)[^}]*overflow: auto/);
    expect(video).toMatch(/\.video-seek-played \{[^}]*background: var\(--color-player-progress\)/);
  });
});
