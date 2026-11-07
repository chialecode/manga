import { Worker } from "node:worker_threads";
import { MangaError } from "@manga/contracts";
import type { WalkEntry } from "./plan.ts";

/**
 * The part of a scan that touches the disk a lot: listing a library path and sampling files for a quick identity. It runs in a
 * worker thread so a path with tens of thousands of files never holds the main process's event loop. The source is plain
 * CommonJS run with `eval`, so it needs no extra file in the packaged app and nothing to locate; it only uses Node's own modules.
 */
const WALKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");

const cancelled = new Set();
const IGNORED = /^(thumbs\.db|desktop\.ini|\.ds_store)$/i;
const ignored = (name) => IGNORED.test(name) || name.startsWith("._") || name.startsWith(".") || name === "__MACOSX";
const BATCH = 400;

parentPort.on("message", (message) => {
  if (message.type === "cancel") { cancelled.add(message.id); return; }
  if (message.type === "list") void list(message);
  else if (message.type === "keys") void keys(message);
});

async function list(request) {
  const { id, root, maxDepth, maxEntries } = request;
  let batch = [];
  let total = 0;
  let truncated = false;
  const failed = [];
  const flush = () => {
    if (batch.length) { parentPort.postMessage({ id, type: "batch", entries: batch }); batch = []; }
  };
  const record = (rel, error) => failed.push({ p: rel || ".", code: (error && error.code) || "ERROR" });
  async function walk(dir, rel, depth) {
    if (cancelled.has(id) || truncated) return;
    let handle;
    try { handle = await fsp.opendir(dir); } catch (error) { record(rel, error); return; }
    const subdirs = [];
    try {
      for await (const entry of handle) {
        if (cancelled.has(id)) break;
        if (ignored(entry.name)) continue;
        const childRel = rel ? rel + "/" + entry.name : entry.name;
        if (entry.isDirectory()) {
          batch.push({ p: childRel, t: "d", s: 0, m: 0 });
          if (depth < maxDepth) subdirs.push(entry.name);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          let stat;
          try { stat = await fsp.stat(path.join(dir, entry.name)); } catch (error) { record(childRel, error); continue; }
          // A link that leads to a folder is not followed, so a loop through links cannot keep the walk going.
          if (!stat.isFile()) continue;
          batch.push({ p: childRel, t: "f", s: stat.size, m: Math.floor(stat.mtimeMs) });
          total += 1;
          if (total >= maxEntries) { truncated = true; break; }
        }
        if (batch.length >= BATCH) { flush(); await new Promise((resolve) => setImmediate(resolve)); }
      }
    } catch (error) { record(rel, error); }
    for (const name of subdirs) await walk(path.join(dir, name), rel ? rel + "/" + name : name, depth + 1);
  }
  try {
    await fsp.access(root);
    await walk(root, "", 0);
    flush();
    parentPort.postMessage({ id, type: "done", failed, truncated, cancelled: cancelled.has(id) });
  } catch (error) {
    parentPort.postMessage({ id, type: "error", code: (error && error.code) || "ERROR", message: String(error && error.message || error) });
  }
}

const SAMPLE = 64 * 1024;

/** Size plus the first, middle and last 64 KiB: enough to tell a moved file from another file, cheap for a multi-gigabyte video. */
async function sampleKey(file, size) {
  const hash = crypto.createHash("sha256");
  hash.update(String(size));
  const handle = await fsp.open(file, "r");
  try {
    const offsets = size <= SAMPLE * 3 ? [0] : [0, Math.floor(size / 2) - SAMPLE / 2, size - SAMPLE];
    for (const offset of offsets) {
      const length = size <= SAMPLE * 3 ? size : SAMPLE;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest("hex");
}

async function keys(request) {
  const { id, files } = request;
  const results = [];
  for (const file of files) {
    if (cancelled.has(id)) break;
    try { results.push({ p: file.p, key: await sampleKey(file.abs, file.size) }); } catch (error) { results.push({ p: file.p, error: (error && error.code) || "ERROR" }); }
  }
  parentPort.postMessage({ id, type: "keys", results, cancelled: cancelled.has(id) });
}
`;

export type WalkResult = { failed: Array<{ p: string; code: string }>; truncated: boolean; cancelled: boolean };

/** A long-lived worker thread; created on first use and ended with the service. */
export class WalkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, { onBatch?: (entries: WalkEntry[]) => void; resolve: (value: never) => void; reject: (error: Error) => void }>();

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WALKER_SOURCE, { eval: true });
    worker.on("message", (message: { id: number; type: string; entries?: WalkEntry[]; [key: string]: unknown }) => {
      const item = this.pending.get(message.id);
      if (!item) return;
      if (message.type === "batch") { item.onBatch?.(message.entries ?? []); return; }
      this.pending.delete(message.id);
      if (message.type === "error") item.reject(new MangaError("LOCATION_UNAVAILABLE", `the folder could not be read (${String(message.code)})`, { details: { code: message.code } }));
      else item.resolve(message as never);
    });
    const fail = (error: Error) => {
      this.worker = null;
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", () => fail(new MangaError("INTERRUPTED", "the scan worker stopped")));
    this.worker = worker;
    return worker;
  }

  private request<T>(message: Record<string, unknown>, onBatch: ((entries: WalkEntry[]) => void) | undefined, signal?: AbortSignal): Promise<T> {
    const worker = this.start();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { onBatch, resolve: resolve as (value: never) => void, reject });
      const abort = () => { worker.postMessage({ type: "cancel", id }); };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      worker.postMessage({ ...message, id });
    });
  }

  /** List everything below `root`, handing the entries over in batches. Folders that cannot be read are reported, not fatal. */
  list(root: string, options: { maxDepth: number; maxEntries: number; onBatch: (entries: WalkEntry[]) => void; signal?: AbortSignal }): Promise<WalkResult> {
    return this.request<WalkResult>({ type: "list", root, maxDepth: options.maxDepth, maxEntries: options.maxEntries }, options.onBatch, options.signal);
  }

  /** Quick identities for single files, read in the worker. */
  async keys(files: Array<{ p: string; abs: string; size: number }>, signal?: AbortSignal): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let at = 0; at < files.length; at += 200) {
      const reply = await this.request<{ results: Array<{ p: string; key?: string }> }>({ type: "keys", files: files.slice(at, at + 200) }, undefined, signal);
      for (const item of reply.results) if (item.key) out.set(item.p, item.key);
      if (signal?.aborted) break;
    }
    return out;
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    for (const item of this.pending.values()) item.reject(new MangaError("CANCELLED", "the scan worker was closed"));
    this.pending.clear();
    if (worker) void worker.terminate();
  }
}
