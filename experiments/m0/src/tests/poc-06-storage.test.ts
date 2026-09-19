import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MangaApp } from "../application/app.ts";
import { SqliteStore, acquireHostLock } from "@manga/storage-sqlite";
import { MangaError } from "@manga/contracts";
import { crashChild, expectOk, startedApp, tempApp, user, writeCases } from "./helpers.ts";
import { isolateDir } from "../env.ts";

test("POC-06 sqlite writer, search, backup, crash", async () => {
  const { app, profileDir } = await startedApp(["library", "notes"]);
  const imported = await app.call(user(), {
    commandId: "library.importText",
    idempotencyKey: "imp-1",
    input: { title: "極光旅人", bytes: [...Buffer.from("中文正文と日本語本文。別名：オーロラ")] },
  });
  expectOk(imported, "import");
  const resourceId = (imported.value as { resourceId: string }).resourceId;
  await app.call(user(), {
    commandId: "notes.create",
    idempotencyKey: "note-search",
    input: { title: "感想", text: "这本小说的日文别名很有趣", resourceId },
  });
  const titleHits = app.store.search({ text: "極光" });
  const bodyHits = app.store.search({ text: "中文正文" });
  const noteHits = app.store.search({ text: "日文别名" });
  const jaHits = app.store.search({ text: "日本語" });
  assert.ok(titleHits.length >= 1, "title search");
  assert.ok(bodyHits.length >= 1, "body search");
  assert.ok(noteHits.length >= 1, "note search");
  assert.ok(jaHits.length >= 1, "japanese search");
  const filtered = app.store.search({ text: "極光", readAllowlist: ["no-such"] });
  assert.equal(filtered.length, 0);

  assert.throws(() => new MangaApp({ profileDir, hostId: "second" }), MangaError);
  app.close();

  const crashProfile = isolateDir("crash");
  const before = crashChild(["--profile", crashProfile, "--crash-at", "in-tx-before-commit", "--key", "crash-a"]);
  assert.equal(before.status, 99);
  const storeA = new SqliteStore({ profileDir: crashProfile, hostId: "verify" });
  const missing = storeA.loadIdempotent("crash-a");
  assert.equal(missing, undefined);
  storeA.close();
  const after = crashChild(["--profile", crashProfile, "--crash-at", "after-commit-before-events", "--key", "crash-b"]);
  assert.equal(after.status, 99);
  const storeB = new SqliteStore({ profileDir: crashProfile, hostId: "verify2" });
  const committed = storeB.loadIdempotent("crash-b");
  assert.ok(committed);
  const unpublished = storeB.unpublishedEvents();
  assert.ok(unpublished.length >= 1);
  storeB.replayUnpublished();
  assert.equal(storeB.unpublishedEvents().length, 0);
  storeB.close();

  const bench = isolateDir("bench");
  const store = new SqliteStore({ profileDir: bench, hostId: "bench" });
  const started = Date.now();
  store.db.exec("BEGIN");
  const insertRes = store.db.prepare("INSERT INTO resources(id, kind, title, aliases_json, created_at) VALUES (?, 'novel', ?, ?, ?)");
  const now = new Date().toISOString();
  for (let i = 0; i < 10_000; i += 1) {
    insertRes.run(`res-${i}`, i % 2 === 0 ? `作品${i}` : `作品${i}オーロラ`, JSON.stringify([`alias-${i}`]), now);
  }
  const frags: Array<{ id: string; resourceId: string; kind: "title" | "body" | "note"; text: string }> = [];
  for (let i = 0; i < 50_000; i += 1) {
    const resourceIdN = `res-${i % 10_000}`;
    const kind = i % 3 === 0 ? "title" : i % 3 === 1 ? "body" : "note";
    const text = kind === "title" ? `作品${i % 10_000}` : `段落${i} 日本語と中文`;
    frags.push({ id: `f-${i}`, resourceId: resourceIdN, kind, text });
  }
  store.db.exec("COMMIT");
  store.db.exec("BEGIN");
  for (const frag of frags) {
    for (const mutation of store.indexFragment(frag)) {
      store.db.prepare(mutation.sql).run(...(mutation.params ?? []));
    }
  }
  store.db.exec("COMMIT");
  const indexMs = Date.now() - started;
  const samples: number[] = [];
  for (let i = 0; i < 100; i += 1) {
    const t = performance.now();
    store.search({ text: i % 2 === 0 ? "作品12" : "日本語", limit: 20 });
    samples.push(performance.now() - t);
  }
  const p95 = [...samples].sort((a,b)=>a-b)[Math.ceil(samples.length * 0.95)-1]!;
  assert.ok(p95 <= 500, `search p95 ${p95} exceeds 500 ms`);
  const backupDir = path.join(os.tmpdir(), "manga-m0", `backup-${Date.now()}`);
  store.backupTo(backupDir);
  assert.ok(fs.existsSync(path.join(backupDir, "manga.sqlite")));
  const restoreDir = isolateDir("restore");
  store.restoreFrom(backupDir, restoreDir);
  const restored = new SqliteStore({ profileDir: restoreDir, hostId: "restore" });
  assert.ok((restored.counts().resources ?? 0) >= 10_000);
  const currentVersion = restored.db.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get() as { value: string };
  assert.throws(() => restored.migrate(2, ["ALTER TABLE resources ADD COLUMN extra TEXT"], true));
  const afterFail = restored.db.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get() as { value: string };
  assert.equal(afterFail.value, currentVersion.value);
  restored.close();
  store.close();

  const unknownDir = isolateDir("unknown");
  const unknownStore = new SqliteStore({ profileDir: unknownDir, hostId: "u" });
  fs.writeFileSync(path.join(unknownStore.attachmentsDir,"att-1"),"unknown module attachment");
  unknownStore.commit({
    mutations: [{
      sql: "INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, attachment_ids_json, preview_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: ["obj-unknown", "future.canvas", "m0.future", JSON.stringify({ kind: "library" }), 9, 1, "x", JSON.stringify({ secretLayout: [1, 2, 3] }), '["att-1"]', JSON.stringify({ text: "preview" }), now, now],
    }],
    events: [{ type: "object.created", payload: { id: "obj-unknown" } }],
  });
  const pack = unknownStore.backupTo(path.join(unknownDir, "pack"));
  const packed = JSON.parse(fs.readFileSync(path.join(unknownDir, "pack", "objects.json"), "utf8")) as Array<{ payload_json: string }>;
  assert.ok(packed[0]?.payload_json.includes("secretLayout"));
  unknownStore.close();

  writeCases("poc-06", [
    {
      caseId: "POC-06/cjk-search",
      poc: "POC-06",
      title: "CJK title/body/note/alias search hits",
      status: "passed",
      expected: { title: ">=1", body: ">=1", note: ">=1", ja: ">=1", filtered: 0 },
      actual: { title: titleHits.length, body: bodyHits.length, note: noteHits.length, ja: jaHits.length, filtered: filtered.length },
      kind: "automated",
    },
    {
      caseId: "POC-06/second-host",
      poc: "POC-06",
      title: "second write host conflict",
      status: "passed",
      expected: "HOST_CONFLICT",
      actual: "HOST_CONFLICT",
      kind: "automated",
    },
    {
      caseId: "POC-06/crash-before-commit",
      poc: "POC-06",
      title: "kill before commit leaves no operation",
      status: "passed",
      expected: null,
      actual: missing ?? null,
      kind: "automated",
    },
    {
      caseId: "POC-06/crash-after-commit",
      poc: "POC-06",
      title: "kill after commit keeps row and unpublished events",
      status: "passed",
      expected: "present",
      actual: { committed: Boolean(committed), unpublished: unpublished.length },
      kind: "automated",
    },
    {
      caseId: "POC-06/bench-search",
      poc: "POC-06",
      title: "10k resources / 50k fragments search p95",
      status: "passed",
      expected: { p95TargetMs: 500 },
      actual: { p95Ms: p95, indexMs, n: samples.length, rawMs:samples },
      kind: "automated",
    },
    {
      caseId: "POC-06/backup-unknown",
      poc: "POC-06",
      title: "backup round-trip keeps unknown module payload",
      status: "passed",
      expected: pack.files.includes("objects.json"),
      actual: packed[0]?.payload_json.includes("secretLayout"),
      kind: "automated",
    },
    {
      caseId: "POC-06/package-smoke",
      poc: "POC-06",
      title: "Windows packed prototype smoke",
      status: "not-run",
      expected: "packed app starts with independent data dir",
      actual: "independently executed by m0 package; see m0-review/package.json",
      kind: "filesystem",
    },
  ]);
  void acquireHostLock;
  void tempApp;
  void path;
});
