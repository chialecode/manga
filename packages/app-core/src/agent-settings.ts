import { AgentChatSettingsSchema, AgentLimitsSchema, AgentMediaSettingsSchema, AgentTraceSettingsSchema, DEFAULT_AGENT_CHAT_SETTINGS, DEFAULT_AGENT_LIMITS, DEFAULT_AGENT_MEDIA_SETTINGS, DEFAULT_AGENT_TRACE_SETTINGS, type AgentChatSettings, type AgentLimits, type AgentMediaSettings, type AgentTraceSettings } from "@manga/contracts/models";
import type { DrizzleStore } from "@manga/storage-drizzle";

/** The limits of an agent task and what is kept of its requests, as the person set them; a stored value that no longer fits is replaced by the default. */
export type AgentSettings = { limits: AgentLimits; trace: AgentTraceSettings; media: AgentMediaSettings; chat: AgentChatSettings };

const KEY = "settings.agent";

export function readAgentSettings(store: DrizzleStore): AgentSettings {
  const fallback: AgentSettings = { limits: { ...DEFAULT_AGENT_LIMITS }, trace: { ...DEFAULT_AGENT_TRACE_SETTINGS }, media: { ...DEFAULT_AGENT_MEDIA_SETTINGS }, chat: { ...DEFAULT_AGENT_CHAT_SETTINGS } };
  const raw = store.getMeta(KEY);
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as { limits?: unknown; trace?: unknown; media?: unknown; chat?: unknown };
    const limits = AgentLimitsSchema.safeParse({ ...DEFAULT_AGENT_LIMITS, ...(value.limits as object | undefined) });
    const trace = AgentTraceSettingsSchema.safeParse({ ...DEFAULT_AGENT_TRACE_SETTINGS, ...(value.trace as object | undefined) });
    const media = AgentMediaSettingsSchema.safeParse({ ...DEFAULT_AGENT_MEDIA_SETTINGS, ...(value.media as object | undefined) });
    const chat = AgentChatSettingsSchema.safeParse({ ...DEFAULT_AGENT_CHAT_SETTINGS, ...(value.chat as object | undefined) });
    return { limits: limits.success ? limits.data : fallback.limits, trace: trace.success ? trace.data : fallback.trace, media: media.success ? media.data : fallback.media, chat: chat.success ? chat.data : fallback.chat };
  } catch {
    return fallback;
  }
}

export function writeAgentSettings(store: DrizzleStore, patch: { limits?: Partial<AgentLimits>; trace?: Partial<AgentTraceSettings>; media?: Partial<AgentMediaSettings>; chat?: Partial<AgentChatSettings> }): AgentSettings {
  const current = readAgentSettings(store);
  // The input schema checked each field; the whole is checked again here so a partial patch cannot leave a pair that does not fit.
  const next: AgentSettings = {
    limits: AgentLimitsSchema.parse({ ...current.limits, ...(patch.limits ?? {}) }),
    trace: AgentTraceSettingsSchema.parse({ ...current.trace, ...(patch.trace ?? {}) }),
    media: AgentMediaSettingsSchema.parse({ ...current.media, ...(patch.media ?? {}) }),
    chat: AgentChatSettingsSchema.parse({ ...current.chat, ...(patch.chat ?? {}) }),
  };
  store.setMeta(KEY, JSON.stringify(next));
  return next;
}
