import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { repoRoot, evidenceRunDir } from "../desktop-paths.ts";

export { repoRoot };

const SKIP = new Set(["node_modules", "dist", "out", ".vite", ".cache", "coverage"]);

/** The stage being developed, from the document registry. */
export function currentStage() {
  const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs/governance/document-registry.json"), "utf8"));
  if (typeof registry.currentStage !== "string" || !registry.currentStage) throw new Error("document-registry.json declares no currentStage");
  return registry.currentStage;
}

/** The stage gate: required cases, scenarios, bench targets and fingerprinted inputs. One file, rewritten for each stage. */
export function loadGate() {
  const file = path.join(repoRoot, "scripts/stage/gate.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** One run directory shared by test, bench, package and report. STAGE_RUN selects another one. */
export function runDir() {
  const dir = evidenceRunDir(process.env.STAGE_RUN ?? "current");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Bytes as the repository stores them. `.gitattributes` keeps text with LF line ends, but tools on Windows may leave CRLF
 * in the working tree; without this a clean checkout of the same commit would get a different fingerprint. A file with a
 * NUL byte near its start is binary (Git's own test) and is hashed unchanged.
 */
export function storedBytes(bytes) {
  if (bytes.subarray(0, 8000).includes(0) || !bytes.includes(13)) return bytes;
  return Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
}

export function hashTree(root, entries) {
  const hash = createHash("sha256");
  const visit = (relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) if (!SKIP.has(name)) visit(path.join(relative, name).replaceAll("\\", "/"));
    } else {
      hash.update(relative.replaceAll("\\", "/"));
      hash.update(storedBytes(fs.readFileSync(file)));
    }
  };
  for (const entry of entries) visit(entry);
  return hash.digest("hex");
}

/** The key a result file stores a group's fingerprint under: `sourceFingerprint`, `lockFingerprint`, `<group>ScriptFingerprint` for the rest. */
export const fingerprintKey = (group) => (group === "source" || group === "lock" ? `${group}Fingerprint` : `${group}ScriptFingerprint`);

/**
 * Fingerprints of the inputs a result can belong to, one per group of gate.json `fingerprint` (product source, lock file, build code, the gate's
 * shared code, and the code of each entry: test, package, bench, installer). Every result file stores all of them; the report compares only the
 * groups gate.json `fingerprintOf` names for that file, so a change to the bench code makes the bench stale and leaves the test and package
 * results current, while a change to the product source makes every result stale. A file under scripts/stage or scripts/samples that no group
 * names would change nothing, so it is refused.
 */
export function stageFingerprints(root, config) {
  const groups = config.fingerprint;
  const named = Object.values(groups).flat();
  for (const dir of ["scripts/stage", "scripts/samples"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const file = `${dir}/${name}`;
      if (!named.some((entry) => file === entry || file.startsWith(`${entry}/`))) throw new Error(`gate.json: no fingerprint group names ${file}`);
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([group, entries]) => [fingerprintKey(group), hashTree(root, entries)]));
}

/** The fingerprint keys a result file must match: the groups gate.json `fingerprintOf` names for it, else every group. */
export function fingerprintKeysOf(config, file) {
  return (config.fingerprintOf?.[file] ?? Object.keys(config.fingerprint)).map(fingerprintKey);
}

export function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

export function p99(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
}

export function readJson(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  } catch {
    return null;
  }
}

export function packagedExecutable() {
  const outDir = process.env.MANGA_DESKTOP_PACKAGE_DIR ? path.resolve(repoRoot, process.env.MANGA_DESKTOP_PACKAGE_DIR) : path.join(repoRoot, "dist/desktop/packages");
  if (!fs.existsSync(outDir)) return undefined;
  const built = fs.readdirSync(outDir).find((name) => name.startsWith("MANGA"));
  if (!built) return undefined;
  const exe = path.join(outDir, built, process.platform === "win32" ? "MANGA.exe" : "MANGA");
  return fs.existsSync(exe) ? exe : undefined;
}
