import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const commandRequests = sqliteTable("command_requests", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  commandId: text("command_id").notNull(),
  resultJson: text("result_json").notNull(),
  committedAt: text("committed_at").notNull(),
});

export const events = sqliteTable("events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const works = sqliteTable("works", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
});

export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(),
  workId: text("work_id"),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  aliasesJson: text("aliases_json").notNull(),
  createdAt: text("created_at").notNull(),
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

export const recentDismissals = sqliteTable("recent_dismissals", {
  key: text("key").primaryKey(),
  dismissedAt: text("dismissed_at").notNull(),
});
