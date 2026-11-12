import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DrizzleStore } from "@manga/storage-drizzle";

export type SeededV15 = {
  dir: string;
  termIds: {
    manualGlobal: string;
    manualWork: string;
    autoCharacter: string;
    autoActor: string;
    autoWork: string;
    legacyOther: string;
  };
};

/**
 * Constructs an authentic schema-v15 SQLite database in `dir`:
 * - Opens a current store to lay down all base..v15 tables,
 * - Rebuilds `dictionary_terms` back to its exact 8-column v9..v15 shape (`id, scope, work_id, term, heard, source, created_at, updated_at`),
 * - Drops all v16 tables (`dictionary_aliases`, `dictionary_suggestions`, `dictation_history`, `bangumi_details`),
 * - Seeds works, notes, agent_requests, and 6 dictionary_terms covering manual + metadata sources and `heard` edge cases,
 * - Sets `schemaVersion = '15'`.
 */
export function seedV15(dir: string): SeededV15 {
  fs.mkdirSync(dir, { recursive: true });
  const bootstrap = new DrizzleStore({ profileDir: dir, hostId: "seed-v15-bootstrap" });
  bootstrap.close();

  for (const name of fs.readdirSync(dir)) {
    if (name.includes(".premigrate-")) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }

  const dbPath = path.join(dir, "manga.sqlite");
  const db = new Database(dbPath);
  const now = "2026-10-01T08:00:00.000Z";
  const termIds = {
    manualGlobal: "trm_manual_global",
    manualWork: "trm_manual_work",
    autoCharacter: "trm_auto_char",
    autoActor: "trm_auto_actor",
    autoWork: "trm_auto_work",
    legacyOther: "trm_legacy_other",
  };

  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;

      DROP TABLE IF EXISTS dictionary_aliases;
      DROP TABLE IF EXISTS dictionary_suggestions;
      DROP TABLE IF EXISTS dictation_history;
      DROP TABLE IF EXISTS bangumi_details;

      DROP INDEX IF EXISTS dictionary_terms_unique;
      DROP INDEX IF EXISTS dictionary_terms_work;
      DROP TABLE IF EXISTS dictionary_terms;

      CREATE TABLE dictionary_terms (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        work_id TEXT NOT NULL DEFAULT '',
        term TEXT NOT NULL,
        heard TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX dictionary_terms_unique ON dictionary_terms(scope, work_id, term);
      CREATE INDEX dictionary_terms_work ON dictionary_terms(work_id, scope);
    `);

    db.prepare(
      "INSERT INTO works(id, title, media_kind, shelf_state, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("work_astral", "星穹航路", "anime", "reading", now, now);
    db.prepare(
      "INSERT INTO works(id, title, media_kind, shelf_state, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("work_sea", "白昼海风", "novel", "completed", now, now);

    db.prepare(
      "INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, attachment_ids_json, preview_json, tags_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("note_v15", "notes.document", "manga.notes", "{}", 1, 1, "旧版笔记", '{"blocks":[{"id":"b1","type":"paragraph","text":"保留的正文"}]}', "[]", "{}", "[]", now, now);

    // Seed an `agent_requests` row so backup-stripping assertions verify both `agent_requests` and `dictation_history`
    db.prepare(
      "INSERT INTO agent_requests(id, run_id, step, kind, status, started_at) VALUES (?,?,?,?,?,?)",
    ).run("areq_v15", "run_1", 1, "model", "done", now);

    const insertTerm = db.prepare(
      "INSERT INTO dictionary_terms(id, scope, work_id, term, heard, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    insertTerm.run(termIds.manualGlobal, "global", "", "星穹航路", "新穷航路", "manual", now, now);
    insertTerm.run(termIds.manualWork, "work", "work_astral", "星野苍真", "  心野仓真  ", "manual", now, now);
    insertTerm.run(termIds.autoCharacter, "work", "work_astral", "雾岛千夏", null, "metadata:bangumi:character:501", now, now);
    insertTerm.run(termIds.autoActor, "work", "work_astral", "风间奏太", "   ", "metadata:bangumi:actor:601", now, now);
    insertTerm.run(termIds.autoWork, "work", "work_sea", "白昼海风", null, "metadata:bangumi:work:701", now, now);
    insertTerm.run(termIds.legacyOther, "global", "", "旧导入专名", "旧导入专明", "import:legacy", now, now);

    db.prepare("UPDATE schema_meta SET value = '15' WHERE key = 'schemaVersion'").run();
    db.pragma("foreign_keys = ON");
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }

  return { dir, termIds };
}
