import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;

function run(label, command, args) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.error || result.status !== 0) {
    console.error(`FAILED ${label}`);
    failed = true;
  }
}

if (!fs.existsSync(path.join(root, "node_modules"))) {
  console.error("node_modules missing; run pnpm install");
  process.exit(1);
}

run("doctor", process.execPath, ["scripts/m0.mjs", "doctor"]);
run("deps", process.execPath, ["scripts/check-deps.mjs"]);
run("deps-counterexample", process.execPath, ["scripts/check-deps.mjs", "--self-test-only"]);
run("report-counterexample", process.execPath, ["--test", "scripts/m0-report.test.mjs"]);
run("typecheck", process.execPath, ["scripts/m0.mjs", "typecheck"]);
run("fixtures", process.execPath, ["scripts/m0.mjs", "fixtures"]);
run("test", process.execPath, ["scripts/m0.mjs", "test"]);
run("report", process.execPath, ["scripts/m0.mjs", "report"]);

const summaryPath = path.join(path.resolve(root, process.env.M0_EVIDENCE_DIR ?? "docs/evidence/m0-closure"), "summary.json");
const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, "utf8")) : {};
console.log(JSON.stringify({
  status: failed ? "failed" : "passed",
  check: "verify-m0",
  evidenceDir: path.relative(root,path.dirname(summaryPath)).replaceAll("\\","/"),
  automationStatus: failed ? "failed" : summary.automationStatus ?? "unknown",
  engineeringReviewable: summary.engineeringReviewable ?? false,
  m0Exit: summary.m0Exit ?? "not-assessed-see-stage-gates",
  m1Entry: summary.m1Entry ?? "not-assessed-see-stage-gates",
}, null, 2));
process.exitCode = failed ? 1 : 0;
