import type { ServerToolEvent } from "@manga/model-protocol";

/**
 * What a run under way has thought and searched so far in its current step, for the conversation to show while the answer is written (计划 4.3/4.4).
 * Held only in memory: once the step is over it is in the run's messages.
 */
const live = new Map<string, { reasoning: string; search: ServerToolEvent[] }>();

export function startLiveExtras(runId: string): { reasoning: string; search: ServerToolEvent[] } {
  const entry = { reasoning: "", search: [] as ServerToolEvent[] };
  live.set(runId, entry);
  return entry;
}
export const liveRunExtras = (runId: string) => live.get(runId);
export const endLiveExtras = (runId: string) => { live.delete(runId); };
