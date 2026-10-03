import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";
import { evaluateM1bEvidence } from "./m1b-report.mjs";
import required from "./m1b-required-cases.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
if (!fs.existsSync(vitest)) {
  console.error("FAILED m1b tests: vitest is not installed");
  process.exit(1);
}
const evidence = path.resolve(root, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/b-final");
fs.mkdirSync(evidence, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1b-vitest-"));
const reporterFile = path.join(scratch, "vitest.json");
const result = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.m1b.config.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${reporterFile}`], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, M1B_LARGE: "1" },
});
const vitestReport = fs.existsSync(reporterFile) ? JSON.parse(fs.readFileSync(reporterFile, "utf8")) : undefined;
fs.rmSync(scratch, { recursive: true, force: true });
if (result.status !== 0 || !vitestReport) process.exit(result.status || 1);

const reportSelfTest = spawnSync(process.execPath, ["--test", "scripts/m1b-report.test.mjs"], { cwd: root, stdio: "inherit" });
const executed = [];
for (const file of vitestReport.testResults ?? []) {
  const relative = path.relative(root, file.name).replaceAll("\\", "/");
  for (const assertion of file.assertionResults ?? []) {
    const status = assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "not-run";
    executed.push({ file: relative, name: assertion.fullName, status });
  }
}
executed.push({ file: "scripts/m1b-report.test.mjs", name: "scripts/m1b-report.test.mjs", status: reportSelfTest.status === 0 ? "passed" : "failed" });

const fingerprints = m1bFingerprints(root);
const cases = (required["cases.json"] ?? []).map((def) => {
  const tests = [];
  for (const pattern of def.tests ?? []) {
    const regex = new RegExp(pattern);
    const matched = executed.filter((entry) => regex.test(entry.name) && entry.status !== "not-run");
    if (!matched.length) tests.push({ file: "tests/m1b", name: pattern, status: "not-run" });
    for (const entry of matched) tests.push({ file: entry.file, name: entry.name, status: entry.status });
  }
  const status = tests.some((entry) => entry.status !== "passed") ? (tests.some((entry) => entry.status === "failed") ? "failed" : "not-run") : "passed";
  return { caseId: def.id, kind: def.kind, status, tests };
});
const testRun = {
  status: vitestReport.success && reportSelfTest.status === 0 && cases.every((entry) => entry.status === "passed") ? "passed" : "failed",
  at: new Date().toISOString(),
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
  generator: "scripts/verify-m1b.mjs",
  productAcceptance: "not-run",
  cases,
}, null, 2)}\n`);
if (testRun.status !== "passed") {
  console.error(JSON.stringify({ status: "failed", check: "m1b-test", cases: cases.filter((entry) => entry.status !== "passed").map((entry) => entry.caseId) }));
  process.exit(1);
}
const hasReport = ["bench.json", "package.json"].every((name) => fs.existsSync(path.join(evidence, name)));
if (hasReport || process.env.M1B_REQUIRE_REPORT === "1") {
  const report = evaluateM1bEvidence(evidence, fingerprints, { requirePdfCounterexamples: process.env.M1B_REQUIRE_REPORT === "1" });
  fs.writeFileSync(path.join(evidence, "report.json"), `${JSON.stringify({ ...report, ...fingerprints, at: new Date().toISOString() }, null, 2)}\n`);
  if (!report.engineeringReviewable) {
    console.error(JSON.stringify({ status: "failed", check: "m1b-report", errors: report.errors }, null, 2));
    process.exit(1);
  }
}
console.log(JSON.stringify({ status: "passed", check: "m1b-verify", evidence: path.relative(root, evidence).replaceAll("\\", "/"), productAcceptance: "not-run" }));
