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
  objects: z.object({id, type:id, owner_module_id:id, scope_json:json, schema_version:z.number().int().positive(), revision:z.number().int().positive(), title:z.string(), payload_json:json, attachment_ids_json:json, preview_json:json, ...created, updated_at:z.string(), deleted_at:z.string().nullable()}),
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
  format:z.literal("manga-library-package-v1"),createdAt:z.string(),
  ...Object.fromEntries(Object.entries(rows).map(([key,row]) => [key,z.array(row.strict()).max(250000)])),
  // Optional for reading older v1 packages; new exports preserve note search scope.
  noteScopes:z.array(z.object({objectId:id,resourceId:id.nullable()}).strict()).max(250000).optional(),
  attachments:z.array(z.object({id:PackageAttachmentNameSchema,relativePath:z.string(),hash:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative().max(maxAttachmentBytes)}).strict()).max(4096),
}).strict();
