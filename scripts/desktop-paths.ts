import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const desktopOutput = path.join(repoRoot, "dist/desktop");
export const desktopPackageDir = path.join(desktopOutput, "packages");
export const latestDesktopPackage = path.join(desktopOutput, "latest-package.json");
export const evidenceRunsRoot = path.join(repoRoot, "dist/evidence-runs");

/** Per-run output directory (ignored by git); only final results are copied to docs/evidence/<stage>/. */
export function evidenceRunDir(stage: string, run: string): string {
  return path.join(evidenceRunsRoot, stage, run);
}

/** Final, committed evidence directory for a stage. */
export function stageEvidenceDir(stage: string): string {
  return path.join(repoRoot, "docs/evidence", stage);
}
