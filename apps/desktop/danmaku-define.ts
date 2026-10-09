import fs from "node:fs";
import path from "node:path";

/** The names of the two variables that carry the DanDanPlay application credentials of a release. They are read when the main process is built. */
export const DANMAKU_ENV = { id: "MANGA_DANDANPLAY_APP_ID", secret: "MANGA_DANDANPLAY_APP_SECRET" } as const;
const SHAPE = /^[A-Za-z0-9_-]{4,128}$/;

/** `NAME=value` lines of an env file, for the two names only: no other name in the file is read, so nothing else in it can reach a bundle. */
function fromFile(file: string): Partial<Record<string, string>> {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return {}; }
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || (match[1] !== DANMAKU_ENV.id && match[1] !== DANMAKU_ENV.secret)) continue;
    found[match[1]] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return found;
}

/**
 * The credentials to build into the main process: the environment first (a CI build), then `.env.local` at the root of the repository (a local
 * package). A value that does not look like one is dropped, so a stray character cannot become a half credential. Nothing is printed.
 */
export function danmakuCredentialsFor(env: NodeJS.ProcessEnv, repoRoot: string): { appId: string; secret: string } | null {
  const file = fromFile(path.join(repoRoot, ".env.local"));
  const appId = env[DANMAKU_ENV.id] || file[DANMAKU_ENV.id] || "";
  const secret = env[DANMAKU_ENV.secret] || file[DANMAKU_ENV.secret] || "";
  return SHAPE.test(appId) && SHAPE.test(secret) ? { appId, secret } : null;
}

/**
 * Vite `define` entries for the main process only. The renderer and preload configs do not use this, so the credentials are in the main bundle and in
 * no file the screen loads. Without credentials both constants are empty and danmaku says it has none.
 */
export function danmakuDefine(env: NodeJS.ProcessEnv, repoRoot: string): Record<string, string> {
  const credentials = danmakuCredentialsFor(env, repoRoot);
  return {
    __MANGA_DANDANPLAY_APP_ID__: JSON.stringify(credentials?.appId ?? ""),
    __MANGA_DANDANPLAY_APP_SECRET__: JSON.stringify(credentials?.secret ?? ""),
  };
}
