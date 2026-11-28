import { z } from "zod";
import { OCR_PURPOSES, PROVIDER_SERVICE_KINDS } from "./provider.ts";

const id = z.string().min(1).max(256);

/**
 * What a model can be given besides text. Audio is transcribed first. A model that takes PDF is given a whole PDF the person put into the task as the file,
 * and one that takes video a clip of the stretch asked about, when the conditions of 计划 4.5 hold; otherwise the text and frame pictures go as before.
 */
export const MODEL_INPUT_TYPES = ["text", "image", "video", "pdf", "audio"] as const;
export type ModelInputType = (typeof MODEL_INPUT_TYPES)[number];

/** What a model can do. Tool calls are what the agent works by; the rest are used when the model has them. */
export const MODEL_CAPABILITIES = ["tools", "structured_output", "web_search", "reasoning"] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** How hard a reasoning model thinks. Chat Completions takes it as `reasoning_effort`, Responses as `reasoning.effort`; a model without the reasoning capability is not sent it. */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Which HTTP shape a transcription connection speaks: multipart `/audio/transcriptions` or `/chat/completions` with `input_audio`. */
export const TRANSCRIPTION_INTERFACES = ["audio_transcriptions", "chat_input_audio", "deepseek_asr"] as const;

/** How a chat service differs from plain Chat Completions (计划 4.3); see `TextRequest.dialect`. */
export const MODEL_DIALECTS = ["deepseek"] as const;
export type ModelDialect = (typeof MODEL_DIALECTS)[number];
export type TranscriptionInterface = (typeof TRANSCRIPTION_INTERFACES)[number];

/** Where a number of the profile came from: left at the default, typed by the person, or read from the service by a test. */
export type ProfileSource = "default" | "user" | "detected";

/** How large a file and a video clip a model is given at most (计划 4.5). Saved with the profile; a profile saved before this has the defaults. */
export const ModelLimitsSchema = z.object({
  /** A whole file (a PDF), in bytes: 1 MiB to 50 MiB, the most one request may carry. */
  fileBytes: z.number().int().min(1024 * 1024).max(50 * 1024 * 1024),
  /** A video clip, in bytes: 1 MiB to 20 MiB (base64 makes it a third larger in the request). */
  videoBytes: z.number().int().min(1024 * 1024).max(20 * 1024 * 1024),
  /** A video clip, in seconds: 5 to 600. */
  videoSeconds: z.number().int().min(5).max(600),
}).strict();
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;
export const DEFAULT_MODEL_LIMITS: ModelLimits = { fileBytes: 20 * 1024 * 1024, videoBytes: 5 * 1024 * 1024, videoSeconds: 60 };

export const ModelProfileSchema = z.object({
  /** Tokens the model can take in one request, the input and the answer together. */
  contextWindow: z.number().int().min(4_096).max(10_000_000),
  /** Most tokens the model answers with in one request. */
  maxOutput: z.number().int().min(256).max(1_000_000),
  inputTypes: z.array(z.enum(MODEL_INPUT_TYPES)).min(1).max(MODEL_INPUT_TYPES.length),
  capabilities: z.array(z.enum(MODEL_CAPABILITIES)).max(MODEL_CAPABILITIES.length),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
  transcriptionInterface: z.enum(TRANSCRIPTION_INTERFACES).default("audio_transcriptions"),
  /** The dialect of the service, from the provider's catalogue (or the address, for DeepSeek added by hand). */
  dialect: z.enum(MODEL_DIALECTS).optional(),
  /**
   * The reasoning levels the model declares, from the provider's catalogue: the settings show only these (`max` only where it is declared), and when the
   * list is there "off" (`reasoningEffort: null`) means thinking is switched off rather than not mentioned.
   */
  reasoningLevels: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length).optional(),
  source: z.object({
    contextWindow: z.enum(["default", "user", "detected"]),
    maxOutput: z.enum(["default", "user", "detected"]),
  }).strict(),
  limits: ModelLimitsSchema.default(DEFAULT_MODEL_LIMITS),
}).strict().refine((profile) => profile.maxOutput < profile.contextWindow, { message: "the answer cannot be as long as the whole window", path: ["maxOutput"] });
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/** Conservative until the person says otherwise or a test finds out: a 128k window, 8k of answer, text in, tool calls. */
export const DEFAULT_MODEL_PROFILE: ModelProfile = {
  contextWindow: 128_000,
  maxOutput: 8_192,
  inputTypes: ["text"],
  capabilities: ["tools"],
  reasoningEffort: null,
  transcriptionInterface: "audio_transcriptions",
  source: { contextWindow: "default", maxOutput: "default" },
  limits: { ...DEFAULT_MODEL_LIMITS },
};

/** What a person may set. Anything left out keeps its value; text is always an input. */
export const ModelProfilePatchSchema = z.object({
  contextWindow: ModelProfileSchema.shape.contextWindow.optional(),
  maxOutput: ModelProfileSchema.shape.maxOutput.optional(),
  inputTypes: z.array(z.enum(MODEL_INPUT_TYPES)).max(MODEL_INPUT_TYPES.length).optional(),
  capabilities: ModelProfileSchema.shape.capabilities.optional(),
  reasoningEffort: ModelProfileSchema.shape.reasoningEffort.optional(),
  transcriptionInterface: z.enum(TRANSCRIPTION_INTERFACES).optional(),
  limits: ModelLimitsSchema.partial().optional(),
}).strict();

/** What a detection from a provider's catalogue or model list may also set; a person never sets these. */
export type ProviderProfilePatch = ModelProfilePatch & { dialect?: ModelDialect; reasoningLevels?: ModelProfile["reasoningLevels"] };
export type ModelProfilePatch = z.infer<typeof ModelProfilePatchSchema>;

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** Apply a patch (from the person) or a detection (from a test) to a profile, keeping it valid; a number that would not fit the other is refused by the caller's validation. */
export function applyProfile(base: ModelProfile, patch: ProviderProfilePatch, source: "user" | "detected"): ModelProfile {
  const next: ModelProfile = {
    ...base,
    ...(patch.contextWindow !== undefined ? { contextWindow: patch.contextWindow } : {}),
    ...(patch.maxOutput !== undefined ? { maxOutput: patch.maxOutput } : {}),
    ...(patch.inputTypes !== undefined ? { inputTypes: unique(["text" as const, ...patch.inputTypes]) } : {}),
    ...(patch.capabilities !== undefined ? { capabilities: unique(patch.capabilities) } : {}),
    ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
    ...(patch.transcriptionInterface !== undefined ? { transcriptionInterface: patch.transcriptionInterface } : {}),
    ...(patch.dialect !== undefined ? { dialect: patch.dialect } : {}),
    ...(patch.reasoningLevels !== undefined ? { reasoningLevels: patch.reasoningLevels } : {}),
    limits: { ...DEFAULT_MODEL_LIMITS, ...base.limits, ...(patch.limits ?? {}) },
    source: {
      contextWindow: patch.contextWindow !== undefined ? source : base.source.contextWindow,
      maxOutput: patch.maxOutput !== undefined ? source : base.source.maxOutput,
    },
  };
  return next;
}

/** A profile whose numbers came from a test of another model: what was detected goes back to the default, what the person typed stays (clamped so `maxOutput < contextWindow` always holds). */
export function forgetDetected(profile: ModelProfile): ModelProfile {
  const resetWindow = profile.source.contextWindow === "detected";
  const resetMax = profile.source.maxOutput === "detected";
  const contextWindow = resetWindow ? DEFAULT_MODEL_PROFILE.contextWindow : profile.contextWindow;
  let maxOutput = resetMax ? DEFAULT_MODEL_PROFILE.maxOutput : profile.maxOutput;
  let maxSource = resetMax ? ("default" as const) : profile.source.maxOutput;
  if (maxOutput >= contextWindow) {
    maxOutput = Math.max(256, Math.min(DEFAULT_MODEL_PROFILE.maxOutput, Math.floor(contextWindow / 2)));
    maxSource = "default";
  }
  return {
    ...profile,
    contextWindow,
    maxOutput,
    source: {
      contextWindow: resetWindow ? "default" : profile.source.contextWindow,
      maxOutput: maxSource,
    },
  };
}

/**
 * The profile a connection works with: what was saved, or, for a connection saved before profiles existed, the default plus what its tests had verified.
 * A stored value that no longer fits the schema is ignored rather than trusted.
 */
export function effectiveProfile(stored: string | null | undefined, verified: readonly string[] = []): ModelProfile {
  if (stored) {
    try {
      const parsed = ModelProfileSchema.safeParse(JSON.parse(stored));
      if (parsed.success) return parsed.data;
    } catch { /* fall through to the default */ }
  }
  return {
    ...DEFAULT_MODEL_PROFILE,
    inputTypes: verified.includes("vision") ? ["text", "image"] : [...DEFAULT_MODEL_PROFILE.inputTypes],
    capabilities: unique([...DEFAULT_MODEL_PROFILE.capabilities]),
    limits: { ...DEFAULT_MODEL_LIMITS },
  };
}

/** Why a test of a connection failed, in the words the person needs to fix it. */
export const CONNECTION_FAILURES = ["auth", "address", "model", "timeout", "network", "rate_limit", "protocol", "billing", "busy", "provider", "other"] as const;
export type ConnectionFailure = (typeof CONNECTION_FAILURES)[number];

export type ConnectionTestResult = {
  at: string;
  ok: boolean;
  /** How long the first answer took, in milliseconds. */
  latencyMs: number;
  /** The first words of the model's reply to the test question. */
  reply?: string;
  /** What the test found the model can do: `streaming`, `tools`, `vision`; a capability that failed to show is simply not listed. */
  capabilities?: string[];
  /** What the service said about its own limits, when it did. */
  detected?: { contextWindow?: number; maxOutput?: number };
  /** For a provider service (speech, recognition, search, fetch, OCR): what the test got back. */
  service?: { kind: (typeof PROVIDER_SERVICE_KINDS)[number]; detail: string };
  failure?: { category: ConnectionFailure; status?: number; detail?: string };
};

/** Limits of one agent task; the agent stops with a reason when either is reached. */
export const AgentLimitsSchema = z.object({
  maxSteps: z.number().int().min(1).max(64),
  maxDurationMs: z.number().int().min(30_000).max(30 * 60_000),
}).strict();
export type AgentLimits = z.infer<typeof AgentLimitsSchema>;
export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxSteps: 24, maxDurationMs: 10 * 60_000 };

/**
 * How long the pictures and clips frozen for a task are kept after the task has ended (计划 4.4, Q-36): 1 to 365 days, or for ever (`null`). After that a
 * retry takes them again from their source.
 */
export const AgentMediaSettingsSchema = z.object({
  retentionDays: z.number().int().min(1).max(365).nullable(),
}).strict();
export type AgentMediaSettings = z.infer<typeof AgentMediaSettingsSchema>;
export const DEFAULT_AGENT_MEDIA_SETTINGS: AgentMediaSettings = { retentionDays: 30 };

/**
 * What the conversations talk with, chosen on the conversation page (A-137): the text connection (null: the first one; a project with its own model uses
 * that), how hard it thinks (`off`, one of the model's levels, or null for what its settings say) and the window a task may fill (null: the model's whole
 * window; less than it also keeps the answer to a quarter of it). A choice the model cannot take is ignored for it.
 */
export const AgentChatSettingsSchema = z.object({
  connectionId: z.string().min(1).max(256).nullable(),
  reasoningEffort: z.enum([...REASONING_EFFORTS, "off"]).nullable(),
  contextWindow: z.number().int().min(16_384).max(10_000_000).nullable(),
}).strict();
export type AgentChatSettings = z.infer<typeof AgentChatSettingsSchema>;
export const DEFAULT_AGENT_CHAT_SETTINGS: AgentChatSettings = { connectionId: null, reasoningEffort: null, contextWindow: null };

/** What is kept of every request the agent makes (A-83, Q-29): the whole of it, or only its sizes and timing. */
export const AgentTraceSettingsSchema = z.object({
  mode: z.enum(["full", "metadata"]),
  retentionDays: z.number().int().min(1).max(365),
  maxMegabytes: z.number().int().min(10).max(5_000),
}).strict();
export type AgentTraceSettings = z.infer<typeof AgentTraceSettingsSchema>;
export const DEFAULT_AGENT_TRACE_SETTINGS: AgentTraceSettings = { mode: "full", retentionDays: 30, maxMegabytes: 500 };

/** The most the record of one tool call or one model request keeps of a part, before it is cut and marked as cut. */
export const TRACE_PART_LIMIT_BYTES = 256 * 1024;

export const TRACE_KINDS = ["model", "tool", "compaction"] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

const providerRef = z.string().min(3).max(200).regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\/[a-z0-9][a-z0-9._-]*$/);
const SERVICE_KINDS = PROVIDER_SERVICE_KINDS;

export const ModelInputs = {
  /** The providers the enabled provider plugins offer, with their catalogues, and the accounts already set up for each (计划 4.2). */
  "providers.list": z.object({}).strict(),
  /** Reads the models an account can use (`GET /models`), with a new key (a handle the page stashed) or an existing account's. */
  "providers.discover": z.object({ providerRef, accountId: id.optional(), credentialHandle: id.optional() }).strict(),
  /** Creates the account (or uses one) and the chosen connections in one step. `verified` is false when the list could not be read and the catalogue was used. */
  "providers.add": z.object({
    providerRef,
    accountId: id.optional(),
    credentialHandle: id.optional(),
    label: z.string().trim().min(1).max(80).optional(),
    models: z.array(z.string().min(1).max(128)).max(32),
    services: z.array(z.enum(SERVICE_KINDS)).max(SERVICE_KINDS.length),
    verified: z.boolean().default(true),
  }).strict(),
  /** Changes the key of an account; every connection of the account uses the new one. */
  "providers.setKey": z.object({ accountId: id, credentialHandle: id }).strict(),
  /** Removes an account with its key; only when no connection uses it any more. */
  "providers.deleteAccount": z.object({ accountId: id }).strict(),
  /** Reads balance and availability for an account (or all balance-capable accounts) from providers declaring `balance`. */
  "providers.balance": z.object({
    accountId: id.optional(),
    providerRef: providerRef.optional(),
  }).strict(),
  /** Main-process single source of truth for active chat and provider capabilities. */
  "providers.capabilities": z.object({
    projectId: id.nullable().optional(),
    connectionId: id.nullable().optional(),
  }).strict(),
  /** Recognizes text or layout from an image or PDF using a configured OCR service (e.g. `deepseek-ocr@1`). */
  "ocr.recognize": z.object({
    pathHandle: id.optional(),
    resourceId: id.optional(),
    resourceRevisionId: id.optional(),
    pageId: id.optional(),
    purpose: z.enum(OCR_PURPOSES).default("text_recognition"),
    connectionId: id.optional(),
  }).strict().refine((value) => Boolean(value.pathHandle) !== Boolean(value.resourceId), {
    message: "provide either a path handle or a library resource",
  }),
  /** Set the numbers and switches of a connection's model; anything left out keeps its value. */
  "connections.setProfile": z.object({ connectionId: id, profile: ModelProfilePatchSchema }).strict(),
  /** Ask a connection one question and look at what it can do; the result is kept with the connection. */
  "connections.probe": z.object({ connectionId: id }).strict(),
  "settings.getAgent": z.object({}).strict(),
  "settings.setAgent": z.object({
    limits: AgentLimitsSchema.partial().optional(),
    trace: AgentTraceSettingsSchema.partial().optional(),
    media: AgentMediaSettingsSchema.partial().optional(),
    chat: AgentChatSettingsSchema.partial().optional(),
  }).strict(),
  /** The requests, tool calls and compactions of one run, in order, without their contents. */
  "agent.trace.list": z.object({ runId: id }).strict(),
  /** One part of one entry, a page at a time: the context and parameters sent (`request`) or what came back (`response`). */
  "agent.trace.get": z.object({
    entryId: id,
    part: z.enum(["request", "response"]),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(64 * 1024).default(16 * 1024),
  }).strict(),
  /** A run's whole trace as one JSON text, redacted the same way, to copy. */
  "agent.trace.export": z.object({ runId: id }).strict(),
  "agent.trace.stats": z.object({}).strict(),
  /** Remove every entry now. */
  "agent.trace.clear": z.object({}).strict(),
};
