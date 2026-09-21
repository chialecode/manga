import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { sourceFingerprint } from "../experiments/m0/src/report.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "test";

function run(commandName, args, extra = {}) {
  const result = spawnSync(commandName, args, { cwd: root, stdio: "inherit", ...extra });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (command === "test") {
  const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
  if (!fs.existsSync(vitest)) {
    console.error("vitest is not installed; run pnpm install");
    process.exit(1);
  }
  run(process.execPath, [vitest, "run", "--config", "vitest.config.ts"]);
} else if (command === "package") {
  run(process.execPath, ["scripts/package-m1a.mjs"]);
} else if (command === "bench") {
  run(process.execPath, ["scripts/bench-m1a.mjs"]);
} else if (command === "live") {
  run(process.execPath, ["scripts/m1a-live.mjs"]);
} else {
  console.error("usage: node scripts/m1a.mjs test|package|bench|live");
  process.exit(2);
}

if (command === "test") {
  console.log(JSON.stringify({ status: "passed", check: "m1a-test", sourceFingerprint: sourceFingerprint(root) }));
}
