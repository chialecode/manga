import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { fingerprintBuffer } from "../report.ts";
import { buildEpubFixture } from "../domain/epub.ts";
import { buildCbz } from "../domain/comic.ts";
import { generateMedia } from "../domain/media.ts";
import { fixturesDir } from "../env.ts";

export type FixtureManifest = {
  id: string;
  kind: string;
  path: string;
  fingerprint: string;
  expected: Record<string, unknown>;
};

const FIXED_AT = "2026-01-01T00:00:00.000Z";

function write(file: string, data: Uint8Array | string): FixtureManifest {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  fs.writeFileSync(file, buffer);
  return {
    id: path.basename(file),
    kind: path.extname(file).slice(1) || "bin",
    path: file,
    fingerprint: fingerprintBuffer(buffer),
    expected: {},
  };
}

export async function generateFixtures(root = fixturesDir()): Promise<{ root: string; items: FixtureManifest[]; generator: string }> {
  fs.mkdirSync(root, { recursive: true });
  const items: FixtureManifest[] = [];
  const textDir = path.join(root, "text");
  items.push(write(path.join(textDir, "utf8-bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("春が来た。春が来た。重复句定位。\n")])));
  items.push(write(path.join(textDir, "zh-ja-emoji.txt"), "日本語テスト。中文句子。🙂‍↔️组合表情。ガ合字。同一句同一句。"));
  items.push(write(path.join(textDir, "long-chapter.txt"), `${"第1章\n"}${"他沿着长街走着。".repeat(5000)}`));
  const epub = buildEpubFixture({
    title: "M0 EPUB",
    chapters: [
      { id: "c1", title: "序", html: "<p>春が来た。</p><p>插图前。</p><img src='cover.png' alt='cover'/>" },
      { id: "c2", title: "重复", html: "<p>同一句同一句</p><p>同一句同一句</p>" },
    ],
  });
  items.push(Object.assign(write(path.join(root, "epub/basic.epub"), epub), {
    expected: { chapters: 2, duplicateSentence: "同一句同一句" },
  }));
  const huge = new Uint8Array(9 * 1024 * 1024);
  const illegal = zipSync({
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": strToU8("<package></package>"),
    "../escape.txt": strToU8("nope"),
  });
  items.push(write(path.join(root, "epub/illegal-path.epub"), illegal));
  items.push(write(path.join(root, "epub/huge-entry.epub"), zipSync({
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": strToU8("<package></package>"),
    "OEBPS/big.bin": huge,
  })));
  const png = pngPixel();
  items.push(write(path.join(root, "comic/p1.png"), png));
  items.push(write(path.join(root, "comic/p2.png"), png));
  items.push(write(path.join(root, "comic/book.cbz"), buildCbz({
    "1.png": png,
    "3.png": png,
    "2.png": png,
    "2-dup.png": png,
  })));
  const mediaDir = path.join(root, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const mp4 = path.join(mediaDir, "h264-aac.mp4");
  try {
    if (fs.existsSync(mp4)) fs.unlinkSync(mp4);
    generateMedia(mp4, { durationSec: 4, gop: 48 });
    items.push({
      id: "h264-aac.mp4",
      kind: "mp4",
      path: mp4,
      fingerprint: fingerprintBuffer(fs.readFileSync(mp4)),
      expected: { video: "h264", audio: "aac" },
    });
  } catch (error) {
    fs.writeFileSync(path.join(mediaDir, "ffmpeg-missing.txt"), String(error));
  }
  const srt = "1\n00:00:00,000 --> 00:00:01,000\nHELLO MARKER\n";
  items.push(write(path.join(mediaDir, "basic.srt"), srt));
  items.push(write(path.join(mediaDir, "basic.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHELLO MARKER\n"));
  items.push(write(path.join(root, "http/ok.bin"), "OKFILE"));
  items.push(write(path.join(root, "http/sample.bin"), "MANGA-M0-FILE"));
  const manifest = {
    generatedAt: FIXED_AT,
    generator: "experiments/m0/src/fixtures/generate.ts",
    tool: { node: process.versions.node },
    items,
  };
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, items, generator: manifest.generator };
}

function pngPixel(): Uint8Array {
  const raw = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return raw;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  const result = await generateFixtures();
  console.log(JSON.stringify({ status: "passed", root: result.root, count: result.items.length }));
}
