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
    allow: [/^node:/, /^\.\//, /^@manga\/contracts(\/[\w.-]+)?$/],
    forbid: [/^@manga\/kernel/, /^electron$/],
  },
  {
    dir: "packages/kernel/src",
    allow: [/^node:/, /^\.\//, /^@manga\/contracts(\/[\w.-]+)?$/, /^@manga\/plugin-sdk$/],
    forbid: [/^electron$/],
  },
  {
    dir: "packages/i18n/src",
    allow: [/^node:/, /^\.\//],
    forbid: [/^@manga\//, /^electron$/],
  },
  {
    dir: "packages/storage-drizzle/src",
    allow: [/^node:/, /^\.\//, /^@manga\/contracts(\/[\w.-]+)?$/, /^better-sqlite3$/, /^drizzle-orm/],
    forbid: [/^@manga\/kernel/, /^electron$/],
  },
  {
    dir: "packages/model-protocol/src",
    allow: [/^node:/, /^\.\//, /^@manga\/contracts(\/[\w.-]+)?$/, /^@earendil-works\/pi-ai/],
    forbid: [/^@manga\/kernel/, /^electron$/],
  },
  {
    dir: "packages/app-core/src",
    // sharp, yauzl and anitomy serve the comic and media services; zod validates what the Bangumi client receives; readability and linkedom read a fetched
    // page as text; fflate writes and reads project packages; mdast-util-to-markdown writes a note's blocks as the Markdown file kept in its work's folder.
    allow: [/^node:/, /^\.\//, /^@manga\/contracts(\/[\w.-]+)?$/, /^@manga\/plugin-sdk$/, /^@manga\/kernel$/, /^@manga\/storage-drizzle$/, /^@manga\/model-protocol$/, /^@manga\/i18n$/, /^sharp$/, /^yauzl$/, /^anitomy$/, /^zod$/, /^@mozilla\/readability$/, /^linkedom$/, /^fflate$/, /^mdast-util-to-markdown$/],
    forbid: [/^electron$/],
  },
  {
    // A first-party plugin is a package of its own: it reaches the product only through the wire protocol, never by importing it.
    dir: "plugins/acquisition-bt",
    allow: [/^node:/, /^\.\//, /^webtorrent$/, /^parse-torrent$/],
    forbid: [/^@manga\//, /^electron$/],
  },
];

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name === "node_modules") continue;
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) acc.push(full);
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
        // A relative import may go up into a sibling folder of the same package, but not out of it.
        if (spec.startsWith(".")) {
          const packageDir = path.join(base, rule.dir);
          const target = path.resolve(path.dirname(file), spec);
          if (target !== packageDir && !target.startsWith(packageDir + path.sep)) errors.push(`${path.relative(base, file)}: illegal import ${spec} (leaves ${rule.dir})`);
          continue;
        }
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
  fs.mkdirSync(path.join(dir, "packages/contracts/src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "plugins/acquisition-bt/src"), { recursive: true });
  const put = (file, lines) => fs.writeFileSync(path.join(dir, file), lines.join("\n") + "\n");
  put("packages/contracts/src/bad.ts", ['import electron from "electron";']);
  put("packages/contracts/src/up.ts", ['import { x } from "../../../other/outside.ts";']);
  put("packages/contracts/src/ok.ts", ['import { y } from "./bad.ts";']);
  put("plugins/acquisition-bt/src/reach.mjs", ['import { run } from "@manga/app-core";']);
  put("plugins/acquisition-bt/src/fine.mjs", ['import WebTorrent from "webtorrent";', 'import { connect } from "./link.mjs";']);
  const errors = checkTree(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!errors.some((item) => item.includes("electron"))) {
    throw new Error("dependency gate self-test did not fail on electron import");
  }
  if (!errors.some((item) => item.includes("outside.ts"))) {
    throw new Error("dependency gate self-test did not fail on a relative import that leaves the package");
  }
  if (!errors.some((item) => item.includes("reach.mjs"))) {
    throw new Error("dependency gate self-test did not fail on a plugin that imports the product");
  }
  if (errors.some((item) => item.includes("fine.mjs"))) {
    throw new Error("dependency gate self-test rejected a plugin's own dependency");
  }
  if (errors.some((item) => item.includes("ok.ts"))) {
    throw new Error("dependency gate self-test rejected a relative import inside the package");
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
