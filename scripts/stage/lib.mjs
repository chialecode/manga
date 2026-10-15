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

/**
 * Fingerprints of what a result file belongs to: product source, lock file, test code and build code.
 * Any change to those inputs makes earlier test, bench and package results stale.
 */
export function stageFingerprints(root, config) {
  const f = config.fingerprint;
  return {
    sourceFingerprint: hashTree(root, f.source),
    lockFingerprint: hashTree(root, f.lock),
    testScriptFingerprint: hashTree(root, f.test),
    buildScriptFingerprint: hashTree(root, f.build),
  };
}

export const fingerprintKeys = ["sourceFingerprint", "lockFingerprint", "testScriptFingerprint", "buildScriptFingerprint"];

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
  const outDir = path.join(repoRoot, "dist/desktop/packages");
  if (!fs.existsSync(outDir)) return undefined;
  const built = fs.readdirSync(outDir).find((name) => name.startsWith("MANGA"));
  if (!built) return undefined;
  const exe = path.join(outDir, built, process.platform === "win32" ? "MANGA.exe" : "MANGA");
  return fs.existsSync(exe) ? exe : undefined;
}
