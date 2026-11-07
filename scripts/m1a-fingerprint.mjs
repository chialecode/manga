import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sourceFingerprint } from "../experiments/m0/src/report.ts";

export { sourceFingerprint };

export function m1aSourceFingerprint(root) {
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
  for (const entry of [
    "packages",
    "apps/desktop",
    "tests/m1a",
    "experiments",
    "scripts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "vitest.config.ts",
  ]) visit(entry);
  return hash.digest("hex");
}
