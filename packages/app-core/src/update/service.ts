import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_UPDATE_SETTINGS,
  JustUpdatedInfoSchema,
  MangaError,
  UPDATE_ERROR_MESSAGES,
  UpdateSettingsSchema,
  UpdateStatusSchema,
  type BuildInfo,
  type ErrorCode,
  type JustUpdatedInfo,
  type LocationLayout,
  type UpdateBusyReason,
  type UpdateRestartResult,
  type UpdateSettings,
  type UpdateSettingsPatch,
  type UpdateState,
  type UpdateStatus,
} from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import type { FetchLike } from "../metadata/bangumi.ts";
import type { OperationLog } from "../ops/operation-log.ts";
import {
  RELEASE_UPDATE_PUBLIC_KEYS,
  checkAppUpdateConfig,
  compareReleaseVersions,
  computeBlockMapPlan,
  parseBlockMapBytes,
  parseLatestYaml,
  verifyReleaseInstaller,
  type BlockMapData,
  type LatestManifest,
  type VerifiedUpdateReceipt,
} from "./signature.ts";

export const DEFAULT_UPDATE_INITIAL_DELAY_MS = 10 * 60 * 1000;
export const DEFAULT_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** The version the person went back from after it did not start (4.2); written by the bootstrap's rollback, cleared from 设置 › 更新. */
export const UPDATE_SKIP_FILE = "update-skip.json";
/** The bootstrap's note of a rollback, put in the operation log by the version it went back to. */
export const UPDATE_ROLLBACK_RECORD = "rollback-record.json";
/** The version and SHA-512 of the installer kept in the updater cache (`installer.exe`), so the next update can keep it as the way back. */
const CACHED_INSTALLER_RECORD = "installer.json";
const PREVIOUS_DIR = "previous";

function sha512HexOfFile(file: string): string {
  const hash = createHash("sha512");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function writeJsonAtomic(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staging, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(staging, file);
}

export const DEFAULT_GITHUB_FEED_URL = "https://github.com/chialecode/manga/releases/latest/download";

/** The desktop supplies electron-updater; the service owns settings, trust, saving and recovery. */
export type UpdateInstallerDownloader = (input: {
  manifest: LatestManifest;
  baseUrl: string;
  signature: string;
  signal: AbortSignal;
  onProgress: (downloadedBytes: number, totalBytes: number, usedDifferential: boolean) => void;
}) => Promise<{ installerPath: string; downloadedBytes: number; usedDifferential: boolean }>;

const META_SETTINGS = "update.settings";
const META_LAST_CHECKED = "update.lastCheckedAt";
const META_LAST_RUN_VERSION = "update.lastRunVersion";
const META_PENDING_FROM = "update.pendingFrom";
const META_PENDING_NOTES = "update.pendingNotes";

export type UpdateServiceOptions = {
  store: DrizzleStore;
  layout: LocationLayout;
  buildInfo: BuildInfo;
  log: OperationLog;
  notify: (topic: string, payload: Record<string, unknown>) => void;
  resourcesPath?: string;
  /** Path to `app-update.yml`. When provided (or when `packaged` is true), `publisherName` in `app-update.yml` is enforced. */
  appUpdateConfigPath?: string;
  packaged?: boolean;
  installDirectory?: string;
  feedUrl?: string;
  /** Allow `http://127.0.0.1` / `http://localhost` for loopback test servers (unless `requireHttps` is `true`). */
  allowLoopbackHttp?: boolean;
  /** Explicitly reject all `http://` URLs including loopback (for testing AT-160 non-HTTPS rejection). */
  requireHttps?: boolean;
  publicKeys?: ReadonlyArray<{ publicKey: string; label: string }>;
  netFetch?: FetchLike;
  initialDelayMs?: number;
  intervalMs?: number;
  isBusy?: () => UpdateBusyReason[];
  onBeforeInstall?: (mode: "restart" | "quit") => Promise<void> | void;
  onInstallFailed?: (mode: "restart" | "quit") => Promise<void> | void;
  runInstaller?: (installerPath: string, args: string[], mode: "restart" | "quit", receipt: VerifiedUpdateReceipt) => Promise<boolean> | boolean;
  downloadInstaller?: UpdateInstallerDownloader;
  verifyPublisherSignature?: (installerPath: string) => Promise<string | null>;
  now?: () => number;
};

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "::1" || lower === "[::1]";
}

export class UpdateService {
  private readonly store: DrizzleStore;
  private readonly layout: LocationLayout;
  private buildInfo: BuildInfo;
  private readonly log: OperationLog;
  private readonly notify: (topic: string, payload: Record<string, unknown>) => void;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly cacheDir: string;
  private readonly pendingDir: string;
  private isBusyFn: () => UpdateBusyReason[];
  private readonly onBeforeInstall?: (mode: "restart" | "quit") => Promise<void> | void;
  private readonly onInstallFailed?: (mode: "restart" | "quit") => Promise<void> | void;
  private runInstallerFn: (installerPath: string, args: string[], mode: "restart" | "quit", receipt: VerifiedUpdateReceipt) => Promise<boolean> | boolean;
  private downloadInstallerFn?: UpdateInstallerDownloader;
  private verifyPublisherSignatureFn?: (installerPath: string) => Promise<string | null>;

  private feedUrl: string;
  private allowLoopbackHttp: boolean;
  private requireHttps: boolean;
  private publicKeys: ReadonlyArray<{ publicKey: string; label: string }>;
  private appUpdateConfigPath: string | undefined;
  private requireAppUpdateConfig: boolean;
  private installDirectory: string | undefined;
  private initialDelayMs: number;
  private intervalMs: number;

  private state: UpdateState;
  private lastCheckedAt: string | null;
  private availableVersion: string | null = null;
  private releaseNotes: string | null = null;
  private targetSchemaVersion: number | null = null;
  private downloadedBytes = 0;
  private totalBytes = 0;
  private usedDifferential = false;
  private error: string | null = null;
  private errorCode: ErrorCode | null = null;
  private settings: UpdateSettings;
  private justUpdated: JustUpdatedInfo | null = null;

  private downloadedInstallerPath: string | null = null;
  private downloadedSigText: string | null = null;
  private verifiedReceipt: VerifiedUpdateReceipt | null = null;
  private verifiedByPublisherHook = false;
  private pendingManifest: LatestManifest | null = null;
  private checkInFlight: Promise<UpdateStatus> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private schedulerActive = false;
  private installTriggered = false;
  private disposed = false;
  private readonly lifecycle = new AbortController();

  constructor(options: UpdateServiceOptions) {
    this.store = options.store;
    this.layout = options.layout;
    this.buildInfo = options.buildInfo;
    this.log = options.log;
    this.notify = options.notify;
    this.fetchFn = options.netFetch ?? ((url, init) => fetch(url, init as RequestInit));
    this.now = options.now ?? Date.now;
    this.cacheDir = path.join(this.layout.partitions.cache, "updater");
    this.pendingDir = path.join(this.cacheDir, "pending");
    this.isBusyFn = options.isBusy ?? (() => []);
    this.onBeforeInstall = options.onBeforeInstall;
    this.onInstallFailed = options.onInstallFailed;
    this.runInstallerFn = options.runInstaller ?? ((installerPath, args) => this.defaultSpawnInstaller(installerPath, args));
    this.downloadInstallerFn = options.downloadInstaller;
    this.verifyPublisherSignatureFn = options.verifyPublisherSignature;

    this.feedUrl = (options.feedUrl ?? process.env.MANGA_UPDATE_FEED_URL ?? DEFAULT_GITHUB_FEED_URL).trim();
    this.allowLoopbackHttp = options.allowLoopbackHttp ?? (process.env.MANGA_UPDATE_ALLOW_HTTP === "1" || Boolean(process.env.MANGA_UPDATE_FEED_URL));
    this.requireHttps = options.requireHttps ?? (process.env.MANGA_UPDATE_REQUIRE_HTTPS === "1");
    this.publicKeys = options.publicKeys ?? RELEASE_UPDATE_PUBLIC_KEYS;

    const candidateAppUpdate = options.appUpdateConfigPath
      ?? (options.resourcesPath ? path.join(options.resourcesPath, "app-update.yml") : undefined);
    this.appUpdateConfigPath = candidateAppUpdate;
    this.requireAppUpdateConfig = Boolean(
      options.appUpdateConfigPath
      || (options.packaged && this.buildInfo.channel === "release")
      || (candidateAppUpdate && fs.existsSync(candidateAppUpdate)),
    );
    this.installDirectory = options.installDirectory;

    const envDelay = Number(process.env.MANGA_UPDATE_INITIAL_DELAY_MS);
    const envInterval = Number(process.env.MANGA_UPDATE_INTERVAL_MS);
    this.initialDelayMs = options.initialDelayMs ?? (Number.isFinite(envDelay) && envDelay >= 0 ? envDelay : DEFAULT_UPDATE_INITIAL_DELAY_MS);
    this.intervalMs = options.intervalMs ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : DEFAULT_UPDATE_INTERVAL_MS);

    this.settings = this.readStoredSettings();
    this.lastCheckedAt = this.store.getMeta(META_LAST_CHECKED) ?? null;
    this.state = this.buildInfo.channel === "release" ? "idle" : "unavailable";

    this.recordRollback();
    this.detectFirstLaunchAfterUpdate();
  }

  /** Reconfigure feed/security options in tests or runtime. */
  configure(patch: {
    buildInfo?: BuildInfo;
    feedUrl?: string;
    allowLoopbackHttp?: boolean;
    requireHttps?: boolean;
    publicKeys?: ReadonlyArray<{ publicKey: string; label: string }>;
    appUpdateConfigPath?: string;
    requireAppUpdateConfig?: boolean;
    installDirectory?: string;
    initialDelayMs?: number;
    intervalMs?: number;
    isBusy?: () => UpdateBusyReason[];
    runInstaller?: (installerPath: string, args: string[], mode: "restart" | "quit", receipt: VerifiedUpdateReceipt) => Promise<boolean> | boolean;
    downloadInstaller?: UpdateInstallerDownloader;
    verifyPublisherSignature?: (installerPath: string) => Promise<string | null>;
    resetState?: boolean;
    detectFirstLaunch?: boolean;
  }): void {
    if (patch.buildInfo !== undefined) {
      this.buildInfo = patch.buildInfo;
    }
    if (patch.feedUrl !== undefined) this.feedUrl = patch.feedUrl.trim();
    if (patch.allowLoopbackHttp !== undefined) this.allowLoopbackHttp = patch.allowLoopbackHttp;
    if (patch.requireHttps !== undefined) this.requireHttps = patch.requireHttps;
    if (patch.publicKeys !== undefined) this.publicKeys = patch.publicKeys;
    if (patch.appUpdateConfigPath !== undefined) {
      this.appUpdateConfigPath = patch.appUpdateConfigPath;
      this.requireAppUpdateConfig = true;
    }
    if (patch.requireAppUpdateConfig !== undefined) {
      this.requireAppUpdateConfig = patch.requireAppUpdateConfig;
    }
    if (patch.installDirectory !== undefined) this.installDirectory = patch.installDirectory;
    if (patch.initialDelayMs !== undefined) this.initialDelayMs = patch.initialDelayMs;
    if (patch.intervalMs !== undefined) this.intervalMs = patch.intervalMs;
    if (patch.isBusy !== undefined) this.isBusyFn = patch.isBusy;
    if (patch.runInstaller !== undefined) this.runInstallerFn = patch.runInstaller;
    if (patch.downloadInstaller !== undefined) this.downloadInstallerFn = patch.downloadInstaller;
    if (patch.verifyPublisherSignature !== undefined) this.verifyPublisherSignatureFn = patch.verifyPublisherSignature;
    if (patch.resetState || patch.buildInfo !== undefined) {
      this.state = this.buildInfo.channel === "release" ? "idle" : "unavailable";
      this.availableVersion = null;
      this.releaseNotes = null;
      this.targetSchemaVersion = null;
      this.downloadedBytes = 0;
      this.totalBytes = 0;
      this.usedDifferential = false;
      this.error = null;
      this.errorCode = null;
      this.downloadedInstallerPath = null;
      this.downloadedSigText = null;
      this.verifiedReceipt = null;
      this.verifiedByPublisherHook = false;
      this.pendingManifest = null;
      this.installTriggered = false;
      if (!patch.detectFirstLaunch) {
        this.justUpdated = null;
      }
    }
    if (patch.detectFirstLaunch) {
      this.recordRollback();
      this.detectFirstLaunchAfterUpdate();
    }
    this.emitStatus();
  }

  /** Seed the current version's installer and blockmap in the updater cache so differential downloads can copy unchanged blocks. */
  seedCurrentInstallerCache(installerBytes: Uint8Array, blockMapGzipBytes: Uint8Array): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(this.cacheDir, "installer.exe"), installerBytes);
    fs.writeFileSync(path.join(this.cacheDir, "current.blockmap"), blockMapGzipBytes);
    this.recordCachedInstaller(this.buildInfo.version);
  }

  private recordCachedInstaller(version: string, sha512Hex?: string): void {
    try {
      const file = path.join(this.cacheDir, "installer.exe");
      writeJsonAtomic(path.join(this.cacheDir, CACHED_INSTALLER_RECORD), { version, sha512Hex: sha512Hex ?? sha512HexOfFile(file) });
    } catch {
      // Without the record the next update simply offers no one-click way back.
    }
  }

  /**
   * Keep the installer of the running version as the way back (4.2): copied to `cache\updater\previous\` with its version and SHA-512, one at a
   * time. Only an installer recorded as this version, whose bytes are still the recorded ones, is kept; without one the update goes on as before
   * and a failed start offers the download page instead.
   */
  keepPreviousInstaller(target: { version: string; schemaVersion: number | null; backup: string | null }): boolean {
    const previousDir = path.join(this.cacheDir, PREVIOUS_DIR);
    try {
      const cached = path.join(this.cacheDir, "installer.exe");
      const record = JSON.parse(fs.readFileSync(path.join(this.cacheDir, CACHED_INSTALLER_RECORD), "utf8")) as { version?: string; sha512Hex?: string };
      if (record.version !== this.buildInfo.version || typeof record.sha512Hex !== "string" || !fs.existsSync(cached)) return false;
      const sha512Hex = sha512HexOfFile(cached);
      if (sha512Hex !== record.sha512Hex.toLowerCase()) return false;
      fs.rmSync(previousDir, { recursive: true, force: true });
      fs.mkdirSync(previousDir, { recursive: true });
      const file = `installer-${this.buildInfo.version.replace(/[^A-Za-z0-9._-]/g, "_")}.exe`;
      fs.copyFileSync(cached, path.join(previousDir, `${file}.part`));
      fs.renameSync(path.join(previousDir, `${file}.part`), path.join(previousDir, file));
      writeJsonAtomic(path.join(previousDir, "previous.json"), {
        version: this.buildInfo.version,
        sha512Hex,
        file,
        schemaVersion: this.buildInfo.schemaVersion,
        targetVersion: target.version,
        targetSchemaVersion: target.schemaVersion,
        database: this.databaseFile(),
        backup: target.backup,
        keptAt: new Date(this.now()).toISOString(),
      });
      return true;
    } catch {
      try { fs.rmSync(previousDir, { recursive: true, force: true }); } catch { /* nothing kept */ }
      return false;
    }
  }

  private databaseFile(): string | null {
    const name = (this.store.sqlite as { name?: unknown }).name;
    return typeof name === "string" && name !== "" && name !== ":memory:" ? path.resolve(name) : null;
  }

  /** The version skipped after going back from it (4.2), or null. */
  skippedVersion(): string | null {
    try {
      const body = JSON.parse(fs.readFileSync(path.join(this.layout.partitions.data, UPDATE_SKIP_FILE), "utf8")) as { version?: unknown };
      return typeof body.version === "string" && body.version ? body.version : null;
    } catch {
      return null;
    }
  }

  /** "取消跳过": the skipped version is offered again at the next check. */
  unskip(): UpdateStatus {
    // The command itself is what the operation log records (update.unskip).
    if (this.skippedVersion()) {
      fs.rmSync(path.join(this.layout.partitions.data, UPDATE_SKIP_FILE), { force: true });
      this.emitStatus();
    }
    return this.status();
  }

  /** The bootstrap went back to this version: put that in the operation log once. */
  private recordRollback(): void {
    const file = path.join(this.layout.partitions.data, UPDATE_ROLLBACK_RECORD);
    let body: { from?: unknown; to?: unknown; databaseRestored?: unknown; keptAs?: unknown };
    try { body = JSON.parse(fs.readFileSync(file, "utf8")) as typeof body; } catch { return; }
    try { fs.rmSync(file, { force: true }); } catch { /* recorded once is enough */ }
    if (typeof body.from !== "string" || typeof body.to !== "string") return;
    this.log.record({
      actorKind: "user",
      category: "settings",
      action: "update.rolledBack",
      objectKind: "update",
      objectId: body.from,
      objectLabel: body.from,
      summaryKey: body.databaseRestored === true ? "log.update.rolledBackRestored" : "log.update.rolledBack",
      summaryParams: { from: body.from, to: body.to, ...(typeof body.keptAs === "string" ? { keptAs: body.keptAs } : {}) },
      outcome: "ok",
    });
  }

  private readStoredSettings(): UpdateSettings {
    const raw = this.store.getMeta(META_SETTINGS);
    if (!raw) return { ...DEFAULT_UPDATE_SETTINGS };
    try {
      return UpdateSettingsSchema.parse(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_UPDATE_SETTINGS };
    }
  }

  private detectFirstLaunchAfterUpdate(): void {
    const currentVersion = this.buildInfo.version;
    const pendingFrom = this.store.getMeta(META_PENDING_FROM)?.trim() || null;
    const pendingNotes = this.store.getMeta(META_PENDING_NOTES) ?? "";
    const lastRunVersion = this.store.getMeta(META_LAST_RUN_VERSION)?.trim() || null;

    let previousVersion: string | null = null;
    const candidate = pendingFrom || lastRunVersion;
    if (candidate && candidate !== currentVersion && this.buildInfo.channel === "release") {
      try {
        if (compareReleaseVersions(currentVersion, candidate) > 0) {
          previousVersion = candidate;
        }
      } catch {
        // non-release version strings are not compared
      }
    }

    if (previousVersion) {
      this.writePreUpdateBackup(previousVersion);
      this.justUpdated = JustUpdatedInfoSchema.parse({
        version: currentVersion,
        previousVersion,
        releaseNotes: pendingNotes,
      });
      this.log.record({
        actorKind: "system",
        category: "settings",
        action: "update.installed",
        objectKind: "update",
        objectId: currentVersion,
        objectLabel: currentVersion,
        summaryKey: "log.update.installed",
        summaryParams: { from: previousVersion, to: currentVersion },
        outcome: "ok",
      });
    }

    if (pendingFrom !== null) {
      this.store.setMeta(META_PENDING_FROM, "");
    }
    if (lastRunVersion !== currentVersion) {
      this.store.setMeta(META_LAST_RUN_VERSION, currentVersion);
    }
  }

  /**
   * Create a pre-update backup copy of `manga.sqlite` in `layout.partitions.backups` (`manga.sqlite.preupdate-v<previousVersion>.sqlite`).
   */
  writePreUpdateBackup(previousVersion = this.buildInfo.version, options: { refresh?: boolean } = {}): string | null {
    let temporary: string | undefined;
    try {
      const backupsDir = this.layout.partitions.backups;
      fs.mkdirSync(backupsDir, { recursive: true });
      const safeVer = previousVersion.replace(/[^A-Za-z0-9._-]/g, "_");
      const targetPath = path.join(backupsDir, `manga.sqlite.preupdate-v${safeVer}.sqlite`);
      if (options.refresh || !fs.existsSync(targetPath)) {
        // serialize() takes a SQLite snapshot including committed WAL pages. Copying only the main
        // file after an unchecked checkpoint can silently omit saved records.
        const snapshot = this.store.sqlite.serialize();
        temporary = `${targetPath}.part`;
        fs.writeFileSync(temporary, snapshot);
        fs.renameSync(temporary, targetPath);
        this.log.record({
          actorKind: "system",
          category: "backup",
          action: "update.backup",
          objectKind: "update",
          objectId: previousVersion,
          objectLabel: previousVersion,
          summaryKey: "log.update.backup",
          summaryParams: { version: previousVersion },
          outcome: "ok",
        });
      }
      return fs.statSync(targetPath).size > 0 ? targetPath : null;
    } catch {
      if (temporary) { try { fs.rmSync(temporary, { force: true }); } catch { /* retry will replace the partial backup */ } }
      return null;
    }
  }

  /** Start the automatic update check schedule (10 min after launch, then every 6 hours) in the `release` channel. */
  startScheduler(): void {
    this.schedulerActive = true;
    this.rescheduleTimers();
  }

  private clearTimers(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private rescheduleTimers(): void {
    this.clearTimers();
    if (this.disposed || !this.schedulerActive) return;
    if (this.buildInfo.channel !== "release" || !this.settings.autoCheck) return;

    this.initialTimer = setTimeout(() => {
      if (!this.disposed && this.settings.autoCheck && this.buildInfo.channel === "release") {
        void this.check({ manual: false });
      }
    }, this.initialDelayMs);
    this.initialTimer.unref?.();

    this.intervalTimer = setInterval(() => {
      if (!this.disposed && this.settings.autoCheck && this.buildInfo.channel === "release") {
        void this.check({ manual: false });
      }
    }, this.intervalMs);
    this.intervalTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycle.abort();
    this.schedulerActive = false;
    this.clearTimers();
  }

  getSettings(): UpdateSettings {
    return { ...this.settings };
  }

  setSettings(patch: UpdateSettingsPatch): UpdateSettings {
    this.settings = UpdateSettingsSchema.parse({
      ...this.settings,
      ...(patch.autoCheck !== undefined ? { autoCheck: patch.autoCheck } : {}),
      ...(patch.autoDownload !== undefined ? { autoDownload: patch.autoDownload } : {}),
    });
    this.store.setMeta(META_SETTINGS, JSON.stringify(this.settings));
    this.rescheduleTimers();
    this.emitStatus();
    if (
      this.buildInfo.channel === "release"
      && patch.autoDownload === true
      && this.pendingManifest
      && this.state === "idle"
    ) {
      void this.check({ manual: false, download: true });
    }
    return { ...this.settings };
  }

  status(options: { dismissJustUpdated?: boolean } = {}): UpdateStatus {
    if (options.dismissJustUpdated && this.justUpdated) {
      this.justUpdated = null;
      this.store.setMeta(META_PENDING_NOTES, "");
      this.emitStatus();
    }
    const willUpgradeSchema = Boolean(
      this.targetSchemaVersion !== null && this.targetSchemaVersion > this.buildInfo.schemaVersion,
    );
    return UpdateStatusSchema.parse({
      version: this.buildInfo.version,
      channel: this.buildInfo.channel,
      commit: this.buildInfo.commit,
      builtAt: this.buildInfo.builtAt,
      schemaVersion: this.buildInfo.schemaVersion,
      state: this.buildInfo.channel === "release" ? this.state : "unavailable",
      lastCheckedAt: this.lastCheckedAt,
      availableVersion: this.availableVersion,
      releaseNotes: this.releaseNotes,
      targetSchemaVersion: this.targetSchemaVersion,
      willUpgradeSchema,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      usedDifferential: this.usedDifferential,
      error: this.error,
      errorCode: this.errorCode,
      settings: this.settings,
      justUpdated: this.justUpdated,
      skippedVersion: this.buildInfo.channel === "release" ? this.skippedVersion() : null,
    });
  }

  private emitStatus(): void {
    if (this.disposed) return;
    try {
      this.notify("update.changed", this.status() as unknown as Record<string, unknown>);
    } catch {
      // ignore listener errors
    }
  }

  private userAgentHeader(): Record<string, string> {
    return {
      "User-Agent": `MANGA/${this.buildInfo.version} (${process.platform}; ${process.arch})`,
      "Cache-Control": "no-cache",
    };
  }

  private async fetchSecure(rawUrl: string, init: { headers?: Record<string, string> } = {}): Promise<Response> {
    let url = rawUrl;
    for (let redirects = 0; redirects <= 10; redirects += 1) {
      const checked = this.validateUrlSecurity(url);
      if (!checked.ok) throw new MangaError("UPDATE_VERIFY_FAILED", checked.message);
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: { ...this.userAgentHeader(), ...init.headers },
        redirect: "manual",
        signal: AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(120_000)]),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new MangaError("UPDATE_VERIFY_FAILED", "更新源重定向无效，已保留当前版本");
      url = new URL(location, url).href;
    }
    throw new MangaError("UPDATE_VERIFY_FAILED", "更新源重定向次数过多，已保留当前版本");
  }

  private validateUrlSecurity(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string; message: string } {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, reason: "invalid-url", message: "更新源地址无效，已保留当前版本" };
    }
    if (parsed.protocol === "https:") {
      return { ok: true, url: parsed };
    }
    if (
      parsed.protocol === "http:"
      && this.allowLoopbackHttp
      && !this.requireHttps
      && isLoopbackHost(parsed.hostname)
    ) {
      return { ok: true, url: parsed };
    }
    return {
      ok: false,
      reason: "non-https",
      message: "更新源必须使用 HTTPS，已保留当前版本",
    };
  }

  private rejectWithVerifyFailure(reason: string, message: string = UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED, versionLabel?: string | null): UpdateStatus {
    this.cleanupPendingFiles();
    this.state = "error";
    this.errorCode = "UPDATE_VERIFY_FAILED";
    this.error = message;
    this.log.record({
      actorKind: "system",
      category: "settings",
      action: "update.rejected",
      objectKind: "update",
      objectId: versionLabel ?? this.availableVersion ?? null,
      objectLabel: versionLabel ?? this.availableVersion ?? null,
      summaryKey: "log.update.rejected",
      summaryParams: { reason, version: versionLabel ?? this.availableVersion ?? "—" },
      outcome: "error",
      errorCode: "UPDATE_VERIFY_FAILED",
    });
    this.emitStatus();
    return this.status();
  }

  private cleanupPendingFiles(): void {
    if (this.downloadedInstallerPath) {
      try { fs.rmSync(this.downloadedInstallerPath, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(`${this.downloadedInstallerPath}.sig`, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(`${this.downloadedInstallerPath}.part`, { force: true }); } catch { /* ignore */ }
    }
    try {
      if (fs.existsSync(this.pendingDir)) {
        for (const name of fs.readdirSync(this.pendingDir)) {
          fs.rmSync(path.join(this.pendingDir, name), { force: true, recursive: true });
        }
      }
    } catch {
      // ignore
    }
    this.downloadedInstallerPath = null;
    this.downloadedSigText = null;
    this.verifiedReceipt = null;
    this.verifiedByPublisherHook = false;
  }

  /**
   * Check for updates from the configured release feed (`latest.yml`).
   * In `development` channel, throws `UPDATE_UNAVAILABLE`.
   */
  async check(options: { manual?: boolean; download?: boolean } = {}): Promise<UpdateStatus> {
    const manual = options.manual ?? true;
    if (this.buildInfo.channel !== "release") {
      throw new MangaError("UPDATE_UNAVAILABLE", UPDATE_ERROR_MESSAGES.UPDATE_UNAVAILABLE);
    }
    if (this.disposed) return this.status();
    if (this.checkInFlight) {
      return this.checkInFlight;
    }
    const work = this.doCheck({ manual, download: options.download }).finally(() => {
      this.checkInFlight = null;
    });
    this.checkInFlight = work;
    return work;
  }

  private async doCheck(options: { manual: boolean; download?: boolean }): Promise<UpdateStatus> {
    // Keep a verified pending release stable until it is installed or rejected. A later feed must not
    // replace its version/notes while the receipt still refers to the earlier installer.
    if (this.installTriggered || this.state === "ready") return this.status();
    const checkedAt = new Date(this.now()).toISOString();
    this.lastCheckedAt = checkedAt;
    this.store.setMeta(META_LAST_CHECKED, checkedAt);

    // 1. Validate feed URL security (must be HTTPS unless loopback test override is active).
    const feedCheck = this.validateUrlSecurity(this.feedUrl);
    if (!feedCheck.ok) {
      return this.rejectWithVerifyFailure(feedCheck.reason, feedCheck.message);
    }

    this.state = "checking";
    this.availableVersion = null;
    this.releaseNotes = null;
    this.targetSchemaVersion = null;
    this.pendingManifest = null;
    this.error = null;
    this.errorCode = null;
    this.emitStatus();

    const baseHref = feedCheck.url.href.replace(/\/+$/, "");
    const manifestUrl = baseHref.endsWith("/latest.yml") ? baseHref : `${baseHref}/latest.yml`;
    const manifestUrlCheck = this.validateUrlSecurity(manifestUrl);
    if (!manifestUrlCheck.ok) {
      return this.rejectWithVerifyFailure(manifestUrlCheck.reason, manifestUrlCheck.message);
    }

    let manifestText: string;
    try {
      const response = await this.fetchSecure(manifestUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      manifestText = await response.text();
    } catch (error) {
      if (this.disposed) return this.status();
      if (error instanceof MangaError && error.code === "UPDATE_VERIFY_FAILED") return this.rejectWithVerifyFailure("redirect-rejected", error.message);
      return this.handleNetworkFailure(options.manual, error);
    }
    if (this.disposed) return this.status();

    let manifest: LatestManifest;
    try {
      manifest = parseLatestYaml(manifestText);
    } catch {
      return this.rejectWithVerifyFailure("invalid-manifest", "更新清单格式无效，已保留当前版本");
    }

    // Ignore draft or pre-release entries in the release channel (计划 4.3).
    if (manifest.draft || manifest.prerelease) {
      this.state = "idle";
      this.emitStatus();
      return this.status();
    }

    // Validate version ordering (`allowDowngrade = false`, 计划 4.4, AT-160).
    let cmp: number;
    try {
      cmp = compareReleaseVersions(manifest.version, this.buildInfo.version);
    } catch {
      return this.rejectWithVerifyFailure("invalid-version", "更新清单版本号无效，已保留当前版本", manifest.version);
    }
    if (cmp < 0) {
      return this.rejectWithVerifyFailure("downgrade", "拒绝安装旧版本更新包，已保留当前版本", manifest.version);
    }
    if (cmp === 0) {
      this.state = this.verifiedReceipt ? "ready" : "idle";
      this.emitStatus();
      return this.status();
    }
    // The version the person went back from is not offered again until a newer one comes or they cancel the skip (4.2).
    if (this.skippedVersion() === manifest.version) {
      this.state = "idle";
      this.availableVersion = null;
      this.pendingManifest = null;
      this.emitStatus();
      return this.status();
    }

    // Check fileName safety and resolved download URL security.
    if (
      manifest.fileName.includes("://")
      || path.basename(manifest.fileName) !== manifest.fileName
      || !manifest.fileName.toLowerCase().endsWith(".exe")
    ) {
      if (manifest.fileName.startsWith("http://")) {
        return this.rejectWithVerifyFailure("non-https", "更新源必须使用 HTTPS，已保留当前版本", manifest.version);
      }
      return this.rejectWithVerifyFailure("invalid-filename", "更新包文件名无效，已保留当前版本", manifest.version);
    }

    this.availableVersion = manifest.version;
    this.releaseNotes = manifest.releaseNotes || null;
    this.targetSchemaVersion = manifest.schemaVersion;
    this.totalBytes = manifest.size;
    this.pendingManifest = manifest;

    const shouldDownload = options.download ?? this.settings.autoDownload;
    if (!shouldDownload) {
      this.state = "idle";
      this.emitStatus();
      return this.status();
    }

    return this.downloadAndVerify(manifest, { manual: options.manual, baseHref: baseHref.replace(/\/latest\.yml$/, "") });
  }

  private handleNetworkFailure(manual: boolean, _error: unknown): UpdateStatus {
    this.log.record({
      actorKind: manual ? "user" : "system",
      category: "settings",
      action: "update.offline",
      objectKind: "update",
      objectId: null,
      objectLabel: null,
      summaryKey: "log.update.offline",
      summaryParams: { mode: manual ? "manual" : "auto" },
      outcome: "error",
      errorCode: "UPDATE_UNAVAILABLE",
    });
    if (manual) {
      this.state = "error";
      this.errorCode = "UPDATE_UNAVAILABLE";
      this.error = UPDATE_ERROR_MESSAGES.UPDATE_OFFLINE;
    } else {
      // Automatic check stays silent when offline (计划 4.3, AT-160).
      this.state = this.verifiedReceipt ? "ready" : "idle";
      this.error = null;
      this.errorCode = null;
    }
    this.emitStatus();
    return this.status();
  }

  private async downloadAndVerify(
    manifest: LatestManifest,
    options: { manual: boolean; baseHref?: string },
  ): Promise<UpdateStatus> {
    if (this.requireAppUpdateConfig && (!this.appUpdateConfigPath || !fs.existsSync(this.appUpdateConfigPath)
      || checkAppUpdateConfig(fs.readFileSync(this.appUpdateConfigPath, "utf8")).length)) {
      return this.rejectWithVerifyFailure("invalid-app-update-config", undefined, manifest.version);
    }
    const baseHref = options.baseHref ?? this.feedUrl.replace(/\/+$/, "").replace(/\/latest\.yml$/, "");
    const installerUrl = `${baseHref}/${manifest.fileName}`;
    const sigUrl = `${baseHref}/${manifest.fileName}.sig`;
    const newBlockMapUrl = `${baseHref}/${manifest.fileName}.blockmap`;

    for (const targetUrl of [installerUrl, sigUrl, newBlockMapUrl]) {
      const check = this.validateUrlSecurity(targetUrl);
      if (!check.ok) {
        return this.rejectWithVerifyFailure(check.reason, check.message, manifest.version);
      }
    }

    this.state = "downloading";
    this.downloadedBytes = 0;
    this.totalBytes = manifest.size;
    this.usedDifferential = false;
    this.emitStatus();

    fs.mkdirSync(this.pendingDir, { recursive: true });
    let finalPath = path.join(this.pendingDir, manifest.fileName);
    const partPath = `${finalPath}.part`;

    let newBlockMapBytes: Buffer | null = null;
    let suppliedSignature: string | null = null;
    try {
      if (this.downloadInstallerFn) {
        const signatureResponse = await this.fetchSecure(sigUrl);
        if (!signatureResponse.ok) return this.rejectWithVerifyFailure("signature-missing", undefined, manifest.version);
        suppliedSignature = await signatureResponse.text();
        this.downloadedSigText = suppliedSignature;
        const downloaded = await this.downloadInstallerFn({
          manifest,
          baseUrl: baseHref,
          signature: suppliedSignature,
          signal: this.lifecycle.signal,
          onProgress: (bytes, _total, differential) => {
            this.downloadedBytes = Math.max(0, Math.round(bytes));
            this.usedDifferential = differential;
            this.emitStatus();
          },
        });
        finalPath = downloaded.installerPath;
        this.downloadedBytes = downloaded.downloadedBytes;
        this.usedDifferential = downloaded.usedDifferential;
      } else {
        // Try differential download first when a cached previous installer exists.
        const oldInstallerPath = path.join(this.cacheDir, "installer.exe");
        const oldBlockMapPath = path.join(this.cacheDir, "current.blockmap");
        let completedDifferentially = false;

        if (fs.existsSync(oldInstallerPath) && (!fs.existsSync(partPath) || fs.statSync(partPath).size === 0)) {
          try {
            const oldBlockMap = await this.loadOldBlockMap(oldBlockMapPath, baseHref);
            const nbResp = await this.fetchSecure(newBlockMapUrl);
            if (oldBlockMap && nbResp.ok) {
              newBlockMapBytes = Buffer.from(await nbResp.arrayBuffer());
              const newBlockMap = parseBlockMapBytes(newBlockMapBytes);
              const plan = computeBlockMapPlan(oldBlockMap, newBlockMap);
              if (plan.totalBytes === manifest.size && plan.copyBytes > 0) {
                const oldBytes = fs.readFileSync(oldInstallerPath);
                const targetChunks: Buffer[] = [];
                let fetchedBytes = 0;
                for (const op of plan.operations) {
                  if (op.kind === "copy") {
                    if (op.end > oldBytes.length) throw new Error("old installer shorter than blockmap copy range");
                    targetChunks.push(oldBytes.subarray(op.start, op.end));
                  } else {
                    const rangeResp = await this.fetchSecure(installerUrl, {
                      headers: {
                        Range: `bytes=${op.start}-${op.end - 1}`,
                      },
                    });
                    if (!rangeResp.ok) throw new Error(`range request failed: ${rangeResp.status}`);
                    const chunk = Buffer.from(await rangeResp.arrayBuffer());
                    if (chunk.length !== op.end - op.start) {
                      throw new Error(`range length mismatch: expected ${op.end - op.start}, got ${chunk.length}`);
                    }
                    targetChunks.push(chunk);
                    fetchedBytes += chunk.length;
                    this.downloadedBytes = fetchedBytes;
                    this.emitStatus();
                  }
                }
                const assembled = Buffer.concat(targetChunks);
                fs.writeFileSync(finalPath, assembled);
                this.downloadedBytes = fetchedBytes;
                this.usedDifferential = true;
                completedDifferentially = true;
              }
            }
          } catch {
            // Fall back to full / resumed download (计划 3.1, 4.3).
            completedDifferentially = false;
          }
        }

        if (!completedDifferentially) {
          await this.downloadFullOrResume(installerUrl, partPath, finalPath, manifest.size);
        }
      }
    } catch (error) {
      if (this.disposed) {
        this.cleanupPendingFiles();
        return this.status();
      }
      if (error instanceof MangaError && error.code === "UPDATE_VERIFY_FAILED") {
        return this.rejectWithVerifyFailure("updater-verification", error.message, manifest.version);
      }
      return this.handleNetworkFailure(options.manual, error);
    }

    this.downloadedInstallerPath = finalPath;
    if (this.disposed) { this.cleanupPendingFiles(); return this.status(); }

    // Fetch detached `.sig` file (计划 4.4, AT-160).
    let sigText: string;
    try {
      const sigResp = suppliedSignature === null ? await this.fetchSecure(sigUrl) : null;
      if (sigResp && !sigResp.ok) {
        try { fs.rmSync(finalPath, { force: true }); } catch { /* ignore */ }
        return this.rejectWithVerifyFailure("signature-missing", UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED, manifest.version);
      }
      sigText = suppliedSignature ?? await sigResp!.text();
    } catch {
      try { fs.rmSync(finalPath, { force: true }); } catch { /* ignore */ }
      if (this.disposed) { this.cleanupPendingFiles(); return this.status(); }
      return this.rejectWithVerifyFailure("signature-missing", UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED, manifest.version);
    }
    if (this.disposed) { this.cleanupPendingFiles(); return this.status(); }

    fs.writeFileSync(`${finalPath}.sig`, sigText, "utf8");
    this.downloadedSigText = sigText;

    // The desktop invokes NsisUpdater.verifySignature; isolated service tests use the same trust gate.
    let hookError: { reason: string; message: string } | null;
    try {
      hookError = await this.runPublisherVerifyHook(finalPath, manifest.version, manifest.fileName, sigText);
    } catch {
      if (this.disposed) { this.cleanupPendingFiles(); return this.status(); }
      return this.rejectWithVerifyFailure("publisher-verification-error", undefined, manifest.version);
    }
    if (this.disposed) { this.cleanupPendingFiles(); return this.status(); }
    if (hookError !== null) {
      return this.rejectWithVerifyFailure(hookError.reason, hookError.message, manifest.version);
    }

    // Step 2: Defense-in-depth verification (计划第 9 节:任何路径都不能执行未经 Ed25519 校验的安装包，包括 publisherName 缺失、.sig 缺失、下载中断后续传的文件).
    const verified = this.verifyReadyInstallerOnDisk(finalPath, manifest.version, manifest.fileName, manifest.sha512, sigText);
    if (!verified.ok) {
      return this.rejectWithVerifyFailure(verified.reason, verified.message, manifest.version);
    }

    if (newBlockMapBytes) {
      try {
        fs.writeFileSync(path.join(this.pendingDir, "current.blockmap"), newBlockMapBytes);
      } catch {
        // ignore
      }
    }

    this.verifiedReceipt = verified.receipt;
    this.state = "ready";
    this.error = null;
    this.errorCode = null;
    this.log.record({
      actorKind: "system",
      category: "settings",
      action: "update.verified",
      objectKind: "update",
      objectId: manifest.version,
      objectLabel: manifest.version,
      summaryKey: "log.update.verified",
      summaryParams: {
        version: manifest.version,
        differential: this.usedDifferential ? 1 : 0,
        bytes: this.downloadedBytes,
      },
      outcome: "ok",
    });
    this.emitStatus();
    return this.status();
  }

  private async loadOldBlockMap(cachedPath: string, baseHref: string): Promise<BlockMapData | null> {
    if (fs.existsSync(cachedPath)) {
      try {
        return parseBlockMapBytes(fs.readFileSync(cachedPath));
      } catch {
        // try server next
      }
    }
    const oldUrl = `${baseHref}/manga-setup-${this.buildInfo.version}.exe.blockmap`;
    const check = this.validateUrlSecurity(oldUrl);
    if (!check.ok) return null;
    try {
      const resp = await this.fetchSecure(oldUrl);
      if (!resp.ok) return null;
      return parseBlockMapBytes(Buffer.from(await resp.arrayBuffer()));
    } catch {
      return null;
    }
  }

  private async downloadFullOrResume(url: string, partPath: string, finalPath: string, expectedSize: number): Promise<void> {
    let existingSize = 0;
    if (fs.existsSync(partPath)) {
      try {
        existingSize = fs.statSync(partPath).size;
      } catch {
        existingSize = 0;
      }
    }
    if (existingSize >= expectedSize) {
      existingSize = 0;
      try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
    }

    const headers: Record<string, string> = { ...this.userAgentHeader() };
    if (existingSize > 0) {
      headers.Range = `bytes=${existingSize}-`;
    }

    const response = await this.fetchSecure(url, { headers });
    if (!response.ok) {
      throw new Error(`download HTTP ${response.status}`);
    }

    const isPartial = response.status === 206 && existingSize > 0;
    if (response.status === 206 && response.headers.get("content-range") !== `bytes ${existingSize}-${expectedSize - 1}/${expectedSize}`) {
      await response.body?.cancel();
      throw new MangaError("UPDATE_VERIFY_FAILED", UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED);
    }
    const baseBytes = isPartial ? existingSize : 0;

    if (response.body && typeof (response.body as ReadableStream<Uint8Array>).getReader === "function") {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const flags = isPartial ? "a" : "w";
      const fd = fs.openSync(partPath, flags);
      let received = baseBytes;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            fs.writeSync(fd, value);
            received += value.byteLength;
            if (received > expectedSize) throw new MangaError("UPDATE_VERIFY_FAILED", UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED);
            this.downloadedBytes = received - baseBytes;
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      if (isPartial) {
        fs.appendFileSync(partPath, buf);
      } else {
        fs.writeFileSync(partPath, buf);
      }
      this.downloadedBytes = baseBytes + buf.length;
    }

    const finalStat = fs.statSync(partPath);
    if (finalStat.size !== expectedSize) {
      throw new Error(`download interrupted (${finalStat.size}/${expectedSize} bytes)`);
    }
    fs.renameSync(partPath, finalPath);
    this.emitStatus();
  }

  /**
   * Execute the publisher gate supplied by the desktop, or its isolated service-test equivalent:
   * In `electron-updater` 6.8.11, `NsisUpdater.verifySignature` reads `publisherName` from `app-update.yml`;
   * if `publisherName` is absent, `NsisUpdater.verifySignature` returns `null` without calling `verifyUpdateCodeSignature`.
   */
  private async runPublisherVerifyHook(
    installerPath: string,
    expectedVersion: string,
    expectedFileName: string,
    sigText: string,
  ): Promise<{ reason: string; message: string } | null> {
    this.verifiedByPublisherHook = false;
    if (this.verifyPublisherSignatureFn) {
      const error = await this.verifyPublisherSignatureFn(installerPath);
      if (error !== null) return { reason: "publisher-signature-failed", message: UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED };
      // The signature callback sets verifiedByPublisherHook only when actually invoked.
      return null;
    }
    if (this.requireAppUpdateConfig) {
      if (!this.appUpdateConfigPath || !fs.existsSync(this.appUpdateConfigPath)) {
        // Without app-update.yml or publisherName, NsisUpdater skips verifyUpdateCodeSignature completely.
        return null;
      }
      const yamlText = fs.readFileSync(this.appUpdateConfigPath, "utf8");
      const problems = checkAppUpdateConfig(yamlText);
      if (problems.length > 0) {
        // NsisUpdater.verifySignature returns null when publisherName is missing; our defense-in-depth catches that verifiedByPublisherHook is false!
        return null;
      }
    }

    const result = verifyReleaseInstaller({
      installerPath,
      expectedVersion,
      expectedFileName,
      sigText,
      publicKeys: this.publicKeys,
    });
    if (!result.ok) {
      return { reason: result.reason, message: result.message };
    }
    this.verifiedByPublisherHook = true;
    return null;
  }

  /**
   * Defense-in-depth check before marking an update `ready` or executing any installer (计划第 9 节, AT-160).
   */
  private verifyReadyInstallerOnDisk(
    installerPath: string,
    expectedVersion: string,
    expectedFileName: string,
    expectedManifestSha512: string | null,
    sigText?: string | null,
  ): { ok: true; receipt: VerifiedUpdateReceipt } | { ok: false; reason: string; message: string } {
    if (this.requireAppUpdateConfig) {
      if (!this.appUpdateConfigPath || !fs.existsSync(this.appUpdateConfigPath)) {
        return { ok: false, reason: "app-update-config-missing", message: UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED };
      }
      const yamlProblems = checkAppUpdateConfig(fs.readFileSync(this.appUpdateConfigPath, "utf8"));
      if (yamlProblems.length > 0) {
        return { ok: false, reason: "publisher-name-missing", message: UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED };
      }
    }
    if (!this.verifiedByPublisherHook) {
      return { ok: false, reason: "publisher-hook-bypassed", message: UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED };
    }
    const verified = verifyReleaseInstaller({
      installerPath,
      expectedVersion,
      expectedFileName,
      sigText,
      publicKeys: this.publicKeys,
    });
    if (!verified.ok) {
      return verified;
    }
    if (expectedManifestSha512 && verified.receipt.sha512 !== expectedManifestSha512) {
      return { ok: false, reason: "manifest-sha512-mismatch", message: UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED };
    }
    return verified;
  }

  /**
   * Adapter callback for `NsisUpdater.verifyUpdateCodeSignature`:
   * Returns `null` when valid, or the Chinese error message (after deleting `tempUpdateFile`) when invalid.
   */
  createNsisCodeSignatureVerifier(options: {
    expectedVersion: () => string;
    expectedFileName: () => string;
    sigText?: () => Promise<string | null> | string | null;
  }): (publisherNames: string[], tempUpdateFile: string) => Promise<string | null> {
    return async (publisherNames: string[], tempUpdateFile: string): Promise<string | null> => {
      if (!Array.isArray(publisherNames) || !publisherNames.includes("chialecode")) {
        try { fs.rmSync(tempUpdateFile, { force: true }); } catch { /* ignore */ }
        return UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED;
      }
      const sigText = options.sigText ? await options.sigText() : this.downloadedSigText;
      const result = verifyReleaseInstaller({
        installerPath: tempUpdateFile,
        expectedVersion: options.expectedVersion(),
        expectedFileName: options.expectedFileName(),
        sigText,
        publicKeys: this.publicKeys,
      });
      if (!result.ok) {
        try { fs.rmSync(tempUpdateFile, { force: true }); } catch { /* ignore */ }
        return result.message;
      }
      this.verifiedByPublisherHook = true;
      return null;
    };
  }

  /** Collect all currently busy work reasons (backend + renderer-supplied). */
  collectBusyReasons(rendererBusy: UpdateBusyReason[] = []): UpdateBusyReason[] {
    const reasons = new Set<UpdateBusyReason>();
    for (const r of rendererBusy) reasons.add(r);
    for (const r of this.isBusyFn()) reasons.add(r);
    return [...reasons];
  }

  /**
   * Execute "重启以更新" (`update.restartToUpdate`, 计划 4.3, AT-159).
   * If work is in progress and `force !== true`, returns `{ status: "busy", restarted: false, busyReasons }`.
   */
  async restartToUpdate(input: { force?: boolean; busyReasons?: UpdateBusyReason[] } = {}): Promise<UpdateRestartResult> {
    if (this.disposed || this.buildInfo.channel !== "release") {
      throw new MangaError("UPDATE_UNAVAILABLE", UPDATE_ERROR_MESSAGES.UPDATE_UNAVAILABLE);
    }
    if (this.state !== "ready" || !this.downloadedInstallerPath || !this.availableVersion) {
      throw new MangaError("VALIDATION_ERROR", "当前没有已就绪的更新包");
    }

    // Re-verify on disk before executing (计划第 9 节).
    const expectedFileName = this.pendingManifest?.fileName ?? path.basename(this.downloadedInstallerPath);
    const verified = this.verifyReadyInstallerOnDisk(
      this.downloadedInstallerPath,
      this.availableVersion,
      expectedFileName,
      this.pendingManifest?.sha512 ?? null,
    );
    if (!verified.ok) {
      this.rejectWithVerifyFailure(verified.reason, verified.message, this.availableVersion);
      throw new MangaError("UPDATE_VERIFY_FAILED", verified.message, { details: { reason: verified.reason } });
    }

    const busyReasons = this.collectBusyReasons(input.busyReasons ?? []);
    if (busyReasons.length > 0 && input.force !== true) {
      return {
        status: "busy",
        restarted: false,
        busyReasons,
        version: this.availableVersion,
      };
    }

    const installed = await this.prepareAndRunInstaller("restart", verified.receipt);
    if (!installed) throw new MangaError("UPDATE_UNAVAILABLE", "无法启动更新安装程序，已保留当前版本");
    return {
      status: "restarting",
      restarted: true,
      busyReasons: [],
      version: verified.receipt.version,
    };
  }

  /**
   * Install the ready update silently before the window closes (计划 4.3, AT-159) if not already triggered.
   */
  async installOnQuit(): Promise<boolean> {
    if (this.disposed || this.installTriggered || this.buildInfo.channel !== "release") return false;
    if (this.state !== "ready" || !this.downloadedInstallerPath || !this.availableVersion) return false;

    const expectedFileName = this.pendingManifest?.fileName ?? path.basename(this.downloadedInstallerPath);
    const verified = this.verifyReadyInstallerOnDisk(
      this.downloadedInstallerPath,
      this.availableVersion,
      expectedFileName,
      this.pendingManifest?.sha512 ?? null,
    );
    if (!verified.ok) {
      this.rejectWithVerifyFailure(verified.reason, verified.message, this.availableVersion);
      return false;
    }

    return this.prepareAndRunInstaller("quit", verified.receipt);
  }

  private async prepareAndRunInstaller(mode: "restart" | "quit", receipt: VerifiedUpdateReceipt): Promise<boolean> {
    if (this.installTriggered) return false;
    this.installTriggered = true;

    const previousPendingFrom = this.store.getMeta(META_PENDING_FROM) ?? "";
    const previousPendingNotes = this.store.getMeta(META_PENDING_NOTES) ?? "";
    try {
      await this.onBeforeInstall?.(mode);
      this.lifecycle.signal.throwIfAborted();
      const backup = this.writePreUpdateBackup(this.buildInfo.version, { refresh: true });
      if (!backup) {
        throw new MangaError("UPDATE_UNAVAILABLE", "更新前备份失败，已保留当前版本");
      }
      this.store.setMeta(META_PENDING_FROM, this.buildInfo.version);
      this.store.setMeta(META_PENDING_NOTES, this.releaseNotes ?? "");

      // Re-read the signature too: removing a .sig after download must never allow installation.
      const finalVerification = this.verifyReadyInstallerOnDisk(receipt.installerPath, receipt.version, receipt.fileName, receipt.sha512);
      if (!finalVerification.ok) {
        this.rejectWithVerifyFailure(finalVerification.reason, finalVerification.message, receipt.version);
        throw new MangaError("UPDATE_VERIFY_FAILED", finalVerification.message);
      }

      // The running version's installer becomes the way back before the new one takes its place in the cache.
      this.keepPreviousInstaller({ version: receipt.version, schemaVersion: this.targetSchemaVersion, backup });
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        fs.copyFileSync(receipt.installerPath, path.join(this.cacheDir, "installer.exe"));
        this.recordCachedInstaller(receipt.version, Buffer.from(receipt.sha512, "base64").toString("hex"));
        const pendingBlockMap = path.join(this.pendingDir, "current.blockmap");
        if (fs.existsSync(pendingBlockMap)) {
          fs.copyFileSync(pendingBlockMap, path.join(this.cacheDir, "current.blockmap"));
        }
      } catch {
        // A missing optimization cache does not prevent a verified update.
      }

      const args = ["--updated", "/S"];
      if (mode === "restart") args.push("--force-run");
      if (this.installDirectory) args.push(`/D=${this.installDirectory}`);

      const ok = await this.runInstallerFn(receipt.installerPath, args, mode, finalVerification.receipt);
      if (!ok) throw new MangaError("UPDATE_UNAVAILABLE", "无法启动更新安装程序，已保留当前版本");
      return true;
    } catch (error) {
      this.installTriggered = false;
      if (this.disposed) return false;
      this.store.setMeta(META_PENDING_FROM, previousPendingFrom);
      this.store.setMeta(META_PENDING_NOTES, previousPendingNotes);
      this.errorCode = error instanceof MangaError ? error.code : "UPDATE_UNAVAILABLE";
      this.error = error instanceof MangaError ? error.message : "更新前保存或安装失败，已保留当前版本";
      try { await this.onInstallFailed?.(mode); } catch { /* preserve the preparation or installation error */ }
      this.emitStatus();
      if (error instanceof MangaError) throw error;
      throw new MangaError("UPDATE_UNAVAILABLE", "更新前保存或安装失败，已保留当前版本");
    }
  }

  private async defaultSpawnInstaller(installerPath: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const child = spawn(installerPath, args, {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.once("error", () => resolve(false));
        child.once("spawn", () => resolve(true));
        child.unref();
      } catch { resolve(false); }
    });
  }
}
