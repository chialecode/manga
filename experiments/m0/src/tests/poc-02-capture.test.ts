import assert from "node:assert/strict";
import test from "node:test";
import { associateAsrResult, captureOffsetFromSamples, mapCaptureToSources, mediaTimeAt, runAsrFixture } from "../domain/capture.ts";
import { writeCases } from "./helpers.ts";
import type { CapturePositionEvent } from "@manga/contracts";

test("POC-02 capture clock mapping and ASR fixture", async () => {
  const events: CapturePositionEvent[] = [
    {
      captureOffsetMs: 0,
      clockDomainId: "capture",
      resourceId: "res-a",
      resourceRevisionId: "rev-a",
      locator: { kind: "text", partId: "p1", representationId: "r1", normalizationVersion: "text-nfc-lf-v1", range: { start: 0, end: 4 } },
      reason: "start",
    },
    {
      captureOffsetMs: 1200,
      clockDomainId: "capture",
      resourceId: "res-b",
      resourceRevisionId: "rev-b",
      locator: { kind: "text", partId: "p2", representationId: "r2", normalizationVersion: "text-nfc-lf-v1", range: { start: 4, end: 8 } },
      reason: "resource_change",
    },
    {
      captureOffsetMs: 2500,
      clockDomainId: "capture",
      resourceId: "res-b",
      resourceRevisionId: "rev-b",
      locator: { kind: "text", partId: "p2", representationId: "r2", normalizationVersion: "text-nfc-lf-v1", range: { start: 4, end: 8 } },
      reason: "stop",
    },
  ];
  const segments = mapCaptureToSources(events);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.resourceId, "res-a");
  assert.equal(segments[1]?.resourceId, "res-b");
  assert.ok(segments[0]!.endOffsetMs > segments[0]!.startOffsetMs);

  const mediaEvents: CapturePositionEvent[] = [
    {
      captureOffsetMs: 0,
      clockDomainId: "capture",
      resourceId: "vid",
      resourceRevisionId: "vid-r",
      locator: { kind: "temporal", startMs: 10_000 },
      playing: true,
      playbackRate: 2,
      reason: "start",
    },
    {
      captureOffsetMs: 1000,
      clockDomainId: "capture",
      resourceId: "vid",
      resourceRevisionId: "vid-r",
      locator: { kind: "temporal", startMs: 40_000 },
      playing: true,
      playbackRate: 1,
      reason: "seek",
    },
    {
      captureOffsetMs: 1500,
      clockDomainId: "capture",
      resourceId: "vid",
      resourceRevisionId: "vid-r",
      locator: { kind: "temporal", startMs: 40_000 },
      reason: "stop",
    },
  ];
  const mediaSegments = mapCaptureToSources(mediaEvents);
  assert.equal(mediaSegments.length, 2);
  assert.equal(mediaSegments[0]?.locator.kind, "temporal");

  const paused = mapCaptureToSources([
    { captureOffsetMs: 0, clockDomainId: "samples", resourceId: "vid", resourceRevisionId: "vid-r", locator: { kind: "temporal", startMs: 1000 }, playing: true, playbackRate: 1, reason: "start" },
    { captureOffsetMs: 500, clockDomainId: "samples", resourceId: "vid", resourceRevisionId: "vid-r", locator: { kind: "temporal", startMs: 1500 }, playing: false, playbackRate: 1, reason: "pause" },
    { captureOffsetMs: 1500, clockDomainId: "samples", resourceId: "vid", resourceRevisionId: "vid-r", locator: { kind: "temporal", startMs: 1500 }, playing: false, reason: "stop" },
  ]);
  assert.equal(mediaTimeAt([
    { captureOffsetMs: 0, clockDomainId: "samples", resourceId: "vid", resourceRevisionId: "vid-r", locator: { kind: "temporal", startMs: 1000 }, playing: true, playbackRate: 2, reason: "start" },
    { captureOffsetMs: 400, clockDomainId: "samples", resourceId: "vid", resourceRevisionId: "vid-r", locator: { kind: "temporal", startMs: 4000 }, playing: true, playbackRate: 1, reason: "seek" },
  ], 900)?.mediaMs, 4500);
  assert.equal(mediaTimeAt([
    { captureOffsetMs: 0, clockDomainId: "samples", resourceId: "vid", resourceRevisionId: "vid-r", locator: { kind: "temporal", startMs: 1000 }, playing: false, reason: "pause" },
  ], 800)?.mediaMs, 1000);
  assert.equal(paused.length, 2);
  assert.equal(paused[1]?.playing, false);
  const late = await associateAsrResult({
    response: { delayMs: 5, text: "春が来た" },
    signal: new AbortController().signal,
    captureOffsetMs: 200,
    requestFocus: { resourceId: "res-a", resourceRevisionId: "rev-a", locator: { kind: "text", partId: "p1", representationId: "r1", normalizationVersion: "text-nfc-lf-v1", range: { start: 0, end: 4 } } },
    arrivalFocus: { resourceId: "res-b", resourceRevisionId: "rev-b" },
  });
  assert.equal(late.resourceId, "res-a");
  assert.equal(late.usedArrivalFocus, false);
  const controller = new AbortController();
  const cancelled = runAsrFixture({ delayMs: 50, text: "hello" }, controller.signal);
  controller.abort();
  assert.equal((await cancelled).status, "cancelled");
  const failed = await runAsrFixture({ delayMs: 1, fail: true }, new AbortController().signal);
  assert.equal(failed.status, "failed");
  const timeout = await runAsrFixture({ delayMs: 1, timeout: true }, new AbortController().signal);
  assert.equal(timeout.status, "timeout");
  const ok = await runAsrFixture({ delayMs: 1, text: "fixed transcript" }, new AbortController().signal);
  assert.equal(ok.status, "ok");
  writeCases("poc-02", [
    {
      caseId: "POC-02/segment-on-resource-change",
      poc: "POC-02",
      title: "page/resource change splits capture intervals",
      status: "passed",
      expected: 2,
      actual: segments.length,
      kind: "automated",
    },
    {
      caseId: "POC-02/media-seek-split",
      poc: "POC-02",
      title: "seek splits temporal capture mapping",
      status: "passed",
      expected: 2,
      actual: mediaSegments.length,
      kind: "automated",
    },
    {
      caseId: "POC-02/asr-fixture",
      poc: "POC-02",
      title: "fixed ASR fixture covers delay/fail/timeout/cancel",
      status: "passed",
      expected: ["cancelled", "failed", "timeout", "ok"],
      actual: [ (await cancelled).status, failed.status, timeout.status, ok.status ],
      kind: "simulated",
    },
    {
      caseId: "POC-02/pause-and-seek-clock",
      poc: "POC-02",
      title: "pause freezes media time; playback advances from the seek target",
      status: "passed",
      expected: { pausedSegments: 2, seekMediaMs: 4500 },
      actual: { pausedSegments: paused.length, seekMediaMs: 4500, sampleMs: captureOffsetFromSamples(48000, 48000) },
      kind: "automated",
    },
    {
      caseId: "POC-02/asr-keeps-request-focus",
      poc: "POC-02",
      title: "delayed ASR fixture attaches to request focus, not arrival focus",
      status: "passed",
      expected: { resourceId: "res-a", usedArrivalFocus: false },
      actual: { resourceId: late.resourceId, usedArrivalFocus: late.usedArrivalFocus },
      kind: "simulated",
    },
    {
      caseId: "POC-02/device-headset-speaker",
      poc: "POC-02",
      title: "real headset/speaker capture",
      status: "not-run",
      expected: "human device log for headset vs speaker, crosstalk, unplug",
      actual: "external microphone + display speakers basic capture passed separately; headset/crosstalk/unplug still not-run",
      kind: "human",
      evidence: "docs/evidence/2026-09-19-m0-device-followup.md",
    },
  ]);
});
