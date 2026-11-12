import { blob, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export const dictionaryTerms = sqliteTable("dictionary_terms", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  workId: text("work_id").notNull(),
  term: text("term").notNull(),
  heard: text("heard"),
  source: text("source").notNull(),
  category: text("category").notNull(),
  disabled: integer("disabled").notNull(),
  blockedJson: text("blocked_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const dictionaryAliases = sqliteTable("dictionary_aliases", {
  id: text("id").primaryKey(),
  termId: text("term_id").notNull(),
  alias: text("alias").notNull(),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  createdAt: text("created_at").notNull(),
});

export const dictionarySuggestions = sqliteTable("dictionary_suggestions", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  workId: text("work_id"),
  term: text("term").notNull(),
  heard: text("heard").notNull(),
  score: real("score").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const dictationHistory = sqliteTable("dictation_history", {
  id: text("id").primaryKey(),
  workId: text("work_id"),
  engineKind: text("engine_kind").notNull(),
  engineId: text("engine_id").notNull(),
  modelId: text("model_id").notNull(),
  polishMode: text("polish_mode").notNull(),
  rawText: text("raw_text").notNull(),
  correctedText: text("corrected_text").notNull(),
  finalText: text("final_text").notNull(),
  fallbackReason: text("fallback_reason"),
  timingsJson: text("timings_json").notNull(),
  replacementsJson: text("replacements_json").notNull(),
  audioRelPath: text("audio_rel_path"),
  audioExpiresAt: text("audio_expires_at"),
  createdAt: text("created_at").notNull(),
});

export const bangumiDetails = sqliteTable("bangumi_details", {
  kind: text("kind").notNull(),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  infoboxJson: text("infobox_json"),
  payloadJson: text("payload_json").notNull(),
  fetchedAt: text("fetched_at").notNull(),
});
