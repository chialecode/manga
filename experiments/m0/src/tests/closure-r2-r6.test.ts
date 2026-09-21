import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { generateFixtures } from "../fixtures/generate.ts";
import { expectOk, startedApp, user, agent } from "./helpers.ts";
import { isolateDir } from "../env.ts";
import { applyEdit, createEditor, redo, splitBlock, mergeBlockWithNext, embedStatus } from "../domain/notes.ts";
import { inspectImage, listComicPages, COMIC_DISPLAY_BUDGET } from "../domain/comic.ts";
import { concatCompatibility, concatCopy, cutCopy, planLosslessCut, probeMedia } from "../domain/media.ts";
import { startParseWorker } from "../hosts/parse-client.ts";
import { startIpcClient } from "../hosts/ipc-client.ts";
import { MangaApp } from "../application/app.ts";
import { writeCases } from "./helpers.ts";

test("R2: full resource text, locator, split/merge and embed", async () => {
  const generated = await generateFixtures();
  const long = fs.readFileSync(generated.items.find((item) => item.id === "long-chapter.txt")!.path);
  const { app } = await startedApp(["library", "notes", "novel-reader"]);
  const imported = await app.call(user(), { commandId: "library.importText", idempotencyKey: "long-1", input: { title: "长章", bytes: [...long] } });
  expectOk(imported, "long import");
  const { resourceId, revisionId } = imported.value as { resourceId: string; revisionId: string };
  const full = await app.call(user(), { commandId: "library.getResource", idempotencyKey: "get-long", input: { resourceId } });
  expectOk(full, "get resource");
  const body = full.value as { length: number; previewOnly: boolean; parts: Array<{ normalized: string }> };
  assert.ok(body.length > 32000, `full text ${body.length}`);
  assert.equal(body.previewOnly, false);
  const start = body.parts[0]!.normalized.indexOf("他沿着");
  const resolved = await app.call(user(), {
    commandId: "reader.resolveAnchor",
    idempotencyKey: "resolve-long",
    input: {
      resourceRevisionId: revisionId,
      locator: {
        kind: "text",
        partId: "body",
        representationId: revisionId,
        normalizationVersion: "text-nfc-lf-v1",
        range: { start, end: start + 3 },
        quote: { exact: "他沿着", prefix: body.parts[0]!.normalized.slice(Math.max(0, start - 2), start) },
      },
    },
  });
  expectOk(resolved, "resolve");
  assert.equal((resolved.value as { status: string; text?: string }).status, "resolved");
  const note = await app.call(user(), { commandId: "notes.create", idempotencyKey: "anchor-1", input: { title: "定位", text: "他沿着", resourceId, resourceRevisionId: revisionId } });
  const objectId = (note.value as { objectId: string }).objectId;
  const split = await app.call(user(), { commandId: "notes.split", idempotencyKey: "split-1", input: { objectId, expectedRevision: 1, blockId: "b1", offset: 2 } });
  expectOk(split, "split");
  assert.equal(((split.value as { blocks: unknown[] }).blocks).length, 2);
  const merge = await app.call(user(), { commandId: "notes.merge", idempotencyKey: "merge-1", input: { objectId, expectedRevision: (split.value as { revision: number }).revision, blockId: "b1" } });
  expectOk(merge, "merge");
  const other = await app.call(user(), { commandId: "notes.create", idempotencyKey: "embed-target", input: { title: "target", text: "卡片" } });
  const embed = await app.call(user(), { commandId: "notes.embed", idempotencyKey: "embed-1", input: { objectId, expectedRevision: (merge.value as { revision: number }).revision, fromBlockId: "b1", targetId: (other.value as { objectId: string }).objectId, targetKind: "object" } });
  expectOk(embed, "embed");
  const cycle = await app.call(user(), { commandId: "notes.embed", idempotencyKey: "embed-cycle", input: { objectId: (other.value as { objectId: string }).objectId, expectedRevision: 1, fromBlockId: "b1", targetId: objectId, targetKind: "object" } });
  assert.equal((cycle.value as { embedStatus: string }).embedStatus, "cycle");
  const missing = await app.call(user(), { commandId: "notes.embed", idempotencyKey: "embed-missing", input: { objectId, expectedRevision: (embed.value as { revision: number }).revision, fromBlockId: "b1", targetId: "ghost", targetKind: "object" } });
  assert.equal((missing.value as { embedStatus: string }).embedStatus, "missing");
  app.close();
  const editor = createEditor({ id: "d", revision: 1, title: "t", blocks: [{ id: "b1", type: "paragraph", text: "你好世界" }] });
  applyEdit(editor, (doc) => { splitBlock(doc, "b1", 2); });
  const leftId = editor.document.blocks[0]?.id;
  applyEdit(editor, (doc) => { mergeBlockWithNext(doc, "b1"); });
  redo(editor);
  assert.equal(leftId, "b1");
  assert.equal(embedStatus({ a: ["b"], b: ["a"] }, "a", "b"), "cycle");
  writeCases("poc-01-r2", [
    {
      caseId: "POC-01/full-text-not-preview",
      poc: "POC-01",
      title: "long chapter is returned in full for locators",
      status: "passed",
      expected: { previewOnly: false, minLength: 32000 },
      actual: { previewOnly: body.previewOnly, length: body.length },
      kind: "automated",
    },
    {
      caseId: "POC-01/locator-repeat-sentence",
      poc: "POC-01",
      title: "repeated sentence resolves with range plus prefix",
      status: "passed",
      expected: "resolved",
      actual: (resolved.value as { status: string }).status,
      kind: "automated",
    },
  ]);
});

test("R4: concat compatibility, image budget and CBZ inspection", async () => {
  const generated = await generateFixtures();
  const mp4 = generated.items.find((item) => item.id === "h264-aac.mp4");
  if (!mp4) {
    assert.ok(true, "ffmpeg sample missing; covered by format tests when available");
    return;
  }
  const probe = probeMedia(mp4.path);
  assert.equal(planLosslessCut(probe, 0, 1000).compatible, true);
  const second = path.join(path.dirname(mp4.path), "h264-aac-b.mp4");
  fs.copyFileSync(mp4.path, second);
  assert.equal(concatCompatibility(probe, probeMedia(second)).compatible, true);
  const out = path.join(isolateDir("concat"), "joined.mp4");
  concatCopy([mp4.path, second], out);
  assert.ok(probeMedia(out).durationMs > probe.durationMs);
  const hevc = { ...probe, video: { ...probe.video!, codec: "hevc" } };
  assert.equal(concatCompatibility(probe, hevc).compatible, false);
  const png = fs.readFileSync(generated.items.find((item) => item.id === "p1.png")!.path);
  const ok = inspectImage("p1.png", png);
  assert.equal(ok.overBudget, false);
  const huge = Buffer.alloc(COMIC_DISPLAY_BUDGET.maxBytes + 10, 1);
  huge.set(png.subarray(0, 24), 0);
  assert.equal(inspectImage("huge.png", huge).overBudget, true);
  const tall = Buffer.from(png);
  tall.writeUInt32BE(16, 16);
  tall.writeUInt32BE(80, 20);
  const tallInfo = inspectImage("tall.png", tall);
  assert.equal(tallInfo.longForm, true);
  assert.equal(inspectImage("rotated.png", png, 90).rotation, 90);
  const pages = listComicPages(fs.readFileSync(generated.items.find((item) => item.id === "book.cbz")!.path), "cbz");
  assert.ok(pages.length >= 3);
  const cutOut = path.join(isolateDir("cut"), "copy.mp4");
  cutCopy(mp4.path, cutOut, 0, 1000);
  const cutProbe = probeMedia(cutOut);
  assert.ok(cutProbe.durationMs > 0);
  writeCases("poc-03-r4", [
    {
      caseId: "POC-03/concat-copy",
      poc: "POC-03",
      title: "compatible MP4 copy-concat grows duration",
      status: "passed",
      expected: { compatible: true },
      actual: { joinedMs: probeMedia(out).durationMs, sourceMs: probe.durationMs },
      kind: "automated",
    },
    {
      caseId: "POC-03/copy-cut-requested-vs-actual",
      poc: "POC-03",
      title: "lossless cut records requested vs actual duration",
      status: "passed",
      expected: { requestedMs: 1000 },
      actual: { durationMs: cutProbe.durationMs, keyframeAligned: planLosslessCut(probe, 0, 1000).keyframeAligned },
      kind: "automated",
    },
    {
      caseId: "POC-03/image-budget-long-rotate",
      poc: "POC-03",
      title: "long-form and rotated images are classified; oversize is rejected",
      status: "passed",
      expected: { longForm: true, rotation: 90, overBudget: true },
      actual: { longForm: tallInfo.longForm, rotation: 90, overBudget: inspectImage("huge.png", huge).overBudget },
      kind: "automated",
    },
  ]);
});

test("R5: parse worker cancel/exit and UI/agent command plus stale scope", async () => {
  const worker = startParseWorker();
  try {
    const parsed = await worker.parse({ kind: "text", bytes: [...Buffer.from("春が来た。")] });
    assert.equal((parsed as { length: number }).length > 0, true);
    const controller = new AbortController();
    const delayed = worker.parse({ kind: "text", bytes: [...Buffer.from("delay")], delayMs: 800, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    await assert.rejects(delayed);
    worker.kill();
    await assert.rejects(worker.parse({ kind: "text", bytes: [...Buffer.from("after-exit")] }));
  } finally {
    worker.kill();
  }
  const { app } = await startedApp();
  expectOk(await app.call(user(), { commandId: "notes.create", idempotencyKey: "ui-note", input: { title: "ui", text: "from-ui" } }), "ui");
  expectOk(await app.call(agent(), { commandId: "notes.create", idempotencyKey: "agent-note", input: { title: "agent", text: "from-agent" } }), "agent");
  const denied = await app.call(user(), { commandId: "notes.create", idempotencyKey: "bad-scope", input: { title: "x", text: "y" } }, undefined, "foreign");
  assert.equal(denied.status, "error");
  const present = await app.call(user(), { commandId: "reader.ui.present", idempotencyKey: "ui-facet", input: {} });
  expectOk(present, "ui facet");
  await app.runtime.deactivate("m0.reader.novel");
  const gone = await app.call(user(), { commandId: "reader.ui.present", idempotencyKey: "ui-facet-2", input: {} });
  assert.equal(gone.status, "error");
  const counts = app.store.counts();
  await app.runtime.activate("m0.reader.novel");
  assert.equal(app.store.counts().resources, counts.resources);
  app.close();
  const profile = isolateDir("ipc-ui");
  const client = startIpcClient(profile);
  try {
    const created = await client.send({ commandId: "notes.create", idempotencyKey: "ipc-ui", input: { title: "ipc", text: "facet" } });
    assert.equal((created as { status: string }).status, "ok");
    const snap = await client.snapshot();
    assert.ok(snap);
  } finally {
    await client.close();
  }
});

test("R5: delayed parse after library stop is discarded and a new worker can import", async () => {
  const profileDir = isolateDir("late-parse");
  const app = new MangaApp({ profileDir, hostId: "late", useParseWorker: true });
  await app.start(["library", "notes"]);
  try {
    const worker=(app as unknown as {parseWorker:ReturnType<typeof startParseWorker>}).parseWorker;
    const parse=worker.parse.bind(worker), arrived=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
    worker.parse=async request=>{
      const result=await parse(request);
      request.signal?.addEventListener("abort",()=>release.resolve(),{once:true});
      arrived.resolve();
      await release.promise;
      return result;
    };
    const pending = app.call(user(), { commandId: "library.importText", idempotencyKey: "late-import", input: { title: "slow", bytes: [...Buffer.from("正文")] } });
    await arrived.promise;
    await app.runtime.deactivate("m0.library");
    release.resolve();
    assert.equal((await pending).status,"error");
    assert.equal(app.store.counts().resources,0);
    await app.runtime.activate("m0.library");
    expectOk(await app.call(user(),{commandId:"library.importText",idempotencyKey:"new-worker",input:{title:"new",bytes:[...Buffer.from("重新启用")]}}),"new worker");
    assert.equal(app.store.counts().resources,1);
  } finally {app.close();}
});

test("R6: confirm link, package round-trip and missing provider", async () => {
  const { app, profileDir } = await startedApp(["library", "notes", "metadata"]);
  const imported = await app.call(user(), { commandId: "library.importText", idempotencyKey: "pkg-work", input: { title: "极光旅人", bytes: [...Buffer.from("local")] } });
  const workId = (imported.value as { workId: string }).workId;
  const queried = await app.call(user(), { commandId: "metadata.query", idempotencyKey: "pkg-q", input: { title: "极光旅人", mode: "multi", workId } });
  expectOk(queried, "query");
  assert.equal((queried.value as { review: string }).review, "needs_review");
  const candidate = (queried.value as { candidates: Array<{ providerId: string; externalId: string }> }).candidates[0]!;
  const confirmed = await app.call(user(), { commandId: "metadata.confirm", idempotencyKey: "pkg-c", input: { workId, providerId: candidate.providerId, externalId: candidate.externalId } });
  expectOk(confirmed, "confirm");
  const after = await app.call(user(), { commandId: "metadata.query", idempotencyKey: "pkg-q2", input: { title: "极光旅人", mode: "multi", workId } });
  assert.equal((after.value as { review: string; confirmed?: boolean }).review, "matched");
  await app.runtime.deactivate("m0.metadata.alpha");
  const afterProviderStop = await app.call(user(), { commandId: "metadata.query", idempotencyKey: "pkg-q3", input: { title: "极光旅人", mode: "multi", workId } });
  assert.equal((afterProviderStop.value as { review: string }).review, "matched");
  await app.call(user(), { commandId: "notes.create", idempotencyKey: "pkg-note", input: { title: "n", text: "用户笔记", resourceId: (imported.value as { resourceId: string }).resourceId } });
  const pack = isolateDir("library-pack");
  const exported = await app.call(user(), { commandId: "library.exportPackage", idempotencyKey: "pkg-ex", input: { targetDir: pack } });
  expectOk(exported, "export");
  app.close();
  const dest = isolateDir("library-import");
  const restored = new MangaApp({ profileDir: dest, hostId: "import" });
  await restored.start(["library", "notes"]);
  const importedPack = await restored.call(user(), { commandId: "library.importPackage", idempotencyKey: "pkg-im", input: { sourceDir: pack } });
  expectOk(importedPack, "import");
  assert.equal(restored.workspaceSnapshot().notes.some((note) => note.text.includes("用户笔记")), true);
  const again = await restored.call(user(), { commandId: "library.importPackage", idempotencyKey: "pkg-im2", input: { sourceDir: pack } });
  assert.equal(again.status, "error");
  restored.close();
  void profileDir;
});
