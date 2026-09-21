import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core";

export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(),
  workId: text("work_id"),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  aliasesJson: text("aliases_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const contentObjects = sqliteTable("content_objects", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  ownerModuleId: text("owner_module_id").notNull(),
  scopeJson: text("scope_json").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  revision: integer("revision").notNull(),
  title: text("title").notNull(),
  payloadJson: text("payload_json").notNull(),
  attachmentIdsJson: text("attachment_ids_json").notNull(),
  previewJson: text("preview_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
});

export const grants = sqliteTable("grants", {
  handle: text("handle").primaryKey(),
  actorJson: text("actor_json").notNull(),
  sessionId: text("session_id"),
  runId: text("run_id"),
  allowedCommandsJson: text("allowed_commands_json").notNull(),
  access: text("access").notNull(),
  readResourceIdsJson: text("read_resource_ids_json").notNull(),
  writeResourceIdsJson: text("write_resource_ids_json").notNull(),
  writeObjectIdsJson: text("write_object_ids_json").notNull(),
  allowCreateObjects: integer("allow_create_objects").notNull(),
  pathHandlesJson: text("path_handles_json").notNull(),
  moduleEpoch: integer("module_epoch").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  registryGeneration: integer("registry_generation").notNull(),
  revoked: integer("revoked").notNull(),
  createdAt: text("created_at").notNull(),
});

export const credentials = sqliteTable("credentials", {
  ref: text("ref").primaryKey(),
  ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
  createdAt: text("created_at").notNull(),
});
