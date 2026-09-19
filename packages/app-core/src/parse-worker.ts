import { createInterface } from "node:readline";
import { decodeTextBuffer, normalizeText } from "./domain/text.ts";

type WorkerMessage = {
  type: string;
  id?: string;
  kind?: "text";
  bytes?: number[];
  encoding?: "utf-8" | "utf-16le";
  delayMs?: number;
};

const jobs = new Map<string, AbortController>();

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(job: WorkerMessage, signal: AbortSignal): Promise<unknown> {
  if (job.delayMs && job.delayMs > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, job.delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("parse cancelled"), { code: "CANCELLED" }));
      }, { once: true });
    });
  }
  const bytes = Uint8Array.from(job.bytes ?? []);
  const decoded = decodeTextBuffer(bytes, job.encoding ?? "utf-8");
  const normalized = normalizeText(decoded.text);
  return { kind: "text", bom: decoded.bom, normalized: normalized.normalized, parserVersion: normalized.parserVersion };
}

const rl = createInterface({ input: process.stdin });
send({ type: "hello", pid: process.pid });
void (async () => {
  for await (const line of rl) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as WorkerMessage;
    if (message.type === "shutdown") {
      for (const controller of jobs.values()) controller.abort();
      send({ type: "result", id: message.id, value: { ok: true } });
      break;
    }
    if (message.type === "cancel" && message.id) {
      jobs.get(message.id)?.abort();
      send({ type: "result", id: message.id, value: { cancelled: true } });
      continue;
    }
    if (message.type === "parse" && message.id) {
      const controller = new AbortController();
      jobs.set(message.id, controller);
      handle(message, controller.signal)
        .then((value) => send({ type: "result", id: message.id, status: "ok", value }))
        .catch((error) => send({ type: "result", id: message.id, status: "error", error: { message: (error as Error).message } }))
        .finally(() => jobs.delete(message.id!));
    }
  }
})();
