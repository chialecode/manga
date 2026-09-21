import { createInterface } from "node:readline";
import { decodeTextBuffer, normalizeText } from "../domain/text-locator.ts";
import { parseEpub } from "../domain/epub.ts";

type WorkerMessage = {
  type: string;
  id?: string;
  kind?: "text" | "epub";
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
  if (signal.aborted) throw Object.assign(new Error("parse cancelled"), { code: "CANCELLED" });
  const bytes = Uint8Array.from(job.bytes ?? []);
  if (job.kind === "epub") {
    const parsed = parseEpub(bytes);
    return {
      kind: "epub",
      title: parsed.title,
      parts: parsed.parts.map((part) => ({
        id: part.id,
        normalized: part.text.normalized,
        parserVersion: part.text.parserVersion,
      })),
    };
  }
  const decoded = decodeTextBuffer(bytes, job.encoding ?? "utf-8");
  const normalized = normalizeText(decoded.text);
  return {
    kind: "text",
    bom: decoded.bom,
    normalized: normalized.normalized,
    parserVersion: normalized.parserVersion,
    length: normalized.normalized.length,
  };
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  send({ type: "hello", pid: process.pid });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message: WorkerMessage;
    try {
      message = JSON.parse(line);
    } catch {
      send({ type: "error", error: { code: "VALIDATION_ERROR", message: "malformed worker message" } });
      continue;
    }
    if (message.type === "shutdown") {
      for (const controller of jobs.values()) controller.abort();
      send({ type: "result", id: message.id, value: { ok: true } });
      break;
    }
    if (message.type === "cancel" && message.id) {
      jobs.get(message.id)?.abort();
      send({ type: "result", id: message.id, value: { cancelled: jobs.has(message.id) } });
      continue;
    }
    if (message.type === "parse" && message.id && (message.kind === "text" || message.kind === "epub") && Array.isArray(message.bytes)) {
      const controller = new AbortController();
      jobs.set(message.id, controller);
      handle(message, controller.signal)
        .then((value) => send({ type: "result", id: message.id, status: "ok", value }))
        .catch((error) => send({
          type: "result",
          id: message.id,
          status: "error",
          error: { code: (error as { code?: string }).code ?? "VALIDATION_ERROR", message: error instanceof Error ? error.message : String(error) },
        }))
        .finally(() => jobs.delete(message.id!));
      continue;
    }
    send({ type: "result", id: message.id, status: "error", error: { code: "VALIDATION_ERROR", message: "unknown worker request" } });
  }
  process.exit(0);
}

void main();
