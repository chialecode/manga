import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { sourceFingerprint, m1aSourceFingerprint } from "./m1a-fingerprint.mjs";
import { evaluateM1aEvidence } from "./m1a-report.mjs";
import required from "./m1a-required-cases.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
if (!fs.existsSync(vitest)) {
  console.error("FAILED m1a tests: vitest is not installed");
  process.exit(1);
}
const evidence = path.resolve(root, process.env.M1A_EVIDENCE_DIR ?? "docs/evidence/m1a-review");
fs.mkdirSync(evidence, { recursive: true });

// The JSON reporter output is the only source for cases.json; a hand-written file is always replaced.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1a-vitest-"));
const reporterFile = path.join(scratch, "vitest.json");
const result = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.config.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${reporterFile}`], { cwd: root, stdio: "inherit" });
const vitestReport = fs.existsSync(reporterFile) ? JSON.parse(fs.readFileSync(reporterFile, "utf8")) : undefined;
fs.rmSync(scratch, { recursive: true, force: true });
if (result.status !== 0 || !vitestReport) process.exit(result.status || 1);

const reportSelfTest = spawnSync(process.execPath, ["--test", "scripts/m1a-report.test.mjs"], { cwd: root, stdio: "inherit" });

const executed = [];
for (const file of vitestReport.testResults ?? []) {
  const relative = path.relative(root, file.name).replaceAll("\\", "/");
  for (const assertion of file.assertionResults ?? []) {
    executed.push({ file: relative, name: assertion.fullName, status: assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "not-run" });
  }
}
executed.push({ file: "scripts/m1a-report.test.mjs", name: "scripts/m1a-report.test.mjs", status: reportSelfTest.status === 0 ? "passed" : "failed" });

const fingerprints = {
  sourceFingerprint: sourceFingerprint(root),
  m1aSourceFingerprint: m1aSourceFingerprint(root),
};
const cases = (required["cases.json"] ?? []).map((def) => {
  const tests = [];
  for (const pattern of def.tests ?? []) {
    const regex = new RegExp(pattern);
    const matched = executed.filter((entry) => regex.test(entry.name));
    if (!matched.length) tests.push({ pattern, status: "not-run" });
    for (const entry of matched) tests.push({ file: entry.file, name: entry.name, status: entry.status });
  }
  const status = !tests.length || tests.some((entry) => entry.status === "not-run")
    ? "not-run"
    : tests.some((entry) => entry.status === "failed") ? "failed" : "passed";
  return { caseId: def.id, kind: def.kind, status, tests };
});
const testRun = {
  status: vitestReport.success && reportSelfTest.status === 0 ? "passed" : "failed",
  at: new Date().toISOString(),
  ...fingerprints,
  runner: "vitest",
  files: (vitestReport.testResults ?? []).length,
  tests: { total: vitestReport.numTotalTests, passed: vitestReport.numPassedTests, failed: vitestReport.numFailedTests, skipped: vitestReport.numPendingTests + vitestReport.numTodoTests },
  reportSelfTest: reportSelfTest.status === 0 ? "passed" : "failed",
};
fs.writeFileSync(path.join(evidence, "test-run.json"), `${JSON.stringify(testRun, null, 2)}\n`);
fs.writeFileSync(path.join(evidence, "cases.json"), `${JSON.stringify({
  status: cases.every((entry) => entry.status === "passed") ? "passed" : "failed-or-incomplete",
  at: testRun.at,
  ...fingerprints,
  generator: "scripts/verify-m1a.mjs",
  cases,
}, null, 2)}\n`);
const hasReport = ["bench.json", "package.json"].every((name) => fs.existsSync(path.join(evidence, name)));
if (hasReport || process.env.M1A_REQUIRE_REPORT === "1") {
  const report = evaluateM1aEvidence(evidence, fingerprints);
  fs.writeFileSync(path.join(evidence, "report.json"), `${JSON.stringify({ ...report, ...fingerprints, at: new Date().toISOString() }, null, 2)}\n`);
  if (!report.engineeringReviewable) {
    console.error(JSON.stringify({ status: "failed", check: "m1a-report", errors: report.errors }, null, 2));
    process.exit(1);
  }
}
if (testRun.status !== "passed") {
  console.error(JSON.stringify({ status: "failed", check: "m1a-verify", reportSelfTest: testRun.reportSelfTest }));
  process.exit(1);
}
console.log(JSON.stringify({ status: "passed", check: "m1a-verify", ...fingerprints, cases: cases.map((entry) => `${entry.caseId}:${entry.status}`), reportEvaluated: hasReport || process.env.M1A_REQUIRE_REPORT === "1" }));
