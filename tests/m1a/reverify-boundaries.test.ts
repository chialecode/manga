import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { startApp, waitForRun } from "./helpers.ts";
import { copyOwnedFile } from "../../packages/app-core/src/locations.ts";

describe("A independent failure boundaries", () => {
  it("F-24 preserves an unproven copy and a replaced committed file", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "manga-review-owned-"));
    try {
      const proposed = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "plan", input: { pathHandle: app.registerPath("directory", target) } }, grant.handle);
      const source = path.join(profileRoot, "source.txt");
      fs.writeFileSync(source, "synthetic owned content");
      const copied = path.join(target, "committed.txt");
      const fingerprint = copyOwnedFile(source, copied);
      const displaced = path.join(target, "displaced.txt");
      fs.renameSync(copied, displaced);
      fs.copyFileSync(displaced, copied); // Same bytes, different file ownership.
      const uncertain = path.join(target, "copying.txt");
      fs.writeFileSync(uncertain, "arrived during interrupted copy");
      const insert = app.store.sqlite.prepare("INSERT INTO migration_owned_files(job_id,partition,relative_path,absolute_path,state,fingerprint) VALUES (?,?,?,?,?,?)");
      insert.run(proposed.value?.checkpointId, "resources", "committed.txt", copied, "committed", fingerprint);
      insert.run(proposed.value?.checkpointId, "resources", "copying.txt", uncertain, "copying", null);
      const result = await app.call(actor, { commandId: "settings.recoverJobs", idempotencyKey: "rollback", input: { action: "rollback" } }, grant.handle);
      expect(fs.existsSync(copied)).toBe(true);
      expect(fs.existsSync(uncertain)).toBe(true);
      expect(result.value).toMatchObject({ removed: [], needsReview: [proposed.value?.checkpointId] });
    } finally { app.close(); }
  });

  it("F-24 never overwrites a copy destination that appeared after planning", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-review-exclusive-"));
    const source = path.join(dir, "source");
    const dest = path.join(dir, "dest");
    fs.writeFileSync(source, "owned");
    fs.writeFileSync(dest, "foreign");
    expect(() => copyOwnedFile(source, dest)).toThrow();
    expect(fs.readFileSync(dest, "utf8")).toBe("foreign");
  });

  it("F-26 refuses an unbound legacy receipt and a different task on the same actor", async () => {
    const { app, actor, grant } = await startApp();
    try {
      const request = { commandId: "notes.create", idempotencyKey: "legacy", input: { title: "private", text: "synthetic" } };
      expect((await app.call(actor, request, grant.handle)).status).toBe("ok");
      const scoped = app.grants.issue({ ...grant, handle: undefined, sessionId: "different-session", runId: "different-run" });
      expect((await app.call(actor, request, scoped.handle)).status).toBe("error");
      app.store.sqlite.prepare("UPDATE command_requests SET actor_kind=NULL, actor_id=NULL, grant_fingerprint=NULL WHERE idempotency_key=?").run("legacy");
      expect((await app.call(actor, request, grant.handle)).status).toBe("error");
      app.store.sqlite.prepare("DELETE FROM command_requests WHERE idempotency_key=?").run("legacy");
      const stranger = { kind: "user" as const, id: "stranger" };
      expect((await app.call(stranger, request, app.issueOwnerGrant(stranger).handle)).status).toBe("error");
    } finally { app.close(); }
  });

  it("F-26 re-evaluates inventory after its authorization shrinks", async () => {
    const { app, actor, grant } = await startApp();
    try {
      const note = await app.call(actor, { commandId: "notes.create", idempotencyKey: "note", input: { title: "hidden", text: "synthetic" } }, grant.handle);
      const agent = { kind: "agent" as const, id: "reader" };
      const scoped = app.issueAgentGrant(grant, agent, { sessionId: "session", runId: "run", readResourceIds: [] });
      app.grants.save({ ...scoped, writeObjectIds: [String(note.value?.objectId)] });
      const request = { commandId: "inventory.overview", idempotencyKey: "inventory", input: {} };
      expect((await app.call(agent, request, scoped.handle)).status).toBe("ok");
      app.grants.save({ ...scoped, writeObjectIds: [] });
      const replay = await app.call(agent, request, scoped.handle);
      expect(replay.status).toBe("ok");
      expect(replay.idempotentReplay).not.toBe(true);
      expect(replay.value?.items).toEqual([]);
    } finally { app.close(); }
  });

  it("F-26 checks pending task binding and narrowed or revoked object receipts", async () => {
    const { app, actor, grant } = await startApp();
    try {
      const otherTask = app.grants.issue({ ...grant, handle: undefined, sessionId: "other-task" });
      const scan = { commandId: "inventory.scan", idempotencyKey: "pending", input: {} };
      const first = app.call(actor, scan, grant.handle);
      expect((await app.call(actor, scan, otherTask.handle)).error?.code).toBe("FORBIDDEN");
      await first;
      const agent = { kind: "agent" as const, id: "writer" };
      const scoped = app.issueAgentGrant(grant, agent, { sessionId: "session", runId: "run", readResourceIds: [] });
      const request = { commandId: "notes.create", idempotencyKey: "bound-note", input: { title: "synthetic", text: "body" } };
      expect((await app.call(agent, request, scoped.handle)).status).toBe("ok");
      expect((await app.call(agent, request, scoped.handle)).idempotentReplay).toBe(true);
      app.grants.save({ ...scoped, writeObjectIds: [] });
      expect((await app.call(agent, request, scoped.handle)).error?.code).toBe("SCOPE_DENIED");
      app.grants.revoke(scoped.handle);
      expect((await app.call(agent, request, scoped.handle)).error?.code).toBe("GRANT_REVOKED");
    } finally { app.close(); }
  });

  it("F-29 does not verify an embedding capability from an empty vector list", async () => {
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { app, actor, grant } = await startApp();
    try {
      const saved = await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "empty-conn", input: { label: "synthetic", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, modelId: "synthetic", purpose: "embedding", credentialHandle: app.stashSecret("synthetic-key") } }, grant.handle);
      const result = await app.call(actor, { commandId: "connections.test", idempotencyKey: "empty-probe", input: { connectionId: saved.value?.id, capability: "embedding" } }, grant.handle);
      expect(result.error?.code).toBe("MODEL_CAPABILITY_MISSING");
      const row = app.store.sqlite.prepare("SELECT verified_capabilities_json AS capabilities FROM provider_connections WHERE id=?").get(saved.value?.id) as { capabilities: string };
      expect(row.capabilities).toBe("[]");
    } finally { app.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("F-32 rejects text streams without a terminal provider event", async () => {
    const server = await startMockProvider({ mode: "truncated-stream" });
    const { app, actor, grant } = await startApp();
    try {
      await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: app.stashSecret("synthetic-key") } }, grant.handle);
      const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "session", input: {} }, grant.handle);
      const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "send", input: { sessionId: session.value?.id, text: "synthetic prompt" } }, grant.handle);
      const result = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
      expect(result.value?.status).toBe("failed");
    } finally { app.close(); await server.close(); }
  });
});
