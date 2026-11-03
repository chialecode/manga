/** The project and creative modules: projects, canvases, drafts, research, the semantic index, plugins, acquisition and rough cuts. */
import { MangaError, type CommandEnvelope, type EmbedKind, type PluginPermission, type RoughcutExportOptions } from "@manga/contracts";
import { defineModule, type MangaModule } from "@manga/plugin-sdk";
import type { CreativeHooks } from "../creative/library-section.ts";
import { DraftService } from "../creative/drafts.ts";
import { importProjectPackage, previewProjectPackage, writeProjectPackage } from "../creative/project-package.ts";
import { writeExportFile } from "../creative/export-file.ts";
import type { MangaProductApp, CreativeReg } from "../product-app.ts";

/** What these commands use of the application. */
export type CreativeHost = Pick<MangaProductApp, "acquisition" | "agentAccess" | "assertWritable" | "closed" | "drafts" | "embeds" | "grantOf" | "mindmaps" | "pluginRuntime" | "plugins" | "projects" | "research" | "resolvePath" | "resolvePathFor" | "roughcuts" | "runtime" | "semantic" | "store" | "uiFacets" | "whiteboards">;

export function projectsModule(app: CreativeHost): MangaModule {
  const moduleId = "manga.projects";
  return defineModule({
    manifest: {
      moduleId,
      version: "1.0.0",
      displayName: "项目",
      featureId: "projects",
      contributes: [{ capabilityId: "manga.projects", version: "1.0.0" }],
      needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
      facets: ["service", "ui"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      if ((ctx.hostFacets ?? []).includes("ui")) {
        app.uiFacets.add("projects");
        ctx.register({ kind: "subscription", id: `projects-ui-${ctx.epoch}`, dispose: () => { app.uiFacets.delete("projects"); } });
      }
      const reg = (commandId: string, handler: (envelope: CommandEnvelope) => unknown, options: { write?: boolean } = {}) => app.runtime.registerCommand(moduleId, commandId, (envelope) => {
        const reply = creativeAccess(app, envelope, commandId, "projects");
        if (options.write !== false) app.assertWritable();
        return reply ? reply(handler(envelope)) : handler(envelope);
      });
      const input = <T>(envelope: CommandEnvelope) => envelope.input as T;
      reg("project.list", (envelope) => app.projects.list(input<{ status?: "active" | "archived" | "all" }>(envelope).status), { write: false });
      reg("project.overview", () => app.projects.overview(), { write: false });
      reg("project.create", (envelope) => app.projects.create(input(envelope)));
      reg("project.get", (envelope) => app.projects.get(input<{ projectId: string }>(envelope).projectId), { write: false });
      reg("project.update", (envelope) => app.projects.update(input(envelope)));
      reg("project.delete", (envelope) => app.projects.delete(input<{ projectId: string }>(envelope).projectId));
      reg("project.addMaterial", (envelope) => app.projects.addMaterial(input(envelope)));
      reg("project.objects", (envelope) => app.projects.objects(input<{ projectId: string }>(envelope).projectId), { write: false });
      reg("project.removeMaterial", (envelope) => { const value = input<{ projectId: string; materialId: string }>(envelope); return app.projects.removeMaterial(value.projectId, value.materialId); });
      reg("project.terms", (envelope) => ({ terms: app.projects.terms(input<{ projectId: string }>(envelope).projectId) }), { write: false });
      reg("project.addTerm", (envelope) => app.projects.addTerm(input(envelope)));
      reg("project.updateTerm", (envelope) => app.projects.updateTerm(input(envelope)));
      reg("project.removeTerm", (envelope) => { const value = input<{ projectId: string; termId: string }>(envelope); return app.projects.removeTerm(value.projectId, value.termId); });
      reg("project.importTerms", (envelope) => { const value = input<{ projectId: string; workId: string }>(envelope); return app.projects.importWorkTerms(value.projectId, value.workId); });
      // A package goes to a folder the person picked, and comes from a file they picked, both through the host dialog; only names come back.
      reg("project.exportPackage", (envelope) => {
        const value = input<{ projectId: string; pathHandle: string }>(envelope);
        return writeProjectPackage(app.store, value.projectId, app.resolvePathFor(value.pathHandle, ["directory", "export"]));
      }, { write: false });
      reg("project.packagePreview", (envelope) => previewProjectPackage(app.store, app.resolvePathFor(input<{ pathHandle: string }>(envelope).pathHandle, ["file", "import"])), { write: false });
      reg("project.importPackage", (envelope) => {
        return importProjectPackage(app.store, app.resolvePathFor(input<{ pathHandle: string }>(envelope).pathHandle, ["file", "import"]), creativePackageHooks(app));
      });
    },
    deactivate: () => undefined,
  });
}

/** What bringing projects in from a package needs from the application: keeping pages, indexing excerpts, and taking out a project that a replace overwrites. */
export function creativePackageHooks(app: CreativeHost): Omit<CreativeHooks, "mapTarget"> {
  return {
    adoptPage: (page, preferredId) => app.research.adoptPage(page, preferredId),
    indexExcerpt: (row) => app.research.indexExcerpt(row),
    connectionExists: (id) => Boolean(app.store.sqlite.prepare("SELECT 1 FROM provider_connections WHERE id = ?").get(id)),
    removeProject: (projectId) => { app.projects.delete(projectId); },
  };
}

/**
 * Who may run a creative command: the owner, and, for the few commands an agent of a project may use (A-73), that agent inside its project.
 * For an agent it returns what to do with the reply (cut it to the project and to a size the model can be given); for the owner, null.
 */
export function creativeAccess(app: CreativeHost, envelope: CommandEnvelope, commandId: string, featureId: string): ((value: unknown) => unknown) | null {
  const grant = app.grantOf(envelope);
  if (grant.access === "owner") return null;
  const rule = grant.actor.kind === "agent" ? app.agentAccess.rule(commandId) : undefined;
  if (!rule) throw new MangaError("FORBIDDEN", `${featureId} belongs to the owner`);
  const projectId = app.agentAccess.projectOf(grant);
  const asked = structuredClone(envelope.input ?? {}) as Record<string, unknown>;
  rule.check(envelope, projectId, grant);
  return (value) => app.agentAccess.fit(rule.shape ? rule.shape(value, projectId, asked) : value);
}

/**
 * The shape every creative module shares: owner commands (a few of them also open to an agent of a project, see `creativeAccess`), a UI facet for the pages that show it, and a `write` switch so reads still work
 * while the profile location is being changed. Each module only lists its commands.
 */
export function creativeModule(app: CreativeHost, spec: { moduleId: string; featureId: string; displayName: string; needs?: string[]; optionalNeeds?: string[]; facet?: boolean; register: (reg: CreativeReg, input: <T>(envelope: CommandEnvelope) => T) => void; onDeactivate?: () => void }): MangaModule {
  return defineModule({
    manifest: {
      moduleId: spec.moduleId,
      version: "1.0.0",
      displayName: spec.displayName,
      featureId: spec.featureId,
      contributes: [{ capabilityId: `manga.${spec.featureId}`, version: "1.0.0" }],
      needs: [
        ...["manga.library", ...(spec.needs ?? [])].map((capabilityId) => ({ capabilityId, version: "1.0.0", cardinality: "single" as const, required: true })),
        ...(spec.optionalNeeds ?? []).map((capabilityId) => ({ capabilityId, version: "1.0.0", cardinality: "single" as const, required: false })),
      ],
      facets: ["service", "ui"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      if (spec.facet !== false && (ctx.hostFacets ?? []).includes("ui")) {
        app.uiFacets.add(spec.featureId);
        ctx.register({ kind: "subscription", id: `${spec.featureId}-ui-${ctx.epoch}`, dispose: () => { app.uiFacets.delete(spec.featureId); } });
      }
      const reg: CreativeReg = (commandId, handler, options = {}) => app.runtime.registerCommand(spec.moduleId, commandId, (envelope, signal) => {
        const reply = creativeAccess(app, envelope, commandId, spec.featureId);
        if (options.write !== false) app.assertWritable();
        const value = handler(envelope, signal);
        return reply ? (value instanceof Promise ? value.then(reply) : reply(value)) : value;
      });
      spec.register(reg, <T>(envelope: CommandEnvelope) => envelope.input as T);
    },
    deactivate: () => { spec.onDeactivate?.(); },
  });
}

export function canvasModules(app: CreativeHost): MangaModule[] {
  return [
    creativeModule(app, {
      moduleId: "manga.embeds", featureId: "embeds", displayName: "嵌入",
      register: (reg, input) => {
        type Slot = { sourceKind: EmbedKind; sourceId: string; slot: string };
        reg("embed.list", (envelope) => { const value = input<{ sourceKind: EmbedKind; sourceId: string }>(envelope); return { embeds: app.embeds.list(value.sourceKind, value.sourceId) }; }, { write: false });
        reg("embed.upsert", (envelope) => ({ embed: app.embeds.upsert(input(envelope)) }));
        reg("embed.remove", (envelope) => { const value = input<Slot>(envelope); return app.embeds.remove(value.sourceKind, value.sourceId, value.slot); });
        reg("embed.refresh", (envelope) => { const value = input<Slot>(envelope); return { embed: app.embeds.refresh(value.sourceKind, value.sourceId, value.slot) }; });
        reg("embed.backlinks", (envelope) => { const value = input<{ targetKind: EmbedKind; targetId: string }>(envelope); return { backlinks: app.embeds.backlinks(value.targetKind, value.targetId) }; }, { write: false });
      },
    }),
    creativeModule(app, {
      moduleId: "manga.whiteboard", featureId: "whiteboard", displayName: "白板", needs: ["manga.projects"],
      register: (reg, input) => {
        reg("whiteboard.list", (envelope) => app.whiteboards.list(input<{ projectId?: string }>(envelope).projectId), { write: false });
        reg("whiteboard.create", (envelope) => ({ board: app.whiteboards.create(input(envelope)) }));
        reg("whiteboard.get", (envelope) => app.whiteboards.get(input<{ boardId: string }>(envelope).boardId), { write: false });
        reg("whiteboard.rename", (envelope) => { const value = input<{ boardId: string; title: string }>(envelope); return { board: app.whiteboards.rename(value.boardId, value.title) }; });
        reg("whiteboard.delete", (envelope) => app.whiteboards.delete(input<{ boardId: string }>(envelope).boardId));
        reg("whiteboard.edit", (envelope) => app.whiteboards.edit(input(envelope)));
        reg("whiteboard.setViewport", (envelope) => { const value = input<{ boardId: string; viewport: { x: number; y: number; zoom: number } }>(envelope); return app.whiteboards.setViewport(value.boardId, value.viewport); });
        reg("whiteboard.undo", (envelope) => app.whiteboards.undo(input<{ boardId: string }>(envelope).boardId));
        reg("whiteboard.redo", (envelope) => app.whiteboards.redo(input<{ boardId: string }>(envelope).boardId));
      },
    }),
    creativeModule(app, {
      moduleId: "manga.copywriting", featureId: "copywriting", displayName: "文案", needs: ["manga.projects"],
      register: (reg, input) => {
        reg("draft.list", (envelope) => app.drafts.list(input<{ projectId?: string }>(envelope).projectId), { write: false });
        reg("draft.create", (envelope) => ({ draft: app.drafts.create(input(envelope)) }));
        reg("draft.get", (envelope) => app.drafts.get(input<{ draftId: string }>(envelope).draftId), { write: false });
        reg("draft.rename", (envelope) => { const value = input<{ draftId: string; title: string }>(envelope); return { draft: app.drafts.rename(value.draftId, value.title) }; });
        reg("draft.delete", (envelope) => app.drafts.delete(input<{ draftId: string }>(envelope).draftId));
        reg("draft.save", (envelope) => { const value = input<{ draftId: string; expectedVersion: number; text: string }>(envelope); return { draft: app.drafts.save(value.draftId, value.expectedVersion, value.text) }; });
        reg("draft.checkpoint", (envelope) => { const value = input<{ draftId: string; label?: string }>(envelope); return app.drafts.checkpoint(value.draftId, value.label); });
        reg("draft.version", (envelope) => { const value = input<{ draftId: string; version: number }>(envelope); return app.drafts.version(value.draftId, value.version); }, { write: false });
        reg("draft.restore", (envelope) => { const value = input<{ draftId: string; version: number }>(envelope); return { draft: app.drafts.restore(value.draftId, value.version) }; });
        reg("draft.suggest", (envelope) => app.drafts.suggest({ ...input<Parameters<DraftService["suggest"]>[0]>(envelope), ...(envelope.actor.kind === "agent" ? { author: "agent" as const } : {}) }));
        reg("draft.suggestions", (envelope) => app.drafts.suggestions(input<{ draftId: string }>(envelope).draftId), { write: false });
        reg("draft.suggestion", (envelope) => app.drafts.suggestion(input<{ suggestionId: string }>(envelope).suggestionId), { write: false });
        reg("draft.cancelSuggestion", (envelope) => app.drafts.cancel(input<{ suggestionId: string }>(envelope).suggestionId));
        reg("draft.adopt", (envelope) => { const value = input<{ suggestionId: string; force?: boolean }>(envelope); return app.drafts.adopt(value.suggestionId, value.force); });
        reg("draft.undoAdopt", (envelope) => app.drafts.undoAdopt(input<{ suggestionId: string }>(envelope).suggestionId));
        reg("draft.discardSuggestion", (envelope) => app.drafts.discard(input<{ suggestionId: string }>(envelope).suggestionId));
        reg("draft.keepSuggestion", (envelope) => app.drafts.keepSuggestion(input<{ suggestionId: string }>(envelope).suggestionId));
      },
    }),
    creativeModule(app, {
      moduleId: "manga.mindmap", featureId: "mindmap", displayName: "思维导图", needs: ["manga.projects"],
      register: (reg, input) => {
        reg("mindmap.list", (envelope) => app.mindmaps.list(input<{ projectId?: string }>(envelope).projectId), { write: false });
        reg("mindmap.create", (envelope) => ({ map: app.mindmaps.create(input(envelope)) }));
        reg("mindmap.get", (envelope) => app.mindmaps.get(input<{ mapId: string }>(envelope).mapId), { write: false });
        reg("mindmap.rename", (envelope) => { const value = input<{ mapId: string; title: string }>(envelope); return { map: app.mindmaps.rename(value.mapId, value.title) }; });
        reg("mindmap.delete", (envelope) => app.mindmaps.delete(input<{ mapId: string }>(envelope).mapId));
        reg("mindmap.setTheme", (envelope) => { const value = input<{ mapId: string; theme: string }>(envelope); return { map: app.mindmaps.setTheme(value.mapId, value.theme) }; });
        reg("mindmap.edit", (envelope) => app.mindmaps.edit(input(envelope)));
        reg("mindmap.undo", (envelope) => app.mindmaps.undo(input<{ mapId: string }>(envelope).mapId));
        reg("mindmap.redo", (envelope) => app.mindmaps.redo(input<{ mapId: string }>(envelope).mapId));
        // The file goes to a folder the user picked through the host dialog; only its name comes back.
        reg("mindmap.export", (envelope) => exportMindmap(app, input(envelope)), { write: false });
      },
    }),
  ];
}

/** What a project's search may see: the books, notes, recordings and excerpts it holds or owns. */
export function semanticScope(app: CreativeHost, projectId: string): { resourceIds: string[]; noteIds: string[]; recordingIds: string[]; excerptIds: string[] } {
  const held = (kind: string) => (app.store.sqlite.prepare("SELECT target_id AS id FROM project_materials WHERE project_id = ? AND kind = ?").all(projectId, kind) as Array<{ id: string }>).map((row) => row.id);
  const owned = (app.store.sqlite.prepare("SELECT id FROM excerpts WHERE project_id = ?").all(projectId) as Array<{ id: string }>).map((row) => row.id);
  return { resourceIds: app.projects.scopeResourceIds(projectId), noteIds: app.projects.scopeNoteIds(projectId), recordingIds: held("recording"), excerptIds: [...new Set([...held("excerpt"), ...owned])] };
}

export function semanticModule(app: CreativeHost): MangaModule {
  return creativeModule(app, {
    moduleId: "manga.semantic", featureId: "semantic", displayName: "语义检索",
    register: (reg, input) => {
      reg("semantic.status", () => app.semantic.status(), { write: false });
      reg("semantic.configure", (envelope) => app.semantic.configure(input(envelope)));
      reg("semantic.rebuild", () => app.semantic.rebuild());
      reg("semantic.cancel", () => app.semantic.cancel());
      reg("semantic.update", () => app.semantic.update());
      reg("semantic.clear", () => app.semantic.clear());
      reg("semantic.search", (envelope, signal) => app.semantic.search(input(envelope), signal), { write: false });
    },
  });
}

export function pluginsModule(app: CreativeHost): MangaModule {
  const fileOf = (value: { pathHandle?: string; bundledId?: string }) => ({ path: value.bundledId ? app.plugins.bundledFile(value.bundledId) : app.resolvePathFor(value.pathHandle ?? "", ["file", "import"]) });
  return creativeModule(app, {
    moduleId: "manga.plugins", featureId: "plugins", displayName: "插件",
    // Switching the feature off stops every plugin's process; switching it on (and the application's start) starts what the person had enabled.
    onDeactivate: () => { void app.pluginRuntime.stopAll(); },
    register: (reg, input) => {
      if (!app.closed) void app.plugins.restore().catch(() => undefined);
      reg("plugin.list", () => app.plugins.list(), { write: false });
      reg("plugin.bundled", () => ({ bundled: app.plugins.bundled() }), { write: false });
      reg("plugin.inspect", (envelope) => app.plugins.inspect(fileOf(input(envelope))), { write: false });
      reg("plugin.install", (envelope) => { const value = input<{ pathHandle?: string; bundledId?: string; grant: PluginPermission[]; enable?: boolean }>(envelope); return app.plugins.install(fileOf(value), value.grant, value.enable !== false); });
      reg("plugin.enable", async (envelope) => ({ plugin: await app.plugins.enable(input<{ pluginId: string }>(envelope).pluginId) }));
      reg("plugin.disable", async (envelope) => ({ plugin: await app.plugins.disable(input<{ pluginId: string }>(envelope).pluginId) }));
      reg("plugin.rollback", async (envelope) => ({ plugin: await app.plugins.rollback(input<{ pluginId: string }>(envelope).pluginId) }));
      reg("plugin.uninstall", (envelope) => { const value = input<{ pluginId: string; deleteData?: boolean }>(envelope); return app.plugins.uninstall(value.pluginId, value.deleteData === true); });
      reg("plugin.exportData", (envelope) => { const value = input<{ pluginId: string; pathHandle: string }>(envelope); return app.plugins.exportData(value.pluginId, app.resolvePathFor(value.pathHandle, ["directory", "export"])); }, { write: false });
      reg("plugin.deleteData", (envelope) => app.plugins.deleteData(input<{ pluginId: string }>(envelope).pluginId));
      reg("plugin.trust.list", () => app.plugins.trustList(), { write: false });
      reg("plugin.trust.add", (envelope) => { const value = input<{ publicKey: string; label: string }>(envelope); return app.plugins.addTrust(value.publicKey, value.label); });
      reg("plugin.trust.remove", (envelope) => app.plugins.removeTrust(input<{ keyId: string }>(envelope).keyId));
    },
  });
}

/**
 * Downloads through an engine plugin. The page is offered by the plugin's own facet (and only while app feature is on), not by app module, so
 * without an engine installed there is no page. Switching the feature off puts every running download on hold.
 */
export function acquisitionModule(app: CreativeHost): MangaModule {
  type Budget = { maxBytes?: number; downKbps?: number; upKbps?: number };
  return creativeModule(app, {
    moduleId: "manga.acquisition", featureId: "acquisition", displayName: "下载", facet: false,
    onDeactivate: () => { void app.acquisition.suspend(); },
    register: (reg, input) => {
      if (!app.closed) app.acquisition.recover();
      reg("acquisition.list", () => app.acquisition.list(), { write: false });
      reg("acquisition.get", (envelope) => app.acquisition.get(input<{ jobId: string }>(envelope).jobId), { write: false });
      reg("acquisition.add", (envelope) => {
        const value = input<{ magnet?: string; pathHandle?: string; pathId: string; subdir?: string; budget?: Budget }>(envelope);
        return app.acquisition.add({ magnet: value.magnet, torrentFile: value.pathHandle ? app.resolvePathFor(value.pathHandle, ["file", "import"]) : undefined, pathId: value.pathId, subdir: value.subdir, budget: value.budget });
      });
      reg("acquisition.select", (envelope) => { const value = input<{ jobId: string; indexes: number[]; budget?: Budget }>(envelope); return app.acquisition.select(value.jobId, value.indexes, value.budget); });
      reg("acquisition.pause", (envelope) => app.acquisition.pause(input<{ jobId: string }>(envelope).jobId));
      reg("acquisition.resume", (envelope) => app.acquisition.resume(input<{ jobId: string }>(envelope).jobId));
      reg("acquisition.cancel", (envelope) => app.acquisition.cancel(input<{ jobId: string }>(envelope).jobId));
      reg("acquisition.remove", (envelope) => app.acquisition.remove(input<{ jobId: string }>(envelope).jobId));
      reg("acquisition.retryPublish", (envelope) => app.acquisition.retryPublish(input<{ jobId: string }>(envelope).jobId));
      reg("acquisition.retryImport", (envelope) => app.acquisition.retryImport(input<{ jobId: string }>(envelope).jobId));
      reg("acquisition.restart", (envelope) => app.acquisition.restart(input<{ jobId: string }>(envelope).jobId));
      reg("acquisition.setSeeding", (envelope) => { const value = input<{ jobId: string; enabled: boolean; ratio?: number; upKbps?: number }>(envelope); return app.acquisition.setSeeding(value.jobId, value.enabled, value.ratio, value.upKbps); });
    },
  });
}

export function roughcutModule(app: CreativeHost): MangaModule {
  return creativeModule(app, {
    moduleId: "manga.roughcut", featureId: "roughcut", displayName: "粗剪", needs: ["manga.projects"],
    // The cuts are lists of times of videos in the library: they stay readable and editable when the video module is off; only playing a clip waits for it.
    optionalNeeds: ["manga.video"],
    onDeactivate: () => app.roughcuts.suspend(),
    register: (reg, input) => {
      if (!app.closed) app.roughcuts.recover();
      reg("roughcut.list", (envelope) => app.roughcuts.list(input<{ projectId?: string }>(envelope).projectId), { write: false });
      reg("roughcut.create", (envelope) => ({ cut: app.roughcuts.create(input(envelope)) }));
      reg("roughcut.get", (envelope) => app.roughcuts.get(input<{ cutId: string }>(envelope).cutId), { write: false });
      reg("roughcut.rename", (envelope) => { const value = input<{ cutId: string; title: string }>(envelope); return { cut: app.roughcuts.rename(value.cutId, value.title) }; });
      reg("roughcut.delete", (envelope) => app.roughcuts.delete(input<{ cutId: string }>(envelope).cutId));
      reg("roughcut.edit", (envelope) => app.roughcuts.edit(input(envelope)));
      reg("roughcut.undo", (envelope) => app.roughcuts.undo(input<{ cutId: string }>(envelope).cutId));
      reg("roughcut.redo", (envelope) => app.roughcuts.redo(input<{ cutId: string }>(envelope).cutId));
      reg("roughcut.plan", async (envelope, signal) => {
        const value = input<{ cutId: string; options?: RoughcutExportOptions }>(envelope);
        return { plan: (await app.roughcuts.plan(value.cutId, value.options, signal)).plan };
      }, { write: false });
      reg("roughcut.export", async (envelope, signal) => {
        const value = input<{ cutId: string; pathHandle?: string; fileName?: string; options?: RoughcutExportOptions }>(envelope);
        const dir = value.pathHandle ? app.resolvePathFor(value.pathHandle, ["directory", "export"]) : undefined;
        return { export: await app.roughcuts.startExport({ cutId: value.cutId, dir, fileName: value.fileName, options: value.options }, signal) };
      });
      reg("roughcut.cancel", (envelope) => ({ export: app.roughcuts.cancelExport(input<{ exportId: string }>(envelope).exportId) }));
      reg("roughcut.exports", (envelope) => app.roughcuts.exportsOf(input<{ cutId: string }>(envelope).cutId), { write: false });
    },
  });
}

export function researchModule(app: CreativeHost): MangaModule {
  return creativeModule(app, {
    moduleId: "manga.research", featureId: "research", displayName: "材料搜寻",
    register: (reg, input) => {
      reg("research.search", (envelope) => app.research.search(input(envelope)), { write: false });
      reg("webpage.fetch", (envelope, signal) => app.research.fetch(input<{ url: string }>(envelope).url, signal));
      reg("webpage.list", (envelope) => app.research.pages(input<{ limit?: number }>(envelope).limit), { write: false });
      reg("webpage.get", (envelope) => app.research.getPage(input<{ pageId: string }>(envelope).pageId), { write: false });
      reg("webpage.delete", (envelope) => app.research.deletePage(input<{ pageId: string }>(envelope).pageId));
      reg("excerpt.create", (envelope) => ({ excerpt: app.research.create(input(envelope)) }));
      reg("excerpt.list", (envelope) => app.research.excerpts(input(envelope)), { write: false });
      reg("excerpt.get", (envelope) => app.research.get(input<{ excerptId: string }>(envelope).excerptId), { write: false });
      reg("excerpt.update", (envelope) => { const value = input<{ excerptId: string; title?: string; note?: string }>(envelope); return { excerpt: app.research.update(value.excerptId, value) }; });
      reg("excerpt.delete", (envelope) => app.research.delete(input<{ excerptId: string }>(envelope).excerptId));
      reg("excerpt.follow", (envelope) => app.research.follow(input<{ excerptId: string }>(envelope).excerptId));
    },
  });
}

export function exportMindmap(app: CreativeHost, input: { mapId: string; format: "png" | "svg" | "markdown" | "opml"; pathHandle: string; data?: string }): { fileName: string; bytes: number; format: string } {
  const dir = app.resolvePath(input.pathHandle);
  const title = app.mindmaps.get(input.mapId).map.title;
  let payload: Buffer | string;
  let extension: string;
  if (input.format === "markdown") { payload = app.mindmaps.toMarkdown(input.mapId); extension = "md"; }
  else if (input.format === "opml") { payload = app.mindmaps.toOpml(input.mapId); extension = "opml"; }
  else {
    if (!input.data) throw new MangaError("VALIDATION_ERROR", "an image export carries the drawn image", { details: { reason: "data" } });
    if (input.format === "svg") {
      if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(input.data)) throw new MangaError("VALIDATION_ERROR", "that is not an SVG image", { details: { reason: "format" } });
      payload = input.data; extension = "svg";
    } else {
      const bytes = Buffer.from(input.data, "base64");
      if (bytes.length < 8 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new MangaError("VALIDATION_ERROR", "that is not a PNG image", { details: { reason: "format" } });
      payload = bytes; extension = "png";
    }
  }
  return { ...writeExportFile(dir, title, extension, payload, "mindmap"), format: input.format };
}
