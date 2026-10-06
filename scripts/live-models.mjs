import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStage, stageFingerprints } from "./stage/lib.mjs";
import { evidenceRunDir } from "./desktop-paths.ts";

// Runs the live model probes from the ignored per-purpose local configuration and records
// per-purpose outcomes only. Variable values, request bodies and provider responses never enter the record.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
if (!fs.existsSync(vitest)) {
  console.error("FAILED live probes: vitest is not installed");
  process.exit(1);
}
const evidence = process.env.LIVE_EVIDENCE_DIR ? path.resolve(root, process.env.LIVE_EVIDENCE_DIR) : evidenceRunDir("m2", "live-models");
fs.mkdirSync(evidence, { recursive: true });

function configured(prefix) {
  const file = path.join(root, ".env.local");
  const values = new Map();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (!trimmed || trimmed.startsWith("#") || eq < 0) continue;
      values.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, ""));
    }
  }
  return ["API_BASE_URL", "API_KEY", "MODEL_ID"].every((name) => {
    const key = `MANGA_TEST_${prefix}_${name}`;
    return Boolean(process.env[key] ?? values.get(key));
  });
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "manga-live-"));
const reporterFile = path.join(scratch, "vitest.json");
const result = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.config.ts", "tests/agent/live-models.test.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${reporterFile}`], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, MANGA_LIVE_MODELS: "1" },
});
const report = fs.existsSync(reporterFile) ? JSON.parse(fs.readFileSync(reporterFile, "utf8")) : undefined;
fs.rmSync(scratch, { recursive: true, force: true });
const assertions = (report?.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
const outcome = (pattern, prefix) => {
  if (!configured(prefix)) return { status: "not-run", reason: `MANGA_TEST_${prefix}_* unconfigured` };
  const matched = assertions.filter((item) => pattern.test(item.fullName));
  if (!matched.length) return { status: "not-run", reason: "probe did not execute" };
  return { status: matched.every((item) => item.status === "passed") ? "passed" : "failed", tests: matched.map((item) => ({ name: item.fullName, status: item.status })) };
};
const probes = {
  llm: outcome(/LLM/, "LLM"),
  asr: outcome(/ASR purpose/, "ASR"),
  embedding: outcome(/embedding/, "EMBEDDING"),
};
const record = {
  status: result.status === 0 ? "recorded" : "failed",
  at: new Date().toISOString(),
  ...stageFingerprints(root, loadStage("m2")),
  generator: "scripts/live-models.mjs",
  runner: "vitest tests/agent/live-models.test.ts with MANGA_LIVE_MODELS=1",
  probes,
  network: Object.values(probes).some((item) => item.status !== "not-run"),
  secretsRecorded: false,
  notes: "Synthetic prompts and a silent synthetic WAV only; no user material, credentials or provider bodies are recorded. Purposes read from the ignored .env.local; an unconfigured purpose stays not-run.",
};
fs.writeFileSync(path.join(evidence, "live-api.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ status: record.status, check: "live-models", probes: Object.fromEntries(Object.entries(probes).map(([key, value]) => [key, value.status])) }));
process.exit(result.status === 0 ? 0 : 1);
