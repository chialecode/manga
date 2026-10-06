import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceRunDir } from "./desktop-paths.ts";

// Regression entry for the retained M0 prototype (experiments/m0). Exit condition: M4 acquisition replaces POC-09.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscJs = path.join(root, "node_modules/typescript/bin/tsc");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function fixtures() {
  return run(process.execPath, ["--experimental-strip-types", "experiments/m0/src/fixtures/generate.ts"]);
}

function typecheck() {
  if (!fs.existsSync(tscJs)) {
    console.error("tsc missing; run pnpm install");
    return 1;
  }
  return run(process.execPath, [tscJs, "--noEmit", "-p", "tsconfig.json"]);
}

function test() {
  const files = fs.readdirSync(path.join(root, "experiments/m0/src/tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => path.join("experiments/m0/src/tests", name));
  const evidence = path.resolve(root, process.env.M0_EVIDENCE_DIR ?? evidenceRunDir("m0", "current"));
  fs.mkdirSync(evidence, { recursive: true });
  const status = run(process.execPath, ["--experimental-strip-types", "--test", "--test-reporter=spec", "--test-concurrency=1", ...files], {
    env: { ...process.env, M0_EVIDENCE_DIR: evidence },
  });
  fs.writeFileSync(path.join(evidence, "test-run.json"), `${JSON.stringify({ status: status === 0 ? "passed" : "failed", at: new Date().toISOString(), files }, null, 2)}\n`);
  return status;
}

const command = process.argv[2] ?? "help";
const commands = { fixtures, test, typecheck };
if (command === "help" || !commands[command]) {
  console.log("node scripts/m0.mjs <fixtures|typecheck|test>");
  process.exit(command === "help" ? 0 : 2);
}
process.exit(commands[command]());
