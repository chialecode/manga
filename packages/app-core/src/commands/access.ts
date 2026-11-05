/** Which commands the owner may call. Agents get the narrower lists below; both are fixed in the command snapshot test. */
export const OWNER_COMMANDS = [
  "workspace.get", "workspace.sessions", "workspace.contexts", "workspace.loadContext", "workspace.saveContext", "workspace.setLastContext", "workspace.sidebar", "workspace.items", "workspace.objects", "workspace.find", "session.open", "library.importText", "library.importEpub", "library.importDocument", "library.getResource", "library.read", "library.readOriginal", "library.readSlice", "library.contextSnapshot", "library.search", "library.find", "library.list",
  "library.exportPackage", "library.cancelExport", "library.importPackage", "package.preview", "package.importResolved", "library.transcribeAudio", "library.indexExternal", "library.rebuildIndex", "library.repairSource", "progress.set", "progress.setPage", "progress.setTime", "progress.get",
  "works.list", "works.get", "works.deletePreview", "works.delete", "works.unassigned", "works.reidentify", "library.outside", "library.outsidePreview", "library.removeOutside", "works.setKind", "works.moveResource", "works.setOrdinal", "works.setShelf", "works.setOverride", "works.open",
  "notes.create", "notes.update", "notes.undo", "notes.get", "notes.list", "notes.history", "notes.restore", "notes.tags", "notes.split", "notes.merge", "notes.move", "notes.copy", "notes.replace", "notes.insert", "notes.remove", "notes.setType", "notes.rename", "notes.asset", "notes.openSource",
  "reader.resolveAnchor", "reader.ui.present", "source.card",
  "reading.bookmarks", "reading.setBookmark", "reading.removeBookmark",
  "inventory.overview", "inventory.scan", "inventory.cancelScan", "inventory.reveal", "inventory.repair", "settings.get", "settings.skipAi",
  "settings.proposeLocations", "settings.applyLocations", "settings.cleanLegacyLocation", "settings.recoverJobs", "settings.setRuntime", "settings.setLayout", "settings.getShell", "settings.setShell",
  "connections.list", "connections.upsert", "connections.test", "connections.delete", "connections.setProfile", "connections.probe", "settings.getAgent", "settings.setAgent", "agent.trace.list", "agent.trace.get", "agent.trace.export", "agent.trace.stats", "agent.trace.clear",
  "agent.createSession", "agent.send", "agent.cancel", "agent.retry", "agent.getRun",
  "library.inspectFile", "works.importDirectory", "comic.pages", "comic.pageHandle", "comic.pageHandles",
  "video.probe", "video.subtitles", "video.audioTracks", "video.frameIndex", "video.keyframes", "video.cancelFrameIndex", "video.playbackPlan", "video.playCopy", "video.handle", "video.subtitleHandle", "video.fonts",
  "covers.list", "covers.select", "covers.lock", "covers.fromImage", "covers.handles",
  "metadata.providers", "metadata.setProvider", "metadata.search", "metadata.candidates", "metadata.link", "metadata.unlink", "metadata.refresh", "metadata.related", "metadata.findMissing",
  "material.region", "material.frame", "material.subtitleWindow",
  "settings.getRecording", "settings.setRecording", "settings.getMedia", "settings.setMedia", "settings.getModules", "settings.setModule",
  "capture.start", "capture.append", "capture.event", "capture.stop", "capture.status", "capture.list", "capture.transcribe", "capture.retry", "capture.cancel", "capture.organize", "capture.editDraft", "capture.acceptDraft",
  "capture.retain", "capture.review", "capture.reviseSegment", "capture.calibrate", "capture.terms", "capture.addTerm", "capture.removeTerm", "capture.audioHandle",
  "library.paths.list", "library.paths.add", "library.paths.update", "library.paths.remove", "library.paths.ensureDownloads", "library.resourceContent", "library.openable", "works.counterpart", "screenshot.save", "screenshot.list", "screenshot.get", "screenshot.image", "screenshot.delete", "workFolders.list", "workFolders.forWork", "workFolders.rename", "library.scan.start", "library.scan.cancel", "library.scan.status", "library.scan.setSchedule",
  "metadata.resolveRef", "metadata.preview", "metadata.characters",
  "danmaku.status", "danmaku.match", "danmaku.search", "danmaku.choose", "danmaku.setOffset", "danmaku.load", "danmaku.getSettings", "danmaku.setSettings", "danmaku.setCredentials", "danmaku.clearCache", "danmaku.around",
  "quickTasks.list", "quickTasks.save", "quickTasks.delete", "quickTasks.reorder", "quickTasks.restore",
  "log.query", "usage.query", "records.list", "notes.delete", "notes.undelete", "session.stream", "debug.context",
  "project.list", "project.overview", "project.create", "project.get", "project.update", "project.delete", "project.addMaterial", "project.removeMaterial", "project.objects", "project.terms", "project.addTerm", "project.updateTerm", "project.removeTerm", "project.importTerms", "project.exportPackage", "project.packagePreview", "project.importPackage",
  "conversation.current", "conversation.new", "conversation.history", "conversation.resume", "conversation.rename", "conversation.move", "conversation.list", "conversation.delete", "conversation.deleteAll",
  "dictionary.list", "dictionary.removedWorks", "dictionary.add", "dictionary.update", "dictionary.remove", "dictionary.importMetadata", "dictionary.prompt",
  "whiteboard.list", "whiteboard.create", "whiteboard.get", "whiteboard.rename", "whiteboard.delete", "whiteboard.edit", "whiteboard.setViewport", "whiteboard.undo", "whiteboard.redo",
  "draft.list", "draft.create", "draft.get", "draft.rename", "draft.delete", "draft.save", "draft.checkpoint", "draft.version", "draft.restore",
  "draft.suggest", "draft.suggestions", "draft.suggestion", "draft.cancelSuggestion", "draft.adopt", "draft.undoAdopt", "draft.discardSuggestion", "draft.keepSuggestion",
  "mindmap.list", "mindmap.create", "mindmap.get", "mindmap.rename", "mindmap.delete", "mindmap.setTheme", "mindmap.edit", "mindmap.undo", "mindmap.redo", "mindmap.export",
  "roughcut.list", "roughcut.create", "roughcut.get", "roughcut.rename", "roughcut.delete", "roughcut.edit", "roughcut.undo", "roughcut.redo", "roughcut.plan", "roughcut.export", "roughcut.cancel", "roughcut.exports",
  "embed.list", "embed.upsert", "embed.remove", "embed.refresh", "embed.backlinks",
  "semantic.status", "semantic.configure", "semantic.rebuild", "semantic.cancel", "semantic.update", "semantic.clear", "semantic.search",
  "plugin.list", "plugin.bundled", "plugin.inspect", "plugin.install", "plugin.enable", "plugin.disable", "plugin.rollback", "plugin.uninstall", "plugin.exportData", "plugin.deleteData", "plugin.trust.list", "plugin.trust.add", "plugin.trust.remove",
  "acquisition.list", "acquisition.get", "acquisition.add", "acquisition.select", "acquisition.pause", "acquisition.resume", "acquisition.cancel", "acquisition.remove", "acquisition.retryPublish", "acquisition.retryImport", "acquisition.restart", "acquisition.setSeeding",
  "research.search", "webpage.fetch", "webpage.list", "webpage.get", "webpage.delete", "excerpt.create", "excerpt.list", "excerpt.get", "excerpt.update", "excerpt.delete", "excerpt.follow",
];

/** Commands that change the blocks of a note, after which the note's embeds are reconciled with them. */
export const NOTE_CONTENT_COMMANDS = new Set(["notes.create", "notes.update", "notes.undo", "notes.split", "notes.merge", "notes.move", "notes.copy", "notes.replace", "notes.insert", "notes.remove", "notes.setType", "notes.restore"]);
/** Agent commands that reach outside the machine; a task has them only when the user turned them on for that task. */
export const AGENT_OPT_IN_COMMANDS = ["metadata.search"];
export const AGENT_COMMANDS = ["library.find", "library.list", "library.getResource", "library.read", "library.contextSnapshot", "source.card", "notes.create", "notes.update", "notes.get", "notes.list", "notes.undo", "inventory.overview", "works.list", "works.get", "progress.get", "comic.pages", "material.subtitleWindow", "library.scan.status", "log.query", "screenshot.list", "screenshot.get", "danmaku.around"];
