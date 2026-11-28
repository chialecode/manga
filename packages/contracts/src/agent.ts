import { z } from "zod";
import type { ProposalCard } from "./inputs-proposals.ts";
import type { SourceLocator } from "./location.ts";
import type { SpeechVoice, WebSearchItem } from "./provider.ts";

export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

/**
 * What one run may use. The context is counted in tokens (the model's window less the answer and a margin); the steps and the time are the person's
 * limits from the settings; the answer is limited by the model's own maximum.
 */
export const AgentBudgetSchema = z.object({
  maxSteps: z.number().int().positive().max(64).default(24),
  maxDurationMs: z.number().int().positive().max(30 * 60_000).default(10 * 60_000),
  contextWindow: z.number().int().positive(),
  contextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative().max(100).optional(),
}).strict();
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

export const AgentSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  grantHandle: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const AgentToolEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  commandId: z.string().min(1),
  status: z.enum(["proposed", "executed", "denied", "failed"]),
  inputSummary: z.string(),
  resultSummary: z.string().optional(),
  createdAt: z.string().min(1),
}).strict();
export type AgentToolEvent = z.infer<typeof AgentToolEventSchema>;

// ---------------------------------------------------------------------------
// Chat stream, timeline steps, citations, usage, and live IPC push contracts
// ---------------------------------------------------------------------------

export const SERVER_TOOL_STEP_KINDS = [
  "search",
  "open_page",
  "find_in_page",
  "read_link",
  "image_search",
  "deep_image_search",
] as const;
export type ServerToolStepKind = (typeof SERVER_TOOL_STEP_KINDS)[number];

export const STEP_STATUSES = ["wip", "done", "error"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export type AgentServerToolPage = {
  url: string;
  title?: string;
  site?: string;
  siteIcon?: string;
  snippet?: string;
  publishedAt?: string;
  failed?: boolean;
};

export type AgentServerToolKeyword = {
  pattern: string;
  url?: string;
  found?: boolean;
};

/** Aggregated server-side tool step shown in the unified thinking/search timeline. */
export type AgentServerToolStep = {
  id: string;
  kind: ServerToolStepKind;
  status: StepStatus;
  queries?: string[];
  pages?: AgentServerToolPage[];
  keywords?: AgentServerToolKeyword[];
  startedAt?: string;
  elapsedMs?: number;
  error?: string;
};

/**
 * Raw server-side search/browse step event persisted on assistant messages and streamed live.
 * Backwards-compatible with existing `search` / `open` / `done` rows while covering extended DeepSeek actions.
 */
export type AgentSearchStep =
  | { kind: "search"; callId: string; queries: string[]; status?: StepStatus; sources?: WebSearchItem[] }
  | { kind: "open" | "open_page"; callId: string; url: string; title?: string; siteIcon?: string; failed?: boolean; status?: StepStatus }
  | { kind: "find_in_page"; callId: string; url: string; pattern: string; found?: boolean; status?: StepStatus }
  | { kind: "read_link"; callId: string; url: string; title?: string; siteIcon?: string; failed?: boolean; status?: StepStatus }
  | { kind: "image_search" | "deep_image_search"; callId: string; queries: string[]; status?: StepStatus; sources?: WebSearchItem[] }
  | { kind: "done"; callId: string; sources: WebSearchItem[]; page?: WebSearchItem; found?: boolean; failed?: boolean };

/** MANGA function tool call step surfaced in the chat timeline (mapped to localized Chinese labels in UI). */
export type AgentToolStep = {
  id: string;
  name: string;
  status: StepStatus;
  startedAt?: string;
  elapsedMs?: number;
  summary?: string;
  error?: string;
};

/** Inline and drawer citation metadata for an assistant answer. */
export type AgentCitation = {
  index?: number;
  start?: number;
  end?: number;
  url: string;
  title: string;
  site?: string;
  siteIcon?: string;
  snippet?: string;
  publishedAt?: string;
};

/** Usage, token cache savings, server tool counts, and optional cost/latency summary for one run. */
export type AgentRunUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  searches?: number;
  fetches?: number;
  estimatedCost?: number;
  currency?: string;
  latencyMs?: number;
  pricesCheckedAt?: string;
};

export const AGENT_STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "tool_use",
  "refusal",
  "cancelled",
  "error",
] as const;
export type AgentStopReason = (typeof AGENT_STOP_REASONS)[number];

/** Structured error category used to render localized Chinese error messages and recovery actions in chat. */
export const AGENT_ERROR_CODES = [
  "auth",
  "balance",
  "rate_limit",
  "server",
  "network",
  "cancelled",
  "capability_missing",
  "refusal",
  "file_invalid",
  "context_overflow",
  "budget_exceeded",
  "plugin_disabled",
  "unknown",
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export type StreamNote = {
  kind: "note";
  id: string;
  at: string;
  title: string;
  /** The user's own text, without the quoted excerpt. */
  text: string;
  quote: string;
  tags: string[];
  revision: number;
  resourceId: string | null;
  resourceRevisionId: string | null;
  anchorId: string | null;
  locator: SourceLocator | null;
  /** Page number (1-based) when the locator names a comic page. */
  pageNumber: number | null;
};

export type StreamVoice = {
  kind: "voice";
  id: string;
  at: string;
  stage: string;
  audioState: string;
  playable: boolean;
  durationMs: number;
  text: string;
  segments: { total: number; done: number; failed: number; pending: number };
  /** Where each stretch of speech was said, for the source tags under the bubble. */
  sources: Array<{ startMs: number; locator: SourceLocator | null; resourceId: string | null }>;
  resourceId: string | null;
};

export type StreamUserAttachment = {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  bytes?: number;
};

export type StreamUser = {
  kind: "user";
  id: string;
  at: string;
  runId: string;
  text: string;
  quickTask: { id: string | null; name: string } | null;
  attachments?: StreamUserAttachment[];
};

export type StreamAgent = {
  kind: "agent";
  id: string;
  at: string;
  runId: string;
  status: string;
  text: string;
  error: { code: string; message: string; errorCode?: AgentErrorCode } | null;
  proposals?: ProposalCard[];
  /** The model's thinking, shown folded above the answer after completion; never in notes, materials or project packages. */
  reasoning?: string;
  reasoningStartedAt?: string;
  reasoningElapsedMs?: number;
  /** Raw server-side search/browse events. */
  search?: AgentSearchStep[];
  /** Aggregated server-side tool steps (search, open_page, find_in_page, read_link, image_search, deep_image_search). */
  serverToolSteps?: AgentServerToolStep[];
  /** MANGA function tool steps executed during this run. */
  toolSteps?: AgentToolStep[];
  /** Sources cited by this answer. */
  citations?: AgentCitation[];
  usage?: AgentRunUsage;
  modelId?: string;
  stopReason?: AgentStopReason;
  canContinue?: boolean;
  refusal?: boolean;
  generatedTitle?: string;
  errorCode?: AgentErrorCode;
  /** "联网搜索" needed thinking, so this run thought at the low level. */
  thinkingRaised?: boolean;
};

export type StreamItem = StreamNote | StreamVoice | StreamUser | StreamAgent;

/** Dedicated IPC channel and `manga:notice` topic for pushing live agent stream deltas to the renderer. */
export const AGENT_STREAM_CHANNEL = "manga:agent-stream" as const;
export const AGENT_STREAM_NOTICE_TOPIC = "agent.stream" as const;

export type AgentStreamEvent =
  | {
      kind: "start";
      sessionId: string;
      runId: string;
      modelId?: string;
      thinkingRaised?: boolean;
      at: string;
    }
  | {
      kind: "reasoning-delta";
      sessionId: string;
      runId: string;
      delta: string;
      reasoningStartedAt?: string;
      reasoningElapsedMs?: number;
    }
  | {
      kind: "text-delta";
      sessionId: string;
      runId: string;
      delta: string;
    }
  | {
      kind: "server-tool";
      sessionId: string;
      runId: string;
      event: AgentSearchStep;
      steps?: AgentServerToolStep[];
    }
  | {
      kind: "tool-step";
      sessionId: string;
      runId: string;
      step: AgentToolStep;
    }
  | {
      kind: "citations";
      sessionId: string;
      runId: string;
      citations: AgentCitation[];
    }
  | {
      kind: "title";
      sessionId: string;
      runId: string;
      title: string;
    }
  | {
      kind: "done";
      sessionId: string;
      runId: string;
      status: AgentRunStatus;
      stopReason?: AgentStopReason;
      canContinue?: boolean;
      refusal?: boolean;
      usage?: AgentRunUsage;
      citations?: AgentCitation[];
      generatedTitle?: string;
      reasoningElapsedMs?: number;
      errorCode?: AgentErrorCode;
      error?: { code: string; message: string; errorCode?: AgentErrorCode } | null;
    };

/** Return shape for `agent.continueRun`, `agent.regenerateRun`, and `agent.editAndResend`. */
export type AgentRunActionResult = {
  runId: string;
  sessionId: string;
  status: AgentRunStatus;
  inputText: string;
  previousRunId?: string;
};

/** IPC channels and payloads for HTTP and WebSocket streaming read-aloud TTS. */
export const SPEECH_IPC_CHANNELS = {
  speak: "manga:speak",
  speakStop: "manga:speak-stop",
  speechEvent: "manga:speech",
  streamStart: "manga:speech-stream-start",
  streamPush: "manga:speech-stream-push",
  streamFinish: "manga:speech-stream-finish",
  streamStop: "manga:speech-stream-stop",
} as const;

export type SpeechRequest = {
  text: string;
  voice?: SpeechVoice;
  connectionId?: string;
  task?: "read-aloud" | "novel" | "test";
  /** When true, prefers WebSocket streaming TTS when the active speech service supports it. */
  streaming?: boolean;
};

export type SpeechStreamStartRequest = {
  voice?: SpeechVoice;
  connectionId?: string;
  task?: "read-aloud" | "novel" | "test";
};

export type SpeechStreamPushRequest = {
  text: string;
};

export type SpeechEvent = {
  id: string;
  kind: "chunk" | "end" | "error";
  pcm?: Uint8Array;
  result?: {
    billedChars?: number;
    cached?: boolean;
    firstChunkMs?: number | null;
    bytes?: number;
    transport?: "http" | "ws";
  };
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
};
