import type {
  AgentCitation,
  AgentErrorCode,
  AgentRunStatus,
  AgentRunUsage,
  AgentSearchStep,
  AgentServerToolStep,
  AgentStopReason,
  AgentStreamEvent,
  AgentToolStep,
  WebSearchItem,
} from "@manga/contracts";

/**
 * In-memory live state of an agent run currently executing.
 * Updated immediately on every token/tool/search event while SQLite `live_text` writes are throttled.
 */
export type LiveRunExtras = {
  text: string;
  reasoning: string;
  reasoningStartedAt?: string;
  reasoningElapsedMs?: number;
  search: AgentSearchStep[];
  serverToolSteps: AgentServerToolStep[];
  toolSteps: AgentToolStep[];
  sources: WebSearchItem[];
  citations: AgentCitation[];
  generatedTitle?: string;
  usage?: AgentRunUsage;
  status: AgentRunStatus;
  stopReason?: AgentStopReason;
  errorCode?: AgentErrorCode;
  thinkingRaised?: boolean;
  modelId?: string;
  refusal?: boolean;
  canContinue?: boolean;
};

const live = new Map<string, LiveRunExtras>();

function createLiveEntry(init: Partial<LiveRunExtras> = {}): LiveRunExtras {
  return {
    text: "",
    reasoning: "",
    search: [],
    serverToolSteps: [],
    toolSteps: [],
    sources: [],
    citations: [],
    status: "running",
    ...init,
  };
}

/** Creates (or resets) the live in-memory state for a run. */
export function startLiveExtras(runId: string, init: Partial<LiveRunExtras> = {}): LiveRunExtras {
  const entry = createLiveEntry(init);
  live.set(runId, entry);
  return entry;
}

/**
 * Starts a new model step within an already-running agent run: clears step-local `reasoning`, `search`, and `serverToolSteps`
 * (since earlier steps were persisted to `agent_messages`) while preserving run-level fields (`modelId`, `thinkingRaised`,
 * `toolSteps`, `generatedTitle`, `usage`, `reasoningStartedAt`).
 */
export function beginLiveStep(runId: string, init: Partial<LiveRunExtras> = {}): LiveRunExtras {
  const existing = live.get(runId);
  if (!existing) return startLiveExtras(runId, init);
  existing.reasoning = "";
  existing.search = [];
  existing.serverToolSteps = [];
  if (init.text !== undefined) existing.text = init.text;
  if (init.modelId !== undefined) existing.modelId = init.modelId;
  if (init.thinkingRaised !== undefined) existing.thinkingRaised = init.thinkingRaised;
  if (init.status !== undefined) existing.status = init.status;
  return existing;
}

export const liveRunExtras = (runId: string): LiveRunExtras | undefined => live.get(runId);

export const endLiveExtras = (runId: string): void => {
  live.delete(runId);
};

export type AgentStreamCoalescer = {
  push(event: AgentStreamEvent): void;
  flush(runId?: string): void;
  dispose(): void;
};

type DeltaEvent = Extract<AgentStreamEvent, { kind: "text-delta" | "reasoning-delta" }>;

/**
 * Coalesces high-frequency `text-delta` and `reasoning-delta` events (~33ms) while forwarding structural
 * events (`start`, `server-tool`, `tool-step`, `citations`, `title`, `done`) immediately in causal order.
 */
export function createAgentStreamCoalescer(
  emit: (event: AgentStreamEvent) => void,
  intervalMs = 33,
): AgentStreamCoalescer {
  const pending = new Map<string, DeltaEvent>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flushRun = (runId: string) => {
    const buffered = pending.get(runId);
    if (!buffered) return;
    pending.delete(runId);
    emit(buffered);
  };

  const flushAll = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending.size) return;
    const entries = [...pending.values()];
    pending.clear();
    for (const event of entries) emit(event);
  };

  const schedule = () => {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      flushAll();
    }, intervalMs);
    timer.unref?.();
  };

  return {
    push(event) {
      if (disposed) return;
      if (event.kind === "text-delta" || event.kind === "reasoning-delta") {
        const existing = pending.get(event.runId);
        if (existing && existing.kind === event.kind) {
          if (existing.kind === "reasoning-delta" && event.kind === "reasoning-delta") {
            pending.set(event.runId, {
              ...existing,
              delta: existing.delta + event.delta,
              ...(event.reasoningStartedAt ? { reasoningStartedAt: event.reasoningStartedAt } : {}),
              ...(event.reasoningElapsedMs !== undefined ? { reasoningElapsedMs: event.reasoningElapsedMs } : {}),
            });
          } else {
            pending.set(event.runId, {
              ...existing,
              delta: existing.delta + event.delta,
            });
          }
          schedule();
          return;
        }
        if (existing) flushRun(event.runId);
        pending.set(event.runId, event);
        schedule();
        return;
      }
      // Structural events flush any pending delta for this run first so ordering is strictly preserved.
      flushRun(event.runId);
      emit(event);
    },
    flush(runId) {
      if (runId) flushRun(runId);
      else flushAll();
    },
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
    },
  };
}
