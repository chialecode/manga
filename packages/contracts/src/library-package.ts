import { z } from "zod";
const maxAttachmentBytes = 128 * 1024 * 1024;
export const PackageAttachmentNameSchema = z.string().min(1).max(240).refine(name => !/[\\/:<>"|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && name !== "." && name !== ".." && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name), "unsafe attachment name");
const id = z.string().min(1).max(512);
const json = z.string().refine(value => { try { JSON.parse(value); return true; } catch { return false; } }, "invalid JSON payload");
const created = { created_at: z.string() };
const text = z.string().max(1_000_000);
const rows = {
  // M2 columns are optional so packages written by earlier stages still import.
  works: z.object({
    id, title:z.string(), ...created,
    media_kind: id.optional(), shelf_state: id.optional(), author: z.string().nullable().optional(), cover_id: id.nullable().optional(),
    cover_state: id.optional(), last_resource_id: id.nullable().optional(), last_opened_at: z.string().nullable().optional(),
    projection_json: json.optional(), updated_at: z.string().nullable().optional(),
  }),
  resources: z.object({
    id, work_id:id.nullable(), kind:id, title:z.string(), aliases_json:json, ...created,
    ordinal_label: z.string().nullable().optional(), ordinal_number: z.number().nullable().optional(), ordinal_type: z.string().nullable().optional(), sort_key: z.string().optional(),
  }),
  revisions: z.object({id, resource_id:id, fingerprint:id, parser_version:id, payload_json:json, ...created, layout_json: json.nullable().optional()}),
  objects: z.object({id, type:id, owner_module_id:id, scope_json:json, schema_version:z.number().int().positive(), revision:z.number().int().positive(), title:z.string(), payload_json:json, attachment_ids_json:json, preview_json:json, ...created, updated_at:z.string(), deleted_at:z.string().nullable(), /** Note tags. Optional so packages written before M1b rework still import. */ tags_json: json.optional(),
    /** The work a note belongs to (M2 rework). Optional so earlier packages still import. */ work_id: id.nullable().optional() }),
  objectRevisions: z.object({object_id:id, revision:z.number().int().positive(), payload_json:json, ...created}),
  anchors: z.object({id, resource_id:id, resource_revision_id:id, locator_json:json, preview_json:json.nullable(), ...created}),
  refs: z.object({id, from_object_id:id, from_block_id:id.nullable(), to_kind:id, to_id:id, mode:id, instance_layout_json:json.nullable(), ...created}),
  progress: z.object({resource_id:id, resource_revision_id:id, last_locator_json:json.nullable(), consumed_ranges_json:json, completion_state:id, last_interaction_at:z.string(), percent: z.number().optional()}),
  captures: z.object({
    id, clock_json:json, status:id, attachment_id:PackageAttachmentNameSchema.nullable(), ...created,
    mode: id.nullable().optional(), retention: id.optional(), audio_state: id.optional(), stage: id.optional(), duration_ms: z.number().int().nonnegative().optional(),
    stopped_at: z.string().nullable().optional(), staging_name: PackageAttachmentNameSchema.nullable().optional(), opus_name: PackageAttachmentNameSchema.nullable().optional(),
    device_label: z.string().nullable().optional(), work_id: id.nullable().optional(), vad_json: json.nullable().optional(), error_json: json.nullable().optional(), updated_at: z.string().nullable().optional(),
  }),
  metadataSnapshots: z.object({
    work_id:id, provider_id:id, external_id:id, snapshot_json:json,
    fetched_at: z.string().nullable().optional(), source_url: z.string().nullable().optional(), api_version: z.string().nullable().optional(), detached: z.number().int().optional(),
  }),
  metadataOverrides: z.object({work_id:id, fields_json:json, locked_json:json, cleared_json:json}),
  metadataCandidates: z.object({
    id, work_id:id.nullable(), provider_id:id, payload_json:json,
    external_id: z.string().nullable().optional(), search_id: z.string().nullable().optional(), state: id.optional(), created_at: z.string().nullable().optional(),
  }),
  workLinks: z.object({
    work_id:id, provider_id:id, external_id:id, snapshot_json:json, confirmed_at:z.string(),
    namespace: z.string().optional(), subject_type: z.number().int().nullable().optional(), link_state: id.optional(), match_basis: z.string().nullable().optional(),
  }),
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
  /**
   * Covers whose original is kept (downloaded or user-chosen). Extracted covers are rebuilt from the file. Until the M2 rework the
   * original was an attachment file (`area: "attachments"`); now it is a row of the images table and travels as an attachment named
   * `img-<hash>.bin` that import reads into the images table without publishing it as a file (`area: "images"`).
   */
  covers: z.array(z.object({
    id, work_id: id, source: id, provider_id: z.string().nullable(), external_id: z.string().nullable(), content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    media_type: id, width: z.number().int().nullable(), height: z.number().int().nullable(), bytes: z.number().int().nonnegative(), area: id,
    file_name: PackageAttachmentNameSchema, created_at: z.string(),
  }).strict()).max(250000).optional(),
  /**
   * Characters (with voice actors) and staff saved from a linked entry, with their small pictures. A picture travels as an attachment named
   * `img-<hash>.bin` and is read back into the images table on import.
   */
  characters: z.array(z.object({
    work_id: id, provider_id: id, subject_id: id, character_id: id, position: z.number().int().nonnegative(), name: z.string().max(512),
    relation: z.string().nullable(), summary: z.string().nullable(), actors_json: json, image: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), media_type: id, width: z.number().int().nullable(), height: z.number().int().nullable() }).strict().nullable().optional(),
    fetched_at: z.string(),
  }).strict()).max(250000).optional(),
  persons: z.array(z.object({
    work_id: id, provider_id: id, subject_id: id, person_id: id, position: z.number().int().nonnegative(), name: z.string().max(512),
    relation: z.string().nullable(), career_json: json, episodes: z.string().nullable(), image: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), media_type: id, width: z.number().int().nullable(), height: z.number().int().nullable() }).strict().nullable().optional(),
    fetched_at: z.string(),
  }).strict()).max(250000).optional(),
  captureEvents: z.array(z.object({
    session_id: id, offset_ms: z.number().int().nonnegative().nullable(), reason: z.string().nullable(), resource_id: z.string().nullable(),
    resource_revision_id: z.string().nullable(), payload_json: json,
  }).strict()).max(2_000_000).optional(),
  transcriptSegments: z.array(z.object({
    id, session_id: id, seq: z.number().int().nonnegative(), chunk_key: id, start_ms: z.number().int().nonnegative(), end_ms: z.number().int().nonnegative(),
    text: text, revised_text: text.nullable(), state: id, precision: id, calibrated: z.number().int(), anchors_json: json, attempts: z.number().int().nonnegative(),
    error_json: json.nullable(), created_at: z.string(), updated_at: z.string(),
  }).strict()).max(500000).optional(),
  captureDrafts: z.array(z.object({
    id, session_id: id, state: id, text: text, edited_text: text.nullable(), note_object_id: z.string().nullable(), error_json: json.nullable(),
    created_at: z.string(), updated_at: z.string(),
  }).strict()).max(250000).optional(),
  workTerms: z.array(z.object({ id, work_id: id, term: z.string().min(1).max(128), heard: z.string().max(128).nullable(), created_at: z.string() }).strict()).max(250000).optional(),
  mediaProbes: z.array(z.object({ resource_revision_id: id, probe_json: json, tool_version: z.string(), created_at: z.string() }).strict()).max(250000).optional(),
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
