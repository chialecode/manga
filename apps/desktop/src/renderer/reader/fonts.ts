import { useCallback, useState } from "react";
import { FONT_PRESETS } from "@manga/contracts/reading";

export type FontPreset = (typeof FONT_PRESETS)[number];

const PRESET_STACK: Record<FontPreset, string> = {
  sans: '"Microsoft YaHei", system-ui, sans-serif',
  serif: 'SimSun, "Noto Serif CJK SC", serif',
  mono: 'Consolas, "Microsoft YaHei", monospace',
};

export const isPreset = (family: string | undefined): family is FontPreset => family === "sans" || family === "serif" || family === "mono";

/** The CSS font stack for a preset or an installed family. The family name was validated, but it is still quoted and escaped. */
export function fontStack(family: string | undefined): string {
  if (!family) return PRESET_STACK.sans;
  if (isPreset(family)) return PRESET_STACK[family];
  const safe = family.replace(/["\\]/g, "");
  return `"${safe}", ${PRESET_STACK.sans}`;
}

type LocalFontsWindow = { queryLocalFonts?: () => Promise<Array<{ family: string }>> };

/**
 * Installed font families, looked up when the font menu is first opened. The browser may refuse (no permission, no support);
 * then the list stays empty and only the presets are offered.
 */
export function useInstalledFonts(): { families: string[]; load: () => void; status: "idle" | "loading" | "ready" | "unavailable" } {
  const [families, setFamilies] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const load = useCallback(() => {
    if (status !== "idle") return;
    const query = (window as unknown as LocalFontsWindow).queryLocalFonts;
    if (typeof query !== "function") { setStatus("unavailable"); return; }
    setStatus("loading");
    void query.call(window).then((fonts) => {
      const names = [...new Set(fonts.map((font) => font.family).filter((name) => /^[^"'`\\;{}<>()\x00-\x1f]{1,64}$/.test(name)))].sort((a, b) => a.localeCompare(b, "zh-CN"));
      setFamilies(names);
      setStatus("ready");
    }).catch(() => setStatus("unavailable"));
  }, [status]);
  return { families, load, status };
}

/** Page background and text colors of the five reader themes. The app shell never takes them. */
export const THEME_BACKGROUND: Record<string, string> = {
  white: "#ffffff",
  paper: "#f6edd2",
  green: "#e6f0e0",
  teal: "#d9ece9",
  night: "#1c1f24",
};
export const THEME_FOREGROUND: Record<string, string> = {
  white: "#1a1a1a",
  paper: "#33291a",
  green: "#1f2a1c",
  teal: "#17302d",
  night: "#e6e6e6",
};
