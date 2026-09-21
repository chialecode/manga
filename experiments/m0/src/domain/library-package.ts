import { createHash } from "node:crypto";
import { PackageAttachmentNameSchema as safeName, LibraryPackageManifestSchema as manifestSchema } from "@manga/contracts";
import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";

type LibraryStore = {
  attachmentsDir: string;
  counts: () => { resources?: number; content_objects?: number };
  indexFragment: (input: {id: string; resourceId?: string; objectId?: string; kind: "body" | "note"; text: string}) => Array<{sql: string; params?: Array<string | number | bigint | null | Uint8Array>}>;
  db: {
    exec: (sql: string) => unknown;
    prepare: (sql: string) => {
      all: () => unknown[];
      run: (...args: Array<string | number | bigint | null | Uint8Array>) => unknown;
    };
  };
};

export const LIBRARY_PACKAGE_FORMAT = "manga-library-package-v1";

export type PackageAttachment = {
  id: string;
  hash: string;
  relativePath: string;
  bytes: number;
};

export type LibraryPackageManifest = {
  format: typeof LIBRARY_PACKAGE_FORMAT;
  createdAt: string;
  works: unknown[];
  resources: unknown[];
  revisions: unknown[];
  objects: unknown[];
  objectRevisions: unknown[];
  anchors: unknown[];
  refs: unknown[];
  progress: unknown[];
  captures: unknown[];
  metadataSnapshots: unknown[];
  metadataOverrides: unknown[];
  metadataCandidates: unknown[];
  workLinks: unknown[];
  noteScopes?: Array<{objectId:string;resourceId:string|null}>;
  attachments: PackageAttachment[];
};

const tableKeys = {
  works:"works", resources:"resources", revisions:"resource_revisions", objects:"content_objects",
  objectRevisions:"object_revisions", anchors:"anchors", refs:"refs", progress:"progress", captures:"capture_sessions",
  metadataSnapshots:"metadata_snapshots", metadataOverrides:"metadata_overrides", metadataCandidates:"metadata_candidates", workLinks:"work_links",
} as const;
const maxAttachmentBytes = 128 * 1024 * 1024;
const maxPackageBytes = 512 * 1024 * 1024;


function checkedFile(root: string, relative: string): string {
  const target=path.resolve(root,relative), rel=path.relative(path.resolve(root),target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new MangaError("VALIDATION_ERROR","package path escapes root");
  let current=path.resolve(root);
  if(fs.lstatSync(current).isSymbolicLink()) throw new MangaError("VALIDATION_ERROR","package root cannot be a link");
  for(const part of rel.split(path.sep)) {
    current=path.join(current,part);
    if(fs.lstatSync(current).isSymbolicLink()) throw new MangaError("VALIDATION_ERROR","package path cannot contain links");
  }
  if(!fs.statSync(target).isFile()) throw new MangaError("VALIDATION_ERROR","package attachment must be a regular file");
  return target;
}

function requireEmptyDirectory(dir: string): void {
  if(fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new MangaError("PUBLISH_CONFLICT","package destination requires an empty directory");
  fs.mkdirSync(dir,{recursive:true});
}

function validateReferences(manifest: LibraryPackageManifest): void {
  const attachments=new Set(manifest.attachments.map(item=>item.id));
  const revisions=new Map((manifest.revisions as Array<{id:string;resource_id:string}>).map(item=>[item.id,item.resource_id]));
  const resources=new Set((manifest.resources as Array<{id:string}>).map(item=>item.id));
  const objects=new Set((manifest.objects as Array<{id:string}>).map(item=>item.id));
  for(const row of manifest.objectRevisions as Array<{object_id:string}>) if(!objects.has(row.object_id)) throw new MangaError("VALIDATION_ERROR","package object revision owner missing");
  for(const row of manifest.refs as Array<{from_object_id:string}>) if(!objects.has(row.from_object_id)) throw new MangaError("VALIDATION_ERROR","package reference owner missing");
  const scoped=new Set<string>();
  for(const row of manifest.noteScopes ?? []) {
    if(!objects.has(row.objectId) || scoped.has(row.objectId)) throw new MangaError("VALIDATION_ERROR","package note scope owner missing or duplicate");
    scoped.add(row.objectId);
  }
  for(const item of manifest.revisions as Array<{resource_id:string}>) if(!resources.has(item.resource_id)) throw new MangaError("VALIDATION_ERROR","package revision resource missing");
  for(const item of [...manifest.anchors,...manifest.progress] as Array<{resource_id:string;resource_revision_id:string}>) if(revisions.get(item.resource_revision_id)!==item.resource_id) throw new MangaError("VALIDATION_ERROR","package resource revision mismatch");
  for(const item of manifest.objects as Array<{attachment_ids_json:string}>) {
    const ids = JSON.parse(item.attachment_ids_json) as string[];
    if(!Array.isArray(ids)) throw new MangaError("VALIDATION_ERROR","package attachment list must be an array");
    ids.forEach(id=>safeName.parse(id));
    if(ids.some(id=>!attachments.has(id))) throw new MangaError("VALIDATION_ERROR","package object attachment missing");
  }
  for(const item of manifest.captures as Array<{attachment_id:string}>) if(!attachments.has(item.attachment_id)) throw new MangaError("VALIDATION_ERROR","package capture attachment missing");
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sqlValue(value: unknown): string | number | bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function queryAll(store: LibraryStore, sql: string): unknown[] {
  return store.db.prepare(sql).all();
}

export function exportLibraryPackage(store: LibraryStore, destDir: string): LibraryPackageManifest {
  if(path.resolve(destDir) === path.resolve(store.attachmentsDir) || path.resolve(destDir).startsWith(path.resolve(store.attachmentsDir)+path.sep)) throw new MangaError("PUBLISH_CONFLICT","package destination is inside attachments");
  requireEmptyDirectory(destDir);
  const attachmentsDir = path.join(destDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const attachments: PackageAttachment[] = [];
  if (fs.existsSync(store.attachmentsDir)) {
    for (const name of fs.readdirSync(store.attachmentsDir)) {
      if (name.endsWith(".playback.webm")) continue;
      safeName.parse(name);
      const source = checkedFile(store.attachmentsDir, name);
      if(fs.statSync(source).size > maxAttachmentBytes) throw new MangaError("VALIDATION_ERROR","package attachment exceeds budget");
      const dest = path.join(attachmentsDir, name);
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      const bytes = fs.statSync(dest).size;
      const hash = sha256File(dest);
      attachments.push({ id: name, hash, relativePath: `attachments/${name}`, bytes });
    }
  }
  const manifest: LibraryPackageManifest = {
    format: LIBRARY_PACKAGE_FORMAT,
    createdAt: new Date().toISOString(),
    works: queryAll(store, "SELECT * FROM works"),
    resources: queryAll(store, "SELECT * FROM resources"),
    revisions: queryAll(store, "SELECT * FROM resource_revisions"),
    objects: queryAll(store, "SELECT * FROM content_objects"),
    objectRevisions: queryAll(store, "SELECT object_id, revision, payload_json, created_at FROM object_revisions"),
    anchors: queryAll(store, "SELECT * FROM anchors"),
    refs: queryAll(store, "SELECT * FROM refs"),
    progress: queryAll(store, "SELECT * FROM progress"),
    captures: queryAll(store, "SELECT * FROM capture_sessions"),
    metadataSnapshots: queryAll(store, "SELECT * FROM metadata_snapshots"),
    metadataOverrides: queryAll(store, "SELECT * FROM metadata_overrides"),
    metadataCandidates: queryAll(store, "SELECT * FROM metadata_candidates"),
    workLinks: queryAll(store, "SELECT * FROM work_links"),
    noteScopes: queryAll(store, "SELECT object_id AS objectId, resource_id AS resourceId FROM text_fragments WHERE kind='note' AND object_id IS NOT NULL GROUP BY object_id, resource_id") as Array<{objectId:string;resourceId:string|null}>,
    attachments,
  };
  manifestSchema.parse(manifest);
  if(attachments.reduce((sum,item)=>sum+item.bytes,0)>maxPackageBytes) throw new MangaError("VALIDATION_ERROR","package attachments exceed budget");
  validateReferences(manifest);
  fs.writeFileSync(path.join(destDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`,{flag:"wx"});
  return manifest;
}

export function readLibraryPackage(sourceDir: string): LibraryPackageManifest {
  const file = checkedFile(sourceDir, "manifest.json");
  if (!fs.existsSync(file)) throw new MangaError("UNSUPPORTED_FORMAT", "package manifest missing");
  if(fs.statSync(file).size > 64 * 1024 * 1024) throw new MangaError("VALIDATION_ERROR","package manifest exceeds budget");
  const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) as unknown as LibraryPackageManifest;
  if (manifest.format !== LIBRARY_PACKAGE_FORMAT) throw new MangaError("UNSUPPORTED_FORMAT", "unknown library package format");
  const names=new Set<string>();
  let total=0;
  for (const attachment of manifest.attachments) {
    if(attachment.relativePath !== `attachments/${attachment.id}` || names.has(attachment.id.toLowerCase())) throw new MangaError("VALIDATION_ERROR","unsafe or duplicate package attachment path");
    names.add(attachment.id.toLowerCase());
    const abs = checkedFile(sourceDir, attachment.relativePath);
    if (!fs.existsSync(abs)) throw new MangaError("VALIDATION_ERROR", `package attachment missing: ${attachment.id}`);
    const size=fs.statSync(abs).size;
    total+=size;
    if(size!==attachment.bytes || total>maxPackageBytes) throw new MangaError("VALIDATION_ERROR","package attachment size/budget mismatch");
    const hash = sha256File(abs);
    if (hash !== attachment.hash) throw new MangaError("VALIDATION_ERROR", `package attachment hash mismatch: ${attachment.id}`);
  }
  validateReferences(manifest);
  return manifest;
}

export function importLibraryPackage(store: LibraryStore, sourceDir: string, receipt?: {key: string; commandId: string}): LibraryPackageManifest {
  const manifest = readLibraryPackage(sourceDir);
  if (Object.values(tableKeys).some(table=>store.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).all().length) || fs.readdirSync(store.attachmentsDir).length) {
    throw new MangaError("PUBLISH_CONFLICT", "import requires an empty profile");
  }
  const staging = fs.mkdtempSync(path.join(store.attachmentsDir, ".import-"));
  const published: string[]=[];
  let committed=false;
  try {
    for (const attachment of manifest.attachments) {
      const staged=path.join(staging,attachment.id);
      fs.copyFileSync(checkedFile(sourceDir, attachment.relativePath), staged,fs.constants.COPYFILE_EXCL);
      if(sha256File(staged)!==attachment.hash) throw new MangaError("VALIDATION_ERROR","package attachment changed during copy");
      const fd=fs.openSync(staged,"r+");
      try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    }
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of manifest.works as Array<{ id: string; title: string; created_at: string }>) {
        store.db.prepare("INSERT INTO works(id,title,created_at) VALUES (?,?,?)").run(row.id, row.title, row.created_at);
      }
      for (const row of manifest.resources as Array<{ id: string; work_id?: string; kind: string; title: string; aliases_json: string; created_at: string }>) {
        store.db.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)").run(row.id, row.work_id ?? null, row.kind, row.title, row.aliases_json, row.created_at);
      }
      for (const row of manifest.revisions as Array<{ id: string; resource_id: string; fingerprint: string; parser_version: string; payload_json: string; created_at: string }>) {
        store.db.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(row.id, row.resource_id, row.fingerprint, row.parser_version, row.payload_json, row.created_at);
      }
      for (const row of manifest.objects as Array<Record<string, unknown>>) {
        store.db.prepare("INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, attachment_ids_json, preview_json, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          sqlValue(row.id), sqlValue(row.type), sqlValue(row.owner_module_id), sqlValue(row.scope_json), sqlValue(row.schema_version), sqlValue(row.revision), sqlValue(row.title), sqlValue(row.payload_json), sqlValue(row.attachment_ids_json), sqlValue(row.preview_json), sqlValue(row.created_at), sqlValue(row.updated_at), sqlValue(row.deleted_at),
        );
      }
      for (const row of manifest.objectRevisions as Array<{ object_id: string; revision: number; payload_json: string; created_at: string }>) {
        store.db.prepare("INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?,?,?,?)").run(row.object_id, row.revision, row.payload_json, row.created_at);
      }
      for (const row of manifest.anchors as Array<Record<string, unknown>>) {
        store.db.prepare("INSERT INTO anchors(id, resource_id, resource_revision_id, locator_json, preview_json, created_at) VALUES (?,?,?,?,?,?)").run(sqlValue(row.id), sqlValue(row.resource_id), sqlValue(row.resource_revision_id), sqlValue(row.locator_json), sqlValue(row.preview_json), sqlValue(row.created_at));
      }
      for (const row of manifest.refs as Array<Record<string, unknown>>) {
        store.db.prepare("INSERT INTO refs(id, from_object_id, from_block_id, to_kind, to_id, mode, instance_layout_json, created_at) VALUES (?,?,?,?,?,?,?,?)").run(sqlValue(row.id), sqlValue(row.from_object_id), sqlValue(row.from_block_id), sqlValue(row.to_kind), sqlValue(row.to_id), sqlValue(row.mode), sqlValue(row.instance_layout_json), sqlValue(row.created_at));
      }
      for (const row of manifest.progress as Array<Record<string, unknown>>) {
        store.db.prepare("INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at) VALUES (?,?,?,?,?,?)").run(sqlValue(row.resource_id), sqlValue(row.resource_revision_id), sqlValue(row.last_locator_json), sqlValue(row.consumed_ranges_json), sqlValue(row.completion_state), sqlValue(row.last_interaction_at));
      }
      for (const row of manifest.captures as Array<Record<string, unknown>>) {
        store.db.prepare("INSERT INTO capture_sessions(id, clock_json, status, attachment_id, created_at) VALUES (?,?,?,?,?)").run(sqlValue(row.id), sqlValue(row.clock_json), sqlValue(row.status), sqlValue(row.attachment_id), sqlValue(row.created_at));
      }
      for (const row of manifest.metadataSnapshots as Array<Record<string, unknown>>) {
        store.db.prepare("INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json) VALUES (?,?,?,?)").run(sqlValue(row.work_id), sqlValue(row.provider_id), sqlValue(row.external_id), sqlValue(row.snapshot_json));
      }
      for (const row of manifest.metadataOverrides as Array<Record<string, unknown>>) {
        store.db.prepare("INSERT INTO metadata_overrides(work_id, fields_json, locked_json, cleared_json) VALUES (?,?,?,?)").run(sqlValue(row.work_id), sqlValue(row.fields_json), sqlValue(row.locked_json), sqlValue(row.cleared_json));
      }
      for (const row of manifest.metadataCandidates as Array<Record<string, unknown>>) {
        store.db.prepare("INSERT INTO metadata_candidates(id, work_id, provider_id, payload_json) VALUES (?,?,?,?)").run(sqlValue(row.id), sqlValue(row.work_id), sqlValue(row.provider_id), sqlValue(row.payload_json));
      }
      for (const row of manifest.workLinks as Array<Record<string, unknown>>) {
        store.db.prepare("INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at) VALUES (?,?,?,?,?)").run(sqlValue(row.work_id), sqlValue(row.provider_id), sqlValue(row.external_id), sqlValue(row.snapshot_json), sqlValue(row.confirmed_at));
      }
      for(const revision of manifest.revisions as Array<{id:string;resource_id:string;payload_json:string}>) {
        const payload=JSON.parse(revision.payload_json);
        const text=payload.normalized ?? payload.parts?.map((part:{normalized:string})=>part.normalized).join("\n") ?? "";
        if(text) for(const mutation of store.indexFragment({id:`pkg-body-${revision.id}`,resourceId:revision.resource_id,kind:"body",text})) store.db.prepare(mutation.sql).run(...mutation.params ?? []);
      }
      for(const object of manifest.objects as Array<{id:string;type:string;payload_json:string;deleted_at?:string}>) {
        if(object.type!=="notes.document" || object.deleted_at) continue;
        const payload=JSON.parse(object.payload_json);
        const text=payload.blocks?.map((block:{text:string})=>block.text).join("\n") ?? "";
        const ref=(manifest.refs as Array<{from_object_id:string;to_kind:string;to_id:string}>).find(item=>item.from_object_id===object.id && item.to_kind==="anchor");
        const anchor=(manifest.anchors as Array<{id:string;resource_id:string}>).find(item=>item.id===ref?.to_id);
        const scope=manifest.noteScopes?.find(item=>item.objectId===object.id);
        for(const mutation of store.indexFragment({id:`pkg-note-${object.id}`,objectId:object.id,resourceId:scope ? scope.resourceId ?? undefined : anchor?.resource_id,kind:"note",text})) store.db.prepare(mutation.sql).run(...mutation.params ?? []);
      }
      // Publish durable files before the DB commit so committed rows never refer to missing copies.
      for(const attachment of manifest.attachments) {
        const target=path.join(store.attachmentsDir,attachment.id);
        fs.linkSync(path.join(staging,attachment.id),target);
        published.push(target);
      }
      const now=new Date().toISOString();
      store.db.prepare("INSERT INTO domain_events(event_id,type,payload_json,created_at) VALUES (?,?,?,?)").run(`package-${path.basename(staging)}`,"library.packageImported",JSON.stringify({objects:manifest.objects.length}),now);
      if(receipt) store.db.prepare("INSERT INTO operations(idempotency_key,command_id,result_json,committed_at) VALUES (?,?,?,?)").run(receipt.key,receipt.commandId,JSON.stringify({status:"ok",value:{format:manifest.format,attachments:manifest.attachments.length,objects:manifest.objects.length,works:manifest.works.length}}),now);
      store.db.exec("COMMIT");
      committed=true;
    } catch (error) {
      try { store.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
    return manifest;
  } catch (error) {
    throw error;
  } finally {
    if(!committed) for(const target of published) fs.unlinkSync(target);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
