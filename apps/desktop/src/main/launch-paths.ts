import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where a start of the packaged application keeps its own things, worked out with Node alone (A-128). The bootstrap entry (`main.cjs`) and light
 * open's main process (`light-main.cjs`) use it instead of `@manga/app-core`, which would bring the library database with it. The answers are the
 * same as `resolveLaunchLayout` gives the full application: `%LOCALAPPDATA%\manga` for a release, `manga-dev` for a development build,
 * `manga-test` for the test channel, `-test` after either for a test identity, and `MANGA_PROFILE_ROOT` instead of all of them when a test names one.
 */
export type LaunchChannel = "release" | "development" | "test";
export type ChannelInfo = { channel: LaunchChannel; testIdentity: boolean };

const CHANNELS: readonly LaunchChannel[] = ["release", "development", "test"];
const APP_FOLDER: Record<LaunchChannel, string> = { release: "manga", development: "manga-dev", test: "manga-test" };

/** The channel a package was built for (`resources/channel.json`), unless the environment names one; an unpackaged start is a development build. */
export function channelInfoOf(input: { resourcesPath: string; packaged: boolean; env?: NodeJS.ProcessEnv }): ChannelInfo {
  const env = input.env ?? process.env;
  let fileChannel: LaunchChannel | undefined;
  let fileTest = false;
  const file = path.join(input.resourcesPath, "channel.json");
  if (input.packaged || fs.existsSync(file)) {
    try {
      const body = JSON.parse(fs.readFileSync(file, "utf8")) as { channel?: string; testIdentity?: boolean };
      if (body.channel === "release" || body.channel === "development") fileChannel = body.channel;
      if (body.testIdentity === true) fileTest = true;
    } catch { /* a package made before the channel was written in is a release */ }
  }
  const named = env.MANGA_CHANNEL as LaunchChannel | undefined;
  const channel = named && CHANNELS.includes(named) ? named : !input.packaged ? (fileChannel ?? "development") : (fileChannel ?? "release");
  return { channel, testIdentity: env.MANGA_TEST_IDENTITY === "1" || fileTest };
}

export function localAppData(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCALAPPDATA ? path.resolve(env.LOCALAPPDATA) : path.join(os.homedir(), "AppData", "Local");
}

/** The application data root of a channel: what the full application calls `appRoot`. */
export function appRootOf(info: ChannelInfo, env: NodeJS.ProcessEnv = process.env): string {
  if (env.MANGA_PROFILE_ROOT) return path.resolve(env.MANGA_PROFILE_ROOT);
  const base = APP_FOLDER[info.channel];
  return path.join(localAppData(env), info.testIdentity && info.channel !== "test" ? `${base}-test` : base);
}

/** Light open's whole footprint (4.6): its Chromium profile and running marker, its positions, its play copies and its logs. */
export function lightDirsOf(appRoot: string) {
  const root = path.join(appRoot, "light");
  return { root, runtime: path.join(root, "runtime"), positions: path.join(root, "positions.json"), cache: path.join(root, "cache"), logs: path.join(root, "logs"), windowState: path.join(root, "window.json") };
}

/** The version a package carries in `resources/build.json`; null for a start from source. */
export function packagedVersion(resourcesPath: string): string | null {
  try {
    const body = JSON.parse(fs.readFileSync(path.join(resourcesPath, "build.json"), "utf8")) as { version?: unknown };
    return typeof body.version === "string" && body.version.trim() ? body.version.trim() : null;
  } catch {
    return null;
  }
}
