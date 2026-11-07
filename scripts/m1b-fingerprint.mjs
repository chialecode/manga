import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sourceFingerprint } from "../experiments/m0/src/report.ts";

export { sourceFingerprint };

function hashTree(root, entries) {
  const hash = createHash("sha256");
  const skip = new Set(["node_modules", "dist", "out", ".vite", ".cache", "coverage"]);
  const visit = (relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (!skip.has(name)) visit(path.join(relative, name).replaceAll("\\", "/"));
      }
    } else {
      hash.update(relative.replaceAll("\\", "/"));
      hash.update(fs.readFileSync(file));
    }
  };
  for (const entry of entries) visit(entry);
  return hash.digest("hex");
}

export function m1bFingerprints(root) {
  return {
    sourceFingerprint: sourceFingerprint(root),
    m1bSourceFingerprint: hashTree(root, [
      "packages",
      "apps/desktop",
      "tests/m1b",
      "scripts/m1b.mjs",
      "scripts/verify-m1b.mjs",
      "scripts/m1b-report.mjs",
      "scripts/m1b-fingerprint.mjs",
      "scripts/bench-m1b.mjs",
      "scripts/bench-m1b-scale.mjs",
      "scripts/package-m1b.mjs",
      "vitest.m1b.config.ts",
    ]),
    lockFingerprint: hashTree(root, ["pnpm-lock.yaml"]),
    testScriptFingerprint: hashTree(root, ["scripts/m1b.mjs", "scripts/verify-m1b.mjs", "tests/m1b", "vitest.m1b.config.ts", "scripts/m1b-required-cases.json"]),
    buildScriptFingerprint: hashTree(root, ["scripts/package-m1b.mjs", "scripts/desktop-paths.ts", "scripts/ensure-electron-sqlite.mjs", "scripts/dev-desktop.mjs", "apps/desktop/forge.config.ts", "apps/desktop/package.json", "apps/desktop/vite.main.config.ts", "apps/desktop/vite.renderer.config.ts", "apps/desktop/vite.preload.config.ts"]),
  };
}
