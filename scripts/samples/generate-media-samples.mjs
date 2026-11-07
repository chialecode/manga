#!/usr/bin/env node
// Synthetic sample generator for M2: comic pages and archives, videos, recordings, covers.
// Output: dist/samples/m2/ (git-ignored) plus manifest.json with an ID, fingerprint and sub-features per sample.
//
//   node scripts/samples/generate-media-samples.mjs            generate what is missing or stale
//   node scripts/samples/generate-media-samples.mjs --force    regenerate everything
//   node scripts/samples/generate-media-samples.mjs --verify   check existing samples; non-zero when missing or changed
//   node scripts/samples/generate-media-samples.mjs --only a,b generate only the listed sample IDs
//
// Video and voice samples use the development machine's FFmpeg (the pinned build from scripts/tools) and Windows SAPI
// text-to-speech; neither is shipped. A sample that cannot be produced is recorded as `unavailable` with its reason.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { buildMobiFixture } from "../../packages/app-core/src/domain/formats.ts";
import { buildEmbeddedFontPdf, embeddableFontFile } from "./pdf-embedded-font.ts";
import { renderCover, renderPage, renderStrip } from "./media-draw.mjs";
import { buildArchive, buildImageEpub, buildImagePdf, buildWav, readWav, writeBilevelPng, zeroBombEntry } from "./media-writers.mjs";
import { fingerprintPath, generatorFingerprint, loadManifest, manifestFile, repoRoot, samplesRoot, verifyMediaSamples } from "./media-manifest.mjs";

const args = process.argv.slice(2);
if (args.includes("--verify")) {
  const result = verifyMediaSamples();
  console.log(JSON.stringify({ status: result.ok ? "passed" : "failed", errors: result.errors }, null, 2));
  process.exit(result.ok ? 0 : 1);
}
const force = args.includes("--force");
const onlyArg = args.find((arg) => arg.startsWith("--only="))?.slice(7) ?? (args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined);
const only = onlyArg ? onlyArg.split(",") : undefined;

const ffmpegLock = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts/tools/ffmpeg.lock.json"), "utf8"));
const exe = process.platform === "win32" ? ".exe" : "";
const ffmpegDir = process.env.MANGA_FFMPEG_DIR ?? path.join(repoRoot, "dist/tools/ffmpeg", ffmpegLock.version, "bin");
const ffmpegBin = path.join(ffmpegDir, `ffmpeg${exe}`);
const ffprobeBin = path.join(ffmpegDir, `ffprobe${exe}`);
const scratch = path.join(samplesRoot, ".tmp");

function ff(argv) {
  const result = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-y", ...argv], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.error) throw new Error(`ffmpeg could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.trim().split("\n").slice(-4).join(" | ")}`);
}

function probe(file) {
  const result = spawnSync(ffprobeBin, ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", file], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(`ffprobe failed on ${path.basename(file)}: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

function summarizeProbe(file) {
  const data = probe(file);
  return {
    format: data.format.format_name,
    duration: Number(data.format.duration),
    startTime: Number(data.format.start_time),
    streams: data.streams.map((stream) => ({
      type: stream.codec_type,
      codec: stream.codec_name,
      ...(stream.codec_type === "video" ? { width: stream.width, height: stream.height, pixFmt: stream.pix_fmt, rFrameRate: stream.r_frame_rate, avgFrameRate: stream.avg_frame_rate, profile: stream.profile } : {}),
      ...(stream.codec_type === "audio" ? { channels: stream.channels, sampleRate: Number(stream.sample_rate), language: stream.tags?.language, title: stream.tags?.title } : {}),
      ...(stream.codec_type === "attachment" ? { filename: stream.tags?.filename, mimetype: stream.tags?.mimetype } : {}),
    })),
    chapters: data.chapters.length,
  };
}

const old = !force ? loadManifest() : undefined;
const reuseGenerator = old?.generator?.fingerprint === generatorFingerprint();
if (only && !reuseGenerator) {
  console.error("--only needs samples from the current generator; run once without it");
  process.exit(2);
}
const manifestSamples = [];

/** Define one sample. `build(target)` writes it and returns its truth data; an `optional` failure is recorded, not thrown. */
async function define(id, { kind, rel, features, optional = false, note }, build) {
  const target = path.join(samplesRoot, rel);
  const previous = old?.samples.find((entry) => entry.id === id);
  const selected = !only || only.includes(id);
  if (!selected) {
    if (previous) manifestSamples.push(previous);
    return;
  }
  if (!force && reuseGenerator && previous?.status === "generated" && fs.existsSync(target) && fingerprintPath(target).sha256 === previous.sha256) {
    manifestSamples.push(previous);
    console.log(`  = ${id} (unchanged)`);
    return;
  }
  const started = Date.now();
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    const truth = (await build(target)) ?? {};
    const print = fingerprintPath(target);
    manifestSamples.push({ id, kind, path: rel, status: "generated", features, ...print, ...(note ? { note } : {}), truth });
    console.log(`  + ${id} (${(print.bytes / 1024 / 1024).toFixed(1)} MiB, ${print.files} files, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    if (!optional) throw error;
    manifestSamples.push({ id, kind, path: rel, status: "unavailable", features, reason: error.message });
    console.log(`  ! ${id} unavailable: ${error.message}`);
  }
}

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const pad = (n, width = 3) => String(n).padStart(width, "0");

fs.mkdirSync(samplesRoot, { recursive: true });
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
console.log(`generating samples into ${path.relative(repoRoot, samplesRoot)}`);

// ---------------------------------------------------------------------------------------------------------------
// Comic image directories
// ---------------------------------------------------------------------------------------------------------------

await define("comic-dir-natural", { kind: "comic-dir", rel: "comic/dir-natural", features: ["natural-sort", "single-directory"] }, async (dir) => {
  const names = ["1.png", "2.png", "3.png", "10.png", "11.png", "20.png"];
  // Written in lexical order on purpose; a reader that does not sort naturally shows 1, 10, 11, 2, 20, 3.
  for (const [index, name] of names.entries()) write(path.join(dir, name), await renderPage({ label: name.split(".")[0], variant: index }));
  return { order: names, labels: names.map((name) => name.split(".")[0]), lexicalOrder: [...names].sort() };
});

await define("comic-dir-sparse", { kind: "comic-dir", rel: "comic/dir-sparse", features: ["non-consecutive-numbering"] }, async (dir) => {
  const numbers = [1, 2, 4, 7, 100];
  for (const [index, n] of numbers.entries()) write(path.join(dir, `p${pad(n)}.png`), await renderPage({ label: pad(n), variant: index }));
  return { order: numbers.map((n) => `p${pad(n)}.png`), labels: numbers.map((n) => pad(n)), pageCount: numbers.length };
});

await define("comic-dir-duplicates", { kind: "comic-dir", rel: "comic/dir-duplicates", features: ["duplicate-names-across-directories", "volume-chapter-layout"] }, async (dir) => {
  const layout = [["vol01", "ch01"], ["vol01", "ch02"], ["vol02", "ch01"]];
  const order = [];
  const labels = [];
  for (const [vi, [vol, ch]] of layout.entries()) {
    for (const page of [1, 2]) {
      const relative = `${vol}/${ch}/${pad(page)}.png`;
      const label = `${vol === "vol01" ? 1 : 2}${ch === "ch01" ? 1 : 2}${page}`;
      write(path.join(dir, relative), await renderPage({ label, variant: vi * 2 + page }));
      order.push(relative);
      labels.push(label);
    }
  }
  return { order, labels, chapters: layout.map(([vol, ch]) => `${vol}/${ch}`) };
});

await define("comic-dir-long-strip", { kind: "comic-dir", rel: "comic/dir-long-strip", features: ["long-strip", "vertical-scroll"] }, async (dir) => {
  write(path.join(dir, "001-strip.png"), await renderStrip({ width: 800, height: 16000, sections: 16 }));
  write(path.join(dir, "002.png"), await renderPage({ label: "002", variant: 1 }));
  return { order: ["001-strip.png", "002.png"], strip: { width: 800, height: 16000, sections: 16 } };
});

await define("comic-dir-huge", { kind: "comic-dir", rel: "comic/dir-huge", features: ["oversized-image", "decode-budget"] }, async (dir) => {
  const width = 20000;
  const height = 20000;
  const stride = width / 8;
  const cell = 2500;
  const rows = [];
  for (let r = 0; r < 8; r += 1) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) {
      const black = (Math.floor(x / cell) + r) % 2 === 0;
      if (!black) row[x >> 3] |= 0x80 >> (x & 7);
    }
    rows.push(row);
  }
  write(path.join(dir, "001.png"), await renderPage({ label: "001" }));
  write(path.join(dir, "002-huge.png"), await writeBilevelPng(width, height, (y) => rows[Math.floor(y / cell)]));
  write(path.join(dir, "003.png"), await renderPage({ label: "003", variant: 2 }));
  return { order: ["001.png", "002-huge.png", "003.png"], huge: { name: "002-huge.png", width, height, pixels: width * height } };
});

await define("comic-dir-corrupt", { kind: "comic-dir", rel: "comic/dir-corrupt", features: ["corrupt-page", "truncated-image", "empty-file"] }, async (dir) => {
  const good = await renderPage({ label: "001" });
  write(path.join(dir, "001.png"), good);
  write(path.join(dir, "002.png"), good.subarray(0, Math.floor(good.length * 0.4)));
  write(path.join(dir, "003.jpg"), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 0x41)]));
  write(path.join(dir, "004.png"), await renderPage({ label: "004", variant: 3 }));
  write(path.join(dir, "005.png"), Buffer.alloc(0));
  write(path.join(dir, "006.webp"), await renderPage({ label: "006", variant: 5, format: "webp" }));
  return { order: ["001.png", "002.png", "003.jpg", "004.png", "005.png", "006.webp"], decodable: ["001.png", "004.png", "006.webp"], corrupt: ["002.png", "003.jpg", "005.png"] };
});

await define("comic-dir-mixed", { kind: "comic-dir", rel: "comic/dir-mixed", features: ["mixed-image-formats", "ignored-files", "comicinfo-sidecar"] }, async (dir) => {
  write(path.join(dir, "001.png"), await renderPage({ label: "001" }));
  write(path.join(dir, "002.jpg"), await renderPage({ label: "002", variant: 1, format: "jpg" }));
  write(path.join(dir, "003.webp"), await renderPage({ label: "003", variant: 2, format: "webp" }));
  write(path.join(dir, "004.gif"), await renderPage({ label: "004", variant: 3, format: "gif" }));
  write(path.join(dir, "Thumbs.db"), Buffer.from("not an image"));
  write(path.join(dir, "desktop.ini"), "[.ShellClassInfo]\r\n");
  write(path.join(dir, ".DS_Store"), Buffer.alloc(64, 1));
  write(path.join(dir, "notes.txt"), "scan notes\n");
  write(path.join(dir, "__MACOSX/._001.png"), Buffer.alloc(32, 2));
  write(path.join(dir, "ComicInfo.xml"), `<?xml version="1.0"?><ComicInfo><Title>Mixed Formats</Title><Series>Synthetic Series</Series><Number>2</Number></ComicInfo>`);
  return { order: ["001.png", "002.jpg", "003.webp", "004.gif"], ignored: ["Thumbs.db", "desktop.ini", ".DS_Store", "notes.txt", "__MACOSX/._001.png"], sidecar: "ComicInfo.xml" };
});

// ---------------------------------------------------------------------------------------------------------------
// CBZ archives
// ---------------------------------------------------------------------------------------------------------------

async function pages(count, { format = "png", variant = 0, width = 600, height = 900 } = {}) {
  const out = [];
  for (let i = 1; i <= count; i += 1) out.push({ name: `${pad(i)}.${format}`, label: pad(i), data: await renderPage({ width, height, label: pad(i), variant: variant + i, format }) });
  return out;
}

await define("cbz-basic", { kind: "cbz", rel: "comic/cbz-basic.cbz", features: ["stored-and-deflated", "five-pages"] }, async (file) => {
  const list = await pages(5);
  write(file, buildArchive(list.map((page, index) => ({ name: page.name, data: page.data, method: index % 2 === 0 ? 0 : 8 }))));
  return { order: list.map((page) => page.name), labels: list.map((page) => page.label) };
});

await define("cbz-comicinfo", { kind: "cbz", rel: "comic/cbz-comicinfo.cbz", features: ["comicinfo-xml", "front-cover-flag", "nested-directory"] }, async (file) => {
  const list = await pages(3, { format: "jpg" });
  const info = `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Title>Synthetic Volume One</Title><Series>Synthetic Series</Series><Number>1</Number><Count>3</Count><Volume>1</Volume><Summary>Generated sample volume.</Summary><Year>2026</Year><Writer>A. Writer</Writer><Penciller>B. Penciller</Penciller><Publisher>Sample House</Publisher><LanguageISO>en</LanguageISO><Manga>YesAndRightToLeft</Manga><PageCount>3</PageCount><Pages><Page Image="0" Type="FrontCover" ImageWidth="600" ImageHeight="900"/><Page Image="1" ImageWidth="600" ImageHeight="900"/><Page Image="2" Type="Story" ImageWidth="600" ImageHeight="900"/></Pages></ComicInfo>`;
  write(file, buildArchive([{ name: "ComicInfo.xml", data: Buffer.from(info), method: 8 }, ...list.map((page) => ({ name: `Volume 1/${page.name}`, data: page.data, method: 8 }))]));
  return { title: "Synthetic Volume One", series: "Synthetic Series", number: "1", writer: "A. Writer", pageCount: 3, rightToLeft: true, frontCoverIndex: 0, order: list.map((page) => `Volume 1/${page.name}`) };
});

// Built from parts: the publication check refuses a literal drive path in a public file, and this one is only an attack vector.
const DRIVE_ENTRY = ["C", ":/win/003.png"].join("");

await define("cbz-traversal", { kind: "cbz", rel: "comic/cbz-traversal.cbz", features: ["path-traversal", "absolute-path", "drive-letter", "backslash-escape"] }, async (file) => {
  const png = (label, variant) => renderPage({ label, variant });
  const entries = [
    { name: "001.png", data: await png("001", 0) },
    { name: "../outside.png", data: await png("900", 1) },
    { name: "/abs/002.png", data: await png("901", 2) },
    { name: DRIVE_ENTRY, data: await png("902", 3) },
    { name: "..\\back.png", data: await png("903", 4) },
    { name: "sub/../../escape.png", data: await png("904", 5) },
    { name: "004.png", data: await png("004", 6) },
  ];
  write(file, buildArchive(entries));
  return { accepted: ["001.png", "004.png"], rejected: ["../outside.png", "/abs/002.png", DRIVE_ENTRY, "..\\back.png", "sub/../../escape.png"] };
});

await define("cbz-bomb", { kind: "cbz", rel: "comic/cbz-bomb.cbz", features: ["compression-bomb", "expansion-budget"] }, async (file) => {
  const total = 1024 * 1024 * 1024;
  const first = await renderPage({ label: "001" });
  write(file, buildArchive([{ name: "001.png", data: first }, zeroBombEntry("002.png", total)]));
  return { accepted: ["001.png"], bomb: { name: "002.png", uncompressedBytes: total, ratioAtLeast: 500 } };
});

await define("cbz-encrypted", { kind: "cbz", rel: "comic/cbz-encrypted.cbz", features: ["encrypted-entry"] }, async (file) => {
  const ok = await renderPage({ label: "002", variant: 1 });
  write(file, buildArchive([
    { name: "001.png", method: 8, flags: 0x0001, payload: Buffer.alloc(200, 0x5a), size: 4096, crc: 0 },
    { name: "002.png", data: ok },
  ]));
  return { accepted: ["002.png"], encrypted: ["001.png"] };
});

// ---------------------------------------------------------------------------------------------------------------
// Image-only PDF / EPUB / MOBI comics, covers
// ---------------------------------------------------------------------------------------------------------------

await define("comic-pdf-images", { kind: "pdf-images", rel: "comic/comic-images.pdf", features: ["image-only-pdf", "dct-jpeg", "five-pages"] }, async (file) => {
  const list = await pages(5, { format: "jpg", variant: 2 });
  write(file, buildImagePdf(list.map((page) => ({ width: 600, height: 900, jpeg: page.data })), { title: "Synthetic image PDF" }));
  return { pageCount: 5, labels: list.map((page) => page.label), pageSize: [600, 900] };
});

await define("comic-epub-images", { kind: "epub-images", rel: "comic/comic-images.epub", features: ["fixed-layout", "image-only-pages"] }, async (file) => {
  const list = await pages(4, { variant: 4 });
  write(file, buildImageEpub({ title: "Synthetic image EPUB", pages: list.map((page) => ({ ...page, width: 600, height: 900 })) }));
  return { pageCount: 4, labels: list.map((page) => page.label), cover: null };
});

await define("comic-mobi-images", { kind: "mobi-images", rel: "comic/comic-images.mobi", features: ["image-only-mobi", "image-records"] }, async (file) => {
  const list = await pages(3, { format: "jpg", width: 300, height: 450, variant: 1 });
  const html = list.map((_, index) => `<p><img recindex="${String(index + 1).padStart(4, "0")}"/></p><mbp:pagebreak/>`).join("");
  write(file, buildMobiFixture("", "Synthetic image MOBI", { html, images: list.map((page) => new Uint8Array(page.data)) }));
  return { pageCount: 3, labels: list.map((page) => page.label) };
});

await define("cover-images", { kind: "covers", rel: "covers/images", features: ["portrait", "landscape", "large", "tiny", "webp", "corrupt"] }, async (dir) => {
  write(path.join(dir, "cover-portrait.png"), await renderCover({ label: "11" }));
  write(path.join(dir, "cover-landscape.jpg"), await renderCover({ width: 1280, height: 720, label: "22", variant: 1, format: "jpg" }));
  write(path.join(dir, "cover-large.png"), await renderCover({ width: 3000, height: 4500, label: "33", variant: 2 }));
  write(path.join(dir, "cover-tiny.png"), await renderCover({ width: 32, height: 48, label: "4", variant: 3 }));
  write(path.join(dir, "cover-wide.webp"), await renderCover({ width: 900, height: 600, label: "55", variant: 4, format: "webp" }));
  const good = await renderCover({ label: "66", variant: 5, format: "jpg" });
  write(path.join(dir, "cover-corrupt.jpg"), good.subarray(0, Math.floor(good.length * 0.3)));
  write(path.join(dir, "cover.png"), await renderCover({ label: "77", variant: 6 }));
  return { sizes: { "cover-portrait.png": [600, 900], "cover-landscape.jpg": [1280, 720], "cover-large.png": [3000, 4500], "cover-tiny.png": [32, 48], "cover-wide.webp": [900, 600] }, corrupt: ["cover-corrupt.jpg"], sidecarName: "cover.png" };
});

await define("epub-with-cover", { kind: "epub-images", rel: "covers/epub-with-cover.epub", features: ["epub-cover-image", "cover-metadata"] }, async (file) => {
  const list = await pages(2, { variant: 3 });
  const cover = { name: "cover.png", data: await renderCover({ label: "88", variant: 7 }) };
  write(file, buildImageEpub({ title: "Synthetic cover EPUB", pages: list.map((page) => ({ ...page, width: 600, height: 900 })), cover }));
  return { pageCount: 2, coverLabel: "88" };
});

// ---------------------------------------------------------------------------------------------------------------
// Text PDF with a real embedded font (LOOP-04): the sample for the combining-mark display check
// ---------------------------------------------------------------------------------------------------------------

// The font program is read from this machine (an open-licence file) and embedded in the sample only; it never enters the repository.
await define("pdf-combining-marks", { kind: "pdf-text", rel: "reading/combining-marks.pdf", features: ["embedded-open-font", "precomposed-control", "decomposed-positioned", "decomposed-raw-control"], optional: true, note: "needs an open-licence TrueType font on the machine (MANGA_TEST_PDF_FONT)" }, async (file) => {
  const mark = String.fromCharCode(0x301);
  const lines = [
    { label: "A precomposed:", word: `cafe${mark} re${mark}sume${mark}`.normalize("NFC"), positionMarks: false },
    { label: "B decomposed, positioned:", word: `cafe${mark} re${mark}sume${mark}`, positionMarks: true },
    { label: "C decomposed, raw:", word: `cafe${mark} re${mark}sume${mark}`, positionMarks: false },
  ];
  write(file, buildEmbeddedFontPdf(lines.map((line, index) => ({ text: `${line.label} ${line.word}`, x: 24, y: 330 - index * 60, size: 17, positionMarks: line.positionMarks })), { pageWidth: 480 }));
  return { lines: lines.map((line) => ({ label: line.label, composedText: line.word.normalize("NFC") })), font: path.basename(embeddableFontFile() ?? ""), expectation: "A and B draw each accent over its letter; C shows the accent shifted right because the file gives it no position" };
});

// ---------------------------------------------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------------------------------------------

const ASS = [
  "[Script Info]",
  "Title: Synthetic subtitles",
  "ScriptType: v4.00+",
  "PlayResX: 640",
  "PlayResY: 360",
  "WrapStyle: 0",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1",
  "Style: Sign,Arial,36,&H0000FFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,0,5,20,20,20,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,First line of dialogue",
  "Dialogue: 0,0:00:04.00,0:00:06.50,Default,,0,0,0,,{\\fad(300,300)}Fading line 中文字幕",
  "Dialogue: 0,0:00:07.00,0:00:09.50,Sign,,0,0,0,,{\\pos(320,60)\\c&H00FF00&}Positioned sign",
  "Dialogue: 0,0:00:10.00,0:00:13.00,Default,,0,0,0,,{\\k50}Ka{\\k50}ra{\\k50}o{\\k50}ke",
  "",
].join("\n");

const SRT = ["1", "00:00:01,000 --> 00:00:03,500", "First line of dialogue", "", "2", "00:00:04,000 --> 00:00:06,500", "Second line", "", "3", "00:00:07,000 --> 00:00:09,500", "Third line", "", ""].join("\n");
const SRT_ZH = ["1", "00:00:01,000 --> 00:00:03,500", "第一句台词", "", "2", "00:00:04,000 --> 00:00:06,500", "第二句台词", "", ""].join("\n");

const source = (kind, seconds, size = "640x360", rate = 24) => ["-f", "lavfi", "-i", `${kind}=size=${size}:rate=${rate}:duration=${seconds}`];
const tone = (hz, seconds) => ["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`];
const h264 = ["-c:v", "libopenh264", "-g", "48", "-b:v", "600k", "-pix_fmt", "yuv420p"];

await define("video-mp4-h264-aac", { kind: "video", rel: "video/h264-aac.mp4", features: ["mp4", "h264", "aac", "keyframe-interval-2s", "faststart"] }, async (file) => {
  ff([...source("testsrc", 24), ...tone(440, 24), ...h264, "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", file]);
  return { ...summarizeProbe(file), keyframeIntervalSeconds: 2, frames: 576 };
});

await define("video-mkv-ass-fonts", { kind: "video", rel: "video/mkv-ass-fonts.mkv", features: ["mkv", "embedded-ass", "attached-font", "two-audio-tracks", "chapters"] }, async (file) => {
  const ass = path.join(scratch, "embedded.ass");
  fs.writeFileSync(ass, ASS);
  const fontFile = [path.join(process.env.WINDIR ?? "", "Fonts", "arial.ttf"), "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((candidate) => fs.existsSync(candidate));
  if (!fontFile) throw new Error("no system TrueType font found to attach");
  const meta = path.join(scratch, "chapters.ffmeta");
  fs.writeFileSync(meta, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=5000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=15000\ntitle=Main part\n");
  ff([
    ...source("testsrc", 15), ...tone(440, 15), ...tone(880, 15), "-i", ass, "-i", meta,
    "-attach", fontFile, "-metadata:s:t:0", "mimetype=font/ttf", "-metadata:s:t:0", `filename=${path.basename(fontFile)}`,
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-map_chapters", "4",
    ...h264, "-c:a", "aac", "-b:a", "96k", "-c:s", "ass",
    "-metadata:s:a:0", "language=jpn", "-metadata:s:a:0", "title=Japanese 2.0",
    "-metadata:s:a:1", "language=chi", "-metadata:s:a:1", "title=Chinese 2.0",
    "-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=English (ASS)",
    "-disposition:a:0", "default", file,
  ]);
  return { ...summarizeProbe(file), subtitleEvents: 4, styleFont: "Arial", attachedFont: path.basename(fontFile), chapterTitles: ["Opening", "Main part"] };
});

await define("video-external-subs", { kind: "video-dir", rel: "video/external-subs", features: ["external-ass", "external-srt", "language-suffix-sidecar"] }, async (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  ff([...source("testsrc", 14), ...tone(523, 14), ...h264, "-c:a", "aac", "-shortest", path.join(dir, "episode.mp4")]);
  write(path.join(dir, "episode.ass"), ASS);
  write(path.join(dir, "episode.en.srt"), SRT);
  write(path.join(dir, "episode.zh-CN.srt"), SRT_ZH);
  write(path.join(dir, "other-episode.srt"), SRT);
  return { video: "episode.mp4", sidecars: ["episode.ass", "episode.en.srt", "episode.zh-CN.srt"], unrelated: ["other-episode.srt"], ...{ probe: summarizeProbe(path.join(dir, "episode.mp4")) } };
});

await define("video-mkv-hevc-8bit", { kind: "video", rel: "video/hevc-8bit.mkv", features: ["mkv", "hevc", "8-bit"] }, async (file) => {
  ff([...source("testsrc", 10), ...tone(440, 10), "-c:v", "libkvazaar", "-pix_fmt", "yuv420p", "-g", "48", "-kvazaar-params", "preset=ultrafast", "-c:a", "aac", "-shortest", file]);
  return summarizeProbe(file);
});

await define("video-mkv-hevc-10bit", { kind: "video", rel: "video/hevc-10bit.mkv", features: ["mkv", "hevc", "10-bit", "main10"], optional: true, note: "encoded with hevc_nvenc; absent on machines without a supporting GPU" }, async (file) => {
  ff([...source("testsrc", 10, "1280x720"), ...tone(440, 10), "-c:v", "hevc_nvenc", "-pix_fmt", "p010le", "-profile:v", "main10", "-preset", "p1", "-g", "48", "-c:a", "aac", "-shortest", file]);
  return summarizeProbe(file);
});

await define("video-vfr", { kind: "video", rel: "video/vfr.mp4", features: ["variable-frame-rate", "mp4"] }, async (file) => {
  ff([...source("testsrc", 16, "480x270", 30), "-vf", "select='lt(t\\,8)+not(mod(n\\,3))'", "-fps_mode", "vfr", ...h264, "-an", file]);
  const summary = summarizeProbe(file);
  return { ...summary, note: "full 30 fps for 8 s, then every third frame (10 fps) for 8 s" };
});

await define("video-nonzero-start", { kind: "video", rel: "video/nonzero-start.mkv", features: ["start-time-offset", "mkv"] }, async (file) => {
  ff([...source("testsrc", 10, "480x270"), ...tone(440, 10), ...h264, "-c:a", "aac", "-shortest", "-output_ts_offset", "2.5", file]);
  const summary = summarizeProbe(file);
  if (!(summary.startTime > 2)) throw new Error(`start time was not offset: ${summary.startTime}`);
  return { ...summary, expectedStartTime: 2.5 };
});

await define("video-ac3", { kind: "video", rel: "video/ac3.mkv", features: ["ac3-audio", "mkv", "audio-transcode-needed"] }, async (file) => {
  ff([...source("testsrc", 10, "480x270"), ...tone(440, 10), ...h264, "-c:a", "ac3", "-b:a", "192k", "-shortest", file]);
  return summarizeProbe(file);
});

await define("video-corrupt", { kind: "video", rel: "video/truncated.mp4", features: ["damaged-container", "moov-missing"] }, async (file) => {
  const whole = path.join(scratch, "whole.mp4");
  ff([...source("testsrc", 8, "320x180"), ...h264, "-an", whole]); // no faststart: moov atom is at the end
  const bytes = fs.readFileSync(whole);
  write(file, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  const result = spawnSync(ffprobeBin, ["-v", "error", file], { encoding: "utf8" });
  if (result.status === 0) throw new Error("truncated sample is unexpectedly readable");
  return { probeFails: true };
});

const EPISODES = [
  { file: "[SubGroup] Sample Anime - 01 [1080p].mkv", title: "Sample Anime", episode: "01", kind: "episode" },
  { file: "[SubGroup] Sample Anime - 02 [1080p].mkv", title: "Sample Anime", episode: "02", kind: "episode" },
  { file: "[SubGroup] Sample Anime - 03 [1080p].mkv", title: "Sample Anime", episode: "03", kind: "episode" },
  { file: "[SubGroup] Sample Anime - 05 [1080p].mkv", title: "Sample Anime", episode: "05", kind: "episode" },
  { file: "[SubGroup] Sample Anime - 07v2 [1080p].mkv", title: "Sample Anime", episode: "07", version: "2", kind: "episode" },
  { file: "[SubGroup] Sample Anime - SP1 [1080p].mkv", title: "Sample Anime", episode: "SP1", kind: "special" },
  { file: "[SubGroup] Sample Anime - OVA [1080p].mkv", title: "Sample Anime", episode: "OVA", kind: "ova" },
];

await define("video-episodes", { kind: "video-dir", rel: "video/episodes", features: ["anitomy-style-names", "episode-gap", "version-suffix", "special-and-ova", "external-subtitle"] }, async (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const [index, entry] of EPISODES.entries()) {
    ff([...source("testsrc2", 4, "320x180", 24), ...tone(400 + index * 40, 4), ...h264, "-c:a", "aac", "-shortest", "-metadata", `title=${entry.title} ${entry.episode}`, path.join(dir, entry.file)]);
  }
  write(path.join(dir, "[SubGroup] Sample Anime - 01 [1080p].chs.ass"), ASS);
  return { episodes: EPISODES, missingEpisodes: ["04", "06"], sidecars: ["[SubGroup] Sample Anime - 01 [1080p].chs.ass"] };
});

// ---------------------------------------------------------------------------------------------------------------
// Recordings: Windows SAPI speech mixed with synthetic music and noise
// ---------------------------------------------------------------------------------------------------------------

const RATE = 16000;
const PHRASES = {
  "zh-CN": [
    "今天我们开始阅读第一章，请先打开书籍并翻到第一页。",
    "星野澪推开白鹭学园的旧图书馆大门，发现了一封没有署名的信。",
    "这一段需要重点记录，主角第一次遇到魔法少女，并签下了契约。",
    "第三话的结尾处，时间线出现了明显的矛盾，需要回头核对设定。",
    "我想把这页的分镜顺序整理一下，再和上一章的结尾对照着看。",
    "这个角色的口头禅出现了三次，分别在开头中段和结尾。",
    "请把刚才那句台词记成笔记，并标注是哪一话的哪一分钟。",
    "背景音乐在这里切换成了钢琴，气氛一下子安静下来。",
    "作者在后记里提到，这部作品的灵感来自一次雨夜的旅行。",
    "下一段是回忆场景，画面颜色明显变淡，大概是为了区分时间。",
    "结局的伏笔早在第二卷就已经埋下，只是当时没有人注意到。",
    "今天的录音先到这里，明天继续往后读。",
  ],
  "en-US": [
    "The protagonist opens the old library door and finds a hidden letter.",
    "This scene is important, so please save a note with the exact timestamp.",
    "The second chapter ends with a quiet conversation on the rooftop.",
    "I want to compare the opening of volume one with the final pages of volume three.",
    "The music changes to a slow piano melody and the whole mood settles down.",
    "She promises to return before the festival begins, but nobody believes her.",
    "There is a small mistake in the subtitle timing around the third minute.",
    "The author explains in the afterword that the story began as a short sketch.",
    "Let us pause here and write down the three questions that remain unanswered.",
    "Notice how the colors fade during the flashback to mark a different time.",
    "The final twist was foreshadowed in the very first episode.",
    "That is all for today's recording, we will continue tomorrow.",
  ],
};
const VOICES = { "zh-CN": ["Microsoft Huihui Desktop"], "en-US": ["Microsoft Zira Desktop", "Microsoft David Desktop"] };

/** Synthesize phrases with SAPI into 16 kHz mono WAV files. Returns Int16 sample arrays by "lang/index". */
function synthesize() {
  if (process.platform !== "win32") throw new Error("Windows SAPI text-to-speech is only available on Windows");
  const clips = new Map();
  const items = [];
  for (const [lang, phrases] of Object.entries(PHRASES)) {
    const voices = VOICES[lang];
    phrases.forEach((text, index) => items.push({ lang, index, text, voice: voices[index % voices.length], file: path.join(scratch, `${lang}-${pad(index, 2)}.wav`) }));
  }
  const itemsFile = path.join(scratch, "tts-items.json");
  fs.writeFileSync(itemsFile, JSON.stringify(items), "utf8");
  const script = path.join(scratch, "tts.ps1");
  fs.writeFileSync(script, [
    "param($Items)",
    "Add-Type -AssemblyName System.Speech",
    "$list = Get-Content -Raw -Encoding UTF8 $Items | ConvertFrom-Json",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    "foreach ($i in $list) { $synth.SelectVoice($i.voice); $synth.SetOutputToWaveFile($i.file, $fmt); $synth.Speak($i.text); $synth.SetOutputToNull() }",
    "",
  ].join("\r\n"), "utf8");
  const run = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, itemsFile], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`SAPI synthesis failed: ${(run.stderr || run.stdout).trim().slice(0, 300)}`);
  for (const item of items) {
    const { rate, samples } = readWav(fs.readFileSync(item.file));
    if (rate !== RATE) throw new Error(`unexpected TTS rate ${rate}`);
    // Voiced bounds: first and last sample above a small threshold; the rest of the clip is padding.
    let first = 0;
    let last = samples.length - 1;
    while (first < samples.length && Math.abs(samples[first]) < 300) first += 1;
    while (last > first && Math.abs(samples[last]) < 300) last -= 1;
    if (last - first < RATE) throw new Error(`TTS clip ${item.lang}/${item.index} is nearly silent`);
    clips.set(`${item.lang}/${item.index}`, { ...item, samples, first, last });
  }
  return clips;
}

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHORDS = [[261.63, 329.63, 392.0], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]];

function addChords(buffer, start, seconds, gain) {
  const chordLength = 2 * RATE;
  const total = Math.floor(seconds * RATE);
  for (let n = 0; n < total; n += 1) {
    const index = Math.floor(n / chordLength);
    const t = (n % chordLength) / chordLength;
    const envelope = Math.min(1, t * 12) * Math.min(1, (1 - t) * 8);
    let value = 0;
    for (const f of CHORDS[index % CHORDS.length]) value += Math.sin((2 * Math.PI * f * n) / RATE) + 0.3 * Math.sin((4 * Math.PI * f * n) / RATE);
    const position = start + n;
    if (position < buffer.length) buffer[position] += (value / 6) * envelope * gain;
  }
}

function addNoise(buffer, start, seconds, gain, kind, random) {
  const total = Math.floor(seconds * RATE);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let n = 0; n < total; n += 1) {
    const white = random() * 2 - 1;
    let value = white;
    if (kind === "pink") {
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      value = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    if (start + n < buffer.length) buffer[start + n] += value * gain;
  }
}

function addClip(buffer, start, clip, gain) {
  const peak = clip.samples.reduce((max, value) => Math.max(max, Math.abs(value)), 1);
  const scale = (gain * 32768) / peak / 32768;
  for (let i = 0; i < clip.samples.length; i += 1) if (start + i < buffer.length) buffer[start + i] += clip.samples[i] * scale;
}

function toInt16(buffer, peak = 0.9) {
  let max = 1e-9;
  for (let i = 0; i < buffer.length; i += 1) max = Math.max(max, Math.abs(buffer[i]));
  const scale = Math.min(1, peak / max);
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) out[i] = Math.max(-32768, Math.min(32767, Math.round(buffer[i] * scale * 32767)));
  return out;
}

let ttsCache;
const clipsOnce = () => (ttsCache ??= synthesize());

await define("voice-recording-30min", { kind: "recording", rel: "voice/recording-30min", features: ["tts-zh-en", "music-chords", "white-noise", "pink-noise", "digital-silence", "speech-over-music", "truth-intervals", "30-minutes"], optional: true, note: "Windows SAPI voices installed on the generating machine: zh-CN Huihui, en-US Zira/David; no Japanese voice was available" }, async (dir) => {
  const clips = clipsOnce();
  const random = prng(20261003);
  const totalSeconds = 30 * 60;
  const buffer = new Float32Array(totalSeconds * RATE);
  const events = [];
  let clipCounter = 0;
  const region = (start, end, kind, extra = {}) => events.push({ start, end, kind, ...extra });
  const speechRun = (from, to, lang, { background, gap = 1.4 } = {}) => {
    let cursor = from;
    for (;;) {
      const key = `${lang}/${clipCounter % PHRASES[lang].length}`;
      const clip = clips.get(key);
      const lead = Math.floor(0.2 * RATE);
      const length = clip.samples.length / RATE;
      if (cursor + length + 0.2 > to) break;
      const startSample = Math.floor(cursor * RATE);
      addClip(buffer, startSample, clip, 0.6);
      events.push({ start: +(cursor + clip.first / RATE).toFixed(3), end: +(cursor + clip.last / RATE).toFixed(3), kind: background ? "speech-over-music" : "speech", lang, text: clip.text, voice: clip.voice });
      void lead;
      cursor += length + gap;
      clipCounter += 1;
    }
  };
  for (let block = 0; block < 15; block += 1) {
    const o = block * 120;
    region(o, o + 6, "silence");
    addChords(buffer, (o + 6) * RATE, 20, 0.25);
    region(o + 6, o + 26, "music");
    addNoise(buffer, (o + 26) * RATE, 4, 0.1, "white", random);
    region(o + 26, o + 30, "noise-white");
    speechRun(o + 31, o + 60, "zh-CN");
    addNoise(buffer, (o + 60) * RATE, 6, 0.1, "pink", random);
    region(o + 60, o + 66, "noise-pink");
    addNoise(buffer, (o + 66) * RATE, 30, 0.008, "pink", random);
    speechRun(o + 66.5, o + 96, "en-US");
    addChords(buffer, (o + 96) * RATE, 24, 0.07);
    speechRun(o + 97, o + 119, "zh-CN", { background: true });
    region(o + 119, o + 120, "silence");
  }
  const pcm = toInt16(buffer);
  write(path.join(dir, "recording.wav"), buildWav(pcm, RATE));
  const speech = events.filter((event) => event.kind.startsWith("speech"));
  write(path.join(dir, "truth.json"), `${JSON.stringify({ sampleRate: RATE, durationSeconds: totalSeconds, events }, null, 2)}\n`);
  return { sampleRate: RATE, durationSeconds: totalSeconds, speechClips: speech.length, speechSeconds: +speech.reduce((sum, event) => sum + (event.end - event.start), 0).toFixed(1), truth: "truth.json", languages: ["zh-CN", "en-US"] };
});

await define("voice-no-speech", { kind: "recording", rel: "voice/no-speech", features: ["no-speech", "music-chords", "white-noise", "pink-noise", "digital-silence", "5-minutes"] }, async (dir) => {
  const random = prng(7);
  const totalSeconds = 300;
  const buffer = new Float32Array(totalSeconds * RATE);
  const events = [];
  for (let block = 0; block < 5; block += 1) {
    const o = block * 60;
    addChords(buffer, (o + 5) * RATE, 20, 0.3);
    addNoise(buffer, (o + 25) * RATE, 8, 0.12, "white", random);
    addNoise(buffer, (o + 33) * RATE, 12, 0.12, "pink", random);
    addChords(buffer, (o + 45) * RATE, 8, 0.3);
    events.push({ start: o, end: o + 5, kind: "silence" }, { start: o + 5, end: o + 25, kind: "music" }, { start: o + 25, end: o + 33, kind: "noise-white" }, { start: o + 33, end: o + 45, kind: "noise-pink" }, { start: o + 45, end: o + 53, kind: "music" }, { start: o + 53, end: o + 60, kind: "silence" });
  }
  write(path.join(dir, "recording.wav"), buildWav(toInt16(buffer), RATE));
  write(path.join(dir, "truth.json"), `${JSON.stringify({ sampleRate: RATE, durationSeconds: totalSeconds, events, speech: [] }, null, 2)}\n`);
  return { sampleRate: RATE, durationSeconds: totalSeconds, speechClips: 0, truth: "truth.json" };
});

await define("voice-tts-clips", { kind: "recording", rel: "voice/tts-clips", features: ["short-tts-clips", "asr-contract-input", "zh-en"], optional: true }, async (dir) => {
  const clips = clipsOnce();
  const truth = [];
  for (const key of ["zh-CN/0", "zh-CN/1", "zh-CN/2", "en-US/0", "en-US/1", "en-US/2"]) {
    const clip = clips.get(key);
    const name = `${key.replace("/", "-")}.wav`;
    write(path.join(dir, name), buildWav(clip.samples.slice(Math.max(0, clip.first - 4000), Math.min(clip.samples.length, clip.last + 4000)), RATE));
    truth.push({ file: name, lang: clip.lang, text: clip.text, voice: clip.voice, seconds: +((clip.last - clip.first) / RATE).toFixed(2) });
  }
  write(path.join(dir, "truth.json"), `${JSON.stringify({ clips: truth }, null, 2)}\n`);
  return { clips: truth };
});

// ---------------------------------------------------------------------------------------------------------------

fs.rmSync(scratch, { recursive: true, force: true });
const order = ["comic", "cbz", "pdf", "epub", "mobi", "cover", "video", "recording"];
manifestSamples.sort((a, b) => order.findIndex((p) => a.kind.startsWith(p) || a.id.startsWith(p)) - order.findIndex((p) => b.kind.startsWith(p) || b.id.startsWith(p)) || a.id.localeCompare(b.id));
const manifest = {
  schema: 1,
  stage: "m2",
  note: "Synthetic samples for M2. Generated, git-ignored; no real content. Regenerate with node scripts/samples/generate-media-samples.mjs.",
  generator: {
    path: "scripts/samples/generate-media-samples.mjs",
    fingerprint: generatorFingerprint(),
    node: process.version,
    sharp: sharp.versions.sharp,
    ffmpeg: ffmpegLock.version,
    platform: process.platform,
  },
  samples: manifestSamples,
};
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
const check = verifyMediaSamples();
const unavailable = manifestSamples.filter((sample) => sample.status !== "generated");
console.log(JSON.stringify({ status: check.ok ? "passed" : "failed", samples: manifestSamples.length, unavailable: unavailable.map((sample) => sample.id), errors: check.errors }));
process.exit(check.ok ? 0 : 1);
