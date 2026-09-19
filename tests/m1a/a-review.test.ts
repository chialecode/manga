import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MangaProductApp, TestVault, exportLibraryPackage } from "@manga/app-core";
import { commandInputJsonSchema } from "@manga/contracts";
import { startMockProvider, streamText } from "@manga/model-protocol";
import { startApp, tempProfile, waitForRun } from "./helpers.ts";

const crashChild = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/app-core/src/crash-child.ts");

describe("A review: P1 grants", () => {
  it("issues agent grants without resource write rights and lets the agent edit only its own notes", async () => {
    const { app, actor, grant } = await startApp();
    const imported = await app.call(actor, { commandId: "library.importText", idempotencyKey: "w-imp", input: { title: "r", bytes: [...Buffer.from("正文")] } }, grant.handle);
    const agentGrant = app.issueAgentGrant(grant, { kind: "agent", id: "writer" }, { readResourceIds: [String(imported.value?.resourceId)] });
    expect(agentGrant.writeResourceIds).toEqual([]);
    expect(app.grants.canWriteResource(agentGrant, String(imported.value?.resourceId))).toBe(false);
    const userNote = await app.call(actor, { commandId: "notes.create", idempotencyKey: "w-user", input: { title: "mine", text: "user" } }, grant.handle);
    const foreignUndo = await app.call({ kind: "agent", id: "writer" }, { commandId: "notes.undo", idempotencyKey: "w-undo", input: { objectId: userNote.value?.objectId, expectedRevision: 1 } }, agentGrant.handle);
    expect(foreignUndo.status).toBe("error");
    expect(foreignUndo.error?.code).toBe("SCOPE_DENIED");
    app.close();
  });

  it("rejects idempotency key reuse across commands and path handles used as credentials", async () => {
    const { app, actor, grant } = await startApp();
    const first = await app.call(actor, { commandId: "notes.create", idempotencyKey: "reuse", input: { title: "a", text: "a" } }, grant.handle);
    expect(first.status).toBe("ok");
    const other = await app.call(actor, { commandId: "settings.get", idempotencyKey: "reuse", input: {} }, grant.handle);
    expect(other.status).toBe("error");
    expect(other.error?.code).toBe("VALIDATION_ERROR");
    const pathHandle = app.registerPath("directory", path.join(app.layout.defaultRoot, "somewhere"));
    const asCredential = await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "cred-path", input: { label: "x", protocol: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", modelId: "m", purpose: "text", credentialHandle: pathHandle } }, grant.handle);
    expect(asCredential.status).toBe("error");
    expect(asCredential.error?.code).toBe("FORBIDDEN");
    expect(app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM credentials").get()).toEqual({ n: 0 });
    app.close();
  });
});

describe("A review: P2 package and locations", () => {
  it("round-trips a package into an empty profile and restores search scope and attachments", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    const imported = await app.call(actor, { commandId: "library.importText", idempotencyKey: "rt-src", input: { title: "往返", bytes: [...Buffer.from("往返正文内容")] } }, grant.handle);
    await app.call(actor, { commandId: "notes.create", idempotencyKey: "rt-note", input: { title: "n", text: "恢复检索内容", resourceId: imported.value?.resourceId } }, grant.handle);
    fs.writeFileSync(path.join(app.store.attachmentsDir, "unknown.bin"), "unknown synthetic payload");
    const pack = path.join(profileRoot, "pack");
    const exportHandle = app.registerPath("export", pack);
    const exported = await app.call(actor, { commandId: "library.exportPackage", idempotencyKey: "rt-exp", input: { pathHandle: exportHandle } }, grant.handle);
    expect(exported.status).toBe("ok");
    app.close();

    const dest = await startApp();
    const importHandle = dest.app.registerPath("import", pack);
    const request = { commandId: "library.importPackage", idempotencyKey: "rt-imp", input: { pathHandle: importHandle } };
    const restored = await dest.app.call(dest.actor, request, dest.grant.handle);
    expect(restored.status).toBe("ok");
    expect((await dest.app.call(dest.actor, request, dest.grant.handle)).idempotentReplay).toBe(true);
    expect(dest.app.store.search({ text: "恢复检索" }).length).toBe(1);
    expect(dest.app.store.search({ text: "恢复检索", readAllowlist: [String(imported.value?.resourceId)] }).length).toBe(1);
    expect(dest.app.store.search({ text: "恢复检索", readAllowlist: ["foreign"] }).length).toBe(0);
    expect(dest.app.store.search({ text: "往返正文" }).length).toBe(1);
    expect(fs.readFileSync(path.join(dest.app.store.attachmentsDir, "unknown.bin"), "utf8")).toBe("unknown synthetic payload");
    expect(fs.readdirSync(dest.app.store.attachmentsDir).some((name) => name.startsWith(".import-"))).toBe(false);
    expect(dest.app.pendingRecoveryJobs()).toEqual([]);
    dest.app.close();

    const failed = await startApp();
    const manifestFile = path.join(pack, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { objects: unknown[] };
    manifest.objects.push(manifest.objects[0]);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const failedHandle = failed.app.registerPath("import", pack);
    const result = await failed.app.call(failed.actor, { commandId: "library.importPackage", idempotencyKey: "rt-bad", input: { pathHandle: failedHandle } }, failed.grant.handle);
    expect(result.status).toBe("error");
    expect(failed.app.store.counts().content_objects).toBe(0);
    expect(fs.readdirSync(failed.app.store.attachmentsDir)).toEqual([]);
    expect(failed.app.pendingRecoveryJobs()).toEqual([]);
    failed.app.close();
  });

  it("rolls back a package import interrupted after publish without touching foreign files", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    await app.call(actor, { commandId: "library.importText", idempotencyKey: "rb-src", input: { title: "pack", bytes: [...Buffer.from("package body")] } }, grant.handle);
    fs.writeFileSync(path.join(app.store.attachmentsDir, "sample.bin"), "payload");
    const dest = path.join(profileRoot, "bundle");
    exportLibraryPackage(app.store, dest);
    app.close();
    const empty = tempProfile();
    const result = spawnSync(process.execPath, ["--experimental-strip-types", crashChild, "--profile", empty, "--crash-at", "publish", "--op", "package.import", "--source", dest], { encoding: "utf8", timeout: 20_000, windowsHide: true });
    expect(result.status).toBe(99);
    const reopened = new MangaProductApp({ profileRoot: empty, channel: "test", documentsDir: path.join(empty, "documents"), pointerPath: path.join(empty, "launcher", "pointer.json"), hostId: "reopen", vault: new TestVault("x") });
    await reopened.start();
    const user = { kind: "user" as const, id: "r" };
    const owner = reopened.issueOwnerGrant(user);
    const settings = await reopened.call(user, { commandId: "settings.get", idempotencyKey: "rb-settings", input: {} }, owner.handle);
    const jobs = settings.value?.recoveryJobs as Array<{ kind: string; status: string }>;
    expect(jobs.map((job) => job.kind)).toEqual(["package-import"]);
    expect(reopened.store.counts().resources).toBe(0);
    fs.writeFileSync(path.join(reopened.store.attachmentsDir, "user-owned.bin"), "keep me");
    const rolled = await reopened.call(user, { commandId: "settings.recoverJobs", idempotencyKey: "rb-rollback", input: { action: "rollback" } }, owner.handle);
    expect(rolled.status).toBe("ok");
    expect(fs.readdirSync(reopened.store.attachmentsDir)).toEqual(["user-owned.bin"]);
    expect(reopened.pendingRecoveryJobs()).toEqual([]);
    reopened.close();
  });

  it("verifies copied partitions and excludes host lock files from the migrated root", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    await app.call(actor, { commandId: "notes.create", idempotencyKey: "mig-note", input: { title: "mig", text: "moved with me" } }, grant.handle);
    const moved = path.join(os.tmpdir(), `manga-m1a-verified-${process.pid}-${Date.now()}`);
    const handle = app.registerPath("directory", moved);
    const proposed = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "mig-p", input: { pathHandle: handle } }, grant.handle);
    expect(proposed.status).toBe("ok");
    const otherHandle = app.registerPath("directory", path.join(profileRoot, "other-root"));
    const wrongTarget = await app.call(actor, { commandId: "settings.applyLocations", idempotencyKey: "mig-wrong", input: { checkpointId: proposed.value?.checkpointId, pathHandle: otherHandle } }, grant.handle);
    expect(wrongTarget.status).toBe("error");
    const applied = await app.call(actor, { commandId: "settings.applyLocations", idempotencyKey: "mig-a", input: { checkpointId: proposed.value?.checkpointId, pathHandle: handle } }, grant.handle);
    expect(applied.status).toBe("ok");
    expect((applied.value?.verified as unknown[]).length).toBeGreaterThan(1);
    const movedData = fs.readdirSync(path.join(moved, "data"));
    expect(movedData).toContain("manga.sqlite");
    expect(movedData.some((name) => name.includes("WRITE_LOCK") || name.endsWith("-wal") || name.endsWith("-shm"))).toBe(false);
    app.close();
    const reopened = new MangaProductApp({ profileRoot: moved, channel: "test", documentsDir: path.join(profileRoot, "documents"), pointerPath: path.join(profileRoot, "launcher", "pointer.json"), hostId: "moved", vault: new TestVault("x") });
    await reopened.start();
    expect(reopened.workspace().notes.map((note) => note.title)).toContain("mig");
    reopened.close();
  });
});

describe("A review: P4 inventory", () => {
  it("reports a scan as cancelled when cancel arrives while it runs", async () => {
    const { app, actor, grant } = await startApp();
    const scan = app.call(actor, { commandId: "inventory.scan", idempotencyKey: "scan-c", input: {} }, grant.handle);
    const cancel = await app.call(actor, { commandId: "inventory.cancelScan", idempotencyKey: "cancel-c", input: { scanId: "current" } }, grant.handle);
    expect(cancel.value?.cancelled).toBe(true);
    const result = await scan;
    expect(result.status).toBe("ok");
    expect(result.value?.cancelled).toBe(true);
    const overview = await app.call(actor, { commandId: "inventory.overview", idempotencyKey: "ov-c", input: {} }, grant.handle);
    expect(overview.value?.cancelled).toBe(false);
    app.close();
  });
});

describe("A review: P3/P5 agent loop", () => {
  it("does not execute a tool when the stream drops before completion", async () => {
    const server = await startMockProvider({ mode: "truncated-stream" });
    const { app, actor, grant } = await startApp();
    const secret = app.stashSecret("test-credential-value-for-vault");
    await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "cut-conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "cut-ses", input: {} }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "cut-send", input: { sessionId: session.value?.id, text: "go" } }, grant.handle);
    expect(sent.status).toBe("ok");
    const finished = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
    expect(finished.value?.status).toBe("failed");
    expect((finished.value?.error as { retryable?: boolean } | undefined)?.retryable).toBe(true);
    expect((app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM content_objects").get() as { n: number }).n).toBe(0);
    const run = app.store.sqlite.prepare("SELECT status FROM agent_runs ORDER BY created_at DESC LIMIT 1").get() as { status: string };
    expect(run.status).toBe("failed");
    await server.close();
    app.close();
  });

  it("advertises tools with the real input schema instead of an open object", () => {
    const schema = commandInputJsonSchema("notes.create") as { properties: Record<string, unknown>; additionalProperties?: boolean; required?: string[] };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["title", "text"]));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(["title", "text"]));
    expect(commandInputJsonSchema("no.such.command")).toBeUndefined();
  });

  it("cancel on a finished run reports nothing to cancel", async () => {
    const { app, actor, grant } = await startApp();
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "fin-ses", input: {} }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "fin-send", input: { sessionId: session.value?.id, text: "no model" } }, grant.handle);
    expect(sent.status).toBe("ok");
    await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
    const cancel = await app.call(actor, { commandId: "agent.cancel", idempotencyKey: "fin-cancel", input: { runId: sent.value?.runId } }, grant.handle);
    expect(cancel.value?.cancelled).toBe(false);
    const run = app.store.sqlite.prepare("SELECT status FROM agent_runs WHERE id = ?").get(String(sent.value?.runId)) as { status: string };
    expect(run.status).toBe("succeeded");
    app.close();
  });
});

describe("A review: connections", () => {
  it("deleting a connection also removes its stored credential ciphertext", async () => {
    const { app, actor, grant } = await startApp();
    const secret = app.stashSecret("test-credential-value-for-vault");
    const saved = await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "del-conn", input: { label: "x", protocol: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", modelId: "m", purpose: "text", credentialHandle: secret } }, grant.handle);
    expect((app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n).toBe(1);
    const removed = await app.call(actor, { commandId: "connections.delete", idempotencyKey: "del-1", input: { connectionId: saved.value?.id } }, grant.handle);
    expect(removed.value?.credentialRemoved).toBe(true);
    expect((app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n).toBe(0);
    app.close();
  });
});

describe("A review: streaming tool-call reassembly", () => {
  it("keeps call id and name across real-shape chunks for both protocols", async () => {
    const server = await startMockProvider({ streamToolName: "library.find", streamToolArguments: '{"text":"中文 检索"}' });
    for (const protocol of ["openai-chat-completions", "openai-responses"] as const) {
      const calls = new Map<string, { name: string; args: string }>();
      for await (const event of streamText(protocol, server.url, "k", {
        model: "demo",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "library.find", description: "find", parameters: { type: "object", properties: { text: { type: "string" } } } }],
      })) {
        if (event.type !== "tool-call-delta") continue;
        const current = calls.get(event.callId) ?? { name: event.name, args: "" };
        current.args += event.argumentsDelta;
        calls.set(event.callId, current);
      }
      expect([...calls.keys()]).toEqual(["call_1"]);
      expect(calls.get("call_1")?.name).toBe("library.find");
      expect(JSON.parse(calls.get("call_1")?.args ?? "")).toEqual({ text: "中文 检索" });
    }
    await server.close();
  });
});
