import { z } from "zod";
import { ChannelSchema, type Channel } from "./paths.ts";

export const VERSION_LINE = "0.1.0";
export const BUILD_JSON_NAME = "build.json";
export const BUILD_SCHEMA_VERSION = 15;

export const BuildInfoSchema = z.object({
  version: z.string().min(1),
  channel: ChannelSchema,
  commit: z.string().min(1),
  builtAt: z.string().min(1),
  schemaVersion: z.number().int().positive(),
});

export type BuildInfo = z.infer<typeof BuildInfoSchema>;

const RELEASE_TAG_RE = /^v?0\.1\.(\d+)$/;

/**
 * Compute the next `0.1.<patch>` release version from existing tags (计划 4.1, AT-157).
 * - Returns `"0.1.1"` when no `v0.1.*` tag exists (or only `v0.1.0` exists).
 * - Returns `0.1.<highest + 1>` when `v0.1.*` tags exist, even when non-contiguous.
 * - Never auto-bumps to `0.2` or `1.0`; ignores non-`0.1.*` and pre-release tags.
 */
export function computeNextReleaseVersion(tags: Iterable<string>): string {
  let highest = 0;
  for (const raw of tags) {
    const trimmed = String(raw).trim();
    const match = RELEASE_TAG_RE.exec(trimmed);
    if (!match) continue;
    const patchText = match[1]!;
    if (patchText.length > 1 && patchText.startsWith("0")) continue;
    const patch = Number.parseInt(patchText, 10);
    if (Number.isSafeInteger(patch) && patch > highest) highest = patch;
  }
  return `0.1.${highest + 1}`;
}

/**
 * Format a UTC date as a 12-digit `YYYYMMDDHHmm` timestamp with no leading zero (计划 4.1).
 */
export function formatUtcBuildTimestamp(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}${month}${day}${hours}${minutes}`;
}

/**
 * Compute a development version `<nextReleaseVersion>-dev.<YYYYMMDDHHmm>` (计划 4.1, AT-157).
 */
export function computeDevVersion(tags: Iterable<string>, date: Date = new Date()): string {
  return `${computeNextReleaseVersion(tags)}-dev.${formatUtcBuildTimestamp(date)}`;
}

export type { Channel };
