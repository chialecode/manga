/**
 * The fonts the ASS renderer (JASSUB) is given. Its own fallback font has Western letters only, so a style whose font is neither in the file nor
 * on the machine drew Chinese and Japanese as boxes. The default font is a font with those glyphs: the bundled Noto Sans SC, loaded with the
 * renderer so the first frame already has it. A machine's own font (Microsoft YaHei, SimHei, Source Han Sans) is only the default when the
 * app has no bundled one: the renderer reads an installed font after the first frame was drawn and does not draw that frame again, so on a
 * paused picture a style's text was missing until the next frame, and on some machines it never loaded at all.
 */

export type FallbackFont = { family: string; url: string };

/** Installed families that draw Chinese and Japanese, lower case, in the order they are preferred. */
export const SYSTEM_CJK_FAMILIES = ["microsoft yahei", "simhei", "source han sans sc", "noto sans cjk sc", "noto sans sc", "pingfang sc", "heiti sc"] as const;

export type JassubFonts = {
  /** Font files loaded when the renderer starts: the ones the video carries, and the bundled fallback when it is the default. */
  fonts: string[];
  /** Fonts the renderer may fetch when a style asks for them by name. */
  availableFonts: Record<string, string>;
  /** The family used for every style whose font cannot be found; undefined leaves the renderer's own (Western-only) default. */
  defaultFont: string | undefined;
  /** Where the default comes from, for the debug panel. */
  source: "system" | "bundled" | "none";
};

export function jassubFonts(input: { embedded: string[]; fallback: FallbackFont | null; systemFamilies: ReadonlySet<string> | null }): JassubFonts {
  if (input.fallback) {
    const family = input.fallback.family.trim().toLowerCase();
    return { fonts: [...input.embedded, input.fallback.url], availableFonts: { [family]: input.fallback.url }, defaultFont: family, source: "bundled" };
  }
  const system = input.systemFamilies ? SYSTEM_CJK_FAMILIES.find((family) => input.systemFamilies!.has(family)) : undefined;
  if (system) return { fonts: [...input.embedded], availableFonts: {}, defaultFont: system, source: "system" };
  return { fonts: [...input.embedded], availableFonts: {}, defaultFont: undefined, source: "none" };
}

type LocalFontsWindow = { queryLocalFonts?: () => Promise<Array<{ family: string }>> };

let installed: Promise<ReadonlySet<string> | null> | null = null;

/**
 * The installed families, lower case, looked up once; null when the browser cannot say (no support, no permission). The renderer
 * reads a font's file through the same permission, and asks for it by name only when that permission is "granted": a family it could
 * list but not read must not be taken as the default font, or a style whose font is nowhere is drawn with nothing at all.
 */
export function installedFamilies(): Promise<ReadonlySet<string> | null> {
  installed ??= (async () => {
    try {
      const query = (window as unknown as LocalFontsWindow).queryLocalFonts;
      if (typeof query !== "function") return null;
      const families = new Set((await query.call(window)).map((font) => font.family.trim().toLowerCase()));
      const ask = navigator.permissions?.query;
      if (typeof ask === "function") {
        const state = (await ask.call(navigator.permissions, { name: "local-fonts" as PermissionName }).catch(() => null))?.state;
        if (state !== undefined && state !== "granted") return null;
      }
      return families;
    } catch {
      return null;
    }
  })();
  return installed;
}

/** Forget the looked-up families (a test changes what the machine has). */
export function resetInstalledFamilies(): void {
  installed = null;
}
