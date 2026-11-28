import type { AgentErrorCode, StreamAgent } from "@manga/contracts";
import type { MessageKey, Translator } from "@manga/i18n";

type T = Translator["t"];

export type LocalizedChatError = {
  code: AgentErrorCode;
  message: string;
  action?: "settings" | "retry";
};

const KNOWN_CODES = new Set<AgentErrorCode>([
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
]);

/** Infers a structured `AgentErrorCode` from explicit contract fields, backend error codes, or raw provider messages. */
export function classifyChatError(item: Pick<StreamAgent, "error" | "errorCode" | "status" | "stopReason" | "refusal">): AgentErrorCode | null {
  const explicit = item.errorCode ?? item.error?.errorCode;
  if (explicit && KNOWN_CODES.has(explicit)) return explicit;
  if (item.refusal || item.stopReason === "refusal") return "refusal";
  const err = item.error;
  if (!err) {
    if (item.status === "cancelled" || item.stopReason === "cancelled") return "cancelled";
    return null;
  }
  const code = err.code.toUpperCase();
  const msg = err.message.toLowerCase();
  if (code === "MODEL_CAPABILITY_MISSING") return "capability_missing";
  if (code === "AUTHENTICATION_FAILED" || code === "UNAUTHORIZED" || /\b401\b|\b403\b|invalid[_\s-]?api[_\s-]?key|unauthorized|auth/.test(msg)) return "auth";
  if (code === "QUOTA_EXCEEDED" || code === "INSUFFICIENT_BALANCE" || /\b402\b|insufficient[\s_-]?balance|billing|quota/.test(msg)) return "balance";
  if (code === "RATE_LIMITED" || /\b429\b|rate[\s_-]?limit|too many requests/.test(msg)) return "rate_limit";
  if (code === "PLUGIN_DISABLED" || /plugin[_\s-]?disabled/.test(msg)) return "plugin_disabled";
  if (code === "CANCELLED" || code === "ABORTED" || /cancel|abort/.test(msg)) return "cancelled";
  if (code === "BUDGET_EXCEEDED" || /budget|max[_\s-]?steps|max[_\s-]?duration/.test(msg)) return "budget_exceeded";
  if (code === "CONTEXT_OVERFLOW" || /context[\s_-]?(length|window|limit)|maximum context|too many tokens/.test(msg)) return "context_overflow";
  if (code === "FILE_INVALID" || /unsupported[\s_-]?(file|media)|file[\s_-]?too[\s_-]?large/.test(msg)) return "file_invalid";
  if (code === "REFUSAL" || /refusal|content[\s_-]?filter|safety/.test(msg)) return "refusal";
  if (code === "NETWORK_ERROR" || code === "TIMEOUT" || /econn|enotfound|etimedout|fetch failed|network|timeout|socket/.test(msg)) return "network";
  if (code === "UPSTREAM_ERROR" || /\b5\d\d\b|server error|overloaded|bad gateway|service unavailable/.test(msg)) return "server";
  return "unknown";
}

/** Maps a chat run failure into calm, actionable Chinese UI copy without leaking raw English stack/HTTP text. */
export function localizeChatError(
  t: T,
  item: Pick<StreamAgent, "error" | "errorCode" | "status" | "stopReason" | "refusal">,
): LocalizedChatError | null {
  const code = classifyChatError(item);
  if (!code) return null;
  if (code === "capability_missing" && item.error?.code === "MODEL_CAPABILITY_MISSING" && item.error.message) {
    return {
      code,
      message: t("rp.missingVision", { reason: item.error.message }),
      action: "settings",
    };
  }
  const message = t(`chat.error.${code}` as MessageKey);
  const action: LocalizedChatError["action"] =
    code === "auth" || code === "balance" || code === "plugin_disabled" || code === "capability_missing"
      ? "settings"
      : code === "rate_limit" || code === "server" || code === "network" || code === "unknown"
        ? "retry"
        : undefined;
  return { code, message, action };
}
