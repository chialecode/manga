import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { contextKey, MangaError, ProfileConfigSchema, createId, validateCommandInput, type Actor, type CommandEnvelope, type CommandResult, type ContextId, type LocationLayout, type ScopeGrant } from "@manga/contracts";
import { MangaRuntime } from "@manga/kernel";
import { DrizzleStore, acquireHostLock, releaseHostLock } from "@manga/storage-drizzle";
import type { ChatMessage } from "@manga/model-protocol";
import { filterUnread, readShell } from "./reading-service.ts";
import { frontierConsumed } from "./progress-service.ts";
import { readLayout } from "./domain/revision-layout.ts";
import { WorkFolders } from "./work-folders.ts";
import { NoteFiles } from "./note-files.ts";
import { ScreenshotService, type ScreenshotView } from "./screenshots.ts";
import { displayTitle } from "./works-service.ts";
import { assertLocatorFits } from "./domain/media-anchors.ts";
import { PluginService } from "./plugins/service.ts";
import { PluginRuntime, type PluginSpawner, type RuntimeLimits } from "./plugins/runtime.ts";
import { TrustStore } from "./plugins/trust.ts";
import { nodeSpawner } from "./plugins/spawn-node.ts";
import { GrantRegistry } from "./grants.ts";
import { type CredentialVault, UnavailableVault } from "./credentials.ts";
import { persistPointer, type LaunchRequest, resolveLaunchLayout } from "./locations.ts";
import type { ParseClient } from "./parse-client.ts";
import { MediaServices, type FfmpegTools } from "./media/index.ts";
import { ComicService } from "./comic/service.ts";
import { VideoService } from "./video/service.ts";
import { BangumiClient, bangumiUserAgent, type BangumiOptions, type FetchLike } from "./metadata/bangumi.ts";
import { BangumiProvider, type OnlineProvider } from "./metadata/provider.ts";
import { CoverService } from "./metadata/covers.ts";
import { DEFAULT_MODEL_PROFILE } from "@manga/contracts/models";
import { budgetOf } from "./agent-context.ts";
import { readAgentSettings } from "./agent-settings.ts";
import { sweepAgentMedia } from "./agent-media.ts";
import { ResourceExtras } from "./metadata/extras.ts";
import { MetadataService } from "./metadata/service.ts";
import { parseOrdinalName } from "./domain/ordinal.ts";
import { CaptureService } from "./voice/capture.ts";
import type { AsrPort, LlmPort } from "./voice/ports.ts";
import { VadWorkerClient, type VadEngine } from "./voice/vad-client.ts";
import { OperationLog, LOGGED_COMMANDS, LOG_RETENTION_DAYS, LOG_RETENTION_ROWS, describeObject, type LogEntry } from "./ops/operation-log.ts";
import { redactDeep } from "./ops/redact.ts";
import { QuickTaskService } from "./quick-tasks.ts";
import { ConversationService } from "./conversations.ts";
import { WorkspaceService } from "./workspace-service.ts";
import { SidebarService } from "./sidebar-service.ts";
import { ProjectService } from "./creative/projects.ts";
import { AGENT_LOGGED_COMMANDS, AGENT_PROJECT_COMMANDS, AgentProjectAccess } from "./creative/agent-access.ts";
import { OpLog } from "./creative/ops.ts";
import { EmbedService, noteEmbedsOf } from "./creative/embeds.ts";
import { WhiteboardService } from "./creative/whiteboard.ts";
import { MindmapService } from "./creative/mindmap.ts";
import { RoughcutService } from "./creative/roughcut.ts";
import { DraftService } from "./creative/drafts.ts";
import { ResearchService } from "./creative/research.ts";
import { SemanticService } from "./semantic/service.ts";
import type { EmbeddingPort } from "./semantic/ports.ts";
import { NetworkBroker, type BrokerOptions } from "./net/broker.ts";
import { ScanService } from "./library-scan/service.ts";
import { checkOpenable, inLibrarySql, resourcesListed } from "./library-locations.ts";
import { AcquisitionService, type AcquisitionOptions } from "./acquisition/service.ts";
import { DandanClient, type DandanClientOptions } from "./danmaku/client.ts";
import type { DandanCredentials } from "./danmaku/sign.ts";
import { DanmakuService } from "./danmaku/service.ts";
import { AgentTrace } from "./agent-trace.ts";
import { AGENT_COMMANDS, AGENT_OPT_IN_COMMANDS, NOTE_CONTENT_COMMANDS, OWNER_COMMANDS } from "./commands/access.ts";
import { AgentMaterials, subtitleLimit, publicMedia, type FrozenMedia } from "./agent-materials.ts";
import { BASE_FEATURES, MEDIA_FEATURES, CREATIVE_FEATURES, CORE_FEATURES, TOOL_DESCRIPTIONS, encodeResourceCursor, safeJsonValue } from "./product-helpers.ts";
import { libraryModule } from "./commands/library.ts";
import { scanHost } from "./commands/library-io.ts";
import { comicModule, videoModule, danmakuCredentials, danmakuCredentialSource, danmakuModule, metadataToken, metadataModule } from "./commands/media.ts";
import { asrPort, llmPort, embeddingPort, voiceModule } from "./commands/voice.ts";
import { notesModule } from "./commands/notes.ts";
import { settingsModule, recoverJobs } from "./commands/settings.ts";
import { inventoryModule } from "./commands/inventory.ts";
import { agentModule } from "./commands/agent.ts";
import { projectsModule, canvasModules, semanticScope, semanticModule, pluginsModule, acquisitionModule, roughcutModule, researchModule } from "./commands/creative.ts";

export type ProductAppOptions = LaunchRequest & {
  /** The layout the desktop host resolved before Electron started (it may have moved an old profile to get it); resolved here otherwise. */
  layout?: LocationLayout;
  hostId?: string;
  crashAt?: string;
  vault?: CredentialVault;
  useParseWorker?: boolean;
  parseWorkerPath?: string;
  /** Where the packaged FFmpeg and other bundled tools live; development builds look at the local tool cache. */
  resourcesPath?: string;
  /** Replace FFmpeg discovery (tests); `null` runs without it. */
  ffmpegTools?: FfmpegTools | null;
  /** Shown to Bangumi in the User-Agent. */
  appVersion?: string;
  /** Network entry for metadata sources. The desktop host passes Electron's `net.fetch` so system proxies apply. */
  netFetch?: FetchLike;
  /** Overrides for the network broker that fetches the pages people ask to keep (tests allow their loopback server and fake name lookups here). */
  network?: Pick<BrokerOptions, "allowPrivate" | "lookup" | "timeoutMs" | "maxBytes" | "maxRedirects">;
  /** Overrides for the Bangumi client (origin, allowed hosts, retry pacing); tests aim it at a local fake server. */
  bangumi?: Partial<BangumiOptions>;
  /** More online metadata sources, for tests that swap one source for another. */
  extraMetadataProviders?: OnlineProvider[];
  /** Voice-activity engine; the desktop host and the default use the Silero worker, tests may pass a stand-in. */
  vad?: VadEngine;
  /** Transcription and text-model access for recordings; the default reads the configured connections. */
  asr?: AsrPort;
  llm?: LlmPort;
  /** Where vectors for the semantic index come from; the default reads the embedding connections. */
  embedding?: EmbeddingPort;
  /** Switches for the semantic index in tests: no vector extension, and no wait before a failed batch is tried again. */
  semantic?: { vec?: boolean; retryBaseMs?: number };
  /** Base of the transcription retry backoff, in milliseconds (tests use 0). */
  voiceRetryBaseMs?: number;
  /**
   * Plugin packages (PLUG-04): how a plugin's process is started (the desktop host starts utility processes, the default is plain Node), the folder of
   * packages that come with the application, the keys of the first party, and the runtime's limits.
   */
  plugins?: { spawn?: PluginSpawner; bundledDir?: string; firstPartyKeys?: ReadonlyArray<{ publicKey: string; label: string }>; limits?: Partial<RuntimeLimits> };
  /**
   * Danmaku (DanDanPlay open API): the application credentials built into the release (injected into the main process at build time; they never reach the
   * renderer), the API origin, and for tests the transport switches. Without credentials of its own or built-in ones, danmaku says so and sends nothing.
   */
  danmaku?: { credentials?: DandanCredentials | null; origin?: string; client?: Partial<Pick<DandanClientOptions, "allowHttp" | "extraRedirectHosts" | "timeoutMs" | "now">>; now?: () => number };
  /** Acquisition (ACQ-01—03): the network an engine may use (tests keep it to the loopback), the free-space probe, and a hook that stops a publish where a crash would. */
  acquisition?: Pick<AcquisitionOptions, "network" | "freeBytes" | "forceCopy" | "fault" | "progressPersistMs" | "progressNoticeMs">;
};

export type CreativeReg = (commandId: string, handler: (envelope: CommandEnvelope, signal: AbortSignal) => unknown, options?: { write?: boolean }) => void;

export type AppNotice = { topic: string; payload: Record<string, unknown> };

export class MangaProductApp {
  readonly runtime: MangaRuntime;
  readonly store: DrizzleStore;
  readonly grants: GrantRegistry;
  readonly layout: LocationLayout;
  readonly media: MediaServices;
  readonly comics: ComicService;
  readonly videos: VideoService;
  readonly covers: CoverService;
  readonly extras: ResourceExtras;
  readonly metadata: MetadataService;
  readonly danmaku: DanmakuService;
  readonly dandan: DandanClient;
  readonly voice: CaptureService;
  readonly materials: AgentMaterials;
  readonly log: OperationLog;
  readonly quickTasks: QuickTaskService;
  readonly projects: ProjectService;
  readonly agentAccess: AgentProjectAccess;
  readonly creativeOps: OpLog;
  readonly embeds: EmbedService;
  readonly whiteboards: WhiteboardService;
  readonly mindmaps: MindmapService;
  readonly roughcuts: RoughcutService;
  readonly drafts: DraftService;
  readonly research: ResearchService;
  readonly semantic: SemanticService;
  readonly conversations: ConversationService;
  readonly workspaces: WorkspaceService;
  readonly sidebar: SidebarService;
  readonly scan: ScanService;
  readonly plugins: PluginService;
  readonly pluginRuntime: PluginRuntime;
  readonly acquisition: AcquisitionService;
  private readonly vadEngine: VadEngine;
  readonly onlineProviders: OnlineProvider[];
  private readonly noticeListeners = new Set<(notice: AppNotice) => void>();
  readonly uiFacets = new Set<string>();
  private readonly lock;
  readonly vault: CredentialVault;
  private readonly pending = new Map<string, { actorId: string; actorKind: string; sessionId: string | null; runId: string | null; work: Promise<CommandResult> }>();
  parseWorker: ParseClient | undefined;
  readonly parseWorkerPath: string | undefined;
  readonly wantParseWorker: boolean;
  parseGeneration = 0;
  scanAbort: AbortController | undefined;
  exportAbort: AbortController | undefined;
  readonly runAbort = new Map<string, AbortController>();
  /** The folders the files made for works live in: screenshots, recordings, rough cuts, exports (A-79). */
  readonly workFolders: WorkFolders;
  readonly noteFiles: NoteFiles;
  readonly screenshots: ScreenshotService;
  readonly pathResolved = new Map<string, string>();
  readonly secrets = new Map<string, string>();
  readonly builtinDanmakuCredentials: DandanCredentials | null;
  readonly trace: AgentTrace;
  sealed = false;
  closed = false;
  private layoutTask: Promise<void> | null = null;
  private readonly mediaSweepTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(options: ProductAppOptions) {
    this.layout = options.layout ?? resolveLaunchLayout(options);
    if (!this.layout.writable) {
      throw new MangaError("LOCATION_UNAVAILABLE", "profile data directory is not writable", {
        details: { recovery: this.layout.recovery },
      });
    }
    for (const dir of Object.values(this.layout.partitions)) fs.mkdirSync(dir, { recursive: true });
    persistPointer(this.layout);
    this.vault = options.vault ?? new UnavailableVault();
    const hostId = options.hostId ?? "product";
    this.lock = acquireHostLock(this.layout.partitions.data, hostId);
    try {
      this.store = new DrizzleStore({
        profileDir: this.layout.partitions.data,
        hostId,
        crashAt: options.crashAt,
        attachmentsDir: this.layout.partitions.attachments,
        resourcesDir: this.layout.partitions.resources,
        worksDir: this.layout.partitions.works,
      });
    } catch (error) {
      releaseHostLock(this.layout.partitions.data, hostId);
      throw error;
    }
    this.workFolders = new WorkFolders(this.store);
    this.noteFiles = new NoteFiles(this.store, this.workFolders, { onError: (reason) => this.reportWorkFiles(reason) });
    this.screenshots = new ScreenshotService(this.store, this.workFolders, (topic, payload) => this.notify(topic, payload));
    this.grants = new GrantRegistry(this.store);
    this.media = new MediaServices({ cacheDir: this.layout.partitions.cache, resourcesPath: options.resourcesPath, tools: options.ffmpegTools });
    this.comics = new ComicService(this.store, this.media);
    this.videos = new VideoService(this.store, this.media);
    this.covers = new CoverService(this.store, this.media);
    this.extras = new ResourceExtras(this.store, this.media, this.comics, this.videos, this.covers);
    this.log = new OperationLog(this.store);
    this.trace = new AgentTrace(this.store, () => readAgentSettings(this.store).trace);
    this.quickTasks = new QuickTaskService(this.store);
    this.projects = new ProjectService(this.store, (featureId) => this.featureEnabled(featureId));
    this.agentAccess = new AgentProjectAccess(this.store, this.projects, this.grants);
    this.creativeOps = new OpLog(this.store);
    this.embeds = new EmbedService(this.store, { featureOn: (featureId) => this.featureEnabled(featureId) });
    this.whiteboards = new WhiteboardService(this.store, this.creativeOps, this.embeds, (featureId) => this.featureEnabled(featureId));
    this.mindmaps = new MindmapService(this.store, this.creativeOps, this.embeds, (featureId) => this.featureEnabled(featureId));
    this.roughcuts = new RoughcutService({
      store: this.store, ops: this.creativeOps, videos: this.videos, ffmpeg: this.media.ffmpeg, folders: this.workFolders, stagingRoot: path.join(this.layout.partitions.cache, "roughcut"),
      notify: (topic, payload) => this.notify(topic, payload),
    });
    this.drafts = new DraftService(this.store, {
      llm: () => options.llm ?? llmPort(this), featureOn: (featureId) => this.featureEnabled(featureId), notify: (topic, payload) => this.notify(topic, payload),
      projectConnection: (projectId) => (this.store.sqlite.prepare("SELECT model_connection_id AS id FROM projects WHERE id = ?").get(projectId) as { id: string | null } | undefined)?.id ?? null,
    });
    this.research = new ResearchService(this.store, {
      broker: new NetworkBroker({ fetch: options.netFetch, userAgent: `MANGA/${options.appVersion ?? "0.0.0"} (local reader)`, ...options.network }),
      featureOn: (featureId) => this.featureEnabled(featureId),
    });
    this.semantic = new SemanticService(this.store, {
      embedding: () => options.embedding ?? embeddingPort(this), notify: (topic, payload) => this.notify(topic, payload), featureOn: (featureId) => this.featureEnabled(featureId),
      projectScope: (projectId) => semanticScope(this, projectId), ...options.semantic,
    });
    this.conversations = new ConversationService(this.store);
    this.workspaces = new WorkspaceService(this.store);
    this.sidebar = new SidebarService(this.store);
    this.pluginRuntime = new PluginRuntime({ spawn: options.plugins?.spawn ?? nodeSpawner, limits: options.plugins?.limits });
    this.plugins = new PluginService({
      store: this.store, pluginsDir: path.join(this.layout.partitions.data, "plugins"), dataDir: path.join(this.layout.partitions.data, "plugin-data"),
      bundledDir: options.plugins?.bundledDir, appVersion: options.appVersion ?? "0.0.0", trust: new TrustStore(this.store, options.plugins?.firstPartyKeys), runtime: this.pluginRuntime,
      notify: (topic, payload) => this.notify(topic, payload),
    });
    this.scan = new ScanService({ store: this.store, host: scanHost(this) });
    this.acquisition = new AcquisitionService({
      store: this.store, plugins: this.plugins, runtime: this.pluginRuntime, scan: this.scan, stagingRoot: path.join(this.layout.partitions.downloads, "acquisition"),
      notify: (topic, payload) => this.notify(topic, payload), ...options.acquisition,
    });
    if (this.store.migration) {
      this.log.record({ actorKind: "system", category: "backup", action: "migration", summaryKey: "log.migration", summaryParams: { from: this.store.migration.from, to: this.store.migration.to, covers: this.store.migration.coversImported }, outcome: "ok" });
    }
    const bangumiClient = new BangumiClient({
      fetch: options.netFetch ?? ((url, init) => fetch(url, init as RequestInit)),
      userAgent: bangumiUserAgent(options.appVersion ?? "0.0.0"),
      token: () => metadataToken(this, "bangumi"),
      ...options.bangumi,
    });
    this.onlineProviders = [new BangumiProvider(bangumiClient, options.bangumi?.apiOrigin), ...(options.extraMetadataProviders ?? [])];
    this.metadata = new MetadataService({
      store: this.store, media: this.media, covers: this.covers, extras: this.extras,
      providers: () => this.onlineProviders,
      credentials: { remove: (ref) => { this.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(ref); } },
      notify: (topic, payload) => this.notify(topic, payload),
    });
    this.builtinDanmakuCredentials = options.danmaku?.credentials ?? null;
    this.dandan = new DandanClient({
      fetch: options.netFetch ?? ((url, init) => fetch(url, init as RequestInit)),
      credentials: () => danmakuCredentials(this),
      userAgent: `MANGA/${options.appVersion ?? "0.0.0"} (local reader)`,
      origin: options.danmaku?.origin,
      ...options.danmaku?.client,
    });
    this.danmaku = new DanmakuService({
      store: this.store, videos: this.videos, client: this.dandan, credentialSource: () => danmakuCredentialSource(this),
      suggestedQuery: (workId) => this.suggestedQuery(workId), now: options.danmaku?.now,
    });
    this.vadEngine = options.vad ?? new VadWorkerClient({ resourcesPath: options.resourcesPath });
    this.voice = new CaptureService({
      store: this.store, media: this.media, vad: this.vadEngine,
      asr: options.asr ?? asrPort(this), llm: options.llm ?? llmPort(this),
      notify: (topic, payload) => this.notify(topic, payload),
      validateLocator: (revisionId, locator) => assertLocatorFits(this.store, revisionId, locator),
      retryBaseMs: options.voiceRetryBaseMs,
    });
    this.materials = new AgentMaterials({ store: this.store, grants: this.grants, comics: this.comics, videos: this.videos, voice: this.voice, spoilerGuard: () => readShell(this.store).spoilerGuard });
    this.media.jobs.onChange((job) => {
      if (job.kind === "play-copy" || job.kind === "frame-index" || job.kind === "capture-filter" || job.kind === "capture-asr" || job.kind === "capture-organize") this.notify("job.changed", { jobId: job.id, kind: job.kind, key: job.key, state: job.state, progress: job.progress, error: job.error });
    });
    // The old place a first start moved the profile from (计划 4.9): remembered so settings can offer to clean it, once the person agrees.
    if (this.layout.upgrade?.state === "migrated") {
      this.store.setMeta("legacyLocation", JSON.stringify({ root: this.layout.upgrade.from, carried: this.layout.upgrade.carried, at: new Date().toISOString(), cleaned: false }));
    }
    this.store.setMeta("layoutConfig", JSON.stringify({
      pointerPath: this.layout.pointerPath,
      partitions: this.layout.overrides,
      profileRoot: this.layout.defaultRoot,
    }));
    this.runtime = new MangaRuntime([
      libraryModule(this),
      notesModule(this),
      settingsModule(this),
      inventoryModule(this),
      agentModule(this),
      comicModule(this),
      videoModule(this),
      metadataModule(this),
      danmakuModule(this),
      voiceModule(this),
      projectsModule(this),
      ...canvasModules(this),
      researchModule(this),
      semanticModule(this),
      pluginsModule(this),
      acquisitionModule(this),
      roughcutModule(this),
    ], {
      hostFacets: ["service", "ui", "worker"],
      trustedScope: (actor, handle) => this.grants.trustedScope(actor, handle),
      isCommandAdmitted: (_commandId, envelope) => {
        const grant = this.grants.get(envelope.scopeHandle);
        if (!grant || grant.revoked) return false;
        return grant.allowedCommands.includes(envelope.commandId);
      },
    });
    this.parseWorkerPath = options.parseWorkerPath;
    this.wantParseWorker = options.useParseWorker === true;
  }

  async start(): Promise<void> {
    const saved = this.store.getMeta("lastValidProfile");
    let profile = saved ? ProfileConfigSchema.parse(JSON.parse(saved)) : {
      profileId: "default",
      revision: 1,
      enabledFeatures: [...BASE_FEATURES, ...MEDIA_FEATURES, ...CREATIVE_FEATURES],
      disabledFeatures: [],
      preferredProviders: {},
    };
    // A profile saved before a feature existed never mentioned it: switch it on unless the owner turned it off.
    const knownFeatures = new Set(this.runtime.getManifests().map((manifest) => manifest.featureId));
    const missing = [...MEDIA_FEATURES, ...CREATIVE_FEATURES].filter((id) => !profile.enabledFeatures.includes(id) && !profile.disabledFeatures.includes(id) && knownFeatures.has(id));
    if (missing.length) profile = { ...profile, revision: profile.revision + 1, enabledFeatures: [...profile.enabledFeatures, ...missing] };
    await this.runtime.applyProfile(profile);
    if (this.featureEnabled("semantic")) this.semantic.recover();
    this.store.setMeta("lastValidProfile", JSON.stringify(this.runtime.snapshot().lastValidProfile ?? profile));
    // No run loop survives a process boundary: anything still "running" in the database is stale.
    this.interruptRuns("host restarted before the run finished");
    this.store.replayUnpublished();
    this.noteFiles.attach();
    this.settleWorkFiles();
  }

  private reportWorkFiles(reason: string): void {
    try { this.log.record({ actorKind: "system", category: "library", action: "workFiles", summaryKey: "log.workFilesFailed", summaryParams: { reason }, outcome: "error" }); } catch { /* the log may be closed */ }
  }

  /** Finish what a stop left half done in the folders of the works, then bring recordings kept before those folders into them (A-79). */
  private settleWorkFiles(): void {
    try {
      this.workFolders.resumeMoves();
      this.workFolders.migrateRecordings(this.layout.partitions.attachments);
    } catch (error) {
      this.reportWorkFiles(error instanceof Error ? error.message : String(error));
    }
    this.layoutTask = this.settleLayout();
  }

  /**
   * After the schema moved to v11 the files made so far are put where the rule gives them and the notes are written as files (A-88). It runs after
   * the start, in the background, in batches; the marker `workLayout` stays `pending` until all of it is done, so a stop in the middle is
   * redone at the next start, and a second run changes nothing.
   */
  private async settleLayout(): Promise<void> {
    if (this.store.getMeta("workLayout") !== "pending") return;
    try {
      const moved = await this.workFolders.settleAll({ stop: () => this.closed });
      if (!moved.finished) return;
      const notes = await this.noteFiles.syncAll({ stop: () => this.closed });
      if (!notes.finished || this.closed) return;
      this.store.setMeta("workLayout", "settled");
      this.log.record({ actorKind: "system", category: "library", action: "workLayout", summaryKey: "log.workLayoutSettled", summaryParams: { moved: moved.moved, notes: notes.written }, outcome: "ok" });
    } catch (error) {
      if (!this.closed) this.reportWorkFiles(error instanceof Error ? error.message : String(error));
    }
  }

  /** The background reflow of the folders, for a caller that has to wait for it (tests, the smoke run). */
  async whenLayoutSettled(): Promise<void> {
    await this.layoutTask;
  }

  /** Recordings that arrived in a package are kept in the attachments; each is moved into the folder of its work. */
  settleImportedRecordings(): void {
    try { this.workFolders.migrateRecordings(this.layout.partitions.attachments, { keepOriginal: false }); } catch (error) {
      this.reportWorkFiles(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * What was made for some resources or a work goes where the rule puts it now (A-88): after a link or an unlink, a resource moved to another work,
   * an entry deleted. The notes follow, and are written again with their new source. A failure is reported to the log and does not undo the change.
   */
  followFiles(scope: { workId?: string; workIds?: string[]; resourceIds?: string[] }): void {
    try {
      this.workFolders.settle(scope);
      this.noteFiles.syncScope(scope);
    } catch (error) {
      this.reportWorkFiles(error instanceof Error ? error.message : String(error));
    }
  }

  /** Start the timed library scans; the desktop host calls this once the window is up. Tests and tools that only read do not. */
  startScheduler(): void {
    this.scan.startScheduler();
    // The pictures of ended tasks are let go after the retention period: once shortly after the start, when the window has settled, then every day (计划 4.4).
    const sweep = () => { if (!this.closed) this.sweepAgentMedia(); };
    this.mediaSweepTimers.push(setTimeout(sweep, 30_000), setInterval(sweep, 86_400_000));
    for (const timer of this.mediaSweepTimers) timer.unref?.();
  }

  /** One pass of the clean-up of frozen task pictures; `now` is for the tests and the window observation that move the clock. */
  sweepAgentMedia(now = Date.now()): { runs: number; removed: number } {
    try {
      return sweepAgentMedia(this.store, readAgentSettings(this.store).media, now);
    } catch {
      return { runs: 0, removed: 0 };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.noteFiles.dispose();
    for (const timer of this.mediaSweepTimers.splice(0)) clearTimeout(timer);
    this.scan.dispose();
    this.acquisition.dispose();
    void this.roughcuts.dispose();
    this.drafts.close();
    this.semantic.close();
    this.pluginRuntime.killAll();
    this.interruptRuns("host closed while the run was in progress");
    this.parseWorker?.kill();
    this.voice.pipeline.abortAll();
    this.media.dispose();
    this.vadEngine.dispose();
    this.store.close();
    releaseHostLock(this.layout.partitions.data, this.lock.hostId);
  }

  /** Abort live run loops and persist `interrupted` for every unfinished run so a reopen never shows a phantom `running`. */
  interruptRuns(reason: string): number {
    for (const controller of this.runAbort.values()) controller.abort();
    return this.store.sqlite.prepare("UPDATE agent_runs SET status = 'interrupted', error_json = ?, updated_at = ? WHERE status IN ('queued','running','waiting_input')").run(
      JSON.stringify({ code: "INTERRUPTED", message: reason, retryable: true, details: {} }),
      new Date().toISOString(),
    ).changes;
  }

  issueOwnerGrant(actor: Actor): ScopeGrant {
    const snapshot = this.runtime.snapshot();
    return this.grants.issue({
      actor,
      allowedCommands: OWNER_COMMANDS,
      access: "owner",
      readResourceIds: [],
      writeResourceIds: [],
      writeObjectIds: [],
      allowCreateObjects: true,
      pathHandles: [],
      moduleEpoch: 1,
      bindingEpoch: 1,
      registryGeneration: snapshot.registryGeneration,
    });
  }

  issueAgentGrant(owner: ScopeGrant, actor: Actor, input: { sessionId?: string; runId?: string; readResourceIds: string[]; allowCommands?: string[]; projectId?: string | null }): ScopeGrant {
    return this.grants.issue({
      actor,
      sessionId: input.sessionId,
      runId: input.runId,
      // The network commands are not part of the standing set: the user adds them for one task, and only commands the task may ever use are accepted.
      allowedCommands: [...AGENT_COMMANDS, ...(input.projectId ? AGENT_PROJECT_COMMANDS : []), ...(input.allowCommands ?? []).filter((commandId) => AGENT_OPT_IN_COMMANDS.includes(commandId))],
      access: "enumerated",
      readResourceIds: input.readResourceIds,
      writeResourceIds: [],
      writeObjectIds: [],
      allowCreateObjects: true,
      pathHandles: [...owner.pathHandles],
      moduleEpoch: owner.moduleEpoch,
      bindingEpoch: owner.bindingEpoch,
      registryGeneration: owner.registryGeneration,
    });
  }

  registerPath(purpose: ScopeGrant["pathHandles"] extends string[] ? "file" | "directory" | "export" | "import" | "profile" : never, resolvedPath: string): string {
    const id = createId("path");
    this.store.sqlite.prepare("INSERT INTO path_handles(id, purpose, resolved_path, created_at) VALUES (?,?,?,?)").run(id, purpose, resolvedPath, new Date().toISOString());
    this.pathResolved.set(id, resolvedPath);
    return id;
  }

  stashSecret(plain: string): string {
    if (plain.length < 1 || plain.length > 4096) throw new MangaError("VALIDATION_ERROR", "credential payload is invalid");
    const id = createId("sec");
    this.secrets.set(id, plain);
    return id;
  }

  resolvePath(handle: string): string {
    const stored = this.store.sqlite.prepare("SELECT resolved_path FROM path_handles WHERE id = ?").get(handle) as { resolved_path: string } | undefined;
    if (!stored) throw new MangaError("FORBIDDEN", "path handle is not authorized");
    return stored.resolved_path;
  }

  /** Whether the profile wants a feature on right now; a reference to something a switched-off feature owns shows a placeholder instead. */
  featureEnabled(featureId: string): boolean {
    const profile = this.runtime.snapshot().lastValidProfile;
    return !profile || (profile.enabledFeatures.includes(featureId) && !profile.disabledFeatures.includes(featureId));
  }

  /** The modules the user can switch: what each is, whether the profile wants it on, and what it is doing now. */
  listModules(): { modules: Array<{ featureId: string; moduleId: string; displayName: string; wanted: boolean; state: string; core: boolean }> } {
    const snapshot = this.runtime.snapshot();
    const profile = snapshot.lastValidProfile;
    const wanted = (featureId: string) => !profile || (profile.enabledFeatures.includes(featureId) && !profile.disabledFeatures.includes(featureId));
    return {
      modules: this.runtime.getManifests().map((manifest) => ({
        featureId: manifest.featureId,
        moduleId: manifest.moduleId,
        displayName: manifest.displayName,
        wanted: wanted(manifest.featureId),
        state: snapshot.modules[manifest.moduleId]?.state ?? "discovered",
        core: CORE_FEATURES.has(manifest.featureId),
      })),
    };
  }

  /**
   * Switch one feature on or off by applying the profile with that change. The planner refuses a switch another
   * enabled feature depends on, and a failed activation rolls back to the profile that worked; either way the
   * profile that is saved is the one that is running.
   */
  async setModule(envelope: CommandEnvelope) {
    this.assertWritable();
    const { featureId, enabled } = envelope.input as { featureId: string; enabled: boolean };
    if (!this.runtime.getManifests().some((manifest) => manifest.featureId === featureId)) throw new MangaError("NOT_FOUND", "unknown module", { details: { featureId } });
    if (!enabled && CORE_FEATURES.has(featureId)) throw new MangaError("VALIDATION_ERROR", "this module is needed to run the app and cannot be turned off", { details: { featureId, reason: "core" } });
    const current = this.runtime.snapshot().lastValidProfile;
    if (!current) throw new MangaError("ACTIVATION_FAILED", "the app has no running profile yet");
    const on = new Set(current.enabledFeatures);
    const off = new Set(current.disabledFeatures);
    if (enabled) { on.add(featureId); off.delete(featureId); } else { on.delete(featureId); off.add(featureId); }
    const next = { ...current, revision: current.revision + 1, enabledFeatures: [...on], disabledFeatures: [...off] };
    await this.runtime.applyProfile(next);
    this.store.setMeta("lastValidProfile", JSON.stringify(this.runtime.snapshot().lastValidProfile ?? next));
    return this.listModules();
  }

  assertWritable(): void {
    if (this.sealed) throw new MangaError("RESTART_REQUIRED", "profile location changed; restart to open the authoritative library");
  }

  private grantFingerprint(grant: ScopeGrant): string {
    return createHash("sha256").update(JSON.stringify({
      access: grant.access,
      allowedCommands: grant.allowedCommands,
      readResourceIds: grant.readResourceIds,
      writeResourceIds: grant.writeResourceIds,
      writeObjectIds: grant.writeObjectIds,
      allowCreateObjects: grant.allowCreateObjects,
    })).digest("hex");
  }

  private assertIdempotentReplay(existing: CommandResult, envelope: CommandEnvelope, grant: ScopeGrant, request: {
    actor_kind: string | null;
    actor_id: string | null;
    session_id: string | null;
    run_id: string | null;
    grant_fingerprint: string | null;
  }): void {
    if (request.actor_kind !== envelope.actor.kind || request.actor_id !== envelope.actor.id) {
      throw new MangaError("FORBIDDEN", "idempotency key belongs to a different actor");
    }
    if (request.session_id !== (grant.sessionId ?? null) || request.run_id !== (grant.runId ?? null)) {
      throw new MangaError("FORBIDDEN", "idempotency key belongs to a different task");
    }
    this.grants.assertCommand(grant, envelope.commandId);
    if (!this.runtime.gateway.has(envelope.commandId)) {
      throw new MangaError("CAPABILITY_UNAVAILABLE", `command ${envelope.commandId} is not admitted`);
    }
    const value = existing.value as { objectId?: string; resourceId?: string } | undefined;
    if (grant.access === "enumerated") {
      if (value?.objectId && !this.grants.canWriteObject(grant, value.objectId)) {
        throw new MangaError("SCOPE_DENIED", "replayed object is outside the current authorization");
      }
      if (value?.resourceId && !this.grants.canRead(grant, value.resourceId)) {
        throw new MangaError("SCOPE_DENIED", "replayed resource is outside the current authorization");
      }
    }
    if (!request.grant_fingerprint) throw new MangaError("FORBIDDEN", "legacy receipt has no verifiable authorization binding");
    if (request.grant_fingerprint !== this.grantFingerprint(grant)) {
      // A successful creation extends the same run's writable object set. Only an object receipt
      // can survive this change, after checking that the object is still authorized above.
      const authorizedObjectReceipt = envelope.commandId.startsWith("notes.") && value?.objectId && this.grants.canWriteObject(grant, value.objectId);
      if (!authorizedObjectReceipt) throw new MangaError("SCOPE_DENIED", "authorization changed since the original result");
    }
  }

  /**
   * Every command passes through here. The result is written to the operation log afterwards, by this one place, so a handler cannot
   * forget it and a failed command is recorded as failed. A replay of a command that already ran is not logged a second time.
   */
  async call(actor: Actor, untrusted: unknown, grantHandle: string, requestId?: string): Promise<CommandResult> {
    const result = await this.callInner(actor, untrusted, grantHandle, requestId);
    try { this.syncNoteEmbeds(untrusted, result); } catch { /* the embed relation is derived from the note and is read again by the next change */ }
    try { this.logCommand(actor, untrusted, grantHandle, requestId, result); } catch { /* the log must never turn a finished command into an error */ }
    return result;
  }

  /** After a command that changed a note's blocks, the embeds the note holds are made to match them, so backlinks and states never lag the text. */
  private syncNoteEmbeds(untrusted: unknown, result: CommandResult): void {
    if (this.closed || result.status !== "ok" || result.idempotentReplay) return;
    const raw = untrusted && typeof untrusted === "object" ? untrusted as { commandId?: unknown; input?: { objectId?: unknown } } : {};
    if (typeof raw.commandId !== "string" || !NOTE_CONTENT_COMMANDS.has(raw.commandId)) return;
    const value = result.value && typeof result.value === "object" ? result.value as { objectId?: unknown } : {};
    const objectId = typeof raw.input?.objectId === "string" ? raw.input.objectId : typeof value.objectId === "string" ? value.objectId : null;
    if (!objectId) return;
    const row = this.store.sqlite.prepare("SELECT payload_json FROM content_objects WHERE id = ? AND type = 'notes.document'").get(objectId) as { payload_json: string } | undefined;
    if (!row) return;
    const blocks = (JSON.parse(row.payload_json) as { blocks?: Array<{ id?: string; type?: string; attrs?: Record<string, unknown> }> }).blocks ?? [];
    const wanted = noteEmbedsOf(blocks);
    const have = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM embeds WHERE source_kind = 'note' AND source_id = ?").get(objectId) as { n: number }).n;
    if (!wanted.length && !have) return;
    this.store.sqlite.transaction(() => { this.embeds.sync("note", objectId, wanted, { strictCycles: false }); })();
  }

  private logCommand(actor: Actor, untrusted: unknown, grantHandle: string, requestId: string | undefined, result: CommandResult): void {
    if (this.closed) return;
    const raw = untrusted && typeof untrusted === "object" ? untrusted as { commandId?: unknown; input?: unknown } : {};
    const commandId = typeof raw.commandId === "string" ? raw.commandId : "";
    const category = LOGGED_COMMANDS[commandId] ?? (actor.kind === "agent" ? AGENT_LOGGED_COMMANDS[commandId] : undefined);
    if (!category || result.idempotentReplay) return;
    const grant = this.grants.get(grantHandle);
    const subject = describeObject(this.store, raw.input, result.status === "ok" ? result.value : undefined);
    const value = result.status === "ok" && result.value && typeof result.value === "object" ? result.value as Record<string, unknown> : {};
    const params: Record<string, number | string> = {};
    if (Array.isArray(value.resources)) params.count = value.resources.length;
    if (value.duplicate === true) params.duplicate = 1;
    if (typeof raw.input === "object" && raw.input && typeof (raw.input as { enabled?: unknown }).enabled === "boolean") params.enabled = (raw.input as { enabled: boolean }).enabled ? 1 : 0;
    this.log.record({
      actorKind: actor.kind === "agent" ? "agent" : actor.kind === "user" ? "user" : "system",
      actorId: actor.id,
      runId: grant?.runId ?? null,
      category,
      action: commandId,
      objectKind: subject?.kind ?? null,
      objectId: subject?.id ?? null,
      objectLabel: subject?.label ?? null,
      summaryKey: `log.${commandId}`,
      summaryParams: params,
      outcome: result.status === "ok" ? "ok" : "error",
      errorCode: result.error?.code ?? null,
      requestId: requestId ?? null,
    });
  }

  private async callInner(actor: Actor, untrusted: unknown, grantHandle: string, requestId?: string): Promise<CommandResult> {
    try {
      const envelope = this.runtime.gateway.sealFromTrusted({ untrusted, actor, scopeHandle: grantHandle, requestId });
      envelope.input = validateCommandInput(envelope.commandId, envelope.input);
      const grant = this.grants.get(grantHandle);
      if (!grant) throw new MangaError("FORBIDDEN", "unknown authorization handle");
      this.grants.assertCommand(grant, envelope.commandId);
      if (grant.actor.kind !== actor.kind || grant.actor.id !== actor.id) throw new MangaError("FORBIDDEN", "actor does not match grant");
      const inputHash = createHash("sha256").update(JSON.stringify(envelope.input)).digest("hex");
      const request = this.store.sqlite.prepare("SELECT command_id, input_hash, actor_kind, actor_id, session_id, run_id, grant_fingerprint FROM command_requests WHERE idempotency_key = ?").get(envelope.idempotencyKey) as {
        command_id: string;
        input_hash: string;
        actor_kind: string | null;
        actor_id: string | null;
        session_id: string | null;
        run_id: string | null;
        grant_fingerprint: string | null;
      } | undefined;
      if (request && (request.command_id !== envelope.commandId || request.input_hash !== inputHash)) {
        throw new MangaError("VALIDATION_ERROR", "idempotency key reused with a different command or input");
      }
      if (request && (request.actor_kind !== actor.kind || request.actor_id !== actor.id)) {
        throw new MangaError("FORBIDDEN", "idempotency key belongs to a different actor");
      }
      if (request && (request.session_id !== (grant.sessionId ?? null) || request.run_id !== (grant.runId ?? null))) {
        throw new MangaError("FORBIDDEN", "idempotency key belongs to a different task");
      }
      const existing = this.store.loadIdempotent(envelope.idempotencyKey);
      if (existing && !request) throw new MangaError("FORBIDDEN", "legacy receipt has no trusted request binding");
      this.store.sqlite.prepare("INSERT OR IGNORE INTO command_requests(idempotency_key,command_id,input_hash,actor_kind,actor_id,grant_handle,session_id,run_id,registry_generation,grant_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
        envelope.idempotencyKey,
        envelope.commandId,
        inputHash,
        actor.kind,
        actor.id,
        grant.handle,
        grant.sessionId ?? null,
        grant.runId ?? null,
        grant.registryGeneration,
        this.grantFingerprint(grant),
      );
      if (existing) {
        const stored = this.store.sqlite.prepare("SELECT actor_kind, actor_id, session_id, run_id, grant_fingerprint FROM command_requests WHERE idempotency_key = ?").get(envelope.idempotencyKey) as {
          actor_kind: string | null;
          actor_id: string | null;
          session_id: string | null;
          run_id: string | null;
          grant_fingerprint: string | null;
        };
        this.assertIdempotentReplay(existing, envelope, grant, stored);
        return { ...existing, idempotentReplay: true };
      }
      const pending = this.pending.get(envelope.idempotencyKey);
      if (pending) {
        if (pending.actorKind !== actor.kind || pending.actorId !== actor.id) {
          throw new MangaError("FORBIDDEN", "idempotency key is already in flight for another actor");
        }
        if ((pending.sessionId || pending.runId) && (pending.sessionId !== (grant.sessionId ?? null) || pending.runId !== (grant.runId ?? null))) {
          throw new MangaError("FORBIDDEN", "idempotency key is already in flight for another task");
        }
        const result = await pending.work;
        const currentGrant = this.grants.get(grantHandle);
        if (!currentGrant || !request) throw new MangaError("FORBIDDEN", "authorization is no longer available");
        this.assertIdempotentReplay(result, envelope, currentGrant, request);
        return result;
      }
      const work = this.runtime.gateway.execute(envelope);
      this.pending.set(envelope.idempotencyKey, {
        actorId: actor.id,
        actorKind: actor.kind,
        sessionId: grant.sessionId ?? null,
        runId: grant.runId ?? null,
        work,
      });
      try {
        return await work;
      } finally {
        this.pending.delete(envelope.idempotencyKey);
      }
    } catch (error) {
      return {
        status: "error",
        error: error instanceof MangaError ? error.toJSON() : { code: "VALIDATION_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false, details: {} },
      };
    }
  }

  /** What a work should be searched for: the cleaned title; for a video the series name parsed out of the first file name (release group, resolution and episode number removed). */
  suggestedQuery(workId: string): string {
    const work = this.store.sqlite.prepare("SELECT title, media_kind, projection_json FROM works WHERE id = ?").get(workId) as { title: string; media_kind: string; projection_json: string } | undefined;
    if (!work) return "";
    if (work.media_kind === "video") {
      const first = this.store.sqlite.prepare(`SELECT fl.relative_path AS file FROM resources r
        JOIN resource_revisions v ON v.resource_id = r.id JOIN file_locations fl ON fl.resource_revision_id = v.id
        WHERE r.work_id = ? ORDER BY r.sort_key, r.rowid LIMIT 1`).get(workId) as { file: string } | undefined;
      const parsed = first ? parseOrdinalName(path.basename(first.file), "video").title?.trim() : undefined;
      if (parsed) return parsed;
    }
    return displayTitle(work).trim();
  }

  workspace() {
    const notes = this.store.sqlite.prepare("SELECT id, revision, title, tags_json, payload_json, updated_at AS updatedAt FROM content_objects WHERE type = 'notes.document' AND deleted_at IS NULL ORDER BY updated_at DESC").all() as Array<{ id: string; revision: number; title: string; tags_json: string; payload_json: string; updatedAt: string }>;
    // One row more than the page shows tells the reader whether older resources exist; the cursor in
    // resourcePage keeps everything past this window reachable through library.list.
    const resourceRows = this.store.sqlite.prepare(`SELECT r.id, r.title, r.created_at AS createdAt, v.id AS revisionId FROM resources r
      LEFT JOIN resource_revisions v ON v.id = (SELECT v2.id FROM resource_revisions v2 WHERE v2.resource_id = r.id ORDER BY v2.created_at DESC, v2.rowid DESC LIMIT 1)
      WHERE ${inLibrarySql("r")} ORDER BY r.created_at DESC, r.id DESC LIMIT 101`).all() as Array<{ id: string; title: string; createdAt: string; revisionId: string | null }>;
    const resources = resourceRows.slice(0, 100);
    const resourceTotal = (this.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM resources r WHERE ${inLibrarySql("r")}`).get() as { n: number }).n;
    const sessions = this.store.sqlite.prepare("SELECT id, title, kind, target_id AS targetId, project_id AS contextId, created_at AS createdAt, updated_at AS updatedAt FROM agent_sessions ORDER BY updated_at DESC").all();
    const runs = this.store.sqlite.prepare("SELECT id, session_id AS sessionId, status, grant_handle AS grantHandle, input_text AS inputText, created_at AS createdAt, updated_at AS updatedAt FROM agent_runs ORDER BY created_at DESC LIMIT 50").all();
    const refs = this.store.sqlite.prepare(`SELECT r.from_object_id AS objectId, r.from_block_id AS blockId, r.to_id AS anchorId, a.resource_id AS resourceId
      FROM refs r JOIN anchors a ON a.id = r.to_id WHERE r.to_kind = 'anchor'`).all() as Array<{ objectId: string; blockId: string | null; anchorId: string; resourceId: string }>;
    return {
      notes: notes.map((row) => {
        const own = refs.filter((ref) => ref.objectId === row.id);
        const payload = JSON.parse(row.payload_json) as { blocks?: unknown[] };
        return {
          id: row.id,
          revision: row.revision,
          title: row.title,
          tags: row.tags_json ? JSON.parse(row.tags_json) as string[] : [],
          blocks: payload.blocks ?? [],
          resourceId: own[0]?.resourceId ?? null,
          anchorId: own[0]?.anchorId ?? null,
          blockId: own[0]?.blockId ?? null,
          updatedAt: row.updatedAt,
        };
      }),
      resources,
      resourcePage: {
        total: resourceTotal,
        listed: resources.length,
        nextCursor: resourceRows.length > 100 && resources.length
          ? encodeResourceCursor({ createdAt: resources[resources.length - 1]!.createdAt, id: resources[resources.length - 1]!.id })
          : null,
      },
      sessions,
      runs,
      // What an enabled plugin turns on is offered only while the plugin feature itself is on.
      uiFacets: [...this.uiFacets, ...(this.uiFacets.has("plugins") ? [...this.plugins.facets()].filter((facet) => facet !== "acquisition" || this.featureEnabled("acquisition")) : [])],
      layout: this.publicLayout(),
      aiSkipped: this.store.getMeta("aiSkipped") === "1",
      restartRequired: this.sealed,
      shell: readShell(this.store),
    };
  }

  /**
   * The conversations of one context, most recent first (A-94): what the sidebar lists under a project or under "最近". A conversation about a resource
   * carries where the person is in that resource in this context, so a row can show "page 12 of 180" without opening the file.
   */
  sessionList(contextId: ContextId): Array<Record<string, unknown>> {
    const rows = this.store.sqlite.prepare(`SELECT id, title, kind, target_id AS targetId, project_id AS contextId, updated_at AS updatedAt FROM agent_sessions WHERE ${contextId ? "project_id = ?" : "project_id IS NULL"} ORDER BY updated_at DESC LIMIT 100`)
      .all(...(contextId ? [contextId] : [])) as Array<{ id: string; title: string; kind: string; targetId: string | null; contextId: string | null; updatedAt: string }>;
    return rows.map((row) => {
      const runCount = Number((this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?").get(row.id) as { n: number }).n);
      const active = this.store.sqlite.prepare("SELECT id, status FROM agent_runs WHERE session_id = ? AND status IN ('queued','running','waiting_input') ORDER BY created_at DESC LIMIT 1").get(row.id) as { id: string; status: string } | undefined;
      const resource = row.targetId && row.kind === "resource"
        ? this.store.sqlite.prepare("SELECT r.title AS title, r.work_id AS workId, COALESCE(w.media_kind, r.kind) AS mediaKind, r.ordinal_label AS ordinalLabel FROM resources r LEFT JOIN works w ON w.id = r.work_id WHERE r.id = ?").get(row.targetId) as { title: string; workId: string | null; mediaKind: string | null; ordinalLabel: string | null } | undefined
        : undefined;
      // A work page's session is bound to the work itself.
      const workId = resource?.workId ?? (row.kind === "work" ? row.targetId : null);
      const work = workId ? this.store.sqlite.prepare("SELECT title, media_kind AS mediaKind, cover_id AS coverId, projection_json AS projection FROM works WHERE id = ?").get(workId) as { title: string; mediaKind: string | null; coverId: string | null; projection: string } | undefined : undefined;
      // Where the reader is in this context.
      let progress: Record<string, unknown> | null = null;
      if (resource && row.targetId) {
        const revision = this.store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(row.targetId) as { id: string } | undefined;
        const saved = revision ? this.store.sqlite.prepare("SELECT percent, completion_state AS completion, last_locator_json AS locator FROM progress WHERE context_id = ? AND resource_id = ? AND resource_revision_id = ?").get(contextKey(contextId), row.targetId, revision.id) as { percent: number; completion: string; locator: string | null } | undefined : undefined;
        const layout = revision ? readLayout(this.store, revision.id) : undefined;
        if (saved) progress = { percent: saved.percent, completion: saved.completion, locator: saved.locator ? safeJsonValue(saved.locator) : null, unit: layout?.unit ?? null, total: layout?.total ?? 0 };
      }
      return {
        sessionId: row.id,
        title: resource?.title ?? (work ? displayTitle({ title: work.title, projection_json: work.projection }) : row.title),
        kind: row.kind,
        targetId: row.targetId,
        // The left rail groups resource sessions by the medium of the work they belong to.
        mediaKind: resource?.mediaKind ?? work?.mediaKind ?? null,
        // A resource whose file is outside the library or gone is not offered for opening; its conversation and progress stay (A-86).
        openState: resource && row.targetId ? checkOpenable(this.store, row.targetId).state : "open",
        workId: workId ?? null,
        workTitle: work ? displayTitle({ title: work.title, projection_json: work.projection }) : null,
        ordinalLabel: resource?.ordinalLabel ?? null,
        coverId: work?.coverId ?? null,
        progress,
        contextId: row.contextId,
        runCount,
        activeRunId: active?.id ?? null,
        activeRunStatus: active?.status ?? null,
        updatedAt: row.updatedAt,
      };
    });
  }

  publicLayout() {
    return {
      ...this.layout,
      partitions: this.layout.partitions,
    };
  }

  grantOf(envelope: CommandEnvelope): ScopeGrant {
    const grant = this.grants.get(envelope.scopeHandle);
    if (!grant) throw new MangaError("FORBIDDEN", "missing grant");
    return grant;
  }

  /** Whether a task may be told about a screenshot: with the spoiler guard on, only a moment the person has reached. */
  screenshotVisible(shot: ScreenshotView): boolean {
    if (!readShell(this.store).spoilerGuard) return true;
    let consumed: Array<{ start: number; end: number }> = [];
    // Reached in any context counts (A-96): the guard keeps the furthest the person has been.
    try { consumed = frontierConsumed(this.store, shot.resourceId, shot.resourceRevisionId); } catch { /* no progress: nothing has been reached */ }
    if (shot.mediaKind === "video") return shot.positionMs !== null && subtitleLimit({ positionMs: shot.positionMs, consumed, guard: true }).limitMs >= shot.positionMs;
    const index = typeof shot.meta.pageIndex === "number" ? shot.meta.pageIndex : -1;
    return index >= 0 && consumed.some((range) => range.start <= index && index < range.end);
  }

  /** What a task is told about a screenshot: where it is from and what was on screen, never the file or where it is on this machine. */
  screenshotForTask(shot: ScreenshotView) {
    return { id: shot.id, title: shot.title, resourceId: shot.resourceId, resourceRevisionId: shot.resourceRevisionId, workId: shot.workId, mediaKind: shot.mediaKind, positionMs: shot.positionMs, frame: shot.frame, pageId: shot.pageId, pageLabel: shot.pageLabel, spread: shot.spread, region: shot.region, width: shot.width, height: shot.height, subtitleText: shot.subtitleText, capturedAt: shot.capturedAt };
  }

  search(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const input = envelope.input as { text: string; readAllowlist?: string[]; resourceId?: string; withinProgress?: boolean; mediaKind?: "novel" | "comic" | "video" };
    const allowlist = this.grants.intersectRead(grant, input.readAllowlist);
    const found = this.store.search({ text: input.text, readAllowlist: allowlist, resourceIds: input.resourceId ? [input.resourceId] : undefined });
    // Only resources in a library path are listed (A-113), and the search box's medium keeps its own (计划 4.8); the hits of notes are not resources.
    const listed = resourcesListed(this.store, found.flatMap((hit) => (hit.resourceId ? [hit.resourceId] : [])), input.mediaKind);
    const hits = found.filter((hit) => (hit.resourceId ? listed.has(hit.resourceId) : !input.mediaKind));
    const spoiler = grant.access !== "owner" && readShell(this.store).spoilerGuard;
    return input.withinProgress || spoiler ? filterUnread(this.store, hits) : hits;
  }

  /** Jobs whose staging or partial copies still need a decision (identified, never auto-deleted). */
  pendingRecoveryJobs() {
    return this.store.sqlite.prepare("SELECT id, kind, stage, status, staging_path AS stagingPath, updated_at AS updatedAt FROM recovery_jobs WHERE status IN ('planned','running','interrupted','failed','needs-review') ORDER BY created_at").all() as Array<{ id: string; kind: string; stage: string; status: string; stagingPath: string | null; updatedAt: string }>;
  }

  // ------------------------------------------------------------------ library scan

  // ------------------------------------------------------------------ notes, log and debugging

  queryLog(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const found = this.log.query(envelope.input as Parameters<OperationLog["query"]>[0]);
    const visible = (entry: LogEntry): LogEntry => {
      if (grant.access === "owner") return entry;
      // A task may read what happened; names of works and files it was not given stay out of what it sees.
      const known = entry.objectKind === "module" || entry.objectKind === "run" || entry.objectKind === "session"
        || (entry.objectKind === "resource" && entry.objectId !== null && this.grants.canRead(grant, entry.objectId))
        || (entry.objectKind === "work" && entry.objectId !== null && (this.store.sqlite.prepare("SELECT id FROM resources WHERE work_id = ?").all(entry.objectId) as Array<{ id: string }>).some((row) => this.grants.canRead(grant, row.id)))
        || (entry.objectKind === "note" && entry.objectId !== null && this.grants.canWriteObject(grant, entry.objectId));
      return known ? entry : { ...entry, objectLabel: null };
    };
    return { entries: found.entries.map(visible), nextBefore: found.nextBefore, total: found.total, categories: this.log.categories(), retention: { days: LOG_RETENTION_DAYS, rows: LOG_RETENTION_ROWS } };
  }

  /**
   * What the Agent would be given for this session, with credentials and local paths taken out, for the debug panel (A-48). It reports
   * the frozen material of the session's latest run, the model and tools the next run would use, and the budget; it sends nothing.
   */
  debugContext(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "the context panel belongs to the owner");
    const input = envelope.input as { sessionId?: string; resourceId?: string; workId?: string; page?: string };
    const session = input.sessionId ? this.store.sqlite.prepare("SELECT id, kind, target_id AS targetId, project_id AS contextId FROM agent_sessions WHERE id = ?").get(input.sessionId) as { id: string; kind: string; targetId: string | null; contextId: string | null } | undefined : undefined;
    if (input.sessionId && !session) throw new MangaError("NOT_FOUND", "session missing");
    const run = session
      ? this.store.sqlite.prepare("SELECT id, status, input_text, snapshot_json, budget_json, runtime, model_id, input_tokens, output_tokens, created_at FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(session.id) as { id: string; status: string; input_text: string; snapshot_json: string | null; budget_json: string; runtime: string | null; model_id: string | null; input_tokens: number | null; output_tokens: number | null; created_at: string } | undefined
      : undefined;
    const snapshot = run?.snapshot_json ? safeJsonValue(run.snapshot_json) as { materials?: unknown[]; selection?: unknown; notes?: Array<{ objectId: string; revision: number; title: string; text?: string; truncated?: boolean }>; media?: FrozenMedia; history?: ChatMessage[]; contextText?: string | null; capturedAt?: string; runtime?: string } : undefined;
    const connection = this.store.sqlite.prepare("SELECT id, protocol, model_id, runtime, base_url, purpose FROM provider_connections WHERE purpose = 'text' LIMIT 1").get() as { id: string; protocol: string; model_id: string; runtime: string | null; base_url: string; purpose: string } | undefined;
    const clip = (text: string, max: number) => ([...text].length > max ? `${[...text].slice(0, max).join("")}…` : text);
    const host = (() => { try { return new URL(connection?.base_url ?? "").host; } catch { return null; } })();
    const report = {
      generatedAt: new Date().toISOString(),
      scope: { sessionId: session?.id ?? null, sessionKind: session?.kind ?? null, targetId: session?.targetId ?? input.resourceId ?? input.workId ?? null, contextId: session?.contextId ?? null, page: input.page ?? null },
      model: connection ? { connectionId: connection.id, protocol: connection.protocol, modelId: connection.model_id, runtime: connection.runtime, host } : null,
      tools: [...AGENT_COMMANDS, ...(session?.contextId ? AGENT_PROJECT_COMMANDS : [])].filter((commandId) => this.runtime.gateway.has(commandId)).map((commandId) => ({ id: commandId, description: TOOL_DESCRIPTIONS[commandId] ?? commandId })),
      budget: run?.budget_json ? safeJsonValue(run.budget_json) : { ...readAgentSettings(this.store).limits, ...budgetOf(DEFAULT_MODEL_PROFILE) },
      lastRun: run ? {
        runId: run.id, status: run.status, at: run.created_at, runtime: run.runtime, modelId: run.model_id, inputTokens: run.input_tokens, outputTokens: run.output_tokens,
        question: clip(run.input_text, 2000),
        capturedAt: snapshot?.capturedAt ?? null,
        materials: snapshot?.materials ?? [],
        selection: snapshot?.selection ?? null,
        notes: (snapshot?.notes ?? []).map((note) => ({ objectId: note.objectId, revision: note.revision, title: note.title, chars: [...(note.text ?? "")].length, truncated: note.truncated === true })),
        media: snapshot?.media ? publicMedia(snapshot.media) : null,
        history: { messages: snapshot?.history?.length ?? 0, chars: (snapshot?.history ?? []).reduce((sum, message) => sum + [...message.content].length, 0) },
        contextText: snapshot?.contextText ? clip(snapshot.contextText, 6000) : null,
      } : null,
    };
    const clean = redactDeep(report);
    return { ...clean.value, redactions: { secrets: clean.secrets, paths: clean.paths } };
  }

  requireModule(probeCommand: string, label: string): void {
    if (!this.runtime.gateway.has(probeCommand)) throw new MangaError("CAPABILITY_UNAVAILABLE", `${label} is turned off; turn it on in settings to use this`);
  }

  /** A path the renderer picked through the host dialog, checked against what the handle was issued for. */
  resolvePathFor(handle: string, purposes: string[]): string {
    const row = this.store.sqlite.prepare("SELECT purpose, resolved_path FROM path_handles WHERE id = ?").get(handle) as { purpose: string; resolved_path: string } | undefined;
    if (!row) throw new MangaError("FORBIDDEN", "path handle is not authorized");
    if (!purposes.includes(row.purpose)) throw new MangaError("FORBIDDEN", `path handle was issued for ${row.purpose}, not for this action`);
    return row.resolved_path;
  }

  onNotice(listener: (notice: AppNotice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => { this.noticeListeners.delete(listener); };
  }

  notify(topic: string, payload: Record<string, unknown>): void {
    for (const listener of this.noticeListeners) {
      try { listener({ topic, payload }); } catch { /* a broken subscriber must not stop an import */ }
    }
  }

  recoverPackage(action: "recover" | "rollback") {
    this.assertWritable();
    return recoverJobs(this, action);
  }
}
