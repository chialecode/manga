import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startMockProvider, streamText } from "@manga/model-protocol";
import { MangaProductApp, TestVault } from "@manga/app-core";
import { startApp, waitForRun } from "./helpers.ts";

const crashChild = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/app-core/src/crash-child.ts");
const actor = { kind: "user" as const, id: "tester" };

function reopen(profileRoot: string, launchRoot: string, hostId: string) {
  return new MangaProductApp({
    profileRoot,
    channel: "test",
    documentsDir: path.join(launchRoot, "documents"),
    pointerPath: path.join(launchRoot, "launcher", "pointer.json"),
    hostId,
    vault: new TestVault("m1a-test-vault"),
  });
}

async function migrate(app: MangaProductApp, grantHandle: string, target: string) {
  const handle = app.registerPath("directory", target);
  const proposed = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: `plan-${path.basename(target)}`, input: { pathHandle: handle } }, grantHandle);
  expect(proposed.status).toBe("ok");
  const applied = await app.call(actor, { commandId: "settings.applyLocations", idempotencyKey: `apply-${path.basename(target)}`, input: { checkpointId: proposed.value?.checkpointId, pathHandle: handle } }, grantHandle);
  expect(applied.status).toBe("ok");
  return String(proposed.value?.checkpointId);
}

function tempTarget(label: string): string {
  return path.join(os.tmpdir(), `manga-m1a-rev-${label}-${process.pid}-${Date.now()}`);
}

describe("A re-verification: F-24/F-25 sealed host after a location switch", () => {
  it("refuses rollback and new plans on the sealed old host and keeps the published library", async () => {
    const { app, grant } = await startApp();
    const target = tempTarget("sealed");
    try {
      await app.call(actor, { commandId: "notes.create", idempotencyKey: "sealed-note", input: { title: "keep", text: "body" } }, grant.handle);
      const checkpointId = await migrate(app, grant.handle, target);
      const localJob = app.store.sqlite.prepare("SELECT status, stage FROM recovery_jobs WHERE id = ?").get(checkpointId) as { status: string; stage: string };
      expect(localJob).toEqual({ status: "succeeded", stage: "done" });
      const settings = await app.call(actor, { commandId: "settings.get", idempotencyKey: "sealed-settings", input: {} }, grant.handle);
      expect(settings.value?.recoveryJobs).toEqual([]);
      expect(settings.value?.restartRequired).toBe(true);
      const rollback = await app.call(actor, { commandId: "settings.recoverJobs", idempotencyKey: "sealed-rollback", input: { action: "rollback" } }, grant.handle);
      expect(rollback.status).toBe("error");
      expect(rollback.error?.code).toBe("RESTART_REQUIRED");
      const again = app.registerPath("directory", tempTarget("sealed-again"));
      const plan = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "sealed-plan", input: { pathHandle: again } }, grant.handle);
      expect(plan.status).toBe("error");
      expect(plan.error?.code).toBe("RESTART_REQUIRED");
      expect(fs.existsSync(path.join(target, "data", "manga.sqlite"))).toBe(true);
    } finally {
      app.close();
    }
  });

  it("treats a job whose target is the already published root as needs-review even when its row looks unfinished", async () => {
    const { app, grant, profileRoot } = await startApp();
    const target = tempTarget("published");
    let checkpointId = "";
    try {
      checkpointId = await migrate(app, grant.handle, target);
    } finally {
      app.close();
    }
    // A restored backup of the old root may still carry the pre-switch row.
    const stale = reopen(profileRoot, profileRoot, "stale-copy");
    await stale.start();
    try {
      stale.store.sqlite.prepare("UPDATE recovery_jobs SET status = 'running', stage = 'copy' WHERE id = ?").run(checkpointId);
      const staleGrant = stale.issueOwnerGrant(actor);
      const rollback = await stale.call(actor, { commandId: "settings.recoverJobs", idempotencyKey: "stale-rollback", input: { action: "rollback" } }, staleGrant.handle);
      expect(rollback.status).toBe("ok");
      expect(rollback.value).toMatchObject({ removed: [], needsReview: [checkpointId] });
      expect(fs.existsSync(path.join(target, "data", "manga.sqlite"))).toBe(true);
    } finally {
      stale.close();
    }
  });

  it("rolls back only the files a crashed copy owned and keeps foreign files at the target", async () => {
    const { app, grant, profileRoot } = await startApp();
    await app.call(actor, { commandId: "notes.create", idempotencyKey: "crash-note", input: { title: "before", text: "copy" } }, grant.handle);
    const pointer = fs.readFileSync(app.layout.pointerPath, "utf8");
    app.close();
    const target = tempTarget("crash");
    fs.mkdirSync(target, { recursive: true });
    const foreignRoot = path.join(target, "foreign.txt");
    fs.writeFileSync(foreignRoot, "not owned by the migration");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", crashChild, "--profile", profileRoot, "--crash-at", "location-copy", "--op", "locations.apply", "--target", target], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    expect(result.status).toBe(99);
    expect(fs.readFileSync(path.join(profileRoot, "launcher", "pointer.json"), "utf8")).toBe(pointer);
    const copiedDb = path.join(target, "data", "manga.sqlite");
    expect(fs.existsSync(copiedDb)).toBe(true);
    const foreignInside = path.join(target, "data", "user-dropped.txt");
    fs.writeFileSync(foreignInside, "added after the crash");
    const recovered = reopen(profileRoot, profileRoot, "recover");
    await recovered.start();
    try {
      const recoveredGrant = recovered.issueOwnerGrant(actor);
      const pending = await recovered.call(actor, { commandId: "settings.get", idempotencyKey: "crash-settings", input: {} }, recoveredGrant.handle);
      expect((pending.value?.recoveryJobs as Array<{ status: string }>).map((job) => job.status)).toEqual(["running"]);
      const rollback = await recovered.call(actor, { commandId: "settings.recoverJobs", idempotencyKey: "crash-rollback", input: { action: "rollback" } }, recoveredGrant.handle);
      expect(rollback.status).toBe("ok");
      const removed = (rollback.value as { removed: string[]; needsReview: string[] });
      expect(removed.needsReview).toEqual([]);
      expect(removed.removed.map((file) => path.resolve(file))).toContain(path.resolve(copiedDb));
      expect(fs.existsSync(copiedDb)).toBe(false);
      expect(fs.existsSync(foreignRoot)).toBe(true);
      expect(fs.existsSync(foreignInside)).toBe(true);
      expect(recovered.workspace().notes.map((note) => note.title)).toContain("before");
      const rows = recovered.store.sqlite.prepare("SELECT COUNT(*) AS n FROM migration_owned_files").get() as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      recovered.close();
    }
  });
});

describe("A re-verification: F-30 relocation plans", () => {
  it("rejects per-partition plans without leaving a checkpoint and refuses to index the data partition", async () => {
    const { app, grant } = await startApp();
    try {
      const partition = app.registerPath("directory", tempTarget("partition"));
      const perPartition = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "plan-partition", input: { partitions: { attachments: partition } } }, grant.handle);
      expect(perPartition.status).toBe("error");
      expect(perPartition.error?.code).toBe("CAPABILITY_UNAVAILABLE");
      const jobs = app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM recovery_jobs").get() as { n: number };
      expect(jobs.n).toBe(0);
      const root = app.registerPath("directory", tempTarget("index-data"));
      const indexData = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "plan-index-data", input: { pathHandle: root, indexedOnly: ["data"] } }, grant.handle);
      expect(indexData.status).toBe("error");
      expect(indexData.error?.code).toBe("VALIDATION_ERROR");
      const applyUnknown = await app.call(actor, { commandId: "settings.applyLocations", idempotencyKey: "apply-unknown", input: { checkpointId: "ckpt_missing" } }, grant.handle);
      expect(applyUnknown.error?.code).toBe("NOT_FOUND");
    } finally {
      app.close();
    }
  });

  it("keeps index-only originals in place and records them as an indexed root inside the moved library", async () => {
    const { app, grant, profileRoot } = await startApp();
    const oldResources = app.layout.partitions.resources;
    const original = path.join(oldResources, "volume-01.bin");
    fs.writeFileSync(original, "synthetic resource bytes");
    fs.writeFileSync(path.join(app.layout.partitions.attachments, "att.bin"), "attachment");
    const target = tempTarget("indexed");
    try {
      const handle = app.registerPath("directory", target);
      const proposed = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "plan-indexed", input: { pathHandle: handle, indexedOnly: ["resources"] } }, grant.handle);
      expect(proposed.status).toBe("ok");
      const applied = await app.call(actor, { commandId: "settings.applyLocations", idempotencyKey: "apply-indexed", input: { checkpointId: proposed.value?.checkpointId, pathHandle: handle } }, grant.handle);
      expect(applied.status).toBe("ok");
      expect((applied.value?.verified as Array<{ partition: string }>).map((item) => item.partition)).not.toContain("resources");
    } finally {
      app.close();
    }
    expect(fs.existsSync(original)).toBe(true);
    expect(fs.existsSync(path.join(target, "resources", "volume-01.bin"))).toBe(false);
    const moved = reopen(target, profileRoot, "moved");
    await moved.start();
    try {
      const movedGrant = moved.issueOwnerGrant(actor);
      const overview = await moved.call(actor, { commandId: "inventory.overview", idempotencyKey: "indexed-overview", input: {} }, movedGrant.handle);
      const items = overview.value?.items as Array<{ kind: string; title: string; location?: string; available: boolean; bytes: number }>;
      const root = items.find((item) => item.kind === "indexed-root");
      expect(root).toBeDefined();
      expect(path.resolve(root!.location!)).toBe(path.resolve(oldResources));
      expect(root!.available).toBe(true);
      expect(root!.bytes).toBeGreaterThan(0);
      expect(items.find((item) => item.kind === "attachment" && item.title === "att.bin")?.available).toBe(true);
    } finally {
      moved.close();
    }
  });
});

describe("A re-verification: F-27 interrupted runs", () => {
  it("marks an in-flight run interrupted on close and lets the reopened host retry it", async () => {
    const server = await startMockProvider({ mode: "timeout" });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    const { app, grant, profileRoot } = await startApp();
    const secret = app.stashSecret("test-credential-value-for-vault");
    await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "int-conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "int-ses", input: {} }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "int-send", input: { sessionId: session.value?.id, text: "hang" } }, grant.handle);
    expect(sent.value?.status).toBe("running");
    const runId = String(sent.value?.runId);
    app.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const again = reopen(profileRoot, profileRoot, "reopened");
    await again.start();
    try {
      const againGrant = again.issueOwnerGrant(actor);
      const run = await again.call(actor, { commandId: "agent.getRun", idempotencyKey: "int-get", input: { runId } }, againGrant.handle);
      expect(run.value?.status).toBe("interrupted");
      expect((run.value?.error as { code: string }).code).toBe("INTERRUPTED");
      const retried = await again.call(actor, { commandId: "agent.retry", idempotencyKey: "int-retry", input: { runId } }, againGrant.handle);
      expect(retried.status).toBe("ok");
      expect(retried.value?.runId).toBe(runId);
      await again.call(actor, { commandId: "agent.cancel", idempotencyKey: "int-cancel", input: { runId } }, againGrant.handle);
      const finished = await waitForRun(again, actor, againGrant.handle, runId);
      expect(finished.value?.status).toBe("cancelled");
    } finally {
      again.close();
      await server.close();
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it("interrupts running tasks before the library moves", async () => {
    const server = await startMockProvider({ mode: "timeout" });
    const { app, grant } = await startApp();
    try {
      const secret = app.stashSecret("test-credential-value-for-vault");
      await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "mv-conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
      const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "mv-ses", input: {} }, grant.handle);
      const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "mv-send", input: { sessionId: session.value?.id, text: "hang" } }, grant.handle);
      const runId = String(sent.value?.runId);
      await migrate(app, grant.handle, tempTarget("move-run"));
      const run = await app.call(actor, { commandId: "agent.getRun", idempotencyKey: "mv-get", input: { runId } }, grant.handle);
      expect(run.value?.status).toBe("interrupted");
    } finally {
      app.close();
      await server.close();
    }
  });
});

describe("A re-verification: F-28 PI runtime", () => {
  const schema = { type: "object", properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title", "text"], additionalProperties: false };

  it("defaults to native and persists the runtime choice across restart", async () => {
    const { app, grant, profileRoot } = await startApp();
    expect((await app.call(actor, { commandId: "settings.get", idempotencyKey: "default-rt", input: {} }, grant.handle)).value?.aiRuntime).toBe("native");
    await app.call(actor, { commandId: "settings.setRuntime", idempotencyKey: "save-pi", input: { runtime: "pi" } }, grant.handle);
    app.close();
    const again = reopen(profileRoot, profileRoot, "runtime-reopened");
    await again.start();
    try {
      expect((await again.call(actor, { commandId: "settings.get", idempotencyKey: "saved-rt", input: {} }, again.issueOwnerGrant(actor).handle)).value?.aiRuntime).toBe("pi");
    } finally { again.close(); }
  });

  it("advertises the contract tool schema through PI for both protocols", async () => {
    const bodies: Array<Record<string, any>> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("content-type", "text/event-stream");
      if ((req.url ?? "").endsWith("/responses")) {
        const done = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
        res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...done, status: "in_progress", content: [] } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "ok" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: done })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [done] } })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    try {
      for (const protocol of ["openai-chat-completions", "openai-responses"] as const) {
        for await (const _event of streamText(protocol, url, "k", {
          model: "demo",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ name: "notes.create", description: "create", parameters: schema }],
        }, "pi")) { /* drain */ }
      }
      expect(bodies).toHaveLength(2);
      expect(bodies[0].tools[0].function.parameters).toEqual(schema);
      expect(bodies[1].tools[0].parameters).toEqual(schema);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports the provider call id and completes an agent tool run through PI on the Responses protocol", async () => {
    const server = await startMockProvider({ streamToolName: "notes.create", streamToolArguments: JSON.stringify({ title: "from-pi", text: "pi-body" }) });
    const calls = new Map<string, string>();
    for await (const event of streamText("openai-responses", server.url, "k", { model: "demo", messages: [{ role: "user", content: "hi" }], tools: [{ name: "notes.create", description: "create", parameters: schema }] }, "pi")) {
      if (event.type === "tool-call-delta") calls.set(event.callId, (calls.get(event.callId) ?? "") + event.argumentsDelta);
    }
    expect([...calls.keys()]).toEqual(["call_1"]);
    expect(JSON.parse(calls.get("call_1") ?? "")).toEqual({ title: "from-pi", text: "pi-body" });

    const { app, grant } = await startApp();
    try {
      await app.call(actor, { commandId: "settings.setRuntime", idempotencyKey: "pi-rt", input: { runtime: "pi" } }, grant.handle);
      const secret = app.stashSecret("test-credential-value-for-vault");
      await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "pi-conn", input: { label: "mock", protocol: "openai-responses", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
      const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "pi-ses", input: {} }, grant.handle);
      const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "pi-send", input: { sessionId: session.value?.id, text: "note" } }, grant.handle);
      const finished = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
      expect(finished.value?.status).toBe("succeeded");
      expect(finished.value?.runtime).toBe("pi");
      expect((finished.value?.tools as Array<{ commandId: string; status: string }>)).toEqual([{ commandId: "notes.create", status: "executed", result: expect.anything() }]);
      expect(app.workspace().notes.map((note) => note.title)).toEqual(["from-pi"]);
    } finally {
      app.close();
      await server.close();
    }
  });

  it("maps PI provider faults to the same public codes as the native runtime", async () => {
    for (const [mode, code] of [["unauthorized", "AUTHENTICATION_FAILED"], ["rate-limited", "RATE_LIMITED"], ["disconnect", "PROVIDER_UNAVAILABLE"]] as const) {
      const server = await startMockProvider({ mode });
      try {
        for (const runtime of ["native", "pi"] as const) {
          const drain = async () => {
            for await (const _event of streamText("openai-chat-completions", server.url, "k", { model: "demo", messages: [{ role: "user", content: "hi" }], timeoutMs: 5_000 }, runtime)) { /* drain */ }
          };
          await expect(drain()).rejects.toMatchObject({ code });
        }
      } finally {
        await server.close();
      }
    }
  });
});

describe("A re-verification: F-32 session history", () => {
  it.each(["native", "pi"] as const)("feeds earlier completed turns of the same session to the model and keeps sessions apart (%s)", async (runtime) => {
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      body.messages = body.messages.map((message: { role: string; content: string | Array<{ text: string }> }) => ({ role: message.role, content: typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join("") }));
      requests.push(body);
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `reply ${requests.length}` }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const { app, grant } = await startApp();
    try {
      await app.call(actor, { commandId: "settings.setRuntime", idempotencyKey: "hist-runtime", input: { runtime } }, grant.handle);
      const secret = app.stashSecret("test-credential-value-for-vault");
      await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "hist-conn", input: { label: "capture", protocol: "openai-chat-completions", baseUrl: url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
      const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "hist-ses", input: {} }, grant.handle);
      const first = await app.call(actor, { commandId: "agent.send", idempotencyKey: "hist-send-1", input: { sessionId: session.value?.id, text: "第一轮问题" } }, grant.handle);
      expect((await waitForRun(app, actor, grant.handle, String(first.value?.runId))).value?.status).toBe("succeeded");
      const second = await app.call(actor, { commandId: "agent.send", idempotencyKey: "hist-send-2", input: { sessionId: session.value?.id, text: "第二轮问题" } }, grant.handle);
      expect((await waitForRun(app, actor, grant.handle, String(second.value?.runId))).value?.status).toBe("succeeded");
      expect(requests[1].messages).toEqual([
        { role: "user", content: "第一轮问题" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "第二轮问题" },
      ]);
      const other = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "hist-ses-2", input: {} }, grant.handle);
      const third = await app.call(actor, { commandId: "agent.send", idempotencyKey: "hist-send-3", input: { sessionId: other.value?.id, text: "另一会话" } }, grant.handle);
      expect((await waitForRun(app, actor, grant.handle, String(third.value?.runId))).value?.status).toBe("succeeded");
      expect(requests[2].messages).toEqual([{ role: "user", content: "另一会话" }]);
    } finally {
      app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
