import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The sidebar's color is a role of the theme (A-99, 设计规则 DESIGN.md): between the frame's gray and the main area's white, in both themes, and readable. */

const css = readFileSync("apps/desktop/src/renderer/styles.css", "utf8");
const frameCss = readFileSync("apps/desktop/src/renderer/styles-frame.css", "utf8");

/** The `--name: #hex;` declarations of the block that starts at `head`. */
function tokens(head: string): Record<string, string> {
  const start = css.indexOf(head);
  expect(start, head).toBeGreaterThan(-1);
  const end = css.indexOf("}", start);
  const found: Record<string, string> = {};
  for (const match of css.slice(start, end).matchAll(/--([a-z-]+):\s*(#[0-9A-Fa-f]{6})(?:[0-9A-Fa-f]{2})?\s*;/g)) found[match[1]!] = match[2]!;
  return found;
}

const channel = (value: number) => { const unit = value / 255; return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => 0.2126 * channel(parseInt(hex.slice(1, 3), 16)) + 0.7152 * channel(parseInt(hex.slice(3, 5), 16)) + 0.0722 * channel(parseInt(hex.slice(5, 7), 16));
const contrast = (a: string, b: string) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high! + 0.05) / (low! + 0.05); };

const light = tokens("@theme {");
const dark = { ...light, ...tokens(':root[data-theme="dark"] {') };

describe("AT-120 the sidebar's color", () => {
  for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
    it(`is lighter than the frame and darker than the page (or the other way round in the dark theme: between them), in the ${name} theme`, () => {
      const { frame, sidebar, surface } = { frame: theme["color-frame"]!, sidebar: theme["color-sidebar"]!, surface: theme["color-surface"]! };
      expect(frame && sidebar && surface, "the three roles are defined").toBeTruthy();
      const [f, s, p] = [luminance(frame), luminance(sidebar), luminance(surface)];
      // Between the two, strictly: the sidebar is neither the frame's color nor the page's.
      expect(s).toBeGreaterThan(Math.min(f, p));
      expect(s).toBeLessThan(Math.max(f, p));
    });

    it(`keeps the text, the pictures and the border readable on it in the ${name} theme`, () => {
      const sidebar = theme["color-sidebar"]!;
      // The names of the rows: the body text's target; the pictures and the second lines: the subtle color, at least the ratio for normal text.
      expect(contrast(theme["color-text"]!, sidebar)).toBeGreaterThanOrEqual(7);
      expect(contrast(theme["color-subtle"]!, sidebar)).toBeGreaterThanOrEqual(4.5);
      // The border that sets a card off from the page under it is seen against the sidebar's color.
      expect(contrast(theme["color-border"]!, sidebar)).toBeGreaterThanOrEqual(1.1);
      // The hover ground of a row is not the sidebar's own color.
      expect(theme["color-muted"]).not.toBe(sidebar);
    });
  }

  it("is told apart from the frame and from the page by at least a visible step in each theme", () => {
    for (const theme of [light, dark]) {
      expect(contrast(theme["color-sidebar"]!, theme["color-frame"]!)).toBeGreaterThan(1.01);
      expect(contrast(theme["color-sidebar"]!, theme["color-surface"]!)).toBeGreaterThan(1.01);
    }
  });

  it("is what the docked sidebar, the card and the settings directory use, and nothing draws it with a color of its own", () => {
    expect(frameCss).toMatch(/\.shell-sidebar \{[^}]*background: var\(--color-sidebar\)/);
    expect(frameCss).not.toMatch(/\.shell-(sidebar|card)[^{]*\{[^}]*background: #/);
    // The card has a visible edge and a shadow, so it reads as a floating thing over the page.
    expect(frameCss).toMatch(/\.shell-card \{[^}]*border: 1px solid var\(--color-border\)/);
    expect(frameCss).toMatch(/\.shell-card \{[^}]*box-shadow/);
    // The settings page is the page's own white, not the sidebar's.
    expect(frameCss).toMatch(/\.settings-area \{[^}]*background: var\(--color-surface\)/);
  });
});
