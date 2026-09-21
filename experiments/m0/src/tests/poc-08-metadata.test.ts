import assert from "node:assert/strict";
import test from "node:test";
import { expectOk, startedApp, user, writeCases } from "./helpers.ts";

test("POC-08 dual fake metadata providers", async () => {
  const { app } = await startedApp(["library", "notes", "metadata"]);
  const imported = await app.call(user(), {
    commandId: "library.importText",
    idempotencyKey: "meta-work",
    input: { title: "local-aurora", bytes: [...Buffer.from("local copy")] },
  });
  expectOk(imported, "import");
  const {workId,resourceId} = imported.value as { workId:string;resourceId: string };
  assert.notEqual(workId,resourceId);
  const multi = await app.call(user(), {
    commandId: "metadata.query",
    idempotencyKey: "q-multi",
    input: { title: "极光旅人", mode: "multi", workId },
  });
  expectOk(multi, "multi");
  const value = multi.value as { review: string; merged: Record<string, { source: string; policy: string; value: unknown }>; candidates: unknown[] };
  assert.equal(value.review, "needs_review");
  assert.ok(value.candidates.length > 1);
  assert.deepEqual(value.merged,{},"ambiguous identities must not produce merged facts");
  const override = await app.call(user(), {
    commandId: "metadata.override",
    idempotencyKey: "ov-1",
    input: { workId, fields: { title: "用户锁定标题" }, locked: ["title"], cleared: ["score"] },
  });
  expectOk(override, "override");
  const after = await app.call(user(), {
    commandId: "metadata.query",
    idempotencyKey: "q-after",
    input: { title: "极光旅人", mode: "multi", workId },
  });
  const merged = (after.value as { merged: Record<string, { value: unknown; policy: string }> }).merged;
  assert.equal(merged.title?.value, "用户锁定标题");
  assert.equal(merged.title?.policy, "locked");
  assert.equal(merged.score?.policy, "empty");

  await app.runtime.deactivate("m0.metadata.hub");
  expectOk(await app.call(user(),{commandId:"metadata.override",idempotencyKey:"offline-override",input:{workId,fields:{title:"用户锁定标题"},locked:["title"],cleared:["score"]}}),"local override remains available without provider hub");
  const localEdit = await app.call(user(), {
    commandId: "notes.create",
    idempotencyKey: "offline-note",
    input: { title: "offline", text: "still here", resourceId },
  });
  expectOk(localEdit, "offline note");
  await app.runtime.activate("m0.metadata.hub");
  const again = await app.call(user(), {
    commandId: "metadata.query",
    idempotencyKey: "q-restore",
    input: { title: "极光旅人", mode: "single", workId },
  });
  expectOk(again, "restore");
  const restoredTitle = (again.value as { merged: Record<string, { value: unknown }> }).merged.title?.value;
  assert.equal(restoredTitle, "用户锁定标题");
  app.close();
  writeCases("poc-08", [
    {
      caseId: "POC-08/cross-medium-ambiguity",
      poc: "POC-08",
      title: "same title across mediums stays needs_review",
      status: "passed",
      expected: "needs_review",
      actual: value.review,
      kind: "automated",
    },
    {
      caseId: "POC-08/user-lock",
      poc: "POC-08",
      title: "user lock and explicit empty beat provider fields",
      status: "passed",
      expected: { title: "用户锁定标题", score: "empty" },
      actual: { title: merged.title?.value, score: merged.score?.policy },
      kind: "automated",
    },
    {
      caseId: "POC-08/disable-providers",
      poc: "POC-08",
      title: "local edits survive provider disable",
      status: "passed",
      expected: "用户锁定标题",
      actual: restoredTitle,
      kind: "automated",
    },
  ]);
});
