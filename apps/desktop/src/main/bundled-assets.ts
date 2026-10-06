import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * What a packaged build carries besides its own code: the media tool, the voice-filter model and runtime, the PDF.js
 * assets, the subtitle renderer's WebAssembly, the worker bundles, and the licence texts that go with them. The build
 * writes a manifest of these files with their sizes and hashes; the app checks it when it starts, so a package that is
 * missing a piece stops there with a plain message instead of failing half-way through a recording or a video.
 */

export const MANIFEST_NAME = "assets.manifest.json";

export type BundledAsset = {
  /** What the file is for; the ids in `REQUIRED_ASSETS` must all be present. */
  id: string;
  /** Relative to the resources directory, with forward slashes. */
  path: string;
  bytes: number;
  sha256: string;
};

export type AssetManifest = {
  version: 1;
  /** Third-party material, so licences and where to get the source travel with the package. */
  notices: Array<{ name: string; version: string; license: string; source: string; files: string[] }>;
  assets: BundledAsset[];
};

/** Each of these must be in the manifest and on disk. */
export const REQUIRED_ASSETS = [
  "ffmpeg", "ffprobe", "ffmpeg-license",
  "vad-model", "vad-worker", "ort-runtime", "ort-common", "ort-wasm", "ort-wasm-loader",
  "parse-worker", "pdfjs-main", "pdfjs-worker",
  "jassub-wasm", "jassub-wasm-modern", "jassub-worker",
] as const;

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let read = fs.readSync(fd, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export type AssetCheck = { ok: boolean; problems: string[] };

/**
 * Check a resources directory against its manifest. The quick check (every start) compares presence and size; `deep`
 * also compares hashes, for the packaging step and the offline package test.
 */
export function verifyBundledAssets(resourcesDir: string, options: { deep?: boolean; required?: readonly string[] } = {}): AssetCheck {
  const problems: string[] = [];
  const file = path.join(resourcesDir, MANIFEST_NAME);
  let manifest: AssetManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8")) as AssetManifest;
  } catch {
    return { ok: false, problems: [`${MANIFEST_NAME} is missing or unreadable`] };
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.assets)) return { ok: false, problems: [`${MANIFEST_NAME} has an unknown format`] };
  const ids = new Set(manifest.assets.map((asset) => asset.id));
  for (const id of options.required ?? REQUIRED_ASSETS) if (!ids.has(id)) problems.push(`the package does not list ${id}`);
  const inElectron = Boolean(process.versions.electron);
  for (const asset of manifest.assets) {
    // Files inside the app archive can only be read from inside Electron; the app checks them at its own start.
    if (asset.path.startsWith("app.asar/") && !inElectron) continue;
    const target = path.join(resourcesDir, asset.path);
    let size: number;
    try {
      size = fs.statSync(target).size;
    } catch {
      problems.push(`${asset.path} is missing`);
      continue;
    }
    if (size !== asset.bytes) problems.push(`${asset.path} has the wrong size`);
    else if (options.deep && sha256File(target) !== asset.sha256) problems.push(`${asset.path} does not match its hash`);
  }
  return { ok: problems.length === 0, problems };
}
