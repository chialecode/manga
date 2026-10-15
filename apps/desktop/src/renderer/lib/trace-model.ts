import type { MessageKey, Translator } from "@manga/i18n";

type T = Translator["t"];

/** One line of a task's trace, as the host lists it (the contents are fetched part by part). */
export type TraceEntry = {
  id: string;
  runId: string;
  step: number;
  kind: "model" | "tool" | "compaction";
  name: string | null;
  status: "running" | "ok" | "error" | "cancelled";
  startedAt: string;
  firstTokenMs: number | null;
  durationMs: number | null;
  connectionId: string | null;
  modelId: string | null;
  protocol: string | null;
  requestBytes: number;
  responseBytes: number;
  truncated: boolean;
  hasContent: boolean;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  error: { code?: string; message?: string } | null;
};

export type TracePart = { entryId: string; part: "request" | "response"; available: boolean; text: string; offset: number; total: number; truncated: boolean; bytes: number };

/** A span of time as a person reads it: milliseconds under a second, seconds under a minute, then minutes and seconds. */
export function spanLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} m ${String(seconds % 60).padStart(2, "0")} s`;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What an entry is called: the kind of it, and for a compaction or a request what it was for. */
export function entryTitle(t: T, entry: TraceEntry): string {
  const name = entry.name ?? "";
  if (entry.kind === "tool") return name || t("trace.kind.tool");
  const summary = /^compaction#(\d+)$/.exec(name);
  if (summary) return t("trace.name.summary", { n: summary[1]! });
  const known = `trace.name.${name}` as MessageKey;
  const label = name ? t(known) : "";
  return label && label !== known ? label : t(`trace.kind.${entry.kind}` as MessageKey);
}

/** A part as it is read: compact JSON becomes indented, and anything else stays as it was. */
export function readable(text: string, complete: boolean): string {
  if (!complete) return text;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
