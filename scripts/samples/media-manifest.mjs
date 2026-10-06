// Sample manifest: where the M2 synthetic samples live, how their fingerprints are computed and how a test
// decides they are present and unchanged. Samples are generated, not committed.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");
export const samplesRoot = process.env.MANGA_SAMPLES_DIR ? path.resolve(process.env.MANGA_SAMPLES_DIR) : path.join(repoRoot, "dist/samples/m2");
export const manifestFile = path.join(samplesRoot, "manifest.json");

/** Files whose content decides what the generator produces; a change makes existing samples stale. */
export const generatorFiles = ["generate-media-samples.mjs", "media-draw.mjs", "media-writers.mjs", "pdf-embedded-font.ts"].map((name) => path.join(here, name));

export function generatorFingerprint() {
  const hash = createHash("sha256");
  for (const file of generatorFiles) {
    hash.update(path.basename(file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

function hashFile(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Fingerprint of a file or a directory tree: sorted relative names plus content hashes. Returns bytes and file count too. */
export function fingerprintPath(target) {
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  const visit = (file, relative) => {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else {
      files += 1;
      bytes += stat.size;
      hash.update(`${relative}\0${hashFile(file)}\0`);
    }
  };
  visit(target, "");
  return { sha256: hash.digest("hex"), bytes, files };
}

export function loadManifest(root = samplesRoot) {
  const file = path.join(root, "manifest.json");
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Check the generated samples against the manifest. Returns { ok, errors, manifest }.
 * A missing manifest, a missing or changed sample and a sample from an older generator all fail.
 */
export function verifyMediaSamples({ ids, root = samplesRoot } = {}) {
  const errors = [];
  const manifest = loadManifest(root);
  if (!manifest) return { ok: false, errors: [`samples missing: ${path.relative(repoRoot, path.join(root, "manifest.json"))} does not exist; run node scripts/samples/generate-media-samples.mjs`], manifest: undefined };
  if (manifest.generator?.fingerprint !== generatorFingerprint()) errors.push("samples were produced by a different version of the generator; regenerate them");
  for (const sample of manifest.samples) {
    if (ids && !ids.includes(sample.id)) continue;
    if (sample.status !== "generated") continue;
    const target = path.join(root, sample.path);
    if (!fs.existsSync(target)) {
      errors.push(`sample ${sample.id} is missing (${sample.path})`);
      continue;
    }
    const actual = fingerprintPath(target);
    if (actual.sha256 !== sample.sha256) errors.push(`sample ${sample.id} does not match its fingerprint`);
  }
  return { ok: errors.length === 0, errors, manifest };
}

export function samplePath(manifest, id, ...rest) {
  const sample = manifest.samples.find((entry) => entry.id === id);
  if (!sample) throw new Error(`unknown sample ${id}`);
  if (sample.status !== "generated") throw new Error(`sample ${id} was not generated: ${sample.reason}`);
  return path.join(samplesRoot, sample.path, ...rest);
}
