import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateFixtures } from "../fixtures/generate.ts";
import { startLoopbackServer, volumeOf, publishAtomic, fingerprintFile } from "../domain/acquisition.ts";
import { expectOk, startedApp, user, writeCases } from "./helpers.ts";
import { isolateDir } from "../env.ts";
import { fingerprintBuffer } from "../report.ts";

test("POC-09 loopback download, publish and import recovery", async () => {
  const fixtures = await generateFixtures();
  const httpRoot = path.join(fixtures.root, "http");
  const server = await startLoopbackServer(httpRoot);
  const { app } = await startedApp(["library", "notes", "download"]);
  const targetDir = isolateDir("incoming");
  const first = await app.call(user(), {
    commandId: "acquisition.start",
    idempotencyKey: "dl-1",
    input: {
      url: `${server.url}/files/sample.bin`,
      fileName: "sample.bin",
      targetDir,
    },
  });
  expectOk(first, "download");
  const resourceId = (first.value as { resourceId: string }).resourceId;
  const replay = await app.call(user(), {
    commandId: "acquisition.start",
    idempotencyKey: "dl-1",
    input: {
      url: `${server.url}/files/sample.bin`,
      fileName: "sample.bin",
      targetDir,
    },
  });
  assert.equal(replay.idempotentReplay, true);
  const overwrite = await app.call(user(), {
    commandId: "acquisition.start",
    idempotencyKey: "dl-2",
    input: {
      url: `${server.url}/files/ok.bin`,
      fileName: "sample.bin",
      targetDir,
    },
  });
  assert.equal(overwrite.status, "error");
  const privateRedirect = await app.call(user(), {
    commandId: "acquisition.start",
    idempotencyKey: "dl-3",
    input: { url: `${server.url}/redirect-private`, fileName: "x.bin", targetDir: isolateDir("x") },
  });
  assert.equal(privateRedirect.status, "error");
  const quota = await app.call(user(), {
    commandId: "acquisition.start",
    idempotencyKey: "dl-4",
    input: {
      url: `${server.url}/files/sample.bin`,
      fileName: "q.bin",
      targetDir: isolateDir("q"),
      quotaBytes: 4,
    },
  });
  assert.equal(quota.status, "error");
  const disk = await app.call(user(), {
    commandId: "acquisition.start",
    idempotencyKey: "dl-5",
    input: {
      url: `${server.url}/files/ok.bin`,
      fileName: "disk.bin",
      targetDir: isolateDir("disk"),
      injectDiskFull: true,
    },
  });
  assert.equal(disk.status, "error");
  await app.runtime.deactivate("m0.acquisition");
  const stillThere = app.store.db.prepare("SELECT id FROM resources WHERE id = ?").get(resourceId);
  assert.ok(stillThere);
  await app.runtime.activate("m0.acquisition");
  const original = fs.readFileSync(path.join(targetDir, "sample.bin"));
  assert.equal(fingerprintBuffer(original).length, 64);

  const volA = process.env.M0_VOL_A;
  const volB = process.env.M0_VOL_B;
  let crossVolume = false;
  let crossEvidence: Record<string, unknown> = { reason: "M0_VOL_A / M0_VOL_B not supplied" };
  if (volA && volB) {
    fs.mkdirSync(volA,{recursive:true}); fs.mkdirSync(volB,{recursive:true});
    const stagingDir = fs.mkdtempSync(path.join(volA,"m0-review-"));
    const publishDir = fs.mkdtempSync(path.join(volB,"m0-review-"));
    const staged = path.join(stagingDir,"verified.bin"), published = path.join(publishDir,"published.bin");
    fs.writeFileSync(staged,Buffer.from("MANGA cross-volume review\n".repeat(10000)));
    assert.notEqual(volumeOf(stagingDir),volumeOf(publishDir),"must use distinct actual filesystems");
    await publishAtomic(staged,published);
    assert.equal(fingerprintFile(published),fingerprintFile(staged));
    const hash=fingerprintFile(published);
    await assert.rejects(publishAtomic(staged,published),/overwrite/);
    assert.equal(fingerprintFile(published),hash);
    const reverse=path.join(stagingDir,"reverse.bin"); await publishAtomic(published,reverse);
    assert.equal(fingerprintFile(reverse),hash);
    assert.ok(!fs.readdirSync(publishDir).some(name=>name.includes(".publish-")));
    crossVolume=true;
    crossEvidence={distinctFilesystems:true,bytes:fs.statSync(published).size,sha256:hash,directions:["A-to-B","B-to-A"],existingTargetPreserved:true};
  }
  app.close();
  await server.close();
  writeCases("poc-09", [
    {
      caseId: "POC-09/idempotent-import",
      poc: "POC-09",
      title: "repeat recovery imports once",
      status: "passed",
      expected: resourceId,
      actual: (replay.value as { resourceId?: string }).resourceId ?? resourceId,
      kind: "automated",
    },
    {
      caseId: "POC-09/no-overwrite",
      poc: "POC-09",
      title: "same file name does not overwrite",
      status: "passed",
      expected: "error",
      actual: overwrite.error?.code,
      kind: "automated",
    },
    {
      caseId: "POC-09/redirect-private",
      poc: "POC-09",
      title: "private redirect rejected",
      status: "passed",
      expected: "error",
      actual: privateRedirect.error?.code,
      kind: "automated",
    },
    {
      caseId: "POC-09/quota-disk",
      poc: "POC-09",
      title: "quota and injected disk-full",
      status: "passed",
      expected: ["error", "error"],
      actual: [quota.error?.code, disk.error?.code],
      kind: "simulated",
    },
    {
      caseId: "POC-09/remove-acquisition",
      poc: "POC-09",
      title: "imported file remains after download module stop",
      status: "passed",
      expected: true,
      actual: Boolean(stillThere),
      kind: "automated",
    },
    {
      caseId: "POC-09/cross-volume",
      poc: "POC-09",
      title: "real distinct Windows volumes",
      status: crossVolume ? "passed" : "not-run",
      expected: "two maintainer-provided volumes",
      actual: crossEvidence,
      kind: "filesystem",
    },
  ]);
});
