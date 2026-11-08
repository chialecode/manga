import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStageReport, runStageTest } from "./stage/test.mjs";

// node scripts/stage.mjs gate|test|bench|package|installer|install-dev|release|report
// gate runs the whole gate in the order that fails soonest and skips a step whose result is still current (scripts/stage/gate.mjs).
// The stage comes from the document registry (currentStage); the gate definition is scripts/stage/gate.json.
// Output goes to dist/evidence-runs/<run>/ (run = STAGE_RUN or "current"); only the chosen final results are
// copied to docs/evidence/gate/ by hand.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...restArgs] = process.argv.slice(2);
const usage = "usage: node scripts/stage.mjs gate|test|bench|package|installer|install-dev|release|report";
if (!command) {
  console.error(usage);
  process.exit(2);
}

function script(name, extraArgs = []) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", `scripts/stage/${name}.mjs`, ...extraArgs], { cwd: root, stdio: "inherit", env: process.env });
  return result.status ?? 1;
}

try {
  if (command === "gate") process.exitCode = script("gate", restArgs);
  else if (command === "test") process.exitCode = runStageTest();
  else if (command === "bench") process.exitCode = script("bench", restArgs);
  else if (command === "package") process.exitCode = script("package", restArgs);
  // A real installation and removal of both channels (计划 4.8); run on its own, after package.
  else if (command === "installer") process.exitCode = script("installer", restArgs);
  else if (command === "install-dev") process.exitCode = script("install-dev", restArgs);
  else if (command === "release") process.exitCode = script("release", restArgs);
  else if (command === "report") process.exitCode = runStageReport();
  else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
