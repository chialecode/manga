import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";

export type ParseRequest = {
  kind: "text" | "epub";
  bytes: number[];
  encoding?: "utf-8" | "utf-16le";
  delayMs?: number;
  signal?: AbortSignal;
};

export type ParseClient = {
  pid(): number | undefined;
  parse(request: ParseRequest): Promise<unknown>;
  close(): Promise<void>;
  kill(): void;
};

function workerCommand(): string[] {
  const candidates = [
    process.env.M0_PARSE_WORKER_PATH,
    path.join(path.dirname(process.argv[1] ?? "."), "parse-worker.cjs"),
    path.join(process.cwd(), "experiments/m0/src/hosts/parse-worker.ts"),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate.endsWith(".ts") ? ["--experimental-strip-types", candidate] : [candidate];
    }
  }
  throw new Error("parse worker entry is missing");
}

export function startParseWorker(): ParseClient {
  const args = workerCommand();
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
    env: { ...process.env },
    windowsHide: true,
  });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (reason: string) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(reason));
    }
    pending.clear();
  };
  child.on("exit", () => fail("parse worker exited"));
  child.on("error", (error) => fail(error.message));
  child.stderr.resume();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try {
      const message = JSON.parse(line) as { id?: string; status?: string; value?: unknown; error?: { message: string } };
      if (!message.id || !pending.has(message.id)) return;
      const item = pending.get(message.id)!;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.status === "error") item.reject(new Error(message.error?.message ?? "parse failed"));
      else item.resolve(message.value);
    } catch {
      // ignore non-json
    }
  });
  let seq = 0;
  const send = (value: Record<string, unknown>, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || !child.stdin.writable) return reject(new Error("parse worker unavailable"));
    const id = String(value.id ?? `parse-${seq++}`);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("parse worker timeout"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ ...value, id })}\n`, (error) => {
      if (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  });
  return {
    pid: () => child.pid,
    parse: async (request) => {
      const id = `parse-${seq++}`;
      if (request.signal?.aborted) throw new Error("parse cancelled");
      const work = send({
        type: "parse",
        id,
        kind: request.kind,
        bytes: request.bytes,
        encoding: request.encoding,
        delayMs: request.delayMs,
      });
      const onAbort = () => {
        if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: "cancel", id })}\n`);
        const item = pending.get(id);
        if (item) {
          clearTimeout(item.timer);
          pending.delete(id);
          item.reject(new Error("parse cancelled"));
        }
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await work;
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
    close: async () => {
      try { await send({ type: "shutdown" }, 2000); } catch { /* killed below */ }
      child.kill();
    },
    kill: () => {
      child.kill();
    },
  };
}
