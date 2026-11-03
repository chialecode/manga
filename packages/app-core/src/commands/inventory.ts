/** The inventory module: what the profile holds on disk, its index and repair. */
import fs from "node:fs";
import path from "node:path";
import { MangaError, LOCATION_PARTITIONS, createId, type CommandEnvelope, type LocationLayout, type ScopeGrant } from "@manga/contracts";
import { defineModule, type MangaModule } from "@manga/plugin-sdk";
import { directoryStats, pathsOverlap, scanDirectoryBatched } from "../locations.ts";
import { absoluteIn } from "../library-locations.ts";
import type { MangaProductApp } from "../product-app.ts";
import { encodeResourceCursor } from "../product-helpers.ts";

/** What these commands use of the application. */
export type InventoryHost = Pick<MangaProductApp, "assertWritable" | "covers" | "grantOf" | "layout" | "resolvePath" | "runtime" | "scanAbort" | "screenshots" | "store" | "uiFacets" | "workFolders">;

export function inventoryModule(app: InventoryHost): MangaModule {
  return defineModule({
    manifest: {
      moduleId: "manga.inventory",
      version: "1.0.0",
      displayName: "资源总览",
      featureId: "inventory",
      contributes: [{ capabilityId: "manga.inventory", version: "1.0.0" }],
      needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
      facets: ["service", "ui"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      if ((ctx.hostFacets ?? []).includes("ui")) {
        app.uiFacets.add("inventory");
        ctx.register({ kind: "subscription", id: `inventory-ui-${ctx.epoch}`, dispose: () => {
          app.uiFacets.delete("inventory");
        } });
      }
      app.runtime.registerCommand("manga.inventory", "inventory.overview", (envelope, signal) => inventory(app, signal, false, app.grantOf(envelope)));
      app.runtime.registerCommand("manga.inventory", "inventory.scan", async (envelope, signal) => {
        app.assertWritable();
        app.scanAbort?.abort();
        app.scanAbort = new AbortController();
        const combined = AbortSignal.any([signal, app.scanAbort.signal]);
        return inventory(app, combined, true, app.grantOf(envelope));
      });
      app.runtime.registerCommand("manga.inventory", "inventory.cancelScan", () => {
        app.scanAbort?.abort();
        return { cancelled: true };
      });
      app.runtime.registerCommand("manga.inventory", "inventory.reveal", (envelope) => revealInventory(app, envelope));
      app.runtime.registerCommand("manga.inventory", "inventory.repair", (envelope) => repairInventory(app, envelope));
    },
    deactivate: () => app.scanAbort?.abort(),
  });
}

export function resourceBytes(app: InventoryHost, resourceId: string): number {
  const row = app.store.sqlite.prepare("SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(resourceId) as { bytes: number } | undefined;
  return row?.bytes ?? 0;
}

export function noteBytes(app: InventoryHost, objectId: string): number {
  const row = app.store.sqlite.prepare("SELECT payload_json FROM content_objects WHERE id = ?").get(objectId) as { payload_json: string } | undefined;
  return row ? Buffer.byteLength(row.payload_json) : 0;
}

export function inventoryItemForResource(app: InventoryHost, row: { id: string; title: string; kind?: string; bytes?: number }, grant: ScopeGrant) {
  const bytes = row.bytes ?? resourceBytes(app, row.id);
  return {
    id: row.id,
    kind: "resource" as const,
    // The medium the resource belongs to; the overview groups its rows by it.
    mediaKind: row.kind ?? null,
    title: row.title,
    bytes,
    location: grant.access === "owner" ? app.layout.partitions.resources : undefined,
    hosted: true,
    indexed: true,
    available: true,
    moduleEnabled: app.uiFacets.has("library"),
    status: app.uiFacets.has("library") ? "ready" as const : "disabled" as const,
    revealable: grant.access === "owner",
  };
}

/**
 * The media part of the overview (LIB-04): comic and video resources, recordings, covers and playback copies, each with a count,
 * the space it holds, and whether its module is on. Counts and sizes come from rows and from the few files MANGA itself
 * stores; media indexed in place is counted, not measured. `claimed` names the attachment files these categories own, so
 * the flat attachment list does not repeat them.
 */
export function mediaInventory(app: InventoryHost, attachmentDir: string) {
  const db = app.store.sqlite;
  const claimed = new Set<string>();
  const sizeOf = (file: string): number | undefined => {
    try { return fs.statSync(file).size; } catch { return undefined; }
  };
  const claim = (file: string) => { if (path.dirname(file) === attachmentDir) claimed.add(path.basename(file)); };
  const mediaKind = (kind: "comic" | "video") => {
    const count = (db.prepare("SELECT COUNT(*) AS n FROM resources WHERE kind = ?").get(kind) as { n: number }).n;
    const rows = db.prepare("SELECT f.relative_path AS file, f.hosted AS hosted, f.available AS available FROM file_locations f JOIN resource_revisions v ON v.id = f.resource_revision_id JOIN resources r ON r.id = v.resource_id WHERE r.kind = ?").all(kind) as Array<{ file: string; hosted: number; available: number }>;
    let bytes = 0;
    let hosted = 0;
    let missing = 0;
    for (const row of rows) {
      if (!row.hosted) { if (!row.available) missing += 1; continue; }
      hosted += 1;
      // The application's own copies live in its managed library path, next to nothing else the user owns.
      const file = absoluteIn(app.store.managedLibraryDir, row.file);
      claim(file);
      const size = sizeOf(file);
      if (size === undefined) missing += 1; else bytes += size;
    }
    return { count, hosted, bytes, missing };
  };
  const comic = mediaKind("comic");
  const video = mediaKind("video");

  const sessions = db.prepare("SELECT c.id AS id, c.created_at AS createdAt, c.duration_ms AS durationMs, c.audio_state AS audioState, c.opus_name AS opus, c.audio_file_id AS audioFile, c.staging_name AS staging, w.title AS workTitle FROM capture_sessions c LEFT JOIN works w ON w.id = c.work_id ORDER BY c.created_at DESC, c.id DESC").all() as Array<{ id: string; createdAt: string; durationMs: number | null; audioState: string | null; opus: string | null; audioFile: string | null; staging: string | null; workTitle: string | null }>;
  let recordingBytes = 0;
  let recordingMissing = 0;
  const recordings = sessions.map((row) => {
    let bytes = 0;
    let location: string | undefined;
    let missing = false;
    for (const name of [row.opus, row.staging]) {
      if (!name) continue;
      const file = path.join(attachmentDir, name);
      claimed.add(name);
      const size = sizeOf(file);
      if (size === undefined) missing = true; else { bytes += size; location ??= file; }
    }
    if (row.audioFile) {
      // A recording kept in the folder of its work.
      const file = app.workFolders.pathOf(row.audioFile);
      const size = file ? sizeOf(file) : undefined;
      if (!file || size === undefined) missing = true; else { bytes += size; location ??= file; }
    }
    recordingBytes += bytes;
    if (missing) recordingMissing += 1;
    return { row, bytes, location, missing };
  });

  const covers = db.prepare("SELECT area, file_name AS fileName, bytes FROM covers").all() as Array<{ area: string; fileName: string; bytes: number }>;
  let coverBytes = 0;
  for (const cover of covers) {
    coverBytes += cover.bytes;
    if (cover.area === "attachments") claimed.add(cover.fileName);
  }
  const copies = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM play_copies WHERE state = 'ready'").get() as { n: number; bytes: number };

  const category = (id: string, facet: string, entry: { count: number; bytes: number; missing?: number; location: string; indexedInPlace?: boolean }) => {
    const enabled = app.uiFacets.has(facet);
    const missing = entry.missing ?? 0;
    return {
      id: `category:${id}`,
      kind: "media-category" as const,
      category: id,
      title: id,
      count: entry.count,
      bytes: entry.bytes,
      location: entry.location,
      hosted: true,
      indexed: Boolean(entry.indexedInPlace),
      available: missing === 0,
      moduleEnabled: enabled,
      // A switched-off module's data stays counted and manageable; only the module's own screens are gone.
      status: missing > 0 ? "missing" as const : enabled ? "ready" as const : "disabled" as const,
      revealable: fs.existsSync(entry.location),
      missing,
    };
  };
  const categories = [
    category("comic", "comic", { count: comic.count, bytes: comic.bytes, missing: comic.missing, location: app.store.managedLibraryDir, indexedInPlace: comic.count > comic.hosted }),
    category("video", "video", { count: video.count, bytes: video.bytes, missing: video.missing, location: app.store.managedLibraryDir, indexedInPlace: video.count > video.hosted }),
    category("recording", "voice", { count: recordings.length, bytes: recordingBytes, missing: recordingMissing, location: attachmentDir }),
    category("cover", "metadata", { count: covers.length, bytes: coverBytes, location: attachmentDir }),
    category("playCopy", "video", { count: copies.n, bytes: copies.bytes, location: path.join(app.layout.partitions.cache, "play-copies") }),
  ];
  const voiceOn = app.uiFacets.has("voice");
  const recordingItems = recordings.slice(0, 50).map(({ row, bytes, location, missing }) => ({
    id: `capture:${row.id}`,
    kind: "recording" as const,
    title: `${row.workTitle ? `${row.workTitle} · ` : ""}${row.createdAt.slice(0, 16).replace("T", " ")}`,
    bytes,
    durationMs: row.durationMs ?? 0,
    location,
    hosted: true,
    indexed: false,
    available: !missing,
    moduleEnabled: voiceOn,
    // `cleaned` is the user's own choice (not kept); it is not a fault.
    status: missing ? "missing" as const : row.audioState === "cleaned" ? "cleaned" as const : voiceOn ? "ready" as const : "disabled" as const,
    revealable: Boolean(location),
  }));
  return {
    categories,
    recordingItems,
    claimed,
    totals: {
      comic: { count: comic.count, bytes: comic.bytes, hosted: comic.hosted, missing: comic.missing },
      video: { count: video.count, bytes: video.bytes, hosted: video.hosted, missing: video.missing },
      recording: { count: recordings.length, bytes: recordingBytes, missing: recordingMissing },
      cover: { count: covers.length, bytes: coverBytes },
      // Pictures the database itself keeps (covers from a source or chosen by the user, and avatars): they are part of the library file, not of the attachments folder.
      image: app.covers.images.usage(),
      playCopy: { count: copies.n, bytes: copies.bytes },
    },
  };
}

export function inventorySync(app: InventoryHost, signal: AbortSignal, grant: ScopeGrant) {
  if (signal.aborted) return { generatedAt: new Date().toISOString(), totals: {}, items: [], cancelled: true };
  if (grant.access !== "owner") {
    const resources = grant.readResourceIds.flatMap((id) => {
      const row = app.store.sqlite.prepare("SELECT id, title, kind FROM resources WHERE id = ?").get(id) as { id: string; title: string; kind: string } | undefined;
      return row ? [inventoryItemForResource(app, row, grant)] : [];
    });
    const notes = grant.writeObjectIds.flatMap((id) => {
      const row = app.store.sqlite.prepare("SELECT id, title FROM content_objects WHERE id = ? AND type = 'notes.document' AND deleted_at IS NULL").get(id) as { id: string; title: string } | undefined;
      return row ? [{ id: row.id, kind: "note" as const, title: row.title, bytes: noteBytes(app, row.id), moduleEnabled: app.uiFacets.has("notes") }] : [];
    });
    return { generatedAt: new Date().toISOString(), items: [...resources, ...notes], totals: { resource: { count: resources.length, bytes: resources.reduce((sum, item) => sum + item.bytes, 0) }, note: { count: notes.length, bytes: notes.reduce((sum, item) => sum + item.bytes, 0) } }, cancelled: false };
  }
  // Byte sizes stay in SQLite. Copying every payload into the process, then painting every row, is what
  // made a 10k library miss the cold-start and click budgets.
  const revisionSizes = app.store.sqlite.prepare("SELECT resource_id AS resourceId, length(CAST(payload_json AS BLOB)) AS bytes, created_at AS createdAt, rowid FROM resource_revisions").all() as Array<{ resourceId: string; bytes: number; createdAt: string; rowid: number }>;
  const latestBytes = new Map<string, { bytes: number; createdAt: string; rowid: number }>();
  for (const row of revisionSizes) {
    const prev = latestBytes.get(row.resourceId);
    if (!prev || row.createdAt > prev.createdAt || (row.createdAt === prev.createdAt && row.rowid > prev.rowid)) latestBytes.set(row.resourceId, row);
  }
  const resources = app.store.sqlite.prepare("SELECT id, title, kind, created_at AS createdAt FROM resources ORDER BY created_at DESC, id DESC").all() as Array<{ id: string; title: string; kind: string; createdAt: string }>;
  const resourceBytesTotal = resources.reduce((sum, row) => sum + (latestBytes.get(row.id)?.bytes ?? 0), 0);
  const listedResources = resources.slice(0, 100).map((row) => inventoryItemForResource(app, { id: row.id, title: row.title, kind: row.kind, bytes: latestBytes.get(row.id)?.bytes ?? 0 }, grant));
  const notes = app.store.sqlite.prepare("SELECT id, title FROM content_objects WHERE type='notes.document' AND deleted_at IS NULL").all() as Array<{ id: string; title: string }>;
  const attachmentDir = app.layout.partitions.attachments;
  const attachments = fs.existsSync(attachmentDir) ? fs.readdirSync(attachmentDir).filter((name) => !name.startsWith(".")) : [];
  const indexed = app.store.sqlite.prepare("SELECT id, path, kind, hosted, bytes, file_count AS fileCount FROM indexed_roots").all() as Array<{ id: string; path: string; kind: string; hosted: number; bytes: number; fileCount: number }>;
  const mediaInfo = mediaInventory(app, attachmentDir);
  const partitionStat = (name: string) => app.store.sqlite.prepare("SELECT bytes, file_count AS fileCount, missing, scanned_at AS scannedAt FROM partition_stats WHERE name = ?").get(name) as { bytes: number; fileCount: number; missing: number; scannedAt: string | null } | undefined;
  const backup = partitionStat("backups") ?? { bytes: 0, fileCount: 0, missing: fs.existsSync(app.layout.partitions.backups) ? 0 : 1, scannedAt: null };
  const cache = partitionStat("cache") ?? { bytes: 0, fileCount: 0, missing: fs.existsSync(app.layout.partitions.cache) ? 0 : 1, scannedAt: null };
  const partitionItems = (["backups", "cache", "attachments", "resources", "works", "downloads", "exports"] as const).map((name) => {
    const location = app.layout.partitions[name];
    const exists = fs.existsSync(location);
    const stats = partitionStat(name);
    return {
      id: name,
      kind: "partition" as const,
      title: name,
      bytes: stats?.bytes ?? 0,
      location,
      hosted: true,
      indexed: false,
      available: exists,
      moduleEnabled: true,
      status: exists ? "ready" as const : "missing" as const,
      revealable: exists,
      scannedAt: stats?.scannedAt ?? null,
      missing: Boolean(stats?.missing) || !exists,
      fileCount: stats?.fileCount ?? 0,
    };
  });
  const items = [
    ...listedResources,
    ...partitionItems,
    ...notes.map((row) => ({
      id: row.id,
      kind: "note" as const,
      title: row.title,
      bytes: noteBytes(app, row.id),
      location: app.layout.partitions.projects,
      hosted: true,
      indexed: true,
      available: true,
      moduleEnabled: app.uiFacets.has("notes"),
      status: app.uiFacets.has("notes") ? "ready" as const : "disabled" as const,
      revealable: true,
    })),
    ...mediaInfo.categories,
    ...mediaInfo.recordingItems,
    ...app.workFolders.list().slice(0, 200).map((folder) => {
      const location = app.workFolders.absolute(folder);
      const exists = fs.existsSync(location);
      return {
        id: `workfolder:${folder.id}`,
        kind: "work-folder" as const,
        title: folder.relDir,
        bytes: folder.bytes,
        location,
        hosted: true,
        indexed: false,
        available: exists,
        moduleEnabled: app.uiFacets.has("library"),
        status: exists ? "ready" as const : "missing" as const,
        revealable: exists,
        fileCount: folder.files,
      };
    }),
    ...attachments.filter((name) => !mediaInfo.claimed.has(name)).slice(0, 200).map((name) => {
      const location = path.join(attachmentDir, name);
      const exists = fs.existsSync(location);
      return {
        id: name,
        kind: "attachment" as const,
        title: name,
        bytes: exists ? fs.statSync(location).size : 0,
        location,
        hosted: true,
        indexed: false,
        available: exists,
        moduleEnabled: true,
        status: exists ? "ready" as const : "missing" as const,
        revealable: exists,
      };
    }),
    ...indexed.map((root) => ({
      id: root.id,
      kind: "indexed-root" as const,
      title: root.path,
      bytes: root.bytes,
      location: root.path,
      hosted: root.hosted === 1,
      indexed: true,
      available: fs.existsSync(root.path),
      moduleEnabled: true,
      status: fs.existsSync(root.path) ? "indexed" as const : "missing" as const,
      revealable: fs.existsSync(root.path),
      fileCount: root.fileCount,
    })),
  ];
  if (signal.aborted) return { generatedAt: new Date().toISOString(), totals: {}, items: [], cancelled: true };
  // Resources past the bounded page stay reachable: the cursor names the next older row for library.list.
  const resourcePagination = {
    resource: {
      total: resources.length,
      listed: listedResources.length,
      nextCursor: resources.length > 100 && listedResources.length
        ? encodeResourceCursor({ createdAt: resources[99]!.createdAt, id: resources[99]!.id })
        : null,
    },
  };
  const totals = {
    resource: { count: resources.length, bytes: resourceBytesTotal },
    note: { count: notes.length, bytes: items.filter((item) => item.kind === "note").reduce((sum, item) => sum + item.bytes, 0) },
    attachment: { count: attachments.length, bytes: items.filter((item) => item.kind === "attachment").reduce((sum, item) => sum + item.bytes, 0) },
    ...mediaInfo.totals,
    backup: { count: backup.fileCount, bytes: backup.bytes, missing: Boolean(backup.missing), scanned: Boolean(backup.scannedAt) },
    cache: { count: cache.fileCount, bytes: cache.bytes, missing: Boolean(cache.missing), scanned: Boolean(cache.scannedAt) },
    indexedRoot: { count: indexed.length, bytes: indexed.reduce((sum, item) => sum + item.bytes, 0) },
  };
  return { generatedAt: new Date().toISOString(), totals, items, pagination: resourcePagination, cancelled: false };
}

export async function inventory(app: InventoryHost, signal: AbortSignal, scan: boolean, grant: ScopeGrant) {
  if (!scan) return inventorySync(app, signal, grant);
  const cancelled = () => ({ generatedAt: new Date().toISOString(), totals: {}, items: [], cancelled: true });
  const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  await yieldTurn();
  if (signal.aborted) return cancelled();
  if (grant.access === "owner") {
    for (const name of ["backups", "cache", "attachments", "resources", "works", "downloads", "exports"] as const) {
      if (signal.aborted) return cancelled();
      const stats = await scanDirectoryBatched(app.layout.partitions[name], signal);
      if (stats.cancelled) return cancelled();
      app.store.sqlite.prepare("INSERT INTO partition_stats(name, bytes, file_count, missing, scanned_at) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes, file_count=excluded.file_count, missing=excluded.missing, scanned_at=excluded.scanned_at").run(
        name, stats.bytes, stats.fileCount, stats.missing ? 1 : 0, new Date().toISOString(),
      );
    }
    const roots = app.store.sqlite.prepare("SELECT id, path FROM indexed_roots").all() as Array<{ id: string; path: string }>;
    for (const root of roots) {
      if (signal.aborted) return cancelled();
      const stats = await scanDirectoryBatched(root.path, signal);
      if (stats.cancelled) return cancelled();
      app.store.sqlite.prepare("UPDATE indexed_roots SET bytes = ?, file_count = ? WHERE id = ?").run(stats.bytes, stats.fileCount, root.id);
    }
  }
  await yieldTurn();
  if (signal.aborted) return cancelled();
  const result = inventorySync(app, signal, grant);
  await yieldTurn();
  if (signal.aborted) return cancelled();
  return result;
}

export function indexRootRecord(app: InventoryHost, target: string, kind: string) {
  const stats = directoryStats(target);
  const existing = app.store.sqlite.prepare("SELECT id FROM indexed_roots WHERE path = ?").get(target) as { id: string } | undefined;
  const id = existing?.id ?? createId("idx");
  app.store.sqlite.prepare("INSERT OR REPLACE INTO indexed_roots(id, path, kind, hosted, bytes, file_count, created_at) VALUES (?,?,?,?,?,?,?)").run(
    id, target, kind, 0, stats.bytes, stats.fileCount, new Date().toISOString(),
  );
  return { id, path: target, bytes: stats.bytes, fileCount: stats.fileCount };
}

export function indexExternalRoot(app: InventoryHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { pathHandle: string; kind?: "novel" | "comic" | "video" | "audio" | "file" };
  const target = app.resolvePath(input.pathHandle);
  if (pathsOverlap(target, app.layout.defaultRoot)) {
    throw new MangaError("PUBLISH_CONFLICT", "indexed external roots cannot overlap the active profile");
  }
  return indexRootRecord(app, target, input.kind ?? "file");
}

export function revealInventory(app: InventoryHost, envelope: CommandEnvelope) {
  const grant = app.grantOf(envelope);
  if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "only the owner can reveal inventory locations");
  const input = envelope.input as { id: string };
  // A folder of a work, or the folder a screenshot is in: opened directly, they do not wait for the overview to list them.
  if (input.id.startsWith("workfolder:")) {
    const folder = app.workFolders.folder(input.id.slice("workfolder:".length));
    if (!folder) throw new MangaError("NOT_FOUND", "folder missing");
    const dir = app.workFolders.absolute(folder);
    fs.mkdirSync(dir, { recursive: true });
    return { id: input.id, path: dir, kind: "work-folder" };
  }
  if (input.id.startsWith("screenshot:")) {
    return { id: input.id, path: path.dirname(app.screenshots.pathOf(input.id.slice("screenshot:".length))), kind: "screenshot" };
  }
  const overview = inventorySync(app, new AbortController().signal, grant);
  const item = overview.items.find((entry) => entry.id === input.id);
  if (!item || !("location" in item) || !item.location) throw new MangaError("NOT_FOUND", "inventory item missing");
  if (!fs.existsSync(item.location)) throw new MangaError("NOT_FOUND", "inventory location is not available");
  return { id: item.id, path: item.location, kind: item.kind };
}

export function repairInventory(app: InventoryHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const grant = app.grantOf(envelope);
  if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "only the owner can repair inventory locations");
  const input = envelope.input as { id: string; pathHandle?: string };
  const root = app.store.sqlite.prepare("SELECT id, path, kind FROM indexed_roots WHERE id = ?").get(input.id) as { id: string; path: string; kind: string } | undefined;
  if (root) {
    const next = input.pathHandle ? app.resolvePath(input.pathHandle) : root.path;
    if (pathsOverlap(next, app.layout.defaultRoot)) {
      throw new MangaError("PUBLISH_CONFLICT", "indexed external roots cannot overlap the active profile");
    }
    if (!fs.existsSync(next)) throw new MangaError("NOT_FOUND", "repair target is missing");
    const stats = directoryStats(next);
    app.store.sqlite.prepare("UPDATE indexed_roots SET path = ?, bytes = ?, file_count = ? WHERE id = ?").run(next, stats.bytes, stats.fileCount, root.id);
    return { id: root.id, path: next, repaired: true, kind: "indexed-root", available: true };
  }
  const partition = (LOCATION_PARTITIONS as readonly string[]).includes(input.id) ? input.id as keyof LocationLayout["partitions"] : undefined;
  if (!partition) throw new MangaError("NOT_FOUND", "inventory item missing");
  if (input.pathHandle) {
    throw new MangaError("CAPABILITY_UNAVAILABLE", "per-partition relocation is not available yet; migrate the profile root instead");
  }
  const location = app.layout.partitions[partition];
  fs.mkdirSync(location, { recursive: true });
  const stats = directoryStats(location);
  app.store.sqlite.prepare("INSERT INTO partition_stats(name, bytes, file_count, missing, scanned_at) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes, file_count=excluded.file_count, missing=excluded.missing, scanned_at=excluded.scanned_at").run(
    partition, stats.bytes, stats.fileCount, 0, new Date().toISOString(),
  );
  return { id: partition, path: location, repaired: true, kind: "partition", available: true };
}
