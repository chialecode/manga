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
    // page as text; fflate writes and reads project packages; mdast-util-to-markdown writes a note's blocks as the Markdown file kept in its work's folder;
    // pinyin-pro, wanakana and opencc-js normalize readings and script conversion for voice dictation. sherpa-onnx-node stays exclusively in asr-host.
    allow: [/^node:/, /^\.\//, /^@manga\/contracts(\/[\w.-]+)?$/, /^@manga\/plugin-sdk$/, /^@manga\/kernel$/, /^@manga\/storage-drizzle$/, /^@manga\/model-protocol$/, /^@manga\/i18n$/, /^sharp$/, /^yauzl$/, /^anitomy$/, /^zod$/, /^@mozilla\/readability$/, /^linkedom$/, /^fflate$/, /^mdast-util-to-markdown$/, /^pinyin-pro$/, /^wanakana$/, /^opencc-js(\/[\w.-]+)?$/],
    forbid: [/^electron$/, /^sherpa-onnx/],
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

/**
 * Light open (A-128, 4.1): what the bootstrap entry, light open's main process and its page reach, followed import by import from each entry. The
 * bootstrap uses Node and Electron alone; light open's main process reaches the application only through `@manga/app-core/light`; its page only
 * the readers' hooks and controls, the base controls and the theme. None of them may reach the library database, plugins, the Agent or updates.
 */
const LIGHT_FORBIDDEN_PACKAGES = [/^better-sqlite3$/, /^drizzle-orm/, /^@manga\/storage-drizzle/, /^electron-updater$/, /^sharp$/, /^@manga\/kernel/, /^@manga\/plugin-sdk/, /^@manga\/model-protocol/, /^@manga\/app-core$/, /^@napi-rs\/canvas/, /^sqlite-vec/, /^sherpa-onnx/];
const LIGHT_FORBIDDEN_FILES = [
  /product-app\.ts$/,
  /asr-(?:host|service|protocol)\.ts$/,
  /packages\/app-core\/src\/(plugins|update|semantic|acquisition|ops|commands|danmaku|voice|metadata|creative|library-scan)\//,
  /packages\/app-core\/src\/agent/,
  /renderer\/(workspace|voice|agent|chat|creative|notes|library|settings|shelf|shell|workbench)/,
  /renderer\/components\/(chat|screenshot|add-to|work-picker|trace)/,
  /danmaku/,
  /screenshot/,
  /renderer\/hooks\/(?!use-window-state)/,
  /renderer\/lib\/(works|use-work|reader-context|quote-tags|chat|plugin|download|semantic|trace|materials|shell-model)/,
];
export const LIGHT_ENTRIES = [
  { entry: "apps/desktop/src/main/bootstrap.ts", packages: [/^node:/, /^electron$/] },
  { entry: "apps/desktop/src/main/light/main.ts", packages: [/^node:/, /^electron$/, /^@manga\/contracts(\/[\w.-]+)?$/, /^yauzl$/] },
  { entry: "apps/desktop/src/light/main.tsx", packages: [/^react(-dom)?(\/[\w.-]+)?$/, /^lucide-react$/, /^@manga\/i18n$/, /^@manga\/contracts(\/[\w.-]+)?$/, /^clsx$/, /^tailwind-merge$/, /^jassub/, /^pdfjs-dist/, /^@radix-ui\//] },
];
const ANY_IMPORT = /(?:from|import)\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

export function checkLightClosure(base = root, entries = LIGHT_ENTRIES) {
  const errors = [];
  for (const { entry, packages } of entries) {
    const seen = new Set();
    const queue = [path.join(base, entry)];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const relative = path.relative(base, file).replaceAll("\\", "/");
      if (LIGHT_FORBIDDEN_FILES.some((re) => re.test(relative))) errors.push(`${entry}: reaches ${relative}`);
      // An import the walk cannot follow (no such file, or no extension) would hide everything behind it.
      if (!fs.existsSync(file)) { errors.push(`${entry}: cannot follow the import of ${relative} (name the file with its extension)`); continue; }
      if (/\.(css|wasm|json)$/.test(file)) continue;
      // Comments, and type-only imports (erased from the bundle), are not imports.
      const text = fs.readFileSync(file, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "").replace(/^\s*(import|export)\s+type\s[^;]*;/gm, "");
      for (const match of text.matchAll(ANY_IMPORT)) {
        const spec = (match[1] ?? match[2] ?? match[3]).replace(/\?.*$/, "");
        if (spec.startsWith(".")) { queue.push(path.resolve(path.dirname(file), spec)); continue; }
        if (spec === "@manga/app-core/light") { queue.push(path.join(base, "packages/app-core/src/light/index.ts")); continue; }
        if (LIGHT_FORBIDDEN_PACKAGES.some((re) => re.test(spec))) { errors.push(`${entry}: ${relative} imports ${spec}`); continue; }
        // Inside app-core the package's own pure helpers are followed above; any other package the entry does not list is refused.
        if (!packages.some((re) => re.test(spec))) errors.push(`${entry}: ${relative} imports ${spec}, which is not allowed here`);
      }
    }
  }
  return errors;
}

const MAIN_FORBIDDEN_PACKAGES = [/^sherpa-onnx/];
const MAIN_FORBIDDEN_FILES = [/(?:^|\/)asr-host\.ts$/];

function resolveWorkspaceImport(base, fromFile, spec) {
  if (spec.startsWith(".")) {
    const raw = path.resolve(path.dirname(fromFile), spec);
    for (const candidate of [raw, `${raw}.ts`, `${raw}.tsx`, `${raw}.mjs`, path.join(raw, "index.ts")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return raw;
  }
  if (spec === "@manga/app-core/light") {
    return path.join(base, "packages/app-core/src/light/index.ts");
  }
  const pkgMatch = /^@manga\/([\w-]+)(?:\/([\w./-]+))?$/.exec(spec);
  if (pkgMatch) {
    const [, pkgName, subpath] = pkgMatch;
    const raw = subpath
      ? path.join(base, "packages", pkgName, "src", subpath)
      : path.join(base, "packages", pkgName, "src", "index.ts");
    for (const candidate of [raw, `${raw}.ts`, `${raw}.tsx`, path.join(raw, "index.ts")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

/**
 * Local speech native addon isolation (计划 4.5, 5.4): `sherpa-onnx-node` and `asr-host.ts` belong exclusively to the
 * `asr-host.cjs` utilityProcess bundle. Neither `main` (`src/main/index.ts`) nor any workspace package it reaches may import them.
 */
export function checkMainClosure(base = root, entry = "apps/desktop/src/main/index.ts") {
  const errors = [];
  const start = path.join(base, entry);
  if (!fs.existsSync(start)) return errors;
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const relative = path.relative(base, file).replaceAll("\\", "/");
    if (MAIN_FORBIDDEN_FILES.some((re) => re.test(relative))) {
      errors.push(`${entry}: reaches ${relative} (asr-host must run only in its utilityProcess)`);
      continue;
    }
    if (!fs.existsSync(file) || /\.(css|wasm|json)$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "").replace(/^\s*(import|export)\s+type\s[^;]*;/gm, "");
    for (const match of text.matchAll(ANY_IMPORT)) {
      const spec = (match[1] ?? match[2] ?? match[3]).replace(/\?.*$/, "");
      if (MAIN_FORBIDDEN_PACKAGES.some((re) => re.test(spec))) {
        errors.push(`${entry}: ${relative} imports ${spec}`);
        continue;
      }
      const target = resolveWorkspaceImport(base, file, spec);
      if (target) queue.push(target);
    }
  }
  return errors;
}

// Electron 45 deprecates the synchronous safeStorage interface and 46 removes it (计划 4.1): product and test code use only the asynchronous one.
// The one exception is the sample that reproduces what the Electron 44 release wrote.
const SYNC_SAFE_STORAGE = /\b(?:isEncryptionAvailable|encryptString|decryptString)\s*\(/;
const SYNC_SAFE_STORAGE_ALLOWED = new Set(["scripts/samples/legacy-credentials-e44.ts"]);
const SOURCE_DIRS = ["packages", "apps", "plugins", "scripts", "tests"];

export function checkSyncSafeStorage(base = root) {
  const errors = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".vite" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/.test(entry.name)) {
        const relative = path.relative(base, full).replaceAll("\\", "/");
        if (SYNC_SAFE_STORAGE_ALLOWED.has(relative) || relative === "scripts/check-deps.mjs") continue;
        const lines = fs.readFileSync(full, "utf8").split("\n");
        lines.forEach((line, index) => { if (SYNC_SAFE_STORAGE.test(line)) errors.push(`${relative}:${index + 1}: synchronous safeStorage call`); });
      }
    }
  };
  for (const dir of SOURCE_DIRS) visit(path.join(base, dir));
  return errors;
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-dep-"));
  try {
    fs.mkdirSync(path.join(dir, "packages/contracts/src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "packages/app-core/src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "plugins/acquisition-bt/src"), { recursive: true });
    const put = (file, lines) => fs.writeFileSync(path.join(dir, file), lines.join("\n") + "\n");
    put("packages/contracts/src/bad.ts", ['import electron from "electron";']);
    put("packages/contracts/src/up.ts", ['import { x } from "../../../other/outside.ts";']);
    put("packages/contracts/src/ok.ts", ['import { y } from "./bad.ts";']);
    put("packages/app-core/src/index.ts", ['import sherpa from "sherpa-onnx-node";', "export const v = sherpa;"]);
    put("plugins/acquisition-bt/src/reach.mjs", ['import { run } from "@manga/app-core";']);
    put("plugins/acquisition-bt/src/fine.mjs", ['import WebTorrent from "webtorrent";', 'import { connect } from "./link.mjs";']);
    fs.mkdirSync(path.join(dir, "apps/desktop/src"), { recursive: true });
    put("apps/desktop/src/vault.ts", ["const ok = safeStorage.isEncryptionAvailable();"]);
    put("apps/desktop/src/async.ts", ["const ok = await safeStorage.isAsyncEncryptionAvailable(); const c = await safeStorage.encryptStringAsync(x);"]);
    const syncErrors = checkSyncSafeStorage(dir);
    fs.mkdirSync(path.join(dir, "apps/desktop/src/main/light"), { recursive: true });
    put("apps/desktop/src/main/light/main.ts", ['import { app } from "electron";', 'import { x } from "./helper.ts";', 'import { y } from "./hidden";']);
    put("apps/desktop/src/main/light/helper.ts", ['import Database from "better-sqlite3";', 'import sherpa from "sherpa-onnx-node";']);
    const lightErrors = checkLightClosure(dir, [{ entry: "apps/desktop/src/main/light/main.ts", packages: [/^electron$/] }]);
    if (!lightErrors.some((item) => item.includes("better-sqlite3"))) throw new Error("dependency gate self-test did not follow light open's imports to the library database");
    if (!lightErrors.some((item) => item.includes("sherpa-onnx-node"))) throw new Error("dependency gate self-test did not reject sherpa-onnx-node in light open");
    if (!lightErrors.some((item) => item.includes("cannot follow the import") && item.includes("hidden"))) throw new Error("dependency gate self-test let an import it cannot follow through");
    put("apps/desktop/src/main/asr-host.ts", ['const s = require("sherpa-onnx-node");', "export default s;"]);
    put("apps/desktop/src/main/index.ts", ['import { v } from "@manga/app-core";', 'import host from "./asr-host.ts";', "export { v, host };"]);
    const mainErrors = checkMainClosure(dir);
    if (!mainErrors.some((item) => item.includes("sherpa-onnx-node"))) {
      throw new Error("dependency gate self-test did not reject sherpa-onnx-node in main closure");
    }
    if (!mainErrors.some((item) => item.includes("asr-host.ts"))) {
      throw new Error("dependency gate self-test did not reject asr-host.ts in main closure");
    }
    const errors = checkTree(dir);
    if (!syncErrors.some((item) => item.includes("vault.ts")) || syncErrors.some((item) => item.includes("async.ts"))) {
      throw new Error("dependency gate self-test did not tell a synchronous safeStorage call from an asynchronous one");
    }
    if (!errors.some((item) => item.includes("electron"))) {
      throw new Error("dependency gate self-test did not fail on electron import");
    }
    if (!errors.some((item) => item.includes("sherpa-onnx-node"))) {
      throw new Error("dependency gate self-test did not fail on sherpa-onnx-node import in app-core");
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

selfTest();
const errors = [...checkTree(root), ...checkSyncSafeStorage(root), ...checkLightClosure(root), ...checkMainClosure(root)];
if (process.argv.includes("--self-test-only")) {
  console.log(JSON.stringify({ status: "passed", check: "dependency-boundary-self-test" }));
  process.exit(0);
}
for (const error of errors) console.error(`ERROR ${error}`);
console.log(JSON.stringify({ status: errors.length ? "failed" : "passed", check: "dependency-boundary", errors: errors.length }));
process.exitCode = errors.length ? 1 : 0;
