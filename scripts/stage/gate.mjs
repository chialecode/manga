import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
// MANGA_PACKAGE_IN_GATE: a package run inside the gate leaves the local development install to the gate's last step (install-dev), once.
const node = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env, MANGA_PACKAGE_IN_GATE: "1" } }).status ?? 1;
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
// A step passes when it exits 0 and its result files say passed for the inputs as they are now: an exit code alone once let a failed installer
// through to the bench (A-08).
const run = (name, args, { results } = {}) => {
  if (results && current(...results)) return record(name, "current, kept");
  const started = Date.now();
  const status = node(args);
  const outcome = status !== 0 ? `failed (exit ${status})` : results && !current(...results) ? "failed (its result is not passed)" : "passed";
  record(name, outcome, Date.now() - started);
  if (outcome !== "passed") finish("failed");
};

/**
 * The person's own MANGA places that no step may write to: the launcher pointers of the installed release and development builds, and the
 * test-identity folders, which belong in each step's temporary LOCALAPPDATA only. A step that opens the product with just a profile root and the
 * real LOCALAPPDATA writes there, and the installed application then opens a temporary library (A-06). Compared at the end of the gate.
 */
const realPlaces = () => {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const temp = path.resolve(os.tmpdir()).toLowerCase();
  const leaked = ["manga", "manga-dev"].filter((name) => {
    try {
      const root = JSON.parse(fs.readFileSync(path.join(local, name, "launcher", "pointer.json"), "utf8")).profileRoot;
      return typeof root === "string" && path.resolve(root).toLowerCase().startsWith(temp);
    } catch { return false; }
  }).map((name) => `${name} pointer leads to a temporary folder`);
  const folders = ["manga-test", "manga-dev-test"].filter((name) => fs.existsSync(path.join(local, name))).map((name) => `${name} folder`);
  return [...leaked, ...folders];
};
const realPlacesAtStart = realPlaces();
const fingerprintsAtStart = stageFingerprints(root, config);
// The checks that are not tests (types, unused code, documents, publication, dependency boundaries); the tests themselves run once, in the next step.
run("verify", ["scripts/verify.mjs", "--skip-tests"]);
run("test", ["scripts/stage.mjs", "test"], { results: ["cases.json", "test-run.json"] });
run("package", ["scripts/stage.mjs", "package"], { results: ["package.json", "scenarios.json"] });
run("installer", ["scripts/stage.mjs", "installer"], { results: ["installer.json"] });
run("bench", ["scripts/stage.mjs", "bench"], { results: ["bench.json"] });
{
  // Where the bench's time went (bench.json records.sectionSeconds), slowest first: the next place to make the gate faster.
  const sections = readJson(evidence, "bench.json")?.records?.sectionSeconds;
  const last = steps.at(-1);
  if (sections && last?.name === "bench" && last.outcome === "passed") {
    last.slowest = Object.entries(sections).sort(([, a], [, b]) => b - a).slice(0, 5).map(([name, seconds]) => ({ name, seconds }));
    console.log(`[gate] bench, slowest sections: ${last.slowest.map((item) => `${item.name} ${item.seconds} s`).join(", ")}`);
  }
}
const wanted = config.package.passStreak ?? 1;
for (;;) {
  const streak = current("package.json") ? readJson(evidence, "package.json").passStreak ?? 1 : 0;
  if (streak >= wanted) break;
  run(`package (pass ${streak + 1} of ${wanted})`, ["scripts/stage.mjs", "package"]);
  if (!current("package.json")) finish("failed");
}
// An edit made while the gate ran leaves some result stale; the report names it, and the next gate runs only what it touched.
const changed = Object.keys(fingerprintsAtStart).filter((key) => stageFingerprints(root, config)[key] !== fingerprintsAtStart[key]);
if (changed.length) console.error(`[gate] inputs changed while the gate ran: ${changed.join(", ")}`);
const realPlacesNow = realPlaces().filter((item) => !realPlacesAtStart.includes(item));
if (realPlacesNow.length) {
  record("real places", `written by a step: ${realPlacesNow.join("; ")}`);
  finish("failed");
}
run("report", ["scripts/stage.mjs", "report"]);
{
  const started = Date.now();
  const status = node(["--experimental-strip-types", "scripts/stage/install-dev.mjs"]);
  const devResult = readJson(evidence, "install-dev.json");
  const outcome = devResult?.status ?? (status === 0 ? "passed" : `failed (exit ${status})`);
  record("install-dev", outcome, Date.now() - started);
}
finish("passed");
