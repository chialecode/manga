import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const desktopOutput = path.join(repoRoot, "dist/desktop");
export const desktopPackageDir = path.join(desktopOutput, "packages");
export const electronSqlite = path.join(desktopOutput, "native/electron-37.4.0-x64/better_sqlite3.node");
export const latestDesktopPackage = path.join(desktopOutput, "latest-package.json");
