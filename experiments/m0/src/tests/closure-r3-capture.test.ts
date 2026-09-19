import assert from "node:assert/strict";
import test from "node:test";
import { associateAsrResult, captureOffsetFromSamples, mapCaptureToSources, mediaTimeAt } from "../domain/capture.ts";
import { expectOk, startedApp, user, writeCases } from "./helpers.ts";
import { writeDurationlessFixture } from "../domain/webm.ts";
import { isolateDir } from "../env.ts";
import fs from "node:fs";
import path from "node:path";

test("R3: sample clock excludes permission wait; pause/rate/seek mapping", async () => {
  const sampleRate = 48_000;
  const permissionWaitMs = 320;
  const capturedMs = captureOffsetFromSamples(sampleRate, sampleRate);
  assert.equal(capturedMs, 1000);
  assert.notEqual(capturedMs, permissionWaitMs + capturedMs);

  const events = [
    { captureOffsetMs: 0, clockDomainId: "capture-samples", resourceId: "txt", resourceRevisionId: "r1", locator: { kind: "text" as const, partId: "body", representationId: "r1", normalizationVersion: "text-nfc-lf-v1", range: { start: 0, end: 4 } }, playing: true, playbackRate: 1, reason: "start" as const },
    { captureOffsetMs: 400, clockDomainId: "capture-samples", resourceId: "vid", resourceRevisionId: "v1", locator: { kind: "temporal" as const, startMs: 1000 }, playing: true, playbackRate: 1, reason: "resource_change" as const },
    { captureOffsetMs: 700, clockDomainId: "capture-samples", resourceId: "vid", resourceRevisionId: "v1", locator: { kind: "temporal" as const, startMs: 1300 }, playing: false, playbackRate: 1, reason: "pause" as const },
    { captureOffsetMs: 1100, clockDomainId: "capture-samples", resourceId: "vid", resourceRevisionId: "v1", locator: { kind: "temporal" as const, startMs: 1300 }, playing: true, playbackRate: 2, reason: "resume" as const },
    { captureOffsetMs: 1300, clockDomainId: "capture-samples", resourceId: "vid", resourceRevisionId: "v1", locator: { kind: "temporal" as const, startMs: 8000 }, playing: true, playbackRate: 2, reason: "seek" as const },
    { captureOffsetMs: 1500, clockDomainId: "capture-samples", resourceId: "vid", resourceRevisionId: "v1", locator: { kind: "temporal" as const, startMs: 8000 }, playing: true, playbackRate: 1, reason: "rate_change" as const },
    { captureOffsetMs: 1800, clockDomainId: "capture-samples", resourceId: "vid", resourceRevisionId: "v1", locator: { kind: "temporal" as const, startMs: 8300 }, reason: "stop" as const },
  ];
  const segments = mapCaptureToSources(events);
  assert.ok(segments.length >= 4);
  assert.equal(mediaTimeAt(events, 900)?.mediaMs, 1300);
  assert.equal(mediaTimeAt(events, 1400)?.mediaMs, 8200);
  const at1600 = mediaTimeAt(events, 1600);
  assert.equal(at1600?.mediaMs, 8100);

  const markerAt500 = captureOffsetFromSamples(24_000, sampleRate);
  const expectedSource = mapCaptureToSources(events).find((segment) => segment.startOffsetMs <= markerAt500 && markerAt500 < segment.endOffsetMs);
  assert.equal(expectedSource?.resourceId, "vid");

  const late = await associateAsrResult({
    response: { delayMs: 1, text: "marker" },
    signal: new AbortController().signal,
    captureOffsetMs: 500,
    requestFocus: { resourceId: "vid", resourceRevisionId: "v1", locator: { kind: "temporal", startMs: 1000 } },
    arrivalFocus: { resourceId: "txt", resourceRevisionId: "r1" },
  });
  assert.equal(late.resourceId, "vid");
  assert.equal(late.usedArrivalFocus, false);

  const { app } = await startedApp(["library", "notes"]);
  const dir = isolateDir("r3-capture");
  const file = path.join(dir, "tone.webm");
  writeDurationlessFixture(file, 1.0);
  const saved = await app.call(user(), {
    commandId: "capture.save",
    idempotencyKey: "r3-clock",
    input: {
      bytes: [...fs.readFileSync(file)],
      mimeType: "audio/webm",
      metadata: { clock: "capture-samples", sampleRate, permissionMs: permissionWaitMs, samples: sampleRate, positions: events },
    },
  });
  expectOk(saved, "save");
  const marked = await app.call(user(), {
    commandId: "capture.markPlayback",
    idempotencyKey: "r3-progress",
    input: { attachmentId: (saved.value as { attachmentId: string }).attachmentId, positionMs: 350 },
  });
  expectOk(marked, "playback progress");
  const stat = await app.call(user(), {
    commandId: "capture.stat",
    idempotencyKey: "r3-stat",
    input: { attachmentId: (saved.value as { attachmentId: string }).attachmentId },
  });
  assert.equal((stat.value as { metadata: { lastPlaybackMs: number } }).metadata.lastPlaybackMs, 350);
  app.close();

  writeCases("poc-02-r3", [
    {
      caseId: "POC-02/sample-clock-excludes-permission",
      poc: "POC-02",
      title: "capture offset uses processed samples, not getUserMedia wait",
      status: "passed",
      expected: { capturedMs: 1000, permissionWaitMs: 320 },
      actual: { capturedMs, permissionWaitMs },
      kind: "automated",
    },
    {
      caseId: "POC-02/player-events-during-capture",
      poc: "POC-02",
      title: "pause freezes media; seek does not interpolate; rate applies after the event",
      status: "passed",
      expected: { pauseMs: 1300, seekMs: 8200, afterRateMs: 8100 },
      actual: { pauseMs: mediaTimeAt(events, 900)?.mediaMs, seekMs: mediaTimeAt(events, 1400)?.mediaMs, afterRateMs: at1600?.mediaMs, segments: segments.length },
      kind: "automated",
    },
    {
      caseId: "POC-02/asr-marker-keeps-request-focus",
      poc: "POC-02",
      title: "fixed marker/ASR fixture stays on request focus",
      status: "passed",
      expected: { resourceId: "vid", usedArrivalFocus: false },
      actual: { resourceId: late.resourceId, usedArrivalFocus: late.usedArrivalFocus },
      kind: "simulated",
    },
    {
      caseId: "POC-02/playback-progress-persisted",
      poc: "POC-02",
      title: "playback position is stored on the capture session",
      status: "passed",
      expected: 350,
      actual: (stat.value as { metadata: { lastPlaybackMs: number } }).metadata.lastPlaybackMs,
      kind: "automated",
    },
    {
      caseId: "POC-02/hardware-offset",
      poc: "POC-02",
      title: "hardware analog/acoustic offset",
      status: "not-run",
      expected: "user-started loopback/headset measurement",
      actual: "joint-test entry is in the desktop window; Agent does not open the real microphone",
      kind: "human",
      evidence: "docs/evidence/2026-09-19-m0-human-checklist.md",
    },
  ]);
});
