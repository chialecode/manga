import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_SHELL_PREFERENCE, type ShellPreferenceV1 } from "@manga/contracts";
import { schemaSql } from "@manga/storage-drizzle";
import { makeLegacyProfile } from "./legacy-db.ts";

const at = (n: number) => `2026-09-0${n}T00:00:00.000Z`;

export type SeededV11 = { root: string; data: string; works: string; ids: Record<string, string> };

/**
 * A synthetic v11 library of the two-mode shell, for the migration to v12 (A-94, A-96) and for the packaged window to be started on: a book opened in both
 * modes, a work page in both modes, a comic that was closed from the left rail, two projects (one closed from the rail), one archived project, the current
 * conversation of each mode, positions in two resources and the work-mode layout. It is built from the DDL of the stages before; no real profile is read.
 * The library lies in `<root>/data` and the works folder is `<root>/works`; `root` is a new temporary folder unless one is given.
 */
export function seedV11(given?: string): SeededV11 {
  const { dir, ids } = makeLegacyProfile(10);
  const root = given ?? fs.mkdtempSync(path.join(os.tmpdir(), "manga-v12-profile-"));
  const data = path.join(root, "data");
  const works = path.join(root, "works");
  fs.mkdirSync(data, { recursive: true });
  for (const name of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, name), path.join(data, name));
  fs.rmSync(dir, { recursive: true, force: true });
  const db = new Database(path.join(data, "manga.sqlite"));
  db.exec(schemaSql.V11_SCHEMA_SQL);
  db.exec(schemaSql.V11_TABLES_SQL);
  // The mark of "closed from the left rail" that v11 kept in its own table.
  db.exec("CREATE TABLE IF NOT EXISTS closed_sessions (session_id TEXT PRIMARY KEY, closed_at TEXT NOT NULL)");
  db.prepare("UPDATE schema_meta SET value = '11' WHERE key = 'schemaVersion'").run();
  db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('workLayout', 'settled')").run();

  db.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)").run("rev-second", ids.second, "s".repeat(64), "p", "{}", at(2));
  const project = db.prepare("INSERT INTO projects(id, name, goal, status, created_at, updated_at) VALUES (?,?,?,?,?,?)");
  project.run("proj-a", "项目甲", "", "active", at(1), at(6));
  project.run("proj-b", "项目乙", "", "active", at(1), at(2));
  project.run("proj-c", "归档项目", "", "archived", at(1), at(9));
  db.prepare("INSERT INTO project_materials(id, project_id, kind, target_id, label, sort_order, added_at) VALUES (?,?,?,?,?,?,?)").run("pm-1", "proj-a", "work", ids.work, "", 0, at(1));

  const session = db.prepare("INSERT INTO agent_sessions(id, title, grant_handle, kind, target_id, mode, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  session.run("ses-ent-res", "书", "g", "resource", ids.resource, "enthusiast", null, at(1), at(5));
  session.run("ses-cre-res", "书（工作）", "g", "resource", ids.resource, "creator", null, at(1), at(3));
  session.run("ses-closed-res", "已关闭的漫画", "g", "resource", ids.second, "enthusiast", null, at(1), at(4));
  session.run("ses-work-cre", "作品页", "g", "work", ids.work, "creator", null, at(1), at(2));
  session.run("ses-work-ent", "作品页（娱乐）", "g", "work", ids.work, "enthusiast", null, at(1), at(1));
  session.run("ses-note", "笔记", "g", "note", "note-x", "enthusiast", null, at(1), at(1));
  session.run("ses-proj-a", "项目甲", "g", "project", "proj-a", "creator", "proj-a", at(1), at(6));
  session.run("ses-proj-b", "项目乙", "g", "project", "proj-b", "creator", "proj-b", at(1), at(2));
  session.run("ses-shared-ent", "对话 1", "g", "shared", null, "enthusiast", null, at(1), at(7));
  session.run("ses-shared-cre", "对话 2", "g", "shared", null, "creator", null, at(1), at(8));
  db.prepare("INSERT INTO closed_sessions(session_id, closed_at) VALUES (?, ?)").run("ses-closed-res", at(5));
  db.prepare("INSERT INTO closed_sessions(session_id, closed_at) VALUES (?, ?)").run("ses-proj-b", at(5));
  db.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run("run-1", "ses-cre-res", "succeeded", "g", "{}", "旧的提问", at(3), at(3));
  const meta = db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)");
  meta.run("conversation.current.enthusiast", "ses-shared-ent");
  meta.run("conversation.current.creator", "ses-shared-cre");
  meta.run("conversation.current.project.proj-a", "ses-proj-a");

  const locator = { kind: "text", partId: "body", representationId: ids.revision, normalizationVersion: "text-nfc-lf-v1", range: { start: 6, end: 14 }, quote: { exact: "旧库里的正文，用来" } };
  db.prepare("UPDATE progress SET last_locator_json = ? WHERE resource_id = ?").run(JSON.stringify(locator), ids.resource);
  db.prepare("INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent) VALUES (?,?,?,?,?,?,?)")
    .run(ids.second, "rev-second", null, "[]", "in_progress", at(4), 0.4);

  const old: ShellPreferenceV1 = {
    version: 1,
    mode: "creator",
    spoilerGuard: true,
    layouts: {
      enthusiast: { focus: false, left: { visible: true, width: 300 }, right: { visible: false, width: 500 } },
      creator: { focus: true, left: { visible: false, width: 224 }, right: { visible: true, width: 400 } },
    },
    reading: DEFAULT_SHELL_PREFERENCE.reading,
  };
  db.prepare("INSERT INTO config(key, revision, value_json) VALUES ('shell.layout', 3, ?)").run(JSON.stringify(old));
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return { root, data, works, ids };
}
