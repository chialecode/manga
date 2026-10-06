import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { transcribeAudio } from "@manga/model-protocol";
import { evidenceRunDir } from "../../scripts/desktop-paths.ts";

/**
 * Contract check of the configured ASR service (plan section 7, item 3). It runs only when MANGA_LIVE_ASR=1 and never in CI.
 *
 * - the only audio sent is the synthetic text-to-speech clips from the sample generator, never a recording or a real work;
 * - at most BUDGET requests per run, counted at the network call, not trusted from the test's own loop;
 * - the endpoint, key and model come from the ignored local test configuration (MANGA_TEST_ASR_*) and are never printed
 *   or written; a missing field makes the result `not-run`, and a network that cannot reach the service makes it `blocked`;
 * - the evidence file carries outcomes, counts and a similarity figure against the known text of each synthetic clip.
 */
const enabled = process.env.MANGA_LIVE_ASR === "1" && !process.env.CI;
const BUDGET = 10;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clipsDir = path.join(root, "dist/samples/m2/voice/tts-clips");

function loadAsrConfig(): Record<string, string> {
  const values: Record<string, string> = {};
  const file = path.join(root, ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (!trimmed || trimmed.startsWith("#") || eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key.startsWith("MANGA_TEST_ASR_")) values[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  for (const key of Object.keys(process.env)) if (key.startsWith("MANGA_TEST_ASR_") && process.env[key]) values[key] = process.env[key]!;
  return values;
}

function similarity(a: string, b: string): number {
  const clean = (text: string) => [...text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase()];
  const x = clean(a);
  const y = clean(b);
  if (!x.length || !y.length) return 0;
  let previous = Array.from({ length: y.length + 1 }, (_, index) => index);
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= y.length; j += 1) row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1)));
    previous = row;
  }
  return 1 - previous[y.length]! / Math.max(x.length, y.length);
}

type Step = { clip: string; options: string; outcome: "ok" | "failed"; similarity?: number; segments?: number; seconds?: number; detail?: string };

describe.skipIf(!enabled)("ASR contract (live, synthetic speech only)", () => {
  it("transcribes the synthetic clips, with segment timestamps and a term hint, inside the request budget", async (context) => {
    const out = path.join(evidenceRunDir("m2", "live-asr"), "summary.json");
    const steps: Step[] = [];
    let requests = 0;
    const write = (status: "passed" | "blocked" | "failed" | "not-run", extra: Record<string, unknown> = {}) => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), status, requests, budget: BUDGET, steps, ...extra }, null, 2));
    };

    const config = loadAsrConfig();
    const baseUrl = config.MANGA_TEST_ASR_API_BASE_URL;
    const apiKey = config.MANGA_TEST_ASR_API_KEY;
    const model = config.MANGA_TEST_ASR_MODEL_ID;
    if (!baseUrl || !apiKey || !model) {
      write("not-run", { reason: "MANGA_TEST_ASR_* is not configured in the ignored local environment" });
      context.skip();
      return;
    }
    const truthFile = path.join(clipsDir, "truth.json");
    if (!fs.existsSync(truthFile)) {
      write("not-run", { reason: "the synthetic speech clips are missing; run: node scripts/samples/generate-media-samples.mjs" });
      context.skip();
      return;
    }
    const truth = JSON.parse(fs.readFileSync(truthFile, "utf8")) as { clips: Array<{ file: string; lang: string; text: string; seconds: number }> };
    const clips = truth.clips.filter((clip) => clip.lang === "zh-CN").slice(0, 3);
    expect(clips.length).toBeGreaterThan(0);

    // The count is taken where the request leaves the process, so no path through the client can exceed the budget unseen.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (requests >= BUDGET) throw new Error("request budget exhausted");
      requests += 1;
      return realFetch(input, init);
    }) as typeof fetch;

    const plan: Array<{ clip: (typeof clips)[number]; timestamps: boolean; prompt?: string }> = [
      { clip: clips[0]!, timestamps: false },
      { clip: clips[1]!, timestamps: true },
      { clip: clips[2]!, timestamps: true, prompt: "术语：契约、魔法少女" },
    ];
    try {
      for (const item of plan) {
        const bytes = fs.readFileSync(path.join(clipsDir, item.clip.file));
        const options = [item.timestamps ? "timestamps" : "plain", item.prompt ? "prompt" : "no-prompt"].join("+");
        try {
          const result = await transcribeAudio(baseUrl, apiKey, {
            model, bytes, mimeType: "audio/wav", fileName: item.clip.file, language: "zh", timestamps: item.timestamps, prompt: item.prompt, timeoutMs: 60_000,
          });
          steps.push({ clip: item.clip.file, options, outcome: "ok", similarity: Number(similarity(result.text, item.clip.text).toFixed(3)), ...(result.segments ? { segments: result.segments.length } : {}), ...(result.duration ? { seconds: result.duration } : {}) });
        } catch (error) {
          const code = (error as { code?: string }).code ?? "ERROR";
          steps.push({ clip: item.clip.file, options, outcome: "failed", detail: code });
          if (code === "PROVIDER_UNAVAILABLE" && steps.length === 1) {
            write("blocked", { reason: "the service could not be reached from this machine", retest: "run again on a working network with MANGA_LIVE_ASR=1" });
            context.skip();
            return;
          }
          write("failed");
          throw error;
        }
      }
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(requests).toBeLessThanOrEqual(BUDGET);
    const poor = steps.filter((step) => (step.similarity ?? 0) < 0.6);
    write(poor.length ? "failed" : "passed", { note: "similarity is edit distance against the known text of each synthetic clip" });
    expect(poor, JSON.stringify(poor)).toEqual([]);
    // A service that answers with timestamps gives them in the same shape the product maps positions from; one that does not is
    // recorded rather than failed, because the product falls back to chunk-level positions (plan R4).
  }, 240_000);
});
