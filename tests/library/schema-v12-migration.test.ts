import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { readShell } from "@manga/app-core";
import { DEFAULT_SHELL_PREFERENCE, WorkspaceStateSchema } from "@manga/contracts";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";
import { startApp } from "../helpers/app.ts";
import { makeLegacyProfile } from "../helpers/legacy-db.ts";
import { seedV11 } from "../helpers/legacy-v11.ts";

/**
 * Schema v12 (A-94, A-96, plan 4.8): a library of the two-mode shell becomes one workspace. Every profile here is synthetic and built from the DDL of
 * the stages before; none is a real profile.
 */
const names = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
const tablesOf = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>).map((row) => row.name);

const dumpSessions = (db: Database.Database) => db.prepare("SELECT id, title, kind, target_id, project_id FROM agent_sessions ORDER BY id").all();
const dumpState = (db: Database.Database) => ({
  sessions: dumpSessions(db),
  progress: db.prepare("SELECT context_id, resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, percent FROM progress ORDER BY resource_id").all(),
  contexts: db.prepare("SELECT context_id, state_json FROM workspace_contexts ORDER BY context_id").all(),
  meta: db.prepare("SELECT key, value FROM schema_meta WHERE key LIKE 'conversation.current.%' ORDER BY key").all(),
  shell: db.prepare("SELECT revision, value_json FROM config WHERE key = 'shell.layout'").get(),
  runs: db.prepare("SELECT id, session_id FROM agent_runs ORDER BY id").all(),
});

describe("schema v12 migration (one workspace: conversations, positions, tabs and the shell preference are kept per context)", () => {
  it("converts a v11 library: positions to 最近, the older of two conversations of one target to a general conversation, tabs from what was open, the shell preference to the new shape", () => {
    const seeded = seedV11();
    const before = new Database(path.join(seeded.data, "manga.sqlite"), { readonly: true });
    const wasProgress = before.prepare("SELECT resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent FROM progress ORDER BY resource_id").all();
    const wasSessionCount = (before.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get() as { n: number }).n;
    before.close();
    const store = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "migrate-v12" });
    try {
      expect(PRODUCT_SCHEMA_VERSION).toBe(12);
      expect(store.getMeta("schemaVersion")).toBe("12");
      expect(store.migration).toMatchObject({ from: 11, to: 12, workspace: { convertedToShared: 2, fromDeletedProjects: 0, contexts: 2, tabs: 2, lastContext: "proj-a" } });

      // The backup is v11, untouched: the old progress key, the mark of closed conversations, the old shell preference.
      expect(fs.readdirSync(seeded.data).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v11"]);
      const backup = new Database(path.join(seeded.data, "manga.sqlite.premigrate-v11"), { readonly: true });
      expect(backup.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "11" });
      expect(names(backup, "progress")).not.toContain("context_id");
      expect(tablesOf(backup)).toContain("closed_sessions");
      expect(tablesOf(backup)).not.toContain("workspace_contexts");
      expect(names(backup, "project_materials")).not.toContain("origin");
      expect(JSON.parse((backup.prepare("SELECT value_json FROM config WHERE key = 'shell.layout'").get() as { value_json: string }).value_json).version).toBe(1);
      backup.close();

      // Progress: the same rows, every one now a position of 最近, and the view that answers "latest in any context" exists.
      expect(names(store.sqlite, "progress")).toContain("context_id");
      const progress = store.sqlite.prepare("SELECT context_id, resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent FROM progress ORDER BY resource_id").all() as Array<Record<string, unknown>>;
      expect(progress.map(({ context_id, ...row }) => { expect(context_id).toBe(""); return row; })).toEqual(wasProgress);
      expect(tablesOf(store.sqlite)).toContain("progress_latest");
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM progress_latest").get()).toEqual({ n: wasProgress.length });
      expect(names(store.sqlite, "project_materials")).toContain("origin");
      expect(store.sqlite.prepare("SELECT origin FROM project_materials WHERE id = 'pm-1'").get()).toEqual({ origin: "manual" });

      // Conversations: nothing is deleted, the runs stay with their sessions; projects own their conversations, everything else is "最近".
      expect((store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get() as { n: number }).n).toBe(wasSessionCount);
      expect(store.sqlite.prepare("SELECT id, kind, target_id, project_id FROM agent_sessions WHERE id IN ('ses-proj-a', 'ses-proj-b', 'ses-ent-res', 'ses-work-cre', 'ses-note') ORDER BY id").all()).toEqual([
        { id: "ses-ent-res", kind: "resource", target_id: seeded.ids.resource, project_id: null },
        { id: "ses-note", kind: "note", target_id: "note-x", project_id: null },
        { id: "ses-proj-a", kind: "project", target_id: "proj-a", project_id: "proj-a" },
        { id: "ses-proj-b", kind: "project", target_id: "proj-b", project_id: "proj-b" },
        { id: "ses-work-cre", kind: "work", target_id: seeded.ids.work, project_id: null },
      ]);
      // Of the two conversations one target had in the two modes the newer stays, the older becomes a general conversation that says where it came from.
      expect(store.sqlite.prepare("SELECT kind, target_id, title, project_id FROM agent_sessions WHERE id = 'ses-cre-res'").get()).toEqual({ kind: "shared", target_id: null, title: "书（工作）（原工作模式）", project_id: null });
      expect(store.sqlite.prepare("SELECT kind, target_id, title FROM agent_sessions WHERE id = 'ses-work-ent'").get()).toEqual({ kind: "shared", target_id: null, title: "作品页（娱乐）（原娱乐模式）" });
      expect(store.sqlite.prepare("SELECT session_id FROM agent_runs WHERE id = 'run-1'").get()).toEqual({ session_id: "ses-cre-res" });
      // The current conversation of 最近 is the newer of the two modes' current ones; a project's is its own.
      expect(store.getMeta("conversation.current.recent")).toBe("ses-shared-cre");
      expect(store.getMeta("conversation.current.enthusiast")).toBeUndefined();
      expect(store.getMeta("conversation.current.creator")).toBeUndefined();
      expect(store.getMeta("conversation.current.project.proj-a")).toBe("ses-proj-a");

      // Tabs: what was open on the rail (not what was closed from it) becomes the tabs of its context; the archived project has none.
      const contexts = store.sqlite.prepare("SELECT context_id, state_json FROM workspace_contexts ORDER BY context_id").all() as Array<{ context_id: string; state_json: string }>;
      expect(contexts.map((row) => row.context_id)).toEqual(["", "proj-a"]);
      const recent = WorkspaceStateSchema.parse(JSON.parse(contexts[0]!.state_json));
      expect(recent).toMatchObject({ preset: "single", layout: null, closed: [] });
      expect(recent.tabs).toHaveLength(1);
      expect(recent.tabs[0]).toMatchObject({ kind: "reader", target: { resourceId: seeded.ids.resource, mediaKind: "novel" }, title: "旧库作品" });
      expect(recent.focusedTab).toBe(recent.tabs[0]!.id);
      const projectState = WorkspaceStateSchema.parse(JSON.parse(contexts[1]!.state_json));
      expect(projectState.tabs).toHaveLength(1);
      expect(projectState.tabs[0]).toMatchObject({ kind: "project", target: { projectId: "proj-a" }, title: "项目甲" });

      // The shell preference: the columns of the entertainment mode, and the person comes back to the project they were working in.
      expect(store.sqlite.prepare("SELECT revision FROM config WHERE key = 'shell.layout'").get()).toEqual({ revision: 4 });
      const shell = readShell(store);
      expect(shell).toMatchObject({ version: 2, spoilerGuard: true, sidebar: { visible: true, width: 300 }, dock: { visible: false, width: 500 }, lastContext: "proj-a" });
      expect(shell.reading).toEqual(DEFAULT_SHELL_PREFERENCE.reading);

      expect(tablesOf(store.sqlite)).not.toContain("closed_sessions");
      expect(tablesOf(store.sqlite)).toEqual(expect.arrayContaining(["workspace_contexts", "project_material_exclusions"]));
      expect(store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(store.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("turns the conversation of a project deleted before v12 into a general conversation of 最近 instead of leaving it under a project that is gone", async () => {
    const seeded = seedV11();
    // Deleting a project in v11 cleared project_id and left the kind and the target pointing at the project.
    const db = new Database(path.join(seeded.data, "manga.sqlite"));
    db.prepare("INSERT INTO agent_sessions(id, title, grant_handle, kind, target_id, mode, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("ses-proj-gone", "已删除的项目", "g", "project", "proj-gone", "creator", null, "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    db.close();
    const store = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "orphan-v12" });
    try {
      expect(store.migration).toMatchObject({ from: 11, to: 12, workspace: { convertedToShared: 2, fromDeletedProjects: 1 } });
      expect(store.sqlite.prepare("SELECT kind, target_id, title, project_id FROM agent_sessions WHERE id = 'ses-proj-gone'").get()).toEqual({ kind: "shared", target_id: null, title: "已删除的项目", project_id: null });
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE kind = 'project' AND project_id NOT IN (SELECT id FROM projects)").get()).toEqual({ n: 0 });
      expect(store.getMeta("conversation.current.project.proj-gone")).toBeUndefined();
    } finally {
      store.close();
    }
    const ctx = await startApp({ profileRoot: seeded.root });
    try {
      const result = await ctx.app.call(ctx.actor, { commandId: "conversation.history", idempotencyKey: "v12-orphan-history", input: { contextId: null } }, ctx.grant.handle);
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect((result.value as { items: Array<{ sessionId: string }> }).items.map((item) => item.sessionId)).toContain("ses-proj-gone");
    } finally {
      ctx.app.close();
    }
  });

  it("is a no-op the second time: no second backup, nothing converted again, the same rows", () => {
    const seeded = seedV11();
    const first = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "first-v12" });
    const once = dumpState(first.sqlite);
    first.close();
    const again = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "again-v12" });
    try {
      expect(again.migration).toBeNull();
      expect(dumpState(again.sqlite)).toEqual(once);
      expect(fs.readdirSync(seeded.data).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v11"]);
    } finally {
      again.close();
    }
  });

  it("stops before the version is published: the library is still v11 with its old shape and rows, and the retry finishes with one backup and the same result", () => {
    const seeded = seedV11();
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      "import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({ profileDir: process.env.MANGA_V12_DATA, hostId: 'crash-before-v12', crashAt: 'migration-before-version' });"], {
      env: { ...process.env, MANGA_V12_DATA: seeded.data }, encoding: "utf8", windowsHide: true, timeout: 60_000,
    });
    expect(child.status, child.stderr).toBe(99);
    const half = new Database(path.join(seeded.data, "manga.sqlite"));
    expect(half.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "11" });
    expect(names(half, "progress")).not.toContain("context_id");
    expect(tablesOf(half)).toContain("closed_sessions");
    expect(tablesOf(half)).not.toContain("workspace_contexts");
    expect(half.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE project_id IS NULL AND kind = 'project'").get()).toEqual({ n: 0 });
    expect(half.prepare("SELECT kind FROM agent_sessions WHERE id = 'ses-cre-res'").get()).toEqual({ kind: "resource" });
    expect(JSON.parse((half.prepare("SELECT value_json FROM config WHERE key = 'shell.layout'").get() as { value_json: string }).value_json).version).toBe(1);
    half.close();

    const retried = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "retry-v12" });
    const reference = seedV11();
    const direct = new DrizzleStore({ profileDir: reference.data, worksDir: reference.works, hostId: "direct-v12" });
    try {
      expect(retried.getMeta("schemaVersion")).toBe("12");
      expect(fs.readdirSync(seeded.data).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v11"]);
      // Contexts are saved with fresh tab ids, so the comparison is on everything but those.
      const strip = (state: ReturnType<typeof dumpState>) => ({ ...state, contexts: state.contexts.map((row) => ({ context_id: (row as { context_id: string }).context_id })), shell: { revision: (state.shell as { revision: number }).revision } });
      expect(strip(dumpState(retried.sqlite))).toEqual(strip(dumpState(direct.sqlite)));
    } finally {
      retried.close();
      direct.close();
    }
  });

  it("goes back by restoring the backup, and the same migration runs again from there with the same result", () => {
    const seeded = seedV11();
    const first = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "restore-first" });
    const once = dumpState(first.sqlite);
    first.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(seeded.data, `manga.sqlite${suffix}`), { force: true });
    fs.copyFileSync(path.join(seeded.data, "manga.sqlite.premigrate-v11"), path.join(seeded.data, "manga.sqlite"));
    fs.rmSync(path.join(seeded.data, "manga.sqlite.premigrate-v11"));
    const again = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "restore-again" });
    try {
      expect(again.migration).toMatchObject({ from: 11, to: 12 });
      const strip = (state: ReturnType<typeof dumpState>) => ({ ...state, contexts: state.contexts.map((row) => ({ context_id: (row as { context_id: string }).context_id })) });
      expect(strip(dumpState(again.sqlite))).toEqual(strip(once));
    } finally {
      again.close();
    }
  });

  it("refuses a library whose schema is newer than this application, and leaves it alone", () => {
    const seeded = seedV11();
    const db = new Database(path.join(seeded.data, "manga.sqlite"));
    db.prepare("UPDATE schema_meta SET value = '13' WHERE key = 'schemaVersion'").run();
    db.close();
    expect(() => new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "newer-v12" })).toThrow(/newer than this application/);
    const check = new Database(path.join(seeded.data, "manga.sqlite"), { readonly: true });
    expect(check.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "13" });
    expect(names(check, "progress")).not.toContain("context_id");
    check.close();
    expect(fs.readdirSync(seeded.data).filter((name) => name.includes("premigrate"))).toEqual([]);
  });

  it("goes v10 → v12 in one start with one backup of what was there, and starts a new library at v12 with nothing to convert", () => {
    const { dir } = makeLegacyProfile(10);
    const chained = new DrizzleStore({ profileDir: dir, hostId: "chain-v12" });
    try {
      expect(chained.migration).toMatchObject({ from: 10, to: 12, workspace: { convertedToShared: 0, contexts: 0, tabs: 0, lastContext: null } });
      expect(fs.readdirSync(dir).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v10"]);
      expect(names(chained.sqlite, "progress")).toContain("context_id");
      expect(chained.sqlite.prepare("SELECT context_id FROM progress").all()).toEqual([{ context_id: "" }]);
      expect(chained.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_contexts").get()).toEqual({ n: 0 });
    } finally {
      chained.close();
    }
    const fresh = new DrizzleStore({ profileDir: fs.mkdtempSync(path.join(os.tmpdir(), "manga-v12-fresh-")), hostId: "fresh-v12" });
    try {
      expect(fresh.getMeta("schemaVersion")).toBe("12");
      expect(fresh.migration).toBeNull();
      expect(tablesOf(fresh.sqlite)).toEqual(expect.arrayContaining(["workspace_contexts", "project_material_exclusions", "progress_latest"]));
      expect(tablesOf(fresh.sqlite)).not.toContain("closed_sessions");
    } finally {
      fresh.close();
    }
  });

  it("opens in the application: the contexts, the tabs, the conversations and the positions are where the new shell looks for them", async () => {
    const seeded = seedV11();
    const ctx = await startApp({ profileRoot: seeded.root });
    try {
      const call = async (commandId: string, input: Record<string, unknown>) => {
        const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `v12-${commandId}-${Math.random()}`, input }, ctx.grant.handle);
        expect(result.status, JSON.stringify(result)).toBe("ok");
        return result.value as Record<string, any>;
      };
      const listed = (await call("workspace.contexts", {})).contexts as Array<{ contextId: string | null; kind: string; name: string; tabCount: number }>;
      expect(listed.map((item) => [item.contextId, item.name, item.tabCount])).toEqual([[null, "最近", 1], ["proj-a", "项目甲", 1], ["proj-b", "项目乙", 0]]);
      const withArchived = (await call("workspace.contexts", { includeArchived: true })).contexts as Array<{ contextId: string | null }>;
      expect(withArchived.map((item) => item.contextId)).toContain("proj-c");

      const loaded = await call("workspace.loadContext", { contextId: null });
      expect(loaded.state.tabs.map((tab: { kind: string }) => tab.kind)).toEqual(["reader"]);
      expect(loaded.damaged).toBe(false);
      expect((await call("conversation.current", { contextId: null })).conversation.sessionId).toBe("ses-shared-cre");
      expect((await call("conversation.current", { contextId: "proj-a" })).conversation.sessionId).toBe("ses-proj-a");
      const history = (await call("conversation.history", { contextId: null })).items as Array<{ sessionId: string; title: string }>;
      expect(history.map((item) => item.sessionId)).toEqual(expect.arrayContaining(["ses-shared-ent", "ses-cre-res", "ses-work-ent"]));
      expect(history.find((item) => item.sessionId === "ses-cre-res")!.title).toContain("原工作模式");

      // The position that was kept is the position of 最近; a project has none until the book is read in it.
      const there = await call("progress.get", { contextId: null, resourceId: seeded.ids.resource });
      expect(there.locator).toMatchObject({ kind: "text", range: { start: 6, end: 14 } });
      expect(there.elsewhere).toBeNull();
      const inProject = await call("progress.get", { contextId: "proj-a", resourceId: seeded.ids.resource });
      expect(inProject.locator).toBeNull();
      expect(inProject.elsewhere).toMatchObject({ contextId: null, contextName: "最近", locator: { kind: "text", range: { start: 6, end: 14 } } });
    } finally {
      ctx.app.close();
    }
  });
});
