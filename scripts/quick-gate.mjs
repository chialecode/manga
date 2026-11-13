import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// node scripts/quick-gate.mjs [--phases a,b] [--all-tests]
//
// The everyday tier of the gate (person's decision of 2026-11-14): after a change inside a stage, after A's fixes and after an
// in-stage addition, run this instead of `stage gate`. It aims at five minutes:
//   1. `verify --skip-tests` (types, knip, docs, publication, dependency boundaries);
//   2. the Vitest files related to the files changed since HEAD (`--all-tests`: every test);
//   3. only the packaged window-observation phases the change touches (`--phases`, as MANGA_PACKAGE_PHASES; none by default).
// It writes no evidence and does not stand in for the full gate, which runs once when B hands over a whole stage
// (docs/dev-rules/quality-gates.md#gate-tiers).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET_SECONDS = 300;
const args = process.argv.slice(2);
const allTests = args.includes("--all-tests");
const phasesAt = args.indexOf("--phases");
const phases = phasesAt >= 0 ? (args[phasesAt + 1] ?? "").trim() : "";
if (phasesAt >= 0 && !phases) {
  console.error("usage: node scripts/quick-gate.mjs [--phases a,b] [--all-tests]");
  process.exit(2);
}

const started = Date.now();
const steps = [];

function run(name, command, commandArgs, env = {}) {
  const at = Date.now();
  console.log(`[quick] ${name} …`);
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  const seconds = Math.round((Date.now() - at) / 1000);
  const ok = result.status === 0;
  steps.push({ name, ok, seconds });
  console.log(`[quick] ${name}: ${ok ? "passed" : `failed (exit ${result.status ?? "signal"})`} (${seconds} s)`);
  return ok;
}

/** Files changed since HEAD, tracked or new, as repository-relative paths. */
function changedFiles() {
  const git = (gitArgs) => spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" }).stdout ?? "";
  const names = [...git(["diff", "--name-only", "HEAD"]).split("\n"), ...git(["ls-files", "--others", "--exclude-standard"]).split("\n")];
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].filter((name) => fs.existsSync(path.join(root, name)));
}

function finish(ok) {
  const seconds = Math.round((Date.now() - started) / 1000);
  const over = seconds > BUDGET_SECONDS;
  console.log(JSON.stringify({ status: ok ? "passed" : "failed", check: "quick-gate", seconds, budgetSeconds: BUDGET_SECONDS, overBudget: over, steps, phases: phases || null }));
  if (over) console.log(`[quick] took ${seconds} s, over the ${BUDGET_SECONDS} s budget: next time name fewer phases, or leave the rest to the full gate at stage handover`);
  process.exit(ok ? 0 : 1);
}

if (!run("verify", process.execPath, ["scripts/verify.mjs", "--skip-tests"])) finish(false);

const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
if (allTests) {
  if (!run("tests (all)", process.execPath, [vitest, "run", "--config", "vitest.config.ts"])) finish(false);
} else {
  const changed = changedFiles().filter((name) => /\.(c|m)?(t|j)sx?$/.test(name));
  if (changed.length === 0) {
    console.log("[quick] tests: no changed source or test files since HEAD, none to run");
    steps.push({ name: "tests (related)", ok: true, seconds: 0, files: 0 });
  } else if (!run(`tests related to ${changed.length} changed file(s)`, process.execPath, [vitest, "related", "--run", "--config", "vitest.config.ts", "--passWithNoTests", ...changed])) {
    finish(false);
  }
}

if (phases && !run(`packaged phases ${phases}`, process.execPath, ["scripts/stage.mjs", "package"], { MANGA_PACKAGE_PHASES: phases })) finish(false);
finish(true);
