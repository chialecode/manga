export const PRODUCT_SCHEMA_VERSION = 4;
export const LEGACY_SCHEMA_VERSION = 1;

export const BASE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_requests (
  idempotency_key TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  input_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS write_host (
  profile_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  work_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_revisions (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_locations (
  id TEXT PRIMARY KEY,
  resource_revision_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  hosted INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS content_objects (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  owner_module_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attachment_ids_json TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS object_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(object_id, revision)
);

CREATE TABLE IF NOT EXISTS anchors (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  preview_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refs (
  id TEXT PRIMARY KEY,
  from_object_id TEXT NOT NULL,
  from_block_id TEXT,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  instance_layout_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  resource_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  last_locator_json TEXT,
  consumed_ranges_json TEXT NOT NULL,
  completion_state TEXT NOT NULL,
  last_interaction_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, resource_revision_id)
);

CREATE TABLE IF NOT EXISTS operations (
  idempotency_key TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  committed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT,
  epoch INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  checkpoint_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  staging_path TEXT,
  target_path TEXT,
  bytes INTEGER,
  fingerprint TEXT,
  etag TEXT,
  publish_state TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_receipts (
  idempotency_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata_snapshots (
  work_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (work_id, provider_id)
);

CREATE TABLE IF NOT EXISTS metadata_overrides (
  work_id TEXT PRIMARY KEY,
  fields_json TEXT NOT NULL,
  locked_json TEXT NOT NULL,
  cleared_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata_candidates (
  id TEXT PRIMARY KEY,
  work_id TEXT,
  provider_id TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS text_fragments (
  id TEXT PRIMARY KEY,
  resource_id TEXT,
  object_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  ngrams TEXT NOT NULL,
  locator_json TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5(
  fragment_id UNINDEXED,
  kind UNINDEXED,
  resource_id UNINDEXED,
  text,
  ngrams,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capture_sessions (
  id TEXT PRIMARY KEY,
  clock_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attachment_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capture_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_links (
  work_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (work_id, provider_id, external_id)
);
`;

export const V2_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS grants (
  handle TEXT PRIMARY KEY,
  actor_json TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  allowed_commands_json TEXT NOT NULL,
  access TEXT NOT NULL,
  read_resource_ids_json TEXT NOT NULL,
  write_resource_ids_json TEXT NOT NULL,
  write_object_ids_json TEXT NOT NULL,
  allow_create_objects INTEGER NOT NULL,
  path_handles_json TEXT NOT NULL,
  module_epoch INTEGER NOT NULL,
  binding_epoch INTEGER NOT NULL,
  registry_generation INTEGER NOT NULL,
  revoked INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS path_handles (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  resolved_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  credential_ref TEXT,
  timeout_ms INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  model_id TEXT NOT NULL,
  verified_capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  ref TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  grant_handle TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  grant_handle TEXT NOT NULL,
  snapshot_id TEXT,
  budget_json TEXT NOT NULL,
  input_text TEXT NOT NULL,
  error_json TEXT,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tool_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  result_summary TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  staging_path TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const V3_SCHEMA_SQL = `
ALTER TABLE command_requests ADD COLUMN actor_kind TEXT;
ALTER TABLE command_requests ADD COLUMN actor_id TEXT;
ALTER TABLE command_requests ADD COLUMN grant_handle TEXT;
ALTER TABLE command_requests ADD COLUMN session_id TEXT;
ALTER TABLE command_requests ADD COLUMN run_id TEXT;
ALTER TABLE command_requests ADD COLUMN registry_generation INTEGER;
ALTER TABLE command_requests ADD COLUMN grant_fingerprint TEXT;

ALTER TABLE provider_connections ADD COLUMN runtime TEXT NOT NULL DEFAULT 'native';

ALTER TABLE agent_runs ADD COLUMN read_resource_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_runs ADD COLUMN snapshot_json TEXT;
ALTER TABLE agent_runs ADD COLUMN runtime TEXT NOT NULL DEFAULT 'native';

ALTER TABLE agent_messages ADD COLUMN payload_json TEXT;

CREATE TABLE IF NOT EXISTS migration_owned_files (
  job_id TEXT NOT NULL,
  partition TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  state TEXT NOT NULL,
  fingerprint TEXT,
  PRIMARY KEY (job_id, partition, relative_path)
);

CREATE TABLE IF NOT EXISTS indexed_roots (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  hosted INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

export const V4_SCHEMA_SQL = `
ALTER TABLE agent_runs ADD COLUMN deadline_at TEXT;
ALTER TABLE agent_runs ADD COLUMN live_text TEXT;
ALTER TABLE agent_runs ADD COLUMN checkpoint_json TEXT;

CREATE TABLE IF NOT EXISTS partition_stats (
  name TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT
);
`;
