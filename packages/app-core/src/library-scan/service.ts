import fs from "node:fs";
import path from "node:path";
import { MangaError, createId } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { planScan, SCAN_LIMITS, type ScanGroup, type ScanKind, type ScanUnit, type WalkEntry } from "./plan.ts";
import { WalkerClient } from "./walker.ts";

/** What the scan needs from the application: reading one unit into the library, and the few things around it. */
export type ScanHost = {
  importUnit(request: { kind: ScanKind; rootAbs: string; groupAbs: string; unit: ScanUnit; group: ScanGroup; workId?: string; index: number }, signal: AbortSignal): Promise<{ resourceId: string; revisionId: string; workId: string; duplicate: boolean; replaced: boolean }>;
  /** Called once per scan with the resources it added, for the cover and file-metadata work that follows. */
  afterImport(resourceIds: string[]): void;
  moduleEnabled(kind: ScanKind): boolean;
  assertWritable(): void;
  notify(topic: string, payload: Record<string, unknown>): void;
};

export type ScanSchedule = { onStartup: boolean; intervalMinutes: 0 | 30 | 60 | 360 | 1440 };
export const DEFAULT_SCAN_SCHEDULE: ScanSchedule = { onStartup: true, intervalMinutes: 60 };
export const SCAN_INTERVALS = [0, 30, 60, 360, 1440] as const;

export type ScanStage = "queued" | "discover" | "compare" | "fingerprint" | "import" | "covers" | "finish";
export type ScanStatus = "queued" | "running" | "done" | "cancelled" | "failed" | "interrupted";
export type ScanTrigger = "manual" | "startup" | "schedule" | "add";

export type ScanJob = {
  id: string;
  pathId: string;
  path: string;
  mediaKind: ScanKind;
  trigger: ScanTrigger;
  status: ScanStatus;
  stage: ScanStage;
  processed: number;
  total: number;
  current: string | null;
  added: number;
  changed: number;
  moved: number;
  unavailable: number;
  failed: number;
  skipped: number;
  /** Folders the scan could not open (no permission, removed while it ran). */
  unreadable: number;
  truncated: boolean;
  error: { code: string; message: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type LibraryPath = {
  id: string;
  path: string;
  mediaKind: ScanKind;
  autoScan: boolean;
  createdAt: string;
  lastScanAt: string | null;
  lastScan: Pick<ScanJob, "status" | "added" | "changed" | "moved" | "unavailable" | "failed" | "skipped" | "unreadable" | "truncated" | "error"> | null;
  files: { present: number; unavailable: number; failed: number };
  reachable: boolean;
};

type PathRow = { id: string; path: string; media_kind: ScanKind; auto_scan: number; created_at: string; last_scan_at: string | null; last_scan_json: string | null };
type FileRow = { relative_path: string; size: number; mtime_ms: number; fingerprint: string | null; resource_id: string | null; resource_revision_id: string | null; state: string };

const SETTINGS_KEY = "settings.scan";
const PROGRESS_MS = 200;
const KEY_BATCH = 200;
const likeEscape = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const within = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export type ScanServiceOptions = { store: DrizzleStore; host: ScanHost; now?: () => number; tickMs?: number; startupDelayMs?: number };

/**
 * Library paths and the background scan (A-50). A scan lists a path in a worker thread, compares the listing with the file
 * register, and reads only what is new or changed; files that vanished are marked unavailable, never deleted. Nothing here
 * touches the network. One scan runs at a time; others wait their turn.
 */
export class ScanService {
  private readonly store: DrizzleStore;
  private readonly host: ScanHost;
  private readonly now: () => number;
  private readonly walker = new WalkerClient();
  private readonly queue: Array<{ job: ScanJob; abort: AbortController }> = [];
  private active: { job: ScanJob; abort: AbortController } | null = null;
  private idle: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickStart: number;
  private lastNotify = 0;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private readonly tickMs: number;
  private readonly startupDelayMs: number;
  private disposed = false;

  constructor(options: ScanServiceOptions) {
    this.store = options.store;
    this.host = options.host;
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 60_000;
    this.startupDelayMs = options.startupDelayMs ?? 4000;
    this.lastTickStart = this.now();
    // No scan survives a process boundary: whatever the database still calls running was cut off.
    this.store.sqlite.prepare("UPDATE scan_jobs SET status = 'interrupted', finished_at = ? WHERE status IN ('queued','running')").run(new Date().toISOString());
  }

  // ------------------------------------------------------------------ settings and schedule

  schedule(): ScanSchedule {
    const raw = this.store.getMeta(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SCAN_SCHEDULE };
    try {
      const value = JSON.parse(raw) as Partial<ScanSchedule>;
      const interval = SCAN_INTERVALS.includes(value.intervalMinutes as never) ? (value.intervalMinutes as ScanSchedule["intervalMinutes"]) : DEFAULT_SCAN_SCHEDULE.intervalMinutes;
      return { onStartup: value.onStartup !== false, intervalMinutes: interval };
    } catch {
      return { ...DEFAULT_SCAN_SCHEDULE };
    }
  }

  setSchedule(next: ScanSchedule): ScanSchedule {
    if (!SCAN_INTERVALS.includes(next.intervalMinutes)) throw new MangaError("VALIDATION_ERROR", "the scan interval is not one of the offered choices");
    this.store.setMeta(SETTINGS_KEY, JSON.stringify(next));
    return this.schedule();
  }

  /** Start the timers: one scan shortly after launch (when the user wants it) and one every interval. Called by the desktop host, not by tests that do not ask for it. */
  startScheduler(): void {
    if (this.timer || this.disposed) return;
    this.lastTickStart = this.now();
    if (this.schedule().onStartup) {
      this.startupTimer = setTimeout(() => { this.startupTimer = null; void this.startAuto("startup").catch(() => undefined); }, this.startupDelayMs);
      this.startupTimer.unref?.();
    }
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  /** One timer tick. After a sleep the timer fires once, and the scan it starts moves `lastTickStart`, so waking never produces a burst of scans. */
  tick(): void {
    const interval = this.schedule().intervalMinutes;
    if (!interval || this.active || this.queue.length) return;
    if (this.now() - this.lastTickStart < interval * 60_000) return;
    void this.startAuto("schedule").catch(() => undefined);
  }

  private async startAuto(trigger: "startup" | "schedule"): Promise<void> {
    this.lastTickStart = this.now();
    const rows = this.store.sqlite.prepare("SELECT id FROM library_paths WHERE auto_scan = 1 ORDER BY created_at").all() as Array<{ id: string }>;
    for (const row of rows) this.enqueue(row.id, trigger);
  }

  // ------------------------------------------------------------------ paths

  private rowOf(pathId: string): PathRow {
    const row = this.store.sqlite.prepare("SELECT * FROM library_paths WHERE id = ?").get(pathId) as PathRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "that library path does not exist");
    return row;
  }

  async listPaths(): Promise<LibraryPath[]> {
    const rows = this.store.sqlite.prepare("SELECT * FROM library_paths ORDER BY created_at, id").all() as PathRow[];
    const counts = this.store.sqlite.prepare("SELECT path_id AS pathId, state, COUNT(*) AS n FROM library_files GROUP BY path_id, state").all() as Array<{ pathId: string; state: string; n: number }>;
    const out: LibraryPath[] = [];
    for (const row of rows) {
      let reachable = true;
      try { reachable = (await fs.promises.stat(row.path)).isDirectory(); } catch { reachable = false; }
      const count = (state: string) => counts.find((item) => item.pathId === row.id && item.state === state)?.n ?? 0;
      out.push({
        id: row.id, path: row.path, mediaKind: row.media_kind, autoScan: row.auto_scan === 1, createdAt: row.created_at, lastScanAt: row.last_scan_at,
        lastScan: row.last_scan_json ? JSON.parse(row.last_scan_json) as LibraryPath["lastScan"] : null,
        files: { present: count("present"), unavailable: count("unavailable"), failed: count("failed") },
        reachable,
      });
    }
    return out;
  }

  async addPath(input: { path: string; mediaKind: ScanKind; autoScan?: boolean }): Promise<LibraryPath> {
    this.host.assertWritable();
    if (!path.isAbsolute(input.path)) throw new MangaError("VALIDATION_ERROR", "a library path must be an absolute folder path");
    const abs = path.resolve(input.path);
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(abs); } catch { throw new MangaError("NOT_FOUND", "the folder is not available", { details: { reason: "missing" } }); }
    if (!stat.isDirectory()) throw new MangaError("VALIDATION_ERROR", "a library path must be a folder", { details: { reason: "not-a-folder" } });
    for (const row of this.store.sqlite.prepare("SELECT id, path FROM library_paths").all() as Array<{ id: string; path: string }>) {
      if (samePath(row.path, abs)) throw new MangaError("VALIDATION_ERROR", "that folder is already a library path", { details: { reason: "duplicate", pathId: row.id } });
      if (within(row.path, abs) || within(abs, row.path)) throw new MangaError("VALIDATION_ERROR", "that folder overlaps a library path that already exists", { details: { reason: "overlap", pathId: row.id } });
    }
    const id = createId("lpath");
    this.store.commit({
      mutations: [{ sql: "INSERT INTO library_paths(id, path, media_kind, auto_scan, created_at) VALUES (?,?,?,?,?)", params: [id, abs, input.mediaKind, input.autoScan === false ? 0 : 1, new Date().toISOString()] }],
      events: [{ type: "library.pathAdded", payload: { pathId: id, mediaKind: input.mediaKind } }],
    });
    return (await this.listPaths()).find((item) => item.id === id)!;
  }

  async updatePath(pathId: string, input: { mediaKind?: ScanKind; autoScan?: boolean }): Promise<LibraryPath> {
    this.host.assertWritable();
    const row = this.rowOf(pathId);
    if (input.mediaKind && input.mediaKind !== row.media_kind && this.store.sqlite.prepare("SELECT 1 FROM library_files WHERE path_id = ? LIMIT 1").get(pathId)) {
      throw new MangaError("VALIDATION_ERROR", "the kind of a path that has been scanned cannot change; remove the path and add it again", { details: { reason: "kind-locked" } });
    }
    this.store.commit({
      mutations: [{ sql: "UPDATE library_paths SET media_kind = ?, auto_scan = ? WHERE id = ?", params: [input.mediaKind ?? row.media_kind, input.autoScan === undefined ? row.auto_scan : input.autoScan ? 1 : 0, pathId] }],
      events: [{ type: "library.pathChanged", payload: { pathId } }],
    });
    return (await this.listPaths()).find((item) => item.id === pathId)!;
  }

  /** Stops scanning a path. Works, progress and records stay: only the register of what the path held is forgotten. */
  async removePath(pathId: string): Promise<{ pathId: string }> {
    this.host.assertWritable();
    this.rowOf(pathId);
    this.cancel({ pathId });
    await this.idle;
    this.store.commit({
      mutations: [
        { sql: "DELETE FROM library_files WHERE path_id = ?", params: [pathId] },
        { sql: "DELETE FROM library_paths WHERE id = ?", params: [pathId] },
      ],
      events: [{ type: "library.pathRemoved", payload: { pathId } }],
    });
    return { pathId };
  }

  // ------------------------------------------------------------------ queue

  private emptyJob(row: PathRow, trigger: ScanTrigger): ScanJob {
    return {
      id: createId("scan"), pathId: row.id, path: row.path, mediaKind: row.media_kind, trigger, status: "queued", stage: "queued", processed: 0, total: 0, current: null,
      added: 0, changed: 0, moved: 0, unavailable: 0, failed: 0, skipped: 0, unreadable: 0, truncated: false, error: null, startedAt: null, finishedAt: null,
    };
  }

  /** Queue a scan of one path. A path that is already queued or being scanned returns that scan instead of starting another. */
  enqueue(pathId: string, trigger: ScanTrigger): ScanJob {
    this.host.assertWritable();
    const row = this.rowOf(pathId);
    const existing = this.active?.job.pathId === pathId ? this.active : this.queue.find((item) => item.job.pathId === pathId);
    if (existing) return existing.job;
    const job = this.emptyJob(row, trigger);
    this.store.sqlite.prepare("INSERT INTO scan_jobs(id, path_id, trigger_kind, status, stage, started_at) VALUES (?,?,?,?,?,?)").run(job.id, job.pathId, trigger, "queued", "queued", new Date().toISOString());
    this.queue.push({ job, abort: new AbortController() });
    this.publish(job, true);
    this.pump();
    return job;
  }

  /** Scan one path, or every path. */
  start(input: { pathId?: string; trigger?: ScanTrigger } = {}): ScanJob[] {
    const trigger = input.trigger ?? "manual";
    const ids = input.pathId ? [input.pathId] : (this.store.sqlite.prepare("SELECT id FROM library_paths ORDER BY created_at, id").all() as Array<{ id: string }>).map((row) => row.id);
    return ids.map((id) => this.enqueue(id, trigger));
  }

  /** Stop a scan (or every scan, or those of one path). What was committed before the stop stays. */
  cancel(input: { jobId?: string; pathId?: string } = {}): { cancelled: number } {
    let cancelled = 0;
    const matches = (job: ScanJob) => (!input.jobId || job.id === input.jobId) && (!input.pathId || job.pathId === input.pathId);
    for (const item of [...this.queue]) {
      if (!matches(item.job)) continue;
      this.queue.splice(this.queue.indexOf(item), 1);
      this.finish(item.job, "cancelled");
      cancelled += 1;
    }
    if (this.active && matches(this.active.job)) { this.active.abort.abort(); cancelled += 1; }
    return { cancelled };
  }

  /** What a status line or the settings page shows: the running scan, those waiting, and the last few that finished. */
  status(): { running: ScanJob | null; queued: ScanJob[]; recent: ScanJob[]; schedule: ScanSchedule } {
    const rows = this.store.sqlite.prepare("SELECT j.*, p.path AS path_text, p.media_kind AS kind FROM scan_jobs j LEFT JOIN library_paths p ON p.id = j.path_id WHERE j.status NOT IN ('queued','running') ORDER BY j.started_at DESC, j.rowid DESC LIMIT 8").all() as Array<Record<string, unknown>>;
    return {
      running: this.active?.job ?? null,
      queued: this.queue.map((item) => item.job),
      recent: rows.map((row) => ({
        id: String(row.id), pathId: String(row.path_id ?? ""), path: String(row.path_text ?? ""), mediaKind: (row.kind as ScanKind) ?? "novel", trigger: row.trigger_kind as ScanTrigger, status: row.status as ScanStatus, stage: row.stage as ScanStage,
        processed: Number(row.processed), total: Number(row.total), current: (row.current_item as string | null) ?? null, added: Number(row.added), changed: Number(row.changed), moved: 0,
        unavailable: Number(row.unavailable), failed: Number(row.failed), skipped: Number(row.skipped), unreadable: 0, truncated: false,
        error: row.error_json ? JSON.parse(String(row.error_json)) as ScanJob["error"] : null, startedAt: (row.started_at as string | null) ?? null, finishedAt: (row.finished_at as string | null) ?? null,
      })),
      schedule: this.schedule(),
    };
  }

  /** Resolves when no scan is running or waiting; for tests and for shutting down. */
  async whenIdle(): Promise<void> {
    while (this.active || this.queue.length) await this.idle.catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.trailing) clearTimeout(this.trailing);
    this.timer = this.startupTimer = this.trailing = null;
    for (const item of this.queue.splice(0)) this.finish(item.job, "cancelled");
    this.active?.abort.abort();
    this.walker.dispose();
  }

  private pump(): void {
    if (this.active || this.disposed) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.idle = this.run(next.job, next.abort.signal).catch(() => undefined).finally(() => {
      this.active = null;
      this.pump();
    });
  }

  // ------------------------------------------------------------------ progress

  /** Progress goes to the interface at most about every 200 ms, with the last state always delivered. */
  private publish(job: ScanJob, force = false): void {
    const send = () => {
      this.lastNotify = this.now();
      this.host.notify("scan.progress", { job });
    };
    if (force || this.now() - this.lastNotify >= PROGRESS_MS) {
      if (this.trailing) { clearTimeout(this.trailing); this.trailing = null; }
      send();
      return;
    }
    if (!this.trailing) {
      this.trailing = setTimeout(() => { this.trailing = null; send(); }, PROGRESS_MS);
      this.trailing.unref?.();
    }
  }

  private stage(job: ScanJob, stage: ScanStage): void {
    job.stage = stage;
    job.current = null;
    this.store.sqlite.prepare("UPDATE scan_jobs SET stage = ?, status = ? WHERE id = ?").run(stage, job.status, job.id);
    this.publish(job, true);
  }

  private finish(job: ScanJob, status: ScanStatus, error?: { code: string; message: string }): void {
    job.status = status;
    job.stage = "finish";
    job.current = null;
    job.error = error ?? null;
    job.finishedAt = new Date().toISOString();
    this.store.sqlite.prepare("UPDATE scan_jobs SET status = ?, stage = ?, processed = ?, total = ?, current_item = NULL, added = ?, changed = ?, unavailable = ?, failed = ?, skipped = ?, error_json = ?, finished_at = ? WHERE id = ?")
      .run(status, "finish", job.processed, job.total, job.added, job.changed, job.unavailable, job.failed, job.skipped, error ? JSON.stringify(error) : null, job.finishedAt, job.id);
    const summary = { status, added: job.added, changed: job.changed, moved: job.moved, unavailable: job.unavailable, failed: job.failed, skipped: job.skipped, unreadable: job.unreadable, truncated: job.truncated, error: job.error };
    // A scan cancelled while it was still waiting never looked at the path, so it does not replace the last real result.
    if (job.startedAt) this.store.sqlite.prepare("UPDATE library_paths SET last_scan_at = ?, last_scan_json = ? WHERE id = ?").run(job.finishedAt, JSON.stringify(summary), job.pathId);
    this.publish(job, true);
    this.host.notify("scan.finished", { job });
    if (job.added || job.changed || job.unavailable || job.moved) this.host.notify("work.updated", { reason: "scan", pathId: job.pathId });
  }

  // ------------------------------------------------------------------ the scan itself

  private async run(job: ScanJob, signal: AbortSignal): Promise<void> {
    const row = this.store.sqlite.prepare("SELECT * FROM library_paths WHERE id = ?").get(job.pathId) as PathRow | undefined;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.store.sqlite.prepare("UPDATE scan_jobs SET status = 'running', started_at = ? WHERE id = ?").run(job.startedAt, job.id);
    if (!row) return this.finish(job, "failed", { code: "NOT_FOUND", message: "the library path was removed" });
    if (!this.host.moduleEnabled(row.media_kind)) return this.finish(job, "failed", { code: "CAPABILITY_UNAVAILABLE", message: `the module that reads ${row.media_kind} files is turned off` });
    const rootName = path.basename(row.path) || row.path;
    try {
      // 1. List the folder in the worker. The main thread only collects the batches.
      this.stage(job, "discover");
      const entries: WalkEntry[] = [];
      let files = 0;
      const walk = await this.walker.list(row.path, {
        maxDepth: SCAN_LIMITS.maxDepth, maxEntries: 1_000_000, signal,
        onBatch: (batch) => {
          for (const entry of batch) entries.push(entry);
          files += batch.filter((entry) => entry.t === "f").length;
          job.processed = files;
          job.current = batch.at(-1)?.p ?? null;
          this.publish(job);
        },
      });
      job.unreadable = walk.failed.length;
      job.truncated = walk.truncated;
      if (signal.aborted || walk.cancelled) return this.finish(job, "cancelled");

      // 2. Compare with the register: unchanged units are skipped without reading them.
      this.stage(job, "compare");
      const plan = planScan(row.media_kind, entries, rootName);
      job.truncated ||= plan.truncated;
      const registered = new Map((this.store.sqlite.prepare("SELECT relative_path, size, mtime_ms, fingerprint, resource_id, resource_revision_id, state FROM library_files WHERE path_id = ?").all(row.id) as FileRow[]).map((file) => [file.relative_path, file]));
      const todo: Array<{ unit: ScanUnit; group: ScanGroup; index: number; known: FileRow | undefined }> = [];
      const unchanged: string[] = [];
      for (const group of plan.groups) {
        group.units.forEach((unit, index) => {
          const known = registered.get(unit.rel);
          if (known && known.resource_id && known.size === unit.size && known.mtime_ms === unit.mtime && (known.state !== "failed" || job.trigger !== "manual")) unchanged.push(unit.rel);
          else todo.push({ unit, group, index, known });
        });
      }
      this.markSeen(row.id, job.id, unchanged, registered);
      const currentRels = new Set<string>();
      for (const group of plan.groups) for (const unit of group.units) currentRels.add(unit.rel);
      const gone = this.moveCandidates(row, currentRels);
      job.skipped = unchanged.length;
      job.total = todo.length;
      job.processed = 0;
      this.publish(job, true);

      // 3. Quick identities (in the worker) tell a moved file from a new one.
      this.stage(job, "fingerprint");
      const keys = await this.quickKeys(row, todo, signal);
      if (signal.aborted) return this.finish(job, "cancelled");

      // 4. Read the new and changed units, one at a time, writing each as its own small transaction.
      this.stage(job, "import");
      const added: string[] = [];
      const rootAbs = row.path;
      const workOfGroup = new Map<string, string | undefined>();
      for (const item of todo) {
        if (signal.aborted) break;
        const { unit, group, index, known } = item;
        job.current = unit.rel;
        const key = keys.get(unit.rel) ?? unit.sig ?? null;
        try {
          if (!known && key && this.relink(row, unit, key, job, gone)) { job.processed += 1; this.publish(job); await yieldToLoop(); continue; }
          let workId = workOfGroup.get(group.key);
          if (workId === undefined && !workOfGroup.has(group.key)) { workId = this.workOfGroup(row.id, group); workOfGroup.set(group.key, workId); }
          this.host.assertWritable();
          const outcome = await this.host.importUnit({ kind: row.media_kind, rootAbs, groupAbs: group.folder ? path.join(rootAbs, group.key) : rootAbs, unit, group, workId, index }, signal);
          workOfGroup.set(group.key, outcome.workId);
          this.register(row.id, unit, key, outcome, job.id, "present", null);
          if (outcome.duplicate) job.skipped += 1;
          else if (known || outcome.replaced) job.changed += 1;
          else { job.added += 1; added.push(outcome.resourceId); }
        } catch (error) {
          if (signal.aborted || (error instanceof MangaError && error.code === "CANCELLED")) break;
          job.failed += 1;
          const known2 = error instanceof MangaError ? { code: error.code, message: error.message } : { code: "UNSUPPORTED_FORMAT", message: error instanceof Error ? error.message : String(error) };
          this.register(row.id, unit, key, null, job.id, "failed", known2);
        }
        job.processed += 1;
        this.publish(job);
        await yieldToLoop();
      }
      if (signal.aborted) return this.finish(job, "cancelled");

      // 5. What is no longer there is marked, not deleted. Folders that could not be opened do not count as gone.
      const failedDirs = walk.failed.map((item) => item.p);
      job.unavailable = this.markUnavailable(row, job.id, failedDirs, walk.truncated || plan.truncated);
      this.stage(job, "covers");
      if (added.length) this.host.afterImport(added);
      this.finish(job, "done");
    } catch (error) {
      if (signal.aborted) return this.finish(job, "cancelled");
      const known = error instanceof MangaError ? { code: error.code, message: error.message } : { code: "INTERRUPTED", message: error instanceof Error ? error.message : String(error) };
      this.finish(job, "failed", known);
    }
  }

  private markSeen(pathId: string, jobId: string, rels: string[], registered: Map<string, FileRow>): void {
    if (!rels.length) return;
    const seen = this.store.sqlite.prepare("UPDATE library_files SET seen_scan_id = ?, state = 'present', error_json = NULL WHERE path_id = ? AND relative_path = ?");
    const restore = this.store.sqlite.prepare("UPDATE file_locations SET available = 1 WHERE resource_revision_id = ? AND available = 0");
    this.store.sqlite.transaction(() => {
      for (const rel of rels) {
        seen.run(jobId, pathId, rel);
        const known = registered.get(rel);
        // A file that was marked unavailable and is back at the same path with the same size and time is simply available again.
        if (known?.state === "unavailable" && known.resource_revision_id) restore.run(known.resource_revision_id);
      }
    })();
  }

  /** Quick identities for new single files, computed by the worker; only files that might be a moved one need it, but computing it also gives every file its register key. */
  private async quickKeys(row: PathRow, todo: Array<{ unit: ScanUnit }>, signal: AbortSignal): Promise<Map<string, string>> {
    const files = todo.filter((item) => item.unit.type !== "image-dir").map((item) => ({ p: item.unit.rel, abs: path.join(row.path, item.unit.rel), size: item.unit.size }));
    const out = new Map<string, string>();
    for (let at = 0; at < files.length; at += KEY_BATCH) {
      if (signal.aborted) break;
      const part = await this.walker.keys(files.slice(at, at + KEY_BATCH), signal);
      for (const [rel, key] of part) out.set(rel, key);
    }
    return out;
  }

  /**
   * Files the register knows that this scan did not see where they were: those of this path missing from the listing, and those an earlier scan of
   * any path of the same kind already found missing. A new file with the same content as one of them is that file, moved.
   */
  private moveCandidates(row: PathRow, currentRels: Set<string>): Map<string, Array<{ pathId: string; rel: string; revisionId: string | null }>> {
    const rows = this.store.sqlite.prepare(`SELECT lf.path_id AS pathId, lf.relative_path AS rel, lf.fingerprint AS key, lf.resource_revision_id AS revisionId, lf.state AS state
      FROM library_files lf JOIN library_paths p ON p.id = lf.path_id
      WHERE lf.fingerprint IS NOT NULL AND lf.resource_id IS NOT NULL AND lf.state IN ('present','unavailable') AND p.media_kind = ?`).all(row.media_kind) as Array<{ pathId: string; rel: string; key: string; revisionId: string | null; state: string }>;
    const out = new Map<string, Array<{ pathId: string; rel: string; revisionId: string | null }>>();
    for (const item of rows) {
      if (!(item.state === "unavailable" || (item.pathId === row.id && !currentRels.has(item.rel)))) continue;
      const list = out.get(item.key) ?? [];
      list.push({ pathId: item.pathId, rel: item.rel, revisionId: item.revisionId });
      out.set(item.key, list);
    }
    return out;
  }

  /** The same content at a new path: the old resource follows the file, and nothing new is created. */
  private relink(row: PathRow, unit: ScanUnit, key: string, job: ScanJob, candidates: Map<string, Array<{ pathId: string; rel: string; revisionId: string | null }>>): boolean {
    const gone = candidates.get(key)?.shift();
    if (!gone) return false;
    const target = path.join(row.path, unit.rel);
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("DELETE FROM library_files WHERE path_id = ? AND relative_path = ?").run(row.id, unit.rel);
      this.store.sqlite.prepare("UPDATE library_files SET path_id = ?, relative_path = ?, size = ?, mtime_ms = ?, state = 'present', seen_scan_id = ?, error_json = NULL, updated_at = ? WHERE path_id = ? AND relative_path = ?")
        .run(row.id, unit.rel, unit.size, unit.mtime, job.id, new Date().toISOString(), gone.pathId, gone.rel);
      if (gone.revisionId) this.store.sqlite.prepare("UPDATE file_locations SET relative_path = ?, available = 1 WHERE resource_revision_id = ?").run(target, gone.revisionId);
    })();
    job.moved += 1;
    return true;
  }

  /** The work the earlier files of this folder went into, so a new file joins it; a folder never scanned before has none yet. */
  private workOfGroup(pathId: string, group: ScanGroup): string | undefined {
    const rows = this.store.sqlite.prepare(`SELECT r.work_id AS workId, COUNT(*) AS n FROM library_files lf JOIN resources r ON r.id = lf.resource_id
      WHERE lf.path_id = ? AND lf.state != 'failed' AND r.work_id IS NOT NULL AND (lf.relative_path = ? OR lf.relative_path LIKE ? ESCAPE '\\')
      GROUP BY r.work_id ORDER BY n DESC LIMIT 1`).all(pathId, group.key, `${likeEscape(group.key)}/%`) as Array<{ workId: string }>;
    return rows[0]?.workId;
  }

  private register(pathId: string, unit: ScanUnit, key: string | null, outcome: { resourceId: string; revisionId: string } | null, jobId: string, state: "present" | "failed", error: { code: string; message: string } | null): void {
    this.store.sqlite.prepare(`INSERT INTO library_files(path_id, relative_path, size, mtime_ms, fingerprint, resource_id, resource_revision_id, state, seen_scan_id, error_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(path_id, relative_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, fingerprint = excluded.fingerprint,
        resource_id = COALESCE(excluded.resource_id, library_files.resource_id), resource_revision_id = COALESCE(excluded.resource_revision_id, library_files.resource_revision_id),
        state = excluded.state, seen_scan_id = excluded.seen_scan_id, error_json = excluded.error_json, updated_at = excluded.updated_at`)
      .run(pathId, unit.rel, unit.size, unit.mtime, key, outcome?.resourceId ?? null, outcome?.revisionId ?? null, state, jobId, error ? JSON.stringify(error) : null, new Date().toISOString());
  }

  private markUnavailable(row: PathRow, jobId: string, failedDirs: string[], incomplete: boolean): number {
    if (incomplete) return 0;
    const missing = (this.store.sqlite.prepare("SELECT relative_path AS rel, resource_revision_id AS revisionId FROM library_files WHERE path_id = ? AND state IN ('present','failed') AND (seen_scan_id IS NULL OR seen_scan_id != ?)").all(row.id, jobId) as Array<{ rel: string; revisionId: string | null }>)
      .filter((file) => !failedDirs.some((dir) => dir === "." || file.rel === dir || file.rel.startsWith(`${dir}/`)));
    if (!missing.length) return 0;
    const mark = this.store.sqlite.prepare("UPDATE library_files SET state = 'unavailable', updated_at = ? WHERE path_id = ? AND relative_path = ?");
    const locate = this.store.sqlite.prepare("UPDATE file_locations SET available = 0 WHERE resource_revision_id = ?");
    const now = new Date().toISOString();
    this.store.sqlite.transaction(() => {
      for (const file of missing) {
        mark.run(now, row.id, file.rel);
        if (file.revisionId) locate.run(file.revisionId);
      }
    })();
    return missing.length;
  }
}
