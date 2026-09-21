import assert from "node:assert/strict";
import test from "node:test";
import { MangaError } from "@manga/contracts";
import { planComposition } from "@manga/kernel";
import { startedApp, user, agent, expectOk, writeCases } from "./helpers.ts";
import { startIpcClient } from "../hosts/ipc-client.ts";
import { isolateDir } from "../env.ts";
import type { ModuleManifest } from "@manga/contracts";

test("POC-04 lifecycle, gateway and independent host IPC", async () => {
  const { app } = await startedApp();
  const createdUi = await app.call(user(), {
    commandId: "notes.create",
    idempotencyKey: "note-ui-1",
    input: { title: "from-ui", text: "hello" },
  });
  const createdAgent = await app.call(agent(), {
    commandId: "notes.create",
    idempotencyKey: "note-agent-1",
    input: { title: "from-agent", text: "hello" },
  });
  expectOk(createdUi, "ui note");
  expectOk(createdAgent, "agent note");
  assert.notEqual((createdUi.value as { objectId: string }).objectId, (createdAgent.value as { objectId: string }).objectId);
  const replay = await app.call(user(), {
    commandId: "notes.create",
    idempotencyKey: "note-ui-1",
    input: { title: "from-ui", text: "hello" },
  });
  assert.equal(replay.idempotentReplay, true);
  const countsBefore: Record<string, number>[] = [];
  for (let i = 0; i < 50; i += 1) {
    await app.runtime.deactivate("m0.reader.novel");
    await app.runtime.activate("m0.reader.novel");
    countsBefore.push({ ...app.runtime.resourceTotals() });
  }
  const last = countsBefore.at(-1)!;
  const first = countsBefore[0]!;
  assert.ok((last.subscription ?? 0) <= (first.subscription ?? 0) + 1);

  const stale = app.runtime.gateway.sealFromTrusted({
    untrusted: { commandId: "notes.create", idempotencyKey: "stale-1", input: { title: "x", text: "y" } },
    actor: user(),
    scopeHandle: "library",
  });
  await app.runtime.deactivate("m0.notes");
  const denied = await app.runtime.gateway.execute(stale);
  assert.equal(denied.status, "error");
  assert.ok(denied.error?.code === "CAPABILITY_UNAVAILABLE" || denied.error?.code === "EPOCH_MISMATCH");

  app.runtime.bumpUnrelatedRegistry();
  await app.runtime.activate("m0.notes");
  const afterBump = await app.call(user(), {
    commandId: "notes.create",
    idempotencyKey: "after-bump",
    input: { title: "still-works", text: "ok" },
  });
  expectOk(afterBump, "unrelated registry bump");

  const profile = isolateDir("ipc");
  const client = startIpcClient(profile);
  const fromIpc = await client.send({
      commandId: "notes.create",
      idempotencyKey: "ipc-note",
      input: { title: "ipc", text: "across process" },
    });
  assert.equal((fromIpc as {status:string}).status,"ok");
  client.child.stdin.write("{not-json\n");
  const illegal = await client.send({commandId:"notes.create",idempotencyKey:"illegal-ipc",input:{text:12}}) as {status:string;error:{code:string}};
  assert.equal(illegal.error.code,"VALIDATION_ERROR");
  assert.ok(await client.snapshot(),"host survives malformed messages");
  await client.close();
  app.close();

  const manifests: ModuleManifest[] = [
    {
      moduleId: "a",
      version: "1",
      displayName: "A",
      featureId: "fa",
      contributes: [{ capabilityId: "cap.a", version: "1" }],
      needs: [{ capabilityId: "cap.b", version: "1", required: true, cardinality: "single" }],
      facets: ["service"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    {
      moduleId: "b",
      version: "1",
      displayName: "B",
      featureId: "fb",
      contributes: [{ capabilityId: "cap.b", version: "1" }],
      needs: [],
      facets: ["service"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
  ];
  const planned = planComposition(manifests, {
    profileId: "p",
    revision: 1,
    enabledFeatures: ["fa"],
    disabledFeatures: [],
    preferredProviders: {},
  });
  assert.deepEqual(planned.enabledModules, ["a", "b"]);
  assert.throws(() => planComposition(manifests, {
    profileId: "p",
    revision: 1,
    enabledFeatures: ["fa"],
    disabledFeatures: ["fb"],
    preferredProviders: {},
  }), MangaError);

  writeCases("poc-04", [
    {
      caseId: "POC-04/ui-agent-same-command",
      poc: "POC-04",
      title: "UI and fake Agent share notes.create",
      status: "passed",
      expected: "ok",
      actual: { ui: createdUi.status, agent: createdAgent.status, replay: replay.idempotentReplay },
      kind: "automated",
    },
    {
      caseId: "POC-04/start-stop-50",
      poc: "POC-04",
      title: "50 reader start/stop cycles without handle growth",
      status: "passed",
      expected: first,
      actual: last,
      kind: "automated",
    },
    {
      caseId: "POC-04/stale-epoch",
      poc: "POC-04",
      title: "deactivated module rejects in-flight sealed command",
      status: "passed",
      expected: "error",
      actual: denied.error?.code,
      kind: "automated",
    },
    {
      caseId: "POC-04/ipc-host",
      poc: "POC-04",
      title: "independent Node IPC host executes the same command",
      status: "passed",
      expected: "result",
      actual: fromIpc,
      kind: "automated",
    },
  ]);
});
