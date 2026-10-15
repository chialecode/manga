/**
 * Acquisition (ACQ-01—03): a plan to fetch something from a source, through an engine a plugin provides, into a folder the person already
 * authorized as a library path; and what the job goes through on the way. The states are the ones the person sees.
 */

/** What a job is doing. `choosing` waits for the person to pick files once the torrent's file list is known. */
export const ACQUISITION_STATES = ["metadata", "choosing", "downloading", "verifying", "publishing", "importing", "done", "paused", "failed", "cancelled"] as const;
export type AcquisitionState = (typeof ACQUISITION_STATES)[number];

/** The states a job ends in; nothing happens to a job in one of them until the person acts. */
export const ACQUISITION_TERMINAL: readonly AcquisitionState[] = ["done", "failed", "cancelled"];

/** Why a paused job is paused: the person paused it, or the engine went away (the plugin was turned off, removed or ended). */
export const ACQUISITION_PAUSE_REASONS = ["user", "engine"] as const;
export type AcquisitionPauseReason = (typeof ACQUISITION_PAUSE_REASONS)[number];

/** Where a failed job stopped, so the right retry is offered: the transfer, the publishing of its files, or the import. */
export const ACQUISITION_STAGES = ["transfer", "publish", "import"] as const;
export type AcquisitionStage = (typeof ACQUISITION_STAGES)[number];

export const ACQUISITION_PUBLISH_STATES = ["none", "verified", "published", "conflict"] as const;
export type AcquisitionPublishState = (typeof ACQUISITION_PUBLISH_STATES)[number];
export const ACQUISITION_IMPORT_STATES = ["pending", "imported", "skipped", "failed"] as const;
export type AcquisitionImportState = (typeof ACQUISITION_IMPORT_STATES)[number];

/** What the person set aside for a job: the most it may take in, the speeds it may use. 0 or absent means no limit. */
export type AcquisitionBudget = { maxBytes?: number; downKbps?: number; upKbps?: number };

/** What an import leaves for each file: which resource it became, so a retry finds it again instead of adding another. */
export type ImportReceipt = {
  idempotencyKey: string;
  jobId: string;
  entryId: number;
  fingerprint: string;
  resourceId: string;
  resourceRevisionId: string;
};
