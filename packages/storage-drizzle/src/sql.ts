export const PRODUCT_SCHEMA_VERSION = 11;
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

/** Schema v6: note tags, reading bookmarks, extracted page/illustration assets and resource-bound agent sessions. */
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
 * Schema v7: media kinds, series ordering, shelf state, covers, multi-source metadata, video probes and play
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
 * Schema v8: library paths with a file register and scan jobs, an image table for authoritative pictures
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

/**
 * Schema v9: projects with their materials and terms, the voice dictionary (global and per work), and a project on a session. The
 * creative workspace's own tables follow in `V9_CREATIVE_SQL`; a v8 profile gets all of them in one migration. `work_terms` is kept for the old
 * commands' compatibility and its rows become manual dictionary terms.
 */
export const V9_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  model_connection_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_materials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  UNIQUE (project_id, kind, target_id)
);
CREATE INDEX IF NOT EXISTS project_materials_project ON project_materials(project_id, sort_order);

CREATE TABLE IF NOT EXISTS project_terms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  term TEXT NOT NULL,
  heard TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, term)
);

ALTER TABLE agent_sessions ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS agent_sessions_project ON agent_sessions(project_id);

CREATE TABLE IF NOT EXISTS dictionary_terms (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  work_id TEXT NOT NULL DEFAULT '',
  term TEXT NOT NULL,
  heard TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, work_id, term)
);
CREATE INDEX IF NOT EXISTS dictionary_terms_work ON dictionary_terms(work_id);
INSERT OR IGNORE INTO dictionary_terms(id, scope, work_id, term, heard, source, created_at, updated_at)
  SELECT id, 'work', work_id, term, heard, 'manual', created_at, created_at FROM work_terms;
`;

/**
 * The creative workspace's own tables (boards, maps, embeds, drafts, excerpts, search index, cuts, plugins, acquisition). Every statement is idempotent and
 * the whole block runs at each start, so a profile that was migrated by an earlier build of the same schema version gets the tables added later.
 */
export const V9_CREATIVE_SQL = `
-- What a project package said about personal material the project points at and this profile did not have (project package): kept so the
-- reference stays readable while it shows as missing.
CREATE TABLE IF NOT EXISTS project_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  UNIQUE (project_id, kind, target_id)
);

-- Plugin packages (PLUG-04): the keys the person chose to trust, what is installed, the versions kept for going back, and what an uninstalled plugin left.
CREATE TABLE IF NOT EXISTS plugin_keys (
  key_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  label TEXT NOT NULL,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  previous_version TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  granted_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_versions (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  key_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version)
);
CREATE TABLE IF NOT EXISTS plugin_leftovers (
  plugin_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  uninstalled_at TEXT NOT NULL
);

-- Acquisition (ACQ-01—03): a job that fetches something through an engine plugin, and one row per file the torrent holds. The source (a magnet link can
-- carry tracker keys) stays in this table and is never shown, logged or sent anywhere but to the engine.
CREATE TABLE IF NOT EXISTS acquisition_jobs (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  resume_format TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  info_hash TEXT,
  name TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  paused_from TEXT,
  paused_reason TEXT,
  stage TEXT,
  error_json TEXT,
  path_id TEXT NOT NULL,
  subdir TEXT NOT NULL DEFAULT '',
  budget_json TEXT NOT NULL DEFAULT '{}',
  total_bytes INTEGER NOT NULL DEFAULT 0,
  selected_bytes INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  uploaded_bytes INTEGER NOT NULL DEFAULT 0,
  seeding INTEGER NOT NULL DEFAULT 0,
  seed_ratio REAL NOT NULL DEFAULT 0,
  seed_up_kbps INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS acquisition_jobs_state ON acquisition_jobs(state);
CREATE INDEX IF NOT EXISTS acquisition_jobs_hash ON acquisition_jobs(info_hash);
CREATE TABLE IF NOT EXISTS acquisition_entries (
  job_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  path TEXT NOT NULL,
  length INTEGER NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT,
  publish_state TEXT NOT NULL DEFAULT 'none',
  target_rel TEXT,
  import_state TEXT NOT NULL DEFAULT 'pending',
  resource_id TEXT,
  revision_id TEXT,
  note TEXT,
  PRIMARY KEY (job_id, idx)
);

-- Whiteboards (CRE-02): the layout is rows, so a move writes one node, and the undo stack is a list of operations, never a snapshot of the board.
CREATE TABLE IF NOT EXISTS whiteboards (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  viewport_json TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS whiteboards_project ON whiteboards(project_id);
CREATE TABLE IF NOT EXISTS whiteboard_nodes (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL,
  h REAL NOT NULL,
  z INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS whiteboard_nodes_board ON whiteboard_nodes(board_id);
CREATE TABLE IF NOT EXISTS whiteboard_edges (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS whiteboard_edges_board ON whiteboard_edges(board_id);

-- Mind maps (CRE-03): one root, a stable id per node, a sort key between siblings; a reference is an attachment, never a child.
CREATE TABLE IF NOT EXISTS mindmaps (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'pink',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mindmaps_project ON mindmaps(project_id);
CREATE TABLE IF NOT EXISTS mindmap_nodes (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL,
  parent_id TEXT,
  sort_key TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  collapsed INTEGER NOT NULL DEFAULT 0,
  refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mindmap_nodes_map ON mindmap_nodes(map_id, parent_id, sort_key);

-- The operations behind undo and redo of a board, a map or a rough cut: what was done and what undoes it.
CREATE TABLE IF NOT EXISTS creative_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_kind TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  at TEXT NOT NULL,
  label TEXT NOT NULL,
  forward_json TEXT NOT NULL,
  inverse_json TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS creative_ops_doc ON creative_ops(doc_kind, doc_id, id);

-- Embeds (CRE-04): one relation for every object that can sit inside another, live or as a fixed snapshot.
CREATE TABLE IF NOT EXISTS embeds (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT '',
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  locator_json TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'live',
  snapshot_json TEXT,
  snapshot_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_kind, source_id, slot)
);
CREATE INDEX IF NOT EXISTS embeds_target ON embeds(target_kind, target_id);

-- Drafts and their suggestions (CRE-05): text with a version history; a suggestion is kept apart from the draft until the user takes it.
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_project ON drafts(project_id);
CREATE TABLE IF NOT EXISTS draft_versions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (draft_id, version)
);
CREATE TABLE IF NOT EXISTS draft_suggestions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  instruction TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  base_version INTEGER NOT NULL,
  base_text TEXT NOT NULL,
  result_text TEXT NOT NULL DEFAULT '',
  sources_json TEXT NOT NULL DEFAULT '[]',
  model_json TEXT,
  adopted_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS draft_suggestions_draft ON draft_suggestions(draft_id, created_at);

-- Research (CRE-06): a page fetched from a given address is kept by version; an excerpt points into one version of it.
CREATE TABLE IF NOT EXISTS excerpt_pages (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  body_text TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  previous_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS excerpt_pages_url ON excerpt_pages(url, version);
CREATE TABLE IF NOT EXISTS excerpts (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  page_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS excerpts_project ON excerpts(project_id);
-- What is searched in pages and excerpts: a page as windows of its text (so a hit says where), an excerpt as one entry. Kept apart from the
-- library's own index, so a hit here can never be mistaken for a resource of the library.
CREATE VIRTUAL TABLE IF NOT EXISTS research_idx USING fts5(
  ref_kind UNINDEXED,
  ref_id UNINDEXED,
  start_offset UNINDEXED,
  text,
  ngrams,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Rough cuts (CLIP-01/02): a sequence of clips, each pointing at a revision of a video; an export keeps what was planned and what was cut.
CREATE TABLE IF NOT EXISTS rough_cuts (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rough_cuts_project ON rough_cuts(project_id);
CREATE TABLE IF NOT EXISTS rough_cut_clips (
  id TEXT PRIMARY KEY,
  cut_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  in_ms INTEGER NOT NULL,
  out_ms INTEGER NOT NULL,
  sort_key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rough_cut_clips_cut ON rough_cut_clips(cut_id, sort_key);
CREATE TABLE IF NOT EXISTS rough_cut_exports (
  id TEXT PRIMARY KEY,
  cut_id TEXT NOT NULL,
  state TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  result_json TEXT,
  tmp_name TEXT,
  final_name TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Semantic search (SEARCH-02): one version per model, vector length and way of cutting the text. A version's vectors live in a table of their
-- own (a vec0 table, or the blob column of the chunk rows when the extension cannot be loaded), so vectors of different models never meet.
CREATE TABLE IF NOT EXISTS index_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER,
  segmentation TEXT NOT NULL,
  engine TEXT NOT NULL,
  status TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT
);
CREATE TABLE IF NOT EXISTS semantic_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  start_cp INTEGER NOT NULL,
  end_cp INTEGER NOT NULL,
  vector BLOB,
  UNIQUE (version_id, source_kind, source_id, seq)
);
CREATE INDEX IF NOT EXISTS semantic_chunks_source ON semantic_chunks(source_kind, source_id);
-- A conversation closed from the left rail (A-74): only removed from the list. The session, its runs and the place in the file are untouched,
-- and opening the same target again takes it back.
CREATE TABLE IF NOT EXISTS closed_sessions (
  session_id TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL
);
-- The works that share one online entry are the versions of a title (A-68); the lookup is by entry, not by work.
CREATE INDEX IF NOT EXISTS work_links_external ON work_links(provider_id, external_id);
`;

/**
 * Schema v10: a resource's file is a library path plus a path inside it (A-80), the files a user makes for a work live in a folder of the work
 * (A-79), screenshots, danmaku, the model profile of a connection and the call trace of the agent. One migration for the whole change; the
 * statements that cannot run twice are here, the tables that can are in `V10_TABLES_SQL` (run at every start like the creative tables).
 */
export const V10_SCHEMA_SQL = `
ALTER TABLE library_paths ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
-- relative_path is relative to the library path, with / separators. A row with no library_path_id is outside the library: it keeps the
-- path it had in legacy_path only to tell the user where to look, and its resource cannot be opened.
ALTER TABLE file_locations ADD COLUMN library_path_id TEXT;
ALTER TABLE file_locations ADD COLUMN legacy_path TEXT;
CREATE INDEX IF NOT EXISTS file_locations_library ON file_locations(library_path_id, relative_path);
ALTER TABLE capture_sessions ADD COLUMN audio_file_id TEXT;
ALTER TABLE provider_connections ADD COLUMN profile_json TEXT;
ALTER TABLE provider_connections ADD COLUMN last_test_json TEXT;
`;

export const V10_TABLES_SQL = `
-- Files copied or moved between places by a migration or a folder change, so a stop in the middle can be finished at the next start.
CREATE TABLE IF NOT EXISTS file_moves (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);

-- One folder per title and medium: the works linked to one online entry share it, every other work has its own (A-68, A-79).
CREATE TABLE IF NOT EXISTS work_folders (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  rel_dir TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_kind, owner_id, media_kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS work_folders_dir ON work_folders(rel_dir);
CREATE TABLE IF NOT EXISTS work_files (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  resource_id TEXT,
  kind TEXT NOT NULL,
  sub_dir TEXT NOT NULL,
  file_name TEXT NOT NULL,
  ref_kind TEXT,
  ref_id TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (folder_id, sub_dir, file_name)
);
CREATE INDEX IF NOT EXISTS work_files_work ON work_files(work_id, kind);
CREATE INDEX IF NOT EXISTS work_files_ref ON work_files(ref_kind, ref_id);

CREATE TABLE IF NOT EXISTS screenshots (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  file_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  position_ms INTEGER,
  frame INTEGER,
  page_id TEXT,
  page_label TEXT,
  spread INTEGER,
  region_json TEXT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  format TEXT NOT NULL,
  subtitle_text TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS screenshots_resource ON screenshots(resource_id, captured_at);

-- Which danmaku belong to a file's episode, kept per resource revision so the choice can be changed (A-81).
CREATE TABLE IF NOT EXISTS danmaku_matches (
  resource_revision_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  anime_id INTEGER,
  episode_id INTEGER NOT NULL,
  anime_title TEXT NOT NULL DEFAULT '',
  episode_title TEXT NOT NULL DEFAULT '',
  offset_ms INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  matched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS danmaku_cache (
  source TEXT NOT NULL,
  episode_id INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  count INTEGER NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY (source, episode_id)
);
-- Whether the file's name, fingerprint, size and length may be sent to match a work that is not linked to an online entry (Q-28), per work.
CREATE TABLE IF NOT EXISTS danmaku_consent (
  work_id TEXT PRIMARY KEY,
  allowed INTEGER NOT NULL,
  decided_at TEXT NOT NULL
);

-- The trace of the agent (A-83): one row per model request, tool call and context compaction, with what was sent and what came back.
CREATE TABLE IF NOT EXISTS agent_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  first_token_at TEXT,
  ended_at TEXT,
  connection_id TEXT,
  model_id TEXT,
  protocol TEXT,
  request_z BLOB,
  response_z BLOB,
  request_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS agent_requests_run ON agent_requests(run_id, step, started_at);
CREATE INDEX IF NOT EXISTS agent_requests_started ON agent_requests(started_at);
`;

/**
 * Schema v11 (A-87, A-88). A resource may belong to no work (its entry was deleted), so the files and screenshots made from it may name no work
 * either; the title a deleted work had is kept for what was written on the work itself. A v10 profile was already in use, so v10's definitions
 * stay as they were and this is a second migration: tables are rebuilt (SQLite cannot drop NOT NULL), and nothing that holds a file is touched.
 * The files themselves are moved by the work-folder settle that runs after the start, not in this transaction.
 */
export const V11_SCHEMA_SQL = `
ALTER TABLE resources ADD COLUMN left_work_at TEXT;

CREATE TABLE work_files_v11 (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  work_id TEXT,
  resource_id TEXT,
  kind TEXT NOT NULL,
  sub_dir TEXT NOT NULL,
  file_name TEXT NOT NULL,
  ref_kind TEXT,
  ref_id TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (folder_id, sub_dir, file_name)
);
INSERT INTO work_files_v11(id, folder_id, work_id, resource_id, kind, sub_dir, file_name, ref_kind, ref_id, bytes, created_at)
  SELECT id, folder_id, work_id, resource_id, kind, sub_dir, file_name, ref_kind, ref_id, bytes, created_at FROM work_files;
DROP TABLE work_files;
ALTER TABLE work_files_v11 RENAME TO work_files;
CREATE INDEX IF NOT EXISTS work_files_work ON work_files(work_id, kind);
CREATE INDEX IF NOT EXISTS work_files_ref ON work_files(ref_kind, ref_id);
CREATE INDEX IF NOT EXISTS work_files_resource ON work_files(resource_id);

CREATE TABLE screenshots_v11 (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  file_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_revision_id TEXT NOT NULL,
  work_id TEXT,
  media_kind TEXT NOT NULL,
  position_ms INTEGER,
  frame INTEGER,
  page_id TEXT,
  page_label TEXT,
  spread INTEGER,
  region_json TEXT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  format TEXT NOT NULL,
  subtitle_text TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL
);
INSERT INTO screenshots_v11(id, title, file_id, resource_id, resource_revision_id, work_id, media_kind, position_ms, frame, page_id, page_label, spread, region_json, width, height, format, subtitle_text, meta_json, captured_at)
  SELECT id, title, file_id, resource_id, resource_revision_id, work_id, media_kind, position_ms, frame, page_id, page_label, spread, region_json, width, height, format, subtitle_text, meta_json, captured_at FROM screenshots;
DROP TABLE screenshots;
ALTER TABLE screenshots_v11 RENAME TO screenshots;
CREATE INDEX IF NOT EXISTS screenshots_resource ON screenshots(resource_id, captured_at);
`;

/** The same on every start: what a v11 library adds that cannot be rebuilt by the statements above. */
export const V11_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS removed_works (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  removed_at TEXT NOT NULL
);
`;
