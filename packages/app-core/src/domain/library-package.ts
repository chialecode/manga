import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LibraryPackageManifestSchema, MangaError, PackageAttachmentNameSchema, createId, type LibraryPackageManifest } from "@manga/contracts";
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

function checkedFile(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new MangaError("VALIDATION_ERROR", "package path escapes root");
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) throw new MangaError("VALIDATION_ERROR", "package root cannot be a link");
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) throw new MangaError("VALIDATION_ERROR", `package file missing: ${relative}`);
    if (fs.lstatSync(current).isSymbolicLink()) throw new MangaError("VALIDATION_ERROR", "package path cannot contain links");
  }
  if (!fs.statSync(target).isFile()) throw new MangaError("VALIDATION_ERROR", "package attachment must be a regular file");
  return target;
}

function validateReferences(manifest: LibraryPackageManifest): void {
  const attachments = new Set(manifest.attachments.map((item) => item.id));
  const revisions = new Map(manifest.revisions.map((item) => [item.id, item.resource_id]));
  const resources = new Set(manifest.resources.map((item) => item.id));
  const objects = new Set(manifest.objects.map((item) => item.id));
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
    const abs = checkedFile(sourceDir, attachment.relativePath);
    const size = fs.statSync(abs).size;
    total += size;
    if (size !== attachment.bytes || total > MAX_PACKAGE_BYTES) throw new MangaError("VALIDATION_ERROR", "package attachment size/budget mismatch");
    if (sha256File(abs) !== attachment.hash) throw new MangaError("VALIDATION_ERROR", `package attachment hash mismatch: ${attachment.id}`);
  }
  validateReferences(manifest);
  return manifest;
}

export function importLibraryPackage(store: DrizzleStore, sourceDir: string, options: { crashAt?: string; receipt?: { key: string; commandId: string } } = {}): LibraryPackageManifest {
  const manifest = readLibraryPackage(sourceDir);
  const counts = store.counts();
  const attachmentsPresent = fs.existsSync(store.attachmentsDir)
    ? fs.readdirSync(store.attachmentsDir).some((name) => !name.startsWith(".import-"))
    : false;
  if (Object.values(counts).some((n) => n > 0) || attachmentsPresent) {
    throw new MangaError("PUBLISH_CONFLICT", "import requires an empty profile");
  }
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
  let committed = false;
  try {
    maybeCrash("copy");
    for (const attachment of manifest.attachments) {
      const staged = path.join(staging, attachment.id);
      fs.copyFileSync(checkedFile(sourceDir, attachment.relativePath), staged, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(staged, "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    maybeCrash("verify");
    for (const attachment of manifest.attachments) {
      const staged = path.join(staging, attachment.id);
      if (sha256File(staged) !== attachment.hash) throw new MangaError("VALIDATION_ERROR", "package attachment changed during copy");
    }
    store.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const run = (sql: string, ...params: unknown[]) => store.sqlite.prepare(sql).run(...params.map(sqlValue));
      for (const row of manifest.works) run("INSERT INTO works(id,title,created_at) VALUES (?,?,?)", row.id, row.title, row.created_at);
      for (const row of manifest.resources) run("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)", row.id, row.work_id, row.kind, row.title, row.aliases_json, row.created_at);
      for (const row of manifest.revisions) run("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)", row.id, row.resource_id, row.fingerprint, row.parser_version, row.payload_json, row.created_at);
      for (const row of manifest.objects) {
        run("INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, attachment_ids_json, preview_json, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          row.id, row.type, row.owner_module_id, row.scope_json, row.schema_version, row.revision, row.title, row.payload_json, row.attachment_ids_json, row.preview_json, row.created_at, row.updated_at, row.deleted_at);
      }
      for (const row of manifest.objectRevisions) run("INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?,?,?,?)", row.object_id, row.revision, row.payload_json, row.created_at);
      for (const row of manifest.anchors) run("INSERT INTO anchors(id, resource_id, resource_revision_id, locator_json, preview_json, created_at) VALUES (?,?,?,?,?,?)", row.id, row.resource_id, row.resource_revision_id, row.locator_json, row.preview_json, row.created_at);
      for (const row of manifest.refs) run("INSERT INTO refs(id, from_object_id, from_block_id, to_kind, to_id, mode, instance_layout_json, created_at) VALUES (?,?,?,?,?,?,?,?)", row.id, row.from_object_id, row.from_block_id, row.to_kind, row.to_id, row.mode, row.instance_layout_json, row.created_at);
      for (const row of manifest.progress) run("INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at) VALUES (?,?,?,?,?,?)", row.resource_id, row.resource_revision_id, row.last_locator_json, row.consumed_ranges_json, row.completion_state, row.last_interaction_at);
      for (const row of manifest.captures) run("INSERT INTO capture_sessions(id, clock_json, status, attachment_id, created_at) VALUES (?,?,?,?,?)", row.id, row.clock_json, row.status, row.attachment_id, row.created_at);
      for (const row of manifest.metadataSnapshots) run("INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json) VALUES (?,?,?,?)", row.work_id, row.provider_id, row.external_id, row.snapshot_json);
      for (const row of manifest.metadataOverrides) run("INSERT INTO metadata_overrides(work_id, fields_json, locked_json, cleared_json) VALUES (?,?,?,?)", row.work_id, row.fields_json, row.locked_json, row.cleared_json);
      for (const row of manifest.metadataCandidates) run("INSERT INTO metadata_candidates(id, work_id, provider_id, payload_json) VALUES (?,?,?,?)", row.id, row.work_id, row.provider_id, row.payload_json);
      for (const row of manifest.workLinks) run("INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at) VALUES (?,?,?,?,?)", row.work_id, row.provider_id, row.external_id, row.snapshot_json, row.confirmed_at);
      for (const revision of manifest.revisions) {
        const payload = JSON.parse(revision.payload_json) as { normalized?: string; parts?: Array<{ normalized: string }> };
        const text = payload.normalized ?? payload.parts?.map((part) => part.normalized).join("\n") ?? "";
        if (!text) continue;
        for (const mutation of store.indexFragment({ id: `pkg-body-${revision.id}`, resourceId: revision.resource_id, kind: "body", text: text.slice(0, 4000) })) {
          store.sqlite.prepare(mutation.sql).run(...(mutation.params ?? []));
        }
      }
      for (const object of manifest.objects) {
        if (object.type !== "notes.document" || object.deleted_at) continue;
        const payload = JSON.parse(object.payload_json) as { blocks?: Array<{ text: string }> };
        const text = payload.blocks?.map((block) => block.text).join("\n") ?? "";
        const ref = manifest.refs.find((item) => item.from_object_id === object.id && item.to_kind === "anchor");
        const anchor = manifest.anchors.find((item) => item.id === ref?.to_id);
        const scope = manifest.noteScopes?.find((item) => item.objectId === object.id);
        const resourceId = scope ? scope.resourceId ?? undefined : anchor?.resource_id;
        for (const mutation of store.indexFragment({ id: `pkg-note-${object.id}`, objectId: object.id, resourceId, kind: "note", text })) {
          store.sqlite.prepare(mutation.sql).run(...(mutation.params ?? []));
        }
      }
      // Publish durable files before the DB commit so committed rows never refer to missing copies.
      for (const attachment of manifest.attachments) {
        const target = path.join(store.attachmentsDir, attachment.id);
        if (fs.existsSync(target)) throw new MangaError("PUBLISH_CONFLICT", "attachment already exists");
        fs.linkSync(path.join(staging, attachment.id), target);
        published.push(target);
      }
      maybeCrash("publish");
      maybeCrash("commit");
      const now = new Date().toISOString();
      store.sqlite.prepare("INSERT INTO domain_events(event_id,type,payload_json,created_at) VALUES (?,?,?,?)").run(createId("evt"), "library.packageImported", JSON.stringify({ objects: manifest.objects.length }), now);
      if (options.receipt) {
        store.sqlite.prepare("INSERT INTO operations(idempotency_key,command_id,result_json,committed_at) VALUES (?,?,?,?)").run(
          options.receipt.key, options.receipt.commandId, JSON.stringify({ status: "ok", value: { format: manifest.format, attachments: manifest.attachments.length, objects: manifest.objects.length, works: manifest.works.length } }), now,
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
