import type { JobStatus, AcquisitionPhase } from "./events.ts";

export type ArtifactRecord = {
  id: string;
  jobId: string;
  entryId: string;
  stagingPath?: string;
  targetPath?: string;
  bytes?: number;
  fingerprint?: string;
  etag?: string;
  publishState: "none" | "staged" | "verified" | "published" | "conflict";
};

export type ImportReceipt = {
  idempotencyKey: string;
  jobId: string;
  entryId: string;
  fingerprint: string;
  resourceId: string;
  resourceRevisionId: string;
};

export type AcquisitionJob = {
  id: string;
  status: JobStatus;
  phase: AcquisitionPhase;
  epoch: number;
  idempotencyKey: string;
  planId: string;
};
