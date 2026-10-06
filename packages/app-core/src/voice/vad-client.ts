import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { MangaError } from "@manga/contracts";

/** What the capture pipeline needs from a voice-activity engine; the real one runs in a worker, tests may inject a stand-in. */
export interface VadStream {
  /** Speech probabilities for the whole 512-sample frames the pushed audio completes. */
  push(pcm: Int16Array): Promise<Float32Array>;
  close(): void;
}

export interface VadEngine {
  readonly available: boolean;
  /** Why it is not available, in words for a status line. */
  readonly unavailableReason?: string;
  open(): VadStream;
  /** Probabilities for a whole staged PCM file, from its first sample. */
  analyzeFile(file: string, options?: { signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<Float32Array>;
  dispose(): void;
}

export type VadAssets = { modelPath: string; ortEntry: string; wasmDir: string };

const resolveFrom = (...parts: string[]) => path.join(...parts);

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

function assetsAt(modelDir: string, ortDir: string): VadAssets | null {
  const modelPath = resolveFrom(modelDir, "silero_vad.onnx");
  const ortEntry = resolveFrom(ortDir, "ort.node.min.js");
  return fs.existsSync(modelPath) && fs.existsSync(ortEntry) ? { modelPath, ortEntry, wasmDir: ortDir } : null;
}

/**
 * Where the model and the WebAssembly runtime are looked for: an explicit directory (`MANGA_VAD_DIR`), the copy shipped
 * with a packaged build, and the development copies (the model fetched under `dist/tools/silero-vad`, the runtime in
 * `node_modules`). Nothing is fetched at run time: a missing file is a capability the caller reports.
 */
export function locateVadAssets(options: { env?: NodeJS.ProcessEnv; resourcesPath?: string; cwd?: string } = {}): VadAssets | null {
  const env = options.env ?? process.env;
  if (env.MANGA_VAD_DIR) {
    const found = assetsAt(env.MANGA_VAD_DIR, path.join(env.MANGA_VAD_DIR, "ort"));
    if (found) return found;
  }
  const resources = options.resourcesPath ?? (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resources) {
    for (const base of [path.join(resources, "vad"), path.join(resources, "app.asar.unpacked", "vad")]) {
      const found = assetsAt(base, path.join(base, "ort"));
      if (found) return found;
    }
  }
  const root = workspaceRoot(options.cwd ?? process.cwd()) ?? workspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (root) {
    const found = assetsAt(path.join(root, "dist", "tools", "silero-vad"), path.join(root, "node_modules", "onnxruntime-web", "dist"));
    if (found) return found;
  }
  return null;
}

function workerCandidates(explicit?: string): string[] {
  const here = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath ?? "";
  const argvDir = path.dirname(process.argv[1] ?? here);
  const names = [
    explicit,
    process.env.MANGA_VAD_WORKER,
    path.join(here, "vad-worker.ts"),
    path.join(here, "vad-worker.cjs"),
    path.join(argvDir, "vad-worker.cjs"),
    resources ? path.join(resources, "app.asar.unpacked", ".vite", "build", "vad-worker.cjs") : "",
    resources ? path.join(resources, "vad-worker.cjs") : "",
  ];
  return names.filter((file): file is string => Boolean(file)).flatMap((file) => {
    const marker = `${path.sep}app.asar${path.sep}`;
    return file.includes(marker) ? [file.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`), file] : [file];
  });
}

type Pending = { resolve: (value: Float32Array) => void; reject: (error: Error) => void; onProgress?: (fraction: number) => void };

const restarted = () => new MangaError("PROVIDER_UNAVAILABLE", "the voice filter restarted and lost this stream", { retryable: true });

/** The production engine: one worker thread, started on first use and restarted if it ever dies. */
export class VadWorkerClient implements VadEngine {
  private worker: Worker | null = null;
  private ready: Promise<Worker> | null = null;
  private generation = 0;
  private seq = 0;
  private streamSeq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly assets: VadAssets | null;
  private readonly workerPath: string | null;

  constructor(options: { assets?: VadAssets | null; workerPath?: string; resourcesPath?: string } = {}) {
    this.assets = options.assets === undefined ? locateVadAssets({ resourcesPath: options.resourcesPath }) : options.assets;
    this.workerPath = workerCandidates(options.workerPath).find((file) => fs.existsSync(file)) ?? null;
  }

  get available(): boolean {
    return Boolean(this.assets && this.workerPath);
  }

  get unavailableReason(): string | undefined {
    if (!this.assets) return "the voice filter model or runtime is not installed";
    if (!this.workerPath) return "the voice filter worker is missing";
    return undefined;
  }

  private start(): Promise<Worker> {
    if (this.ready) return this.ready;
    if (!this.assets || !this.workerPath) return Promise.reject(new MangaError("CAPABILITY_UNAVAILABLE", this.unavailableReason ?? "voice filter unavailable"));
    const generation = ++this.generation;
    const worker = new Worker(this.workerPath, {
      workerData: { modelPath: this.assets.modelPath, ortEntry: this.assets.ortEntry, wasmDir: this.assets.wasmDir },
      execArgv: this.workerPath.endsWith(".ts") ? ["--experimental-strip-types"] : [],
    });
    this.worker = worker;
    const ready = new Promise<Worker>((resolve, reject) => {
      const timer = setTimeout(() => reject(new MangaError("PROVIDER_UNAVAILABLE", "the voice filter did not start", { retryable: true })), 60_000);
      worker.on("message", (message: { type: string; id?: number; probs?: Float32Array; message?: string; fraction?: number }) => {
        if (generation !== this.generation) return;
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve(worker);
        } else if (message.type === "init-error") {
          clearTimeout(timer);
          reject(new MangaError("CAPABILITY_UNAVAILABLE", `the voice filter could not load: ${message.message ?? "unknown"}`));
        } else if (message.type === "result" && message.id !== undefined) {
          const item = this.pending.get(message.id);
          this.pending.delete(message.id);
          item?.resolve(message.probs!);
        } else if (message.type === "progress" && message.id !== undefined) {
          this.pending.get(message.id)?.onProgress?.(message.fraction ?? 0);
        } else if (message.type === "error" && message.id !== undefined) {
          const item = this.pending.get(message.id);
          this.pending.delete(message.id);
          item?.reject(message.message === "cancelled" ? new MangaError("CANCELLED", "the voice filter was cancelled") : new MangaError("PROVIDER_UNAVAILABLE", `voice filter failed: ${message.message ?? "unknown"}`, { retryable: true }));
        }
      });
      const gone = (reason: string) => {
        if (generation !== this.generation) return;
        clearTimeout(timer);
        this.drop(reason);
        reject(new MangaError("PROVIDER_UNAVAILABLE", reason, { retryable: true }));
      };
      worker.on("error", (error) => gone(`the voice filter stopped: ${error.message}`));
      worker.on("exit", () => gone("the voice filter exited"));
    });
    this.ready = ready;
    ready.catch(() => undefined);
    worker.postMessage({ type: "init" });
    return ready;
  }

  /** Forget the worker so the next call starts a new one; whatever was waiting on the old one fails now. */
  private drop(_reason: string): void {
    this.worker = null;
    this.ready = null;
    this.generation += 1;
    for (const item of this.pending.values()) item.reject(restarted());
    this.pending.clear();
  }

  private request(id: number, message: Record<string, unknown>, transfer: ArrayBuffer[] = [], onProgress?: (fraction: number) => void): Promise<Float32Array> {
    return this.start().then((worker) => new Promise<Float32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ ...message, id }, transfer);
    }));
  }

  open(): VadStream {
    const stream = ++this.streamSeq;
    // A stream belongs to one worker: if that one goes away its model state is gone, and the caller must fall back to a full pass.
    let boundTo = -1;
    let closed = false;
    return {
      push: async (pcm) => {
        if (closed) throw new MangaError("CANCELLED", "the voice filter stream is closed");
        const worker = await this.start();
        if (boundTo === -1) {
          boundTo = this.generation;
          worker.postMessage({ type: "open", stream });
        } else if (boundTo !== this.generation) {
          throw restarted();
        }
        const copy = new Int16Array(pcm);
        return this.request(++this.seq, { type: "push", stream, pcm: copy }, [copy.buffer]);
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (boundTo === this.generation && this.worker) this.worker.postMessage({ type: "close", stream });
      },
    };
  }

  async analyzeFile(file: string, options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<Float32Array> {
    if (options.signal?.aborted) throw new MangaError("CANCELLED", "the voice filter was cancelled");
    const id = ++this.seq;
    const run = this.request(id, { type: "analyze", file }, [], options.onProgress);
    const onAbort = () => this.worker?.postMessage({ type: "cancel", id });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await run;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  dispose(): void {
    const worker = this.worker;
    this.drop("the voice filter was shut down");
    if (!worker) return;
    // Ask the worker to release the model and leave on its own; ending a thread inside a WebAssembly call is the last resort.
    const forced = setTimeout(() => { void worker.terminate(); }, 3000);
    forced.unref();
    worker.once("exit", () => clearTimeout(forced));
    worker.postMessage({ type: "shutdown" });
  }
}
