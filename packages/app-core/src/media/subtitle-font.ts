import fs from "node:fs";
import path from "node:path";

/** The font that draws Chinese and Japanese subtitles whose own fonts are neither in the file nor on the machine. */
export type SubtitleFont = {
  /** The family name inside the font file, which the subtitle renderer looks the font up by. */
  family: string;
  path: string;
  mediaType: string;
};

/** Noto Sans CJK, Simplified Chinese subset (SIL OFL-1.1): the file `scripts/tools/subtitle-font.lock.json` pins. */
export const SUBTITLE_FONT_FILE = "NotoSansSC-Regular.otf";
export const SUBTITLE_FONT_FAMILY = "Noto Sans SC";

function workspaceRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Where the font is looked for, in order: an explicit directory (`MANGA_SUBTITLE_FONT_DIR`), the copy shipped with a packaged build, and the
 * development copy under `dist/tools/subtitle-font`. Nothing is fetched at run time: a missing font is a capability the caller reports.
 */
export function locateSubtitleFont(options: { env?: NodeJS.ProcessEnv; resourcesPath?: string; cwd?: string } = {}): SubtitleFont | null {
  const env = options.env ?? process.env;
  const dirs: string[] = [];
  if (env.MANGA_SUBTITLE_FONT_DIR) dirs.push(env.MANGA_SUBTITLE_FONT_DIR);
  const resources = options.resourcesPath ?? (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resources) dirs.push(path.join(resources, "subtitle-font"));
  const root = workspaceRoot(options.cwd ?? process.cwd()) ?? workspaceRoot(import.meta.dirname ?? ".");
  if (root) dirs.push(path.join(root, "dist", "tools", "subtitle-font"));
  for (const dir of dirs) {
    const file = path.join(dir, SUBTITLE_FONT_FILE);
    if (fs.existsSync(file)) return { family: SUBTITLE_FONT_FAMILY, path: file, mediaType: "font/otf" };
  }
  return null;
}
