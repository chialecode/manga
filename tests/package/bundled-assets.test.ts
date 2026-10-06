import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MANIFEST_NAME, REQUIRED_ASSETS, verifyBundledAssets, type AssetManifest } from "../../apps/desktop/src/main/bundled-assets.ts";
import { stageBundledAssets } from "../../scripts/desktop-assets.ts";
import { VadWorkerClient, locateVadAssets } from "../../packages/app-core/src/voice/vad-client.ts";
import { locateFfmpeg } from "../../packages/app-core/src/media/ffmpeg.ts";
import { join, quiet, tone } from "../helpers/voice.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manga-assets-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (file: string, content: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

/**
 * A repository root with the real lock files and the real voice model and runtime (they are small and the worker test
 * needs them), but tiny stand-ins for FFmpeg and PDF.js, so staging does not copy 180 MB each time.
 */
function fakeRoot(): string {
  const root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, "scripts", "tools"), { recursive: true });
  for (const name of ["ffmpeg.lock.json", "silero-vad.lock.json"]) fs.copyFileSync(path.join(repo, "scripts", "tools", name), path.join(root, "scripts", "tools", name));
  const ffmpegLock = JSON.parse(fs.readFileSync(path.join(repo, "scripts", "tools", "ffmpeg.lock.json"), "utf8")) as { version: string };
  const home = path.join(root, "dist", "tools", "ffmpeg", ffmpegLock.version);
  for (const name of ["ffmpeg.exe", "ffprobe.exe", "ffplay.exe", "avcodec-62.dll", "avutil-60.dll"]) write(path.join(home, "bin", name), `stand-in ${name}`);
  write(path.join(home, "LICENSE.txt"), "GNU LESSER GENERAL PUBLIC LICENSE\n");
  const silero = path.join(repo, "dist", "tools", "silero-vad");
  for (const name of ["silero_vad.onnx", "LICENSE"]) {
    if (!fs.existsSync(path.join(silero, name))) throw new Error("the Silero model is not in the tool cache; run: node scripts/tools/fetch-silero-vad.mjs");
    write(path.join(root, "dist", "tools", "silero-vad", name), fs.readFileSync(path.join(silero, name)));
  }
  const ortFrom = path.join(repo, "node_modules", "onnxruntime-web");
  for (const name of ["ort.node.min.js", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) write(path.join(root, "node_modules", "onnxruntime-web", "dist", name), fs.readFileSync(path.join(ortFrom, "dist", name)));
  write(path.join(root, "node_modules", "onnxruntime-web", "package.json"), fs.readFileSync(path.join(ortFrom, "package.json")));
  const commonFrom = path.join(repo, "node_modules", "onnxruntime-common");
  fs.cpSync(commonFrom, path.join(root, "node_modules", "onnxruntime-common"), { recursive: true, filter: (from) => !/\.(d\.ts|map)$/.test(from) });
  const pdfjs = path.join(root, "node_modules", "pdfjs-dist");
  write(path.join(pdfjs, "package.json"), JSON.stringify({ name: "pdfjs-dist", version: "0.0.0-test" }));
  write(path.join(pdfjs, "LICENSE"), "Apache License\n");
  write(path.join(pdfjs, "legacy", "build", "pdf.mjs"), "export {};\n");
  write(path.join(pdfjs, "legacy", "build", "pdf.worker.mjs"), "export {};\n");
  write(path.join(pdfjs, "cmaps", "a.bcmap"), "cmap");
  return root;
}

let root: string;
let renderer: string;
let build: string;
let resources: string;
let manifest: AssetManifest;

beforeAll(async () => {
  if (mediaPrerequisitesAbsent) return;
  // The package may be unpacked under a folder whose own package.json says "module" (this is how a build inside the repository looks).
  write(path.join(tmp, "package.json"), JSON.stringify({ private: true, type: "module" }));
  root = fakeRoot();
  renderer = path.join(tmp, "renderer");
  write(path.join(renderer, "assets", "jassub-worker-AAA.wasm"), "wasm-legacy");
  write(path.join(renderer, "assets", "jassub-worker-modern-BBB.wasm"), "wasm-modern");
  write(path.join(renderer, "assets", "worker-CCC.js"), "x".repeat(60_000));
  write(path.join(renderer, "assets", "worker-DDD.js"), "tiny");
  build = path.join(tmp, "build");
  write(path.join(build, "parse-worker.cjs"), "module.exports = {};\n");
  // The real worker bundle, built the way the main bundle builds it.
  await esbuild.build({ absWorkingDir: repo, entryPoints: ["packages/app-core/src/voice/vad-worker.ts"], outfile: path.join(build, "vad-worker.cjs"), bundle: true, platform: "node", format: "cjs" });
  resources = path.join(tmp, "resources");
  manifest = stageBundledAssets(resources, { repoRoot: root, rendererDir: renderer, buildDir: build });
}, 60_000);

describe.skipIf(mediaPrerequisitesAbsent)("what a package carries", () => {
  it("stages every required asset, with sizes and hashes, and checks out", () => {
    const ids = new Set(manifest.assets.map((asset) => asset.id));
    for (const id of REQUIRED_ASSETS) expect(ids.has(id), id).toBe(true);
    for (const asset of manifest.assets) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.path).not.toContain("\\");
    }
    expect(verifyBundledAssets(resources, { deep: true })).toEqual({ ok: true, problems: [] });
  });

  it("leaves the player out of the FFmpeg copy and ships its licence and where to get the source", () => {
    const ffmpeg = path.join(resources, "ffmpeg");
    expect(fs.readdirSync(path.join(ffmpeg, "bin")).sort()).toEqual(["avcodec-62.dll", "avutil-60.dll", "ffmpeg.exe", "ffprobe.exe"]);
    expect(fs.readFileSync(path.join(ffmpeg, "LICENSE.txt"), "utf8")).toContain("LESSER GENERAL PUBLIC LICENSE");
    const source = fs.readFileSync(path.join(ffmpeg, "SOURCE.txt"), "utf8");
    expect(source).toContain("GNU Lesser General Public License");
    expect(source).toContain("https://github.com/BtbN/FFmpeg-Builds");
    expect(source).toMatch(/sha256: [0-9a-f]{64}/);
    expect(source).toContain("replaced");
  });

  it("lists third-party notices whose files are in the package", () => {
    expect(manifest.notices.map((notice) => notice.name)).toEqual(["FFmpeg", "Silero VAD", "ONNX Runtime Web", "PDF.js"]);
    for (const notice of manifest.notices) {
      expect(notice.license.length, notice.name).toBeGreaterThan(0);
      expect(notice.source, notice.name).toMatch(/^https:\/\//);
      for (const file of notice.files) expect(fs.existsSync(path.join(resources, file)), file).toBe(true);
    }
  });

  it("describes the subtitle renderer's files from the app window build", () => {
    const byId = Object.fromEntries(manifest.assets.map((asset) => [asset.id, asset]));
    expect(byId["jassub-wasm"]!.path).toBe("app.asar/.vite/renderer/main_window/assets/jassub-worker-AAA.wasm");
    expect(byId["jassub-wasm-modern"]!.path).toContain("jassub-worker-modern-BBB.wasm");
    // The big worker file, not the tiny one with the same prefix.
    expect(byId["jassub-worker"]!.path).toContain("worker-CCC.js");
  });

  it("finds the tools where the app looks for them in a packaged build", () => {
    const tools = locateFfmpeg({ env: {}, resourcesPath: resources, cwd: tmp });
    expect(tools?.ffmpeg).toBe(path.join(resources, "ffmpeg", "bin", "ffmpeg.exe"));
    const vad = locateVadAssets({ env: {}, resourcesPath: resources, cwd: tmp });
    expect(vad?.modelPath).toBe(path.join(resources, "vad", "silero_vad.onnx"));
    expect(vad?.ortEntry).toBe(path.join(resources, "vad", "ort", "ort.node.min.js"));
  });

  it("runs the voice filter from the staged layout with the bundled worker file", async () => {
    const client = new VadWorkerClient({ resourcesPath: resources, workerPath: path.join(resources, "vad-worker.cjs"), assets: locateVadAssets({ env: {}, resourcesPath: resources, cwd: tmp }) });
    try {
      expect(client.available, client.unavailableReason).toBe(true);
      const pcm = join(quiet(1000), tone(1500), quiet(1000));
      const file = path.join(tmp, "probe.pcm");
      fs.writeFileSync(file, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      const probabilities = await client.analyzeFile(file);
      expect(probabilities.length).toBe(Math.floor(pcm.length / 512));
      expect(Math.max(...probabilities)).toBeGreaterThanOrEqual(0);
    } finally {
      client.dispose();
    }
  }, 60_000);
});

describe.skipIf(mediaPrerequisitesAbsent)("a package that is missing something stops at start", () => {
  const copyResources = (name: string) => {
    const target = path.join(tmp, name);
    fs.cpSync(resources, target, { recursive: true });
    return target;
  };

  it("says the manifest is missing", () => {
    const dir = copyResources("no-manifest");
    fs.rmSync(path.join(dir, MANIFEST_NAME));
    const check = verifyBundledAssets(dir);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toContain(MANIFEST_NAME);
  });

  it("names each missing file", () => {
    const dir = copyResources("missing-files");
    fs.rmSync(path.join(dir, "ffmpeg", "bin", "ffmpeg.exe"));
    fs.rmSync(path.join(dir, "vad", "silero_vad.onnx"));
    const check = verifyBundledAssets(dir);
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual(expect.arrayContaining(["ffmpeg/bin/ffmpeg.exe is missing", "vad/silero_vad.onnx is missing"]));
  });

  it("catches a truncated file by its size, and a changed one by its hash when asked to look closely", () => {
    const dir = copyResources("changed");
    fs.appendFileSync(path.join(dir, "vad-worker.cjs"), "\n// tampered");
    expect(verifyBundledAssets(dir).problems).toEqual(["vad-worker.cjs has the wrong size"]);
    const same = copyResources("same-size");
    const file = path.join(same, "parse-worker.cjs");
    const bytes = fs.readFileSync(file);
    bytes[0] = bytes[0] === 0x6d ? 0x4d : 0x6d;
    fs.writeFileSync(file, bytes);
    expect(verifyBundledAssets(same).ok).toBe(true);
    expect(verifyBundledAssets(same, { deep: true }).problems).toEqual(["parse-worker.cjs does not match its hash"]);
  });

  it("notices a required asset that the manifest no longer lists", () => {
    const dir = copyResources("unlisted");
    const file = path.join(dir, MANIFEST_NAME);
    const edited = JSON.parse(fs.readFileSync(file, "utf8")) as AssetManifest;
    edited.assets = edited.assets.filter((asset) => asset.id !== "vad-model");
    fs.writeFileSync(file, JSON.stringify(edited));
    expect(verifyBundledAssets(dir).problems).toEqual(["the package does not list vad-model"]);
  });

  it("refuses a manifest of an unknown format", () => {
    const dir = copyResources("unknown-format");
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({ version: 2, assets: [] }));
    expect(verifyBundledAssets(dir).ok).toBe(false);
  });
});

describe.skipIf(mediaPrerequisitesAbsent)("packaging stops when a tool is not in the cache", () => {
  it("names the command that fetches FFmpeg, and the one that fetches the voice model", () => {
    const empty = path.join(tmp, "empty-root");
    fs.mkdirSync(path.join(empty, "scripts", "tools"), { recursive: true });
    for (const name of ["ffmpeg.lock.json", "silero-vad.lock.json"]) fs.copyFileSync(path.join(repo, "scripts", "tools", name), path.join(empty, "scripts", "tools", name));
    expect(() => stageBundledAssets(path.join(tmp, "out1"), { repoRoot: empty, rendererDir: renderer, buildDir: build })).toThrow(/fetch-ffmpeg\.mjs/);
    // FFmpeg present, model absent.
    const ffmpegLock = JSON.parse(fs.readFileSync(path.join(repo, "scripts", "tools", "ffmpeg.lock.json"), "utf8")) as { version: string };
    write(path.join(empty, "dist", "tools", "ffmpeg", ffmpegLock.version, "bin", "ffmpeg.exe"), "x");
    write(path.join(empty, "dist", "tools", "ffmpeg", ffmpegLock.version, "LICENSE.txt"), "x");
    expect(() => stageBundledAssets(path.join(tmp, "out2"), { repoRoot: empty, rendererDir: renderer, buildDir: build })).toThrow(/fetch-silero-vad\.mjs/);
  });

  it("stops when a worker bundle or the app window build is missing", () => {
    const noWorker = path.join(tmp, "no-worker");
    fs.mkdirSync(noWorker);
    expect(() => stageBundledAssets(path.join(tmp, "out3"), { repoRoot: root, rendererDir: renderer, buildDir: noWorker })).toThrow(/parse-worker\.cjs is missing/);
    expect(() => stageBundledAssets(path.join(tmp, "out4"), { repoRoot: root, rendererDir: path.join(tmp, "nowhere"), buildDir: build })).toThrow(/app window is not built/);
  });
});
