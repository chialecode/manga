import type { CapturePositionEvent, SourceLocator } from "@manga/contracts";

export type CaptureSegment = {
  startOffsetMs: number;
  endOffsetMs: number;
  resourceId: string;
  resourceRevisionId: string;
  locator: SourceLocator;
  playbackRate: number;
  playing: boolean;
  clockDomainId: string;
};

export function captureOffsetFromSamples(samples: number, sampleRate: number): number {
  if (!(sampleRate > 0) || samples < 0) return 0;
  return (samples / sampleRate) * 1000;
}

export function mapCaptureToSources(events: CapturePositionEvent[]): CaptureSegment[] {
  const segments: CaptureSegment[] = [];
  let current: {
    startOffsetMs: number;
    resourceId: string;
    resourceRevisionId: string;
    locator: SourceLocator;
    playbackRate: number;
    playing: boolean;
    clockDomainId: string;
  } | undefined;
  const close = (endOffsetMs: number) => {
    if (!current || endOffsetMs <= current.startOffsetMs) return;
    segments.push({
      startOffsetMs: current.startOffsetMs,
      endOffsetMs,
      resourceId: current.resourceId,
      resourceRevisionId: current.resourceRevisionId,
      locator: current.locator,
      playbackRate: current.playbackRate,
      playing: current.playing,
      clockDomainId: current.clockDomainId,
    });
  };
  const open = (event: CapturePositionEvent) => {
    if (!event.resourceId || !event.resourceRevisionId || !event.locator) {
      current = undefined;
      return;
    }
    current = {
      startOffsetMs: event.captureOffsetMs,
      resourceId: event.resourceId,
      resourceRevisionId: event.resourceRevisionId,
      locator: event.locator,
      playbackRate: event.playbackRate ?? 1,
      playing: event.playing !== false,
      clockDomainId: event.clockDomainId,
    };
  };
  for (const event of events) {
    if (event.reason === "start" || event.reason === "speech_start" || event.reason === "resume") {
      close(event.captureOffsetMs);
      open(event);
      continue;
    }
    if (!current) {
      if (event.reason === "resource_change" || event.reason === "seek") open(event);
      continue;
    }
    if (event.reason === "pause") {
      close(event.captureOffsetMs);
      open({ ...event, playing: false, locator: event.locator ?? current.locator, resourceId: event.resourceId ?? current.resourceId, resourceRevisionId: event.resourceRevisionId ?? current.resourceRevisionId });
      continue;
    }
    if (event.reason === "rate_change") {
      close(event.captureOffsetMs);
      open({ ...event, locator: event.locator ?? current.locator, resourceId: event.resourceId ?? current.resourceId, resourceRevisionId: event.resourceRevisionId ?? current.resourceRevisionId, playing: current.playing });
      continue;
    }
    if (event.reason === "seek" || event.reason === "resource_change") {
      close(event.captureOffsetMs);
      open(event);
      continue;
    }
    if (event.reason === "stop") {
      close(event.captureOffsetMs);
      current = undefined;
    }
  }
  return segments;
}

export function mediaTimeAt(events: CapturePositionEvent[], captureOffsetMs: number): { mediaMs: number; resourceId?: string; interpolating: boolean } | undefined {
  const ordered = [...events].sort((a, b) => a.captureOffsetMs - b.captureOffsetMs);
  let last: CapturePositionEvent | undefined;
  for (const event of ordered) {
    if (event.captureOffsetMs > captureOffsetMs) break;
    last = event;
  }
  if (!last || last.reason === "stop" || last.locator?.kind !== "temporal") return undefined;
  if (last.playing === false || last.reason === "pause") {
    return { mediaMs: last.locator.startMs, resourceId: last.resourceId, interpolating: false };
  }
  const rate = last.playbackRate ?? 1;
  return {
    mediaMs: last.locator.startMs + (captureOffsetMs - last.captureOffsetMs) * rate,
    resourceId: last.resourceId,
    interpolating: true,
  };
}

export type AsrFixtureResponse = {
  delayMs: number;
  fail?: boolean;
  timeout?: boolean;
  text?: string;
};

export type AsrAttachment = {
  status: "ok" | "failed" | "timeout" | "cancelled";
  text?: string;
  resourceId: string;
  resourceRevisionId: string;
  locator?: unknown;
  captureOffsetMs: number;
  focusAtRequest: { resourceId: string; resourceRevisionId: string };
  focusAtArrival: { resourceId: string; resourceRevisionId: string };
  usedArrivalFocus: false;
};

export async function runAsrFixture(
  response: AsrFixtureResponse,
  signal: AbortSignal,
): Promise<{ status: "ok" | "failed" | "timeout" | "cancelled"; text?: string }> {
  if (signal.aborted) return { status: "cancelled" };
  await new Promise((resolve) => setTimeout(resolve, response.delayMs));
  if (signal.aborted) return { status: "cancelled" };
  if (response.timeout) return { status: "timeout" };
  if (response.fail) return { status: "failed" };
  return { status: "ok", text: response.text ?? "" };
}

export async function associateAsrResult(input: {
  response: AsrFixtureResponse;
  signal: AbortSignal;
  captureOffsetMs: number;
  requestFocus: { resourceId: string; resourceRevisionId: string; locator?: unknown };
  arrivalFocus: { resourceId: string; resourceRevisionId: string };
}): Promise<AsrAttachment> {
  const result = await runAsrFixture(input.response, input.signal);
  return {
    ...result,
    resourceId: input.requestFocus.resourceId,
    resourceRevisionId: input.requestFocus.resourceRevisionId,
    locator: input.requestFocus.locator,
    captureOffsetMs: input.captureOffsetMs,
    focusAtRequest: { resourceId: input.requestFocus.resourceId, resourceRevisionId: input.requestFocus.resourceRevisionId },
    focusAtArrival: input.arrivalFocus,
    usedArrivalFocus: false,
  };
}
