import fs from "node:fs";
import path from "node:path";
import { MangaError, createId, type AcquisitionBudget, type AcquisitionImportState, type AcquisitionPauseReason, type AcquisitionPublishState, type AcquisitionStage, type AcquisitionState } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import type { ScanService } from "../library-scan/service.ts";
import type { PluginService } from "../plugins/service.ts";
import type { PluginRuntime } from "../plugins/runtime.ts";
import { TargetTaken, absUnder, decidePlacement, normalizeSubdir, publishFile, sha256File, unsafeEntryPath } from "./files.ts";

/**
 * Fetching things through an engine a plugin provides, into a folder the person already authorized as a library path (ACQ-01—03). The engine only moves
 * bytes and says what happened; this service decides everything else: where files go, whether there is room, what a failure means, and what a restart
 * does. A job is a row, and every step it takes is written down before it is done, so each can be repeated after a crash.
 *
 *   metadata → choosing → downloading → verifying → publishing → importing → done
 *
 * `paused` (by the person, or because the engine went away), `failed` (with the stage it stopped in) and `cancelled` are the other places a job can be.
 */

export type AcquisitionFault = "after-verify" | "after-publish" | "before-import" | "after-scan";
/** Thrown by a test's fault hook to stop a pipeline exactly where a crash would: nothing is written, nothing is cleaned up. */
export class AcquisitionCrash extends Error {}

export type AcquisitionNetwork = { dht?: boolean; lsd?: boolean; natUpnp?: boolean; natPmp?: boolean; torrentPort?: number };

export type AcquisitionOptions = {
  store: DrizzleStore;
  plugins: Pick<PluginService, "providers">;
  runtime: PluginRuntime;
  scan: Pick<ScanService, "enqueue" | "whenIdle" | "status">;
  /** Where staged downloads live: `<root>/<jobId>/{data,engine}`. */
  stagingRoot: string;
  notify: (topic: string, payload: Record<string, unknown>) => void;
  /** The network the engine may use. The default reaches the public DHT; tests keep it to the loopback address. */
  network?: AcquisitionNetwork;
  freeBytes?: (dir: string) => number | null;
  /** Always copy instead of linking a published file, as happens across volumes; for tests that have one volume. */
  forceCopy?: boolean;
  fault?: (point: AcquisitionFault, info: { jobId: string; index?: number }) => void | Promise<void>;
  now?: () => number;
  progressPersistMs?: number;
  progressNoticeMs?: number;
};

export type AcquisitionEntryView = {
  index: number;
  path: string;
  length: number;
  selected: boolean;
  verified: boolean;
  publishState: AcquisitionPublishState;
  /** Where the file is in the library, relative to the library path; null until it is published. */
  targetPath: string | null;
  importState: AcquisitionImportState;
  resourceId: string | null;
  note: string | null;
};

export type AcquisitionJobView = {
  id: string;
  name: string;
  state: AcquisitionState;
  pausedReason: AcquisitionPauseReason | null;
  stage: AcquisitionStage | null;
  error: { code: string; message: string } | null;
  infoHash: string | null;
  pathId: string;
  subdir: string;
  budget: AcquisitionBudget;
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
  entries?: AcquisitionEntryView[];
};

export type AcquisitionEngineView = { available: boolean; running: boolean; pluginId: string | null; reason: "no-plugin" | "not-running" | null };

type JobRow = {
  id: string; engine: string; resume_format: string; source_kind: "magnet" | "torrent"; source_ref: string; info_hash: string | null; name: string; state: AcquisitionState;
  paused_from: AcquisitionState | null; paused_reason: AcquisitionPauseReason | null; stage: AcquisitionStage | null; error_json: string | null; path_id: string; subdir: string; budget_json: string;
  total_bytes: number; selected_bytes: number; downloaded_bytes: number; uploaded_bytes: number; seeding: number; seed_ratio: number; seed_up_kbps: number; epoch: number;
  created_at: string; updated_at: string; finished_at: string | null;
};
type EntryRow = {
  job_id: string; idx: number; path: string; length: number; selected: number; verified: number; fingerprint: string | null; publish_state: AcquisitionPublishState;
  target_rel: string | null; import_state: AcquisitionImportState; resource_id: string | null; revision_id: string | null; note: string | null;
};
type Live = { down: number; up: number; peers: number; downloaded: number; uploaded: number; persistedAt: number; noticedAt: number };
type EngineInfo = { engine: string; resumeFormat: string };

const TRANSFER_STATES: readonly AcquisitionState[] = ["metadata", "choosing", "downloading", "verifying"];
const TERMINAL_STATES: readonly AcquisitionState[] = ["done", "failed", "cancelled"];
const SLOT = "acquisition.engine";
const MAX_ENTRIES = 100_000;
const MAX_TORRENT_FILE = 8 * 1024 * 1024;
const MIN_ROOM = 64 * 1024 * 1024;
const MAGNET = /^magnet:\?/i;

class Failure extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const codeOfError = (error: unknown): { code: string; message: string } => {
  const raw = (error as NodeJS.ErrnoException | undefined)?.code;
  if (error instanceof Failure) return { code: error.code, message: error.message };
  if (error instanceof MangaError) return { code: error.code === "PROVIDER_UNAVAILABLE" ? "ENGINE_UNAVAILABLE" : error.code, message: error.message };
  if (raw === "ENOSPC") return { code: "DISK_FULL", message: "there is no room left" };
  if (raw === "EACCES" || raw === "EPERM" || raw === "EROFS") return { code: "WRITE_DENIED", message: "the folder cannot be written to" };
  if (raw === "COPY_MISMATCH") return { code: "COPY_MISMATCH", message: "a copy did not match the file it was made from" };
  return { code: typeof raw === "string" && raw.length < 24 ? raw : "PUBLISH_FAILED", message: String((error as Error | undefined)?.message ?? error).slice(0, 300) };
};

const infoHashOf = (magnet: string): string | null => {
  const match = /[?&]xt=urn:btih:([A-Za-z0-9]{32,40})(?:&|$)/i.exec(magnet);
  if (!match) return null;
  const value = match[1]!;
  if (value.length === 40 && /^[0-9a-f]+$/i.test(value)) return value.toLowerCase();
  return value.length === 32 ? value.toUpperCase() : null;
};

export class AcquisitionService {
  private readonly o: AcquisitionOptions;
  private readonly live = new Map<string, Live>();
  /** Jobs the engine is working on right now (including seeding ones). */
  private readonly active = new Set<string>();
  private readonly pipelines = new Map<string, Promise<void>>();
  private readonly setups = new Map<string, Promise<EngineInfo>>();
  private chains = new Map<string, Promise<unknown>>();
  private disposed = false;
  private readonly off: Array<() => void> = [];

  constructor(options: AcquisitionOptions) {
    this.o = options;
    fs.mkdirSync(options.stagingRoot, { recursive: true });
    this.off.push(options.runtime.onEvent((pluginId, name, payload) => this.onEvent(pluginId, name, payload)));
    this.off.push(options.runtime.onState((pluginId, info) => this.onState(pluginId, info.state)));
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.off) off();
  }

  private get sqlite() { return this.o.store.sqlite; }
  private now() { return (this.o.now ?? Date.now)(); }
  private stamp() { return new Date(this.now()).toISOString(); }
  private stateDir(id: string) { return path.join(this.o.stagingRoot, id); }
  private dataDir(id: string) { return path.join(this.stateDir(id), "data"); }
  private torrentFile(id: string) { return path.join(this.stateDir(id), "engine", "torrent.torrent"); }
  private free(dir: string): number | null {
    if (this.o.freeBytes) return this.o.freeBytes(dir);
    try { let at = dir; while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at); const stat = fs.statfsSync(at); return Number(stat.bavail) * Number(stat.bsize); } catch { return null; }
  }

  // ------------------------------------------------------------------------------------------------------- reading

  private row(id: string): JobRow {
    const row = this.sqlite.prepare("SELECT * FROM acquisition_jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "that download does not exist");
    return row;
  }
  private maybeRow(id: string): JobRow | undefined { return this.sqlite.prepare("SELECT * FROM acquisition_jobs WHERE id = ?").get(id) as JobRow | undefined; }
  private entries(id: string): EntryRow[] { return this.sqlite.prepare("SELECT * FROM acquisition_entries WHERE job_id = ? ORDER BY idx").all(id) as EntryRow[]; }
  private libraryRoot(pathId: string): string | null { return (this.sqlite.prepare("SELECT path FROM library_paths WHERE id = ?").get(pathId) as { path: string } | undefined)?.path ?? null; }
  private budgetOf(row: JobRow): AcquisitionBudget { try { return JSON.parse(row.budget_json) as AcquisitionBudget; } catch { return {}; } }

  /** What the person may see of a job: never the source it came from. */
  private view(row: JobRow, withEntries: boolean): AcquisitionJobView {
    const entries = this.entries(row.id);
    const live = this.live.get(row.id);
    const selected = entries.filter((entry) => entry.selected === 1);
    const counts = {
      files: entries.length, selected: selected.length,
      published: selected.filter((entry) => entry.publish_state === "published").length,
      imported: selected.filter((entry) => entry.import_state === "imported").length,
      skipped: selected.filter((entry) => entry.import_state === "skipped").length,
      failed: selected.filter((entry) => entry.import_state === "failed").length,
    };
    const error = row.error_json ? JSON.parse(row.error_json) as { code: string; message: string } : null;
    return {
      id: row.id, name: row.name, state: row.state, pausedReason: row.paused_reason, stage: row.stage, error, infoHash: row.info_hash, pathId: row.path_id, subdir: row.subdir,
      budget: this.budgetOf(row), totalBytes: row.total_bytes, selectedBytes: row.selected_bytes,
      downloadedBytes: live?.downloaded ?? row.downloaded_bytes, uploadedBytes: live?.uploaded ?? row.uploaded_bytes,
      speeds: { down: live?.down ?? 0, up: live?.up ?? 0, peers: live?.peers ?? 0 },
      counts,
      seeding: { enabled: row.seeding === 1, active: row.seeding === 1 && this.active.has(row.id), ratio: row.seed_ratio, upKbps: row.seed_up_kbps, possible: row.state === "done" && this.canSeed(row, entries) },
      createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
      ...(withEntries ? { entries: entries.map((entry) => ({
        index: entry.idx, path: entry.path, length: entry.length, selected: entry.selected === 1, verified: entry.verified === 1, publishState: entry.publish_state, targetPath: entry.target_rel,
        importState: entry.import_state, resourceId: entry.resource_id, note: entry.note,
      })) } : {}),
    };
  }

  engineView(): AcquisitionEngineView {
    // An engine that is installed but turned off is still an engine: the page says it is not running, not that there is none.
    const providers = this.o.plugins.providers(SLOT, { includeDisabled: true });
    if (!providers.length) return { available: false, running: false, pluginId: null, reason: "no-plugin" };
    const running = providers.find((item) => item.running);
    return running ? { available: true, running: true, pluginId: running.pluginId, reason: null } : { available: true, running: false, pluginId: providers[0]!.pluginId, reason: "not-running" };
  }

  list(): { engine: AcquisitionEngineView; jobs: AcquisitionJobView[] } {
    const rows = this.sqlite.prepare("SELECT * FROM acquisition_jobs ORDER BY created_at DESC, id DESC").all() as JobRow[];
    return { engine: this.engineView(), jobs: rows.map((row) => this.view(row, false)) };
  }

  get(jobId: string): { job: AcquisitionJobView } {
    return { job: this.view(this.row(jobId), true) };
  }

  /** Resolves when the publishing and importing of a job (or of every job) has ended; for tests and for shutting down. */
  async whenSettled(jobId?: string): Promise<void> {
    for (;;) {
      const waiting = jobId ? [this.pipelines.get(jobId)] : [...this.pipelines.values()];
      const pending = waiting.filter((item): item is Promise<void> => Boolean(item));
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  // ------------------------------------------------------------------------------------------------------- writing state

  private patch(id: string, fields: Record<string, string | number | null>, notice = true): void {
    const sets = Object.keys(fields).map((key) => `${key} = ?`);
    this.sqlite.prepare(`UPDATE acquisition_jobs SET ${sets.length ? `${sets.join(", ")}, ` : ""}updated_at = ? WHERE id = ?`).run(...Object.values(fields), this.stamp(), id);
    if (notice) this.changed(id);
  }

  private changed(id: string): void {
    if (this.disposed) return;
    const row = this.maybeRow(id);
    if (!row) { this.o.notify("acquisition.changed", { jobId: id, removed: true }); return; }
    this.o.notify("acquisition.changed", { jobId: id, job: this.view(row, false) });
  }

  private fail(id: string, stage: AcquisitionStage, error: { code: string; message: string }): void {
    if (!this.maybeRow(id)) return;
    this.active.delete(id);
    this.live.delete(id);
    this.patch(id, { state: "failed", stage, error_json: JSON.stringify(error), paused_from: null, paused_reason: null });
  }

  /** Runs `work` after what was started for the same job before it, so a command and an engine event cannot interleave. */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(work, work);
    this.chains.set(id, next.catch(() => undefined));
    return next;
  }

  // ------------------------------------------------------------------------------------------------------- the engine

  private pidOf(pluginId: string): string { return `${pluginId}:${this.o.runtime.info(pluginId).pid ?? 0}`; }

  /** Sets a freshly started engine up once: its network, its limits and what resume data it can read. */
  private ensureEngine(pluginId: string): Promise<EngineInfo> {
    const key = this.pidOf(pluginId);
    let setup = this.setups.get(key);
    if (!setup) {
      setup = (async () => {
        await this.call(pluginId, "engine.configure", { dht: this.o.network?.dht ?? true, lsd: this.o.network?.lsd ?? false, natUpnp: this.o.network?.natUpnp ?? false, natPmp: this.o.network?.natPmp ?? false, ...(this.o.network?.torrentPort !== undefined ? { torrentPort: this.o.network.torrentPort } : {}) });
        const info = await this.call(pluginId, "engine.info", {}) as EngineInfo;
        await this.applyLimits(pluginId);
        return info;
      })();
      setup.catch(() => { if (this.setups.get(key) === setup) this.setups.delete(key); });
      this.setups.set(key, setup);
    }
    return setup;
  }

  private call(pluginId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.o.runtime.call(pluginId, method, params, { timeoutMs: 30_000 });
  }

  /** The engine's speed limits are one pair for all its jobs: the strictest the jobs that are running ask for. */
  private async applyLimits(pluginId: string): Promise<void> {
    let down = 0;
    let up = 0;
    const tighten = (current: number, value: number | undefined) => (value && value > 0 ? (current ? Math.min(current, value) : value) : current);
    for (const id of this.active) {
      const row = this.maybeRow(id);
      if (!row || row.engine !== pluginId) continue;
      const budget = this.budgetOf(row);
      down = tighten(down, budget.downKbps);
      up = tighten(up, budget.upKbps);
      if (row.seeding === 1) up = tighten(up, row.seed_up_kbps);
    }
    await this.call(pluginId, "engine.limits", { downKbps: down, upKbps: up }).catch(() => undefined);
  }

  private onState(pluginId: string, state: string): void {
    if (this.disposed) return;
    if (state === "starting") return;
    if (state === "running") { void this.engineUp(pluginId).catch(() => undefined); return; }
    this.engineDown(pluginId);
  }

  /** The engine went away (turned off, removed, ended): its jobs wait, and carry on by themselves when an engine is running again. */
  private engineDown(pluginId: string): void {
    for (const key of [...this.setups.keys()]) if (key.startsWith(`${pluginId}:`)) this.setups.delete(key);
    for (const row of this.sqlite.prepare("SELECT * FROM acquisition_jobs WHERE engine = ?").all(pluginId) as JobRow[]) {
      this.active.delete(row.id);
      this.live.delete(row.id);
      if (!TRANSFER_STATES.includes(row.state)) { if (row.seeding === 1) this.changed(row.id); continue; }
      this.patch(row.id, { state: "paused", paused_from: row.state === "verifying" ? "downloading" : row.state, paused_reason: "engine" });
    }
  }

  private async engineUp(pluginId: string): Promise<void> {
    const info = await this.ensureEngine(pluginId);
    if (this.disposed) return;
    for (const row of this.sqlite.prepare("SELECT * FROM acquisition_jobs WHERE engine = ? AND state = 'paused' AND paused_reason = 'engine'").all(pluginId) as JobRow[]) {
      if (row.resume_format !== info.resumeFormat) { this.fail(row.id, "transfer", { code: "RESUME_INCOMPATIBLE", message: "the engine cannot continue what an earlier engine left" }); continue; }
      await this.serial(row.id, () => this.resumeNow(row.id)).catch(() => undefined);
    }
    for (const row of this.sqlite.prepare("SELECT * FROM acquisition_jobs WHERE engine = ? AND state = 'done' AND seeding = 1").all(pluginId) as JobRow[]) {
      if (this.active.has(row.id)) continue;
      await this.serial(row.id, () => this.startSeeding(row.id)).catch(() => { this.patch(row.id, { seeding: 0 }); });
    }
  }

  /** The running engine that provides the slot, set up and ready; refuses with the reason when there is none. */
  private async engine(): Promise<{ pluginId: string; info: EngineInfo }> {
    const view = this.engineView();
    if (!view.running || !view.pluginId) throw new MangaError("PROVIDER_UNAVAILABLE", view.reason === "no-plugin" ? "no download engine is installed" : "the download engine is not running", { details: { reason: view.reason ?? "not-running" } });
    return { pluginId: view.pluginId, info: await this.ensureEngine(view.pluginId) };
  }

  // ------------------------------------------------------------------------------------------------------- commands

  async add(input: { magnet?: string; torrentFile?: string; pathId: string; subdir?: string; budget?: AcquisitionBudget }): Promise<{ jobId: string; job: AcquisitionJobView }> {
    const { pluginId, info } = await this.engine();
    const root = this.libraryRoot(input.pathId);
    if (!root) throw new MangaError("NOT_FOUND", "that library path does not exist");
    try { if (!fs.statSync(root).isDirectory()) throw new Error("not a folder"); } catch { throw new MangaError("LOCATION_UNAVAILABLE", "the library path cannot be reached", { details: { reason: "path-unreachable" } }); }
    const subdir = normalizeSubdir(input.subdir);
    if (subdir === null) throw new MangaError("VALIDATION_ERROR", "that folder name is not allowed", { details: { reason: "subdir" } });
    const budget = this.cleanBudget(input.budget);
    let hash: string | null = null;
    if (input.magnet !== undefined) {
      if (!MAGNET.test(input.magnet.trim())) throw new MangaError("VALIDATION_ERROR", "this is not a magnet link", { details: { reason: "source" } });
      hash = infoHashOf(input.magnet.trim());
      if (!hash) throw new MangaError("VALIDATION_ERROR", "this magnet link names no torrent", { details: { reason: "source" } });
      this.refuseDuplicate(hash);
    }
    const id = createId("acq");
    const stateDir = this.stateDir(id);
    fs.mkdirSync(path.join(stateDir, "engine"), { recursive: true });
    let source: { magnet: string } | { torrentPath: string };
    try {
      if (input.torrentFile) {
        const stat = fs.statSync(input.torrentFile);
        if (!stat.isFile() || stat.size > MAX_TORRENT_FILE) throw new MangaError("VALIDATION_ERROR", "this is not a torrent file", { details: { reason: "source" } });
        const copy = path.join(stateDir, "source.torrent");
        fs.copyFileSync(input.torrentFile, copy);
        source = { torrentPath: copy };
      } else source = { magnet: input.magnet!.trim() };
      const now = this.stamp();
      this.sqlite.prepare(`INSERT INTO acquisition_jobs(id, engine, resume_format, source_kind, source_ref, info_hash, name, state, path_id, subdir, budget_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, pluginId, info.resumeFormat, "magnet" in source ? "magnet" : "torrent", "magnet" in source ? source.magnet : "", hash, "", "metadata", input.pathId, subdir, JSON.stringify(budget), now, now);
      let added: { infoHash: string };
      try { added = await this.call(pluginId, "engine.add", { jobId: id, ...source, dir: this.dataDir(id), stateDir, selected: null }) as { infoHash: string }; } catch (error) {
        throw new MangaError("VALIDATION_ERROR", /magnet|torrent file|source/i.test(String((error as Error).message)) ? String((error as Error).message) : "the engine could not take this source", { details: { reason: "source" } });
      }
      this.active.add(id);
      try { this.refuseDuplicate(added.infoHash, id); } catch (error) {
        await this.call(pluginId, "engine.remove", { jobId: id, deleteFiles: true }).catch(() => undefined);
        this.active.delete(id);
        throw error;
      }
      this.patch(id, { info_hash: added.infoHash }, false);
      await this.applyLimits(pluginId);
    } catch (error) {
      this.active.delete(id);
      this.sqlite.prepare("DELETE FROM acquisition_jobs WHERE id = ?").run(id);
      fs.rmSync(stateDir, { recursive: true, force: true });
      throw error;
    }
    this.changed(id);
    return { jobId: id, job: this.view(this.row(id), true) };
  }

  /** The same torrent is not fetched twice at once, and not fetched again once it is in the library. */
  private refuseDuplicate(infoHash: string, except?: string): void {
    const same = this.sqlite.prepare("SELECT id, state FROM acquisition_jobs WHERE LOWER(info_hash) = LOWER(?) AND id != ? AND state NOT IN ('failed','cancelled') LIMIT 1").get(infoHash, except ?? "") as { id: string; state: AcquisitionState } | undefined;
    if (same) throw new MangaError("VALIDATION_ERROR", "this torrent is already in the downloads", { details: { reason: "duplicate", jobId: same.id, state: same.state } });
  }

  private cleanBudget(budget: AcquisitionBudget | undefined): AcquisitionBudget {
    const out: AcquisitionBudget = {};
    if (budget?.maxBytes) out.maxBytes = budget.maxBytes;
    if (budget?.downKbps) out.downKbps = budget.downKbps;
    if (budget?.upKbps) out.upKbps = budget.upKbps;
    return out;
  }

  select(jobId: string, indexes: number[], budget?: AcquisitionBudget): Promise<{ job: AcquisitionJobView }> {
    return this.serial(jobId, async () => {
      const row = this.row(jobId);
      if (row.state !== "choosing" && row.state !== "downloading") throw new MangaError("VALIDATION_ERROR", "files can be chosen while the download is waiting for them or running", { details: { reason: "state", state: row.state } });
      const entries = this.entries(jobId);
      const chosen = [...new Set(indexes)].sort((a, b) => a - b);
      if (chosen.some((index) => !entries.some((entry) => entry.idx === index))) throw new MangaError("VALIDATION_ERROR", "a chosen file is not in the torrent", { details: { reason: "index" } });
      const bytes = chosen.reduce((sum, index) => sum + entries.find((entry) => entry.idx === index)!.length, 0);
      const nextBudget = budget ? this.cleanBudget(budget) : this.budgetOf(row);
      if (nextBudget.maxBytes && bytes > nextBudget.maxBytes) throw new MangaError("QUOTA_EXCEEDED", "the chosen files are larger than the limit set for this download", { details: { bytes, maxBytes: nextBudget.maxBytes } });
      const room = this.free(this.dataDir(jobId));
      const already = entries.filter((entry) => entry.selected === 1).reduce((sum, entry) => sum + entry.length, 0);
      if (room !== null && room < Math.max(0, bytes - (row.state === "downloading" ? already : 0)) + MIN_ROOM) throw new MangaError("DISK_FULL", "there is not enough room for the chosen files", { details: { bytes, room } });
      const { pluginId } = await this.engine();
      if (row.engine !== pluginId) throw new MangaError("PROVIDER_UNAVAILABLE", "the engine that started this download is not running", { details: { reason: "not-running" } });
      await this.call(pluginId, "engine.select", { jobId, indexes: chosen });
      // Written in the same turn the engine's answer is handled in, before any event it sends after it.
      this.sqlite.transaction(() => {
        this.sqlite.prepare("UPDATE acquisition_entries SET selected = 0 WHERE job_id = ?").run(jobId);
        const mark = this.sqlite.prepare("UPDATE acquisition_entries SET selected = 1 WHERE job_id = ? AND idx = ?");
        for (const index of chosen) mark.run(jobId, index);
      })();
      this.patch(jobId, { selected_bytes: bytes, budget_json: JSON.stringify(nextBudget), state: "downloading" }, false);
      await this.applyLimits(pluginId);
      this.changed(jobId);
      return { job: this.view(this.row(jobId), true) };
    });
  }

  pause(jobId: string): Promise<{ job: AcquisitionJobView }> {
    return this.serial(jobId, async () => {
      const row = this.row(jobId);
      if (!TRANSFER_STATES.includes(row.state)) throw new MangaError("VALIDATION_ERROR", "this download is not transferring", { details: { reason: "state", state: row.state } });
      this.active.delete(jobId);
      this.live.delete(jobId);
      await this.call(row.engine, "engine.remove", { jobId, deleteFiles: false }).catch(() => undefined);
      this.patch(jobId, { state: "paused", paused_from: row.state === "verifying" ? "downloading" : row.state, paused_reason: "user" });
      await this.applyLimits(row.engine);
      return { job: this.view(this.row(jobId), true) };
    });
  }

  resume(jobId: string): Promise<{ job: AcquisitionJobView }> {
    return this.serial(jobId, async () => {
      const row = this.row(jobId);
      if (row.state === "failed" && row.stage === "publish") return this.retryPublishNow(jobId);
      if (row.state === "failed" && row.stage === "import") return this.retryImportNow(jobId);
      if (row.state !== "paused" && !(row.state === "failed" && row.stage === "transfer")) throw new MangaError("VALIDATION_ERROR", "this download is not waiting to continue", { details: { reason: "state", state: row.state } });
      await this.resumeNow(jobId);
      return { job: this.view(this.row(jobId), true) };
    });
  }

  /** Adds the job to the engine again; the engine continues from the data under the job's folder. */
  private async resumeNow(jobId: string): Promise<void> {
    const row = this.row(jobId);
    if (row.state !== "paused" && row.state !== "failed") return;
    const { pluginId, info } = await this.engine();
    if (row.engine !== pluginId) throw new MangaError("PROVIDER_UNAVAILABLE", "the engine that started this download is not running", { details: { reason: "not-running" } });
    if (row.resume_format !== info.resumeFormat) { this.fail(jobId, "transfer", { code: "RESUME_INCOMPATIBLE", message: "the engine cannot continue what an earlier engine left" }); throw new MangaError("API_INCOMPATIBLE", "the installed engine cannot continue this download; start it again"); }
    const selected = this.entries(jobId).filter((entry) => entry.selected === 1).map((entry) => entry.idx);
    const stateDir = this.stateDir(jobId);
    const torrent = this.torrentFile(jobId);
    const source = fs.existsSync(torrent) ? { torrentPath: torrent } : row.source_kind === "magnet" ? { magnet: row.source_ref } : { torrentPath: path.join(stateDir, "source.torrent") };
    this.patch(jobId, { state: selected.length ? "downloading" : "metadata", paused_from: null, paused_reason: null, stage: null, error_json: null }, false);
    try {
      await this.call(pluginId, "engine.add", { jobId, ...source, dir: this.dataDir(jobId), stateDir, selected: selected.length ? selected : null });
    } catch (error) {
      const { code, message } = codeOfError(error);
      this.patch(jobId, { state: "paused", paused_from: row.paused_from ?? (selected.length ? "downloading" : "metadata"), paused_reason: "engine" }, false);
      this.changed(jobId);
      throw new MangaError("PROVIDER_UNAVAILABLE", `${code}: ${message}`, { details: { reason: "engine" } });
    }
    this.active.add(jobId);
    await this.applyLimits(pluginId);
    this.changed(jobId);
  }

  cancel(jobId: string): Promise<{ jobId: string; jobName: string }> {
    return this.serial(jobId, async () => {
      const row = this.row(jobId);
      if (row.state === "publishing" || row.state === "importing") throw new MangaError("VALIDATION_ERROR", "this download is being put into the library; wait for it to finish", { details: { reason: "state", state: row.state } });
      if (row.state === "done" || row.state === "cancelled") throw new MangaError("VALIDATION_ERROR", "this download is already over", { details: { reason: "state", state: row.state } });
      this.active.delete(jobId);
      this.live.delete(jobId);
      await this.call(row.engine, "engine.remove", { jobId, deleteFiles: true }).catch(() => undefined);
      // What is staged and was never published is deleted; what was published and imported stays where it is.
      fs.rmSync(this.stateDir(jobId), { recursive: true, force: true });
      this.patch(jobId, { state: "cancelled", paused_from: null, paused_reason: null, seeding: 0, finished_at: this.stamp() });
      await this.applyLimits(row.engine);
      return { jobId, jobName: row.name };
    });
  }

  remove(jobId: string): Promise<{ jobId: string; jobName: string }> {
    return this.serial(jobId, async () => {
      const row = this.row(jobId);
      if (!TERMINAL_STATES.includes(row.state)) throw new MangaError("VALIDATION_ERROR", "stop this download before removing it", { details: { reason: "state", state: row.state } });
      if (this.active.has(jobId)) await this.call(row.engine, "engine.remove", { jobId, deleteFiles: false }).catch(() => undefined);
      this.active.delete(jobId);
      this.live.delete(jobId);
      this.sqlite.transaction(() => {
        this.sqlite.prepare("DELETE FROM acquisition_entries WHERE job_id = ?").run(jobId);
        this.sqlite.prepare("DELETE FROM acquisition_jobs WHERE id = ?").run(jobId);
      })();
      fs.rmSync(this.stateDir(jobId), { recursive: true, force: true });
      this.changed(jobId);
      return { jobId, jobName: row.name };
    });
  }

  /** Starts the job over from its source: for when what it left cannot be continued by the engine that is installed now. Files already in the library are not touched. */
  restart(jobId: string): Promise<{ job: AcquisitionJobView }> {
    return this.serial(jobId, async () => {
      const row = this.row(jobId);
      if (row.state === "done" || row.state === "cancelled" || row.state === "publishing" || row.state === "importing") throw new MangaError("VALIDATION_ERROR", "this download cannot be started over now", { details: { reason: "state", state: row.state } });
      const { pluginId, info } = await this.engine();
      this.active.delete(jobId);
      this.live.delete(jobId);
      await this.call(row.engine, "engine.remove", { jobId, deleteFiles: true }).catch(() => undefined);
      const stateDir = this.stateDir(jobId);
      fs.rmSync(path.join(stateDir, "engine"), { recursive: true, force: true });
      fs.rmSync(this.dataDir(jobId), { recursive: true, force: true });
      fs.mkdirSync(path.join(stateDir, "engine"), { recursive: true });
      this.sqlite.prepare("DELETE FROM acquisition_entries WHERE job_id = ? AND publish_state != 'published'").run(jobId);
      this.sqlite.prepare("UPDATE acquisition_entries SET selected = 0, verified = 0 WHERE job_id = ?").run(jobId);
      this.patch(jobId, { engine: pluginId, resume_format: info.resumeFormat, state: "metadata", stage: null, error_json: null, paused_from: null, paused_reason: null, selected_bytes: 0, downloaded_bytes: 0, finished_at: null }, false);
      const source = row.source_kind === "magnet" ? { magnet: row.source_ref } : { torrentPath: path.join(stateDir, "source.torrent") };
      try { await this.call(pluginId, "engine.add", { jobId, ...source, dir: this.dataDir(jobId), stateDir, selected: null }); } catch (error) {
        const { code, message } = codeOfError(error);
        this.fail(jobId, "transfer", { code: code === "ENGINE_UNAVAILABLE" ? code : "ENGINE", message });
        throw error;
      }
      this.active.add(jobId);
      this.changed(jobId);
      return { job: this.view(this.row(jobId), true) };
    });
  }

  retryPublish(jobId: string): Promise<{ job: AcquisitionJobView }> {
    return this.serial(jobId, async () => this.retryPublishNow(jobId));
  }

  private retryPublishNow(jobId: string): { job: AcquisitionJobView } {
    const row = this.row(jobId);
    if (row.state !== "failed" || row.stage !== "publish") throw new MangaError("VALIDATION_ERROR", "there is nothing to publish again", { details: { reason: "state", state: row.state } });
    this.patch(jobId, { state: "publishing", stage: null, error_json: null }, false);
    this.launch(jobId, "publish");
    return { job: this.view(this.row(jobId), true) };
  }

  retryImport(jobId: string): Promise<{ job: AcquisitionJobView }> {
    return this.serial(jobId, async () => this.retryImportNow(jobId));
  }

  private retryImportNow(jobId: string): { job: AcquisitionJobView } {
    const row = this.row(jobId);
    if (row.state !== "failed" || row.stage !== "import") throw new MangaError("VALIDATION_ERROR", "there is nothing to import again", { details: { reason: "state", state: row.state } });
    this.patch(jobId, { state: "importing", stage: null, error_json: null }, false);
    this.launch(jobId, "import");
    return { job: this.view(this.row(jobId), true) };
  }

  // ------------------------------------------------------------------------------------------------------- engine events

  private onEvent(pluginId: string, name: string, payload: unknown): void {
    if (this.disposed || !name.startsWith("acq.") || typeof payload !== "object" || !payload) return;
    const p = payload as Record<string, any>;
    if (name === "acq.engineError") { this.o.notify("acquisition.engineError", { pluginId }); return; }
    const jobId = typeof p.jobId === "string" ? p.jobId : null;
    if (!jobId || !this.active.has(jobId)) return;
    const row = this.maybeRow(jobId);
    if (!row || row.engine !== pluginId) return;
    try { this.handle(row, name, p); } catch (error) {
      const { code, message } = codeOfError(error);
      this.endEngineJob(row);
      this.fail(jobId, "transfer", { code, message });
    }
  }

  private endEngineJob(row: JobRow): void {
    this.active.delete(row.id);
    this.live.delete(row.id);
    void this.call(row.engine, "engine.remove", { jobId: row.id, deleteFiles: false }).then(() => this.applyLimits(row.engine)).catch(() => undefined);
  }

  private handle(row: JobRow, name: string, p: Record<string, any>): void {
    const id = row.id;
    // A finished download that is being shared sends progress and its end; the file list it also sends is already known.
    if (row.state === "done" && !["acq.progress", "acq.error", "acq.seedStopped"].includes(name)) return;
    switch (name) {
      case "acq.metadata": {
        const files = Array.isArray(p.files) ? p.files as Array<{ index: number; path: string; length: number }> : [];
        if (files.length === 0 || files.length > MAX_ENTRIES) throw new Failure("INVALID_SOURCE", "the torrent holds no files or too many");
        if (files.some((file) => !Number.isInteger(file.index) || !Number.isFinite(file.length) || file.length < 0 || unsafeEntryPath(file.path))) throw new Failure("PATH_ESCAPE", "the torrent holds a file name that is not allowed");
        const upsert = this.sqlite.prepare(`INSERT INTO acquisition_entries(job_id, idx, path, length) VALUES (?,?,?,?) ON CONFLICT(job_id, idx) DO UPDATE SET path = excluded.path, length = excluded.length`);
        this.sqlite.transaction(() => { for (const file of files) upsert.run(id, file.index, file.path, file.length); })();
        const total = files.reduce((sum, file) => sum + file.length, 0);
        const selected = this.entries(id).filter((entry) => entry.selected === 1);
        this.patch(id, { name: String(p.name ?? "").slice(0, 300), total_bytes: total, state: selected.length ? "downloading" : "choosing" });
        return;
      }
      case "acq.progress": {
        const live = this.live.get(id) ?? { down: 0, up: 0, peers: 0, downloaded: 0, uploaded: 0, persistedAt: 0, noticedAt: 0 };
        live.down = Number(p.downloadSpeed) || 0; live.up = Number(p.uploadSpeed) || 0; live.peers = Number(p.peers) || 0;
        live.downloaded = row.state === "done" ? row.downloaded_bytes : Number(p.downloaded) || 0; live.uploaded = Number(p.uploaded) || 0;
        this.live.set(id, live);
        const now = this.now();
        if (now - live.persistedAt >= (this.o.progressPersistMs ?? 5000)) { live.persistedAt = now; this.sqlite.prepare("UPDATE acquisition_jobs SET downloaded_bytes = ?, uploaded_bytes = ? WHERE id = ?").run(Math.floor(live.downloaded), Math.floor(live.uploaded), id); }
        if (now - live.noticedAt >= (this.o.progressNoticeMs ?? 700)) { live.noticedAt = now; this.changed(id); }
        return;
      }
      case "acq.verifying":
        if (row.state === "downloading") this.patch(id, { state: "verifying" });
        return;
      case "acq.verified": {
        const files = Array.isArray(p.files) ? p.files as Array<{ index: number; path: string; length: number }> : [];
        const entries = this.entries(id);
        const wanted = entries.filter((entry) => entry.selected === 1);
        const verified = new Set(files.map((file) => file.index));
        if (!wanted.length || wanted.some((entry) => !verified.has(entry.idx))) throw new Failure("ENGINE", "the engine did not verify every chosen file");
        const mark = this.sqlite.prepare("UPDATE acquisition_entries SET verified = 1 WHERE job_id = ? AND idx = ?");
        this.sqlite.transaction(() => { for (const entry of wanted) mark.run(id, entry.idx); })();
        this.active.delete(id);
        this.live.delete(id);
        this.patch(id, { state: "publishing", downloaded_bytes: Math.floor(Number(p.downloaded) || row.downloaded_bytes), uploaded_bytes: Math.floor(Number(p.uploaded) || 0), stage: null, error_json: null });
        void this.applyLimits(row.engine);
        this.launch(id, "publish");
        return;
      }
      case "acq.error": {
        this.active.delete(id);
        this.live.delete(id);
        if (row.state === "done") { this.patch(id, { seeding: 0 }); this.o.notify("acquisition.seedStopped", { jobId: id, reason: "error" }); void this.applyLimits(row.engine); return; }
        this.fail(id, "transfer", { code: String(p.code ?? "ENGINE").slice(0, 40), message: String(p.message ?? "").slice(0, 300) });
        void this.applyLimits(row.engine);
        return;
      }
      case "acq.seedStopped":
        this.active.delete(id);
        this.live.delete(id);
        this.patch(id, { seeding: 0, uploaded_bytes: Math.floor(Number(p.uploaded) || row.uploaded_bytes) });
        this.o.notify("acquisition.seedStopped", { jobId: id, reason: String(p.reason ?? "ratio") });
        void this.applyLimits(row.engine);
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------------------------------------------------- publishing and importing

  private launch(jobId: string, from: "publish" | "import"): void {
    if (this.pipelines.has(jobId) || this.disposed) return;
    const run = (async () => {
      try {
        if (from === "publish") await this.publishAll(jobId);
        await this.importAll(jobId);
      } catch (error) {
        if (error instanceof AcquisitionCrash) return;
        const stage: AcquisitionStage = this.maybeRow(jobId)?.state === "importing" ? "import" : "publish";
        const coded = codeOfError(error);
        this.fail(jobId, stage, stage === "import" && !(error instanceof Failure) ? { code: "SCAN_FAILED", message: coded.message } : coded);
      } finally {
        this.pipelines.delete(jobId);
      }
    })();
    this.pipelines.set(jobId, run);
  }

  private async publishAll(jobId: string): Promise<void> {
    const job = this.row(jobId);
    const root = this.libraryRoot(job.path_id);
    if (!root || !fs.existsSync(root)) throw new Failure("LOCATION_UNAVAILABLE", "the library path cannot be reached");
    for (const entry of this.entries(jobId)) {
      if (entry.selected !== 1 || entry.publish_state === "published") continue;
      await this.publishEntry(job, entry, root);
      this.changed(jobId);
    }
  }

  private async publishEntry(job: JobRow, entry: EntryRow, root: string): Promise<void> {
    const id = job.id;
    const update = (fields: Partial<Record<"fingerprint" | "publish_state" | "target_rel" | "note", string | null>>) => {
      const keys = Object.keys(fields);
      this.sqlite.prepare(`UPDATE acquisition_entries SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE job_id = ? AND idx = ?`).run(...Object.values(fields), id, entry.idx);
    };
    const src = absUnder(this.dataDir(id), entry.path);
    const wanted = job.subdir ? `${job.subdir}/${entry.path}` : entry.path;
    let fingerprint = entry.fingerprint;
    if (fs.existsSync(src)) {
      if (fs.statSync(src).size !== entry.length) throw new Failure("STAGED_CHANGED", "a downloaded file changed after it was verified");
      fingerprint = await sha256File(src);
      update({ fingerprint });
      await this.o.fault?.("after-verify", { jobId: id, index: entry.idx });
    } else if (!fingerprint) throw new Failure("STAGED_MISSING", "a downloaded file is no longer there");
    // Several attempts: whatever is at a name when it is time to write may be a file that appeared in the meantime.
    let target = entry.target_rel;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (target) {
        const abs = absUnder(root, target);
        if (fs.existsSync(abs)) {
          // Published before and the record of it was lost: this very file is there already.
          if (fs.statSync(abs).size === entry.length && (await sha256File(abs)) === fingerprint) break;
          target = null;
        } else if (!fs.existsSync(src)) throw new Failure("STAGED_MISSING", "a downloaded file is no longer there");
      }
      if (!target) {
        const placement = await decidePlacement(root, wanted, entry.length, fingerprint!);
        if (!placement) { update({ publish_state: "conflict", note: "no-name" }); throw new Failure("PUBLISH_CONFLICT", "no free name was found for a file"); }
        target = placement.rel;
        update({ target_rel: target });
        if (placement.adopted) break;
      }
      const abs = absUnder(root, target);
      if (fs.existsSync(abs)) continue;
      try {
        await publishFile(src, abs, { length: entry.length, fingerprint: fingerprint! }, { forceCopy: this.o.forceCopy, freeBytes: (dir) => this.free(dir), tempName: (to) => path.join(path.dirname(to), `.${path.basename(to)}.${id.slice(-8)}-${entry.idx}.publish`) });
        break;
      } catch (error) {
        if (error instanceof TargetTaken) { target = null; continue; }
        throw error;
      }
    }
    if (!target) throw new Failure("PUBLISH_CONFLICT", "no free name was found for a file");
    await this.o.fault?.("after-publish", { jobId: id, index: entry.idx });
    update({ publish_state: "published", target_rel: target, note: null });
    fs.rmSync(src, { force: true });
  }

  private async importAll(jobId: string): Promise<void> {
    const job = this.row(jobId);
    this.patch(jobId, { state: "importing", stage: null, error_json: null });
    await this.o.fault?.("before-import", { jobId });
    const wanted = () => this.entries(jobId).filter((entry) => entry.selected === 1 && entry.publish_state === "published");
    // A scan that was already walking the path when the files were published may not have seen them: when something is missing, scan once more.
    const stale = this.o.scan.status().running?.pathId === job.path_id;
    for (let round = 0; round < (stale ? 2 : 1); round += 1) {
      const scan = this.o.scan.enqueue(job.path_id, "add");
      await this.o.scan.whenIdle();
      const status = (this.sqlite.prepare("SELECT status FROM scan_jobs WHERE id = ?").get(scan.id) as { status: string } | undefined)?.status;
      if (status && status !== "done") throw new Failure("SCAN_FAILED", "the library scan did not finish");
      await this.o.fault?.("after-scan", { jobId });
      if (this.matchEntries(job.path_id, wanted()).missing === 0) break;
    }
    const failed = this.entries(jobId).filter((entry) => entry.selected === 1 && entry.import_state === "failed").length;
    if (failed) throw new Failure("IMPORT_FAILED", `${failed} file(s) could not be read into the library`);
    fs.rmSync(this.dataDir(jobId), { recursive: true, force: true });
    this.patch(jobId, { state: "done", stage: null, error_json: null, finished_at: this.stamp() });
    this.o.notify("acquisition.done", { jobId, name: this.row(jobId).name });
  }

  /**
   * Records what the library made of each published file: the resource it became, or why it did not become one. A file inside a folder the scan takes as one
   * unit (the pages of a comic) is matched through the folder. `missing` counts files the library has no record of at all.
   */
  private matchEntries(pathId: string, entries: EntryRow[]): { missing: number } {
    const find = this.sqlite.prepare("SELECT relative_path, resource_id, resource_revision_id, state, error_json FROM library_files WHERE path_id = ? AND relative_path = ?");
    let missing = 0;
    const apply = this.sqlite.prepare("UPDATE acquisition_entries SET import_state = ?, resource_id = ?, revision_id = ?, note = ? WHERE job_id = ? AND idx = ?");
    this.sqlite.transaction(() => {
      for (const entry of entries) {
        const parts = entry.target_rel!.split("/");
        let found: { relative_path: string; resource_id: string | null; resource_revision_id: string | null; state: string; error_json: string | null } | undefined;
        for (let n = parts.length; n >= 1 && !found; n -= 1) found = find.get(pathId, parts.slice(0, n).join("/")) as typeof found;
        if (!found) { missing += 1; apply.run("skipped", null, null, "not-recognized", entry.job_id, entry.idx); continue; }
        if (found.resource_id && found.state === "present") apply.run("imported", found.resource_id, found.resource_revision_id, null, entry.job_id, entry.idx);
        else if (found.state === "failed") apply.run("failed", null, null, found.error_json ? String((JSON.parse(found.error_json) as { code?: string }).code ?? "failed") : "failed", entry.job_id, entry.idx);
        else apply.run("skipped", null, null, "not-recognized", entry.job_id, entry.idx);
      }
    })();
    return { missing };
  }

  // ------------------------------------------------------------------------------------------------------- seeding

  /** Seeding offers what was published back to the swarm. It needs every file to be where the torrent expects it, under the name it has. */
  private canSeed(row: JobRow, entries: EntryRow[]): boolean {
    if (row.state !== "done" || !fs.existsSync(this.torrentFile(row.id))) return false;
    const selected = entries.filter((entry) => entry.selected === 1);
    return selected.length > 0 && selected.every((entry) => entry.publish_state === "published" && entry.target_rel === (row.subdir ? `${row.subdir}/${entry.path}` : entry.path));
  }

  private async startSeeding(jobId: string): Promise<void> {
    const row = this.row(jobId);
    const root = this.libraryRoot(row.path_id);
    if (!root) throw new MangaError("NOT_FOUND", "that library path does not exist");
    const { pluginId } = await this.engine();
    if (row.engine !== pluginId) throw new MangaError("PROVIDER_UNAVAILABLE", "the engine that started this download is not running", { details: { reason: "not-running" } });
    await this.call(pluginId, "engine.seed", { jobId, torrentPath: this.torrentFile(jobId), dir: row.subdir ? absUnder(root, row.subdir) : root, stateDir: this.stateDir(jobId), ratio: row.seed_ratio });
    this.active.add(jobId);
    await this.applyLimits(pluginId);
  }

  setSeeding(jobId: string, enabled: boolean, ratio?: number, upKbps?: number): Promise<{ job: AcquisitionJobView }> {
    return this.serial(jobId, async () => {
      const row = this.row(jobId);
      if (row.state !== "done") throw new MangaError("VALIDATION_ERROR", "only a finished download can be shared", { details: { reason: "state", state: row.state } });
      if (!enabled) {
        if (this.active.has(jobId)) await this.call(row.engine, "engine.remove", { jobId, deleteFiles: false }).catch(() => undefined);
        this.active.delete(jobId);
        this.live.delete(jobId);
        this.patch(jobId, { seeding: 0 });
        await this.applyLimits(row.engine);
        return { job: this.view(this.row(jobId), true) };
      }
      if (!this.canSeed(row, this.entries(jobId))) throw new MangaError("VALIDATION_ERROR", "these files are not where the torrent expects them, so they cannot be shared", { details: { reason: "seed-impossible" } });
      this.patch(jobId, { seeding: 1, seed_ratio: ratio ?? row.seed_ratio, seed_up_kbps: upKbps ?? row.seed_up_kbps }, false);
      if (this.active.has(jobId)) await this.call(row.engine, "engine.remove", { jobId, deleteFiles: false }).catch(() => undefined);
      this.active.delete(jobId);
      try { await this.startSeeding(jobId); } catch (error) { this.patch(jobId, { seeding: 0 }); throw error; }
      this.changed(jobId);
      return { job: this.view(this.row(jobId), true) };
    });
  }

  // ------------------------------------------------------------------------------------------------------- start

  /** The feature was switched off: every transfer is put on hold (the engine lets go of it) and carries on when the feature is on again. */
  async suspend(): Promise<void> {
    for (const row of this.sqlite.prepare("SELECT * FROM acquisition_jobs WHERE state IN ('metadata','choosing','downloading','verifying') OR (state = 'done' AND seeding = 1)").all() as JobRow[]) {
      await this.call(row.engine, "engine.remove", { jobId: row.id, deleteFiles: false }).catch(() => undefined);
      this.active.delete(row.id);
      this.live.delete(row.id);
      if (TRANSFER_STATES.includes(row.state)) this.patch(row.id, { state: "paused", paused_from: row.state === "verifying" ? "downloading" : row.state, paused_reason: "engine" });
    }
  }

  /** Called when the feature starts: what was in flight when the application ended is put where it can carry on. */
  recover(): void {
    for (const row of this.sqlite.prepare("SELECT * FROM acquisition_jobs WHERE state IN ('metadata','choosing','downloading','verifying')").all() as JobRow[]) {
      this.patch(row.id, { state: "paused", paused_from: row.state === "verifying" ? "downloading" : row.state, paused_reason: "engine" }, false);
    }
    for (const row of this.sqlite.prepare("SELECT * FROM acquisition_jobs WHERE state IN ('publishing','importing')").all() as JobRow[]) this.launch(row.id, row.state === "publishing" ? "publish" : "import");
    const view = this.engineView();
    if (view.running && view.pluginId) void this.engineUp(view.pluginId).catch(() => undefined);
  }

  /** The folder a job's files are staged in, for tests that look at what is left on disk. */
  stagingOf(jobId: string): string { return this.stateDir(jobId); }
}
