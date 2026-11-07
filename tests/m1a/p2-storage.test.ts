import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { DrizzleStore } from "@manga/storage-drizzle";
import { MangaProductApp, TestVault, exportLibraryPackage } from "@manga/app-core";
import { startApp, tempProfile } from "./helpers.ts";

describe("P2 storage, locations and recovery", () => {
  it("opens a legacy schema v1 database and keeps identities", async () => {
    const dir = tempProfile();
    const dbPath = path.join(dir, "manga.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE resources (id TEXT PRIMARY KEY, work_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, aliases_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE resource_revisions (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, fingerprint TEXT NOT NULL, parser_version TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE content_objects (id TEXT PRIMARY KEY, type TEXT NOT NULL, owner_module_id TEXT NOT NULL, scope_json TEXT NOT NULL, schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, payload_json TEXT NOT NULL, attachment_ids_json TEXT NOT NULL, preview_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);`);
    legacy.prepare("INSERT INTO schema_meta(key,value) VALUES ('schemaVersion','1')").run();
    legacy.prepare("INSERT INTO resources(id,kind,title,aliases_json,created_at) VALUES ('res_old','novel','旧书','[]','2026-01-01T00:00:00.000Z')").run();
    legacy.prepare("INSERT INTO resource_revisions(id,resource_id,fingerprint,parser_version,payload_json,created_at) VALUES ('rev_old','res_old','abc','novel-parser-v1',?,'2026-01-01T00:00:00.000Z')").run(JSON.stringify({ normalized: "こんにちは世界" }));
    legacy.close();
    const store = new DrizzleStore({ profileDir: dir, hostId: "migrate" });
    const row = store.sqlite.prepare("SELECT id, title FROM resources WHERE id = 'res_old'").get() as { id: string; title: string };
    expect(row.title).toBe("旧书");
    expect(store.getMeta("schemaVersion")).toBe("4");
    store.close();
  });

  it("filters CJK search before returning hits", async () => {
    const { app, actor, grant } = await startApp();
    const one = await app.call(actor, { commandId: "library.importText", idempotencyKey: "jp-1", input: { title: "a", bytes: [...Buffer.from("日本語の本文")] } }, grant.handle);
    const two = await app.call(actor, { commandId: "library.importText", idempotencyKey: "jp-2", input: { title: "b", bytes: [...Buffer.from("中文正文")] } }, grant.handle);
    const limited = app.issueAgentGrant(grant, { kind: "agent", id: "searcher" }, { readResourceIds: [String(one.value?.resourceId)] });
    const hits = await app.call({ kind: "agent", id: "searcher" }, { commandId: "library.find", idempotencyKey: "s1", input: { text: "本文" } }, limited.handle);
    expect(hits.status).toBe("ok");
    const ids = ((hits.value as Array<{ resourceId?: string }>) ?? []).map((item) => item.resourceId);
    expect(ids).toContain(one.value?.resourceId);
    expect(ids).not.toContain(two.value?.resourceId);
    app.close();
  });

  it("keeps original files and conflict copies when a package import process exits after publish", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    await app.call(actor, { commandId: "library.importText", idempotencyKey: "pkg-src", input: { title: "pack", bytes: [...Buffer.from("package body")] } }, grant.handle);
    fs.writeFileSync(path.join(app.store.attachmentsDir, "sample.bin"), "payload");
    const dest = path.join(profileRoot, "bundle");
    exportLibraryPackage(app.store, dest);
    app.close();
    const empty = tempProfile();
    const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/app-core/src/crash-child.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", child, "--profile", empty, "--crash-at", "publish", "--op", "package.import", "--source", dest], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    expect(result.status).toBe(99);
    const attachments = path.join(empty, "attachments");
    const names = fs.existsSync(attachments) ? fs.readdirSync(attachments) : [];
    expect(names.some((name) => name.startsWith(".import-"))).toBe(true);
    expect(names.some((name) => !name.startsWith(".import-"))).toBe(true);
  });

  it("refuses a schema newer than this application", () => {
    const dir = tempProfile();
    const db = new Database(path.join(dir, "manga.sqlite"));
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schemaVersion','99')").run();
    db.close();
    expect(() => new DrizzleStore({ profileDir: dir, hostId: "too-new" })).toThrow(/API_INCOMPATIBLE|newer/);
  });

  it("keeps the old pointer when a location copy process exits", async () => {
    const { app, profileRoot } = await startApp();
    const pointer = app.layout.pointerPath;
    const before = fs.readFileSync(pointer, "utf8");
    app.close();
    const target = path.join(os.tmpdir(), `manga-m1a-moved-${process.pid}-${Date.now()}`);
    const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/app-core/src/crash-child.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", child, "--profile", profileRoot, "--crash-at", "location-copy", "--op", "locations.apply", "--target", target], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    expect(result.status).toBe(99);
    expect(fs.readFileSync(pointer, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(target, "data"))).toBe(true);
  });

  it("exports and migrates only through host path handles", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    await app.call(actor, { commandId: "library.importText", idempotencyKey: "exp-src", input: { title: "pack", bytes: [...Buffer.from("handle body")] } }, grant.handle);
    const dest = path.join(profileRoot, "bundle");
    fs.mkdirSync(dest, { recursive: true });
    const exportHandle = app.registerPath("export", dest);
    const exported = await app.call(actor, { commandId: "library.exportPackage", idempotencyKey: "exp-1", input: { pathHandle: exportHandle } }, grant.handle);
    expect(exported.status).toBe("ok");
    const raw = await app.call(actor, { commandId: "library.exportPackage", idempotencyKey: "exp-raw", input: { targetDir: dest } }, grant.handle);
    expect(raw.status).toBe("error");
    expect(raw.error?.code).toBe("FORBIDDEN");
    const moved = path.join(os.tmpdir(), `manga-m1a-handle-${process.pid}-${Date.now()}`);
    fs.mkdirSync(moved, { recursive: true });
    const locationHandle = app.registerPath("directory", moved);
    const proposed = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "loc-p", input: { pathHandle: locationHandle } }, grant.handle);
    expect(proposed.status).toBe("ok");
    expect((proposed.value?.copies as unknown[]).length).toBeGreaterThan(1);
    const applied = await app.call(actor, {
      commandId: "settings.applyLocations",
      idempotencyKey: "loc-a",
      input: { checkpointId: proposed.value?.checkpointId, pathHandle: locationHandle },
    }, grant.handle);
    expect(applied.status).toBe("ok");
    const pointer = JSON.parse(fs.readFileSync(app.layout.pointerPath, "utf8")) as { profileRoot: string };
    expect(pointer.profileRoot).toBe(moved);
    app.close();
  });

  it("isolates test profiles from Documents and rejects a second write host", async () => {
    const { app, profileRoot } = await startApp();
    expect(profileRoot.startsWith(os.tmpdir()) || profileRoot.includes("manga-m1a")).toBe(true);
    expect(app.layout.pointerPath.startsWith(profileRoot)).toBe(true);
    expect(app.layout.documentsRoot.startsWith(profileRoot)).toBe(true);
    expect(() => new MangaProductApp({
      profileRoot: app.layout.defaultRoot,
      channel: "test",
      documentsDir: app.layout.documentsRoot,
      pointerPath: app.layout.pointerPath,
      hostId: "other",
      vault: new TestVault("x"),
    })).toThrow(/write host|HOST_CONFLICT/i);
    app.close();
  });

  it("stores only credential references and can undo a note", async () => {
    const { app, actor, grant } = await startApp();
    const secretHandle = app.stashSecret("test-credential-value-for-vault");
    const saved = await app.call(actor, {
      commandId: "connections.upsert",
      idempotencyKey: "conn-1",
      input: { label: "local", protocol: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", modelId: "demo", purpose: "text", credentialHandle: secretHandle },
    }, grant.handle);
    expect(saved.status).toBe("ok");
    const snapshot = JSON.stringify(app.workspace());
    expect(snapshot.includes("test-credential-value-for-vault")).toBe(false);
    const persisted = app.store.sqlite.prepare("SELECT group_concat(sql) AS sql FROM sqlite_master").get() as { sql: string };
    expect(JSON.stringify(app.store.sqlite.prepare("SELECT * FROM path_handles").all()).includes("test-credential-value-for-vault")).toBe(false);
    expect(persisted.sql.includes("credentials")).toBe(true);
    const created = await app.call(actor, { commandId: "notes.create", idempotencyKey: "n1", input: { title: "n", text: "one" } }, grant.handle);
    await app.call(actor, { commandId: "notes.update", idempotencyKey: "n2", input: { objectId: created.value?.objectId, expectedRevision: 1, text: "two" } }, grant.handle);
    const undone = await app.call(actor, { commandId: "notes.undo", idempotencyKey: "n3", input: { objectId: created.value?.objectId, expectedRevision: 2 } }, grant.handle);
    expect(undone.status).toBe("ok");
    app.close();
  });
});
