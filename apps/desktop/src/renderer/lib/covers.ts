import { useEffect, useMemo, useState } from "react";
import { attempt, asArray } from "./api.ts";

type Entry = { url: string | null; at: number };
type Size = "grid" | "detail";

// A handle is good for six hours in the main process; asking again a little before that keeps long sessions from showing blanks.
const FRESH_MS = 5 * 60 * 60_000;
const BATCH = 40;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();

const keyOf = (coverId: string, size: Size) => `${size}:${coverId}`;
const usable = (entry: Entry | undefined, now: number) => entry !== undefined && (entry.url === null ? now - entry.at < 60_000 : now - entry.at < FRESH_MS);

async function load(ids: string[], size: Size): Promise<void> {
  const result = await attempt<{ covers: Array<{ coverId: string; available: boolean; url?: string }> }>("covers.handles", { coverIds: ids, size });
  const now = Date.now();
  if (!result.ok) {
    // A failed batch is remembered briefly so a broken main process is not asked again on every render.
    for (const id of ids) cache.set(keyOf(id, size), { url: null, at: now });
    return;
  }
  const seen = new Set<string>();
  for (const cover of asArray<{ coverId: string; available: boolean; url?: string }>(result.value.covers)) {
    seen.add(cover.coverId);
    cache.set(keyOf(cover.coverId, size), { url: cover.available && cover.url ? cover.url : null, at: now });
  }
  for (const id of ids) if (!seen.has(id)) cache.set(keyOf(id, size), { url: null, at: now });
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
