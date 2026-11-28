import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../apps/desktop/src/renderer/${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tokens = read("styles.css");
const video = read("styles-video.css");
const frame = read("styles-frame.css");
const reader = read("styles-reader.css");

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

function blockOf(head: string): string {
  const start = tokens.indexOf(head);
  if (start < 0) throw new Error(`missing CSS block ${head}`);
  const end = tokens.indexOf("}", start);
  return tokens.slice(start, end);
}

const lightBlock = blockOf("@theme {");
const darkBlock = blockOf(':root[data-theme="dark"] {');

/** The `#RRGGBB[AA]` value of a token, following `var(--...)` aliases within `scope` (falling back to `@theme`). */
function rgba(name: string, scope = lightBlock): RGBA {
  const findIn = (source: string) => {
    const alias = new RegExp(`--${name}:\\s*var\\(--([a-z0-9-]+)\\)`).exec(source);
    if (alias) return rgba(alias[1]!, scope);
    const match = new RegExp(`--${name}:\\s*#([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?\\b`).exec(source);
    if (!match) return null;
    const hex = match[1]!;
    const alpha = match[2] ? parseInt(match[2], 16) / 255 : 1;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), alpha] as RGBA;
  };
  const found = findIn(scope) ?? (scope === lightBlock ? null : findIn(lightBlock));
  if (!found) throw new Error(`token --${name} is not defined as a hex colour`);
  return found;
}

/** The channel value of `#RRGGBB` (the first six hex digits of a token). */
function channels(name: string, scope = lightBlock): RGB {
  const [r, g, b] = rgba(name, scope);
  return [r, g, b];
}

const composite = (fg: RGBA, bg: RGB): RGB => {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
};
const luminance = ([r, g, b]: RGB) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const rgbOf = (value: RGB) => value;
const contrast = (a: RGB, b: RGB) => {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("player light controls", () => {
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

  it("keeps dark-theme ordinary player controls readable (contrast of at least 4.5 : 1)", () => {
    const bar = channels("color-player-bar", darkBlock);
    expect(luminance(bar)).toBeLessThan(0.15);
    expect(contrast(channels("color-player-ink", darkBlock), bar)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(channels("color-player-ink-strong", darkBlock), bar)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(channels("color-player-ink-strong", darkBlock), channels("color-player-hover", darkBlock))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(channels("color-player-selected-ink", darkBlock), channels("color-player-selected", darkBlock))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the picture itself black, and gives fullscreen bars dark translucent glass with >= 4.5:1 contrast over black and white (A-141)", () => {
    expect(channels("color-player-stage")).toEqual([0, 0, 0]);
    expect(video).toMatch(/\.video-stage \{[^}]*background: var\(--color-player-stage\)/);
    expect(video).toMatch(/\.video-shell\[data-full\] \.video-controls \{[^}]*background: var\(--color-player-bar-overlay\)[^}]*backdrop-filter: blur\(22px\) saturate\(1\.4\)[^}]*color-scheme: dark[^}]*text-shadow: var\(--shadow-fullscreen-ink\)[^}]*--color-accent-soft: var\(--color-fullscreen-selected-bg\)[^}]*--color-primary-foreground: var\(--color-fullscreen-surface\)[^}]*--color-focus: var\(--color-fullscreen-accent\)/);
    expect(frame).toMatch(/\.shell-top\[data-immersive="true"\] \{[^}]*background: var\(--color-frame-glass\)[^}]*backdrop-filter: blur\(22px\) saturate\(1\.4\)[^}]*color-scheme: dark[^}]*text-shadow: var\(--shadow-fullscreen-ink\)[^}]*--color-text: var\(--color-fullscreen-ink\)[^}]*--color-accent-soft: var\(--color-fullscreen-selected-bg\)[^}]*--color-primary-foreground: var\(--color-fullscreen-surface\)[^}]*--color-focus: var\(--color-fullscreen-accent\)/);
    expect(reader).toMatch(/\.reader\[data-immersive\] \.reader-foot \{[^}]*background: var\(--color-frame-glass\)[^}]*backdrop-filter: blur\(22px\) saturate\(1\.4\)[^}]*color-scheme: dark; color: var\(--color-text\); text-shadow: var\(--shadow-fullscreen-ink\)[^}]*--color-accent-soft: var\(--color-fullscreen-selected-bg\)[^}]*--color-primary-foreground: var\(--color-fullscreen-surface\)[^}]*--color-focus: var\(--color-fullscreen-accent\)/);
    expect(reader).toMatch(/\.reader\[data-immersive\] \.comic-footer \{[^}]*background: var\(--color-frame-glass\)[^}]*backdrop-filter: blur\(22px\) saturate\(1\.4\)[^}]*color-scheme: dark; color: var\(--color-text\); text-shadow: var\(--shadow-fullscreen-ink\)[^}]*--color-accent-soft: var\(--color-fullscreen-selected-bg\)[^}]*--color-primary-foreground: var\(--color-fullscreen-surface\)[^}]*--color-focus: var\(--color-fullscreen-accent\)/);
    expect(tokens).toMatch(/--shadow-fullscreen-ink:\s*0 1px 2px #[0-9A-Fa-f]{8};/);

    const glass = rgba("color-player-bar-overlay");
    const darkGlass = rgba("color-frame-glass", darkBlock);
    expect(darkGlass).toEqual(glass);
    expect(luminance([glass[0], glass[1], glass[2]])).toBeLessThan(0.1);
    expect(glass[3]).toBeGreaterThanOrEqual(0.50);
    expect(glass[3]).toBeLessThanOrEqual(0.62);

    const ink = channels("color-fullscreen-ink");
    const mutedInk = channels("color-fullscreen-ink-muted");
    const accent = channels("color-fullscreen-accent");
    const dangerText = channels("color-fullscreen-danger-text");
    const hover = rgba("color-fullscreen-hover");
    const surface = channels("color-fullscreen-surface");
    const selectedBg = rgba("color-fullscreen-selected-bg");

    for (const backdrop of [[0, 0, 0], [255, 255, 255]] as RGB[]) {
      const bar = composite(glass, backdrop);
      expect(contrast(ink, bar)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(mutedInk, bar)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accent, bar)).toBeGreaterThanOrEqual(3);
      expect(contrast(dangerText, bar)).toBeGreaterThanOrEqual(3);
      expect(contrast(ink, composite(hover, bar))).toBeGreaterThanOrEqual(3);
      expect(contrast(accent, composite(selectedBg, bar))).toBeGreaterThanOrEqual(4.5);
    }

    expect(contrast(ink, surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(mutedInk, surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(accent, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dangerText, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(surface, accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent, composite(selectedBg, surface))).toBeGreaterThanOrEqual(4.5);
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
