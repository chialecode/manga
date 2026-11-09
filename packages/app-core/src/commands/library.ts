/** The library module: reading, works, library paths, scans and the resources outside them. */
import fs from "node:fs";
import path from "node:path";
import { MangaError, type CommandEnvelope, type ContextId, type ScopeGrant, type WorkspaceState } from "@manga/contracts";
import { defineModule, type MangaModule } from "@manga/plugin-sdk";
import { listBookmarks, readShell, removeBookmark, resolveAnchor, setBookmark, sourceCard, writeShell } from "../reading-service.ts";
import { getProgress, setPageProgress, setProgress, setTimeProgress } from "../progress-service.ts";
import { deleteEntry, listUnassigned, previewDeleteEntry } from "../works-delete.ts";
import { ScreenshotService } from "../screenshots.ts";
import { getWork, listWorks, moveResource, openResource, setOrdinal, setOverride, setResourceKind, setShelf } from "../works-service.ts";
import { counterpart } from "../works-versions.ts";
import { resourceContent } from "../resource-content.ts";
import { exportLibraryPackageCancellable, importLibraryPackage, importLibraryPackageResolved, previewLibraryPackage } from "../domain/library-package.ts";
import { startParseWorker } from "../parse-client.ts";
import { SidebarService } from "../sidebar-service.ts";
import { listOutside, previewRemoveOutside, reidentifyResources, removeOutside } from "../library-outside.ts";
import { ScanService, type ScanJob } from "../library-scan/service.ts";
import { assertOpenable, checkOpenable } from "../library-locations.ts";
import type { MangaProductApp } from "../product-app.ts";
import { importText, importDocument, inspectFile, importDirectory, readResource, readResourceOriginal, readResourceSlice, repairSource, getResource, libraryList } from "./library-io.ts";
import { queueExtras } from "./media.ts";
import { contextSnapshot } from "./agent.ts";
import { creativePackageHooks } from "./creative.ts";
import { transcribeAuthorizedFile } from "./voice.ts";
import { indexExternalRoot } from "./inventory.ts";

/** What these commands use of the application. */
export type LibraryHost = Pick<MangaProductApp, "acquisition" | "agentAccess" | "assertWritable" | "builtinDanmakuCredentials" | "call" | "closed" | "comics" | "conversations" | "covers" | "danmaku" | "debugContext" | "drafts" | "embeds" | "exportAbort" | "extras" | "followFiles" | "grantOf" | "grants" | "interruptRuns" | "issueAgentGrant" | "layout" | "listModules" | "log" | "materials" | "media" | "metadata" | "mindmaps" | "notify" | "parseGeneration" | "parseWorker" | "parseWorkerPath" | "pendingRecoveryJobs" | "pluginRuntime" | "plugins" | "projects" | "proposals" | "publicLayout" | "queryLog" | "quickTasks" | "requireModule" | "research" | "resolvePath" | "resolvePathFor" | "roughcuts" | "runAbort" | "runtime" | "scan" | "scanAbort" | "screenshotForTask" | "screenshotVisible" | "screenshots" | "sealed" | "search" | "secrets" | "semantic" | "sessionList" | "setModule" | "settleImportedRecordings" | "sidebar" | "store" | "suggestedQuery" | "trace" | "uiFacets" | "vault" | "videos" | "voice" | "wantParseWorker" | "whiteboards" | "workFolders" | "workspace" | "workspaces">;

export function libraryModule(app: LibraryHost): MangaModule {
  return defineModule({
    manifest: {
      moduleId: "manga.library",
      version: "1.0.0",
      displayName: "资料库",
      featureId: "library",
      contributes: [{ capabilityId: "manga.library", version: "1.0.0" }],
      needs: [],
      facets: ["service", "ui", "worker"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      if (app.wantParseWorker) {
        app.parseWorker ??= startParseWorker(app.parseWorkerPath);
        ctx.register({
          kind: "worker",
          id: `parse-worker-${ctx.epoch}`,
          dispose: () => {
            app.parseGeneration += 1;
            app.parseWorker?.kill();
            app.parseWorker = undefined;
          },
        });
      }
      if ((ctx.hostFacets ?? []).includes("ui")) {
        app.uiFacets.add("library");
        ctx.register({
          kind: "subscription",
          id: `library-ui-${ctx.epoch}`,
          dispose: () => {
            app.uiFacets.delete("library");
          },
        });
      }
      app.runtime.registerCommand("manga.library", "workspace.get", () => app.workspace());
      app.runtime.registerCommand("manga.library", "workspace.sessions", (envelope) => app.sessionList((envelope.input as { contextId: ContextId }).contextId));
      app.runtime.registerCommand("manga.library", "workspace.contexts", (envelope) => app.workspaces.contexts((envelope.input as { includeArchived?: boolean }).includeArchived));
      app.runtime.registerCommand("manga.library", "workspace.loadContext", (envelope) => app.workspaces.load((envelope.input as { contextId: ContextId }).contextId));
      app.runtime.registerCommand("manga.library", "workspace.sidebar", (envelope) => app.sidebar.sidebar(envelope.input as Parameters<SidebarService["sidebar"]>[0]));
      app.runtime.registerCommand("manga.library", "workspace.items", (envelope) => app.sidebar.items(envelope.input as Parameters<SidebarService["items"]>[0]));
      app.runtime.registerCommand("manga.library", "workspace.objects", (envelope) => app.sidebar.objects(envelope.input as Parameters<SidebarService["objects"]>[0]));
      app.runtime.registerCommand("manga.library", "workspace.find", (envelope) => app.sidebar.find(envelope.input as Parameters<SidebarService["find"]>[0]));
      app.runtime.registerCommand("manga.library", "workspace.dismissRecent", (envelope) => {
        ownerOnly(envelope);
        app.assertWritable();
        return app.sidebar.dismissRecent((envelope.input as { key: string }).key, envelope);
      });
      app.runtime.registerCommand("manga.library", "workspace.undismissRecent", (envelope) => {
        ownerOnly(envelope);
        app.assertWritable();
        const input = envelope.input as { key: string; previousDismissedAt?: string | null };
        return app.sidebar.undismissRecent(input.key, input.previousDismissedAt, envelope);
      });
      app.runtime.registerCommand("manga.library", "workspace.saveContext", (envelope) => {
        app.assertWritable();
        const input = envelope.input as { contextId: ContextId; state: WorkspaceState };
        return app.workspaces.save(input.contextId, input.state);
      });
      app.runtime.registerCommand("manga.library", "workspace.setLastContext", (envelope) => {
        app.assertWritable();
        const { contextId } = envelope.input as { contextId: ContextId };
        // A project that no longer exists is not somewhere to come back to.
        return writeShell(app.store, readShell(app.store), { lastContext: contextId && app.projects.exists(contextId) ? contextId : null }, envelope);
      });
      app.runtime.registerCommand("manga.library", "library.importText", (envelope, signal) => {
        app.assertWritable();
        return importText(app, envelope, signal);
      });
      app.runtime.registerCommand("manga.library", "library.importEpub", async (envelope, signal) => {
        app.assertWritable();
        const input = envelope.input as { title: string; bytes: number[] };
        return queueExtras(app, await importDocument(app, { ...envelope, input: { title: input.title, bytes: input.bytes, format: "epub" } }, signal));
      });
      app.runtime.registerCommand("manga.library", "library.importDocument", async (envelope, signal) => {
        app.assertWritable();
        return queueExtras(app, await importDocument(app, envelope, signal));
      });
      app.runtime.registerCommand("manga.library", "library.inspectFile", (envelope, signal) => inspectFile(app, envelope, signal));
      app.runtime.registerCommand("manga.library", "works.importDirectory", async (envelope, signal) => {
        app.assertWritable();
        return queueExtras(app, await importDirectory(app, envelope, signal));
      });
      app.runtime.registerCommand("manga.library", "covers.list", (envelope) => app.covers.list((envelope.input as { workId: string }).workId));
      app.runtime.registerCommand("manga.library", "covers.select", (envelope) => {
        app.assertWritable();
        return app.covers.select(envelope, envelope.input as { workId: string; coverId: string });
      });
      app.runtime.registerCommand("manga.library", "covers.lock", (envelope) => {
        app.assertWritable();
        return app.covers.lock(envelope, envelope.input as { workId: string; locked: boolean });
      });
      app.runtime.registerCommand("manga.library", "covers.fromImage", async (envelope, signal) => {
        app.assertWritable();
        const input = envelope.input as { workId: string; pathHandle: string };
        const file = app.resolvePathFor(input.pathHandle, ["file", "import"]);
        const stat = fs.existsSync(file) ? fs.statSync(file) : null;
        if (!stat?.isFile()) throw new MangaError("NOT_FOUND", "the picture is not available");
        if (stat.size > 32 * 1024 * 1024) throw new MangaError("UNSUPPORTED_FORMAT", "the picture is larger than a cover may be");
        const added = await app.covers.add(input.workId, { bytes: fs.readFileSync(file), source: "user", select: "user", signal });
        app.notify("work.updated", { workId: input.workId, reason: "cover" });
        return { workId: input.workId, coverId: added.cover.id, added: added.added, selected: added.selected };
      });
      app.runtime.registerCommand("manga.library", "covers.handles", async (envelope, signal) => {
        const input = envelope.input as { coverIds: string[]; size: "grid" | "detail" };
        return { covers: await app.covers.handles(input.coverIds, input.size, signal) };
      });
      app.runtime.registerCommand("manga.library", "library.read", (envelope) => readResource(app, envelope));
      app.runtime.registerCommand("manga.library", "library.readOriginal", (envelope) => readResourceOriginal(app, envelope));
      app.runtime.registerCommand("manga.library", "library.readSlice", (envelope) => readResourceSlice(app, envelope));
      app.runtime.registerCommand("manga.library", "library.rebuildIndex", (envelope) => {
        app.assertWritable();
        return app.store.rebuildSearchIndex();
      });
      app.runtime.registerCommand("manga.library", "library.repairSource", (envelope, signal) => repairSource(app, envelope, signal));
      app.runtime.registerCommand("manga.library", "progress.set", (envelope) => {
        app.assertWritable();
        return setProgress(app.store, envelope, app.grantOf(envelope), app.grants);
      });
      app.runtime.registerCommand("manga.library", "progress.setPage", (envelope) => {
        app.assertWritable();
        return setPageProgress(app.store, envelope, app.grantOf(envelope), app.grants);
      });
      app.runtime.registerCommand("manga.library", "progress.setTime", (envelope) => {
        app.assertWritable();
        return setTimeProgress(app.store, envelope, app.grantOf(envelope), app.grants);
      });
      app.runtime.registerCommand("manga.library", "progress.get", (envelope) => {
        const input = envelope.input as { contextId: ContextId; resourceId: string; resourceRevisionId?: string };
        if (!app.grants.canRead(app.grantOf(envelope), input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        return getProgress(app.store, input);
      });
      app.runtime.registerCommand("manga.library", "works.list", (envelope) => listWorks(app.store, app.grantOf(envelope), envelope.input as Parameters<typeof listWorks>[2]));
      app.runtime.registerCommand("manga.library", "works.get", (envelope) => {
        const grant = app.grantOf(envelope);
        const workId = (envelope.input as { workId: string }).workId;
        const work = getWork(app.store, grant, app.grants, workId);
        if (grant.access !== "owner") return work;
        // What the owner's detail page shows beside the file facts: what to search for, and what the linked entry says (kept offline).
        const linked = app.metadata.snapshotFor(workId);
        return {
          ...work,
          suggestedQuery: app.suggestedQuery(workId),
          linkedSource: linked ? {
            providerId: linked.providerId, externalId: linked.externalId, namespace: linked.namespace, fetchedAt: linked.fetchedAt, detached: linked.detached, sourceUrl: linked.sourceUrl,
            rating: linked.snapshot.rating, episodeCount: linked.snapshot.episodes.length, relatedCount: linked.snapshot.related.length,
          } : null,
        };
      });
      app.runtime.registerCommand("manga.library", "works.deletePreview", (envelope) => {
        ownerOnly(envelope);
        return previewDeleteEntry(app.store, (envelope.input as { workId: string }).workId);
      });
      app.runtime.registerCommand("manga.library", "works.delete", (envelope) => {
        ownerOnly(envelope);
        app.assertWritable();
        const deleted = deleteEntry(app.store, envelope, envelope.input as { workId: string });
        // The files and notes made for the entry's resources leave its folder for the folder of each file (A-88).
        app.followFiles({ workIds: deleted.workIds, resourceIds: deleted.resourceIds });
        for (const workId of deleted.workIds) app.notify("work.deleted", { workId });
        return { deleted: deleted.workIds.length, workIds: deleted.workIds, resourceIds: deleted.resourceIds, title: deleted.title };
      });
      app.runtime.registerCommand("manga.library", "works.unassigned", (envelope) => {
        ownerOnly(envelope);
        return listUnassigned(app.store, envelope.input as { kind?: string; query?: string; limit?: number });
      });
      app.runtime.registerCommand("manga.library", "works.reidentify", (envelope) => {
        ownerOnly(envelope);
        app.assertWritable();
        const input = envelope.input as { resourceIds: string[] };
        const done = reidentifyResources(app.store, envelope, input.resourceIds);
        app.followFiles({ resourceIds: input.resourceIds });
        for (const workId of new Set(done.results.map((item) => item.workId))) app.notify("work.updated", { workId, reason: "reidentify" });
        return done;
      });
      app.runtime.registerCommand("manga.library", "library.outside", (envelope) => {
        ownerOnly(envelope);
        return listOutside(app.store);
      });
      app.runtime.registerCommand("manga.library", "library.outsidePreview", (envelope) => {
        ownerOnly(envelope);
        return previewRemoveOutside(app.store);
      });
      app.runtime.registerCommand("manga.library", "library.removeOutside", (envelope) => {
        ownerOnly(envelope);
        app.assertWritable();
        const removed = removeOutside(app.store, envelope, (envelope.input as { expectedCount: number }).expectedCount, (revisionId) => app.videos.forgetRevision(revisionId));
        app.notify("work.updated", { reason: "outside-removed" });
        return removed;
      });
      app.runtime.registerCommand("manga.library", "works.setKind", (envelope) => {
        app.assertWritable();
        return setResourceKind(app.store, envelope, envelope.input as Parameters<typeof setResourceKind>[2]);
      });
      app.runtime.registerCommand("manga.library", "works.moveResource", (envelope) => {
        app.assertWritable();
        const input = envelope.input as Parameters<typeof moveResource>[2];
        const moved = moveResource(app.store, envelope, input);
        // What was made from the resource goes with it, into the folder of the work it is in now.
        if (moved.moved === true && typeof moved.workId === "string") app.followFiles({ resourceIds: [input.resourceId] });
        return moved;
      });
      app.runtime.registerCommand("manga.library", "works.setOrdinal", (envelope) => {
        app.assertWritable();
        return setOrdinal(app.store, envelope, envelope.input as Parameters<typeof setOrdinal>[2]);
      });
      app.runtime.registerCommand("manga.library", "works.setShelf", (envelope) => {
        app.assertWritable();
        return setShelf(app.store, envelope, envelope.input as Parameters<typeof setShelf>[2]);
      });
      app.runtime.registerCommand("manga.library", "works.setOverride", (envelope) => {
        app.assertWritable();
        return setOverride(app.store, envelope, envelope.input as Parameters<typeof setOverride>[2]);
      });
      app.runtime.registerCommand("manga.library", "works.open", (envelope) => {
        app.assertWritable();
        return openResource(app.store, envelope, envelope.input as { resourceId: string; contextId?: ContextId });
      });
      app.runtime.registerCommand("manga.library", "reader.resolveAnchor", (envelope) => {
        const grant = app.grantOf(envelope);
        const input = envelope.input as { resourceRevisionId: string; locator: Parameters<typeof resolveAnchor>[2] };
        const resolved = resolveAnchor(app.store, input.resourceRevisionId, input.locator);
        const resourceId = resolved.resourceId;
        if (typeof resourceId === "string" && !app.grants.canRead(grant, resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        return resolved;
      });
      app.runtime.registerCommand("manga.library", "reader.ui.present", () => ({ available: app.uiFacets.has("library"), facet: "ui" }));
      app.runtime.registerCommand("manga.library", "library.getResource", (envelope) => getResource(app, envelope));
      app.runtime.registerCommand("manga.library", "library.contextSnapshot", (envelope) => contextSnapshot(app, envelope));
      app.runtime.registerCommand("manga.library", "library.search", (envelope) => app.search(envelope));
      app.runtime.registerCommand("manga.library", "library.find", (envelope) => app.search(envelope));
      app.runtime.registerCommand("manga.library", "library.list", (envelope) => libraryList(app, envelope));
      app.runtime.registerCommand("manga.library", "library.exportPackage", async (envelope, signal) => {
        const input = envelope.input as { pathHandle?: string; targetDir?: string; includeCovers?: boolean };
        if (!input.pathHandle || input.targetDir) throw new MangaError("FORBIDDEN", "export requires a host path handle");
        if (app.exportAbort) throw new MangaError("VALIDATION_ERROR", "an export is already running", { details: { reason: "busy" } });
        const controller = new AbortController();
        app.exportAbort = controller;
        const stop = () => controller.abort();
        signal.addEventListener("abort", stop, { once: true });
        try {
          return await exportLibraryPackageCancellable(app.store, app.resolvePath(input.pathHandle), { includeCovers: input.includeCovers, signal: controller.signal });
        } finally {
          signal.removeEventListener("abort", stop);
          app.exportAbort = undefined;
        }
      });
      app.runtime.registerCommand("manga.library", "library.cancelExport", () => {
        app.exportAbort?.abort();
        return { cancelled: Boolean(app.exportAbort) };
      });
      app.runtime.registerCommand("manga.library", "library.importPackage", (envelope) => {
        app.assertWritable();
        const input = envelope.input as { pathHandle?: string; sourceDir?: string };
        if (!input.pathHandle || input.sourceDir) throw new MangaError("FORBIDDEN", "import requires a host path handle");
        const imported = importLibraryPackage(app.store, app.resolvePath(input.pathHandle), { crashAt: app.store.crashAt, receipt: { key: envelope.idempotencyKey, commandId: envelope.commandId }, creative: creativePackageHooks(app) });
        app.settleImportedRecordings();
        return imported;
      });
      app.runtime.registerCommand("manga.library", "package.preview", (envelope) => {
        const input = envelope.input as { pathHandle?: string; sourceDir?: string };
        if (!input.pathHandle || input.sourceDir) throw new MangaError("FORBIDDEN", "preview requires a host path handle");
        return previewLibraryPackage(app.store, app.resolvePath(input.pathHandle));
      });
      app.runtime.registerCommand("manga.library", "package.importResolved", (envelope) => {
        app.assertWritable();
        const input = envelope.input as { pathHandle?: string; sourceDir?: string; strategy?: "skip" | "replace" | "duplicate"; decisions?: Array<{ kind: string; id: string; action: "skip" | "replace" | "duplicate" }> };
        if (!input.pathHandle || input.sourceDir) throw new MangaError("FORBIDDEN", "import requires a host path handle");
        const imported = importLibraryPackageResolved(app.store, app.resolvePath(input.pathHandle), {
          crashAt: app.store.crashAt,
          receipt: { key: envelope.idempotencyKey, commandId: envelope.commandId },
          strategy: input.strategy ?? "duplicate",
          decisions: (input.decisions ?? []) as never,
          creative: creativePackageHooks(app),
        });
        app.settleImportedRecordings();
        return imported;
      });
      app.runtime.registerCommand("manga.library", "source.card", (envelope) => {
        const input = envelope.input as { resourceId: string };
        if (!app.grants.canRead(app.grantOf(envelope), input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        return sourceCard(app.store, envelope.input as Parameters<typeof sourceCard>[1]);
      });
      app.runtime.registerCommand("manga.library", "reading.bookmarks", (envelope) => {
        const input = envelope.input as { resourceId?: string };
        if (input.resourceId && !app.grants.canRead(app.grantOf(envelope), input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        return listBookmarks(app.store, input.resourceId);
      });
      app.runtime.registerCommand("manga.library", "reading.setBookmark", (envelope) => {
        app.assertWritable();
        const input = envelope.input as { resourceId: string; bookmarkId?: string; label?: string };
        if (!app.grants.canRead(app.grantOf(envelope), input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        const detail = envelope.input as Parameters<typeof setBookmark>[1];
        return setBookmark(app.store, { ...detail, label: input.label ?? "", idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId });
      });
      app.runtime.registerCommand("manga.library", "reading.removeBookmark", (envelope) => {
        app.assertWritable();
        return removeBookmark(app.store, { bookmarkId: (envelope.input as { bookmarkId: string }).bookmarkId, idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId });
      });
      app.runtime.registerCommand("manga.library", "library.transcribeAudio", (envelope, signal) => transcribeAuthorizedFile(app, envelope, signal));
      app.runtime.registerCommand("manga.library", "library.indexExternal", (envelope) => indexExternalRoot(app, envelope));
      // Library paths and scans (A-50). A path is picked through the host dialog and only the interface may add or remove one.
      const ownerOnly = (envelope: CommandEnvelope): ScopeGrant => {
        const grant = app.grantOf(envelope);
        if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "library paths belong to the owner");
        return grant;
      };
      app.runtime.registerCommand("manga.library", "library.paths.list", async (envelope) => {
        ownerOnly(envelope);
        return { paths: await app.scan.listPaths(), schedule: app.scan.schedule() };
      });
      app.runtime.registerCommand("manga.library", "library.paths.add", async (envelope) => {
        ownerOnly(envelope);
        const input = envelope.input as { pathHandle: string; mediaKind: "novel" | "comic" | "video"; autoScan?: boolean };
        const directory = app.resolvePathFor(input.pathHandle, ["directory", "import"]);
        const added = await app.scan.addPath({ path: directory, mediaKind: input.mediaKind, autoScan: input.autoScan });
        // A new path is read once straight away, so the user sees their library appear without asking for it.
        const job = app.scan.enqueue(added.id, "add");
        return { path: added, job };
      });
      app.runtime.registerCommand("manga.library", "library.paths.update", async (envelope) => {
        ownerOnly(envelope);
        const input = envelope.input as { pathId: string; mediaKind?: "novel" | "comic" | "video"; autoScan?: boolean; pathHandle?: string };
        // Moving the path comes first: when the new folder does not hold the same files nothing else about the path changes either.
        if (input.pathHandle) {
          const moved = await app.scan.changePath(input.pathId, { path: app.resolvePathFor(input.pathHandle, ["directory", "import"]) });
          const updated = input.mediaKind !== undefined || input.autoScan !== undefined ? await app.scan.updatePath(input.pathId, input) : moved.path;
          // What the move did not see (new files, files that are not there) is found by a scan of the new folder.
          const job = app.scan.enqueue(input.pathId, "manual");
          return { path: updated, moved: true, checked: moved.checked, job };
        }
        return { path: await app.scan.updatePath(input.pathId, input) };
      });
      app.runtime.registerCommand("manga.library", "library.paths.remove", async (envelope) => {
        ownerOnly(envelope);
        const pathId = (envelope.input as { pathId: string }).pathId;
        // The resources whose file the path held: what was issued for them is withdrawn at once, and the windows showing them are told (A-86).
        const held = (app.store.sqlite.prepare(`SELECT DISTINCT v.resource_id AS id FROM file_locations fl JOIN resource_revisions v ON v.id = fl.resource_revision_id WHERE fl.library_path_id = ?`).all(pathId) as Array<{ id: string }>).map((row) => row.id);
        const removed = await app.scan.removePath(pathId);
        const resourceIds = new Set(held);
        app.media.handles.revokeWhere((binding) => binding.resourceId !== undefined && resourceIds.has(binding.resourceId));
        app.notify("library.pathRemoved", { pathId, resourceIds: held });
        return removed;
      });
      app.runtime.registerCommand("manga.library", "library.paths.ensureDownloads", async (envelope) => {
        ownerOnly(envelope);
        app.assertWritable();
        const { mediaKind } = envelope.input as { mediaKind: "novel" | "comic" | "video" };
        const dir = path.join(app.layout.partitions.downloads, "library", mediaKind);
        fs.mkdirSync(dir, { recursive: true });
        try {
          return { path: await app.scan.addPath({ path: dir, mediaKind, autoScan: true }), created: true };
        } catch (error) {
          const existing = error instanceof MangaError && error.details.reason === "duplicate" ? (await app.scan.listPaths()).find((item) => item.id === error.details.pathId) : undefined;
          if (!existing) throw error;
          return { path: existing, created: false };
        }
      });
      app.runtime.registerCommand("manga.library", "library.resourceContent", (envelope) => {
        ownerOnly(envelope);
        const { resourceId } = envelope.input as { resourceId: string };
        return resourceContent(app.store, resourceId, () => (app.runtime.gateway.has("capture.list") ? app.voice.list({ resourceId, limit: 100 }).sessions : []));
      });
      // The question every way of opening a resource asks first (A-86); nothing is opened or changed by it.
      app.runtime.registerCommand("manga.library", "library.openable", (envelope) => {
        ownerOnly(envelope);
        const { resourceId } = envelope.input as { resourceId: string };
        const resource = app.store.sqlite.prepare("SELECT id, kind, title, work_id AS workId FROM resources WHERE id = ?").get(resourceId) as { id: string; kind: string; title: string; workId: string | null } | undefined;
        if (!resource) throw new MangaError("NOT_FOUND", "resource missing");
        return { resourceId, mediaKind: resource.kind, title: resource.title, workId: resource.workId, ...checkOpenable(app.store, resourceId) };
      });
      app.runtime.registerCommand("manga.library", "works.counterpart", (envelope) => {
        ownerOnly(envelope);
        return counterpart(app.store, envelope.input as Parameters<typeof counterpart>[1]);
      });
      // Screenshots and the folders of the works (A-79). A task may read what a screenshot says about itself, never see a moment it has not reached.
      app.runtime.registerCommand("manga.library", "screenshot.save", async (envelope, signal) => {
        ownerOnly(envelope);
        app.assertWritable();
        const input = envelope.input as Parameters<ScreenshotService["save"]>[0] & { video?: { subtitleTrackId?: string } };
        assertOpenable(app.store, input.resourceId);
        const video = input.video;
        // The lines on screen at that moment are read from the track being shown, so an ASS track is covered as well as a text one.
        if (video && video.subtitleText === undefined && video.subtitleTrackId) {
          const revision = input.resourceRevisionId ?? (app.store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(input.resourceId) as { id: string } | undefined)?.id;
          try {
            const found = revision ? await app.videos.cues(input.resourceId, revision, video.subtitleTrackId, signal) : null;
            const text = found?.cues.filter((cue) => cue.startMs <= video.positionMs && video.positionMs < cue.endMs).map((cue) => cue.text).join("\n").trim();
            if (text) video.subtitleText = text.slice(0, 2000);
          } catch { /* the picture is still worth keeping without the line */ }
        }
        const { subtitleTrackId: _track, ...rest } = video ?? {};
        return { screenshot: app.screenshots.save({ ...input, ...(video ? { video: rest as NonNullable<typeof input.video> } : {}) }) };
      });
      app.runtime.registerCommand("manga.library", "screenshot.list", (envelope) => {
        const grant = app.grantOf(envelope);
        const input = envelope.input as { resourceId?: string; workId?: string; limit?: number };
        if (grant.access !== "owner" && !input.resourceId) throw new MangaError("VALIDATION_ERROR", "a task names the resource whose screenshots it wants");
        if (input.resourceId && !app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        const found = app.screenshots.list(input);
        if (grant.access === "owner") return found;
        const shown = found.items.filter((item) => app.screenshotVisible(item));
        return { items: shown.map((item) => app.screenshotForTask(item)), total: found.total, withheld: found.items.length - shown.length };
      });
      app.runtime.registerCommand("manga.library", "screenshot.get", (envelope) => {
        const grant = app.grantOf(envelope);
        const shot = app.screenshots.get((envelope.input as { screenshotId: string }).screenshotId);
        if (!shot) throw new MangaError("NOT_FOUND", "screenshot missing");
        if (grant.access === "owner") return { screenshot: shot };
        if (!app.grants.canRead(grant, shot.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        if (!app.screenshotVisible(shot)) throw new MangaError("SCOPE_DENIED", "that moment is beyond what has been read or watched", { details: { reason: "spoiler-guard" } });
        return { screenshot: app.screenshotForTask(shot) };
      });
      app.runtime.registerCommand("manga.library", "screenshot.image", (envelope) => {
        ownerOnly(envelope);
        const id = (envelope.input as { screenshotId: string }).screenshotId;
        const issued = app.media.handles.issue({ kind: "file", path: app.screenshots.pathOf(id), mediaType: "image/png" }, { moduleId: "manga.library", subject: id }, { ttlMs: 6 * 60 * 60_000 });
        return { url: issued.url, mediaType: "image/png" };
      });
      app.runtime.registerCommand("manga.library", "screenshot.delete", (envelope) => {
        ownerOnly(envelope);
        app.assertWritable();
        const input = envelope.input as { screenshotId: string; deleteFile?: boolean };
        app.media.handles.revokeSubject(input.screenshotId);
        return app.screenshots.delete(input.screenshotId, { deleteFile: input.deleteFile !== false });
      });
      app.runtime.registerCommand("manga.library", "workFolders.list", (envelope) => {
        ownerOnly(envelope);
        return { folders: app.workFolders.list() };
      });
      app.runtime.registerCommand("manga.library", "workFolders.forWork", (envelope) => {
        ownerOnly(envelope);
        const input = envelope.input as { workId?: string; resourceId?: string };
        return { groups: input.resourceId ? app.workFolders.foldersOfResource(input.resourceId) : app.workFolders.foldersOfWork(input.workId!) };
      });
      app.runtime.registerCommand("manga.library", "workFolders.rename", (envelope) => {
        ownerOnly(envelope);
        app.assertWritable();
        return { folder: app.workFolders.rename((envelope.input as { folderId: string }).folderId) };
      });
      app.runtime.registerCommand("manga.library", "library.scan.start", (envelope) => {
        ownerOnly(envelope);
        return { jobs: app.scan.start({ pathId: (envelope.input as { pathId?: string }).pathId }) };
      });
      app.runtime.registerCommand("manga.library", "library.scan.cancel", (envelope) => {
        ownerOnly(envelope);
        return app.scan.cancel(envelope.input as { jobId?: string; pathId?: string });
      });
      app.runtime.registerCommand("manga.library", "library.scan.status", (envelope) => {
        const status = app.scan.status();
        if (app.grantOf(envelope).access === "owner") return status;
        // A task may ask how a scan is going; where the folders are on app machine is not something it needs.
        const hide = (job: ScanJob): ScanJob => ({ ...job, path: path.basename(job.path), current: null });
        return { running: status.running ? hide(status.running) : null, queued: status.queued.map(hide), recent: status.recent.map(hide), schedule: status.schedule };
      });
      app.runtime.registerCommand("manga.library", "library.scan.setSchedule", (envelope) => {
        ownerOnly(envelope);
        return { schedule: app.scan.setSchedule(envelope.input as Parameters<ScanService["setSchedule"]>[0]) };
      });
    },
    deactivate: () => {
      app.parseGeneration += 1;
    },
  });
}
