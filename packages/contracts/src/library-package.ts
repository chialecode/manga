import { z } from "zod";
const maxAttachmentBytes = 128 * 1024 * 1024;
export const PackageAttachmentNameSchema = z.string().min(1).max(240).refine(name => !/[\\/:<>"|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && name !== "." && name !== ".." && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name), "unsafe attachment name");
const id = z.string().min(1).max(512);
const json = z.string().refine(value => { try { JSON.parse(value); return true; } catch { return false; } }, "invalid JSON payload");
const created = { created_at: z.string() };
const rows = {
  works: z.object({id, title:z.string(), ...created}),
  resources: z.object({id, work_id:id.nullable(), kind:id, title:z.string(), aliases_json:json, ...created}),
  revisions: z.object({id, resource_id:id, fingerprint:id, parser_version:id, payload_json:json, ...created}),
  objects: z.object({id, type:id, owner_module_id:id, scope_json:json, schema_version:z.number().int().positive(), revision:z.number().int().positive(), title:z.string(), payload_json:json, attachment_ids_json:json, preview_json:json, ...created, updated_at:z.string(), deleted_at:z.string().nullable(), /** Note tags. Optional so packages written before M1b rework still import. */ tags_json: json.optional() }),
  objectRevisions: z.object({object_id:id, revision:z.number().int().positive(), payload_json:json, ...created}),
  anchors: z.object({id, resource_id:id, resource_revision_id:id, locator_json:json, preview_json:json.nullable(), ...created}),
  refs: z.object({id, from_object_id:id, from_block_id:id.nullable(), to_kind:id, to_id:id, mode:id, instance_layout_json:json.nullable(), ...created}),
  progress: z.object({resource_id:id, resource_revision_id:id, last_locator_json:json.nullable(), consumed_ranges_json:json, completion_state:id, last_interaction_at:z.string()}),
  captures: z.object({id, clock_json:json, status:id, attachment_id:PackageAttachmentNameSchema, ...created}),
  metadataSnapshots: z.object({work_id:id, provider_id:id, external_id:id, snapshot_json:json}),
  metadataOverrides: z.object({work_id:id, fields_json:json, locked_json:json, cleared_json:json}),
  metadataCandidates: z.object({id, work_id:id.nullable(), provider_id:id, payload_json:json}),
  workLinks: z.object({work_id:id, provider_id:id, external_id:id, snapshot_json:json, confirmed_at:z.string()}),
};
export const LibraryPackageManifestSchema = z.object({
  format: z.literal("manga-library-package-v1"),
  createdAt: z.string(),
  works: z.array(rows.works.strict()).max(250000),
  resources: z.array(rows.resources.strict()).max(250000),
  revisions: z.array(rows.revisions.strict()).max(250000),
  objects: z.array(rows.objects.strict()).max(250000),
  objectRevisions: z.array(rows.objectRevisions.strict()).max(250000),
  anchors: z.array(rows.anchors.strict()).max(250000),
  refs: z.array(rows.refs.strict()).max(250000),
  progress: z.array(rows.progress.strict()).max(250000),
  captures: z.array(rows.captures.strict()).max(250000),
  metadataSnapshots: z.array(rows.metadataSnapshots.strict()).max(250000),
  metadataOverrides: z.array(rows.metadataOverrides.strict()).max(250000),
  metadataCandidates: z.array(rows.metadataCandidates.strict()).max(250000),
  workLinks: z.array(rows.workLinks.strict()).max(250000),
  noteScopes: z.array(z.object({ objectId: id, resourceId: id.nullable() }).strict()).max(250000).optional(),
  /** Reading bookmarks. Optional so packages written before M1b rework still import. */
  bookmarks: z.array(z.object({
    id,
    resource_id: id,
    resource_revision_id: id,
    label: z.string().max(160),
    locator_json: json,
    created_at: z.string(),
  }).strict()).max(250000).optional(),
  /** Host-specific file locations. Optional so packages written before M1b rework still import. */
  fileLocations: z.array(z.object({
    id,
    resource_revision_id: id,
    relative_path: z.string(),
    fingerprint: id,
    available: z.number().int(),
    hosted: z.number().int(),
  }).strict()).max(250000).optional(),
  /** Extracted page/illustration payloads; each row names an entry in `attachments`. */
  assets: z.array(z.object({
    id,
    resource_id: id,
    resource_revision_id: id,
    part_id: id,
    name: z.string(),
    media_type: id,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    attachment: PackageAttachmentNameSchema,
  }).strict()).max(8192).optional(),
  attachments: z.array(z.object({
    id: PackageAttachmentNameSchema,
    relativePath: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative().max(maxAttachmentBytes),
  }).strict()).max(4096),
}).strict();
export type LibraryPackageManifest = z.infer<typeof LibraryPackageManifestSchema>;

/** Per-row conflict decision for an import into a library that already holds data. */
export const PackageImportStrategySchema = z.enum(["skip", "replace", "duplicate"]);
export type PackageImportStrategy = z.infer<typeof PackageImportStrategySchema>;

export const PACKAGE_ROW_KINDS = ["work", "resource", "resource_revision", "object", "anchor", "ref", "progress", "capture", "bookmark"] as const;
export type PackageRowKind = (typeof PACKAGE_ROW_KINDS)[number];

export const PackageConflictSchema = z.object({
  kind: z.enum(PACKAGE_ROW_KINDS),
  id: z.string().min(1),
  label: z.string(),
  reason: z.string(),
}).strict();
export type PackageConflict = z.infer<typeof PackageConflictSchema>;

export const PackagePreviewSchema = z.object({
  format: z.literal("manga-library-package-v1"),
  createdAt: z.string(),
  counts: z.object({
    works: z.number().int().nonnegative(),
    resources: z.number().int().nonnegative(),
    revisions: z.number().int().nonnegative(),
    objects: z.number().int().nonnegative(),
    anchors: z.number().int().nonnegative(),
    refs: z.number().int().nonnegative(),
    progress: z.number().int().nonnegative(),
    attachments: z.number().int().nonnegative(),
  }).strict(),
  /** True when the target library holds no competing rows, so a plain import is lossless. */
  empty: z.boolean(),
  conflicts: z.array(PackageConflictSchema),
  missingAttachments: z.array(z.string()),
  orphanRefs: z.number().int().nonnegative(),
  defaultStrategy: z.enum(["skip", "replace", "duplicate"]),
}).strict();
export type PackagePreview = z.infer<typeof PackagePreviewSchema>;
