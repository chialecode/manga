import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ParseClient = {
  pid(): number | undefined;
  parse(request: { bytes: number[]; encoding?: "utf-8" | "utf-16le"; delayMs?: number; signal?: AbortSignal }): Promise<unknown>;
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
  const here = path.dirname(fileURLToPath(import.meta.url));
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
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (reason: string) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(reason));
    }
    pending.clear();
  };
  child.on("exit", () => fail("parse worker exited"));
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
      // ignore
    }
  });
  let seq = 0;
  return {
    pid: () => child.pid,
    parse: (request) => {
      const id = `parse-${seq++}`;
      return new Promise((resolve, reject) => {
        if (request.signal?.aborted) return reject(new Error("parse cancelled"));
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("parse worker timeout"));
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        const onAbort = () => {
          if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: "cancel", id })}\n`);
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdin.write(`${JSON.stringify({ type: "parse", id, kind: "text", bytes: request.bytes, encoding: request.encoding, delayMs: request.delayMs })}\n`);
      });
    },
    kill: () => child.kill(),
  };
}
