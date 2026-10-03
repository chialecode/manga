import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "test";

function run(script) {
  const result = spawnSync(process.execPath, [script], { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (command === "test") run("scripts/verify-m1b.mjs");
else if (command === "bench") run("scripts/bench-m1b.mjs");
else if (command === "package") run("scripts/package-m1b.mjs");
else if (command === "report") run("scripts/verify-m1b.mjs");
else {
  console.error("usage: node scripts/m1b.mjs test|bench|package|report");
  process.exit(2);
}
