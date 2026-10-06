import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { verifyMediaSamples } from "../../scripts/samples/media-manifest.mjs";
import { requireSamples, sample, samplePath, samplesRoot, type SampleEntry } from "../helpers/samples.ts";

let manifest: { samples: SampleEntry[] };
beforeAll(() => {
  manifest = requireSamples();
});

describe("M2 synthetic samples", () => {
  it("lists every required sample with an ID, a fingerprint and sub-features", () => {
    const required = [
      "comic-dir-natural", "comic-dir-sparse", "comic-dir-duplicates", "comic-dir-long-strip", "comic-dir-huge", "comic-dir-corrupt", "comic-dir-mixed",
      "cbz-basic", "cbz-comicinfo", "cbz-traversal", "cbz-bomb", "cbz-encrypted",
      "comic-pdf-images", "comic-epub-images", "comic-mobi-images", "cover-images", "epub-with-cover",
      "video-mp4-h264-aac", "video-mkv-ass-fonts", "video-external-subs", "video-mkv-hevc-8bit", "video-mkv-hevc-10bit", "video-vfr", "video-nonzero-start", "video-ac3", "video-corrupt", "video-episodes",
      "voice-recording-30min", "voice-no-speech", "voice-tts-clips",
    ];
    for (const id of required) {
      const entry = manifest.samples.find((item) => item.id === id);
      expect(entry, id).toBeDefined();
      expect(entry!.features.length, id).toBeGreaterThan(0);
      if (entry!.status === "generated") expect(entry!.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      else expect(entry!.reason, id).toBeTruthy();
    }
    expect(new Set(manifest.samples.map((item) => item.id)).size).toBe(manifest.samples.length);
  });

  it("every sample matches its recorded fingerprint", () => {
    const result = verifyMediaSamples();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("a missing manifest, a missing sample, a changed sample and a stale generator all fail verification", () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "manga-samples-"));
    expect(verifyMediaSamples({ root: copy }).ok).toBe(false);
    const small = ["comic-dir-natural", "cbz-basic"];
    const subset = { ...JSON.parse(fs.readFileSync(path.join(samplesRoot, "manifest.json"), "utf8")), samples: manifest.samples.filter((item) => small.includes(item.id)) };
    for (const item of subset.samples) fs.cpSync(path.join(samplesRoot, item.path), path.join(copy, item.path), { recursive: true });
    fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(subset));
    expect(verifyMediaSamples({ root: copy }).ok).toBe(true);

    fs.appendFileSync(path.join(copy, "comic/cbz-basic.cbz"), "x");
    const changed = verifyMediaSamples({ root: copy });
    expect(changed.ok).toBe(false);
    expect(changed.errors.join()).toContain("cbz-basic");

    fs.rmSync(path.join(copy, "comic/dir-natural/10.png"));
    expect(verifyMediaSamples({ root: copy }).errors.join()).toContain("comic-dir-natural");

    fs.rmSync(path.join(copy, "comic/dir-natural"), { recursive: true });
    expect(verifyMediaSamples({ root: copy }).errors.join()).toContain("is missing");

    fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify({ ...subset, generator: { fingerprint: "old" } }));
    expect(verifyMediaSamples({ root: copy }).errors.join()).toContain("different version of the generator");
    fs.rmSync(copy, { recursive: true, force: true });
  });

  it("produces the image properties the reader tests depend on", async () => {
    const strip = await sharp(samplePath("comic-dir-long-strip", "001-strip.png")).metadata();
    expect([strip.width, strip.height]).toEqual([800, 16000]);
    const huge = await sharp(samplePath("comic-dir-huge", "002-huge.png"), { limitInputPixels: false }).metadata();
    expect([huge.width, huge.height]).toEqual([20000, 20000]);
    // sharp's default decode budget is below the huge page, which is what the reader's budget check relies on.
    await expect(sharp(samplePath("comic-dir-huge", "002-huge.png")).resize(100).toBuffer()).rejects.toThrow(/pixel limit/);
    expect(fs.readdirSync(samplePath("comic-dir-natural")).sort()).toEqual(["1.png", "10.png", "11.png", "2.png", "20.png", "3.png"]);
  });

  it("describes a 30-minute recording whose truth intervals match the audio", () => {
    const entry = sample("voice-recording-30min");
    if (entry.status !== "generated") return;
    const wav = fs.statSync(samplePath("voice-recording-30min", "recording.wav"));
    expect(wav.size).toBe(44 + 30 * 60 * 16000 * 2);
    const truth = JSON.parse(fs.readFileSync(samplePath("voice-recording-30min", "truth.json"), "utf8"));
    expect(truth.durationSeconds).toBe(1800);
    const kinds = new Set(truth.events.map((event: { kind: string }) => event.kind));
    for (const kind of ["speech", "speech-over-music", "music", "noise-white", "noise-pink", "silence"]) expect(kinds.has(kind), kind).toBe(true);
    for (const event of truth.events) expect(event.end).toBeGreaterThan(event.start);
    const noSpeech = JSON.parse(fs.readFileSync(samplePath("voice-no-speech", "truth.json"), "utf8"));
    expect(noSpeech.speech).toEqual([]);
    expect(noSpeech.events.some((event: { kind: string }) => event.kind.startsWith("speech"))).toBe(false);
  });
});
