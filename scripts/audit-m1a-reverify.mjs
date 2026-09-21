import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { MangaProductApp, TestVault } from "../packages/app-core/src/index.ts";
import { startApp, waitForRun } from "../tests/m1a/helpers.ts";
import { sourceFingerprint, m1aSourceFingerprint } from "./m1a-fingerprint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const observations = [];

// A controlled parser barrier models work admitted before the location switch.
{
  const { app, actor, grant, profileRoot } = await startApp();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "manga-review-authority-"));
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  app.parseWorker = { parse: async () => { await barrier; return { normalized: "synthetic", parserVersion: "audit", bom: false }; }, kill() {} };
  try {
    const pending = app.call(actor, { commandId: "library.importText", idempotencyKey: "late-import", input: { title: "synthetic", bytes: [65] } }, grant.handle);
    const handle = app.registerPath("directory", target);
    const plan = await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "plan", input: { pathHandle: handle } }, grant.handle);
    const move = await app.call(actor, { commandId: "settings.applyLocations", idempotencyKey: "apply", input: { checkpointId: plan.value?.checkpointId } }, grant.handle);
    release();
    const late = await pending;
    observations.push({ finding: "F-25", scenario: "import admitted before switch finishes after switch", status: move.status === "ok" && late.status === "ok" ? "failed" : "passed", migration: move.status, lateImport: late.status, expected: "late write rejected by authoritative commit barrier" });
  } finally { release(); app.close(); }
  const old = new MangaProductApp({ profileRoot, channel: "test", documentsDir: path.join(profileRoot, "documents"), pointerPath: path.join(profileRoot, "launcher", "pointer.json"), vault: new TestVault("m1a-test-vault") });
  try {
    await old.start();
    const pointer = JSON.parse(fs.readFileSync(old.layout.pointerPath, "utf8"));
    const redirectedBack = path.resolve(pointer.profileRoot) === path.resolve(profileRoot);
    const write = await old.call(actor, { commandId: "notes.create", idempotencyKey: "stale-restart", input: { title: "synthetic", text: "stale" } }, old.issueOwnerGrant(actor).handle);
    observations.push({ finding: "F-25", scenario: "restart with the original explicit profile after migration", status: redirectedBack && write.status === "ok" ? "failed" : "passed", pointerRestoredToOldRoot: redirectedBack, oldLibraryWrite: write.status, expected: "reject or redirect relocated profile before publishing a pointer" });
  } finally { old.close(); }
}

{
  const { app, actor, grant } = await startApp();
  try {
    const resource = await app.call(actor, { commandId: "library.importText", idempotencyKey: "resource", input: { title: "synthetic", bytes: [...Buffer.from("version one")] } }, grant.handle);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "session", input: {} }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "send", input: { sessionId: session.value?.id, text: "synthetic", readResourceIds: [resource.value?.resourceId] } }, grant.handle);
    await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
    app.store.sqlite.prepare("INSERT INTO resource_revisions(id,resource_id,fingerprint,parser_version,payload_json,created_at) VALUES (?,?,?,?,?,?)").run("audit-revision", resource.value?.resourceId, "audit", "audit", JSON.stringify({ normalized: "version two" }), new Date().toISOString());
    const changed = await app.call({ kind: "agent", id: `agent:${sent.value?.runId}` }, { commandId: "library.contextSnapshot", idempotencyKey: "changed-material", input: { resourceId: resource.value?.resourceId, resourceRevisionId: "audit-revision" } }, String(sent.value?.grantHandle));
    observations.push({ finding: "F-32", scenario: "context tool requests a revision created after the run snapshot", status: changed.status === "ok" ? "failed" : "passed", contextStatus: changed.status, returnedLaterRevision: changed.value?.resourceRevisionId === "audit-revision", expected: "all run material tools enforce the captured revision" });
  } finally { app.close(); }
}

// After a committed tool and a broken next response, retry must resume its receipt instead of
// asking the model to regenerate a fresh variation of the same side effect.
{
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain synthetic request */ }
    requests += 1;
    if (requests === 2) { response.destroy(); return; }
    response.setHeader("content-type", "text/event-stream");
    const delta = requests === 1 || requests === 3
      ? { tool_calls: [{ index: 0, id: `call_${requests}`, type: "function", function: { name: "notes.create", arguments: JSON.stringify({ title: requests === 1 ? "first variation" : "retry variation", text: "synthetic" }) } }] }
      : { content: "done" };
    response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { app, actor, grant } = await startApp();
  try {
    await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "connection", input: { label: "synthetic", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: "synthetic", purpose: "text", credentialHandle: app.stashSecret("synthetic-credential") } }, grant.handle);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "retry-session", input: {} }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "retry-send", input: { sessionId: session.value?.id, text: "create one synthetic note" } }, grant.handle);
    const first = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
    const notesBefore = app.workspace().notes.length;
    const retried = await app.call(actor, { commandId: "agent.retry", idempotencyKey: "retry", input: { runId: sent.value?.runId } }, grant.handle);
    const final = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
    const notesAfter = app.workspace().notes.length;
    observations.push({ finding: "F-32", scenario: "committed tool then disconnect; retry returns a variation of its arguments", status: notesAfter > notesBefore ? "failed" : "passed", firstRun: first.value?.status, retriedWithSameId: retried.value?.runId === sent.value?.runId, finalRun: final.value?.status, notesBefore, notesAfter, expected: "resume committed tool results without regenerating a second business effect" });
  } finally { app.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

const evidence = path.resolve(root, process.env.M1A_EVIDENCE_DIR ?? "docs/evidence/m1a-f24-f32/a-reverify");
fs.mkdirSync(evidence, { recursive: true });
const record = { status: observations.some((item) => item.status === "failed") ? "open-findings-reproduced" : "no-open-finding-reproduced", at: new Date().toISOString(), sourceFingerprint: sourceFingerprint(root), m1aSourceFingerprint: m1aSourceFingerprint(root), observations, scope: "Synthetic temporary profiles only; audit failures are unresolved product requirements, not passing regression tests." };
fs.writeFileSync(path.join(evidence, "audit.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record));
process.exitCode = observations.some((item) => item.status === "failed") ? 1 : 0;
