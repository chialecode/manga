import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStageReport, runStageTest } from "./stage/test.mjs";

// node scripts/stage.mjs <stage> test|bench|package|report
// Output goes to dist/evidence-runs/<stage>/<run>/ (run = STAGE_RUN or "current"); only chosen final
// results are copied to docs/evidence/<stage>/ by hand.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [stage, command] = process.argv.slice(2);
const usage = "usage: node scripts/stage.mjs <stage> test|bench|package|report";
if (!stage || !command) {
  console.error(usage);
  process.exit(2);
}

function script(name) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", `scripts/stage/${name}.mjs`, stage], { cwd: root, stdio: "inherit", env: process.env });
  return result.status ?? 1;
}

try {
  if (command === "test") process.exitCode = runStageTest(stage);
  else if (command === "bench") process.exitCode = script("bench");
  else if (command === "package") process.exitCode = script("package");
  else if (command === "report") process.exitCode = runStageReport(stage);
  else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
