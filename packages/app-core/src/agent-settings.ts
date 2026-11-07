import { AgentLimitsSchema, AgentTraceSettingsSchema, DEFAULT_AGENT_LIMITS, DEFAULT_AGENT_TRACE_SETTINGS, type AgentLimits, type AgentTraceSettings } from "@manga/contracts/models";
import type { DrizzleStore } from "@manga/storage-drizzle";

/** The limits of an agent task and what is kept of its requests, as the person set them; a stored value that no longer fits is replaced by the default. */
export type AgentSettings = { limits: AgentLimits; trace: AgentTraceSettings };

const KEY = "settings.agent";

export function readAgentSettings(store: DrizzleStore): AgentSettings {
  const fallback: AgentSettings = { limits: { ...DEFAULT_AGENT_LIMITS }, trace: { ...DEFAULT_AGENT_TRACE_SETTINGS } };
  const raw = store.getMeta(KEY);
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as { limits?: unknown; trace?: unknown };
    const limits = AgentLimitsSchema.safeParse({ ...DEFAULT_AGENT_LIMITS, ...(value.limits as object | undefined) });
    const trace = AgentTraceSettingsSchema.safeParse({ ...DEFAULT_AGENT_TRACE_SETTINGS, ...(value.trace as object | undefined) });
    return { limits: limits.success ? limits.data : fallback.limits, trace: trace.success ? trace.data : fallback.trace };
  } catch {
    return fallback;
  }
}

export function writeAgentSettings(store: DrizzleStore, patch: { limits?: Partial<AgentLimits>; trace?: Partial<AgentTraceSettings> }): AgentSettings {
  const current = readAgentSettings(store);
  // The input schema checked each field; the whole is checked again here so a partial patch cannot leave a pair that does not fit.
  const next: AgentSettings = {
    limits: AgentLimitsSchema.parse({ ...current.limits, ...(patch.limits ?? {}) }),
    trace: AgentTraceSettingsSchema.parse({ ...current.trace, ...(patch.trace ?? {}) }),
  };
  store.setMeta(KEY, JSON.stringify(next));
  return next;
}
