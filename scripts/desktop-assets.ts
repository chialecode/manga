import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MANIFEST_NAME, REQUIRED_ASSETS, sha256File, type AssetManifest, type BundledAsset } from "../apps/desktop/src/main/bundled-assets.ts";
import { repoRoot } from "./desktop-paths.ts";

/**
 * Puts everything a package carries besides its own code into its resources directory and writes the manifest the app
 * checks at start. The pinned tools come from the local tool cache that `scripts/tools/fetch-*.mjs` fills and verifies
 * against the lock files; if a tool is not there the packaging stops and says which command fetches it.
 */

type Sources = {
  repoRoot?: string;
  /** The Vite build of the app window, which holds the subtitle renderer's WebAssembly. */
  rendererDir: string;
  /** The built worker bundles. */
  buildDir: string;
};

/** Where the package keeps PDF.js, relative to the resources directory. */
const PDFJS_DIR = "app.asar.unpacked/pdfjs";

const fail = (message: string): never => { throw new Error(`packaging: ${message}`); };

function lock<T>(name: string, root: string): T {
  return JSON.parse(readFileSync(path.join(root, "scripts", "tools", name), "utf8")) as T;
}

function ffmpegHome(root: string, version: string): string {
  const home = path.join(root, "dist", "tools", "ffmpeg", version);
  if (!existsSync(path.join(home, "bin", "ffmpeg.exe"))) fail(`FFmpeg ${version} is not in the tool cache; run: node scripts/tools/fetch-ffmpeg.mjs`);
  return home;
}

/** Copy the listed files (relative to `from`) into `to`, keeping their layout. */
function copyFiles(from: string, to: string, files: readonly string[]): void {
  for (const file of files) {
    const target = path.join(to, file);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(from, file), target);
  }
}

const MIT_TEXT = [
  "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"),",
  "to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,",
  "and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
  "",
  "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS",
  "IN THE SOFTWARE.",
].join("\n");

const mitNotice = (name: string, holder: string, source: string): string =>
  ["MIT License", "", `${name}: Copyright (c) ${holder}`, `Full text of the licence as published: ${source}`, "", MIT_TEXT, ""].join("\n");

const record = (resources: string, id: string, relative: string): BundledAsset => {
  const file = path.join(resources, relative);
  if (!existsSync(file)) fail(`${relative} was not staged`);
  return { id, path: relative.replaceAll("\\", "/"), bytes: statSync(file).size, sha256: sha256File(file) };
};

/** The jassub files of the renderer build: two WebAssembly builds and the worker that loads them. */
function rendererAssets(rendererDir: string): Array<{ id: string; name: string }> {
  const dir = path.join(rendererDir, "assets");
  if (!existsSync(dir)) fail(`the app window is not built (${dir} is missing)`);
  const names = readdirSync(dir);
  const pick = (id: string, pattern: RegExp, minBytes = 0) => {
    const found = names.filter((name) => pattern.test(name) && statSync(path.join(dir, name)).size >= minBytes);
    if (found.length !== 1) fail(`expected one ${id} in the app window build, found ${found.length}`);
    return { id, name: found[0]! };
  };
  return [
    pick("jassub-wasm", /^jassub-worker-(?!modern)[\w-]+\.wasm$/),
    pick("jassub-wasm-modern", /^jassub-worker-modern-[\w-]+\.wasm$/),
    pick("jassub-worker", /^worker-[\w-]+\.js$/, 50_000),
  ];
}

/** Stage the assets into `resourcesDir` and write the manifest. Returns the manifest. */
export function stageBundledAssets(resourcesDir: string, sources: Sources): AssetManifest {
  const root = sources.repoRoot ?? repoRoot;
  const ffmpegLock = lock<{ version: string; source: { repository: string; tag: string; url: string; zipSha256: string }; license: string }>("ffmpeg.lock.json", root);
  const sileroLock = lock<{ version: string; commit: string; license: string }>("silero-vad.lock.json", root);
  const assets: BundledAsset[] = [];
  mkdirSync(resourcesDir, { recursive: true });

  // FFmpeg: the LGPL build without ffplay, its licence text, and where the source and the build recipe are.
  const home = ffmpegHome(root, ffmpegLock.version);
  const ffmpegFiles = readdirSync(path.join(home, "bin")).filter((name) => /\.(exe|dll)$/i.test(name) && !/^ffplay/i.test(name)).map((name) => `bin/${name}`);
  copyFiles(home, path.join(resourcesDir, "ffmpeg"), [...ffmpegFiles, "LICENSE.txt"]);
  writeFileSync(path.join(resourcesDir, "ffmpeg", "SOURCE.txt"), [
    `FFmpeg ${ffmpegLock.version} — ${ffmpegLock.license}`,
    "",
    "This build is distributed under the GNU Lesser General Public License; its text is in LICENSE.txt next to this file.",
    "The binaries are the unmodified build named below. They are separate programs that MANGA starts as child processes and",
    "the libraries are dynamic (DLL), so they can be replaced with another build of the same major version.",
    "",
    `Build:   ${ffmpegLock.source.url}`,
    `Recipe:  ${ffmpegLock.source.repository} (tag ${ffmpegLock.source.tag})`,
    `Archive sha256: ${ffmpegLock.source.zipSha256}`,
    "Source:  https://git.ffmpeg.org/ffmpeg.git (the commit in the version string above, e.g. 330caae0c1 for n8.1.3-14-g330caae0c1)",
    "",
  ].join("\n"));
  for (const name of ffmpegFiles) assets.push(record(resourcesDir, name.endsWith("ffmpeg.exe") ? "ffmpeg" : name.endsWith("ffprobe.exe") ? "ffprobe" : `ffmpeg-lib:${name}`, `ffmpeg/${name}`));
  assets.push(record(resourcesDir, "ffmpeg-license", "ffmpeg/LICENSE.txt"));
  assets.push(record(resourcesDir, "ffmpeg-source", "ffmpeg/SOURCE.txt"));

  // Voice filter: the Silero model, the WebAssembly runtime that runs it, and the worker that drives both.
  const silero = path.join(root, "dist", "tools", "silero-vad");
  if (!existsSync(path.join(silero, "silero_vad.onnx"))) fail("the Silero model is not in the tool cache; run: node scripts/tools/fetch-silero-vad.mjs");
  copyFiles(silero, path.join(resourcesDir, "vad"), ["silero_vad.onnx", "LICENSE"]);
  const ort = path.join(root, "node_modules", "onnxruntime-web");
  const ortVersion = (JSON.parse(readFileSync(path.join(ort, "package.json"), "utf8")) as { version: string }).version;
  const ortFiles = ["ort.node.min.js", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];
  copyFiles(path.join(ort, "dist"), path.join(resourcesDir, "vad", "ort"), ortFiles);
  // The runtime's entry file requires its common package by name, so it is staged where that lookup finds it (vad/node_modules).
  const common = path.join(root, "node_modules", "onnxruntime-common");
  const commonJs = readdirSync(path.join(common, "dist", "cjs")).filter((name) => /\.(js|json)$/.test(name)).map((name) => `dist/cjs/${name}`);
  if (!commonJs.includes("dist/cjs/index.js")) fail("onnxruntime-common's CommonJS build is missing; run pnpm install");
  copyFiles(common, path.join(resourcesDir, "vad", "node_modules", "onnxruntime-common"), ["package.json", ...commonJs]);
  // The runtime's entry file is CommonJS; without its own package.json it would take its type from whatever folder the app is installed in.
  writeFileSync(path.join(resourcesDir, "vad", "ort", "package.json"), `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}
`);
  // The npm package carries no licence file, so the notice is written here from the package's declared licence.
  writeFileSync(path.join(resourcesDir, "vad", "ort", "LICENSE"), mitNotice("ONNX Runtime Web", "Microsoft Corporation", "https://github.com/microsoft/onnxruntime/blob/main/LICENSE"));
  assets.push(record(resourcesDir, "vad-model", "vad/silero_vad.onnx"));
  assets.push(record(resourcesDir, "vad-license", "vad/LICENSE"));
  assets.push(record(resourcesDir, "ort-runtime", "vad/ort/ort.node.min.js"));
  assets.push(record(resourcesDir, "ort-common", "vad/node_modules/onnxruntime-common/dist/cjs/index.js"));
  assets.push(record(resourcesDir, "ort-wasm", "vad/ort/ort-wasm-simd-threaded.wasm"));
  assets.push(record(resourcesDir, "ort-wasm-loader", "vad/ort/ort-wasm-simd-threaded.mjs"));
  assets.push(record(resourcesDir, "ort-license", "vad/ort/LICENSE"));

  // Worker bundles.
  for (const [id, name] of [["parse-worker", "parse-worker.cjs"], ["vad-worker", "vad-worker.cjs"]] as const) {
    const built = path.join(sources.buildDir, name);
    if (!existsSync(built)) fail(`${name} is missing from the build (${sources.buildDir})`);
    cpSync(built, path.join(resourcesDir, name));
    assets.push(record(resourcesDir, id, name));
  }

  // PDF.js: its CMaps, standard fonts and WebAssembly decoders, and the offline build the main process and the parse worker load.
  // It sits beside the unpacked native modules because it looks for `@napi-rs/canvas` (to paint pages) by walking up from its own file.
  const pdfjs = path.join(root, "node_modules", "pdfjs-dist");
  if (!existsSync(path.join(pdfjs, "legacy", "build", "pdf.mjs"))) fail("pdfjs-dist offline build is missing; run pnpm install");
  for (const kind of ["cmaps", "standard_fonts", "wasm", "iccs"]) if (existsSync(path.join(pdfjs, kind))) cpSync(path.join(pdfjs, kind), path.join(resourcesDir, PDFJS_DIR, kind), { recursive: true });
  copyFiles(pdfjs, path.join(resourcesDir, PDFJS_DIR), ["legacy/build/pdf.mjs", "legacy/build/pdf.worker.mjs", "LICENSE"]);
  assets.push(record(resourcesDir, "pdfjs-main", `${PDFJS_DIR}/legacy/build/pdf.mjs`));
  assets.push(record(resourcesDir, "pdfjs-worker", `${PDFJS_DIR}/legacy/build/pdf.worker.mjs`));
  assets.push(record(resourcesDir, "pdfjs-license", `${PDFJS_DIR}/LICENSE`));

  // The subtitle renderer's files live inside the app archive, so they are described from the build and checked by the app at start.
  const assetsDir = path.join(sources.rendererDir, "assets");
  for (const item of rendererAssets(sources.rendererDir)) {
    const file = path.join(assetsDir, item.name);
    assets.push({ id: item.id, path: `app.asar/.vite/renderer/main_window/assets/${item.name}`, bytes: statSync(file).size, sha256: sha256File(file) });
  }

  const manifest: AssetManifest = {
    version: 1,
    notices: [
      { name: "FFmpeg", version: ffmpegLock.version, license: ffmpegLock.license, source: ffmpegLock.source.url, files: ["ffmpeg/LICENSE.txt", "ffmpeg/SOURCE.txt"] },
      { name: "Silero VAD", version: sileroLock.version, license: sileroLock.license, source: `https://github.com/snakers4/silero-vad/tree/${sileroLock.commit}`, files: ["vad/LICENSE"] },
      { name: "ONNX Runtime Web", version: ortVersion, license: "MIT", source: "https://github.com/microsoft/onnxruntime", files: ["vad/ort/LICENSE"] },
      { name: "PDF.js", version: (JSON.parse(readFileSync(path.join(pdfjs, "package.json"), "utf8")) as { version: string }).version, license: "Apache-2.0", source: "https://github.com/mozilla/pdf.js", files: [`${PDFJS_DIR}/LICENSE`] },
    ],
    assets,
  };
  for (const id of REQUIRED_ASSETS) if (!assets.some((asset) => asset.id === id)) fail(`required asset ${id} was not staged`);
  writeFileSync(path.join(resourcesDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
