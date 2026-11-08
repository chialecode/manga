import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  BUILD_JSON_NAME,
  BUILD_SCHEMA_VERSION,
  BuildInfoSchema,
  VERSION_LINE,
  computeDevVersion,
  computeNextReleaseVersion,
  formatUtcBuildTimestamp,
  type BuildInfo,
  type Channel,
} from "@manga/contracts";

export {
  BUILD_JSON_NAME,
  BUILD_SCHEMA_VERSION,
  BuildInfoSchema,
  VERSION_LINE,
  computeDevVersion,
  computeNextReleaseVersion,
  formatUtcBuildTimestamp,
  type BuildInfo,
};

/** Read all `v0.1.*` git tags in `cwd` (returns `[]` when git is unavailable or has no tags). */
export function readGitTags(cwd: string = process.cwd()): string[] {
  try {
    const result = spawnSync("git", ["tag", "--list", "v0.1.*"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Read the 7+ character short commit hash of `HEAD` in `cwd` (or `MANGA_BUILD_COMMIT` if set). */
export function readGitShortCommit(cwd: string = process.cwd()): string {
  const fromEnv = process.env.MANGA_BUILD_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  try {
    const result = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    const hash = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return result.status === 0 && hash.length > 0 ? hash : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Resolve the build version for `channel`:
 * - Uses `options.version` or `MANGA_BUILD_VERSION` when explicitly provided.
 * - For `release`, returns `computeNextReleaseVersion(tags)`.
 * - For `development` (and `test`), returns `computeDevVersion(tags, date)`.
 */
export function resolveBuildVersion(
  channel: Channel,
  options: { version?: string; cwd?: string; tags?: Iterable<string>; date?: Date } = {},
): string {
  const explicit = options.version?.trim() || process.env.MANGA_BUILD_VERSION?.trim();
  if (explicit) return explicit;
  const tags = options.tags ?? readGitTags(options.cwd);
  return channel === "release"
    ? computeNextReleaseVersion(tags)
    : computeDevVersion(tags, options.date ?? new Date());
}

/** Create a validated `BuildInfo` object for packaging or installer staging (计划 4.1). */
export function createBuildInfo(options: {
  channel: Channel;
  version?: string;
  commit?: string;
  builtAt?: string;
  schemaVersion?: number;
  cwd?: string;
  tags?: Iterable<string>;
  date?: Date;
}): BuildInfo {
  const now = options.date ?? new Date();
  const info: BuildInfo = {
    version: resolveBuildVersion(options.channel, {
      version: options.version,
      cwd: options.cwd,
      tags: options.tags,
      date: now,
    }),
    channel: options.channel,
    commit: options.commit?.trim() || readGitShortCommit(options.cwd),
    builtAt: options.builtAt?.trim() || process.env.MANGA_BUILD_AT?.trim() || now.toISOString(),
    schemaVersion: options.schemaVersion ?? BUILD_SCHEMA_VERSION,
  };
  return BuildInfoSchema.parse(info);
}

/** Write `build.json` into `resourcesDir` and return the validated `BuildInfo`. */
export function writeBuildInfo(resourcesDir: string, info: BuildInfo): BuildInfo {
  const validated = BuildInfoSchema.parse(info);
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, BUILD_JSON_NAME), `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

/** Read `build.json` from `MANGA_BUILD_JSON` or `path.join(resourcesDir, "build.json")` if it exists and is valid. */
export function readBuildInfoIfPresent(resourcesDir?: string): BuildInfo | null {
  const candidates = [
    process.env.MANGA_BUILD_JSON?.trim(),
    resourcesDir ? path.join(resourcesDir, BUILD_JSON_NAME) : undefined,
  ].filter((item): item is string => Boolean(item));
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return BuildInfoSchema.parse(parsed);
    } catch {
      continue;
    }
  }
  return null;
}

/** Read `build.json` if present, or synthesize a fallback `BuildInfo` for development / test runs. */
export function readBuildInfo(resourcesDir?: string, fallback: Partial<BuildInfo> = {}): BuildInfo {
  const found = readBuildInfoIfPresent(resourcesDir);
  if (found) {
    return {
      ...found,
      ...(fallback.channel ? { channel: fallback.channel } : {}),
    };
  }
  const channel: Channel = fallback.channel ?? "development";
  return {
    version: fallback.version?.trim() || process.env.MANGA_BUILD_VERSION?.trim() || VERSION_LINE,
    channel,
    commit: fallback.commit?.trim() || readGitShortCommit(),
    builtAt: fallback.builtAt?.trim() || process.env.MANGA_BUILD_AT?.trim() || new Date().toISOString(),
    schemaVersion: fallback.schemaVersion ?? BUILD_SCHEMA_VERSION,
  };
}
