import type { SourceLocator } from "./location.ts";

export type CapturePositionEvent = {
  captureOffsetMs: number;
  clockDomainId: string;
  resourceId?: string;
  resourceRevisionId?: string;
  locator?: SourceLocator;
  playing?: boolean;
  playbackRate?: number;
  reason:
    | "start"
    | "speech_start"
    | "sample"
    | "seek"
    | "pause"
    | "resume"
    | "rate_change"
    | "resource_change"
    | "stop";
};

export type CaptureClock = {
  domainId: string;
  startedAtMs: number;
  sampleRate: number;
};
