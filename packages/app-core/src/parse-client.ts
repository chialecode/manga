import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MangaError } from "@manga/contracts";

export type ParseClient = {
  pid(): number | undefined;
  parse(request: {
    bytes?: number[];
    filePath?: string;
    encoding?: "utf-8" | "utf-16le";
    format?: string;
    kind?: "text" | "document";
    delayMs?: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
  kill(): void;
};

function unpackAsarPath(file: string): string {
  const marker = `${path.sep}app.asar${path.sep}`;
  const unpacked = `${path.sep}app.asar.unpacked${path.sep}`;
  if (file.includes(marker) && !file.includes(unpacked)) return file.replace(marker, unpacked);
  return file;
}

function expandWorkerPath(file: string): string[] {
  const unpacked = unpackAsarPath(file);
  return unpacked === file ? [file] : [unpacked, file];
}

function electronResourcesPath(): string {
  const value = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof value === "string" ? value : "";
}

function workerCandidates(): string[] {
  // The desktop bundle is CommonJS, where import.meta.url is not provided; __dirname is.
  const here = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const argvDir = path.dirname(process.argv[1] ?? here);
  const resources = electronResourcesPath();
  return [
    process.env.MANGA_PARSE_WORKER,
    path.join(here, "parse-worker.ts"),
    path.join(here, "parse-worker.cjs"),
    path.join(argvDir, "parse-worker.cjs"),
    resources ? path.join(resources, "parse-worker.cjs") : "",
    resources ? path.join(resources, "app.asar.unpacked", ".vite", "build", "parse-worker.cjs") : "",
    resources ? path.join(resources, "app", ".vite", "build", "parse-worker.cjs") : "",
  ].filter((file): file is string => Boolean(file)).flatMap(expandWorkerPath);
}

export function startParseWorker(explicitPath?: string): ParseClient {
  const files = [explicitPath, ...workerCandidates()].filter((file): file is string => Boolean(file)).flatMap(expandWorkerPath);
  const tsWorker = files.find((file) => file.endsWith(".ts") && fs.existsSync(file));
  const cjsWorker = files.find((file) => file.endsWith(".cjs") && fs.existsSync(file));
  const args = tsWorker ? ["--experimental-strip-types", tsWorker] : cjsWorker ? [cjsWorker] : null;
  if (!args) throw new Error(`parse worker binary is missing`);
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }>();
  let exited = false;
  const fail = (reason: string) => {
    exited = true;
    for (const item of pending.values()) {
      item.cleanup();
      item.reject(new Error(reason));
    }
    pending.clear();
  };
  child.stdin.on("error", () => undefined);
  child.on("exit", () => fail("parse worker exited"));
  child.stderr.resume();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try {
      const message = JSON.parse(line) as { id?: string; status?: string; value?: unknown; error?: { message: string; code?: string } };
      if (!message.id || !pending.has(message.id)) return;
      const item = pending.get(message.id)!;
      pending.delete(message.id);
      item.cleanup();
      if (message.status === "error") {
        if (message.error?.code === "CANCELLED") {
          item.reject(new MangaError("CANCELLED", message.error.message || "parse cancelled", { retryable: true }));
          return;
        }
        const failure = new Error(message.error?.message ?? "parse failed") as Error & { code?: string };
        failure.code = message.error?.code;
        item.reject(failure);
      } else item.resolve(message.value);
    } catch {
      // ignore
    }
  });
  let seq = 0;
  return {
    pid: () => child.pid,
    parse: (request) => {
      const id = `parse-${seq++}`;
      return new Promise((resolve, reject) => {
        if (request.signal?.aborted) return reject(new MangaError("CANCELLED", "parse cancelled", { retryable: true }));
        if (exited || child.killed || !child.stdin.writable) return reject(new Error("parse worker exited"));
        let onAbort: (() => void) | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          if (onAbort) request.signal?.removeEventListener("abort", onAbort);
        };
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          cleanup();
          reject(new Error("parse worker timeout"));
        }, request.filePath || request.kind === "document" ? 120_000 : 20_000);
        onAbort = () => {
          if (pending.delete(id)) {
            cleanup();
            reject(new MangaError("CANCELLED", "parse cancelled", { retryable: true }));
          }
          if (!exited && !child.killed && child.stdin.writable) {
            try { child.stdin.write(`${JSON.stringify({ type: "cancel", id })}\n`); } catch { /* worker already closed */ }
          }
        };
        pending.set(id, { resolve, reject, cleanup });
        request.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          child.stdin.write(`${JSON.stringify({ type: "parse", id, kind: request.kind ?? "text", bytes: request.bytes, filePath: request.filePath, format: request.format, encoding: request.encoding, delayMs: request.delayMs })}\n`);
        } catch {
          if (pending.delete(id)) {
            cleanup();
            reject(new Error("parse worker exited"));
          }
        }
      });
    },
    kill: () => {
      exited = true;
      child.kill();
    },
  };
}
