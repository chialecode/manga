import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_SCHEMA_VERSION, MangaError } from "@manga/contracts";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";
import { exportLibraryPackage, importLibraryPackage } from "../../packages/app-core/src/domain/library-package.ts";
import { startApp } from "../helpers/app.ts";
import { testTempRoot } from "../helpers/global-temp.ts";
import { seedV15 } from "../helpers/legacy-v15.ts";

const trackedDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(testTempRoot(), `v16-${prefix}-`));
  trackedDirs.push(dir);
  return dir;
}

function crashChild(dir: string, crashAt: string) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({ profileDir: process.env.MANGA_MIGRATION_TEST_DIR, hostId: 'crash-v16', crashAt: '${crashAt}' });`,
    ],
    {
      env: { ...process.env, MANGA_MIGRATION_TEST_DIR: dir },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    },
  );
}

const columnsOf = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

const tablesOf = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );

afterEach(() => {
  while (trackedDirs.length > 0) {
    fs.rmSync(trackedDirs.pop()!, { recursive: true, force: true });
  }
});

describe("schema v16 migration & dictation backup/export isolation (X1 + H1, AT-180, AT-182)", () => {
  it("synchronizes PRODUCT_SCHEMA_VERSION and BUILD_SCHEMA_VERSION at 16", () => {
    expect(PRODUCT_SCHEMA_VERSION).toBe(16);
    expect(BUILD_SCHEMA_VERSION).toBe(16);
  });

  it("backs up v15 (stripping agent_requests), backfills dictionary categories & heard aliases without losing a row, and is idempotent", () => {
    const dir = tempDir("v16-migrate");
    const { termIds } = seedV15(dir);

    const store = new DrizzleStore({ profileDir: dir, hostId: "open-v16" });
    try {
      expect(store.migration).toMatchObject({ from: 15, to: 16 });
      expect(store.getMeta("schemaVersion")).toBe("16");

      // Backup exists, remains untouched v15, and stripped `agent_requests`
      const backupPath = path.join(dir, "manga.sqlite.premigrate-v15");
      expect(fs.existsSync(backupPath)).toBe(true);
      const backup = new Database(backupPath, { readonly: true });
      try {
        expect((backup.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("15");
        expect(columnsOf(backup, "dictionary_terms")).toEqual([
          "id", "scope", "work_id", "term", "heard", "source", "created_at", "updated_at",
        ]);
        expect(tablesOf(backup)).not.toContain("dictionary_aliases");
        expect(backup.prepare("SELECT COUNT(*) AS n FROM agent_requests").get()).toEqual({ n: 0 });
      } finally {
        backup.close();
      }

      // v16 tables and columns exist
      expect(tablesOf(store.sqlite)).toEqual(
        expect.arrayContaining([
          "dictionary_aliases",
          "dictionary_suggestions",
          "dictation_history",
          "bangumi_details",
        ]),
      );
      expect(columnsOf(store.sqlite, "dictionary_terms")).toEqual(
        expect.arrayContaining(["category", "disabled", "blocked_json", "heard"]),
      );

      // Zero lost rows, manual priority preserved, categories accurately derived from `source`
      const terms = store.sqlite
        .prepare("SELECT id, term, heard, source, category, disabled, blocked_json FROM dictionary_terms ORDER BY id")
        .all() as Array<{
        id: string;
        term: string;
        heard: string | null;
        source: string;
        category: string;
        disabled: number;
        blocked_json: string;
      }>;
      expect(terms).toHaveLength(6);
      const byId = new Map(terms.map((t) => [t.id, t]));
      expect(byId.get(termIds.manualGlobal)).toMatchObject({
        term: "星穹航路",
        source: "manual",
        category: "term",
        disabled: 0,
        blocked_json: "[]",
      });
      expect(byId.get(termIds.manualWork)).toMatchObject({
        term: "星野苍真",
        source: "manual",
        category: "term",
        disabled: 0,
      });
      expect(byId.get(termIds.autoCharacter)).toMatchObject({
        term: "雾岛千夏",
        source: "metadata:bangumi:character:501",
        category: "character",
      });
      expect(byId.get(termIds.autoActor)).toMatchObject({
        term: "风间奏太",
        source: "metadata:bangumi:actor:601",
        category: "actor",
      });
      expect(byId.get(termIds.autoWork)).toMatchObject({
        term: "白昼海风",
        source: "metadata:bangumi:work:701",
        category: "work",
      });
      expect(byId.get(termIds.legacyOther)).toMatchObject({
        term: "旧导入专名",
        source: "import:legacy",
        category: "other",
      });

      // Non-empty `heard` values were migrated to `dictionary_aliases(kind='heard')` (trimmed; blank `heard` ignored)
      const aliases = store.sqlite
        .prepare("SELECT term_id, alias, kind, source FROM dictionary_aliases ORDER BY term_id")
        .all();
      expect(aliases).toEqual([
        { term_id: termIds.legacyOther, alias: "旧导入专明", kind: "heard", source: "import:legacy" },
        { term_id: termIds.manualGlobal, alias: "新穷航路", kind: "heard", source: "manual" },
        { term_id: termIds.manualWork, alias: "心野仓真", kind: "heard", source: "manual" },
      ]);

      expect(store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(store.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
    }

    // Second open is a no-op
    const reopened = new DrizzleStore({ profileDir: dir, hostId: "reopen-v16" });
    try {
      expect(reopened.migration).toBeNull();
      expect(reopened.getMeta("schemaVersion")).toBe("16");
      expect(reopened.sqlite.prepare("SELECT COUNT(*) AS n FROM dictionary_aliases").get()).toEqual({ n: 3 });
    } finally {
      reopened.close();
    }
  });

  it("rolls back cleanly when interrupted before version publication and completes on retry", () => {
    const dir = tempDir("v16-crash");
    seedV15(dir);

    const crashed = crashChild(dir, "migration-before-version");
    expect(crashed.status, crashed.stderr).toBe(99);
    expect(fs.existsSync(path.join(dir, "manga.sqlite.premigrate-v15"))).toBe(true);

    const raw = new Database(path.join(dir, "manga.sqlite"), { readonly: true });
    try {
      expect((raw.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("15");
      expect(columnsOf(raw, "dictionary_terms")).not.toContain("category");
      expect(tablesOf(raw)).not.toContain("dictionary_aliases");
      expect(tablesOf(raw)).not.toContain("dictation_history");
    } finally {
      raw.close();
    }

    const recovered = new DrizzleStore({ profileDir: dir, hostId: "recover-v16" });
    try {
      expect(recovered.migration).toMatchObject({ from: 15, to: 16 });
      expect(recovered.getMeta("schemaVersion")).toBe("16");
      expect(recovered.sqlite.prepare("SELECT COUNT(*) AS n FROM dictionary_terms").get()).toEqual({ n: 6 });
      expect(recovered.sqlite.prepare("SELECT COUNT(*) AS n FROM dictionary_aliases").get()).toEqual({ n: 3 });
    } finally {
      recovered.close();
    }
  });

  it("rolls back on write error inside the migration transaction, matches fresh DB shape, and rejects v17 with API_INCOMPATIBLE", () => {
    const dir = tempDir("v16-rollback");
    seedV15(dir);

    const blocker = new Database(path.join(dir, "manga.sqlite"));
    blocker.exec(`
      CREATE TRIGGER fail_v16_version BEFORE UPDATE ON schema_meta
      WHEN NEW.key = 'schemaVersion' AND NEW.value = '16'
      BEGIN
        SELECT RAISE(ABORT, 'simulated disk error during v16');
      END;
    `);
    blocker.close();

    expect(() => new DrizzleStore({ profileDir: dir, hostId: "fail-v16" })).toThrow(/simulated disk error during v16/);

    const check = new Database(path.join(dir, "manga.sqlite"));
    expect((check.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("15");
    expect(columnsOf(check, "dictionary_terms")).not.toContain("category");
    expect(tablesOf(check)).not.toContain("dictionary_aliases");
    check.exec("DROP TRIGGER fail_v16_version");
    check.close();

    const migrated = new DrizzleStore({ profileDir: dir, hostId: "fixed-v16" });
    const freshDir = tempDir("v16-fresh");
    const fresh = new DrizzleStore({ profileDir: freshDir, hostId: "fresh-v16" });
    try {
      expect(migrated.getMeta("schemaVersion")).toBe("16");
      expect(fresh.getMeta("schemaVersion")).toBe("16");
      expect(tablesOf(fresh.sqlite)).toEqual(tablesOf(migrated.sqlite));
      expect([...columnsOf(fresh.sqlite, "dictionary_terms")].sort()).toEqual(
        [...columnsOf(migrated.sqlite, "dictionary_terms")].sort(),
      );
    } finally {
      migrated.close();
      fresh.close();
    }

    // Newer schema v17 must be rejected with MangaError("API_INCOMPATIBLE")
    const future = new Database(path.join(dir, "manga.sqlite"));
    future.prepare("UPDATE schema_meta SET value = '17' WHERE key = 'schemaVersion'").run();
    future.close();

    try {
      new DrizzleStore({ profileDir: dir, hostId: "future-v17" });
      expect.unreachable("expected v17 schema to throw API_INCOMPATIBLE");
    } catch (err) {
      expect(err).toBeInstanceOf(MangaError);
      expect((err as MangaError).code).toBe("API_INCOMPATIBLE");
    }
  });

  it("strips dictation_history & agent_requests from copyForBackup and pre-update backups, and excludes dictation_history & bangumi_details from library packages", async () => {
    const profileRoot = tempDir("v16-isolation");
    const ctx = await startApp({ profileRoot });
    try {
      const { store } = ctx.app;
      const now = "2026-11-12T12:00:00.000Z";
      store.sqlite
        .prepare("INSERT INTO works(id, title, media_kind, shelf_state, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run("work_iso", "隔离验证作品", "anime", "reading", now, now);
      store.sqlite
        .prepare(
          "INSERT INTO dictionary_terms(id, scope, work_id, term, heard, source, category, disabled, blocked_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run("trm_iso", "work", "work_iso", "星野苍真", "心野仓真", "manual", "character", 0, '["心也"]', now, now);
      store.sqlite
        .prepare("INSERT INTO dictionary_aliases(id, term_id, alias, kind, source, created_at) VALUES (?,?,?,?,?,?)")
        .run("als_iso", "trm_iso", "ほしのそうま", "kana", "manual", now);

      store.sqlite
        .prepare(
          "INSERT INTO dictation_history(id, work_id, engine_kind, engine_id, model_id, polish_mode, raw_text, corrected_text, final_text, fallback_reason, timings_json, replacements_json, audio_rel_path, audio_expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "dh_secret_1",
          "work_iso",
          "local",
          "sense-voice-funasr-nano-int8",
          "sense-voice-funasr-nano-int8",
          "light",
          "私密听写原文",
          "私密听写替换",
          "私密听写结果。",
          null,
          '{"totalMs":320}',
          "[]",
          "dh_secret_1.wav",
          "2026-11-13T12:00:00.000Z",
          now,
        );
      store.sqlite
        .prepare(
          "INSERT INTO dictionary_suggestions(id, scope, work_id, term, heard, score, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run("sug_1", "work", "work_iso", "雾岛千夏", "务岛千夏", 0.92, "pending", now, now);
      store.sqlite
        .prepare(
          "INSERT INTO bangumi_details(kind, external_id, name, infobox_json, payload_json, fetched_at) VALUES (?,?,?,?,?,?)",
        )
        .run("character", "501", "霧島千夏", "[]", '{"id":501}', now);
      store.sqlite
        .prepare(
          "INSERT INTO agent_requests(id, run_id, step, kind, status, started_at) VALUES (?,?,?,?,?,?)",
        )
        .run("areq_iso", "run_iso", 1, "model", "done", now);

      // 1. Pre-update backup via UpdateService.writePreUpdateBackup MUST strip dictation_history and agent_requests
      const preupdatePath = ctx.app.update.writePreUpdateBackup("0.1.0", { refresh: true });
      expect(preupdatePath).toBeTruthy();
      const preDb = new Database(preupdatePath!, { readonly: true });
      try {
        expect(preDb.prepare("SELECT COUNT(*) AS n FROM dictation_history").get()).toEqual({ n: 0 });
        expect(preDb.prepare("SELECT COUNT(*) AS n FROM agent_requests").get()).toEqual({ n: 0 });
        // Library works and dictionary terms MUST still be preserved (even when committed in WAL!)
        expect(preDb.prepare("SELECT COUNT(*) AS n FROM works WHERE id = 'work_iso'").get()).toEqual({ n: 1 });
        expect(preDb.prepare("SELECT COUNT(*) AS n FROM dictionary_terms WHERE id = 'trm_iso'").get()).toEqual({ n: 1 });
      } finally {
        preDb.close();
      }

      // 2. Library package export MUST exclude dictation_history, dictionary_suggestions, and bangumi_details
      const pkgDir = path.join(tempDir("v16-pkg"), "bundle");
      const manifest = exportLibraryPackage(store, pkgDir);
      const rawManifestJson = fs.readFileSync(path.join(pkgDir, "manifest.json"), "utf8");
      expect(rawManifestJson).not.toContain("私密听写");
      expect(rawManifestJson).not.toContain("dh_secret_1");
      expect(rawManifestJson).not.toContain("bangumi_details");
      expect(manifest.dictionary).toHaveLength(1);
      expect(manifest.dictionary?.[0]).toMatchObject({
        id: "trm_iso",
        term: "星野苍真",
        category: "character",
        disabled: 0,
        blocked_json: '["心也"]',
      });
      expect(manifest.dictionary?.[0]?.aliases).toEqual([
        expect.objectContaining({ alias: "ほしのそうま", kind: "kana" }),
      ]);

      // Round-trip import into a clean v16 store preserves v16 dictionary metadata while keeping 0 dictation_history rows
      const destStore = new DrizzleStore({ profileDir: tempDir("v16-pkg-dest"), hostId: "pkg-dest" });
      try {
        importLibraryPackage(destStore, pkgDir);
        expect(destStore.sqlite.prepare("SELECT COUNT(*) AS n FROM dictation_history").get()).toEqual({ n: 0 });
        expect(destStore.sqlite.prepare("SELECT category, blocked_json FROM dictionary_terms WHERE id = 'trm_iso'").get()).toEqual({
          category: "character",
          blocked_json: '["心也"]',
        });
        expect(destStore.sqlite.prepare("SELECT alias, kind FROM dictionary_aliases WHERE term_id = 'trm_iso'").all()).toEqual([
          { alias: "ほしのそうま", kind: "kana" },
        ]);
      } finally {
        destStore.close();
      }
    } finally {
      ctx.app.close();
    }
  });
});
