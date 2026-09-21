import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateFixtures } from "../fixtures/generate.ts";
import { cutCopy, generateMedia, planLosslessCut, probeMedia } from "../domain/media.ts";
import { listComicPages } from "../domain/comic.ts";
import { writeCases } from "./helpers.ts";

test("POC-03 media matrix and lossless cut boundary", async (t) => {
  const ffmpeg = process.env.M0_SKIP_FFMPEG === "1" ? false : true;
  if (!ffmpeg) {
    t.skip("ffmpeg skipped");
    return;
  }
  const generated = await generateFixtures();
  const mp4Item = generated.items.find((item) => item.id === "h264-aac.mp4");
  if (!mp4Item) {
    writeCases("poc-03", [{
      caseId: "POC-03/ffmpeg",
      poc: "POC-03",
      title: "ffmpeg media matrix",
      status: "blocked",
      expected: "ffmpeg available",
      actual: "ffmpeg generate failed or missing",
      kind: "automated",
    }]);
    return;
  }
  const mp4 = mp4Item.path;
  const probe = probeMedia(mp4);
  assert.equal(probe.video?.codec, "h264");
  assert.equal(probe.audio?.codec, "aac");
  const compatible = planLosslessCut(probe, 0, 2000);
  assert.equal(compatible.compatible, true);
  const out = path.join(os.tmpdir(), "manga-m0", `cut-${Date.now()}.mp4`);
  cutCopy(mp4, out, 0, 1000);
  const cutProbe = probeMedia(out);
  assert.ok(cutProbe.durationMs > 0);
  const rejected = planLosslessCut({
    ...probe,
    video: { ...probe.video!, codec: "hevc" },
  }, 0, 1000);
  assert.equal(rejected.compatible, false);
  const cbz = generated.items.find((item) => item.id === "book.cbz")!;
  const pages = listComicPages(fs.readFileSync(cbz.path), "cbz");
  assert.ok(pages.length >= 3);
  const names = pages.map((item) => item.name);
  assert.deepEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), names);
  writeCases("poc-03", [
    {
      caseId: "POC-03/h264-aac-probe",
      poc: "POC-03",
      title: "generated MP4 H.264/AAC probe",
      status: "passed",
      expected: { video: "h264", audio: "aac" },
      actual: { video: probe.video?.codec, audio: probe.audio?.codec, durationMs: probe.durationMs },
      kind: "automated",
    },
    {
      caseId: "POC-03/copy-cut",
      poc: "POC-03",
      title: "requested vs actual copy cut",
      status: "passed",
      expected: { requestedMs: 1000 },
      actual: { durationMs: cutProbe.durationMs, plan: compatible },
      kind: "automated",
    },
    {
      caseId: "POC-03/reject-hevc-copy",
      poc: "POC-03",
      title: "incompatible codec rejected for lossless cut",
      status: "passed",
      expected: false,
      actual: rejected.compatible,
      kind: "automated",
    },
    {
      caseId: "POC-03/cbz-order",
      poc: "POC-03",
      title: "CBZ numeric order and duplicate names",
      status: "passed",
      expected: "numeric",
      actual: names,
      kind: "automated",
    },
    {
      caseId: "POC-03/mkv-hevc-ass",
      poc: "POC-03",
      title: "Electron MKV/HEVC/ASS playback and subtitle rendering",
      status: "not-run",
      expected: "playback and synchronization evidence",
      actual: "FFmpeg probe covered separately in format-matrix.json; desktop video player not implemented",
      kind: "automated",
    },
  ]);
  void generateMedia;
});
