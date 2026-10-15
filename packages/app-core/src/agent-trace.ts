import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { createId, MangaError } from "@manga/contracts";
import { TRACE_PART_LIMIT_BYTES, type AgentTraceSettings, type TraceKind } from "@manga/contracts/models";
import type { TextRequest } from "@manga/model-protocol";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { REDACTED_SECRET, redactText } from "./ops/redact.ts";

/**
 * The record of what the agent sent and received (A-83): every request to a model, every tool it called and every compaction of its context, in order, with the
 * context and parameters that were sent, what came back, the time and the tokens. It exists to answer "why did it answer that", so it holds the whole of a part
 * (up to a limit, and a cut is marked) after the secrets and local paths are taken out; or, if the person chose so, only sizes, times and statuses.
 * It is kept on this machine, outside the backups and the packages, for a number of days and up to a size, and can be cleared at any time.
 * Writing it never fails a task: a record that cannot be written is simply missing.
 */

export type TraceStatus = "running" | "ok" | "error" | "cancelled";

export type TraceEntry = {
  id: string;
  runId: string;
  step: number;
  kind: TraceKind;
  name: string | null;
  status: TraceStatus;
  startedAt: string;
  /** Milliseconds from the request to its first words (or first tool call). */
  firstTokenMs: number | null;
  durationMs: number | null;
  connectionId: string | null;
  modelId: string | null;
  protocol: string | null;
  requestBytes: number;
  responseBytes: number;
  truncated: boolean;
  /** Whether the contents were kept (a record made in the sizes-only mode has none). */
  hasContent: boolean;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  error: { code?: string; message?: string } | null;
};

type Row = {
  id: string; run_id: string; step: number; kind: TraceKind; name: string | null; status: TraceStatus; started_at: string; first_token_at: string | null; ended_at: string | null;
  connection_id: string | null; model_id: string | null; protocol: string | null; request_z: Buffer | null; response_z: Buffer | null; request_bytes: number; response_bytes: number;
  truncated: number; usage_json: string | null; error_json: string | null;
};

export type TraceBegin = {
  runId: string;
  step: number;
  kind: TraceKind;
  name?: string;
  connection?: { id: string; modelId: string; protocol: string };
  request: unknown;
  /** Exact strings that must not appear in the record, such as the key of the connection. */
  secrets?: readonly string[];
};

export type TraceHandle = {
  readonly id: string;
  firstToken(): void;
  finish(response: unknown, usage?: TraceEntry["usage"]): void;
  /** The request did not finish. What had come back by then, if anything, is kept beside the error. */
  fail(error: unknown, status?: "error" | "cancelled", partial?: unknown): void;
};

/**
 * Fields named like a secret lose their value. The names of counts (`maxOutputTokens`, `inputTokens`) are not secrets and stay, which is why this is not the
 * redaction of the context panel, whose rule would blank every field with "token" in it.
 */
const SECRET_KEY = /(?:api[-_]?key|secret|password|passwd|credential|authorization|cookie|ciphertext)|^(?:access|refresh|auth|bearer|session|id|api)?[-_]?token$/i;

/** A copy of the value with the secrets, tokens and local paths taken out of every text and the secret-named fields blanked. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 24) return "（嵌套过深，已省略）";
  if (typeof value === "string") return redactText(value).text;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) && child !== null && child !== undefined && child !== "" ? REDACTED_SECRET : scrub(child, depth + 1);
    }
    return out;
  }
  return value;
}

/** Width and height from the header of a PNG, JPEG or WebP picture; null when it is none of them or the header is cut. */
export function imageDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("latin1", 12, 16) === "IHDR") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at += 1; continue; }
      const marker = bytes[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      at += 2 + bytes.readUInt16BE(at + 2);
    }
    return null;
  }
  if (bytes.length > 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    const kind = bytes.toString("latin1", 12, 16);
    if (kind === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") { const bits = bytes.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
  }
  return null;
}

/** The request as it is recorded: everything that was sent except the signal, and a picture only as its kind, size and a short fingerprint. */
export function recordedRequest(request: TextRequest): Record<string, unknown> {
  const { signal: _signal, ...rest } = request;
  return {
    ...rest,
    messages: request.messages.map((message) => {
      if (!message.images?.length) return message;
      return {
        ...message,
        images: message.images.map((image) => {
          const bytes = Buffer.from(image.base64, "base64");
          return { mediaType: image.mediaType, bytes: bytes.length, ...(imageDimensions(bytes) ?? {}), sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
        }),
      };
    }),
  };
}

const NOOP: TraceHandle = { id: "", firstToken() {}, finish() {}, fail() {} };

const mark = (originalBytes: number) => `（已截断：这一部分原有 ${originalBytes} 字节，只保留前 ${Math.round(TRACE_PART_LIMIT_BYTES / 1024)} KiB）`;

/** A text cut to a number of bytes without breaking a character. */
function cutBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  let end = Math.min(text.length, limit);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > limit) end -= Math.max(1, Math.ceil((Buffer.byteLength(text.slice(0, end)) - limit) / 4));
  // Do not end between the halves of a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** What is stored of a part: the redacted JSON, deflated, cut at the limit with the cut said. The original size is kept either way. */
function pack(value: unknown, secrets: readonly string[]): { z: Buffer; bytes: number; truncated: boolean } {
  const text = withoutSecrets(JSON.stringify(scrub(value)) ?? "null", secrets);
  const bytes = Buffer.byteLength(text);
  if (bytes <= TRACE_PART_LIMIT_BYTES) return { z: zlib.deflateSync(text), bytes, truncated: false };
  // A part that is cut is kept as a JSON object holding the head of the text, so what is stored always parses.
  const head = cutBytes(text, TRACE_PART_LIMIT_BYTES);
  return { z: zlib.deflateSync(JSON.stringify({ truncated: true, originalBytes: bytes, head, note: mark(bytes) })), bytes, truncated: true };
}

/** Only the size of a part, for the mode that keeps no contents. */
function measure(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(scrub(value)) ?? "null");
}

const parseUsage = (raw: string | null): TraceEntry["usage"] => {
  if (!raw) return null;
  try { return JSON.parse(raw) as TraceEntry["usage"]; } catch { return null; }
};
const parseError = (raw: string | null): TraceEntry["error"] => {
  if (!raw) return null;
  try { return JSON.parse(raw) as TraceEntry["error"]; } catch { return null; }
};

const entryOf = (row: Row): TraceEntry => ({
  id: row.id,
  runId: row.run_id,
  step: row.step,
  kind: row.kind,
  name: row.name,
  status: row.status,
  startedAt: row.started_at,
  firstTokenMs: row.first_token_at ? Math.max(0, Date.parse(row.first_token_at) - Date.parse(row.started_at)) : null,
  durationMs: row.ended_at ? Math.max(0, Date.parse(row.ended_at) - Date.parse(row.started_at)) : null,
  connectionId: row.connection_id,
  modelId: row.model_id,
  protocol: row.protocol,
  requestBytes: row.request_bytes,
  responseBytes: row.response_bytes,
  truncated: row.truncated === 1,
  hasContent: row.request_z !== null || row.response_z !== null,
  usage: parseUsage(row.usage_json),
  error: parseError(row.error_json),
});

/** The error of a failed request as it is kept: its code and its words. */
function errorOf(error: unknown): { code?: string; message: string } {
  if (error instanceof MangaError) return { code: error.code, message: error.message.slice(0, 500) };
  if (error && typeof error === "object" && "message" in error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return { ...(typeof code === "string" ? { code } : {}), message: String(message).slice(0, 500) };
  }
  return { message: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
}

/** A text with the exact strings that must not appear in it taken out, as they are written and as they are written inside JSON. */
function withoutSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    out = out.split(secret).join(REDACTED_SECRET);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join(REDACTED_SECRET);
  }
  return out;
}

const EXPORT_LIMIT_CHARS = 8 * 1024 * 1024;

export class AgentTrace {
  private readonly store: DrizzleStore;
  private readonly settings: () => AgentTraceSettings;

  constructor(store: DrizzleStore, settings: () => AgentTraceSettings) {
    this.store = store;
    this.settings = settings;
    // A request that was running when the process stopped will never finish.
    this.safely(() => this.store.sqlite.prepare("UPDATE agent_requests SET status = 'error', ended_at = ?, error_json = ? WHERE status = 'running'").run(new Date().toISOString(), JSON.stringify({ message: "the application stopped before this finished" })));
    this.safely(() => this.prune());
  }

  private safely<T>(action: () => T): T | undefined {
    try { return action(); } catch { return undefined; }
  }

  /** Start the record of one request, tool call or compaction. */
  begin(input: TraceBegin): TraceHandle {
    const id = createId("req");
    const startedAt = new Date().toISOString();
    const secrets = input.secrets ?? [];
    const full = this.settings().mode === "full";
    try {
      const request = full ? pack(input.request, secrets) : { z: null, bytes: measure(input.request), truncated: false };
      this.store.sqlite.prepare(`INSERT INTO agent_requests(id, run_id, step, kind, name, status, started_at, connection_id, model_id, protocol, request_z, request_bytes, truncated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.runId, input.step, input.kind, input.name ?? null, "running", startedAt, input.connection?.id ?? null, input.connection?.modelId ?? null, input.connection?.protocol ?? null, request.z, request.bytes, request.truncated ? 1 : 0);
    } catch {
      return NOOP;
    }
    let settled = false;
    return {
      id,
      firstToken: () => {
        this.safely(() => this.store.sqlite.prepare("UPDATE agent_requests SET first_token_at = ? WHERE id = ? AND first_token_at IS NULL").run(new Date().toISOString(), id));
      },
      finish: (response, usage) => {
        if (settled) return;
        settled = true;
        this.safely(() => {
          const packed = full ? pack(response, secrets) : { z: null, bytes: measure(response), truncated: false };
          // A runtime that does not know the tokens may say zero; zero is not a count.
          const counted = usage && (usage.inputTokens || usage.outputTokens || usage.costUsd) ? usage : null;
          this.store.sqlite.prepare("UPDATE agent_requests SET status = 'ok', ended_at = ?, response_z = ?, response_bytes = ?, truncated = MAX(truncated, ?), usage_json = ? WHERE id = ?").run(
            new Date().toISOString(), packed.z, packed.bytes, packed.truncated ? 1 : 0, counted ? JSON.stringify(counted) : null, id,
          );
        });
      },
      fail: (error, status = "error", partial) => {
        if (settled) return;
        settled = true;
        this.safely(() => {
          // The error is the provider's own words and may repeat what was sent, so it is cleaned like everything else.
          const words = withoutSecrets(JSON.stringify(scrub(errorOf(error))), secrets);
          const kept = partial === undefined ? null : full ? pack(partial, secrets) : { z: null, bytes: measure(partial), truncated: false };
          this.store.sqlite.prepare("UPDATE agent_requests SET status = ?, ended_at = ?, error_json = ?, response_z = ?, response_bytes = ?, truncated = MAX(truncated, ?) WHERE id = ?").run(
            status, new Date().toISOString(), words, kept?.z ?? null, kept?.bytes ?? 0, kept?.truncated ? 1 : 0, id,
          );
        });
      },
    };
  }

  /** A record of something that happened in no time, such as old tool results being cut down. */
  note(input: TraceBegin & { response: unknown }): void {
    const handle = this.begin(input);
    handle.finish(input.response);
  }

  list(runId: string): TraceEntry[] {
    const rows = this.store.sqlite.prepare("SELECT * FROM agent_requests WHERE run_id = ? ORDER BY started_at, rowid").all(runId) as Row[];
    return rows.map(entryOf);
  }

  /** One part of one entry, a page of its text at a time. */
  get(entryId: string, part: "request" | "response", offset: number, limit: number) {
    const row = this.store.sqlite.prepare("SELECT * FROM agent_requests WHERE id = ?").get(entryId) as Row | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "no such record");
    const blob = part === "request" ? row.request_z : row.response_z;
    if (!blob) return { entryId, part, available: false, text: "", offset: 0, total: 0, truncated: row.truncated === 1, bytes: part === "request" ? row.request_bytes : row.response_bytes };
    const text = zlib.inflateSync(blob).toString("utf8");
    const chars = [...text];
    return {
      entryId, part, available: true,
      text: chars.slice(offset, offset + limit).join(""),
      offset,
      total: chars.length,
      truncated: row.truncated === 1,
      bytes: part === "request" ? row.request_bytes : row.response_bytes,
    };
  }

  /** The whole record of a run as one JSON text, to copy. A run whose contents are more than the limit keeps the first entries whole and the rest as sizes. */
  export(runId: string): { json: string; entries: number; omitted: number } {
    const rows = this.store.sqlite.prepare("SELECT * FROM agent_requests WHERE run_id = ? ORDER BY started_at, rowid").all(runId) as Row[];
    let used = 0;
    let omitted = 0;
    const parse = (blob: Buffer | null) => {
      if (!blob) return undefined;
      const text = zlib.inflateSync(blob).toString("utf8");
      try { return JSON.parse(text) as unknown; } catch { return text; }
    };
    const entries = rows.map((row) => {
      const meta = entryOf(row);
      if (!meta.hasContent) return meta;
      const size = (row.request_z ? zlib.inflateSync(row.request_z).length : 0) + (row.response_z ? zlib.inflateSync(row.response_z).length : 0);
      if (used + size > EXPORT_LIMIT_CHARS) { omitted += 1; return { ...meta, omitted: "the export is limited in size; open this entry in the application" }; }
      used += size;
      return { ...meta, request: parse(row.request_z), response: parse(row.response_z) };
    });
    return { json: JSON.stringify({ runId, exportedAt: new Date().toISOString(), mode: this.settings().mode, entries }, null, 2), entries: entries.length, omitted };
  }

  stats(): { count: number; bytes: number; oldestAt: string | null } {
    const row = this.store.sqlite.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(length(request_z), 0) + COALESCE(length(response_z), 0)), 0) AS bytes, MIN(started_at) AS oldest FROM agent_requests").get() as { count: number; bytes: number; oldest: string | null };
    return { count: row.count, bytes: row.bytes, oldestAt: row.oldest };
  }

  clear(): { removed: number } {
    return { removed: this.store.sqlite.prepare("DELETE FROM agent_requests").run().changes };
  }

  /** Remove what is older than the days kept, then the oldest until the record is under its size. A request still running is never removed. */
  prune(now = Date.now()): { removed: number } {
    const settings = this.settings();
    let removed = this.store.sqlite.prepare("DELETE FROM agent_requests WHERE started_at < ? AND status != 'running'").run(new Date(now - settings.retentionDays * 86_400_000).toISOString()).changes;
    const limit = settings.maxMegabytes * 1024 * 1024;
    let total = this.stats().bytes;
    if (total <= limit) return { removed };
    const oldest = this.store.sqlite.prepare("SELECT id, COALESCE(length(request_z), 0) + COALESCE(length(response_z), 0) AS bytes FROM agent_requests WHERE status != 'running' ORDER BY started_at, rowid").all() as Array<{ id: string; bytes: number }>;
    const doomed: string[] = [];
    for (const row of oldest) {
      if (total <= limit) break;
      doomed.push(row.id);
      total -= row.bytes;
    }
    const remove = this.store.sqlite.prepare("DELETE FROM agent_requests WHERE id = ?");
    this.store.sqlite.transaction(() => { for (const id of doomed) removed += remove.run(id).changes; })();
    return { removed };
  }
}
