import { z } from "zod";

const id = z.string().min(1).max(256);

/** What a model can be given besides text. Audio is transcribed first and video goes as frame pictures; both are listed so the person can say what the model takes. */
export const MODEL_INPUT_TYPES = ["text", "image", "video", "pdf", "audio"] as const;
export type ModelInputType = (typeof MODEL_INPUT_TYPES)[number];

/** What a model can do. Tool calls are what the agent works by; the rest are used when the model has them. */
export const MODEL_CAPABILITIES = ["tools", "structured_output", "web_search", "reasoning"] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** How hard a reasoning model thinks. Chat Completions takes it as `reasoning_effort`, Responses as `reasoning.effort`; a model without the reasoning capability is not sent it. */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Where a number of the profile came from: left at the default, typed by the person, or read from the service by a test. */
export type ProfileSource = "default" | "user" | "detected";

export const ModelProfileSchema = z.object({
  /** Tokens the model can take in one request, the input and the answer together. */
  contextWindow: z.number().int().min(4_096).max(10_000_000),
  /** Most tokens the model answers with in one request. */
  maxOutput: z.number().int().min(256).max(1_000_000),
  inputTypes: z.array(z.enum(MODEL_INPUT_TYPES)).min(1).max(MODEL_INPUT_TYPES.length),
  capabilities: z.array(z.enum(MODEL_CAPABILITIES)).max(MODEL_CAPABILITIES.length),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
  source: z.object({
    contextWindow: z.enum(["default", "user", "detected"]),
    maxOutput: z.enum(["default", "user", "detected"]),
  }).strict(),
}).strict().refine((profile) => profile.maxOutput < profile.contextWindow, { message: "the answer cannot be as long as the whole window", path: ["maxOutput"] });
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/** Conservative until the person says otherwise or a test finds out: a 128k window, 8k of answer, text in, tool calls. */
export const DEFAULT_MODEL_PROFILE: ModelProfile = {
  contextWindow: 128_000,
  maxOutput: 8_192,
  inputTypes: ["text"],
  capabilities: ["tools"],
  reasoningEffort: null,
  source: { contextWindow: "default", maxOutput: "default" },
};

/** What a person may set. Anything left out keeps its value; text is always an input. */
export const ModelProfilePatchSchema = z.object({
  contextWindow: ModelProfileSchema.shape.contextWindow.optional(),
  maxOutput: ModelProfileSchema.shape.maxOutput.optional(),
  inputTypes: z.array(z.enum(MODEL_INPUT_TYPES)).max(MODEL_INPUT_TYPES.length).optional(),
  capabilities: ModelProfileSchema.shape.capabilities.optional(),
  reasoningEffort: ModelProfileSchema.shape.reasoningEffort.optional(),
}).strict();
export type ModelProfilePatch = z.infer<typeof ModelProfilePatchSchema>;

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** Apply a patch (from the person) or a detection (from a test) to a profile, keeping it valid; a number that would not fit the other is refused by the caller's validation. */
export function applyProfile(base: ModelProfile, patch: ModelProfilePatch, source: "user" | "detected"): ModelProfile {
  const next: ModelProfile = {
    ...base,
    ...(patch.contextWindow !== undefined ? { contextWindow: patch.contextWindow } : {}),
    ...(patch.maxOutput !== undefined ? { maxOutput: patch.maxOutput } : {}),
    ...(patch.inputTypes !== undefined ? { inputTypes: unique(["text" as const, ...patch.inputTypes]) } : {}),
    ...(patch.capabilities !== undefined ? { capabilities: unique(patch.capabilities) } : {}),
    ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
    source: {
      contextWindow: patch.contextWindow !== undefined ? source : base.source.contextWindow,
      maxOutput: patch.maxOutput !== undefined ? source : base.source.maxOutput,
    },
  };
  return next;
}

/** A profile whose numbers came from a test of another model: what was detected goes back to the default, what the person typed stays. */
export function forgetDetected(profile: ModelProfile): ModelProfile {
  const own = (field: "contextWindow" | "maxOutput") => profile.source[field] === "detected";
  return {
    ...profile,
    contextWindow: own("contextWindow") ? DEFAULT_MODEL_PROFILE.contextWindow : profile.contextWindow,
    maxOutput: own("maxOutput") ? DEFAULT_MODEL_PROFILE.maxOutput : profile.maxOutput,
    source: { contextWindow: own("contextWindow") ? "default" : profile.source.contextWindow, maxOutput: own("maxOutput") ? "default" : profile.source.maxOutput },
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
  };
}

/** Why a test of a connection failed, in the words the person needs to fix it. */
export const CONNECTION_FAILURES = ["auth", "address", "model", "timeout", "network", "rate_limit", "protocol", "other"] as const;
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
  failure?: { category: ConnectionFailure; status?: number; detail?: string };
};

/** Limits of one agent task; the agent stops with a reason when either is reached. */
export const AgentLimitsSchema = z.object({
  maxSteps: z.number().int().min(1).max(64),
  maxDurationMs: z.number().int().min(30_000).max(30 * 60_000),
}).strict();
export type AgentLimits = z.infer<typeof AgentLimitsSchema>;
export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxSteps: 24, maxDurationMs: 10 * 60_000 };

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

export const ModelInputs = {
  /** Set the numbers and switches of a connection's model; anything left out keeps its value. */
  "connections.setProfile": z.object({ connectionId: id, profile: ModelProfilePatchSchema }).strict(),
  /** Ask a connection one question and look at what it can do; the result is kept with the connection. */
  "connections.probe": z.object({ connectionId: id }).strict(),
  "settings.getAgent": z.object({}).strict(),
  "settings.setAgent": z.object({
    limits: AgentLimitsSchema.partial().optional(),
    trace: AgentTraceSettingsSchema.partial().optional(),
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
