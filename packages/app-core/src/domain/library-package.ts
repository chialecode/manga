import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LibraryPackageManifestSchema, MangaError, PackageAttachmentNameSchema, createId, type LibraryPackageManifest, type PackageConflict, type PackageImportStrategy, type PackageRowKind } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { comparablePath, ownedFileFingerprint, pathsOverlap, copyOwnedFile, listCopyFiles, fingerprintTree } from "./file-ownership.ts";

const FORMAT = "manga-library-package-v1";
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sqlValue(value: unknown): string | number | bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function locatePackageFile(root: string, relative: string): string | undefined {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new MangaError("VALIDATION_ERROR", "package path escapes root");
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) throw new MangaError("VALIDATION_ERROR", "package root cannot be a link");
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) return undefined;
    if (fs.lstatSync(current).isSymbolicLink()) throw new MangaError("VALIDATION_ERROR", "package path cannot contain links");
  }
  if (!fs.statSync(target).isFile()) throw new MangaError("VALIDATION_ERROR", "package attachment must be a regular file");
  return target;
}

function checkedFile(root: string, relative: string): string {
  const target = locatePackageFile(root, relative);
  if (!target) throw new MangaError("VALIDATION_ERROR", `package file missing: ${relative}`);
  return target;
}

function validateReferences(manifest: LibraryPackageManifest): void {
  const attachments = new Set(manifest.attachments.map((item) => item.id));
  const revisions = new Map(manifest.revisions.map((item) => [item.id, item.resource_id]));
  const resources = new Set(manifest.resources.map((item) => item.id));
  const objects = new Set(manifest.objects.map((item) => item.id));
  // A package whose own ids collide is malformed; replacing rows would silently drop content.
  const unique = (rows: Array<{ id: string }>, label: string) => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) throw new MangaError("VALIDATION_ERROR", `package has a duplicate ${label} id`);
      seen.add(row.id);
    }
  };
  unique(manifest.works, "work");
  unique(manifest.resources, "resource");
  unique(manifest.revisions, "resource revision");
  unique(manifest.objects, "object");
  unique(manifest.anchors, "anchor");
  unique(manifest.refs, "reference");
  unique(manifest.captures, "capture");
  unique(manifest.attachments.map((item) => ({ id: item.id })), "attachment");
  for (const row of manifest.objectRevisions) if (!objects.has(row.object_id)) throw new MangaError("VALIDATION_ERROR", "package object revision owner missing");
  for (const row of manifest.refs) if (!objects.has(row.from_object_id)) throw new MangaError("VALIDATION_ERROR", "package reference owner missing");
  const scoped = new Set<string>();
  for (const row of manifest.noteScopes ?? []) {
    if (!objects.has(row.objectId) || scoped.has(row.objectId)) throw new MangaError("VALIDATION_ERROR", "package note scope owner missing or duplicate");
    scoped.add(row.objectId);
  }
  for (const item of manifest.revisions) if (!resources.has(item.resource_id)) throw new MangaError("VALIDATION_ERROR", "package revision resource missing");
  for (const item of [...manifest.anchors, ...manifest.progress]) {
    if (revisions.get(item.resource_revision_id) !== item.resource_id) throw new MangaError("VALIDATION_ERROR", "package resource revision mismatch");
  }
  for (const item of manifest.objects) {
    const ids = JSON.parse(item.attachment_ids_json) as unknown;
    if (!Array.isArray(ids)) throw new MangaError("VALIDATION_ERROR", "package attachment list must be an array");
    for (const id of ids) PackageAttachmentNameSchema.parse(id);
    if (ids.some((id) => !attachments.has(String(id)))) throw new MangaError("VALIDATION_ERROR", "package object attachment missing");
  }
  for (const item of manifest.captures) if (!attachments.has(item.attachment_id)) throw new MangaError("VALIDATION_ERROR", "package capture attachment missing");
  for (const item of manifest.fileLocations ?? []) {
    if (!revisions.has(item.resource_revision_id)) throw new MangaError("VALIDATION_ERROR", "package file location owner missing");
  }
  for (const item of manifest.assets ?? []) {
    if (revisions.get(item.resource_revision_id) !== item.resource_id) throw new MangaError("VALIDATION_ERROR", "package asset revision mismatch");
    if (!attachments.has(item.attachment)) throw new MangaError("VALIDATION_ERROR", "package asset attachment missing");
  }
}

export function exportLibraryPackage(store: DrizzleStore, destDir: string): LibraryPackageManifest {
  const resolvedDest = path.resolve(destDir);
  const attachmentsRoot = path.resolve(store.attachmentsDir);
  if (resolvedDest === attachmentsRoot || resolvedDest.startsWith(attachmentsRoot + path.sep)) {
    throw new MangaError("PUBLISH_CONFLICT", "package destination is inside attachments");
  }
  if (fs.existsSync(destDir) && fs.readdirSync(destDir).length) throw new MangaError("PUBLISH_CONFLICT", "package destination requires an empty directory");
  fs.mkdirSync(destDir, { recursive: true });
  const attachmentsDir = path.join(destDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const attachments = [];
  let total = 0;
  if (fs.existsSync(store.attachmentsDir)) {
    for (const name of fs.readdirSync(store.attachmentsDir)) {
      if (name.startsWith(".import-")) continue;
      PackageAttachmentNameSchema.parse(name);
      const source = checkedFile(store.attachmentsDir, name);
      const dest = path.join(attachmentsDir, name);
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      const bytes = fs.statSync(dest).size;
      total += bytes;
      if (total > MAX_PACKAGE_BYTES) throw new MangaError("VALIDATION_ERROR", "package attachments exceed budget");
      attachments.push({ id: name, hash: sha256File(dest), relativePath: `attachments/${name}`, bytes });
    }
  }
  const query = (sql: string) => store.sqlite.prepare(sql).all();
  // Extracted page and illustration payloads travel as package attachments so a fixed page reopens offline.
  const assetRows = store.sqlite.prepare("SELECT id, resource_id, resource_revision_id, part_id, name, media_type, hash, bytes, payload FROM resource_assets").all() as Array<{
    id: string;
    resource_id: string;
    resource_revision_id: string;
    part_id: string;
    name: string;
    media_type: string;
    hash: string;
    bytes: number;
    payload: Buffer;
  }>;
  const assets = [];
  for (const [index, row] of assetRows.entries()) {
    const attachmentName = `asset-${index + 1}-${row.hash.slice(0, 16)}.bin`;
    const target = path.join(attachmentsDir, attachmentName);
    fs.writeFileSync(target, row.payload, { flag: "wx" });
    const bytes = fs.statSync(target).size;
    total += bytes;
    if (total > MAX_PACKAGE_BYTES) throw new MangaError("VALIDATION_ERROR", "package assets exceed budget");
    attachments.push({ id: attachmentName, hash: row.hash, relativePath: `attachments/${attachmentName}`, bytes });
    assets.push({
      id: row.id,
      resource_id: row.resource_id,
      resource_revision_id: row.resource_revision_id,
      part_id: row.part_id,
      name: row.name,
      media_type: row.media_type,
      hash: row.hash,
      bytes: row.bytes,
      attachment: attachmentName,
    });
  }
  const manifest = LibraryPackageManifestSchema.parse({
    format: FORMAT,
    createdAt: new Date().toISOString(),
    works: query("SELECT * FROM works"),
    resources: query("SELECT * FROM resources"),
    revisions: query("SELECT * FROM resource_revisions"),
    objects: query("SELECT * FROM content_objects"),
    objectRevisions: query("SELECT object_id, revision, payload_json, created_at FROM object_revisions"),
    anchors: query("SELECT * FROM anchors"),
    refs: query("SELECT * FROM refs"),
    progress: query("SELECT * FROM progress"),
    captures: query("SELECT * FROM capture_sessions"),
    metadataSnapshots: query("SELECT * FROM metadata_snapshots"),
    metadataOverrides: query("SELECT * FROM metadata_overrides"),
    metadataCandidates: query("SELECT * FROM metadata_candidates"),
    workLinks: query("SELECT * FROM work_links"),
    noteScopes: query("SELECT object_id AS objectId, resource_id AS resourceId FROM text_fragments WHERE kind='note' AND object_id IS NOT NULL GROUP BY object_id, resource_id"),
    fileLocations: query("SELECT id, resource_revision_id, relative_path, fingerprint, available, hosted FROM file_locations"),
    // Reading bookmarks travel with the package so a restore keeps the reader's own marks.
    bookmarks: query("SELECT id, resource_id, resource_revision_id, label, locator_json, created_at FROM bookmarks"),
    assets,
    attachments,
  });
  validateReferences(manifest);
  fs.writeFileSync(path.join(destDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

export function readLibraryPackage(sourceDir: string): LibraryPackageManifest {
  const file = checkedFile(sourceDir, "manifest.json");
  if (fs.statSync(file).size > MAX_MANIFEST_BYTES) throw new MangaError("VALIDATION_ERROR", "package manifest exceeds budget");
  const manifest = LibraryPackageManifestSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const names = new Set<string>();
  let total = 0;
  for (const attachment of manifest.attachments) {
    if (attachment.relativePath !== `attachments/${attachment.id}` || names.has(attachment.id.toLowerCase())) {
      throw new MangaError("VALIDATION_ERROR", "unsafe or duplicate package attachment path");
    }
    names.add(attachment.id.toLowerCase());
    // A declared file that is absent stays in the manifest. Import records it as unavailable instead of rejecting the package.
    const abs = locatePackageFile(sourceDir, attachment.relativePath);
    if (!abs) continue;
    const size = fs.statSync(abs).size;
    total += size;
    if (size !== attachment.bytes || total > MAX_PACKAGE_BYTES) throw new MangaError("VALIDATION_ERROR", "package attachment size/budget mismatch");
    if (sha256File(abs) !== attachment.hash) throw new MangaError("VALIDATION_ERROR", `package attachment hash mismatch: ${attachment.id}`);
  }
  validateReferences(manifest);
  return manifest;
}

export type PackageImportDecision = { kind: PackageRowKind; id: string; action: PackageImportStrategy };
export type PackageImportOptions = {
  crashAt?: string;
  receipt?: { key: string; commandId: string };
  strategy?: PackageImportStrategy;
  decisions?: PackageImportDecision[];
};

/** Which rows in the target library already use an id the package also wants. */
export function planPackageImport(store: DrizzleStore, manifest: LibraryPackageManifest, sourceDir?: string) {
  const conflicts: PackageConflict[] = [];
  const has = (sql: string, ...ids: string[]) => Boolean(store.sqlite.prepare(sql).get(...ids));
  const check = (kind: PackageRowKind, id: string, label: string, sql: string, reason: string) => {
    if (has(sql, id)) conflicts.push({ kind, id, label, reason });
  };
  for (const row of manifest.works) check("work", row.id, row.title, "SELECT id FROM works WHERE id = ?", "work id already exists");
  for (const row of manifest.resources) check("resource", row.id, row.title, "SELECT id FROM resources WHERE id = ?", "resource id already exists");
  for (const row of manifest.objects) check("object", row.id, row.title, "SELECT id FROM content_objects WHERE id = ?", "note id already exists");
  for (const row of manifest.anchors) check("anchor", row.id, row.id, "SELECT id FROM anchors WHERE id = ?", "anchor id already exists");
  for (const row of manifest.refs) check("ref", row.id, row.id, "SELECT id FROM refs WHERE id = ?", "reference id already exists");
  for (const row of manifest.captures) check("capture", row.id, row.id, "SELECT id FROM capture_sessions WHERE id = ?", "capture id already exists");
  for (const row of manifest.progress) {
    if (has("SELECT resource_id FROM progress WHERE resource_id = ? AND resource_revision_id = ?", row.resource_id, row.resource_revision_id)) {
      conflicts.push({ kind: "progress", id: `${row.resource_id}:${row.resource_revision_id}`, label: row.resource_id, reason: "progress row already exists" });
    }
  }
  // Revisions may collide without their owner colliding, and a client must be able to decide on them by id.
  for (const row of manifest.revisions) {
    if (has("SELECT id FROM resource_revisions WHERE id = ?", row.id)) {
      conflicts.push({ kind: "resource_revision", id: row.id, label: row.fingerprint.slice(0, 12), reason: "resource revision id already exists" });
    }
  }
  for (const row of manifest.bookmarks ?? []) {
    check("bookmark", row.id, row.label, "SELECT id FROM bookmarks WHERE id = ?", "bookmark id already exists");
  }
  const presentTables = ["works", "resources", "resource_revisions", "content_objects", "anchors", "refs", "progress", "file_locations", "bookmarks", "capture_sessions"];
  const attachmentsPresent = fs.existsSync(store.attachmentsDir) ? fs.readdirSync(store.attachmentsDir).some((name) => !name.startsWith(".import-")) : false;
  // A profile that only holds progress, locations or bookmarks is not empty either.
  const empty = !presentTables.some((table) => Number((store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n) > 0) && !attachmentsPresent;
  // Missing media means the package itself no longer carries the payload it declares.
  const missingAttachments = sourceDir
    ? manifest.attachments.filter((attachment) => !fs.existsSync(path.join(sourceDir, attachment.relativePath))).map((attachment) => attachment.id)
    : [];
  const objectIds = new Set(manifest.objects.map((row) => row.id));
  const anchorIds = new Set(manifest.anchors.map((row) => row.id));
  const orphanRefs = manifest.refs.filter((row) => !objectIds.has(row.from_object_id) || (row.to_kind === "anchor" && !anchorIds.has(row.to_id))).length;
  return {
    format: FORMAT as "manga-library-package-v1",
    createdAt: manifest.createdAt,
    counts: {
      works: manifest.works.length,
      resources: manifest.resources.length,
      revisions: manifest.revisions.length,
      objects: manifest.objects.length,
      anchors: manifest.anchors.length,
      refs: manifest.refs.length,
      progress: manifest.progress.length,
      attachments: manifest.attachments.length,
    },
    empty,
    conflicts,
    missingAttachments,
    orphanRefs,
    defaultStrategy: empty ? ("replace" as const) : conflicts.length ? ("duplicate" as const) : ("replace" as const),
  };
}

export function previewLibraryPackage(store: DrizzleStore, sourceDir: string): ReturnType<typeof planPackageImport> {
  const manifest = readLibraryPackage(sourceDir);
  return planPackageImport(store, manifest, sourceDir);
}

export function importLibraryPackage(store: DrizzleStore, sourceDir: string, options: { crashAt?: string; receipt?: { key: string; commandId: string } } = {}): LibraryPackageManifest {
  // A plain import keeps the historical empty-profile guarantee.
  const preview = previewLibraryPackage(store, sourceDir);
  if (!preview.empty) throw new MangaError("PUBLISH_CONFLICT", "import requires an empty profile; use the conflict preview instead");
  return importLibraryPackageResolved(store, sourceDir, { ...options, strategy: "replace" });
}

/**
 * Import into an empty or conflicting library. `duplicate` remaps ids so an existing library keeps
 * its rows, `replace` overwrites the colliding rows, `skip` leaves them untouched.
 */
export function importLibraryPackageResolved(store: DrizzleStore, sourceDir: string, options: PackageImportOptions = {}): LibraryPackageManifest {
  const manifest = readLibraryPackage(sourceDir);
  const strategy: PackageImportStrategy = options.strategy ?? "duplicate";
  const decisions = new Map<string, PackageImportStrategy>();
  for (const decision of options.decisions ?? []) decisions.set(`${decision.kind}:${decision.id}`, decision.action);
  // A caller that only decided on the resource also decides for its revisions.
  const revisionOwner = new Map(manifest.revisions.map((row) => [row.id, row.resource_id]));
  const decidedAction = (kind: PackageRowKind, id: string): PackageImportStrategy | undefined => {
    const decided = decisions.get(`${kind}:${id}`);
    if (decided) return decided;
    if (kind === "resource_revision") {
      const owner = revisionOwner.get(id);
      const ownerDecision = owner ? decisions.get(`resource:${owner}`) : undefined;
      if (ownerDecision) return ownerDecision;
    }
    return undefined;
  };
  const actionOr = (kind: PackageRowKind, id: string): PackageImportStrategy => decidedAction(kind, id) ?? strategy;
  const preview = planPackageImport(store, manifest, sourceDir);
  if (preview.orphanRefs > 0) throw new MangaError("VALIDATION_ERROR", "package contains references whose target is missing");
  const jobId = createId("pkg");
  const staging = path.join(store.attachmentsDir, `.import-${jobId}`);
  fs.mkdirSync(staging, { recursive: true });
  store.sqlite.prepare("INSERT INTO recovery_jobs(id, kind, stage, status, staging_path, payload_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(
    jobId, "package-import", "copy", "running", staging, JSON.stringify({ sourceDir, attachments: manifest.attachments.map((item) => item.id) }), new Date().toISOString(), new Date().toISOString(),
  );
  const maybeCrash = (stage: string) => {
    store.sqlite.prepare("UPDATE recovery_jobs SET stage = ?, updated_at = ? WHERE id = ?").run(stage, new Date().toISOString(), jobId);
    if (options.crashAt === stage) process.exit(99);
  };
  const published: string[] = [];
  const created: string[] = [];
  const missingMedia = new Set<string>();
  let committed = false;
  try {
    maybeCrash("copy");
    for (const attachment of manifest.attachments) {
      if (!packageFileExists(sourceDir, attachment.relativePath)) {
        // A missing illustration is recorded as unavailable. It does not abort the rest of the package or touch originals.
        missingMedia.add(attachment.id);
        continue;
      }
      const staged = path.join(staging, attachment.id);
      fs.copyFileSync(checkedFile(sourceDir, attachment.relativePath), staged, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(staged, "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    maybeCrash("verify");
    for (const attachment of manifest.attachments) {
      if (missingMedia.has(attachment.id)) continue;
      const staged = path.join(staging, attachment.id);
      if (sha256File(staged) !== attachment.hash) throw new MangaError("VALIDATION_ERROR", "package attachment changed during copy");
    }
    // Ids the package wants but the library already uses are remapped for the `duplicate` action.
    const workIds = remap(manifest.works.map((row) => row.id), (id) => hasRow(store, "works", id), actionOr, "work");
    const resourceIds = remap(manifest.resources.map((row) => row.id), (id) => hasRow(store, "resources", id), actionOr, "resource");
    const objectIds = remap(manifest.objects.map((row) => row.id), (id) => hasRow(store, "content_objects", id), actionOr, "object");
    const anchorIds = remap(manifest.anchors.map((row) => row.id), (id) => hasRow(store, "anchors", id), actionOr, "anchor");
    const refIds = remap(manifest.refs.map((row) => row.id), (id) => hasRow(store, "refs", id), actionOr, "ref");
    const bookmarkIds = remap((manifest.bookmarks ?? []).map((row) => row.id), (id) => hasRow(store, "bookmarks", id), actionOr, "bookmark");
    // A local reference this import does not rewrite keeps naming its anchor, so an anchor write that would
    // overwrite that row must not move the source behind the ref: refs of kept objects, of copies whose
    // original stays, and of local objects the package never mentions all survive.
    const replacedObjectIds = [...new Set(manifest.objects.filter((row) => actionOr("object", row.id) === "replace" && hasRow(store, "content_objects", row.id)).map((row) => row.id))];
    const survivingRefs = (replacedObjectIds.length
      ? store.sqlite.prepare(`SELECT DISTINCT to_id AS toId FROM refs WHERE to_kind = 'anchor' AND from_object_id NOT IN (${replacedObjectIds.map(() => "?").join(",")})`).all(...replacedObjectIds)
      : store.sqlite.prepare("SELECT DISTINCT to_id AS toId FROM refs WHERE to_kind = 'anchor'").all()) as Array<{ toId: string }>;
    const protectedAnchors = new Set(survivingRefs.map((row) => row.toId).filter((anchorId) => hasRow(store, "anchors", anchorId)));
    // An explicit skip keeps that edge even when the import replaces the note that owns it. Those anchors
    // have to enter owner planning now: a later "preserve the row" pass cannot put the revision back.
    for (const row of manifest.refs) {
      if (actionOr("ref", row.id) !== "skip") continue;
      const local = store.sqlite.prepare("SELECT to_kind AS kind, to_id AS tid FROM refs WHERE id = ?").get(row.id) as { kind: string; tid: string } | undefined;
      if (local?.kind === "anchor" && hasRow(store, "anchors", local.tid)) protectedAnchors.add(local.tid);
    }
    // A ref id the library already holds is only replaceable when its owning object is rewritten by this
    // import. Otherwise the row belongs to a surviving source, and a package ref must not move it.
    const rewrittenFromObjects = new Set(replacedObjectIds);
    const localRefRows = new Map<string, { from: string; kind: string; to: string }>();
    for (const row of manifest.refs) {
      const local = store.sqlite.prepare("SELECT from_object_id AS frm, to_kind AS kind, to_id AS tid FROM refs WHERE id = ?").get(row.id) as { frm: string; kind: string; tid: string } | undefined;
      if (local && !rewrittenFromObjects.has(local.frm)) localRefRows.set(row.id, { from: local.frm, kind: local.kind, to: local.tid });
    }
    // Anchors that survive this import pin the revision they name to the owner their row declares:
    // rewriting that revision under a different resource would leave every surviving source pointing at
    // a revision that no longer names it. A source survives when a reference from any object this import
    // does not rewrite names the anchor — including objects the package never mentions (created after the
    // export), and rows kept by an explicit skip. One revision pinned to two owners cannot be combined.
    const pinnedRevisionOwners = new Map<string, string>();
    const pinRevisionOwner = (revision: string, resource: string) => {
      const pinned = pinnedRevisionOwners.get(revision);
      if (pinned && pinned !== resource) {
        throw new MangaError("PUBLISH_CONFLICT", `kept sources pin revision ${revision} to different resources; the decisions cannot be combined`);
      }
      pinnedRevisionOwners.set(revision, resource);
    };
    const localAnchorOwner = (id: string) =>
      store.sqlite.prepare("SELECT resource_id AS resource, resource_revision_id AS revision FROM anchors WHERE id = ?").get(id) as { resource: string; revision: string } | undefined;
    for (const anchorId of protectedAnchors) {
      const local = localAnchorOwner(anchorId);
      if (local) pinRevisionOwner(local.revision, local.resource);
    }
    for (const row of manifest.anchors) {
      const action = actionOr("anchor", row.id);
      const localExists = hasRow(store, "anchors", row.id);
      const kept = (action === "skip" && localExists) || (action === "replace" && localExists && protectedAnchors.has(row.id));
      if (!kept) continue;
      const local = localAnchorOwner(row.id);
      if (local) pinRevisionOwner(local.revision, local.resource);
    }
    // One dependency plan decides, before any write, what each package row becomes: inserted/replaced under a
    // target id, kept as the library's own row (a skipped collision), or dropped because what it depends on
    // is not persisted. Every dependent row (notes, history, refs, index, media, locations) follows this plan.
    const keptResource = new Set(manifest.resources.filter((row) => actionOr("resource", row.id) === "skip" && hasRow(store, "resources", row.id)).map((row) => row.id));
    const revisionIds = new Map<string, string>();
    /** Revisions whose package payload is persisted; only these are indexed or receive package media. */
    const writtenRevisions = new Set<string>();
    const replacedRevisions = new Set<string>();
    /** The resource each revision row names after this import; every dependent must agree with it. */
    const finalRevisionOwner = new Map<string, string>();
    for (const row of manifest.revisions) {
      const local = store.sqlite.prepare("SELECT resource_id FROM resource_revisions WHERE id = ?").get(row.id) as { resource_id: string } | undefined;
      if (keptResource.has(row.resource_id)) {
        // The library keeps its own resource. A revision it already holds stays the source; anything else is not added to it.
        if (local && local.resource_id === row.resource_id) { revisionIds.set(row.id, row.id); finalRevisionOwner.set(row.id, row.resource_id); }
        continue;
      }
      if (!local) { revisionIds.set(row.id, row.id); writtenRevisions.add(row.id); finalRevisionOwner.set(row.id, resourceIds.get(row.resource_id) ?? row.resource_id); continue; }
      const action = actionOr("resource_revision", row.id);
      if (action === "skip") {
        // The local revision is kept untouched. It can stand in for the package's when it is the same
        // revision row (same id under the same original owner), so a duplicated resource cannot hide an
        // otherwise resolvable revision behind its remapped owner.
        if (local.resource_id === row.resource_id) { revisionIds.set(row.id, row.id); finalRevisionOwner.set(row.id, row.resource_id); }
      } else if (action === "replace") {
        revisionIds.set(row.id, row.id);
        writtenRevisions.add(row.id);
        replacedRevisions.add(row.id);
        // A kept source pins the replaced revision to the owner it still names; the package's payload
        // takes that place instead of silently moving the revision to a duplicated resource. Otherwise
        // the revision follows its resource mapping like any other written row.
        finalRevisionOwner.set(row.id, pinnedRevisionOwners.get(row.id) ?? (resourceIds.get(row.resource_id) ?? row.resource_id));
      } else {
        revisionIds.set(row.id, createId("rev"));
        writtenRevisions.add(row.id);
        finalRevisionOwner.set(row.id, resourceIds.get(row.resource_id) ?? row.resource_id);
      }
    }
    /** Resource a dependent row must name: the owner the revision row actually carries. */
    const revisionOwnerResource = (packageRevisionId: string, packageResourceId: string): string =>
      finalRevisionOwner.get(packageRevisionId) ?? (resourceIds.get(packageResourceId) ?? packageResourceId);
    const anchorPlan = new Map<string, string>();
    /** Anchors this import writes (package id → target id with the resolved owner pair). */
    const writtenAnchors = new Map<string, { target: string; resource: string; revision: string; action: PackageImportStrategy }>();
    for (const row of manifest.anchors) {
      // The package revision was not persisted, so the package cannot provide this anchor. An existing local
      // anchor with the same id stays the resolvable source for copied notes.
      const revisionTarget = revisionIds.get(row.resource_revision_id);
      if (revisionTarget === undefined) {
        if (hasRow(store, "anchors", row.id)) anchorPlan.set(row.id, row.id);
        continue;
      }
      const action = actionOr("anchor", row.id);
      if (action === "skip" && hasRow(store, "anchors", row.id)) { anchorPlan.set(row.id, row.id); continue; }
      const target = action === "replace" ? row.id : (anchorIds.get(row.id) ?? row.id);
      // A surviving local reference pins the local anchor row: a write that would overwrite that row is
      // suppressed, so the ref's source does not silently move. Copies resolve onto the kept anchor.
      if (target === row.id && hasRow(store, "anchors", row.id) && protectedAnchors.has(row.id)) {
        anchorPlan.set(row.id, row.id);
        continue;
      }
      anchorPlan.set(row.id, target);
      writtenAnchors.set(row.id, {
        target,
        resource: revisionOwnerResource(row.resource_revision_id, row.resource_id),
        revision: revisionTarget,
        action,
      });
    }
    const noteObjectIds = new Set(manifest.objects.filter((row) => row.type === "notes.document").map((row) => row.id));
    const skippedWork = new Set<string>();
    const skippedResource = keptResource;
    const skippedObject = new Set<string>();
    // An explicit `skip` on a reference is a caller decision to keep the library's own row untouched.
    // A replaced object would delete that row and re-derive the public link from the package payload,
    // silently dropping the decision and the kept row's own fields (mode, block, layout). The row is
    // preserved instead — but only when the combination is satisfiable: its target must still exist
    // after the import and the replaced payload must still name its block. Anything else cannot be
    // combined and is rejected before any write, so the content snapshot stays untouched.
    const preservedSkipRefs = new Map<string, Set<string>>();
    const replacedNoteBlocks = new Map<string, Set<string | null>>();
    for (const object of manifest.objects) {
      if (object.type !== "notes.document" || !replacedObjectIds.includes(object.id)) continue;
      try {
        const payload = JSON.parse(object.payload_json) as { blocks?: Array<{ id?: string }> };
        replacedNoteBlocks.set(object.id, new Set((payload.blocks ?? []).map((block) => block?.id ?? null)));
      } catch { /* a malformed package payload fails its own write below */ }
    }
    for (const row of manifest.refs) {
      if (actionOr("ref", row.id) !== "skip") continue;
      const local = store.sqlite.prepare("SELECT from_object_id AS frm, from_block_id AS block, to_kind AS kind, to_id AS tid FROM refs WHERE id = ?").get(row.id) as { frm: string; block: string | null; kind: string; tid: string } | undefined;
      if (!local || !replacedObjectIds.includes(local.frm)) continue;
      // Anchors and objects are only ever overwritten in place, never deleted, so a target that exists
      // now survives; a target the package re-inserts under the same id survives too. Anything else —
      // a dangling row, or a package row remapped to a fresh id — cannot back the kept reference.
      const targetSurvives = local.kind === "anchor"
        ? hasRow(store, "anchors", local.tid) || anchorPlan.get(local.tid) === local.tid
        : hasRow(store, "content_objects", local.tid) || (objectIds.get(local.tid) !== undefined && objectIds.get(local.tid) === local.tid);
      const blocks = replacedNoteBlocks.get(local.frm);
      if (!targetSurvives || (blocks && !blocks.has(local.block))) {
        throw new MangaError("PUBLISH_CONFLICT", `kept reference ${row.id} cannot survive replacing its note: its target or block would not exist after the import`);
      }
      const kept = preservedSkipRefs.get(local.frm) ?? new Set<string>();
      kept.add(row.id);
      preservedSkipRefs.set(local.frm, kept);
    }
    // The plan is complete and nothing authoritative has been written. A kept edge, the note that will
    // replace its owner, and the revision that edge still names have to describe one source.
    for (const [objectId, kept] of preservedSkipRefs) {
      const object = manifest.objects.find((item) => item.id === objectId);
      if (!object) continue;
      const bodies = [
        JSON.parse(rewriteNoteAnchors(object.payload_json, anchorPlan)) as { blocks?: Array<{ id?: string | null; anchorId?: string }> },
        ...manifest.objectRevisions.filter((item) => item.object_id === objectId).map((item) => JSON.parse(rewriteNoteAnchors(item.payload_json, anchorPlan)) as { blocks?: Array<{ id?: string | null; anchorId?: string }> }),
      ];
      for (const refId of kept) {
        const local = store.sqlite.prepare("SELECT from_block_id AS block, to_id AS tid FROM refs WHERE id = ?").get(refId) as { block: string | null; tid: string };
        for (const body of bodies) {
          for (const block of body.blocks ?? []) {
            if ((block?.id ?? null) !== local.block) continue;
            if (block.anchorId !== local.tid) {
              throw new MangaError("PUBLISH_CONFLICT", `kept reference ${refId} does not agree with the replaced note`);
            }
          }
        }
        const anchor = store.sqlite.prepare("SELECT resource_id AS resource, resource_revision_id AS revision FROM anchors WHERE id = ?").get(local.tid) as { resource: string; revision: string } | undefined;
        const planned = [...writtenAnchors.values()].find((item) => item.target === local.tid);
        const anchorResource = planned?.resource ?? anchor?.resource;
        const anchorRevision = planned?.revision ?? anchor?.revision;
        const owner = anchorRevision
          ? finalRevisionOwner.get(anchorRevision) ?? (store.sqlite.prepare("SELECT resource_id AS resource FROM resource_revisions WHERE id = ?").get(anchorRevision) as { resource: string } | undefined)?.resource
          : undefined;
        if (!anchorResource || !owner || owner !== anchorResource) {
          throw new MangaError("PUBLISH_CONFLICT", `kept reference ${refId} would split its anchor from the revision owner`);
        }
      }
    }
    store.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const run = (sql: string, ...params: unknown[]) => store.sqlite.prepare(sql).run(...params.map(sqlValue));
      for (const row of manifest.works) {
        const action = actionOr("work", row.id);
        if (action === "skip" && hasRow(store, "works", row.id)) { skippedWork.add(row.id); continue; }
        if (action === "replace") run("INSERT OR REPLACE INTO works(id,title,created_at) VALUES (?,?,?)", row.id, row.title, row.created_at);
        else run("INSERT INTO works(id,title,created_at) VALUES (?,?,?)", workIds.get(row.id), row.title, row.created_at);
      }
      for (const row of manifest.resources) {
        const action = actionOr("resource", row.id);
        if (action === "skip" && hasRow(store, "resources", row.id)) { skippedResource.add(row.id); continue; }
        const workId = row.work_id ? (workIds.get(row.work_id) ?? row.work_id) : null;
        if (action === "replace") run("INSERT OR REPLACE INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)", row.id, workId, row.kind, row.title, row.aliases_json, row.created_at);
        else run("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)", resourceIds.get(row.id), workId, row.kind, row.title, row.aliases_json, row.created_at);
      }
      for (const row of manifest.revisions) {
        if (!writtenRevisions.has(row.id)) continue;
        const resourceId = finalRevisionOwner.get(row.id) ?? row.resource_id;
        const revisionId = revisionIds.get(row.id)!;
        if (replacedRevisions.has(row.id)) {
          // The replaced payload's index and media belong to the old text; they are rebuilt from the package below.
          run("DELETE FROM search_idx WHERE fragment_id IN (SELECT id FROM text_fragments WHERE resource_revision_id = ? AND object_id IS NULL)", row.id);
          run("DELETE FROM text_fragments WHERE resource_revision_id = ? AND object_id IS NULL", row.id);
          run("DELETE FROM resource_assets WHERE resource_revision_id = ?", row.id);
          run("DELETE FROM resource_revisions WHERE id = ?", row.id);
        }
        run("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)", revisionId, resourceId, row.fingerprint, row.parser_version, row.payload_json, row.created_at);
      }
      for (const row of manifest.objects) {
        const action = actionOr("object", row.id);
        if (action === "skip" && hasRow(store, "content_objects", row.id)) { skippedObject.add(row.id); continue; }
        const scope = remapScope(row.scope_json, resourceIds);
        const tags = row.tags_json ?? "[]";
        const payload = noteObjectIds.has(row.id) ? rewriteNoteAnchors(row.payload_json, anchorPlan) : row.payload_json;
        if (action === "replace" && hasRow(store, "content_objects", row.id)) {
          // A replaced note takes the package's history, references and index; the old ones would
          // contradict it. Rows an explicit skip decided to keep are excluded: deleting and re-deriving
          // them would drop the kept row's own mode, block and layout fields.
          const keptRefs = preservedSkipRefs.get(row.id);
          if (keptRefs?.size) run(`DELETE FROM refs WHERE from_object_id = ? AND id NOT IN (${[...keptRefs].map(() => "?").join(",")})`, row.id, ...keptRefs);
          else run("DELETE FROM refs WHERE from_object_id = ?", row.id);
          run("DELETE FROM object_revisions WHERE object_id = ?", row.id);
          run("DELETE FROM search_idx WHERE fragment_id IN (SELECT id FROM text_fragments WHERE object_id = ?)", row.id);
          run("DELETE FROM text_fragments WHERE object_id = ?", row.id);
        }
        if (action === "replace") run("INSERT OR REPLACE INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, tags_json, attachment_ids_json, preview_json, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          row.id, row.type, row.owner_module_id, scope, row.schema_version, row.revision, row.title, payload, tags, row.attachment_ids_json, row.preview_json, row.created_at, row.updated_at, row.deleted_at);
        else run("INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, tags_json, attachment_ids_json, preview_json, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          objectIds.get(row.id), row.type, row.owner_module_id, scope, row.schema_version, row.revision, row.title, payload, tags, row.attachment_ids_json, row.preview_json, row.created_at, row.updated_at, row.deleted_at);
      }
      for (const row of manifest.objectRevisions) {
        if (skippedObject.has(row.object_id)) continue;
        const objectId = objectIds.get(row.object_id) ?? row.object_id;
        const payload = noteObjectIds.has(row.object_id) ? rewriteNoteAnchors(row.payload_json, anchorPlan) : row.payload_json;
        run("INSERT OR REPLACE INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?,?,?,?)", objectId, row.revision, payload, row.created_at);
      }
      for (const row of manifest.anchors) {
        const write = writtenAnchors.get(row.id);
        if (!write) continue;
        // A locator keeps a representation id, which must follow a remapped revision.
        const locator = remapLocator(row.locator_json, revisionIds);
        if (write.action === "replace") run("INSERT OR REPLACE INTO anchors(id, resource_id, resource_revision_id, locator_json, preview_json, created_at) VALUES (?,?,?,?,?,?)", write.target, write.resource, write.revision, locator, row.preview_json, row.created_at);
        else run("INSERT INTO anchors(id, resource_id, resource_revision_id, locator_json, preview_json, created_at) VALUES (?,?,?,?,?,?)", write.target, write.resource, write.revision, locator, row.preview_json, row.created_at);
      }
      for (const row of manifest.refs) {
        if (skippedObject.has(row.from_object_id)) continue;
        const action = actionOr("ref", row.id);
        if (action === "skip" && hasRow(store, "refs", row.id)) continue;
        const objectId = objectIds.get(row.from_object_id) ?? row.from_object_id;
        const toId = row.to_kind === "anchor" ? anchorPlan.get(row.to_id) : (objectIds.get(row.to_id) ?? row.to_id);
        // A reference whose target was not imported is dropped instead of pointing nowhere.
        if (row.to_kind === "anchor" && !toId) continue;
        if (!toId) continue;
        const columns = "refs(id, from_object_id, from_block_id, to_kind, to_id, mode, instance_layout_json, created_at)";
        const values = [objectId, row.from_block_id, row.to_kind, toId, row.mode, row.instance_layout_json, row.created_at];
        const local = localRefRows.get(row.id);
        if (action === "replace" && local) {
          // The row this import would overwrite belongs to a surviving source. When the package's link is
          // the same one the survivor already holds, keep it; otherwise the package's link is written
          // under a fresh id so both the survivor and the copy keep their reference.
          if (local.from === objectId && local.kind === row.to_kind && local.to === toId) continue;
          run(`INSERT INTO ${columns} VALUES (?,?,?,?,?,?,?,?)`, createId("ref"), ...values);
          continue;
        }
        if (action === "replace") run(`INSERT OR REPLACE INTO ${columns} VALUES (?,?,?,?,?,?,?,?)`, row.id, ...values);
        else run(`INSERT INTO ${columns} VALUES (?,?,?,?,?,?,?,?)`, refIds.get(row.id), ...values);
      }
      // A note this import writes must keep a public source link: its blocks name anchors, so a package
      // ref row that was skipped or never declared would otherwise leave the written object unresolvable.
      // The link is re-derived from the persisted payload instead of trusting ref rows alone — but a
      // block that already holds a resolvable edge (an explicitly kept row, or the package's own) gains
      // no second, derived one: derivation only fills a genuinely missing edge.
      for (const object of manifest.objects) {
        if (object.type !== "notes.document" || skippedObject.has(object.id)) continue;
        const objectId = objectIds.get(object.id) ?? object.id;
        let payload: { blocks?: Array<{ id?: string; anchorId?: string }> };
        try { payload = JSON.parse(object.payload_json); } catch { continue; }
        for (const block of payload.blocks ?? []) {
          if (!block || typeof block !== "object" || typeof block.anchorId !== "string") continue;
          const targetAnchor = anchorPlan.get(block.anchorId) ?? block.anchorId;
          if (!targetAnchor || !hasRow(store, "anchors", targetAnchor)) continue;
          const existing = store.sqlite.prepare("SELECT to_id AS toId FROM refs WHERE from_object_id = ? AND from_block_id IS ? AND to_kind = 'anchor'").get(objectId, block.id ?? null) as { toId: string } | undefined;
          if (existing?.toId === targetAnchor) continue;
          if (existing) throw new MangaError("PUBLISH_CONFLICT", `block ${block.id ?? ""} already references a different anchor than the note names`);
          run("INSERT INTO refs(id, from_object_id, from_block_id, to_kind, to_id, mode, instance_layout_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
            createId("ref"), objectId, block.id ?? null, "anchor", targetAnchor, "live", null, new Date().toISOString());
        }
      }
      for (const row of manifest.progress) {
        if (skippedResource.has(row.resource_id) || !revisionIds.has(row.resource_revision_id)) continue;
        const resourceId = revisionOwnerResource(row.resource_revision_id, row.resource_id);
        const revisionId = revisionIds.get(row.resource_revision_id) ?? row.resource_revision_id;
        if (actionOr("progress", `${row.resource_id}:${row.resource_revision_id}`) === "skip") continue;
        const lastLocator = row.last_locator_json ? remapLocator(row.last_locator_json, revisionIds) : row.last_locator_json;
        run("INSERT OR REPLACE INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at) VALUES (?,?,?,?,?,?)", resourceId, revisionId, lastLocator, row.consumed_ranges_json, row.completion_state, row.last_interaction_at);
      }
      for (const row of manifest.bookmarks ?? []) {
        if (skippedResource.has(row.resource_id) || !revisionIds.has(row.resource_revision_id)) continue;
        const action = actionOr("bookmark", row.id);
        if (action === "skip" && hasRow(store, "bookmarks", row.id)) continue;
        const resourceId = revisionOwnerResource(row.resource_revision_id, row.resource_id);
        const revisionId = revisionIds.get(row.resource_revision_id) ?? row.resource_revision_id;
        const bookmarkId = action === "replace" ? row.id : (bookmarkIds.get(row.id) ?? row.id);
        run("INSERT OR REPLACE INTO bookmarks(id, resource_id, resource_revision_id, label, locator_json, created_at) VALUES (?,?,?,?,?,?)", bookmarkId, resourceId, revisionId, row.label, remapLocator(row.locator_json, revisionIds), row.created_at);
      }
      for (const row of manifest.captures) {
        const action = actionOr("capture", row.id);
        if (action === "skip" && hasRow(store, "capture_sessions", row.id)) continue;
        const sql = action === "replace"
          ? "INSERT OR REPLACE INTO capture_sessions(id, clock_json, status, attachment_id, created_at) VALUES (?,?,?,?,?)"
          : "INSERT INTO capture_sessions(id, clock_json, status, attachment_id, created_at) VALUES (?,?,?,?,?)";
        run(sql, action === "replace" ? row.id : (hasRow(store, "capture_sessions", row.id) ? createId("cap") : row.id), row.clock_json, row.status, row.attachment_id, row.created_at);
      }
      for (const row of manifest.metadataSnapshots) run("INSERT OR REPLACE INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json) VALUES (?,?,?,?)", workIds.get(row.work_id) ?? row.work_id, row.provider_id, row.external_id, row.snapshot_json);
      for (const row of manifest.metadataOverrides) run("INSERT OR REPLACE INTO metadata_overrides(work_id, fields_json, locked_json, cleared_json) VALUES (?,?,?,?)", workIds.get(row.work_id) ?? row.work_id, row.fields_json, row.locked_json, row.cleared_json);
      for (const row of manifest.metadataCandidates) run("INSERT OR REPLACE INTO metadata_candidates(id, work_id, provider_id, payload_json) VALUES (?,?,?,?)", row.id, row.work_id ? (workIds.get(row.work_id) ?? row.work_id) : null, row.provider_id, row.payload_json);
      for (const row of manifest.workLinks) run("INSERT OR REPLACE INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at) VALUES (?,?,?,?,?)", workIds.get(row.work_id) ?? row.work_id, row.provider_id, row.external_id, row.snapshot_json, row.confirmed_at);
      // Managed media keeps a real location row so a hosted book stays readable after the round trip.
      // Usability is judged from the verified staging copy, because durable files are published after
      // these inserts; the target path is where the publish step will place them.
      for (const row of manifest.fileLocations ?? []) {
        const packageResource = packageResourceOf(manifest, row.resource_revision_id);
        // Locations describe the package's copy of a revision, so a kept local revision does not gain them.
        if (skippedResource.has(packageResource) || !writtenRevisions.has(row.resource_revision_id)) continue;
        const revisionId = revisionIds.get(row.resource_revision_id) ?? row.resource_revision_id;
        const hostedName = path.basename(row.relative_path);
        const hostedPath = row.hosted === 1 ? path.join(store.attachmentsDir, hostedName) : row.relative_path;
        const mediaMissing = row.hosted === 1 && missingMedia.has(hostedName);
        const usable = mediaMissing ? false : row.hosted === 1
          ? fs.existsSync(path.join(staging, hostedName))
          : fs.existsSync(hostedPath);
        run("INSERT INTO file_locations(id, resource_revision_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,?)",
          hasRow(store, "file_locations", row.id) ? createId("loc") : row.id, revisionId, usable ? hostedPath : row.relative_path, row.fingerprint, usable ? 1 : 0, row.hosted);
      }
      for (const row of manifest.assets ?? []) {
        if (!writtenRevisions.has(row.resource_revision_id) || missingMedia.has(row.attachment)) continue;
        // Media follows the revision: the owner pair must match the row the index and anchors name.
        const resourceId = revisionOwnerResource(row.resource_revision_id, row.resource_id);
        const revisionId = revisionIds.get(row.resource_revision_id) ?? row.resource_revision_id;
        const payload = fs.readFileSync(path.join(staging, row.attachment));
        run("INSERT OR REPLACE INTO resource_assets(id, resource_id, resource_revision_id, part_id, name, media_type, hash, bytes, payload, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
          `${revisionId}:${row.id.includes(":") ? row.id.slice(row.id.indexOf(":") + 1) : row.id}`, resourceId, revisionId, row.part_id, row.name, row.media_type, row.hash, row.bytes, payload, new Date().toISOString());
      }
      for (const revision of manifest.revisions) {
        // Only a payload this import wrote is indexed; a kept local revision keeps its own index.
        if (!writtenRevisions.has(revision.id)) continue;
        const revisionId = revisionIds.get(revision.id) ?? revision.id;
        const resourceId = finalRevisionOwner.get(revision.id) ?? revision.resource_id;
        const payload = JSON.parse(revision.payload_json) as { normalized?: string; parts?: Array<{ id?: string; normalized?: string; kind?: string }> };
        const parts = payload.parts?.length ? payload.parts : [{ id: "body", normalized: payload.normalized ?? "" }];
        for (const part of parts) {
          if (part.kind === "image") continue;
          for (const mutation of store.indexTextChunks({
            resourceId,
            resourceRevisionId: revisionId,
            partId: part.id || "body",
            representationId: revisionId,
            kind: "body",
            text: part.normalized ?? "",
          })) {
            store.sqlite.prepare(mutation.sql).run(...(mutation.params ?? []));
          }
        }
      }
      for (const object of manifest.objects) {
        if (object.type !== "notes.document" || object.deleted_at) continue;
        const objectId = objectIds.get(object.id) ?? object.id;
        if (skippedObject.has(object.id)) continue;
        const payload = JSON.parse(object.payload_json) as { blocks?: Array<{ id?: string; text?: string }> };
        // The indexed resource must be the one this note's anchor names in the library after the import,
        // so search, authorization and source resolution agree; a scope remap only stands in when the
        // note carries no anchor.
        const anchored = store.sqlite.prepare("SELECT a.resource_id AS rid FROM refs r JOIN anchors a ON a.id = r.to_id WHERE r.from_object_id = ? AND r.to_kind = 'anchor' ORDER BY r.id LIMIT 1").get(objectId) as { rid: string } | undefined;
        const scope = manifest.noteScopes?.find((item) => item.objectId === object.id);
        const fallbackResource = scope ? scope.resourceId ?? undefined : undefined;
        const resourceId = anchored?.rid ?? (fallbackResource ? resourceIds.get(fallbackResource) ?? fallbackResource : undefined);
        for (const block of payload.blocks ?? []) {
          for (const mutation of store.indexTextChunks({
            objectId,
            resourceId,
            partId: block.id || "block",
            representationId: objectId,
            kind: "note",
            text: block.text ?? "",
          })) {
            store.sqlite.prepare(mutation.sql).run(...(mutation.params ?? []));
          }
        }
      }
      // Publish durable files before the DB commit so committed rows never refer to missing copies.
      for (const attachment of manifest.attachments) {
        if (missingMedia.has(attachment.id)) continue;
        const target = path.join(store.attachmentsDir, attachment.id);
        if (fs.existsSync(target)) {
          if (sha256File(target) === attachment.hash) continue;
          throw new MangaError("PUBLISH_CONFLICT", `attachment already exists with different content: ${attachment.id}`);
        }
        fs.linkSync(path.join(staging, attachment.id), target);
        published.push(target);
        created.push(target);
      }
      maybeCrash("publish");
      maybeCrash("commit");
      const now = new Date().toISOString();
      store.sqlite.prepare("INSERT INTO domain_events(event_id,type,payload_json,created_at) VALUES (?,?,?,?)").run(createId("evt"), "library.packageImported", JSON.stringify({ objects: manifest.objects.length, strategy }), now);
      if (options.receipt) {
        store.sqlite.prepare("INSERT INTO operations(idempotency_key,command_id,result_json,committed_at) VALUES (?,?,?,?)").run(
          options.receipt.key, options.receipt.commandId, JSON.stringify({ status: "ok", value: { format: manifest.format, attachments: manifest.attachments.length, objects: manifest.objects.length, works: manifest.works.length, strategy } }), now,
        );
      }
      store.sqlite.prepare("UPDATE recovery_jobs SET status = 'succeeded', stage = 'done', updated_at = ? WHERE id = ?").run(now, jobId);
      store.sqlite.exec("COMMIT");
      committed = true;
    } catch (error) {
      try { store.sqlite.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
    return manifest;
  } catch (error) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
    throw error;
  } finally {
    if (!committed) {
      // Ordinary failure: the transaction is rolled back, so remove our own published links and staging.
      // A process exit skips this block; recoverOrRollback then handles the recorded job.
      for (const target of published) {
        try { fs.unlinkSync(target); } catch { /* keep going */ }
      }
      fs.rmSync(staging, { recursive: true, force: true });
      store.sqlite.prepare("UPDATE recovery_jobs SET status = 'rolled-back', updated_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
    } else {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

/** Revision ids remapped by the `duplicate` action, shared by every dependent row in one import. */
function packageResourceOf(manifest: LibraryPackageManifest, revisionId: string): string {
  return manifest.revisions.find((row) => row.id === revisionId)?.resource_id ?? "";
}

function hasRow(store: DrizzleStore, table: string, id: string): boolean {
  return Boolean(store.sqlite.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));
}

function remap(ids: string[], exists: (id: string) => boolean, actionFor: (kind: PackageRowKind, id: string) => PackageImportStrategy, kind: PackageRowKind): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const id of ids) {
    // A non-conflicting id keeps the package identity. Only a duplicate collision receives a new id.
    if (exists(id) && actionFor(kind, id) === "duplicate") mapping.set(id, createId(kind.slice(0, 3)));
    else mapping.set(id, id);
  }
  return mapping;
}

/**
 * Rewrite known note-block anchor ids so the payload, its history and the reference row name the same anchor.
 * Unknown attrs and non-note payloads are left untouched.
 */
function rewriteNoteAnchors(payloadJson: string, anchors: Map<string, string>): string {
  let payload: unknown;
  try { payload = JSON.parse(payloadJson); } catch { return payloadJson; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payloadJson;
  const blocks = (payload as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return payloadJson;
  let changed = false;
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const row = block as { anchorId?: unknown };
    if (typeof row.anchorId !== "string") continue;
    const mapped = anchors.get(row.anchorId);
    if (!mapped) {
      delete row.anchorId;
      changed = true;
    } else if (mapped !== row.anchorId) {
      row.anchorId = mapped;
      changed = true;
    }
  }
  return changed ? JSON.stringify(payload) : payloadJson;
}

function packageFileExists(root: string, relative: string): boolean {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new MangaError("VALIDATION_ERROR", "package path escapes root");
  return fs.existsSync(target);
}

/** Keep a note's scope pointing at the resource id the import actually created. */
function remapScope(scopeJson: string, resourceIds: Map<string, string>): string {
  try {
    const scope = JSON.parse(scopeJson) as { resourceId?: string | null };
    if (scope.resourceId && resourceIds.has(scope.resourceId)) return JSON.stringify({ ...scope, resourceId: resourceIds.get(scope.resourceId) });
    return scopeJson;
  } catch {
    return scopeJson;
  }
}

/** A stored locator names the revision it was resolved against, so a remapped revision must follow. */
export function remapLocator(locatorJson: string, revisionIds: Map<string, string>): string {
  if (!revisionIds.size) return locatorJson;
  try {
    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          key === "representationId" && typeof item === "string" && revisionIds.has(item) ? revisionIds.get(item) : walk(item),
        ]));
      }
      return value;
    };
    return JSON.stringify(walk(JSON.parse(locatorJson)));
  } catch {
    return locatorJson;
  }
}

export type RecoveryOutcome = { jobs: number; removed: string[]; needsReview: string[]; recovered: string[] };
function sameFile(a: string, b: string): boolean {
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    return left.ino === right.ino && left.dev === right.dev && left.size === right.size;
  } catch {
    return false;
  }
}

type LocationPayload = {
  copies?: Array<{ partition: string; source: string; target: string; indexedOnly?: boolean }>;
  targetRoot?: string;
  liveRoot?: string;
  verified?: Array<{ partition: string; bytes: number; fingerprint: string }>;
};

export function recoverOrRollback(store: DrizzleStore, action: "recover" | "rollback", liveRoot?: string): RecoveryOutcome {
  const jobs = store.sqlite.prepare("SELECT * FROM recovery_jobs WHERE status IN ('running','interrupted','failed','planned','needs-review')").all() as Array<{ id: string; kind: string; stage: string; status: string; staging_path: string | null; payload_json: string }>;
  const removed: string[] = [];
  const needsReview: string[] = [];
  const recovered: string[] = [];
  for (const job of jobs) {
    if (job.kind === "location-migrate") {
      if (action === "rollback") {
        const outcome = rollbackLocationJob(store, job, liveRoot ?? JSON.parse(job.payload_json).liveRoot);
        removed.push(...outcome.removed);
        needsReview.push(...outcome.needsReview);
        continue;
      }
      const outcome = resumeLocationCopy(store, job, liveRoot);
      needsReview.push(...outcome.needsReview);
      if (outcome.status === "copied") recovered.push(job.id);
      continue;
    }
    if (action !== "rollback") {
      store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
      needsReview.push(job.id);
      continue;
    }
    const payload = JSON.parse(job.payload_json) as { attachments?: string[] };
    if (job.kind === "package-import" && job.staging_path) {
      // The transaction never committed, so published hard links of staged files are orphans.
      for (const name of payload.attachments ?? []) {
        const staged = path.join(job.staging_path, name);
        const target = path.join(store.attachmentsDir, name);
        if (fs.existsSync(staged) && fs.existsSync(target) && sameFile(staged, target)) {
          fs.unlinkSync(target);
          removed.push(target);
        }
      }
      if (fs.existsSync(job.staging_path)) {
        fs.rmSync(job.staging_path, { recursive: true, force: true });
        removed.push(job.staging_path);
      }
    }
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'rolled-back', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
  }
  return { jobs: jobs.length, removed, needsReview, recovered };
}

export function resumeLocationCopy(
  store: DrizzleStore,
  job: { id: string; payload_json: string; status: string },
  liveRoot?: string,
): { status: "copied" | "needs-review" | "blocked"; needsReview: string[]; verified: Array<{ partition: string; bytes: number; fingerprint: string }>; targetRoot?: string } {
  const payload = JSON.parse(job.payload_json) as LocationPayload;
  const live = liveRoot ? comparablePath(liveRoot) : undefined;
  const targetRoot = payload.targetRoot ? comparablePath(payload.targetRoot) : undefined;
  const relocated = store.getMeta("relocatedRoot");
  const published = relocated && targetRoot ? comparablePath(relocated) === targetRoot : false;
  if (live && targetRoot && pathsOverlap(live, targetRoot) && !published) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return { status: "blocked", needsReview: [job.id], verified: [], targetRoot: payload.targetRoot };
  }
  if (published) {
    return { status: "copied", needsReview: [], verified: payload.verified ?? [], targetRoot: payload.targetRoot };
  }
  if (!payload.copies?.length || !payload.targetRoot) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return { status: "needs-review", needsReview: [job.id], verified: [] };
  }
  try {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'running', stage = 'copy', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    const verified: Array<{ partition: string; bytes: number; fingerprint: string }> = [];
    for (const copy of payload.copies) {
      if (copy.indexedOnly) continue;
      const dest = copy.target;
      fs.mkdirSync(dest, { recursive: true });
      const files = listCopyFiles(copy.source);
      for (const file of files) {
        const relative = file.relativePath.replace(/^\.\//, "");
        const targetFile = path.join(dest, relative);
        const owned = store.sqlite.prepare("SELECT state, fingerprint, absolute_path AS path FROM migration_owned_files WHERE job_id = ? AND partition = ? AND relative_path = ?").get(job.id, copy.partition, relative) as { state: string; fingerprint: string | null; path: string } | undefined;
        if (owned?.state === "committed" && fs.existsSync(targetFile)) {
          const destHash = ownedFileFingerprint(targetFile);
          if (destHash === owned.fingerprint || destHash === ownedFileFingerprint(file.absolutePath)) continue;
          if (copy.partition === "data" && targetFile.endsWith(".sqlite")) continue;
          store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
          return { status: "needs-review", needsReview: [job.id], verified };
        }
        if (owned?.state === "copying" && fs.existsSync(targetFile)) {
          try { fs.unlinkSync(targetFile); } catch {
            store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
            return { status: "needs-review", needsReview: [job.id], verified };
          }
        } else if (fs.existsSync(targetFile)) {
          store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
          return { status: "needs-review", needsReview: [job.id], verified };
        }
        store.sqlite.prepare("INSERT OR REPLACE INTO migration_owned_files(job_id, partition, relative_path, absolute_path, state, fingerprint) VALUES (?,?,?,?,?,?)").run(
          job.id, copy.partition, relative, targetFile, "planned", null,
        );
        store.sqlite.prepare("UPDATE migration_owned_files SET state = 'copying' WHERE job_id = ? AND partition = ? AND relative_path = ?").run(job.id, copy.partition, relative);
        const hash = copyOwnedFile(file.absolutePath, targetFile);
        store.sqlite.prepare("UPDATE migration_owned_files SET state = 'committed', fingerprint = ? WHERE job_id = ? AND partition = ? AND relative_path = ?").run(hash, job.id, copy.partition, relative);
      }
      const destTree = fingerprintTree(dest);
      for (const file of files) {
        const relative = file.relativePath.replace(/^\.\//, "");
        const targetFile = path.join(dest, relative);
        if (!fs.existsSync(targetFile) || (
          ownedFileFingerprint(targetFile) !== ownedFileFingerprint(file.absolutePath)
          && !(copy.partition === "data" && targetFile.endsWith(".sqlite"))
        )) {
          throw new MangaError("VALIDATION_ERROR", `copied ${copy.partition} is missing a source file`, { details: { partition: copy.partition, relative } });
        }
      }
      verified.push({ partition: copy.partition, bytes: destTree.bytes, fingerprint: destTree.hash });
    }
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'running', stage = 'verify', payload_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ ...payload, verified }), new Date().toISOString(), job.id,
    );
    return { status: "copied", needsReview: [], verified, targetRoot: payload.targetRoot };
  } catch (error) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    throw error;
  }
}

function rollbackLocationJob(
  store: DrizzleStore,
  job: { id: string; payload_json: string },
  liveRoot?: string,
): { removed: string[]; needsReview: string[] } {
  const owned = store.sqlite.prepare("SELECT absolute_path AS path, state, fingerprint FROM migration_owned_files WHERE job_id = ?").all(job.id) as Array<{ path: string; state: string; fingerprint: string | null }>;
  const live = liveRoot ? comparablePath(liveRoot) : undefined;
  const payload = JSON.parse(job.payload_json) as { targetRoot?: string };
  const targetRoot = payload.targetRoot ? comparablePath(payload.targetRoot) : undefined;
  // A root this library already published to is authoritative even if the job row still looks unfinished.
  const relocated = store.getMeta("relocatedRoot");
  const published = relocated && targetRoot ? comparablePath(relocated) === targetRoot : false;
  if (published || (live && targetRoot && pathsOverlap(live, targetRoot))) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return { removed: [], needsReview: [job.id] };
  }
  if (!owned.length) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return { removed: [], needsReview: [job.id] };
  }
  const removed: string[] = [];
  let uncertain = false;
  for (const file of owned) {
    try {
      if (!fs.existsSync(file.path)) continue;
      const resolved = comparablePath(file.path);
      const real = comparablePath(fs.realpathSync(file.path));
      if (!targetRoot || !resolved.startsWith(targetRoot + path.sep) || real !== resolved
        || (live && pathsOverlap(live, resolved)) || file.state !== "committed"
        || !file.fingerprint || ownedFileFingerprint(file.path) !== file.fingerprint) {
        uncertain = true;
        continue;
      }
      fs.unlinkSync(file.path);
      removed.push(file.path);
    } catch {
      uncertain = true;
    }
  }
  if (uncertain) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return { removed, needsReview: [job.id] };
  }
  store.sqlite.prepare("DELETE FROM migration_owned_files WHERE job_id = ?").run(job.id);
  store.sqlite.prepare("UPDATE recovery_jobs SET status = 'rolled-back', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
  return { removed, needsReview: [] };
}
