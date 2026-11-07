import fs from "node:fs";
import path from "node:path";
import { loadManifest, samplesRoot, verifyMediaSamples } from "../../scripts/samples/media-manifest.mjs";
import { libraryRoot } from "./app.ts";
import { mediaPrerequisitesAbsent } from "./prerequisites.ts";

export type SampleEntry = {
  id: string;
  kind: string;
  path: string;
  status: "generated" | "unavailable";
  features: string[];
  sha256?: string;
  bytes?: number;
  files?: number;
  reason?: string;
  truth: Record<string, any>;
};

/**
 * Samples must exist and match their manifest fingerprints; otherwise the calling test file fails.
 * Pass the sample IDs a test needs so a change to an unrelated sample does not fail it. Where the media prerequisites
 * are declared absent (CI), the tests that call this are skipped and it checks nothing.
 */
export function requireSamples(ids?: string[]): { samples: SampleEntry[] } {
  if (mediaPrerequisitesAbsent) return { samples: [] };
  const result = verifyMediaSamples({ ids });
  if (!result.ok) throw new Error(`synthetic samples are not ready: ${result.errors.join("; ")}. Run node scripts/samples/generate-media-samples.mjs`);
  const manifest = loadManifest() as { samples: SampleEntry[] };
  for (const id of ids ?? []) {
    if (!manifest.samples.some((sample) => sample.id === id)) throw new Error(`unknown sample ${id}`);
  }
  return manifest;
}

export function sample(id: string): SampleEntry {
  const manifest = loadManifest() as { samples: SampleEntry[] } | undefined;
  const entry = manifest?.samples.find((item) => item.id === id);
  if (!entry) throw new Error(`unknown sample ${id}`);
  return entry;
}

/** Absolute path of a generated sample (or of a file inside it). Throws for a sample the generator could not produce. */
export function samplePath(id: string, ...rest: string[]): string {
  const entry = sample(id);
  if (entry.status !== "generated") throw new Error(`sample ${id} was not generated: ${entry.reason}`);
  return path.join(samplesRoot, entry.path, ...rest);
}

export function sampleBytes(id: string, ...rest: string[]): Buffer {
  return fs.readFileSync(samplePath(id, ...rest));
}

export function isAvailable(id: string): boolean {
  if (mediaPrerequisitesAbsent) return false;
  return sample(id).status === "generated";
}

export { samplesRoot };

/**
 * Puts a file or folder under a library path of `app` and returns it unchanged, the way a user adds the folder before importing from it (A-80).
 * The generated samples share one library path; any other folder is registered as it is.
 */
export function inLibrary(app: Parameters<typeof libraryRoot>[0], target: string, mediaKind: "novel" | "comic" | "video" = "novel"): string {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return target;
  const sampled = abs.toLowerCase().startsWith(path.resolve(samplesRoot).toLowerCase() + path.sep);
  libraryRoot(app, sampled ? samplesRoot : fs.statSync(abs).isDirectory() ? abs : path.dirname(abs), mediaKind);
  return target;
}
