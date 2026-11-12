#!/usr/bin/env node
// Synthetic speech evaluation corpus generator (`stage-plan.md` 4.11).
// Generates 80 fictional-entity/disfluency/near-homophone sentences x 3 acoustic variants = 240 WAVs (16 kHz mono)
// into `dist/samples/voice-eval/` using Windows built-in `System.Speech`.
// If not on Windows or no Chinese SAPI voice is installed, records `{ status: "not-run", reason }` and exits 0.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EVAL_SAMPLE_RATE,
  decodeWavMono16,
  encodeWavMono16,
  findVoicedBounds,
  mixAtSnrDb,
  prepareCleanUtterance,
  synthesizeFanNoise,
} from "./audio-dsp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const corpusPath = path.join(scriptDir, "corpus.json");
const outRoot = path.join(repoRoot, "dist/samples/voice-eval");
const manifestPath = path.join(outRoot, "manifest.json");
const scratchDir = path.join(outRoot, ".tmp");

const VARIANTS = ["clean", "fan10db", "speech10db"];

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function resamplePitchShift(samples, ratio = 1.12) {
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[Math.min(samples.length - 1, idx)];
    const b = samples[Math.min(samples.length - 1, idx + 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function writeNotRunManifest(reason) {
  fs.mkdirSync(outRoot, { recursive: true });
  const payload = {
    schema: 1,
    status: "not-run",
    reason,
    generatedAt: new Date().toISOString(),
    sampleRate: EVAL_SAMPLE_RATE,
    sentences: 0,
    variants: VARIANTS,
    totalFiles: 0,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload));
}

function resolvePowerShellBinary() {
  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    const check = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
    });
    if (!check.error && check.status === 0) {
      return candidate;
    }
  }
  return "powershell.exe";
}

function probeChineseVoices(psBin, tmpDir) {
  const psFile = path.join(tmpDir, "probe-voices.ps1");
  // Pure ASCII script so Windows PowerShell 5.1 ANSI/GBK script reader never mangles string literals.
  fs.writeFileSync(
    psFile,
    [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Speech",
      "$probeText = ([string][char]0x8BED) + ([string][char]0x97F3) + ([string][char]0x6D4B) + ([string][char]0x8BD5)",
      "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$usable = @()",
      "foreach ($v in $synth.GetInstalledVoices()) {",
      "  if ($v.Enabled -eq $false) { continue }",
      "  $info = $v.VoiceInfo",
      "  if ($info.Culture.Name -notlike 'zh*') { continue }",
      "  try {",
      "    $synth.SelectVoice($info.Name)",
      "    $ms = New-Object System.IO.MemoryStream",
      "    $synth.SetOutputToAudioStream($ms, $fmt)",
      "    $synth.Speak($probeText)",
      "    $synth.SetOutputToNull()",
      "    if ($ms.Length -gt 2000) {",
      "      $usable += [PSCustomObject]@{ name = $info.Name; culture = $info.Culture.Name; gender = [string]$info.Gender }",
      "    }",
      "    $ms.Dispose()",
      "  } catch {}",
      "}",
      "$synth.Dispose()",
      "ConvertTo-Json -InputObject @($usable) -Compress",
      "",
    ].join("\r\n"),
    "ascii",
  );
  const run = spawnSync(psBin, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psFile], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    return [];
  }
  const stdout = (run.stdout || "").trim();
  if (!stdout) return [];
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export function generateVoiceEvalCorpus({ force = false, verifyOnly = false } = {}) {
  const corpusBytes = fs.readFileSync(corpusPath);
  const corpus = JSON.parse(corpusBytes.toString("utf8"));
  const corpusSha256 = sha256Hex(corpusBytes);
  const generatorSha256 = sha256Hex(fs.readFileSync(fileURLToPath(import.meta.url)));

  if (verifyOnly) {
    if (!fs.existsSync(manifestPath)) {
      return { status: "failed", errors: ["manifest.json does not exist"] };
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.status === "not-run") {
      return { status: "not-run", reason: manifest.reason };
    }
    const errors = [];
    if (manifest.corpusSha256 !== corpusSha256) {
      errors.push("corpus.json fingerprint changed since generation");
    }
    for (const item of manifest.items ?? []) {
      for (const variant of VARIANTS) {
        const rel = item.files?.[variant];
        const abs = rel ? path.join(outRoot, rel) : "";
        if (!rel || !fs.existsSync(abs)) {
          errors.push(`missing ${item.id}/${variant}`);
        }
      }
    }
    return { status: errors.length === 0 ? "passed" : "failed", errors, totalFiles: (manifest.items ?? []).length * VARIANTS.length };
  }

  if (!force && fs.existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (
        existing.status === "generated" &&
        existing.corpusSha256 === corpusSha256 &&
        existing.generatorSha256 === generatorSha256 &&
        Array.isArray(existing.items) &&
        existing.items.length === corpus.sentences.length &&
        existing.items.every((it) => VARIANTS.every((v) => it.files?.[v] && fs.existsSync(path.join(outRoot, it.files[v]))))
      ) {
        return {
          status: "generated",
          reused: true,
          sentences: existing.items.length,
          totalFiles: existing.totalFiles,
          sampleRate: EVAL_SAMPLE_RATE,
        };
      }
    } catch {
      // Regenerate below.
    }
  }

  if (process.platform !== "win32") {
    writeNotRunManifest("Windows System.Speech text-to-speech is only available on win32");
    return { status: "not-run", reason: "Windows System.Speech text-to-speech is only available on win32" };
  }

  fs.mkdirSync(outRoot, { recursive: true });
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.mkdirSync(scratchDir, { recursive: true });

  try {
    const psBin = resolvePowerShellBinary();
    let voices = probeChineseVoices(psBin, scratchDir);
    let activePsBin = psBin;
    if (voices.length === 0 && psBin !== "powershell.exe") {
      activePsBin = "powershell.exe";
      voices = probeChineseVoices(activePsBin, scratchDir);
    }
    if (voices.length === 0) {
      writeNotRunManifest("No installed Chinese System.Speech TTS voice found on this machine");
      return { status: "not-run", reason: "No installed Chinese System.Speech TTS voice found on this machine" };
    }

    // Prefer Desktop Huihui or first female voice for primary speech, and a distinct male/second voice for competing speaker dialogue.
    const primaryVoice =
      voices.find((v) => v.name.includes("Huihui Desktop")) ??
      voices.find((v) => v.gender === "Female") ??
      voices[0];
    const competingVoice =
      voices.find((v) => v.name !== primaryVoice.name && v.gender === "Male") ??
      voices.find((v) => v.name !== primaryVoice.name) ??
      primaryVoice;
    const sameVoiceFallback = competingVoice.name === primaryVoice.name;

    const batchItems = [];
    for (const sentence of corpus.sentences) {
      batchItems.push({
        key: `utt-${sentence.id}`,
        voice: primaryVoice.name,
        rate: 0,
        text: sentence.spokenText,
        file: path.join(scratchDir, `raw-${sentence.id}.wav`),
      });
    }
    corpus.competingDialogue.forEach((line, idx) => {
      batchItems.push({
        key: `comp-${idx}`,
        voice: competingVoice.name,
        rate: sameVoiceFallback ? 2 : 1,
        text: line,
        file: path.join(scratchDir, `comp-${idx}.wav`),
      });
    });

    const batchJsonPath = path.join(scratchDir, "tts-batch.json");
    fs.writeFileSync(batchJsonPath, JSON.stringify(batchItems), "utf8");

    const synthPsPath = path.join(scratchDir, "synth-batch.ps1");
    fs.writeFileSync(
      synthPsPath,
      [
        "param($BatchFile)",
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Speech",
        "$items = Get-Content -Raw -Encoding UTF8 $BatchFile | ConvertFrom-Json",
        "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
        "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        "foreach ($item in $items) {",
        "  $synth.SelectVoice($item.voice)",
        "  $synth.Rate = [int]$item.rate",
        "  $synth.SetOutputToWaveFile($item.file, $fmt)",
        "  $synth.Speak($item.text)",
        "  $synth.SetOutputToNull()",
        "}",
        "$synth.Dispose()",
        "",
      ].join("\r\n"),
      "utf8",
    );

    const synthRun = spawnSync(activePsBin, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", synthPsPath, batchJsonPath], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (synthRun.error || synthRun.status !== 0) {
      const detail = (synthRun.stderr || synthRun.stdout || synthRun.error?.message || "unknown SAPI error").trim().slice(0, 300);
      throw new Error(`System.Speech synthesis failed: ${detail}`);
    }

    // Load competing dialogue pool into a continuous active-speech ring buffer (minimal inter-sentence gaps)
    // so every target utterance overlaps with continuous competing dialogue at +10 dB SNR.
    const competingChunks = [];
    for (let idx = 0; idx < corpus.competingDialogue.length; idx += 1) {
      const wav = decodeWavMono16(fs.readFileSync(path.join(scratchDir, `comp-${idx}.wav`)));
      const bounds = findVoicedBounds(wav.float32, 0.01);
      let voicedSlice = wav.float32.slice(bounds.first, bounds.last + 1);
      if (sameVoiceFallback) {
        voicedSlice = resamplePitchShift(voicedSlice, 1.13);
      }
      const gap = new Float32Array(Math.round(0.08 * EVAL_SAMPLE_RATE));
      competingChunks.push(voicedSlice, gap);
    }
    const totalCompLen = competingChunks.reduce((acc, arr) => acc + arr.length, 0);
    const competingRing = new Float32Array(totalCompLen);
    let writeOffset = 0;
    for (const chunk of competingChunks) {
      competingRing.set(chunk, writeOffset);
      writeOffset += chunk.length;
    }

    for (const variant of VARIANTS) {
      fs.mkdirSync(path.join(outRoot, variant), { recursive: true });
    }

    const items = [];
    for (const [index, sentence] of corpus.sentences.entries()) {
      const rawFile = path.join(scratchDir, `raw-${sentence.id}.wav`);
      const decoded = decodeWavMono16(fs.readFileSync(rawFile));
      if (decoded.sampleRate !== EVAL_SAMPLE_RATE) {
        throw new Error(`Unexpected sample rate ${decoded.sampleRate} for ${sentence.id}`);
      }
      const cleanSamples = prepareCleanUtterance(decoded.float32, EVAL_SAMPLE_RATE, 0.25, 0.56);
      if (cleanSamples.length < Math.round(0.6 * EVAL_SAMPLE_RATE)) {
        throw new Error(`Synthesized clip ${sentence.id} is unexpectedly short (${cleanSamples.length} samples)`);
      }

      // Deterministic fan noise (+10 dB SNR)
      const fanRaw = synthesizeFanNoise(cleanSamples.length, 20261113 + index * 977, EVAL_SAMPLE_RATE);
      const fanMixed = mixAtSnrDb(cleanSamples, fanRaw, 10);

      // Deterministic competing dialogue (+10 dB SNR)
      const ringOffset = (index * 19_937) % Math.max(1, competingRing.length);
      const compSlice = new Float32Array(cleanSamples.length);
      for (let i = 0; i < cleanSamples.length; i += 1) {
        compSlice[i] = competingRing[(ringOffset + i) % competingRing.length];
      }
      const speechMixed = mixAtSnrDb(cleanSamples, compSlice, 10);

      const relClean = `clean/${sentence.id}.wav`;
      const relFan = `fan10db/${sentence.id}.wav`;
      const relSpeech = `speech10db/${sentence.id}.wav`;

      const cleanWav = encodeWavMono16(cleanSamples, EVAL_SAMPLE_RATE);
      const fanWav = encodeWavMono16(fanMixed, EVAL_SAMPLE_RATE);
      const speechWav = encodeWavMono16(speechMixed, EVAL_SAMPLE_RATE);

      fs.writeFileSync(path.join(outRoot, relClean), cleanWav);
      fs.writeFileSync(path.join(outRoot, relFan), fanWav);
      fs.writeFileSync(path.join(outRoot, relSpeech), speechWav);

      items.push({
        id: sentence.id,
        group: sentence.group,
        workId: sentence.workId,
        durationSeconds: Number((cleanSamples.length / EVAL_SAMPLE_RATE).toFixed(3)),
        samples: cleanSamples.length,
        files: {
          clean: relClean,
          fan10db: relFan,
          speech10db: relSpeech,
        },
        sha256: {
          clean: sha256Hex(cleanWav),
          fan10db: sha256Hex(fanWav),
          speech10db: sha256Hex(speechWav),
        },
      });
    }

    const totalSeconds = Number(items.reduce((acc, it) => acc + it.durationSeconds, 0).toFixed(2));
    const manifest = {
      schema: 1,
      status: "generated",
      generatedAt: new Date().toISOString(),
      corpusSha256,
      generatorSha256,
      sampleRate: EVAL_SAMPLE_RATE,
      snrDb: 10,
      voicesUsed: {
        primaryCulture: primaryVoice.culture,
        distinctCompetingVoice: !sameVoiceFallback,
      },
      groups: {
        A: items.filter((i) => i.group === "A").length,
        B: items.filter((i) => i.group === "B").length,
        C: items.filter((i) => i.group === "C").length,
      },
      sentences: items.length,
      variants: VARIANTS,
      totalFiles: items.length * VARIANTS.length,
      cleanDurationSeconds: totalSeconds,
      items,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return {
      status: "generated",
      reused: false,
      sentences: manifest.sentences,
      groups: manifest.groups,
      totalFiles: manifest.totalFiles,
      cleanDurationSeconds: totalSeconds,
      distinctCompetingVoice: !sameVoiceFallback,
    };
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const verifyOnly = args.includes("--verify");
  const summary = generateVoiceEvalCorpus({ force, verifyOnly });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}
