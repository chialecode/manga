import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importRe = /(?:from|import)\s+["']([^"']+)["']/g;

const rules = [
  {
    dir: "packages/contracts/src",
    allow: [/^node:/, /^\.\//, /^zod$/],
    forbid: [/^@manga\//, /^electron$/],
  },
  {
    dir: "packages/plugin-sdk/src",
    allow: [/^node:/, /^\.\//, /^@manga\/contracts$/],
    forbid: [/^@manga\/kernel/, /^@manga\/storage-sqlite/, /^electron$/],
  },
  {
    dir: "packages/kernel/src",
    allow: [/^node:/, /^\.\//, /^@manga\/contracts$/, /^@manga\/plugin-sdk$/],
    forbid: [/^@manga\/storage-sqlite/, /^electron$/],
  },
  {
    dir: "packages/storage-sqlite/src",
    allow: [/^node:/, /^\.\//, /^@manga\/contracts$/],
    forbid: [/^@manga\/kernel/, /^electron$/],
  },
  {
    dir: "experiments/m0/src/domain",
    allow: [/^node:/, /^\.\//, /^@manga\/contracts$/, /^fflate$/, /^parse5$/],
    forbid: [/^@manga\/kernel/, /^@manga\/storage-sqlite/, /^electron$/],
  },
];

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

export function checkTree(base = root) {
  const errors = [];
  for (const rule of rules) {
    for (const file of walk(path.join(base, rule.dir))) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(importRe)) {
        const spec = match[1];
        const allowed = rule.allow.some((re) => re.test(spec));
        const forbidden = rule.forbid.some((re) => re.test(spec));
        if (forbidden || !allowed) {
          errors.push(`${path.relative(base, file)}: illegal import ${spec}`);
        }
      }
    }
  }
  return errors;
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-dep-"));
  fs.mkdirSync(path.join(dir, "experiments/m0/src/domain"), { recursive: true });
  fs.writeFileSync(path.join(dir, "experiments/m0/src/domain/bad.ts"), 'import electron from "electron";\n');
  const errors = checkTree(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!errors.some((item) => item.includes("electron"))) {
    throw new Error("dependency gate self-test did not fail on electron import");
  }
}

selfTest();
const errors = checkTree(root);
if (process.argv.includes("--self-test-only")) {
  console.log(JSON.stringify({ status: "passed", check: "dependency-boundary-self-test" }));
  process.exit(0);
}
for (const error of errors) console.error(`ERROR ${error}`);
console.log(JSON.stringify({ status: errors.length ? "failed" : "passed", check: "dependency-boundary", errors: errors.length }));
process.exitCode = errors.length ? 1 : 0;
