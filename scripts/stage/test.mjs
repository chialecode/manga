import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadStage, repoRoot, runDir, stageFingerprints } from "./lib.mjs";
import { writeReport } from "./report.mjs";

/** node scripts/stage.mjs <stage> test: every Vitest case plus the script self-tests, matched to the required cases. */
export function runStageTest(stage, { withReport = false } = {}) {
  const config = loadStage(stage);
  const root = repoRoot;
  const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
  if (!fs.existsSync(vitest)) {
    console.error(`FAILED ${stage} tests: vitest is not installed`);
    return 1;
  }
  const evidence = runDir(stage);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `manga-${stage}-vitest-`));
  const reporterFile = path.join(scratch, "vitest.json");
  // Stage evidence runs every test: the large files on, and never the CI switch that skips tests needing the media tools.
  const env = { ...process.env, MANGA_LARGE_FILES: "1" };
  delete env.MANGA_MEDIA_PREREQUISITES;
  const result = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.config.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${reporterFile}`], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  const vitestReport = fs.existsSync(reporterFile) ? JSON.parse(fs.readFileSync(reporterFile, "utf8")) : undefined;
  fs.rmSync(scratch, { recursive: true, force: true });
  if (result.status !== 0 || !vitestReport) return result.status || 1;

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

  const fingerprints = stageFingerprints(root, config);
  const cases = config.cases.map((def) => {
    const tests = [];
    for (const pattern of def.tests ?? []) {
      const regex = new RegExp(pattern);
      const matched = executed.filter((entry) => regex.test(entry.name) && entry.status !== "not-run");
      if (!matched.length) tests.push({ file: "tests", name: pattern, status: "not-run" });
      for (const entry of matched) tests.push({ file: entry.file, name: entry.name, status: entry.status });
    }
    const status = tests.some((entry) => entry.status !== "passed") ? (tests.some((entry) => entry.status === "failed") ? "failed" : "not-run") : "passed";
    return { caseId: def.id, kind: def.kind, status, tests };
  });
  const selfTestsPassed = executed.filter((entry) => selfTests.includes(entry.file)).every((entry) => entry.status === "passed");
  const testRun = {
    status: vitestReport.success && selfTestsPassed && cases.every((entry) => entry.status === "passed") ? "passed" : "failed",
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
  if (testRun.status !== "passed") {
    console.error(JSON.stringify({ status: "failed", check: `${stage}-test`, cases: cases.filter((entry) => entry.status !== "passed").map((entry) => entry.caseId) }));
    return 1;
  }
  if (withReport) return runStageReport(stage);
  console.log(JSON.stringify({ status: "passed", check: `${stage}-test`, evidence: path.relative(root, evidence).replaceAll("\\", "/"), productAcceptance: "not-run" }));
  return 0;
}

/** node scripts/stage.mjs <stage> report: evaluate the run directory; non-zero for any missing, stale or failed item. */
export function runStageReport(stage) {
  const config = loadStage(stage);
  const evidence = runDir(stage);
  const report = writeReport(evidence, stageFingerprints(repoRoot, config), config);
  if (!report.engineeringReviewable) {
    console.error(JSON.stringify({ status: "failed", check: `${stage}-report`, errors: report.errors }, null, 2));
    return 1;
  }
  console.log(JSON.stringify({ status: "passed", check: `${stage}-report`, evidence: path.relative(repoRoot, evidence).replaceAll("\\", "/"), productAcceptance: "not-run" }));
  return 0;
}
