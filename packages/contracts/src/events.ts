export type DomainEvent = {
  eventId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type JobStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AcquisitionPhase =
  | "resolving"
  | "transferring"
  | "verifying"
  | "publishing"
  | "importing";
