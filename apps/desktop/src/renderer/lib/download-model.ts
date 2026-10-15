import type { MessageKey } from "@manga/i18n";
import type { CommandError } from "./api.ts";
import { bytesLabel } from "./plugin-model.ts";

export { bytesLabel };

export type DownloadState = "metadata" | "choosing" | "downloading" | "verifying" | "publishing" | "importing" | "done" | "paused" | "failed" | "cancelled";
export type DownloadStage = "transfer" | "publish" | "import";
export type DownloadBudget = { maxBytes?: number; downKbps?: number; upKbps?: number };

export type DownloadEntry = {
  index: number;
  path: string;
  length: number;
  selected: boolean;
  verified: boolean;
  publishState: "none" | "verified" | "published" | "conflict";
  targetPath: string | null;
  importState: "pending" | "imported" | "skipped" | "failed";
  resourceId: string | null;
  note: string | null;
};

export type DownloadJob = {
  id: string;
  name: string;
  state: DownloadState;
  pausedReason: "user" | "engine" | null;
  stage: DownloadStage | null;
  error: { code: string; message: string } | null;
  infoHash: string | null;
  pathId: string;
  subdir: string;
  budget: DownloadBudget;
  totalBytes: number;
  selectedBytes: number;
  downloadedBytes: number;
  uploadedBytes: number;
  speeds: { down: number; up: number; peers: number };
  counts: { files: number; selected: number; published: number; imported: number; skipped: number; failed: number };
  seeding: { enabled: boolean; active: boolean; ratio: number; upKbps: number; possible: boolean };
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  entries?: DownloadEntry[];
};

export type DownloadEngine = { available: boolean; running: boolean; pluginId: string | null; reason: "no-plugin" | "not-running" | null };
export type DownloadList = { engine: DownloadEngine; jobs: DownloadJob[] };
export type LibraryPathOption = { id: string; path: string; mediaKind: string; reachable: boolean };

const ERROR_CODES = ["PATH_ESCAPE", "INVALID_SOURCE", "PIECE_VERIFY", "QUOTA_EXCEEDED", "DISK_FULL", "WRITE_DENIED", "LOCATION_UNAVAILABLE", "RESUME_INCOMPATIBLE", "STAGED_MISSING", "STAGED_CHANGED", "PUBLISH_CONFLICT", "COPY_MISMATCH", "PUBLISH_FAILED", "SCAN_FAILED", "IMPORT_FAILED", "ENGINE", "ENGINE_UNAVAILABLE"];
const REASONS = ["source", "duplicate", "subdir", "state", "index", "seed-impossible", "no-plugin", "not-running", "path-unreachable"];

/** The sentence for why a job stopped; the engine's own message is shown only where the sentence has a place for it. */
export function errorKey(code: string): MessageKey {
  return (ERROR_CODES.includes(code) ? `downloads.error.${code}` : "downloads.error.other") as MessageKey;
}

/** The sentence for why a command about a download was refused, from the reason the host gave or, failing that, the error's code. */
export function reasonKey(error: CommandError): MessageKey | null {
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  if (reason && REASONS.includes(reason)) return `downloads.reason.${reason}` as MessageKey;
  if (error.code === "QUOTA_EXCEEDED" || error.code === "DISK_FULL") return `downloads.reason.${error.code}` as MessageKey;
  return null;
}

/** What a job is doing, for the progress bar: the share of the chosen files that has arrived, or null when that is not known yet. */
export function progressOf(job: DownloadJob): number | null {
  if (job.state === "done") return 1;
  if (job.state === "publishing" || job.state === "importing") return 1;
  if (!job.selectedBytes) return null;
  return Math.max(0, Math.min(1, job.downloadedBytes / job.selectedBytes));
}

/** Jobs that are still going to change by themselves, newest first; the rest after them in the order the host gave. */
export function mergeJob(list: DownloadJob[], next: DownloadJob): DownloadJob[] {
  const at = list.findIndex((job) => job.id === next.id);
  if (at < 0) return [next, ...list];
  const copy = list.slice();
  // A notice carries the job without its files; what the page already knows about them stays until it asks again.
  copy[at] = { ...next, entries: next.entries ?? list[at]!.entries };
  return copy;
}

export const speedLabel = (bytesPerSecond: number): string => bytesLabel(Math.round(bytesPerSecond));

/** The last name of a folder, for showing a library path without writing where it is on the machine. */
export const folderName = (value: string): string => value.split(/[\\/]/).filter(Boolean).pop() ?? value;

/** Whether a file the person can still choose or change: before the transfer has finished. */
export const canChoose = (job: DownloadJob): boolean => job.state === "choosing" || job.state === "downloading";
