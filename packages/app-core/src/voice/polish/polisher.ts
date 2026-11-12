import type { ChineseVariant, PolishMode, PolishPrompts } from "@manga/contracts";
import { MAX_POLISH_CANDIDATES, type RecalledCandidate } from "../correct/index.ts";
import type { LlmConnection } from "../ports.ts";
import {
  checkPolishSkip,
  type PolishFallbackReason,
  type PolishSkipReason,
  validatePolishOutput,
} from "./guards.ts";
import { convertChineseVariant } from "./opencc.ts";
import {
  buildPolishPrompts,
  POLISH_TEMPERATURE,
  POLISH_TIMEOUT_MS,
} from "./prompts.ts";

export type PolishLlmRequest = {
  system: string;
  user: string;
  temperature?: number;
  timeoutMs?: number;
  signal: AbortSignal;
};

export type PolishLlmConnection = LlmConnection & { timeoutMs?: number };

export interface PolishLlmClient {
  resolve(preferredId?: string | null): PolishLlmConnection | null;
  complete(connection: PolishLlmConnection, request: PolishLlmRequest): Promise<{ text: string }>;
}

export type PolishInput = {
  correctedText: string;
  mode: PolishMode;
  chineseVariant?: ChineseVariant;
  candidates?: ReadonlyArray<RecalledCandidate>;
  /** Active canonical dictionary terms (used for Guardrail 4 hallucination check & OpenCC protection). */
  dictionaryTerms?: ReadonlyArray<string>;
  customPrompts?: PolishPrompts | null;
  preferredConnectionId?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type PolishResult = {
  correctedText: string;
  polishedText: string;
  finalText: string;
  usedLlm: boolean;
  skippedReason: PolishSkipReason | null;
  fallbackReason: PolishFallbackReason | null;
  elapsedMs: number;
};

function createAbortError(): Error {
  const err = new Error("Dictation cancelled");
  err.name = "AbortError";
  return err;
}

function isUnsupportedTemperatureError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /temperature/i.test(msg);
}

export class DictationPolisher {
  private readonly llm: PolishLlmClient | null;

  constructor(options?: { llm?: PolishLlmClient | null }) {
    this.llm = options?.llm ?? null;
  }

  async polish(input: PolishInput): Promise<PolishResult> {
    const t0 = performance.now();
    if (input.signal?.aborted) {
      throw createAbortError();
    }

    const variant: ChineseVariant = input.chineseVariant ?? "simplified";
    const candidates = (input.candidates ?? []).slice(0, MAX_POLISH_CANDIDATES);
    const protectedTerms = input.dictionaryTerms ?? [];
    const connection =
      input.mode === "raw" || !this.llm
        ? null
        : this.llm.resolve(input.preferredConnectionId ?? null);

    const skipReason = checkPolishSkip({
      mode: input.mode,
      hasConnection: connection !== null,
      correctedText: input.correctedText,
      candidates,
    });

    if (skipReason !== null || !connection || !this.llm || input.mode === "raw") {
      const finalText = convertChineseVariant(input.correctedText, variant, protectedTerms);
      return {
        correctedText: input.correctedText,
        polishedText: input.correctedText,
        finalText,
        usedLlm: false,
        skippedReason: skipReason ?? "no_connection",
        fallbackReason: null,
        elapsedMs: performance.now() - t0,
      };
    }

    const { system, user } = buildPolishPrompts({
      mode: input.mode,
      correctedText: input.correctedText,
      candidates,
      customPrompts: input.customPrompts,
    });

    const connTimeout =
      typeof connection.timeoutMs === "number" && connection.timeoutMs > 0
        ? connection.timeoutMs
        : POLISH_TIMEOUT_MS;
    const timeoutMs = Math.min(
      input.timeoutMs ?? POLISH_TIMEOUT_MS,
      connTimeout,
      POLISH_TIMEOUT_MS,
    );

    const callController = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onCallerAbort = () => {
      callController.abort(input.signal?.reason ?? createAbortError());
    };
    if (input.signal) {
      input.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const err = new Error("POLISH_TIMEOUT");
        callController.abort(err);
        reject(err);
      }, timeoutMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        timer.unref();
      }
    });

    const llm = this.llm;
    let rawLlmText: string | null = null;
    let fallbackReason: PolishFallbackReason | null = null;

    try {
      const runComplete = async () => {
        try {
          return await llm.complete(connection, {
            system,
            user,
            temperature: POLISH_TEMPERATURE,
            timeoutMs,
            signal: callController.signal,
          });
        } catch (firstErr) {
          if (
            !timedOut &&
            !input.signal?.aborted &&
            !callController.signal.aborted &&
            isUnsupportedTemperatureError(firstErr)
          ) {
            return await llm.complete(connection, {
              system,
              user,
              temperature: undefined,
              timeoutMs,
              signal: callController.signal,
            });
          }
          throw firstErr;
        }
      };

      const response = await Promise.race([runComplete(), timeoutPromise]);
      rawLlmText = response.text;
    } catch (err) {
      if (input.signal?.aborted) {
        throw createAbortError();
      }
      fallbackReason = timedOut ? "timeout" : "llm_error";
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (input.signal) {
        input.signal.removeEventListener("abort", onCallerAbort);
      }
    }

    if (input.signal?.aborted) {
      throw createAbortError();
    }

    let polishedText = input.correctedText;
    if (fallbackReason === null && rawLlmText !== null) {
      const cleaned = rawLlmText.trim();
      const validationFailure = validatePolishOutput({
        correctedText: input.correctedText,
        polishedText: cleaned,
        candidates,
        dictionaryTerms: protectedTerms,
      });
      if (validationFailure !== null) {
        fallbackReason = validationFailure;
      } else {
        polishedText = cleaned;
      }
    }

    const finalText = convertChineseVariant(polishedText, variant, protectedTerms);
    return {
      correctedText: input.correctedText,
      polishedText,
      finalText,
      usedLlm: true,
      skippedReason: null,
      fallbackReason,
      elapsedMs: performance.now() - t0,
    };
  }
}
