/** The comic, video, danmaku and metadata modules. */
import { DANMAKU_ATTRIBUTION, MangaError, createId, type CommandEnvelope, type PageRegion, type ScopeGrant, type WorkMediaKind } from "@manga/contracts";
import { defineModule, type MangaModule } from "@manga/plugin-sdk";
import { MetadataService, METADATA_MODULE } from "../metadata/service.ts";
import { assertOpenable } from "../library-locations.ts";
import type { DandanCredentials } from "../danmaku/sign.ts";
import { DanmakuService, DANMAKU_MODULE, type CredentialSource } from "../danmaku/service.ts";
import type { MangaProductApp } from "../product-app.ts";
import { readCredential, saveCredential } from "../credentials.ts";
import { takeSecret } from "./connections.ts";

/** What these commands use of the application. */
export type MediaHost = Pick<MangaProductApp, "assertWritable" | "builtinDanmakuCredentials" | "comics" | "danmaku" | "extras" | "followFiles" | "grantOf" | "grants" | "materials" | "media" | "metadata" | "notify" | "runtime" | "secrets" | "store" | "suggestedQuery" | "uiFacets" | "vault" | "videos" | "voice">;

export function comicModule(app: MediaHost): MangaModule {
  const moduleId = "manga.comic";
  return defineModule({
    manifest: {
      moduleId,
      version: "1.0.0",
      displayName: "漫画阅读",
      featureId: "comic",
      contributes: [{ capabilityId: "manga.comic", version: "1.0.0" }],
      needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
      facets: ["service", "ui"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      if ((ctx.hostFacets ?? []).includes("ui")) {
        app.uiFacets.add("comic");
        ctx.register({ kind: "subscription", id: `comic-ui-${ctx.epoch}`, dispose: () => { app.uiFacets.delete("comic"); } });
      }
      // Page handles and background work belong to app activation: turning the module off ends them.
      ctx.register({
        kind: "ipc",
        id: `comic-handles-${ctx.epoch}`,
        dispose: () => {
          app.media.handles.bumpGeneration(moduleId);
          app.media.jobs.cancelWhere((job) => job.owner === moduleId);
        },
      });
      app.runtime.registerCommand(moduleId, "comic.pages", (envelope) => {
        const input = envelope.input as { resourceId: string; revisionId?: string };
        if (!app.grants.canRead(app.grantOf(envelope), input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        assertOpenable(app.store, input.resourceId);
        return app.comics.pages(input.resourceId, input.revisionId);
      });
      app.runtime.registerCommand(moduleId, "comic.pageHandle", async (envelope, signal) => {
        const input = envelope.input as { resourceId: string; revisionId: string; pageId: string; variant?: "display" | "original" | "thumb"; maxEdge?: number };
        const grant = app.grantOf(envelope);
        if (!app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        assertOpenable(app.store, input.resourceId);
        const result = await app.comics.pageHandle({ ...input, signal, sessionId: grant.sessionId });
        // A page that finished after the module was switched off must not leave a usable handle behind.
        if (!ctx.isCurrent()) throw new MangaError("CANCELLED", "comic reading was turned off while the page was loading");
        return result;
      });
      app.runtime.registerCommand(moduleId, "comic.pageHandles", async (envelope, signal) => {
        const input = envelope.input as { resourceId: string; revisionId: string; pageIds: string[]; variant?: "display" | "thumb"; maxEdge?: number };
        const grant = app.grantOf(envelope);
        if (!app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        assertOpenable(app.store, input.resourceId);
        const result = await app.comics.pageHandles({ ...input, signal, sessionId: grant.sessionId });
        if (!ctx.isCurrent()) throw new MangaError("CANCELLED", "comic reading was turned off while the pages were loading");
        return { pages: result };
      });
      // A still the user prepares for a task. The bytes wait in a short-lived store until a send freezes them; nothing is saved.
      app.runtime.registerCommand(moduleId, "material.region", async (envelope, signal) => {
        const input = envelope.input as { resourceId: string; resourceRevisionId: string; pageId: string; region?: PageRegion; maxEdge?: number };
        const grant = app.grantOf(envelope);
        if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "image materials are prepared by the user, not by a task");
        if (!app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        assertOpenable(app.store, input.resourceId);
        const result = await app.materials.comicRegion(input, signal);
        if (!ctx.isCurrent()) { app.materials.stash.discard([result.materialId]); throw new MangaError("CANCELLED", "comic reading was turned off while the picture was prepared"); }
        return result;
      });
    },
    deactivate: () => {
      app.media.handles.bumpGeneration(moduleId);
    },
  });
}

export function videoModule(app: MediaHost): MangaModule {
  const moduleId = "manga.video";
  /** Whether the caller may read the resource, and, unless the command only manages what was made from it, whether it can be opened at all (A-86). */
  const readable = (envelope: CommandEnvelope, resourceId: string, options: { open?: boolean } = {}) => {
    const grant = app.grantOf(envelope);
    if (!app.grants.canRead(grant, resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
    if (options.open !== false) assertOpenable(app.store, resourceId);
    return grant;
  };
  return defineModule({
    manifest: {
      moduleId,
      version: "1.0.0",
      displayName: "视频播放",
      featureId: "video",
      contributes: [{ capabilityId: "manga.video", version: "1.0.0" }],
      needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
      facets: ["service", "ui"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      if ((ctx.hostFacets ?? []).includes("ui")) {
        app.uiFacets.add("video");
        ctx.register({ kind: "subscription", id: `video-ui-${ctx.epoch}`, dispose: () => { app.uiFacets.delete("video"); } });
      }
      // Play copies, frame indexes and every handle belong to app activation: turning the module off ends them and leaves no half-written copy.
      ctx.register({
        kind: "ipc",
        id: `video-handles-${ctx.epoch}`,
        dispose: () => {
          app.media.handles.bumpGeneration(moduleId);
          app.media.jobs.cancelWhere((job) => job.owner === moduleId);
        },
      });
      app.videos.copies.recover();
      const live = <T>(value: T, what: string): T => {
        if (!ctx.isCurrent()) throw new MangaError("CANCELLED", `video playback was turned off while ${what}`);
        return value;
      };
      app.runtime.registerCommand(moduleId, "video.probe", async (envelope, signal) => {
        const input = envelope.input as { resourceId: string; revisionId?: string; refresh?: boolean };
        readable(envelope, input.resourceId);
        if (input.refresh) app.assertWritable();
        return app.videos.probe(input.resourceId, input.revisionId, input.refresh === true, signal);
      });
      app.runtime.registerCommand(moduleId, "video.subtitles", (envelope) => {
        const input = envelope.input as { resourceId: string; revisionId?: string };
        readable(envelope, input.resourceId);
        const { subtitles, attachments, ...rest } = app.videos.tracks(input.resourceId, input.revisionId);
        return { ...rest, subtitles, attachments };
      });
      app.runtime.registerCommand(moduleId, "video.audioTracks", (envelope) => {
        const input = envelope.input as { resourceId: string; revisionId?: string };
        readable(envelope, input.resourceId);
        const { audio, ...rest } = app.videos.tracks(input.resourceId, input.revisionId);
        return { resourceId: rest.resourceId, revisionId: rest.revisionId, available: rest.available, audio };
      });
      app.runtime.registerCommand(moduleId, "video.frameIndex", async (envelope, signal) => {
        const input = envelope.input as { resourceId: string; revisionId?: string; timeMs?: number; frame?: number; delta?: number };
        readable(envelope, input.resourceId);
        return live(await app.videos.frame(input.resourceId, input.revisionId, input, signal), "the frame index was being built");
      });
      app.runtime.registerCommand(moduleId, "video.keyframes", async (envelope, signal) => {
        const input = envelope.input as { resourceId: string; revisionId?: string; build?: boolean };
        readable(envelope, input.resourceId);
        return live(await app.videos.keyframes(input.resourceId, input.revisionId, { build: input.build }, signal), "the frame index was being built");
      });
      app.runtime.registerCommand(moduleId, "video.cancelFrameIndex", (envelope) => {
        const input = envelope.input as { resourceId: string; revisionId?: string };
        readable(envelope, input.resourceId, { open: false });
        const row = app.videos.describe(input.resourceId, input.revisionId);
        return { revisionId: row.revisionId, cancelled: app.videos.cancelFrameIndex(row.revisionId) };
      });
      app.runtime.registerCommand(moduleId, "video.playbackPlan", (envelope) => {
        const input = envelope.input as { resourceId: string; revisionId?: string; hardwareHevc?: boolean; audioStreamIndex?: number };
        readable(envelope, input.resourceId);
        return app.videos.playbackPlan(input.resourceId, input.revisionId, { hardwareHevc: input.hardwareHevc === true }, input.audioStreamIndex);
      });
      app.runtime.registerCommand(moduleId, "video.playCopy", async (envelope) => {
        const input = envelope.input as { resourceId: string; revisionId: string; action: "create" | "cancel" | "remove" | "status"; reason?: string; audioStreamIndex?: number; hardwareHevc?: boolean };
        // Looking at, stopping and removing a copy do not read the file; making one does.
        readable(envelope, input.resourceId, { open: input.action === "create" });
        const row = input.action === "create" ? app.videos.load(input.resourceId, input.revisionId) : app.videos.describe(input.resourceId, input.revisionId);
        if (input.action === "status") return { revisionId: row.revisionId, copies: app.videos.copies.list(row.revisionId), budgetBytes: app.videos.copies.budget(), usedBytes: app.videos.copies.totalBytes() };
        app.assertWritable();
        if (input.action === "cancel") return { cancelled: app.videos.copies.cancel(row.revisionId) };
        if (input.action === "remove") return { removed: app.videos.copies.remove(row.revisionId) };
        // The plan the player saw decides what is made. A reason only matters for a file that plays directly: then it is a forced copy.
        const caps = { hardwareHevc: input.hardwareHevc === true };
        let { plan } = app.videos.playbackPlan(input.resourceId, row.revisionId, caps, input.audioStreamIndex);
        if (!plan.copy && input.reason !== undefined) plan = app.videos.playbackPlan(input.resourceId, row.revisionId, { ...caps, forcePlayCopy: true }, input.audioStreamIndex).plan;
        return live({ copy: await app.videos.copies.create({ revisionId: row.revisionId, plan }) }, "the copy was being started");
      });
      app.runtime.registerCommand(moduleId, "video.handle", (envelope) => {
        const input = envelope.input as { resourceId: string; revisionId: string; source: "original" | "play_copy"; copyId?: string };
        const grant = readable(envelope, input.resourceId);
        return live(app.videos.handle(input.resourceId, input.revisionId, { source: input.source, copyId: input.copyId, sessionId: grant.sessionId }), "the player was loading");
      });
      app.runtime.registerCommand(moduleId, "video.subtitleHandle", async (envelope, signal) => {
        const input = envelope.input as { resourceId: string; revisionId: string; trackId: string };
        const grant = readable(envelope, input.resourceId);
        return live(await app.videos.subtitleHandle(input.resourceId, input.revisionId, input.trackId, grant.sessionId, signal), "subtitles were loading");
      });
      app.runtime.registerCommand(moduleId, "video.fonts", async (envelope, signal) => {
        const input = envelope.input as { resourceId: string; revisionId: string };
        const grant = readable(envelope, input.resourceId);
        return live(await app.videos.fonts(input.resourceId, input.revisionId, grant.sessionId, signal), "fonts were loading");
      });
      app.runtime.registerCommand(moduleId, "material.frame", async (envelope, signal) => {
        const input = envelope.input as { resourceId: string; resourceRevisionId: string; timeMs: number; maxEdge?: number };
        const grant = readable(envelope, input.resourceId);
        if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "image materials are prepared by the user, not by a task");
        const result = await app.materials.videoFrame(input, signal);
        if (!ctx.isCurrent()) { app.materials.stash.discard([result.materialId]); throw new MangaError("CANCELLED", "video playback was turned off while the frame was prepared"); }
        return result;
      });
      // Subtitle text before a position. A task gets only what its frozen material allows; the owner's own request follows the spoiler rule and may widen it explicitly.
      app.runtime.registerCommand(moduleId, "material.subtitleWindow", async (envelope, signal) => {
        const input = envelope.input as { resourceId: string; resourceRevisionId: string; centerMs: number; beforeMs?: number; afterMs?: number; allowAhead?: boolean };
        const grant = readable(envelope, input.resourceId);
        return live(await app.materials.subtitleWindow(grant, input, signal), "subtitles were loading");
      });
    },
    deactivate: () => {
      app.media.handles.bumpGeneration(moduleId);
    },
  });
}

/** The credentials the person typed in the settings (kept in the vault), if any. */
export async function customDanmakuCredentials(app: MediaHost): Promise<DandanCredentials | null> {
  const ref = app.store.getMeta("danmaku.credentialRef");
  if (!ref) return null;
  try {
    const plain = await readCredential(app, ref);
    if (plain === undefined) return null;
    const value = JSON.parse(plain) as { appId?: unknown; secret?: unknown };
    return typeof value.appId === "string" && typeof value.secret === "string" && value.appId && value.secret ? { appId: value.appId, secret: value.secret } : null;
  } catch {
    return null;
  }
}

/** The person's own credentials win over the ones built into the release. */
export async function danmakuCredentials(app: MediaHost): Promise<DandanCredentials | null> {
  const builtin = app.builtinDanmakuCredentials;
  return (await customDanmakuCredentials(app)) ?? (builtin?.appId && builtin.secret ? builtin : null);
}

export async function danmakuCredentialSource(app: MediaHost): Promise<CredentialSource> {
  if (await customDanmakuCredentials(app)) return "custom";
  return app.builtinDanmakuCredentials?.appId && app.builtinDanmakuCredentials.secret ? "built-in" : "none";
}

export function danmakuModule(app: MediaHost): MangaModule {
  const moduleId = DANMAKU_MODULE;
  const owner = (envelope: CommandEnvelope): ScopeGrant => {
    const grant = app.grantOf(envelope);
    if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "danmaku settings and requests belong to the owner");
    return grant;
  };
  return defineModule({
    manifest: {
      moduleId,
      version: "1.0.0",
      displayName: "弹幕",
      featureId: "danmaku",
      contributes: [{ capabilityId: "manga.danmaku", version: "1.0.0" }],
      needs: [
        { capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true },
        { capabilityId: "manga.video", version: "1.0.0", cardinality: "single", required: false },
      ],
      facets: ["service", "ui"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      if ((ctx.hostFacets ?? []).includes("ui")) {
        app.uiFacets.add("danmaku");
        ctx.register({ kind: "subscription", id: `danmaku-ui-${ctx.epoch}`, dispose: () => { app.uiFacets.delete("danmaku"); } });
      }
      // A request that is running belongs to app activation: turning the module off ends it. The cache and the settings stay where they are.
      const running = new Set<AbortController>();
      ctx.register({ kind: "ipc", id: `danmaku-net-${ctx.epoch}`, dispose: () => { for (const controller of running) controller.abort(); running.clear(); } });
      const online = async <T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const controller = new AbortController();
        running.add(controller);
        const relay = () => controller.abort();
        signal.addEventListener("abort", relay, { once: true });
        try {
          const value = await work(controller.signal);
          if (!ctx.isCurrent()) throw new MangaError("CANCELLED", "danmaku was turned off while the request was running");
          return value;
        } finally {
          signal.removeEventListener("abort", relay);
          running.delete(controller);
        }
      };
      const reg = app.runtime.registerCommand.bind(app.runtime, moduleId);
      reg("danmaku.status", async (envelope) => {
        owner(envelope);
        const input = envelope.input as { resourceId: string; resourceRevisionId?: string };
        return app.danmaku.status(input.resourceId, input.resourceRevisionId);
      });
      reg("danmaku.match", (envelope, signal) => {
        owner(envelope);
        app.assertWritable();
        return online(signal, (inner) => app.danmaku.match(envelope.input as Parameters<DanmakuService["match"]>[0], inner));
      });
      reg("danmaku.search", (envelope, signal) => {
        owner(envelope);
        return online(signal, (inner) => app.danmaku.search(envelope.input as Parameters<DanmakuService["search"]>[0], inner));
      });
      reg("danmaku.choose", (envelope) => {
        owner(envelope);
        app.assertWritable();
        return app.danmaku.choose(envelope.input as Parameters<DanmakuService["choose"]>[0]);
      });
      reg("danmaku.setOffset", (envelope) => {
        owner(envelope);
        app.assertWritable();
        return app.danmaku.setOffset(envelope.input as Parameters<DanmakuService["setOffset"]>[0]);
      });
      reg("danmaku.load", (envelope, signal) => {
        owner(envelope);
        app.assertWritable();
        return online(signal, (inner) => app.danmaku.load(envelope.input as Parameters<DanmakuService["load"]>[0], inner));
      });
      reg("danmaku.getSettings", async (envelope) => {
        owner(envelope);
        return { settings: app.danmaku.settings(), credentials: await danmakuCredentialSource(app) };
      });
      reg("danmaku.setSettings", async (envelope) => {
        owner(envelope);
        app.assertWritable();
        return { settings: app.danmaku.setSettings(envelope.input as Parameters<DanmakuService["setSettings"]>[0]), credentials: await danmakuCredentialSource(app) };
      });
      reg("danmaku.setCredentials", async (envelope) => {
        owner(envelope);
        app.assertWritable();
        const input = envelope.input as { credentialHandle?: string; clear?: boolean };
        const previous = app.store.getMeta("danmaku.credentialRef");
        if (input.credentialHandle) {
          const handle = input.credentialHandle;
          const ref = await saveCredential(app, () => {
            const secret = takeSecret(app, handle);
            let parsed: { appId?: unknown; secret?: unknown };
            try { parsed = JSON.parse(secret) as typeof parsed; } catch { throw new MangaError("VALIDATION_ERROR", "the credentials are not in the expected shape"); }
            const valid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{4,128}$/.test(value);
            if (!valid(parsed.appId) || !valid(parsed.secret)) throw new MangaError("VALIDATION_ERROR", "the AppId and the AppSecret are made of letters and digits");
            return JSON.stringify({ appId: parsed.appId, secret: parsed.secret });
          });
          app.store.setMeta("danmaku.credentialRef", ref);
        } else if (input.clear) {
          app.store.setMeta("danmaku.credentialRef", "");
        }
        if (previous && previous !== app.store.getMeta("danmaku.credentialRef")) app.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(previous);
        return { credentials: await danmakuCredentialSource(app) };
      });
      reg("danmaku.clearCache", (envelope) => {
        owner(envelope);
        app.assertWritable();
        return app.danmaku.clearCache();
      });
      // A task reads what is already kept: no request is made for it, and nothing later than what has been watched is given (the subtitle rule).
      reg("danmaku.around", (envelope) => {
        const grant = app.grantOf(envelope);
        const input = envelope.input as { resourceId: string; resourceRevisionId: string; centerMs: number; windowMs?: number; limit?: number };
        if (!app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        // The comments are kept by revision: a revision of another resource would read that resource's comments under app one's grant.
        const revisionOwner = app.store.sqlite.prepare("SELECT resource_id AS resourceId FROM resource_revisions WHERE id = ?").get(input.resourceRevisionId) as { resourceId: string } | undefined;
        if (revisionOwner?.resourceId !== input.resourceId) throw new MangaError("SCOPE_DENIED", "that revision is not a revision of the resource");
        const limit = app.materials.watchedLimit(grant, input);
        const kept = app.danmaku.cachedItems(input.resourceRevisionId);
        const half = Math.floor((input.windowMs ?? 20_000) / 2);
        const fromMs = Math.max(0, input.centerMs - half);
        const toMs = Math.min(input.centerMs + half, limit.limitMs);
        const base = { fromMs, toMs, limitMs: limit.limitMs, guard: limit.guard, attribution: DANMAKU_ATTRIBUTION };
        if (!kept) return { status: "none", count: 0, items: [], ...base };
        const offset = kept.match.offsetMs;
        const inWindow = kept.items.filter((item) => item.at + offset >= fromMs && item.at + offset <= toMs);
        const take = Math.min(input.limit ?? 10, inWindow.length);
        const items = Array.from({ length: take }, (_, index) => inWindow[Math.floor((index * inWindow.length) / take)]!).map((item) => ({ atMs: item.at + offset, text: item.text }));
        return { status: "ok", count: inWindow.length, items, cachedAt: kept.fetchedAt, ...base };
      });
    },
    deactivate: () => { /* running requests were ended with the activation */ },
  });
}

export async function metadataToken(app: MediaHost, providerId: string): Promise<string | undefined> {
  const ref = app.metadata.credentialRef(providerId);
  if (!ref) return undefined;
  try {
    return await readCredential(app, ref);
  } catch {
    return undefined;
  }
}

/** After an import: pull a cover out of the file and read what the file says about itself, in the background. */
export function queueExtras<T>(app: MediaHost, result: T): T {
  const ids = new Set<string>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    const record = item as { resourceId?: unknown; duplicate?: unknown; resources?: unknown; items?: unknown };
    if (typeof record.resourceId === "string" && record.duplicate !== true) ids.add(record.resourceId);
    for (const list of [record.resources, record.items]) if (Array.isArray(list)) for (const child of list) visit(child);
  };
  visit(result);
  // One job per work, not per file: a folder of sixty episodes needs one cover, taken from the first file that has a picture, and the
  // other files are never opened for it. Each file still tells what it says about itself.
  const byWork = new Map<string, string[]>();
  for (const resourceId of ids) {
    const row = app.store.sqlite.prepare("SELECT work_id AS workId FROM resources WHERE id = ?").get(resourceId) as { workId: string | null } | undefined;
    const key = row?.workId ?? resourceId;
    byWork.set(key, [...(byWork.get(key) ?? []), resourceId]);
  }
  for (const [workKey, resourceIds] of byWork) {
    const job = app.media.jobs.submit<void>({
      lane: "thumbs", kind: "import-extras", key: `extras:${workKey}`, owner: "manga.library",
      run: async ({ signal }) => {
        let workId: string | null = null;
        let changed = false;
        for (const resourceId of resourceIds) {
          const cover = await app.extras.extractCover(resourceId, { signal, ifMissing: true });
          workId ??= cover.workId;
          changed ||= cover.added;
          if (cover.added || cover.hasCover) break;
        }
        for (const resourceId of resourceIds) {
          signal.throwIfAborted();
          // What the file says about itself belongs to the metadata module: with it off nothing is read and nothing is stored.
          if (app.runtime.gateway.has("metadata.providers") && await app.metadata.absorbLocal(resourceId, signal)) changed = true;
        }
        if (workId && changed) app.notify("work.updated", { workId, reason: "extras" });
      },
    });
    void job.promise.catch(() => undefined);
  }
  return result;
}

export function metadataModule(app: MediaHost): MangaModule {
  const moduleId = METADATA_MODULE;
  const owner = (envelope: CommandEnvelope): ScopeGrant => {
    const grant = app.grantOf(envelope);
    if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "metadata changes need the owner");
    return grant;
  };
  return defineModule({
    manifest: {
      moduleId,
      version: "1.0.0",
      displayName: "封面与资料",
      featureId: "metadata",
      contributes: [{ capabilityId: "manga.metadata", version: "1.0.0" }],
      needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
      facets: ["service", "ui"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      if ((ctx.hostFacets ?? []).includes("ui")) {
        app.uiFacets.add("metadata");
        ctx.register({ kind: "subscription", id: `metadata-ui-${ctx.epoch}`, dispose: () => { app.uiFacets.delete("metadata"); } });
      }
      // Network work and candidate pictures belong to app activation: turning the module off ends them.
      ctx.register({
        kind: "ipc",
        id: `metadata-net-${ctx.epoch}`,
        dispose: () => {
          app.media.handles.bumpGeneration(moduleId);
          app.media.jobs.cancelWhere((job) => job.owner === moduleId);
        },
      });
      const live = <T>(value: T, what: string): T => {
        if (!ctx.isCurrent()) throw new MangaError("CANCELLED", `metadata was turned off while ${what}`);
        return value;
      };
      app.runtime.registerCommand(moduleId, "metadata.providers", (envelope) => {
        owner(envelope);
        return app.metadata.providers();
      });
      app.runtime.registerCommand(moduleId, "metadata.setProvider", async (envelope) => {
        owner(envelope);
        app.assertWritable();
        const input = envelope.input as { providerId: string; enabled: boolean; credentialHandle?: string; clearCredential?: boolean };
        let credentialRef: string | null | undefined;
        if (input.credentialHandle) {
          const handle = input.credentialHandle;
          credentialRef = await saveCredential(app, () => takeSecret(app, handle));
        } else if (input.clearCredential) credentialRef = null;
        return app.metadata.setProviderState({ providerId: input.providerId, enabled: input.enabled, credentialRef });
      });
      app.runtime.registerCommand(moduleId, "metadata.search", async (envelope, signal) => {
        const grant = app.grantOf(envelope);
        const input = envelope.input as Parameters<MetadataService["search"]>[0];
        // A task reaches here only when the user turned online search on for it (the grant carries the command). It may look things up; it may not
        // attach the result to a work, so the candidate list of a work is never replaced by a task.
        if (grant.access !== "owner" && input.workId) throw new MangaError("FORBIDDEN", "a task searches by text; choosing a candidate for a work is the owner's decision");
        return live(await app.metadata.search(input, signal, grant.sessionId), "the search was running");
      });
      app.runtime.registerCommand(moduleId, "metadata.candidates", (envelope) => {
        const grant = owner(envelope);
        return app.metadata.candidates((envelope.input as { workId: string }).workId, grant.sessionId);
      });
      app.runtime.registerCommand(moduleId, "metadata.link", async (envelope, signal) => {
        owner(envelope);
        app.assertWritable();
        const linked = live(await app.metadata.link(envelope, envelope.input as Parameters<MetadataService["link"]>[1], signal), "the link was being made");
        // The work now belongs to the entry's folder (A-68, A-79).
        app.followFiles({ workId: (envelope.input as { workId: string }).workId });
        return linked;
      });
      app.runtime.registerCommand(moduleId, "metadata.unlink", (envelope) => {
        owner(envelope);
        app.assertWritable();
        const unlinked = app.metadata.unlink(envelope, envelope.input as { workId: string; providerId: string });
        // The work no longer has an entry to take names from, so the terms it took from it go.
        followDictionary(app, (envelope.input as { workId: string }).workId);
        app.followFiles({ workId: (envelope.input as { workId: string }).workId });
        return unlinked;
      });
      app.runtime.registerCommand(moduleId, "metadata.refresh", async (envelope, signal) => {
        owner(envelope);
        app.assertWritable();
        const refreshed = live(await app.metadata.refresh(envelope, envelope.input as Parameters<MetadataService["refresh"]>[1], signal), "the refresh was running");
        // Terms the work took from its entry follow the refreshed data; hand-written terms stay as they are.
        followDictionary(app, (envelope.input as { workId: string }).workId);
        return refreshed;
      });
      app.runtime.registerCommand(moduleId, "metadata.resolveRef", async (envelope, signal) => {
        const grant = owner(envelope);
        return live(await app.metadata.resolveRef(envelope.input as Parameters<MetadataService["resolveRef"]>[0], signal, grant.sessionId), "the entry was being looked up");
      });
      app.runtime.registerCommand(moduleId, "metadata.preview", async (envelope, signal) => {
        const grant = owner(envelope);
        return live(await app.metadata.preview(envelope.input as Parameters<MetadataService["preview"]>[0], signal, grant.sessionId), "the preview was being made");
      });
      app.runtime.registerCommand(moduleId, "metadata.characters", async (envelope, signal) => {
        owner(envelope);
        return app.metadata.characters((envelope.input as { workId: string }).workId, signal);
      });
      app.runtime.registerCommand(moduleId, "metadata.related", (envelope) => {
        owner(envelope);
        return app.metadata.related((envelope.input as { workId: string }).workId);
      });
      app.runtime.registerCommand(moduleId, "metadata.findMissing", (envelope) => {
        owner(envelope);
        app.assertWritable();
        return app.metadata.findMissing(envelope.input as { limit?: number; kind?: WorkMediaKind }, (workId) => app.suggestedQuery(workId));
      });
    },
    deactivate: () => {
      app.media.handles.bumpGeneration(moduleId);
    },
  });
}

export function followDictionary(app: MediaHost, workId: string): void {
  try { app.voice.dictionary.followMetadata(workId); } catch { /* the dictionary is a convenience: a refresh that succeeded must not report an error because of it */ }
}
