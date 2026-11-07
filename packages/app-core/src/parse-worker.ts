import fs from "node:fs";
import { createInterface } from "node:readline";
import { MangaError } from "@manga/contracts";
import { parseDocument } from "./domain/formats.ts";
import { decodeTextBuffer, normalizeText } from "./domain/text.ts";

type WorkerMessage = {
  type: string;
  id?: string;
  kind?: "text" | "document";
  bytes?: number[];
  filePath?: string;
  format?: "txt" | "epub" | "mobi" | "pdf" | "auto";
  encoding?: "utf-8" | "utf-16le";
  delayMs?: number;
};

const jobs = new Map<string, AbortController>();

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Extracted page/illustration bytes cross the worker boundary as base64, because the channel is
 * line-delimited JSON and a raw Uint8Array would arrive as a plain index-keyed object.
 */
function encodeAssets(parsed: { assets?: Array<{ bytes?: unknown }> }): unknown {
  if (!parsed.assets?.length) return parsed;
  return {
    ...parsed,
    assets: parsed.assets.map((asset) => ({
      ...asset,
      bytes: Buffer.from(asset.bytes as Uint8Array).toString("base64"),
      bytesEncoding: "base64" as const,
    })),
  };
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
  if (job.kind === "document") {
    const bytes = job.filePath ? new Uint8Array(fs.readFileSync(job.filePath)) : Uint8Array.from(job.bytes ?? []);
    return encodeAssets(await parseDocument(bytes, { format: job.format, encoding: job.encoding, signal }));
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
        .catch((error) => send({
          type: "result",
          id: message.id,
          status: "error",
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: error instanceof MangaError ? error.code : "UNSUPPORTED_FORMAT",
          },
        }))
        .finally(() => jobs.delete(message.id!));
    }
  }
})();
