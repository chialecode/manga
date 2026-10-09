import { MangaError } from "@manga/contracts";
import type { ConnectionTestResult, ModelProfile } from "@manga/contracts/models";
import { joinApiPath, type TextRequest } from "@manga/model-protocol";

/** The result of the last test of a connection as it was stored; one that no longer reads is dropped rather than shown. */
export function parseLastTest(raw: string | null | undefined): ConnectionTestResult | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ConnectionTestResult;
    return value && typeof value === "object" && typeof value.ok === "boolean" && typeof value.at === "string" ? value : null;
  } catch {
    return null;
  }
}

type Failure = NonNullable<ConnectionTestResult["failure"]>;

/**
 * Why a request failed, in the words the person needs: the key was refused, the address is wrong (nothing there, or no such path), the model name is unknown,
 * the time ran out, the network broke, the service is busy, or the answer is not in the protocol. The detail is the system's own short text, never the body
 * the service sent.
 */
export function failureOf(error: unknown): Failure {
  if (!(error instanceof MangaError)) return { category: "other", detail: error instanceof Error ? error.message.slice(0, 160) : "unknown failure" };
  const details = (error.details ?? {}) as { status?: unknown; kind?: unknown };
  const status = typeof details.status === "number" ? details.status : undefined;
  const kind = typeof details.kind === "string" ? details.kind : undefined;
  const make = (category: Failure["category"], detail?: string): Failure => ({ category, ...(status !== undefined ? { status } : {}), ...(detail ? { detail } : {}) });
  if (error.code === "AUTHENTICATION_FAILED" || status === 401 || status === 403) return make("auth");
  if (error.code === "RATE_LIMITED" || status === 429) return make("rate_limit");
  if (kind === "model") return make("model");
  if (kind === "path") return make("address", "the path does not exist at this address");
  if (kind === "context") return make("other", "the service says the request is longer than the model takes");
  if (kind === "timeout") return make("timeout");
  if (kind === "address") return make("address");
  if (kind === "network" || kind === "tls") return make("network", error.message.slice(0, 160));
  if (kind === "protocol") return make("protocol", error.message.slice(0, 160));
  if (status !== undefined && status >= 500) return make("other", "the service reported an error of its own");
  return make("other", error.message.slice(0, 160));
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);

/** The first field of an entry that is a plain number, by the names services use for the model's window. */
const firstNumber = (entry: Record<string, unknown>, names: readonly string[]): number | undefined => {
  for (const name of names) {
    const found = num(entry[name]);
    if (found) return found;
  }
  return undefined;
};

/**
 * What the service says about a model's limits, when it says it: a few services list the window and the longest answer next to the model in `/models`, under
 * names that differ from one to the next. Most say nothing, which is an answer too. Any failure here is silent: this is a hint, not part of the test.
 */
export async function modelLimitsOf(baseUrl: string, apiKey: string, modelId: string, signal: AbortSignal, timeoutMs: number): Promise<{ contextWindow?: number; maxOutput?: number }> {
  try {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const response = await fetch(joinApiPath(baseUrl, "/models"), { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: combined });
    if (!response.ok) return {};
    if (/text\/html/i.test(response.headers.get("content-type") ?? "")) return {};
    const body = await response.json() as { data?: unknown };
    const list = Array.isArray(body.data) ? body.data : [];
    const entry = list.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && (item as { id?: unknown }).id === modelId);
    if (!entry) return {};
    const top = (entry.top_provider && typeof entry.top_provider === "object" ? entry.top_provider : {}) as Record<string, unknown>;
    const contextWindow = firstNumber(entry, ["context_length", "context_window", "max_context_length", "max_model_len", "max_input_tokens"]) ?? firstNumber(top, ["context_length"]);
    const maxOutput = firstNumber(entry, ["max_output_tokens", "max_completion_tokens", "max_tokens"]) ?? firstNumber(top, ["max_completion_tokens"]);
    return { ...(contextWindow ? { contextWindow } : {}), ...(maxOutput ? { maxOutput } : {}) };
  } catch {
    return {};
  }
}

/**
 * What the profile adds to a request. The longest answer is sent only when the person or a test set it: a default is a guess, and a service that takes less than
 * the guess refuses the request. The reasoning effort goes only to a model that reasons.
 */
export function requestLimits(profile: ModelProfile): Pick<TextRequest, "maxOutputTokens" | "maxTokensField" | "reasoningEffort" | "contextWindow"> {
  const reasons = profile.capabilities.includes("reasoning");
  return {
    ...(profile.source.maxOutput !== "default" ? { maxOutputTokens: profile.maxOutput } : {}),
    maxTokensField: reasons ? "max_completion_tokens" : "max_tokens",
    ...(reasons && profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    contextWindow: profile.contextWindow,
  };
}
