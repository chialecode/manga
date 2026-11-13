import { useEffect, useMemo, useState } from "react";
import { attempt, asArray } from "./api.ts";

type Entry = { url: string | null; width: number; height: number; at: number };
type Size = "grid" | "detail";

export type CoverMeta = { url: string; width: number; height: number };

// A handle is good for six hours in the main process; asking again a little before that keeps long sessions from showing blanks.
const FRESH_MS = 5 * 60 * 60_000;
const BATCH = 40;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();

const keyOf = (coverId: string, size: Size) => `${size}:${coverId}`;
const usable = (entry: Entry | undefined, now: number) => entry !== undefined && (entry.url === null ? now - entry.at < 60_000 : now - entry.at < FRESH_MS);

async function load(ids: string[], size: Size): Promise<void> {
  const result = await attempt<{ covers: Array<{ coverId: string; available: boolean; url?: string; width?: number; height?: number }> }>("covers.handles", { coverIds: ids, size });
  const now = Date.now();
  if (!result.ok) {
    // A failed batch is remembered briefly so a broken main process is not asked again on every render.
    for (const id of ids) cache.set(keyOf(id, size), { url: null, width: 0, height: 0, at: now });
    return;
  }
  const seen = new Set<string>();
  for (const cover of asArray<{ coverId: string; available: boolean; url?: string; width?: number; height?: number }>(result.value.covers)) {
    seen.add(cover.coverId);
    const ok = Boolean(cover.available && cover.url);
    cache.set(keyOf(cover.coverId, size), {
      url: ok ? cover.url! : null,
      width: ok && typeof cover.width === "number" ? cover.width : 0,
      height: ok && typeof cover.height === "number" ? cover.height : 0,
      at: now,
    });
  }
  for (const id of ids) if (!seen.has(id)) cache.set(keyOf(id, size), { url: null, width: 0, height: 0, at: now });
}

/** Ask for the cover handles that are not known yet. Concurrent callers share one request per cover. */
export async function ensureCovers(ids: string[], size: Size): Promise<void> {
  const now = Date.now();
  const wanted = [...new Set(ids)].filter((id) => !usable(cache.get(keyOf(id, size)), now));
  const waits: Array<Promise<void>> = [];
  const fresh: string[] = [];
  for (const id of wanted) {
    const pending = inflight.get(keyOf(id, size));
    if (pending) waits.push(pending); else fresh.push(id);
  }
  for (let at = 0; at < fresh.length; at += BATCH) {
    const chunk = fresh.slice(at, at + BATCH);
    const job = load(chunk, size).finally(() => { for (const id of chunk) inflight.delete(keyOf(id, size)); });
    for (const id of chunk) inflight.set(keyOf(id, size), job);
    waits.push(job);
  }
  await Promise.all(waits);
}

export function coverUrl(coverId: string | null | undefined, size: Size): string | undefined {
  if (!coverId) return undefined;
  const entry = cache.get(keyOf(coverId, size));
  return entry?.url ?? undefined;
}

export function coverMeta(coverId: string | null | undefined, size: Size): CoverMeta | undefined {
  if (!coverId) return undefined;
  const entry = cache.get(keyOf(coverId, size));
  if (!entry?.url) return undefined;
  return { url: entry.url, width: entry.width, height: entry.height };
}

/**
 * Height-over-width ratio (`height / width`) for a portrait shelf or row of covers.
 * Uses the synced portrait covers' median ratio (clamped to `[1.25, 1.5]`) when known, else `fallback` (`4 / 3`).
 */
export function portraitCoverRatio(coverIds: ReadonlyArray<string | null | undefined>, size: Size, fallback = 4 / 3): number {
  const ratios: number[] = [];
  for (const id of coverIds) {
    const meta = coverMeta(id, size);
    if (!meta || meta.width <= 0 || meta.height <= 0 || meta.height < meta.width) continue;
    ratios.push(Math.min(1.5, Math.max(1.25, meta.height / meta.width)));
  }
  if (!ratios.length) return fallback;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)]!;
}

/** Drop what is known about a cover, so the next request asks the main process again (after a failed load or a changed cover). */
export function forgetCover(coverId: string): void {
  for (const size of ["grid", "detail"] as const) cache.delete(keyOf(coverId, size));
}

export function resetCovers(): void {
  cache.clear();
  inflight.clear();
}

/** Cover addresses for the given ids; the hook re-renders once the handles arrive. */
export function useCovers(ids: Array<string | null | undefined>, size: Size): (coverId: string | null | undefined) => string | undefined {
  const [, bump] = useState(0);
  const wanted = useMemo(() => ids.filter((id): id is string => Boolean(id)), [ids.join("|")]);
  useEffect(() => {
    let cancelled = false;
    if (!wanted.length) return;
    void ensureCovers(wanted, size).then(() => { if (!cancelled) bump((value) => value + 1); });
    return () => { cancelled = true; };
  }, [wanted, size]);
  return (coverId) => coverUrl(coverId, size);
}
