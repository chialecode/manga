import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { ensurePlaybackDerivative, indexWebmForPlayback, probeContainerDurationMs, readWebmDurationMs, writeDurationlessFixture } from "../domain/webm.ts";
import { expectOk, startedApp, user, writeCases } from "./helpers.ts";
import { isolateDir } from "../env.ts";

test("R1: durationless WebM is indexed without overwriting the original", () => {
  const dir = isolateDir("webm");
  const original = path.join(dir, "raw.webm");
  writeDurationlessFixture(original, 1.14);
  const before = fs.readFileSync(original);
  assert.equal(readWebmDurationMs(before), undefined);
  assert.equal(probeContainerDurationMs(original), null);
  const playback = path.join(dir, "raw.playback.webm");
  const indexed = indexWebmForPlayback(original, playback);
  assert.equal(fs.readFileSync(original).equals(before), true, "original bytes must stay intact");
  assert.ok(indexed.durationMs > 500, `indexed duration ${indexed.durationMs}`);
  assert.notEqual(path.resolve(original), path.resolve(playback));
});

test("R1: capture.save retry is idempotent and keeps original audio", async () => {
  const { app } = await startedApp(["library", "notes"]);
  const dir = isolateDir("capture-bytes");
  const file = path.join(dir, "in.webm");
  writeDurationlessFixture(file, 1.2);
  const bytes = [...fs.readFileSync(file)];
  const key = "capture-retry-key";
  const first = await app.call(user(), { commandId: "capture.save", idempotencyKey: key, input: { bytes, mimeType: "audio/webm", metadata: { clock: "test" } } });
  expectOk(first, "save");
  const second = await app.call(user(), { commandId: "capture.save", idempotencyKey: key, input: { bytes, mimeType: "audio/webm", metadata: { clock: "test" } } });
  assert.equal(second.idempotentReplay || (second.value as { replayed?: boolean }).replayed, true);
  const sessions = app.store.db.prepare("SELECT id, attachment_id FROM capture_sessions").all() as Array<{ id: string; attachment_id: string }>;
  assert.equal(sessions.length, 1);
  const originalPath = path.join(app.store.attachmentsDir, sessions[0]!.attachment_id);
  assert.equal(createHash("sha256").update(fs.readFileSync(originalPath)).digest("hex"), createHash("sha256").update(Buffer.from(bytes)).digest("hex"));
  const playback = ensurePlaybackDerivative(originalPath);
  assert.ok(playback.durationMs > 0);
  const lostResponse = await app.call(user(), { commandId: "capture.save", idempotencyKey: key, input: { bytes, mimeType: "audio/webm", metadata: { clock: "test" } } });
  expectOk(lostResponse, "retry after lost response");
  assert.equal((app.store.db.prepare("SELECT COUNT(*) AS c FROM capture_sessions").get() as { c: number }).c, 1);
  app.close();
  writeCases("poc-02-r1", [
    {
      caseId: "POC-02/durationless-webm-indexed",
      poc: "POC-02",
      title: "durationless WebM is indexed without overwriting the original",
      status: "passed",
      expected: { originalUnchanged: true, durationFinite: true },
      actual: { originalUnchanged: true, durationMs: playback.durationMs },
      kind: "automated",
    },
    {
      caseId: "POC-02/capture-save-idempotent",
      poc: "POC-02",
      title: "lost save response retries the same capture identity",
      status: "passed",
      expected: 1,
      actual: 1,
      kind: "automated",
    },
  ]);
});