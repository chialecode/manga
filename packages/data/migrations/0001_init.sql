-- Initial Phase 1 schema. Rollback: drop tables in reverse dependency order.
CREATE TABLE library_root (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE file (
  id INTEGER PRIMARY KEY,
  root_id INTEGER NOT NULL REFERENCES library_root(id) ON DELETE RESTRICT,
  rel_path TEXT NOT NULL,
  quick_fp TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  modified_at INTEGER NOT NULL,
  UNIQUE (root_id, rel_path)
);
CREATE INDEX file_quick_fp_idx ON file(quick_fp);
CREATE INDEX file_root_rel_path_idx ON file(root_id, rel_path);

CREATE TABLE file_path_history (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE TABLE archive_entry (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  entry_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  UNIQUE (file_id, entry_path)
);

CREATE TABLE task (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX task_state_lease_idx ON task(state, lease_until);
