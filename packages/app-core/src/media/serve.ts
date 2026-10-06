import fs from "node:fs";
import { Readable } from "node:stream";
import { MangaError } from "@manga/contracts";
import { parseMediaUrl, type MediaHandleTable, type MediaSource } from "./handles.ts";
import type { ZipPool } from "./zip-pool.ts";

export type ByteRange = { start: number; end: number };
export type RangeDecision =
  | { kind: "full" }
  | { kind: "partial"; range: ByteRange }
  | { kind: "unsatisfiable" };

/**
 * RFC 9110 single-range handling. A malformed header is ignored (the whole body is served); a range that starts past
 * the end is unsatisfiable; several ranges are not supported and fall back to the whole body, which the RFC allows.
 */
export function decideRange(header: string | null | undefined, size: number): RangeDecision {
  if (!header) return { kind: "full" };
  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (!match) return { kind: "full" };
  const spec = match[1]!.trim();
  if (spec.includes(",")) return { kind: "full" };
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts || (parts[1] === "" && parts[2] === "")) return { kind: "full" };
  if (size === 0) return { kind: "unsatisfiable" };
  if (parts[1] === "") {
    const suffix = Number(parts[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", range: { start: Math.max(0, size - suffix), end: size - 1 } };
  }
  const start = Number(parts[1]);
  if (!Number.isSafeInteger(start)) return { kind: "unsatisfiable" };
  if (start >= size) return { kind: "unsatisfiable" };
  // An end too large to be an exact integer still means "to the end".
  const requestedEnd = parts[2] === "" ? size - 1 : parts[2]!.length > 15 ? Number.MAX_SAFE_INTEGER : Number(parts[2]);
  if (requestedEnd < start) return { kind: "full" };
  return { kind: "partial", range: { start, end: Math.min(requestedEnd, size - 1) } };
}

export type ServeEnv = {
  handles: MediaHandleTable;
  zips: ZipPool;
};

function sourceSize(source: MediaSource): number {
  switch (source.kind) {
    case "file": return fs.statSync(source.path).size;
    case "slice": return source.length;
    case "zip-entry": return source.size;
    case "buffer": return source.bytes.byteLength;
  }
}

async function openBody(env: ServeEnv, source: MediaSource, range: ByteRange | null, signal?: AbortSignal): Promise<Readable> {
  switch (source.kind) {
    case "file": {
      const stream = fs.createReadStream(source.path, range ? { start: range.start, end: range.end } : undefined);
      signal?.addEventListener("abort", () => stream.destroy(), { once: true });
      return stream;
    }
    case "slice": {
      const start = source.offset + (range?.start ?? 0);
      const end = source.offset + (range?.end ?? source.length - 1);
      const stream = fs.createReadStream(source.path, { start, end });
      signal?.addEventListener("abort", () => stream.destroy(), { once: true });
      return stream;
    }
    case "zip-entry": {
      if (!range) return (await env.zips.openStream(source.archive, source.entry, signal)).stream;
      // A zip member cannot be entered in the middle; decode it and cut the requested window.
      const whole = await env.zips.read(source.archive, source.entry, { signal });
      return Readable.from([whole.subarray(range.start, range.end + 1)]);
    }
    case "buffer": {
      const bytes = range ? source.bytes.subarray(range.start, range.end + 1) : source.bytes;
      return Readable.from([Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
    }
  }
}

const NO_STORE = "no-store";
const base = (extra: Record<string, string> = {}) => ({
  "Cache-Control": NO_STORE,
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
  ...extra,
});

function failure(status: number, message: string): Response {
  return new Response(message, { status, headers: base({ "Content-Type": "text/plain; charset=utf-8" }) });
}

/**
 * Answers one `manga-media:` request. The URL carries nothing but a handle; the handle decides what is read, so there is
 * no path to escape. Unknown, expired and revoked handles all get the same 404.
 */
export async function serveMedia(env: ServeEnv, request: { url: string; method: string; headers: { get(name: string): string | null }; signal?: AbortSignal }): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return failure(405, "method not allowed");
  const handle = parseMediaUrl(request.url);
  if (!handle) return failure(400, "bad media url");
  const resolved = env.handles.resolve(handle);
  if (!resolved) return failure(404, "not found");
  const { source } = resolved;
  let size: number;
  try { size = sourceSize(source); } catch { return failure(404, "not found"); }
  const decision = decideRange(request.headers.get("range"), size);
  const common = { "Content-Type": source.mediaType, "Accept-Ranges": "bytes" };
  if (decision.kind === "unsatisfiable") return new Response(null, { status: 416, headers: base({ ...common, "Content-Range": `bytes */${size}` }) });
  const range = decision.kind === "partial" ? decision.range : null;
  const length = range ? range.end - range.start + 1 : size;
  const headers = base({
    ...common,
    "Content-Length": String(length),
    ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
  });
  const status = range ? 206 : 200;
  if (method === "HEAD" || length === 0) return new Response(null, { status, headers });
  try {
    const body = await openBody(env, source, range, request.signal);
    return new Response(Readable.toWeb(body) as ReadableStream, { status, headers });
  } catch (error) {
    if (error instanceof MangaError && error.code === "NOT_FOUND") return failure(404, "not found");
    if (error instanceof MangaError && error.code === "CANCELLED") return failure(499, "cancelled");
    return failure(500, "media could not be read");
  }
}
