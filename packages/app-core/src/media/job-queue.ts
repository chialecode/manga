import { MangaError } from "@manga/contracts";
import { Lane } from "./process-runner.ts";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export type JobSnapshot = {
  id: string;
  lane: string;
  kind: string;
  key: string | null;
  owner: string | null;
  state: JobState;
  progress: number;
  error: { code: string; message: string } | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export type JobContext = {
  signal: AbortSignal;
  /** 0..1. Reports are throttled by the queue so a chatty tool cannot flood subscribers. */
  progress(fraction: number): void;
};

export type JobSubmit<T> = {
  lane: string;
  kind: string;
  /** Jobs with the same key are one job while it is active; a second submit returns the first. */
  key?: string;
  /** Who the work is for (a module id, a resource id, a capture id); used to cancel a whole group. */
  owner?: string;
  run: (context: JobContext) => Promise<T>;
};

type Record_ = JobSnapshot & { controller: AbortController; promise: Promise<unknown>; lastEmit: number };

/**
 * In-process background work with a fixed concurrency per lane, so transcoding, thumbnailing and voice filtering never
 * run unbounded and never block the main thread's own work. Jobs are not persisted: a restart loses the queue, and
 * whatever the job owned (a half-written copy, a staged chunk) is reconciled by its owner on the next start.
 */
export class JobQueue {
  private readonly lanes = new Map<string, Lane>();
  private readonly jobs = new Map<string, Record_>();
  private readonly byKey = new Map<string, string>();
  private readonly listeners = new Set<(job: JobSnapshot) => void>();
  private seq = 0;

  private readonly limits: Record<string, number>;
  private readonly retain: number;
  private readonly now: () => number;

  constructor(limits: Record<string, number> = { default: 2 }, retain = 200, now: () => number = () => Date.now()) {
    this.limits = limits;
    this.retain = retain;
    this.now = now;
  }

  private lane(name: string): Lane {
    let lane = this.lanes.get(name);
    if (!lane) {
      lane = new Lane(this.limits[name] ?? this.limits.default ?? 2);
      this.lanes.set(name, lane);
    }
    return lane;
  }

  onChange(listener: (job: JobSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(record: Record_): void {
    const snapshot = this.snapshot(record);
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* a subscriber must not break the queue */ }
    }
  }

  private snapshot(record: Record_): JobSnapshot {
    const { controller: _c, promise: _p, lastEmit: _l, ...rest } = record;
    return { ...rest, error: record.error ? { ...record.error } : null };
  }

  submit<T>(spec: JobSubmit<T>): { id: string; promise: Promise<T>; cancel: () => void } {
    if (spec.key) {
      const existing = this.byKey.get(spec.key);
      const record = existing ? this.jobs.get(existing) : undefined;
      if (record && (record.state === "queued" || record.state === "running")) {
        return { id: record.id, promise: record.promise as Promise<T>, cancel: () => record.controller.abort() };
      }
    }
    this.seq += 1;
    const id = `job-${this.seq}`;
    const controller = new AbortController();
    const record: Record_ = {
      id, lane: spec.lane, kind: spec.kind, key: spec.key ?? null, owner: spec.owner ?? null,
      state: "queued", progress: 0, error: null, startedAt: null, finishedAt: null,
      controller, promise: Promise.resolve(), lastEmit: 0,
    };
    this.jobs.set(id, record);
    if (spec.key) this.byKey.set(spec.key, id);
    const promise = this.lane(spec.lane).run(async () => {
      record.state = "running";
      record.startedAt = this.now();
      this.emit(record);
      // Background jobs that finish without waiting on anything would otherwise run one after another inside a single turn of the
      // event loop; thousands of them (the extras of a large scan) would hold the main process for seconds. One turn between jobs
      // lets input, IPC and timers through.
      // The job still starts when it was cancelled during that turn: its `run` sees the aborted signal and cleans up what it owns.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      return spec.run({
        signal: controller.signal,
        progress: (fraction) => {
          record.progress = Math.max(0, Math.min(1, fraction));
          const at = this.now();
          if (at - record.lastEmit >= 100 || record.progress >= 1) { record.lastEmit = at; this.emit(record); }
        },
      });
    }, controller.signal).then((value) => {
      record.state = controller.signal.aborted ? "cancelled" : "done";
      record.progress = record.state === "done" ? 1 : record.progress;
      return value;
    }, (error: unknown) => {
      const cancelled = controller.signal.aborted || (error instanceof MangaError && error.code === "CANCELLED");
      record.state = cancelled ? "cancelled" : "failed";
      record.error = error instanceof MangaError
        ? { code: error.code, message: error.message }
        : { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
      throw error;
    }).finally(() => {
      record.finishedAt = this.now();
      this.emit(record);
      if (record.key && this.byKey.get(record.key) === id) this.byKey.delete(record.key);
      this.prune();
    });
    // The caller decides whether to await; an ignored failure must not become an unhandled rejection.
    promise.catch(() => undefined);
    record.promise = promise;
    return { id, promise, cancel: () => controller.abort() };
  }

  get(id: string): JobSnapshot | undefined {
    const record = this.jobs.get(id);
    return record ? this.snapshot(record) : undefined;
  }

  list(filter: { owner?: string; kind?: string; active?: boolean } = {}): JobSnapshot[] {
    return [...this.jobs.values()]
      .filter((record) => (filter.owner === undefined || record.owner === filter.owner)
        && (filter.kind === undefined || record.kind === filter.kind)
        && (!filter.active || record.state === "queued" || record.state === "running"))
      .map((record) => this.snapshot(record));
  }

  cancel(id: string): boolean {
    const record = this.jobs.get(id);
    if (!record || (record.state !== "queued" && record.state !== "running")) return false;
    record.controller.abort();
    return true;
  }

  cancelWhere(predicate: (job: JobSnapshot) => boolean): number {
    let count = 0;
    for (const record of this.jobs.values()) {
      if ((record.state === "queued" || record.state === "running") && predicate(this.snapshot(record))) {
        record.controller.abort();
        count += 1;
      }
    }
    return count;
  }

  /** Resolves when every job that is active right now has finished, whatever the outcome. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()].filter((record) => record.state === "queued" || record.state === "running").map((record) => record.promise));
  }

  laneStats(): Record<string, { running: number; queued: number; limit: number }> {
    return Object.fromEntries([...this.lanes].map(([name, lane]) => [name, { running: lane.running, queued: lane.queued, limit: lane.limit }]));
  }

  private prune(): void {
    if (this.jobs.size <= this.retain) return;
    for (const [id, record] of this.jobs) {
      if (this.jobs.size <= this.retain) break;
      if (record.state === "done" || record.state === "failed" || record.state === "cancelled") this.jobs.delete(id);
    }
  }
}
