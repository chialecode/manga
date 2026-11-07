import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { completeText, startMockProvider, syntheticWav } from "@manga/model-protocol";
import { MangaProductApp, TestVault } from "@manga/app-core";
import { startApp, waitForRun, writeTempWav } from "./helpers.ts";
import { ownedFileFingerprint } from "../../packages/app-core/src/locations.ts";

const crashChild = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/app-core/src/crash-child.ts");

describe("F-24 location ownership", () => {
  it("rolls back only owned copying/committed files and keeps foreign files", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    const target = path.join(os.tmpdir(), `manga-m1a-owned-${process.pid}-${Date.now()}`);
    fs.mkdirSync(path.join(target, "resources"), { recursive: true });
    const keep = path.join(target, "resources", "foreign.txt");
    fs.writeFileSync(keep, "pre-existing");
    const handle = app.registerPath("directory", target);
    const proposed = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "own-p", input: { pathHandle: handle } }, grant.handle);
    expect(proposed.status).toBe("ok");
    fs.writeFileSync(path.join(target, "resources", "owned.txt"), "task owned");
    app.store.sqlite.prepare("INSERT INTO migration_owned_files(job_id, partition, relative_path, absolute_path, state, fingerprint) VALUES (?,?,?,?,?,?)").run(
      proposed.value?.checkpointId, "resources", "owned.txt", path.join(target, "resources", "owned.txt"), "committed", ownedFileFingerprint(path.join(target, "resources", "owned.txt")),
    );
    const rolled = await app.call(actor, { commandId: "settings.recoverJobs", idempotencyKey: "own-rb", input: { action: "rollback" } }, grant.handle);
    expect(rolled.status).toBe("ok");
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(path.join(target, "resources", "owned.txt"))).toBe(false);
    app.close();
  });

  it("resumes an interrupted copy and publishes the new library", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    await app.call(actor, { commandId: "notes.create", idempotencyKey: "resume-note", input: { title: "keep-resume", text: "body" } }, grant.handle);
    const pointer = app.layout.pointerPath;
    app.close();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1a-resume-"));
    const crashed = spawnSync(process.execPath, ["--experimental-strip-types", crashChild, "--profile", profileRoot, "--crash-at", "location-copy", "--op", "locations.apply", "--target", target], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    expect(crashed.status).toBe(99);
    const recovering = await startApp({ profileRoot, hostId: "resume-copy" });
    const recovered = await recovering.app.call(recovering.actor, { commandId: "settings.recoverJobs", idempotencyKey: "resume-recover", input: { action: "recover" } }, recovering.grant.handle);
    expect(recovered.status).toBe("ok");
    expect((recovered.value?.recovered as string[] | undefined)?.length).toBeGreaterThan(0);
    recovering.app.close();
    const reopened = await startApp({ profileRoot, hostId: "resume-open" });
    expect(reopened.app.workspace().notes.map((note) => note.title)).toContain("keep-resume");
    expect(path.resolve(reopened.app.layout.defaultRoot)).toBe(path.resolve(target));
    const pointerBody = JSON.parse(fs.readFileSync(pointer, "utf8")) as { profileRoot: string };
    expect(path.resolve(pointerBody.profileRoot)).toBe(path.resolve(target));
    reopened.app.close();
  });
});

describe("F-25 write barrier after location switch", () => {
  it("seals the old host and marks the target job succeeded before the pointer switch", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    await app.call(actor, { commandId: "notes.create", idempotencyKey: "seal-note", input: { title: "keep", text: "body" } }, grant.handle);
    const moved = path.join(os.tmpdir(), `manga-m1a-sealed-${process.pid}-${Date.now()}`);
    const handle = app.registerPath("directory", moved);
    const proposed = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "seal-p", input: { pathHandle: handle } }, grant.handle);
    const applied = await app.call(actor, { commandId: "settings.applyLocations", idempotencyKey: "seal-a", input: { checkpointId: proposed.value?.checkpointId, pathHandle: handle } }, grant.handle);
    expect(applied.status).toBe("ok");
    const blocked = await app.call(actor, { commandId: "notes.create", idempotencyKey: "seal-blocked", input: { title: "lost", text: "should not persist" } }, grant.handle);
    expect(blocked.status).toBe("error");
    expect(blocked.error?.code).toBe("RESTART_REQUIRED");
    const remote = new Database(path.join(moved, "data", "manga.sqlite"));
    const job = remote.prepare("SELECT status FROM recovery_jobs WHERE id = ?").get(String(proposed.value?.checkpointId)) as { status: string };
    expect(job.status).toBe("succeeded");
    remote.close();
    app.close();
  });

  it("rejects overlapping migration targets", async () => {
    const { app, actor, grant } = await startApp();
    const nested = path.join(app.layout.defaultRoot, "nested");
    const handle = app.registerPath("directory", nested);
    const proposed = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "overlap-p", input: { pathHandle: handle } }, grant.handle);
    expect(proposed.status).toBe("error");
    app.close();
  });

  it("keeps the switched pointer when the process exits after location-switch", async () => {
    const { app, profileRoot } = await startApp();
    const pointer = app.layout.pointerPath;
    app.close();
    const target = path.join(os.tmpdir(), `manga-m1a-switch-${process.pid}-${Date.now()}`);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", crashChild, "--profile", profileRoot, "--crash-at", "location-switch", "--op", "locations.apply", "--target", target], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    expect(result.status).toBe(99);
    const pointerBody = JSON.parse(fs.readFileSync(pointer, "utf8")) as { profileRoot: string };
    expect(path.resolve(pointerBody.profileRoot)).toBe(path.resolve(target));
  });

  it("redirects an explicit old profile root to the published library", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    await app.call(actor, { commandId: "notes.create", idempotencyKey: "auth-note", input: { title: "authoritative", text: "body" } }, grant.handle);
    const moved = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1a-auth-"));
    const handle = app.registerPath("directory", moved);
    const proposed = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "auth-p", input: { pathHandle: handle } }, grant.handle);
    const applied = await app.call(actor, { commandId: "settings.applyLocations", idempotencyKey: "auth-a", input: { checkpointId: proposed.value?.checkpointId, pathHandle: handle } }, grant.handle);
    expect(applied.status).toBe("ok");
    app.close();
    const old = new MangaProductApp({
      profileRoot,
      channel: "test",
      documentsDir: path.join(profileRoot, "documents"),
      pointerPath: path.join(profileRoot, "launcher", "pointer.json"),
      hostId: "stale-explicit",
      vault: new TestVault("m1a-test-vault"),
    });
    await old.start();
    const pointer = JSON.parse(fs.readFileSync(old.layout.pointerPath, "utf8")) as { profileRoot: string };
    expect(path.resolve(pointer.profileRoot)).toBe(path.resolve(moved));
    expect(path.resolve(old.layout.defaultRoot)).toBe(path.resolve(moved));
    const write = await old.call(actor, { commandId: "notes.create", idempotencyKey: "stale-restart", input: { title: "after-redirect", text: "new" } }, old.issueOwnerGrant(actor).handle);
    expect(write.status).toBe("ok");
    old.close();
    const oldDb = new Database(path.join(profileRoot, "data", "manga.sqlite"), { readonly: true, fileMustExist: true });
    const oldNotes = oldDb.prepare("SELECT title FROM content_objects WHERE type = 'notes.document'").all() as Array<{ title: string }>;
    oldDb.close();
    expect(oldNotes.map((row) => row.title)).not.toContain("after-redirect");
  });

  it("covers pointer and copy/verify/publish/commit/switch process exits", async () => {
    const stages = ["location-copy", "location-verify", "location-publish", "location-commit", "location-pointer", "location-switch"] as const;
    for (const stage of stages) {
      const { app, actor, grant, profileRoot } = await startApp();
      await app.call(actor, { commandId: "notes.create", idempotencyKey: `crash-note-${stage}`, input: { title: `keep-${stage}`, text: "body" } }, grant.handle);
      app.close();
      const target = fs.mkdtempSync(path.join(os.tmpdir(), `manga-m1a-${stage}-`));
      const crashed = spawnSync(process.execPath, ["--experimental-strip-types", crashChild, "--profile", profileRoot, "--crash-at", stage, "--op", "locations.apply", "--target", target], {
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      expect(crashed.status, stage).toBe(99);
      const early = stage === "location-copy" || stage === "location-verify" || stage === "location-publish" || stage === "location-commit";
      if (early) {
        const recovering = await startApp({ profileRoot, hostId: `recover-${stage}` });
        const recovered = await recovering.app.call(recovering.actor, { commandId: "settings.recoverJobs", idempotencyKey: `recover-${stage}`, input: { action: "recover" } }, recovering.grant.handle);
        expect(recovered.status, stage).toBe("ok");
        recovering.app.close();
      }
      const reopened = await startApp({ profileRoot, hostId: `open-${stage}` });
      expect(reopened.app.workspace().notes.map((note) => note.title), stage).toContain(`keep-${stage}`);
      expect(path.resolve(reopened.app.layout.defaultRoot), stage).toBe(path.resolve(target));
      reopened.app.close();
    }
  }, 120_000);
});

describe("F-26 actor-bound idempotency", () => {
  it("rejects replaying another actor's receipt", async () => {
    const { app, actor, grant } = await startApp();
    const created = await app.call(actor, { commandId: "notes.create", idempotencyKey: "shared-key", input: { title: "owner", text: "secret" } }, grant.handle);
    expect(created.status).toBe("ok");
    const other = { kind: "user" as const, id: "intruder" };
    const otherGrant = app.issueOwnerGrant(other);
    const replay = await app.call(other, { commandId: "notes.create", idempotencyKey: "shared-key", input: { title: "owner", text: "secret" } }, otherGrant.handle);
    expect(replay.status).toBe("error");
    expect(replay.error?.code).toBe("FORBIDDEN");
    app.close();
  });

  it("rejects an in-flight idempotency key from another actor", async () => {
    const { app, actor, grant } = await startApp();
    const other = { kind: "user" as const, id: "other-host" };
    const otherGrant = app.issueOwnerGrant(other);
    const first = app.call(actor, { commandId: "inventory.scan", idempotencyKey: "scan-shared", input: {} }, grant.handle);
    const second = await app.call(other, { commandId: "inventory.scan", idempotencyKey: "scan-shared", input: {} }, otherGrant.handle);
    expect(second.status).toBe("error");
    expect(second.error?.code).toBe("FORBIDDEN");
    await first;
    app.close();
  });
});

describe("F-27 immediate run identity", () => {
  it("returns a runId before the provider finishes", async () => {
    const server = await startMockProvider({ mode: "timeout" });
    const { app, actor, grant } = await startApp();
    const secret = app.stashSecret("test-credential-value-for-vault");
    await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "imm-conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "imm-ses", input: {} }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "imm-send", input: { sessionId: session.value?.id, text: "later" } }, grant.handle);
    expect(sent.status).toBe("ok");
    expect(sent.value?.status).toBe("running");
    expect(sent.value?.runId).toBeTruthy();
    await app.call(actor, { commandId: "agent.cancel", idempotencyKey: "imm-cancel", input: { runId: sent.value?.runId } }, grant.handle);
    await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
    await server.close();
    app.close();
  });

  it("restores run input, live text and history after close", async () => {
    const server = await startMockProvider({ mode: "timeout" });
    const { app, actor, grant, profileRoot } = await startApp();
    const secret = app.stashSecret("test-credential-value-for-vault");
    await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "hist-conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "hist-ses", input: { title: "history" } }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "hist-send", input: { sessionId: session.value?.id, text: "visible user turn" } }, grant.handle);
    await new Promise((resolve) => setTimeout(resolve, 80));
    app.close();
    const reopened = await startApp({ profileRoot, hostId: "hist-open" });
    const ws = reopened.app.workspace();
    expect((ws.runs as Array<{ inputText?: string }>).some((run) => run.inputText === "visible user turn")).toBe(true);
    const latest = await reopened.app.call(reopened.actor, { commandId: "agent.getRun", idempotencyKey: "hist-get", input: { runId: sent.value?.runId } }, reopened.grant.handle);
    expect(latest.value?.inputText).toBe("visible user turn");
    expect(Array.isArray(latest.value?.messages)).toBe(true);
    expect((latest.value?.messages as Array<{ role: string }>).some((message) => message.role === "user")).toBe(true);
    reopened.app.close();
    await server.close();
  });
});

describe("F-28 dual runtime freeze", () => {
  it("stores the selected runtime on the run and ignores later settings changes", async () => {
    const server = await startMockProvider();
    const { app, actor, grant } = await startApp();
    await app.call(actor, { commandId: "settings.setRuntime", idempotencyKey: "rt-set", input: { runtime: "pi" } }, grant.handle);
    const secret = app.stashSecret("test-credential-value-for-vault");
    const saved = await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "rt-conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", timeoutMs: 1500, credentialHandle: secret } }, grant.handle);
    expect(saved.value?.runtime).toBe("pi");
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "rt-ses", input: {} }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "rt-send", input: { sessionId: session.value?.id, text: "hi" } }, grant.handle);
    const stored = app.store.sqlite.prepare("SELECT runtime FROM agent_runs WHERE id = ?").get(String(sent.value?.runId)) as { runtime: string };
    expect(stored.runtime).toBe("pi");
    await app.call(actor, { commandId: "settings.setRuntime", idempotencyKey: "rt-native", input: { runtime: "native" } }, grant.handle);
    await app.call(actor, { commandId: "agent.cancel", idempotencyKey: "rt-cancel", input: { runId: sent.value?.runId } }, grant.handle);
    const finished = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
    expect(finished.value?.runtime).toBe("pi");
    const native = await completeText("openai-chat-completions", server.url, "k", { model: "demo", messages: [{ role: "user", content: "hi" }] }, "native");
    expect(native.text).toContain("hello");
    await server.close();
    app.close();
  });
});

describe("F-29 model purposes and file transcription", () => {
  it("probes embedding, clears old capabilities on upsert, and transcribes an authorized wav", async () => {
    const server = await startMockProvider();
    const { app, actor, grant, profileRoot } = await startApp();
    const secret = app.stashSecret("test-credential-value-for-vault");
    const embedding = await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "emb-conn", input: { label: "emb", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "emb", purpose: "embedding", credentialHandle: secret } }, grant.handle);
    const probed = await app.call(actor, { commandId: "connections.test", idempotencyKey: "emb-test", input: { connectionId: embedding.value?.id, capability: "embedding" } }, grant.handle);
    expect(probed.status).toBe("ok");
    const updated = await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "emb-upd", input: { id: embedding.value?.id, label: "emb", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "emb-2", purpose: "embedding" } }, grant.handle);
    expect(updated.status).toBe("ok");
    const verified = app.store.sqlite.prepare("SELECT verified_capabilities_json AS capabilities FROM provider_connections WHERE id = ?").get(String(embedding.value?.id)) as { capabilities: string };
    expect(verified.capabilities).toBe("[]");

    const asrSecret = app.stashSecret("asr-credential");
    const asr = await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "asr-conn", input: { label: "asr", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "whisper", purpose: "transcription", credentialHandle: asrSecret } }, grant.handle);
    const wav = writeTempWav(profileRoot);
    const handle = app.registerPath("file", wav);
    const transcript = await app.call(actor, { commandId: "library.transcribeAudio", idempotencyKey: "asr-file", input: { pathHandle: handle, connectionId: asr.value?.id } }, grant.handle);
    expect(transcript.status).toBe("ok");
    expect(String(transcript.value?.text)).toContain("transcript");
    expect(syntheticWav().byteLength).toBeGreaterThan(44);
    await server.close();
    app.close();
  });

  it("does not mark tools or streaming without a completed provider event", async () => {
    const server = await startMockProvider({ mode: "truncated-stream" });
    const { app, actor, grant } = await startApp();
    const secret = app.stashSecret("test-credential-value-for-vault");
    const saved = await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "strict-conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
    const tools = await app.call(actor, { commandId: "connections.test", idempotencyKey: "strict-tools", input: { connectionId: saved.value?.id, capability: "tools" } }, grant.handle);
    expect(tools.status).toBe("error");
    const verified = app.store.sqlite.prepare("SELECT verified_capabilities_json AS capabilities FROM provider_connections WHERE id = ?").get(String(saved.value?.id)) as { capabilities: string };
    expect(verified.capabilities).toBe("[]");
    await server.close();
    app.close();
  });
});

describe("F-30 settings and inventory", () => {
  it("reports needsSetup from connections, not from an empty workspace object", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    const settings = await app.call(actor, { commandId: "settings.get", idempotencyKey: "need-1", input: {} }, grant.handle);
    expect(settings.value?.needsSetup).toBe(true);
    expect(settings.value?.aiRuntime).toBe("native");
    await app.call(actor, { commandId: "library.importText", idempotencyKey: "need-imp", input: { title: "sized", bytes: [...Buffer.from("占用统计正文")] } }, grant.handle);
    const overview = await app.call(actor, { commandId: "inventory.overview", idempotencyKey: "need-ov", input: {} }, grant.handle);
    expect((overview.value?.totals as { resource: { bytes: number } }).resource.bytes).toBeGreaterThan(0);
    const external = path.join(os.tmpdir(), `manga-m1a-indexed-${process.pid}-${Date.now()}`);
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "keep.bin"), "abc");
    const handle = app.registerPath("directory", external);
    const indexed = await app.call(actor, { commandId: "library.indexExternal", idempotencyKey: "need-idx", input: { pathHandle: handle } }, grant.handle);
    expect(indexed.status).toBe("ok");
    expect(fs.existsSync(path.join(external, "keep.bin"))).toBe(true);
    const revealed = await app.call(actor, { commandId: "inventory.reveal", idempotencyKey: "need-rev", input: { id: indexed.value?.id } }, grant.handle);
    expect(revealed.status).toBe("ok");
    expect(revealed.value?.path).toBe(external);
    app.close();
  });

  it("persists a pointer location and cancels a batched scan", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    const pointerDir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1a-pointer-"));
    const handle = app.registerPath("directory", pointerDir);
    const saved = await app.call(actor, { commandId: "settings.setLayout", idempotencyKey: "lay-pointer", input: { pointerPathHandle: handle } }, grant.handle);
    expect(saved.status).toBe("ok");
    expect(String(saved.value?.pointerPath)).toContain("pointer.json");
    expect(fs.existsSync(String(saved.value?.pointerPath))).toBe(true);
    const settings = await app.call(actor, { commandId: "settings.get", idempotencyKey: "lay-get", input: {} }, grant.handle);
    expect((settings.value?.layoutConfig as { pointerPath?: string }).pointerPath).toBe(saved.value?.pointerPath);
    const refused = await app.call(actor, { commandId: "settings.setLayout", idempotencyKey: "lay-part", input: { partitions: { cache: handle } } }, grant.handle);
    expect(refused.status).toBe("error");
    expect(refused.error?.code).toBe("CAPABILITY_UNAVAILABLE");
    fs.rmSync(app.layout.partitions.cache, { recursive: true, force: true });
    const scan = app.call(actor, { commandId: "inventory.scan", idempotencyKey: "lay-scan", input: {} }, grant.handle);
    const cancelled = await app.call(actor, { commandId: "inventory.cancelScan", idempotencyKey: "lay-cancel", input: { scanId: "current" } }, grant.handle);
    expect(cancelled.status).toBe("ok");
    const scanned = await scan;
    expect(scanned.status).toBe("ok");
    const repaired = await app.call(actor, { commandId: "inventory.repair", idempotencyKey: "lay-repair", input: { id: "cache" } }, grant.handle);
    expect(repaired.status).toBe("ok");
    expect(fs.existsSync(app.layout.partitions.cache)).toBe(true);
    const overview = await app.call(actor, { commandId: "inventory.overview", idempotencyKey: "lay-ov", input: {} }, grant.handle);
    expect((overview.value?.items as Array<{ id: string }>).some((item) => item.id === "cache")).toBe(true);
    expect(profileRoot).toBeTruthy();
    app.close();
  });
});

describe("F-32 snapshot, retry and budgets", () => {
  it("keeps material revisions on retry and does not duplicate submitted tools", async () => {
    const server = await startMockProvider({
      streamToolName: "notes.create",
      streamToolArguments: '{"title":"from-agent","text":"tool-body"}',
    });
    const { app, actor, grant } = await startApp();
    const imported = await app.call(actor, { commandId: "library.importText", idempotencyKey: "snap-imp", input: { title: "src", bytes: [...Buffer.from("第一版正文")] } }, grant.handle);
    const secret = app.stashSecret("test-credential-value-for-vault");
    await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "snap-conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "snap-ses", input: {} }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "snap-send", input: { sessionId: session.value?.id, text: "note", readResourceIds: [String(imported.value?.resourceId)] } }, grant.handle);
    const first = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
    expect(first.value?.status).toBe("succeeded");
    const notesBefore = (app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM content_objects").get() as { n: number }).n;
    app.store.sqlite.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(
      "rev_new", imported.value?.resourceId, "new", "novel-parser-v1", JSON.stringify({ normalized: "第二版正文" }), new Date().toISOString(),
    );
    const agentRead = await app.call({ kind: "agent", id: `agent:${String(sent.value?.runId)}` }, {
      commandId: "library.getResource",
      idempotencyKey: "snap-read",
      input: { resourceId: imported.value?.resourceId },
    }, String(sent.value?.grantHandle));
    expect(agentRead.value?.revisionId).toBe(imported.value?.revisionId);
    const ownerRead = await app.call(actor, { commandId: "library.getResource", idempotencyKey: "snap-owner", input: { resourceId: imported.value?.resourceId } }, grant.handle);
    expect(ownerRead.value?.revisionId).toBe("rev_new");
    await app.store.sqlite.prepare("UPDATE agent_runs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), String(sent.value?.runId));
    const retried = await app.call(actor, { commandId: "agent.retry", idempotencyKey: "snap-retry", input: { runId: sent.value?.runId } }, grant.handle);
    expect(retried.value?.runId).toBe(sent.value?.runId);
    await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
    const notesAfter = (app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM content_objects").get() as { n: number }).n;
    expect(notesAfter).toBe(notesBefore);
    await server.close();
    app.close();
  });

  it("stops when the step budget is exhausted", async () => {
    const server = await startMockProvider({ mode: "always-tools", streamToolName: "library.find", streamToolArguments: '{"text":"x"}' });
    const { app, actor, grant } = await startApp();
    const secret = app.stashSecret("test-credential-value-for-vault");
    await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "bud-conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "bud-ses", input: {} }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "bud-send", input: { sessionId: session.value?.id, text: "loop" } }, grant.handle);
    const finished = await waitForRun(app, actor, grant.handle, String(sent.value?.runId), 20_000);
    expect(finished.value?.status).toBe("failed");
    expect((finished.value?.error as { code?: string }).code).toBe("BUDGET_EXCEEDED");
    await server.close();
    app.close();
  });

  it("resumes a committed tool after a disconnect without a second note", async () => {
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      requests += 1;
      if (requests === 2) { response.destroy(); return; }
      response.setHeader("content-type", "text/event-stream");
      const delta = requests === 1 || requests === 3
        ? { tool_calls: [{ index: 0, id: `call_${requests}`, type: "function", function: { name: "notes.create", arguments: JSON.stringify({ title: requests === 1 ? "first variation" : "retry variation", text: "synthetic" }) } }] }
        : { content: "done" };
      response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
    const { app, actor, grant } = await startApp();
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "disc-conn", input: { label: "synthetic", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "synthetic", purpose: "text", credentialHandle: app.stashSecret("synthetic-credential") } }, grant.handle);
      const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "disc-ses", input: {} }, grant.handle);
      const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "disc-send", input: { sessionId: session.value?.id, text: "create one synthetic note" } }, grant.handle);
      const first = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
      expect(first.value?.status).toBe("failed");
      const notesBefore = app.workspace().notes.length;
      expect(notesBefore).toBe(1);
      const deadline = app.store.sqlite.prepare("SELECT deadline_at AS deadline FROM agent_runs WHERE id = ?").get(String(sent.value?.runId)) as { deadline: string | null };
      const retried = await app.call(actor, { commandId: "agent.retry", idempotencyKey: "disc-retry", input: { runId: sent.value?.runId } }, grant.handle);
      const final = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
      const notesAfter = app.workspace().notes.length;
      expect(retried.value?.runId).toBe(sent.value?.runId);
      expect(final.value?.status).toBe("succeeded");
      expect(notesAfter).toBe(notesBefore);
      const later = app.store.sqlite.prepare("SELECT deadline_at AS deadline FROM agent_runs WHERE id = ?").get(String(sent.value?.runId)) as { deadline: string | null };
      expect(later.deadline).toBe(deadline.deadline);
    } finally {
      app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });
});

describe("F-24/25 reopen after migration", () => {
  it("opens the copied library after a successful switch", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    await app.call(actor, { commandId: "notes.create", idempotencyKey: "reopen-n", input: { title: "moved", text: "ok" } }, grant.handle);
    const moved = path.join(os.tmpdir(), `manga-m1a-reopen-${process.pid}-${Date.now()}`);
    const handle = app.registerPath("directory", moved);
    const proposed = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "reopen-p", input: { pathHandle: handle } }, grant.handle);
    const applied = await app.call(actor, { commandId: "settings.applyLocations", idempotencyKey: "reopen-a", input: { checkpointId: proposed.value?.checkpointId, pathHandle: handle } }, grant.handle);
    expect(applied.status).toBe("ok");
    app.close();
    const reopened = new MangaProductApp({
      profileRoot: moved,
      channel: "test",
      documentsDir: path.join(profileRoot, "documents"),
      pointerPath: path.join(profileRoot, "launcher", "pointer.json"),
      hostId: "reopened",
      vault: new TestVault("x"),
    });
    await reopened.start();
    expect(reopened.workspace().notes.map((note) => note.title)).toContain("moved");
    reopened.close();
  });
});
