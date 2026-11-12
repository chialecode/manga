import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { currentStage, loadGate, repoRoot, runDir, stageFingerprints } from "./lib.mjs";
import { writeReport } from "./report.mjs";
import { loadManifest } from "../samples/media-manifest.mjs";

/** A new attempt supersedes the old result immediately, including when the test process exits before writing its report. */
export function beginTestEvidence(evidence, fields) {
  fs.rmSync(path.join(evidence, "cases.json"), { force: true });
  const started = { ...fields, status: "running", at: new Date().toISOString(), runner: "vitest", productAcceptance: "not-run" };
  fs.writeFileSync(path.join(evidence, "test-run.json"), `${JSON.stringify(started, null, 2)}\n`);
}

/**
 * With `--ci` (the release workflow's check on a hosted runner), a required test that did not run is accepted only when gate.json
 * `optionalSampleTests` ties it to optional samples the generator marked unavailable on this machine (a GPU encoder, Windows voices).
 * Such a test stays `not-run` in the evidence, with the reason; anything else that did not run, and every failure, still fails.
 * Without `--ci` every required test must pass, as stage evidence requires.
 */
export function excusedBy(config, ci, manifest = loadManifest()) {
  const unavailable = new Set((manifest?.samples ?? []).filter((sample) => sample.status === "unavailable").map((sample) => sample.id));
  return (pattern) => {
    const samples = config.optionalSampleTests?.[pattern];
    return ci && samples?.length && samples.every((id) => unavailable.has(id)) ? `optional samples not generated on this machine: ${samples.join(", ")}` : null;
  };
}

/** node scripts/stage.mjs test: every Vitest case plus the script self-tests, matched to the required cases. */
export function runStageTest({ withReport = false, ci = process.argv.includes("--ci") } = {}) {
  const stage = currentStage();
  const config = loadGate();
  const excuse = excusedBy(config, ci);
  const root = repoRoot;
  const evidence = runDir();
  const fingerprints = stageFingerprints(root, config);
  beginTestEvidence(evidence, { stage, ...fingerprints });
  const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
  if (!fs.existsSync(vitest)) {
    fs.writeFileSync(path.join(evidence, "test-run.json"), `${JSON.stringify({ stage, ...fingerprints, status: "failed", reason: "vitest is not installed", productAcceptance: "not-run" }, null, 2)}\n`);
    console.error("FAILED stage tests: vitest is not installed");
    return 1;
  }
  // Taken before the tests run: an edit made during the run leaves the result stale.
  const leftoversBefore = testTempEntries();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "manga-vitest-"));
  const reporterFile = path.join(scratch, "vitest.json");
  // Stage evidence runs every test: the large files on, and never the CI switch that skips tests needing the media tools.
  // The global setup and its workers all live under this attempt's root. Keep it on failure; delete it after a successful run.
  const env = { ...process.env, MANGA_LARGE_FILES: "1", MANGA_KEEP_TEST_TMP: "1", TMP: scratch, TEMP: scratch, TMPDIR: scratch };
  delete env.MANGA_MEDIA_PREREQUISITES;
  const result = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.config.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${reporterFile}`], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  const vitestReport = fs.existsSync(reporterFile) ? JSON.parse(fs.readFileSync(reporterFile, "utf8")) : {
    success: false, testResults: [], numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0,
  };

  const selfTests = ["scripts/stage-report.test.mjs", "scripts/check-docs.test.mjs"];
  const executed = [];
  for (const file of vitestReport.testResults ?? []) {
    const relative = path.relative(root, file.name).replaceAll("\\", "/");
    for (const assertion of file.assertionResults ?? []) {
      const status = assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "not-run";
      executed.push({ file: relative, name: assertion.fullName, status });
    }
  }
  for (const file of selfTests) {
    const run = spawnSync(process.execPath, ["--test", file], { cwd: root, stdio: "inherit" });
    executed.push({ file, name: file, status: run.status === 0 ? "passed" : "failed" });
  }

  const selfTestsPassed = executed.filter((entry) => selfTests.includes(entry.file)).every((entry) => entry.status === "passed");
  const cases = config.cases.map((def) => {
    const tests = [];
    for (const pattern of def.tests ?? []) {
      const regex = new RegExp(pattern);
      const matched = executed.filter((entry) => regex.test(entry.name) && entry.status !== "not-run");
      const reason = matched.length ? null : excuse(pattern);
      if (!matched.length) tests.push({ file: "tests", name: pattern, status: "not-run", ...(reason ? { excused: reason } : {}) });
      for (const entry of matched) tests.push({ file: entry.file, name: entry.name, status: entry.status });
    }
    const status = tests.some((entry) => entry.status !== "passed") ? (tests.some((entry) => entry.status === "failed") ? "failed" : "not-run") : "passed";
    return { caseId: def.id, kind: def.kind, status, tests };
  });
  const accepted = (entry) => entry.status === "passed" || (entry.status === "not-run" && entry.tests.every((test) => test.status === "passed" || test.excused));
  const allAccepted = cases.every(accepted);
  if (result.status === 0 && vitestReport.success && selfTestsPassed && allAccepted) {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
  // A passed attempt leaves nothing; a failed attempt retains its synthetic profile and reporter for diagnosis.
  const entriesAfter = testTempEntries();
  const leftovers = [...entriesAfter].filter((name) => !leftoversBefore.has(name));
  const tempDirs = {
    before: leftoversBefore.size,
    after: entriesAfter.size,
    removed: fs.existsSync(scratch) ? 0 : 1,
    left: leftovers.length,
    prefixes: [...new Set(leftovers.map((name) => name.replace(/[^-]*$/, "")))],
  };
  const testRun = {
    tempDirs,
    status: result.status === 0 && vitestReport.success && selfTestsPassed && allAccepted && tempDirs.left === 0 ? "passed" : "failed",
    ...(cases.some((entry) => entry.status !== "passed") && allAccepted ? { excusedCases: cases.filter((entry) => entry.status !== "passed").map((entry) => entry.caseId) } : {}),
    at: new Date().toISOString(),
    stage,
    ...fingerprints,
    runner: "vitest",
    productAcceptance: "not-run",
    tests: { total: vitestReport.numTotalTests, passed: vitestReport.numPassedTests, failed: vitestReport.numFailedTests, skipped: vitestReport.numPendingTests },
  };
  fs.writeFileSync(path.join(evidence, "test-run.json"), `${JSON.stringify(testRun, null, 2)}\n`);
  fs.writeFileSync(path.join(evidence, "cases.json"), `${JSON.stringify({
    status: cases.every((entry) => entry.status === "passed") ? "passed" : "failed-or-incomplete",
    at: testRun.at,
    ...fingerprints,
    generator: "scripts/stage/test.mjs",
    productAcceptance: "not-run",
    cases,
  }, null, 2)}\n`);
  if (tempDirs.left > 0) {
    console.error(JSON.stringify({ status: "failed", check: "stage-test", reason: "temporary directories left behind", count: leftovers.length, ...tempDirs }));
    return 1;
  }
  if (testRun.status !== "passed") {
    console.error(JSON.stringify({ status: "failed", check: "stage-test", cases: cases.filter((entry) => entry.status !== "passed").map((entry) => entry.caseId) }));
    return 1;
  }
  if (withReport) return runStageReport();
  console.log(JSON.stringify({ status: "passed", check: "stage-test", evidence: path.relative(root, evidence).replaceAll("\\", "/"), productAcceptance: "not-run" }));
  return 0;
}

/** The entries of the system's temporary folder named the way this repository's tests and stage scripts name theirs. */
function testTempEntries() {
  try {
    return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("manga-")));
  } catch {
    return new Set();
  }
}

/** node scripts/stage.mjs report: evaluate the run directory; non-zero for any missing, stale or failed item. */
export function runStageReport() {
  const config = loadGate();
  const evidence = runDir();
  const report = writeReport(evidence, stageFingerprints(repoRoot, config), config);
  if (!report.engineeringReviewable) {
    console.error(JSON.stringify({ status: "failed", check: "stage-report", errors: report.errors }, null, 2));
    return 1;
  }
  console.log(JSON.stringify({ status: "passed", check: "stage-report", evidence: path.relative(repoRoot, evidence).replaceAll("\\", "/"), productAcceptance: "not-run" }));
  return 0;
}
