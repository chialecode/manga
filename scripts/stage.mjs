import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStageReport, runStageTest } from "./stage/test.mjs";

// node scripts/stage.mjs test|bench|package|report
// The stage comes from the document registry (currentStage); the gate definition is scripts/stage/gate.json.
// Output goes to dist/evidence-runs/<run>/ (run = STAGE_RUN or "current"); only the chosen final results are
// copied to docs/evidence/gate/ by hand.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command] = process.argv.slice(2);
const usage = "usage: node scripts/stage.mjs test|bench|package|report";
if (!command) {
  console.error(usage);
  process.exit(2);
}

function script(name) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", `scripts/stage/${name}.mjs`], { cwd: root, stdio: "inherit", env: process.env });
  return result.status ?? 1;
}

try {
  if (command === "test") process.exitCode = runStageTest();
  else if (command === "bench") process.exitCode = script("bench");
  else if (command === "package") process.exitCode = script("package");
  else if (command === "report") process.exitCode = runStageReport();
  else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
