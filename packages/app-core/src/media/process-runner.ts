import { spawn } from "node:child_process";
import os from "node:os";
import { MangaError } from "@manga/contracts";

export type ToolRun = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  durationMs: number;
  /** Why the runner ended the process, when it did. A process that died on its own has `killed: null`. */
  killed: "timeout" | "cancelled" | "output-limit" | null;
};

export type ToolRunOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Bytes of stdout kept. Output beyond it ends the process: a probe that prints without bound is a fault, not data. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Called with each complete line of stdout (used for `-progress pipe:1`). Lines are not kept when this is given. */
  onStdoutLine?: (line: string) => void;
  /** Extra strings to hide in error text on top of the generic path redaction. */
  redact?: string[];
  cwd?: string;
  /** Tests and supervisors use the pid to confirm the process is really gone afterwards. */
  onSpawn?: (pid: number | undefined) => void;
};

const DEFAULT_TIMEOUT = 120_000;

/** Replace file paths and the user's home directory so a tool's complaint can be shown without leaking where files live. */
export function redactToolText(text: string, extra: string[] = []): string {
  let out = text;
  for (const secret of [...extra, os.homedir()]) {
    if (secret && secret.length > 2) out = out.split(secret).join("<path>").split(secret.replace(/\\/g, "/")).join("<path>");
  }
  out = out.replace(/(?:[A-Za-z]:|\\\\\?\\[A-Za-z]:)[\\/][^\s"'<>|*?]*/g, "<path>");
  out = out.replace(/(?:^|[\s"'=])(\/(?:home|Users|tmp|var|mnt|media)\/[^\s"'<>|*?]*)/g, (match, p1: string) => match.replace(p1, "<path>"));
  return out;
}

/**
 * Run a helper process to completion. The process is always reaped: timeout, cancellation and output overflow each end it,
 * and the result says which. Nothing here interprets the tool's output.
 */
export function runTool(file: string, args: string[], options: ToolRunOptions = {}): Promise<ToolRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxStdout = options.maxStdoutBytes ?? 64 * 1024 * 1024;
  const maxStderr = options.maxStderrBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new MangaError("CANCELLED", "tool run was cancelled before it started"));
      return;
    }
    const started = Date.now();
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd: options.cwd });
    } catch (error) {
      reject(new MangaError("CAPABILITY_UNAVAILABLE", `tool could not be started: ${redactToolText(error instanceof Error ? error.message : String(error), options.redact)}`));
      return;
    }
    options.onSpawn?.(child.pid);
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let lineBuffer = "";
    let killed: ToolRun["killed"] = null;
    const stop = (reason: NonNullable<ToolRun["killed"]>) => {
      if (killed) return;
      killed = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdoutLine) {
        lineBuffer += chunk.toString("utf8");
        let at = lineBuffer.indexOf("\n");
        while (at >= 0) {
          options.onStdoutLine(lineBuffer.slice(0, at).replace(/\r$/, ""));
          lineBuffer = lineBuffer.slice(at + 1);
          at = lineBuffer.indexOf("\n");
        }
        return;
      }
      outBytes += chunk.length;
      if (outBytes > maxStdout) { stop("output-limit"); return; }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
      if (err.length > maxStderr) err = err.slice(err.length - maxStderr);
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.onStdoutLine && lineBuffer) options.onStdoutLine(lineBuffer.replace(/\r$/, ""));
      resolve({ code, signal, stdout: Buffer.concat(out), stderr: redactToolText(err, options.redact), durationMs: Date.now() - started, killed });
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new MangaError("CAPABILITY_UNAVAILABLE", `tool could not run: ${redactToolText(error.message, options.redact)}`));
    });
    child.on("close", finish);
  });
}

/** A small counting semaphore; waiters leave the queue when their signal aborts. */
export class Lane {
  private active = 0;
  private readonly waiting: Array<{ start: () => void; cancel: () => void }> = [];

  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get running(): number { return this.active; }
  get queued(): number { return this.waiting.length; }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new MangaError("CANCELLED", "task was cancelled while waiting");
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      // The slot is handed over by whoever finishes, so `active` never dips below the real number of running tasks.
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          start: () => { signal?.removeEventListener("abort", waiter.cancel); resolve(); },
          cancel: () => {
            const at = this.waiting.indexOf(waiter);
            if (at >= 0) this.waiting.splice(at, 1);
            reject(new MangaError("CANCELLED", "task was cancelled while waiting"));
          },
        };
        this.waiting.push(waiter);
        signal?.addEventListener("abort", waiter.cancel, { once: true });
      });
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next.start(); else this.active -= 1;
    }
  }
}
