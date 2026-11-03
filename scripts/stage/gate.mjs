import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fingerprintKeysOf, loadGate, readJson, repoRoot as root, runDir, stageFingerprints } from "./lib.mjs";

/**
 * node scripts/stage.mjs gate: the whole stage gate in one command, in the order that finds a failure soonest (LOOP-27, quality gates 2):
 *
 *   verify (without its test run) → test → package → installer → bench → report → package until the consecutive passes are reached → report
 *
 * A step whose result in the run directory is passed and current for the inputs it depends on (gate.json fingerprintOf) is not run again, so after a
 * change to the bench's own code only the bench and the report run, and after a change to the tests only the tests. The first failure stops the gate.
 * The bench comes before the second and third package runs: it is the slowest step to fail, and a failure there would make them stale anyway.
 * What ran, what was kept and how long each step took go to gate-run.json in the run directory (not evidence; the report does not read it).
 */
const config = loadGate();
const evidence = runDir();
const startedAt = new Date();
const steps = [];
const node = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env }).status ?? 1;
const record = (name, outcome, ms = 0) => {
  steps.push({ name, outcome, seconds: Math.round(ms / 1000) });
  console.log(`[gate] ${name}: ${outcome}${ms ? ` (${Math.round(ms / 1000)} s)` : ""}`);
};
const finish = (status) => {
  fs.writeFileSync(path.join(evidence, "gate-run.json"), `${JSON.stringify({ status, at: startedAt.toISOString(), seconds: Math.round((Date.now() - startedAt.getTime()) / 1000), steps }, null, 2)}\n`);
  console.log(JSON.stringify({ status, check: "stage-gate", steps: steps.map((step) => `${step.name}:${step.outcome}`) }));
  process.exit(status === "passed" ? 0 : 1);
};
/** Whether every named result is passed and was made from the inputs it depends on, as they are now. */
const current = (...files) => {
  const now = stageFingerprints(root, config);
  return files.every((file) => {
    const item = readJson(evidence, file);
    return item && item.status === "passed" && fingerprintKeysOf(config, file).every((key) => item[key] === now[key]);
  });
};
const run = (name, args, { skipWhen } = {}) => {
  if (skipWhen?.()) return record(name, "current, kept");
  const started = Date.now();
  const status = node(args);
  record(name, status === 0 ? "passed" : `failed (exit ${status})`, Date.now() - started);
  if (status !== 0) finish("failed");
};

const fingerprintsAtStart = stageFingerprints(root, config);
// The checks that are not tests (types, unused code, documents, publication, dependency boundaries); the tests themselves run once, in the next step.
run("verify", ["scripts/verify.mjs", "--skip-tests"]);
run("test", ["scripts/stage.mjs", "test"], { skipWhen: () => current("cases.json", "test-run.json") });
run("package", ["scripts/stage.mjs", "package"], { skipWhen: () => current("package.json", "scenarios.json") });
run("installer", ["scripts/stage.mjs", "installer"], { skipWhen: () => current("installer.json") });
run("bench", ["scripts/stage.mjs", "bench"], { skipWhen: () => current("bench.json") });
const wanted = config.package.passStreak ?? 1;
for (;;) {
  const streak = current("package.json") ? readJson(evidence, "package.json").passStreak ?? 1 : 0;
  if (streak >= wanted) break;
  run(`package (pass ${streak + 1} of ${wanted})`, ["scripts/stage.mjs", "package"]);
}
// An edit made while the gate ran leaves some result stale; the report names it, and the next gate runs only what it touched.
const changed = Object.keys(fingerprintsAtStart).filter((key) => stageFingerprints(root, config)[key] !== fingerprintsAtStart[key]);
if (changed.length) console.error(`[gate] inputs changed while the gate ran: ${changed.join(", ")}`);
run("report", ["scripts/stage.mjs", "report"]);
finish("passed");
