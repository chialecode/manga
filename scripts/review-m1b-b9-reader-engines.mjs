// Product PDF path. PDF.js is the only parser; there is no second engine and no SVG operator list.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parsePdfBytes, buildPdfFixture, buildEpubFixture, parseEpubBytes } from '../packages/app-core/src/domain/formats.ts';
import { builtinReaderEngine } from '../packages/app-core/src/domain/reader-engine.ts';
import { pdfjsAssets } from '../tests/m1b/pdfjs-reader.ts';
import { m1bFingerprints } from './m1b-fingerprint.mjs';
import { repoRoot } from './desktop-paths.ts';

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? 'docs/evidence/m1b-reading-notes/b9-integration');
fs.mkdirSync(evidence, { recursive: true });
const observations = [];
async function check(name, run) {
  const detail = {};
  try { await run(detail); observations.push({ name, status: 'passed', detail }); }
  catch (error) { observations.push({ name, status: 'failed', actual: error.message, detail }); }
}

const pdfjsPackage = JSON.parse(fs.readFileSync(new URL('../node_modules/pdfjs-dist/package.json', import.meta.url), 'utf8'));
const builtin = builtinReaderEngine();

// Same content-stream fixtures as the F-07 width work: each names the expected second run origin and
// the expected rendered width of the first run, as the built-in layout model computes them.
function pdf(content, font, extra = []) {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`,
    font ?? '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>', ...extra,
  ];
  let source = '%PDF-1.4\n'; const offsets = [];
  bodies.forEach((body, i) => { offsets.push(Buffer.byteLength(source, 'ascii')); source += `${i+1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(source, 'ascii');
  source += `xref\n0 ${bodies.length+1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer << /Size ${bodies.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'ascii');
}
const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0041> <0043> <0041> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end';
const cmapStream = `<< /Length ${Buffer.byteLength(cmap,'ascii')} >>\nstream\n${cmap}\nendstream`;
const cidFont = '<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H /ToUnicode 7 0 R /DescendantFonts [6 0 R] >>';

const fixtures = [
  { name: 'courier-basic', bytes: pdf('BT /F1 20 Tf 1 0 0 1 50 320 Tm (HELLO) Tj (WORLD) Tj ET'), expectedAdvance: 120 },
  { name: 'indirect-simple-widths', bytes: pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm (AB) Tj (C) Tj ET', '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding /FirstChar 65 /LastChar 67 /Widths 6 0 R >>', ['[278 556 444]']), expectedAdvance: 12.78 },
  { name: 'cid-array-widths', bytes: pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm <00410042> Tj <0043> Tj ET', cidFont, ['<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [65 [278 556 444]] >>', cmapStream]), expectedAdvance: null },
  { name: 'cid-range-widths', bytes: pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm <00410042> Tj <0043> Tj ET', cidFont, ['<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [65 67 500] >>', cmapStream]), expectedAdvance: null },
  { name: 'half-scale-text', bytes: pdf('BT /F1 20 Tf 50 Tz 1 0 0 1 50 320 Tm (HELLO) Tj (WORLD) Tj ET'), expectedAdvance: 60 },
];
const expectedAdvanceOf = (name) => fixtures.find(fixture => fixture.name === name).expectedAdvance;

await check('product parser keeps page identity, text and line advance', async detail => {
  detail.fixtures = [];
  for (const fixture of fixtures) {
    const parsed = await parsePdfBytes(new Uint8Array(fixture.bytes));
    const part = parsed.parts[0];
    const runs = part.textRuns ?? [];
    const width = runs.reduce((sum, run) => sum + (run.width ?? 0), 0);
    assert.equal(part.id, 'page-1', fixture.name);
    assert.equal(part.render, undefined, `${fixture.name} stored an SVG render`);
    assert.ok(runs.length >= 1, `${fixture.name}: pdf.js should report the line`);
    if (expectedAdvanceOf(fixture.name) == null) assert.ok(width > 0, `${fixture.name} recorded no advance`);
    else assert.ok(Math.abs(width - expectedAdvanceOf(fixture.name)) < 0.05, `${fixture.name}: advance ${width}`);
    let rebuilt = '';
    for (const run of runs) {
      if (run.offset !== undefined) assert.equal([...rebuilt].length, run.offset, `${fixture.name}: offset mismatch`);
      rebuilt += run.text;
    }
    assert.equal(rebuilt, part.normalized, `${fixture.name}: offsets must reassemble the text layer`);
    detail.fixtures.push({ name: fixture.name, lineAdvance: width, normalized: part.normalized });
  }
});

// A two-page PDF with a declared font and an image XObject, so both engines read valid input.
function twoPagePdf(text, imageBytes) {
  const image = imageBytes ?? Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 8 0 R >>',
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${image.length} >> stream\n${Buffer.from(image).toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(text, 'ascii')} >>\nstream\n${text}\nendstream`,
    '<< /Length 8 >>\nstream\n/Im0 Do\nendstream',
  ];
  let source = '%PDF-1.4\n'; const offsets = [];
  bodies.forEach((body, i) => { offsets.push(Buffer.byteLength(source, 'ascii')); source += `${i+1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(source, 'ascii');
  source += `xref\n0 ${bodies.length+1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer << /Size ${bodies.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'ascii');
}

await check('scan page keeps page identity and has no selectable text', async detail => {
  const bytes = twoPagePdf('BT /F1 12 Tf 72 100 Td (Page One Text) Tj ET');
  const parsed = await parsePdfBytes(new Uint8Array(bytes));
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.parts[1].id, 'page-2');
  assert.equal(parsed.parts[1].kind, 'image');
  assert.equal((parsed.parts[1].normalized ?? '').trim(), '');
  assert.equal(parsed.parts[0].normalized, 'Page One Text');
  detail.scanKind = parsed.parts[1].kind;
});

await check('pdf.js operator list still carries the scan image so a page can be rendered', async detail => {
  const { pathToFileURL } = await import('node:url');
  const root = path.resolve(repoRoot, 'node_modules/pdfjs-dist');
  const { getDocument, OPS } = await import(pathToFileURL(path.join(root, 'legacy/build/pdf.mjs')).href);
  const bytes = twoPagePdf('BT /F1 12 Tf 72 100 Td (Page One Text) Tj ET');
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    cMapPacked: true,
    standardFontDataUrl: `${root.replaceAll('\\', '/')}/standard_fonts/`,
    cMapUrl: `${root.replaceAll('\\', '/')}/cmaps/`,
    wasmUrl: `${root.replaceAll('\\', '/')}/wasm/`,
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(2);
    const ops = await page.getOperatorList();
    const paintOps = ops.fnArray.filter(fn => fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject);
    detail.paintImageOps = paintOps.length;
    assert.ok(paintOps.length > 0, 'the scan page must expose a paintable image operator');
  } finally { await task.destroy().catch(() => undefined); }
});

await check('a declared page extracts its text and a scan page stays an image', async detail => {
  const bytes = buildPdfFixture([{ text: '第一页' }, { scan: true }]);
  const parsed = await parsePdfBytes(bytes);
  assert.equal(parsed.parts[0].normalized, '第一页');
  assert.equal(parsed.parts[1].kind, 'image');
  assert.equal(parsed.parts[0].render, undefined);
  assert.equal(parsed.traits.accepted, true);
  assert.equal(parsed.traits.pdfjsPageRendering, true);
  detail.parserId = parsed.parserId;
});

await check('a cancelled parse rejects instead of publishing a page', async detail => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(parsePdfBytes(new Uint8Array(fixtures[0].bytes), { signal: controller.signal }), error => error.code === 'CANCELLED');
  detail.entryAbort = true;
});

await check('reader engine maps the pdf.js text layer with code-point offsets', async detail => {
  const doc = await builtin.parse(new Uint8Array(fixtures[4].bytes));
  assert.equal(doc.format, 'pdf');
  const runs = doc.parts[0].runs ?? [];
  assert.equal(runs[0].offset, 0);
  assert.equal(runs.map(run => run.text).join(''), 'HELLOWORLD');
  assert.ok(closeTo(runs.reduce((sum, run) => sum + (run.width ?? 0), 0), 60), `boundary width=${runs[0].width}`);
  detail.runs = runs;
  await builtin.dispose();
});

// EPUB bounded comparison on the same fixture: epub.js opens the archive in a jsdom shell (the only
// extra shim it needs is URL.createObjectURL); Readium's npm toolkit ships models and a fetcher
// protocol but no local EPUB-file ingestion, which is itself an adaptation finding.
const epubjsPackage = JSON.parse(fs.readFileSync(new URL('../node_modules/epubjs/package.json', import.meta.url), 'utf8'));
const readiumPackage = JSON.parse(fs.readFileSync(new URL('../node_modules/@readium/shared/package.json', import.meta.url), 'utf8'));

await check('epub.js and the builtin parser agree on spine order and chapter text', async detail => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = {};
  for (const key of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Blob']) previous[key] = globalThis[key];
  for (const key of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Blob']) globalThis[key] = dom.window[key];
  const previousCreateObject = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:comparison';
  const previousRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = () => undefined;
  try {
    const require = (await import('node:module')).createRequire(import.meta.url);
    const ePub = require('epubjs').default ?? require('epubjs');
    const bytes = buildEpubFixture({
      title: '对比样本',
      chapters: [
        { id: 'c1', title: '第一章', html: '<p>甲乙丙丁。</p>' },
        { id: 'c2', title: '第二章', html: '<p>第二段文字。</p>' },
      ],
    });
    const parsed = parseEpubBytes(bytes);
    const book = ePub(new Uint8Array(bytes).buffer, { replacements: 'none' });
    const meta = await book.loaded.metadata;
    const spine = await book.loaded.spine;
    const chapters = [];
    for (const [index, item] of spine.spineItems.entries()) {
      const doc = await item.load(book.load.bind(book));
      // The loaded document is XHTML (no .body property); compare visible body text with script
      // content removed, and ignore whitespace-only block-boundary differences between engines.
      const body = doc.getElementsByTagName('body')[0];
      for (const script of [...body.getElementsByTagName('script'), ...body.getElementsByTagName('style')]) script.remove();
      const bodyOnly = body.textContent ?? '';
      chapters.push({ href: item.href, text: bodyOnly.replace(/\s+/g, ' ').trim() });
      assert.equal(item.href, `${parsed.parts[index].id}.xhtml`, 'spine order must match the builtin part order');
      const builtinText = parsed.parts[index].normalized.replace(/\s+/g, '');
      assert.equal(chapters[index].text.replace(/\s+/g, ''), builtinText, `chapter text must agree (${item.href})`);
    }
    detail.title = meta?.title ?? null;
    detail.chapters = chapters;
    detail.epubjsShims = ['jsdom globals (window/document/DOMParser/XMLSerializer/Blob)', 'URL.createObjectURL/revokeObjectURL stubs'];
    detail.authorStyleHandling = 'epub.js applies author CSS inside rendition iframes; a MANGA adapter must pass it through the reader-style boundary like the builtin authorStyle';
    detail.positioning = 'epub.js exposes EPUB CFI; a MANGA adapter must map CFI to nfc-lf-codepoint locators to keep old anchors resolvable';
    await book.destroy();
  } finally {
    URL.createObjectURL = previousCreateObject;
    URL.revokeObjectURL = previousRevoke;
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  }
});

function closeTo(left, right) { return Math.abs(left - right) < 0.01; }

// Offline asset inventory: a production switch must bundle these with the worker.
const cmapsDir = path.resolve(repoRoot, pdfjsAssets.cmaps);
const fontsDir = path.resolve(repoRoot, pdfjsAssets.standardFonts);
const assets = {
  cmapsDir: pdfjsAssets.cmaps,
  standardFontsDir: pdfjsAssets.standardFonts,
  cmaps: fs.existsSync(cmapsDir) ? fs.readdirSync(cmapsDir).filter(name => name.endsWith('.bcmap')).length : 0,
  standardFonts: fs.existsSync(fontsDir) ? fs.readdirSync(fontsDir).length : 0,
  courierStandardFontPresent: fs.existsSync(path.join(fontsDir, 'FoxitFixed.pfb')),
};

const report = {
  at: new Date().toISOString(),
  kind: 'pdfjs-product',
  engines: {
    product: { engineId: 'pdfjs-dist', version: pdfjsPackage.version, license: pdfjsPackage.license, home: 'https://mozilla.github.io/pdf.js/', accepted: true },
  },
  boundary: 'packages/app-core/src/domain/pdfjs-document.ts',
  adapter: 'packages/app-core/src/domain/pdfjs-document.ts',
  epubCandidates: {
    epubjs: { version: epubjsPackage.version, license: epubjsPackage.license, npmLastPublish: '2023-09-26', githubRelease: 'v0.3.88 (2020) — release channel slower than npm per plan 14.5', role: '对照候选', shims: ['jsdom globals', 'URL.createObjectURL stub'] },
    readium: { version: readiumPackage.version, license: readiumPackage.license, npmLastPublish: readiumPackage.time?.modified ?? null, role: '优先原型候选', finding: '@readium/shared ships Publication models and fetcher protocols but no local EPUB-file ingestion; adapting means implementing the resource-supply fetcher for MANGA archives (medium-high cost per plan 14.2)' },
  },
  candidateStatus: 'accepted=true for pdf.js 6.3.289; epub/mobi candidates remain unaccepted',
  assets,
  encryptedMatrix: 'not-run here; encrypted-PDF rejection stays covered by the G-01 product tests',
  ...m1bFingerprints(repoRoot),
  scriptFingerprint: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  status: observations.every(row => row.status === 'passed') ? 'passed' : 'rework-required',
  humanChecks: 'not-run',
  productAcceptance: 'not-run',
  observations,
};
fs.writeFileSync(path.join(evidence, 'reader-engine-evidence.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
