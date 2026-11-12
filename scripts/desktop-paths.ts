import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The maintainer's signing keys, outside the repository: `%APPDATA%\manga-release` (private `*.key`, public `*.pub`). */
export const releaseKeyDir = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "manga-release");
export const pluginSigningKeyFile = path.join(releaseKeyDir, "plugin-signing.key");
export const updateSigningKeyFile = path.join(releaseKeyDir, "update-signing.key");
export const desktopOutput = path.join(repoRoot, "dist/desktop");
// MANGA_DESKTOP_PACKAGE_DIR (relative to the repository, or absolute) builds and walks a package somewhere else, for when the usual folder is locked by a copy of the application someone has open.
export const desktopPackageDir = process.env.MANGA_DESKTOP_PACKAGE_DIR ? path.resolve(repoRoot, process.env.MANGA_DESKTOP_PACKAGE_DIR) : path.join(desktopOutput, "packages");
export const latestDesktopPackage = path.join(desktopOutput, "latest-package.json");
export const evidenceRunsRoot = path.join(repoRoot, "dist/evidence-runs");

/** Per-run output directory (ignored by git); only the final gate results are copied to docs/evidence/gate/. */
export function evidenceRunDir(run: string): string {
  return path.join(evidenceRunsRoot, run);
}

/** Final, committed evidence directory of the latest stage gate. */
export const gateEvidenceDir = path.join(repoRoot, "docs/evidence/gate");
