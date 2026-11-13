/**
 * Shared human-readable formatting and local-day range helpers across the renderer.
 */

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Byte count formatted as B / KB / MB / GB. Non-finite or negative values format as `0 B`. */
export function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  if (safe < 1024 * 1024 * 1024) return `${(safe / 1024 / 1024).toFixed(1)} MB`;
  return `${(safe / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Duration in seconds formatted as `m:ss` (or `mm:ss` when `padMinutes` is true), and `h:mm:ss` from an hour on.
 * Negative and non-finite values read as zero.
 */
export function formatClockSec(sec: number, options?: { padMinutes?: boolean }): string {
  const total = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${options?.padMinutes ? pad2(minutes) : minutes}:${pad2(seconds)}`;
}

/**
 * Duration in milliseconds formatted as `m:ss` (or `mm:ss` when `padMinutes` is true), and `h:mm:ss` from an hour on.
 * Negative and non-finite values read as zero.
 */
export function formatClockMs(ms: number, options?: { padMinutes?: boolean }): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return formatClockSec(Math.floor(safe / 1000), options);
}

/**
 * Local-timezone ISO instants for the start (`00:00:00.000`) and end (`23:59:59.999`) of a `YYYY-MM-DD` day string.
 * Returns `{}` when empty or malformed.
 */
export function dayBounds(day: string): { from?: string; to?: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) return {};
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const start = new Date(year, month - 1, date, 0, 0, 0, 0);
  const end = new Date(year, month - 1, date, 23, 59, 59, 999);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return {};
  return { from: start.toISOString(), to: end.toISOString() };
}
