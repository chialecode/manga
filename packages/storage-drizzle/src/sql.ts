export const PRODUCT_SCHEMA_VERSION = 8;
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

/** Locator columns for full-text chunks. Added only here so v4 databases keep their original table and get an in-place upgrade. */
export const V5_SCHEMA_SQL = `
ALTER TABLE text_fragments ADD COLUMN resource_revision_id TEXT;
ALTER TABLE text_fragments ADD COLUMN part_id TEXT;
ALTER TABLE text_fragments ADD COLUMN start_offset INTEGER;
ALTER TABLE text_fragments ADD COLUMN end_offset INTEGER;
`;

/** M1b rework: note tags, reading bookmarks, extracted page/illustration assets and resource-bound agent sessions. */
export const V6_SCHEMA_SQL = `
ALTER TABLE content_objects ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE agent_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE agent_sessions ADD COLUMN target_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN mode TEXT;

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  label TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_assets (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  payload BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS resource_assets_part ON resource_assets(resource_revision_id, part_id);
CREATE INDEX IF NOT EXISTS bookmarks_resource ON bookmarks(resource_id);
`;

/**
 * M2: media kinds, series ordering, shelf state, covers, multi-source metadata, video probes and play
 * copies, and the recording pipeline. One migration for the whole stage; it only adds columns and tables,
 * so a v6 library keeps every row and every anchor.
 */
export const V7_SCHEMA_SQL = `
ALTER TABLE works ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'novel';
ALTER TABLE works ADD COLUMN shelf_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE works ADD COLUMN author TEXT;
ALTER TABLE works ADD COLUMN cover_id TEXT;
ALTER TABLE works ADD COLUMN cover_state TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE works ADD COLUMN last_resource_id TEXT;
ALTER TABLE works ADD COLUMN last_opened_at TEXT;
ALTER TABLE works ADD COLUMN projection_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE works ADD COLUMN updated_at TEXT;

ALTER TABLE resources ADD COLUMN ordinal_label TEXT;
ALTER TABLE resources ADD COLUMN ordinal_number REAL;
ALTER TABLE resources ADD COLUMN ordinal_type TEXT;
ALTER TABLE resources ADD COLUMN sort_key TEXT NOT NULL DEFAULT '';

ALTER TABLE resource_revisions ADD COLUMN layout_json TEXT;
ALTER TABLE progress ADD COLUMN percent REAL NOT NULL DEFAULT 0;

UPDATE works SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE works SET media_kind = COALESCE((SELECT r.kind FROM resources r WHERE r.work_id = works.id ORDER BY r.created_at, r.id LIMIT 1), 'novel')
  WHERE media_kind = 'novel';

CREATE INDEX IF NOT EXISTS works_created ON works(created_at, id);
CREATE INDEX IF NOT EXISTS works_opened ON works(last_opened_at);
CREATE INDEX IF NOT EXISTS works_media_shelf ON works(media_kind, shelf_state);
CREATE INDEX IF NOT EXISTS resources_work ON resources(work_id, sort_key);

CREATE TABLE IF NOT EXISTS covers (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  source TEXT NOT NULL,
  provider_id TEXT,
  external_id TEXT,
  content_hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes INTEGER NOT NULL,
  area TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (work_id, content_hash)
);
CREATE INDEX IF NOT EXISTS covers_work ON covers(work_id);

ALTER TABLE work_links ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE work_links ADD COLUMN subject_type INTEGER;
ALTER TABLE work_links ADD COLUMN link_state TEXT NOT NULL DEFAULT 'linked';
ALTER TABLE work_links ADD COLUMN match_basis TEXT;

ALTER TABLE metadata_snapshots ADD COLUMN fetched_at TEXT;
ALTER TABLE metadata_snapshots ADD COLUMN source_url TEXT;
ALTER TABLE metadata_snapshots ADD COLUMN api_version TEXT;
ALTER TABLE metadata_snapshots ADD COLUMN detached INTEGER NOT NULL DEFAULT 0;

ALTER TABLE metadata_candidates ADD COLUMN external_id TEXT;
ALTER TABLE metadata_candidates ADD COLUMN search_id TEXT;
ALTER TABLE metadata_candidates ADD COLUMN state TEXT NOT NULL DEFAULT 'open';
ALTER TABLE metadata_candidates ADD COLUMN created_at TEXT;
CREATE INDEX IF NOT EXISTS metadata_candidates_work ON metadata_candidates(work_id, provider_id);

CREATE TABLE IF NOT EXISTS media_probes (
  resource_revision_id TEXT PRIMARY KEY,
  probe_json TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS play_copies (
  id TEXT PRIMARY KEY,
  resource_revision_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL,
  audio_stream_index INTEGER,
  file_name TEXT,
  bytes INTEGER,
  encoder TEXT,
  tool_version TEXT,
  progress REAL NOT NULL DEFAULT 0,
  timestamp_check_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS play_copies_revision ON play_copies(resource_revision_id);

ALTER TABLE capture_sessions ADD COLUMN mode TEXT;
ALTER TABLE capture_sessions ADD COLUMN retention TEXT NOT NULL DEFAULT 'discard';
ALTER TABLE capture_sessions ADD COLUMN audio_state TEXT NOT NULL DEFAULT 'staged';
ALTER TABLE capture_sessions ADD COLUMN stage TEXT NOT NULL DEFAULT 'recording';
ALTER TABLE capture_sessions ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE capture_sessions ADD COLUMN stopped_at TEXT;
ALTER TABLE capture_sessions ADD COLUMN staging_name TEXT;
ALTER TABLE capture_sessions ADD COLUMN opus_name TEXT;
ALTER TABLE capture_sessions ADD COLUMN device_label TEXT;
ALTER TABLE capture_sessions ADD COLUMN work_id TEXT;
ALTER TABLE capture_sessions ADD COLUMN vad_json TEXT;
ALTER TABLE capture_sessions ADD COLUMN error_json TEXT;
ALTER TABLE capture_sessions ADD COLUMN updated_at TEXT;

ALTER TABLE capture_events ADD COLUMN offset_ms INTEGER;
ALTER TABLE capture_events ADD COLUMN reason TEXT;
ALTER TABLE capture_events ADD COLUMN resource_id TEXT;
ALTER TABLE capture_events ADD COLUMN resource_revision_id TEXT;
CREATE INDEX IF NOT EXISTS capture_events_session ON capture_events(session_id, offset_ms);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  chunk_key TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  revised_text TEXT,
  state TEXT NOT NULL,
  precision TEXT NOT NULL,
  calibrated INTEGER NOT NULL DEFAULT 0,
  anchors_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, chunk_key)
);
CREATE INDEX IF NOT EXISTS transcript_session ON transcript_segments(session_id, seq);

CREATE TABLE IF NOT EXISTS capture_drafts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  edited_text TEXT,
  note_object_id TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capture_drafts_session ON capture_drafts(session_id);

CREATE TABLE IF NOT EXISTS work_terms (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  term TEXT NOT NULL,
  heard TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (work_id, term)
);
`;

/**
 * M2 rework (A-47—A-52): library paths with a file register and scan jobs, an image table for authoritative pictures
 * (covers and avatars), characters and persons of a linked subject, quick tasks, the operation log, run usage fields and a
 * work association for notes. Only adds columns, tables and indexes; the cover files of a v7 library are imported into
 * the image table by the store after this DDL (see `DrizzleStore.importCoverFiles`), inside the same transaction.
 */
export const V8_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS library_paths (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  media_kind TEXT NOT NULL,
  auto_scan INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_scan_at TEXT,
  last_scan_json TEXT
);

CREATE TABLE IF NOT EXISTS library_files (
  path_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  fingerprint TEXT,
  resource_id TEXT,
  resource_revision_id TEXT,
  state TEXT NOT NULL DEFAULT 'present',
  seen_scan_id TEXT,
  error_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (path_id, relative_path)
);
CREATE INDEX IF NOT EXISTS library_files_resource ON library_files(resource_id);
CREATE INDEX IF NOT EXISTS library_files_fingerprint ON library_files(fingerprint);
-- A library of thousands of files asks for the latest revision of a resource and the file of a revision many times in a row; without
-- these each answer reads the whole table and a 5000-file scan stalls the main process for tens of seconds (found by the scale bench).
CREATE INDEX IF NOT EXISTS resource_revisions_resource ON resource_revisions(resource_id, created_at);
CREATE INDEX IF NOT EXISTS file_locations_revision ON file_locations(resource_revision_id);

CREATE TABLE IF NOT EXISTS scan_jobs (
  id TEXT PRIMARY KEY,
  path_id TEXT,
  trigger_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  current_item TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  unavailable INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS scan_jobs_started ON scan_jobs(started_at);

CREATE TABLE IF NOT EXISTS images (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes INTEGER NOT NULL,
  payload BLOB NOT NULL,
  source_url TEXT,
  fetched_at TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE covers ADD COLUMN image_hash TEXT;

CREATE TABLE IF NOT EXISTS subject_characters (
  work_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  relation TEXT,
  summary TEXT,
  actors_json TEXT NOT NULL DEFAULT '[]',
  image_hash TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (work_id, provider_id, subject_id, character_id)
);

CREATE TABLE IF NOT EXISTS subject_persons (
  work_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  relation TEXT,
  career_json TEXT NOT NULL DEFAULT '[]',
  episodes TEXT,
  image_hash TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (work_id, provider_id, subject_id, person_id)
);

CREATE TABLE IF NOT EXISTS quick_tasks (
  id TEXT PRIMARY KEY,
  builtin_key TEXT,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  pages_json TEXT NOT NULL,
  include_frame INTEGER NOT NULL DEFAULT 0,
  include_library INTEGER NOT NULL DEFAULT 0,
  send_mode TEXT NOT NULL DEFAULT 'send',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  run_id TEXT,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  object_kind TEXT,
  object_id TEXT,
  object_label TEXT,
  summary_key TEXT NOT NULL,
  summary_params_json TEXT NOT NULL DEFAULT '{}',
  outcome TEXT NOT NULL,
  error_code TEXT,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS operation_log_at ON operation_log(at);
CREATE INDEX IF NOT EXISTS operation_log_category ON operation_log(category, at);

ALTER TABLE agent_runs ADD COLUMN model_id TEXT;
ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE agent_runs ADD COLUMN duration_ms INTEGER;

ALTER TABLE content_objects ADD COLUMN work_id TEXT;
CREATE INDEX IF NOT EXISTS content_objects_work ON content_objects(work_id);
UPDATE content_objects SET work_id = (SELECT r.work_id FROM resources r WHERE r.id = json_extract(content_objects.scope_json, '$.resourceId'))
  WHERE type = 'notes.document' AND json_extract(scope_json, '$.resourceId') IS NOT NULL;
`;
