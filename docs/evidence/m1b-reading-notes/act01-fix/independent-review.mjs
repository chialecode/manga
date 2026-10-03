// Copied from a-b11-review to re-run the F-07/F-09 packaged checks for ACT-01 in this directory. The only change:
// before switching book or page, the current text layer is marked stale, so waitForGlyph cannot match the previous
// book's identical first line while it is being replaced.
// F-07/F-09 counterexamples for the PDF.js text-layer rework. Writes only this directory.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startApp, tempProfile } from '../../../../tests/m1b/helpers.ts';
import { exportLibraryPackage, importLibraryPackageResolved } from '../../../../packages/app-core/src/domain/library-package.ts';
import { parsePdfBytes } from '../../../../packages/app-core/src/domain/formats.ts';
import { parsePdfDocument } from '../../../../packages/app-core/src/domain/pdfjs-document.ts';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
import { requiredPdfCounterexamples } from '../../../../scripts/m1b-report.mjs';
import { desktopPackageDir } from '../../../../scripts/desktop-paths.ts';
import { renderPdfPage } from '../../../../tests/m1b/pdf-pixels.ts';
import { _electron as electron } from 'playwright-core';

const dir = path.dirname(fileURLToPath(import.meta.url));
const nodeOnly = process.env.M1B_NODE_ONLY === '1';
const observations = [];
async function check(finding, name, fn) {
  const detail = {};
  try { await fn(detail); observations.push({ finding, name, status: 'passed', detail }); }
  catch (e) { observations.push({ finding, name, status: 'failed', actual: e instanceof Error ? e.message : String(e), detail }); }
}
async function call(ctx, commandId, input) {
  const r = await ctx.app.call(ctx.actor, { commandId, input, idempotencyKey: crypto.randomUUID() }, ctx.grant.handle);
  assert.equal(r.status, 'ok', r.error?.message);
  return r.value;
}
const tables = ['works', 'resources', 'resource_revisions', 'anchors', 'refs', 'content_objects', 'object_revisions', 'text_fragments', 'search_idx', 'resource_assets', 'file_locations', 'progress', 'bookmarks'];
function snapshot(db) { return JSON.stringify(tables.map(t => ({ table: t, rows: db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() }))); }
function attachmentSnapshot(root) {
  const out = {};
  function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(root, f).replaceAll('\\', '/')] = createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    }
  }
  walk(root);
  return out;
}
function pdf(content, font = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>') {
  const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, font];
  let s = '%PDF-1.4\n';
  const offsets = [];
  bodies.forEach((b, i) => { offsets.push(Buffer.byteLength(s, 'ascii')); s += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const x = Buffer.byteLength(s, 'ascii');
  s += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer << /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(s, 'ascii');
}
function pdfPages(contents) {
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  const fontId = 3 + contents.length * 2;
  const objects = new Array(fontId).fill('');
  const kids = [];
  contents.forEach((content, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId - 1] = `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`;
  });
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Count ${contents.length} /Kids [${kids.join(' ')}] >>`;
  objects[fontId - 1] = font;
  let s = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((b, i) => { offsets.push(Buffer.byteLength(s, 'ascii')); s += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const x = Buffer.byteLength(s, 'ascii');
  s += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(s, 'ascii');
}
function assemble(objects) {
  const header = Buffer.from('%PDF-1.4\n');
  let cursor = header.length;
  const xref = ['xref\n', `0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
  for (const object of objects) { xref.push(`${String(cursor).padStart(10, '0')} 00000 n \n`); cursor += object.length; }
  const tail = Buffer.from(`${xref.join('')}trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`);
  return Buffer.concat([header, ...objects, tail]);
}
function embeddedFontPdf(text) {
  const fontData = fs.readFileSync(path.resolve('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
  const content = Buffer.from(`BT /F1 20 Tf 1 0 0 1 50 320 Tm (${text}) Tj ET\n`);
  const widths = Array.from({ length: 77 - 32 + 1 }, () => 600).join(' ');
  return assemble([
    Buffer.from('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'),
    Buffer.from('2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n'),
    Buffer.from('3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n'),
    Buffer.concat([Buffer.from(`4 0 obj << /Length ${content.length} >> stream\n`), content, Buffer.from('\nendstream endobj\n')]),
    Buffer.from(`5 0 obj << /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 77 /Widths [${widths}] /FontDescriptor 6 0 R >> endobj\n`),
    Buffer.from('6 0 obj << /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [-543 -303 1300 980] /ItalicAngle 0 /Ascent 905 /Descent -211 /CapHeight 728 /StemV 80 /FontFile2 7 0 R >> endobj\n'),
    Buffer.concat([Buffer.from(`7 0 obj << /Length ${fontData.length} >> stream\n`), fontData, Buffer.from('\nendstream endobj\n')]),
  ]);
}
function ink(ctx, width, height) {
  const data = ctx.getImageData(0, 0, Math.ceil(width), Math.ceil(height)).data;
  let count = 0;
  for (let index = 0; index < data.length; index += 4) if (data[index] < 250 || data[index + 1] < 250 || data[index + 2] < 250) count += 1;
  return count;
}
function occurrence(text, quote, which) {
  const hay = [...text];
  const needle = [...quote];
  let seen = 0;
  for (let index = 0; index <= hay.length - needle.length; index += 1) {
    if (needle.every((char, offset) => hay[index + offset] === char)) {
      seen += 1;
      if (seen === which) return { start: index, end: index + needle.length };
    }
  }
  throw new Error(`missing occurrence ${which} of ${quote}`);
}

if (!nodeOnly) for (const variant of [
  { name: 'replace anchor control', anchor: 'replace', resource: 'replace' },
  { name: 'duplicate anchor retains payload/ref/history agreement', anchor: 'duplicate', resource: 'replace' },
  { name: 'duplicate resource and anchor keeps skipped ref revision owner', anchor: 'duplicate', resource: 'duplicate' },
  { name: 'duplicate resource with replaced anchor keeps skipped source identity', anchor: 'replace', resource: 'duplicate' },
]) await check('F-09', variant.name, async detail => {
  const ctx = await startApp();
  try {
    const book = await call(ctx, 'library.importDocument', { title: '保留来源的合成书', format: 'txt', bytes: [...new TextEncoder().encode('来源正文。第二段。')] });
    const note = await call(ctx, 'notes.create', { title: '保留来源的合成笔记', text: '评论', resourceId: book.resourceId, resourceRevisionId: book.revisionId, locator: { kind: 'text', partId: 'body', representationId: book.revisionId, normalizationVersion: 'nfc-lf-codepoint-v1', range: { start: 0, end: 4 }, quote: { exact: '来源正文' } } });
    const db = ctx.app.store.sqlite, pkg = tempProfile(), manifest = exportLibraryPackage(ctx.app.store, pkg), ref = manifest.refs[0];
    db.prepare('UPDATE refs SET mode=?,instance_layout_json=? WHERE id=?').run('snapshot', JSON.stringify({ marker: 'local-after-export' }), ref.id);
    const sourceBefore = await call(ctx, 'notes.openSource', { objectId: note.objectId, blockId: 'quote' });
    assert.equal(sourceBefore.status, 'resolved');
    assert.equal(sourceBefore.card.status, 'resolved');
    const before = snapshot(db), beforeFiles = attachmentSnapshot(ctx.app.store.attachmentsDir);
    const refBefore = db.prepare('SELECT * FROM refs WHERE id=?').get(ref.id);
    let error;
    try {
      importLibraryPackageResolved(ctx.app.store, pkg, { strategy: 'replace', decisions: [{ kind: 'object', id: note.objectId, action: 'replace' }, { kind: 'ref', id: ref.id, action: 'skip' }, { kind: 'anchor', id: ref.to_id, action: variant.anchor }, { kind: 'resource', id: book.resourceId, action: variant.resource }, { kind: 'resource_revision', id: book.revisionId, action: 'replace' }] });
    } catch (e) { error = e; }
    detail.errorCode = error?.code ?? null;
    detail.contentUnchanged = snapshot(db) === before;
    detail.attachmentsUnchanged = JSON.stringify(attachmentSnapshot(ctx.app.store.attachmentsDir)) === JSON.stringify(beforeFiles);
    detail.refBefore = refBefore;
    detail.refAfter = db.prepare('SELECT * FROM refs WHERE id=?').get(ref.id);
    if (error) { assert.equal(error.code, 'PUBLISH_CONFLICT'); assert.equal(detail.contentUnchanged, true); assert.equal(detail.attachmentsUnchanged, true); return; }
    detail.sourceBefore = sourceBefore;
    detail.sourceAfter = await call(ctx, 'notes.openSource', { objectId: note.objectId, blockId: 'quote' });
    detail.payload = JSON.parse(db.prepare('SELECT payload_json FROM content_objects WHERE id=?').get(note.objectId).payload_json);
    detail.history = db.prepare('SELECT revision,payload_json FROM object_revisions WHERE object_id=? ORDER BY revision').all(note.objectId).map(r => ({ revision: r.revision, payload: JSON.parse(r.payload_json) }));
    detail.refs = db.prepare('SELECT * FROM refs WHERE from_object_id=?').all(note.objectId);
    detail.anchors = db.prepare('SELECT a.id,a.resource_id,a.resource_revision_id,v.resource_id AS revisionOwner FROM anchors a LEFT JOIN resource_revisions v ON a.resource_revision_id=v.id').all();
    detail.indices = db.prepare('SELECT object_id,resource_id,resource_revision_id FROM text_fragments WHERE object_id=?').all(note.objectId);
    const violations = [];
    if (JSON.stringify(detail.refAfter) !== JSON.stringify(refBefore)) violations.push('explicitly skipped ref row changed');
    if (detail.sourceAfter.status !== 'resolved' || detail.sourceAfter.card?.status !== 'resolved') violations.push(`source/card no longer resolved: ${detail.sourceAfter.status}/${detail.sourceAfter.card?.status}`);
    if (detail.sourceAfter.card?.resourceId !== book.resourceId) violations.push('skipped source silently moved to another resource');
    for (const a of detail.anchors) if (a.resource_id !== a.revisionOwner) violations.push(`anchor ${a.id} disagrees with revision owner`);
    for (const payload of [detail.payload, ...detail.history.map(h => h.payload)]) for (const block of payload.blocks ?? []) { if (!block.anchorId) continue; const r = detail.refs.find(r => r.from_block_id === block.id && r.to_kind === 'anchor'); if (r?.to_id !== block.anchorId) violations.push(`block ${block.id} payload/history anchor disagrees with public ref`); }
    detail.violations = [...new Set(violations)];
    assert.deepEqual(detail.violations, [], 'skip must preserve a coherent source graph or reject before content writes');
  } finally { ctx.app.close(); }
});

await check('F-07', 'embedded font and substitute font stay distinct', async detail => {
  const substitute = new Uint8Array(pdf('BT /F1 20 Tf 1 0 0 1 50 320 Tm (EMBED) Tj ET'));
  const embedded = new Uint8Array(embeddedFontPdf('EMBED'));
  detail.substituteHasFontFile = Buffer.from(substitute).includes('/FontFile');
  detail.embeddedHasFontFile = Buffer.from(embedded).includes('/FontFile2');
  assert.equal(detail.substituteHasFontFile, false);
  assert.equal(detail.embeddedHasFontFile, true);
  detail.substituteText = (await parsePdfBytes(substitute)).parts[0]?.normalized ?? '';
  detail.embeddedText = (await parsePdfBytes(embedded)).parts[0]?.normalized ?? '';
  assert.ok(detail.substituteText.includes('EMBED'));
  assert.ok(detail.embeddedText.includes('EMBED'));
  const substitutePaint = await renderPdfPage(substitute, 2);
  const embeddedPaint = await renderPdfPage(embedded, 2);
  detail.substituteInk = ink(substitutePaint.ctx, substitutePaint.width, substitutePaint.height);
  detail.embeddedInk = ink(embeddedPaint.ctx, embeddedPaint.width, embeddedPaint.height);
  const substitutePixels = Buffer.from(substitutePaint.ctx.getImageData(0, 0, Math.ceil(substitutePaint.width), Math.ceil(substitutePaint.height)).data);
  const embeddedPixels = Buffer.from(embeddedPaint.ctx.getImageData(0, 0, Math.ceil(embeddedPaint.width), Math.ceil(embeddedPaint.height)).data);
  detail.sameRaster = substitutePixels.equals(embeddedPixels);
  assert.ok(detail.substituteInk > 20);
  assert.ok(detail.embeddedInk > 20);
  assert.equal(detail.sameRaster, false, 'an embedded font program must not paint the same raster as the Courier substitute');
});

await check('F-07', 'development server serves pdf.js assets from the local package', async detail => {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: path.resolve(process.cwd(), 'apps/desktop/vite.renderer.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen();
    const origin = server.resolvedUrls?.local?.[0];
    assert.ok(origin, 'vite did not report a local url');
    detail.origin = origin;
    const samples = ['cmaps/78-EUC-H.bcmap', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/jbig2.wasm'];
    detail.samples = [];
    for (const sample of samples) {
      const expected = fs.readFileSync(path.resolve('node_modules/pdfjs-dist', sample));
      const response = await fetch(new URL(`/pdfjs/${sample}`, origin));
      const got = Buffer.from(await response.arrayBuffer());
      const host = new URL(response.url).hostname;
      detail.samples.push({ sample, status: response.status, bytes: got.length, host });
      assert.equal(response.status, 200, sample);
      assert.ok(got.equals(expected), `${sample} bytes differ from the local pdfjs-dist package`);
      assert.ok(host === '127.0.0.1' || host === 'localhost', sample);
    }
    const escaped = await fetch(new URL('/pdfjs/../package.json', origin));
    const escapedBody = Buffer.from(await escaped.arrayBuffer());
    detail.traversalStatus = escaped.status;
    const outside = [fs.readFileSync('package.json'), fs.readFileSync('apps/desktop/package.json')];
    assert.ok(outside.every(file => !escapedBody.equals(file)), 'pdfjs route must not serve files outside the package');
    assert.equal(fs.existsSync('packages/app-core/src/domain/pdf-text.ts'), false);
  } finally { await server.close(); }
});

await check('F-07', 'old revision ambiguity stays needs review and a missing original keeps the note', async detail => {
  const bytes = pdf('BT /F1 20 Tf 24 TL 1 0 0 1 50 320 Tm (REPEAT) Tj T* (UNIQUE) Tj T* (REPEAT) Tj ET');
  const parsed = await parsePdfBytes(bytes);
  const text = parsed.parts[0]?.normalized ?? '';
  const ctx = await startApp();
  try {
    const book = await call(ctx, 'library.importDocument', { title: '旧表示', format: 'pdf', bytes: [...bytes] });
    const revisionBefore = book.revisionId;
    const second = occurrence(text, 'REPEAT', 2);
    const exact = await call(ctx, 'notes.create', { title: '第二次', text: 'REPEAT', resourceId: book.resourceId, resourceRevisionId: book.revisionId, locator: { kind: 'text', partId: 'page-1', representationId: book.revisionId, normalizationVersion: 'nfc-lf-codepoint-v1', range: second, quote: { exact: 'REPEAT' } } });
    const opened = await call(ctx, 'notes.openSource', { objectId: exact.objectId, blockId: 'quote' });
    assert.equal(opened.status, 'resolved');
    assert.deepEqual(opened.codePointRange, second);
    const ambiguous = await call(ctx, 'notes.create', { title: '旧歧义', text: 'REPEAT', resourceId: book.resourceId, resourceRevisionId: book.revisionId, locator: { kind: 'text', partId: 'page-1', representationId: book.revisionId, normalizationVersion: 'nfc-lf-codepoint-v1', range: { start: 0, end: 3 }, quote: { exact: 'REPEAT' } } });
    const review = await call(ctx, 'notes.openSource', { objectId: ambiguous.objectId, blockId: 'quote' });
    detail.reviewStatus = review.status;
    assert.equal(review.status, 'needs_review');
    const location = ctx.app.store.sqlite.prepare('SELECT relative_path FROM file_locations WHERE resource_revision_id = ?').get(book.revisionId);
    fs.rmSync(location.relative_path);
    const original = await call(ctx, 'library.readOriginal', { resourceId: book.resourceId, revisionId: book.revisionId });
    detail.originalAvailable = original.available;
    assert.equal(original.available, false);
    const note = await call(ctx, 'notes.get', { objectId: exact.objectId });
    assert.ok(JSON.stringify(note).includes('REPEAT'));
    const read = await call(ctx, 'library.read', { resourceId: book.resourceId, revisionId: book.revisionId });
    assert.ok(String(read.slice?.text ?? '').includes('REPEAT'));
    assert.equal(read.revisionId, revisionBefore);
    detail.revisionId = read.revisionId;
  } finally { ctx.app.close(); }
});

await check('F-07', 'pdf parse cancel disable and release stay on the current generation', async detail => {
  const { buildPdfFixture } = await import('../../../../packages/app-core/src/domain/formats.ts');
  const bytes = buildPdfFixture([{ text: '取消样本' }]);
  await assert.rejects(() => parsePdfDocument(bytes, { signal: AbortSignal.abort() }), (error) => error?.code === 'CANCELLED');
  const ctx = await startApp();
  try {
    const generation = () => ctx.app.parseGeneration;
    const before = generation();
    await ctx.app.runtime.applyProfile({ profileId: 'm1a', revision: 2, enabledFeatures: ['settings'], disabledFeatures: ['library', 'notes', 'inventory', 'agent'], preferredProviders: {} });
    detail.generationBefore = before;
    detail.generationAfterDisable = generation();
    assert.ok(detail.generationAfterDisable > before);
    const refused = await ctx.app.call(ctx.actor, { commandId: 'library.importDocument', idempotencyKey: crypto.randomUUID(), input: { title: '停用期间', format: 'pdf', bytes: [...bytes] } }, ctx.grant.handle);
    assert.equal(refused.status, 'error');
    assert.equal(refused.error?.code, 'CAPABILITY_UNAVAILABLE');
    await ctx.app.runtime.applyProfile({ profileId: 'm1a', revision: 3, enabledFeatures: ['library', 'notes', 'settings', 'inventory', 'agent'], disabledFeatures: [], preferredProviders: {} });
    const imported = await call(ctx, 'library.importDocument', { title: '重新启用', format: 'pdf', bytes: [...bytes] });
    const read = await call(ctx, 'library.read', { resourceId: imported.resourceId });
    assert.ok(String(read.slice?.text ?? '').includes('取消样本'));
    detail.reread = true;
  } finally { ctx.app.close(); }
});

const { buildPdfFixture } = await import('../../../../packages/app-core/src/domain/formats.ts');
let seed;
let books = {};
if (!nodeOnly) {
  seed = await startApp();
  try {
    await call(seed, 'settings.skipAi', {});
    for (const [name, bytes] of Object.entries({
      single: pdf('BT /F1 20 Tf 1 0 0 1 50 320 Tm (FIRST LINE) Tj ET'),
      multiline: pdf('BT /F1 20 Tf 24 TL 1 0 0 1 50 320 Tm (FIRST LINE) Tj T* (SECOND LINE) Tj T* (THIRD LINE) Tj ET'),
      repeated: pdf('BT /F1 20 Tf 24 TL 1 0 0 1 50 320 Tm (REPEAT) Tj T* (REPEAT) Tj ET'),
      paged: pdfPages(['BT /F1 20 Tf 1 0 0 1 50 320 Tm (FIRST LINE) Tj ET', 'BT /F1 20 Tf 1 0 0 1 50 320 Tm (PAGE TWO) Tj ET']),
      unicode: Buffer.from(buildPdfFixture([{ lines: ['中文 😀 e\u0301'] }])),
      eol: Buffer.from(buildPdfFixture([{ lines: ['甲行', '乙行'] }])),
      standardScan: fs.readFileSync(path.join(dir, '../a-b9-rework-review/standard-scan.pdf')),
      scan: buildPdfFixture([{ text: 'SCAN CONTROL' }, { scan: true }, {}]),
    })) {
      fs.writeFileSync(path.join(dir, `${name}.pdf`), bytes);
      books[name] = await call(seed, 'library.importDocument', { title: name, format: 'pdf', bytes: [...bytes] });
    }
  } finally { seed.app.close(); }
}

async function geometry(page, units, originX) {
  return page.getByTestId('reading-pdf-text').evaluate((layer, input) => {
    const span = layer.querySelector('span');
    const box = span.getBoundingClientRect();
    const canvas = layer.parentElement.querySelector('canvas').getBoundingClientRect();
    const scale = canvas.width / 400;
    return {
      fontSize: getComputedStyle(span).fontSize,
      transform: getComputedStyle(span).transform,
      canvasWidth: canvas.width,
      actualWidth: box.width,
      expectedWidth: input.units * scale,
      actualLeft: box.left,
      expectedLeft: canvas.left + input.originX * scale,
      scale,
    };
  }, { units, originX });
}
function assertHit(detail) {
  assert.ok(Number.isFinite(detail.expectedWidth));
  assert.ok(Math.abs(detail.actualWidth - detail.expectedWidth) < 2, `text width ${detail.actualWidth} != ${detail.expectedWidth}`);
  assert.ok(Math.abs(detail.actualLeft - detail.expectedLeft) < 4, `text origin ${detail.actualLeft} != ${detail.expectedLeft}`);
}
async function currentSession(page) {
  const button = page.locator('[data-testid^="session-open-"][data-current="true"]');
  return { id: await button.getAttribute('data-testid'), title: await button.textContent() };
}
async function dragText(page) {
  await page.locator('[data-testid="reading-pdf-text"] span').first().scrollIntoViewIfNeeded();
  const boxes = await page.locator('[data-testid="reading-pdf-text"] span').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { text: node.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  assert.ok(first && last && first.width > 1 && last.width > 1, 'text spans have no hit area');
  await page.mouse.move(first.x + 1, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + Math.max(last.width - 2, 1), last.y + last.height / 2, { steps: 24 });
  await page.mouse.up();
  return boxes;
}
async function installLateOriginal(app, resourceId, mode) {
  await app.evaluate(({ ipcMain }, input) => {
    const original = ipcMain._invokeHandlers.get('manga:command');
    globalThis.reviewOriginalHandler = original;
    globalThis.reviewOriginalPending = false;
    ipcMain.removeHandler('manga:command');
    ipcMain.handle('manga:command', async (event, payload) => {
      if (payload.commandId === 'library.readOriginal' && payload.input.resourceId === input.resourceId) {
        globalThis.reviewOriginalPending = true;
        await new Promise(resolve => { globalThis.releaseReviewOriginal = resolve; });
        if (input.mode === 'error') return { status: 'error', error: { code: 'NOT_FOUND', message: 'late original failure' } };
      }
      return original(event, payload);
    });
  }, { resourceId, mode });
}
async function restoreCommand(app) {
  await app.evaluate(({ ipcMain }) => {
    globalThis.releaseReviewOriginal?.();
    ipcMain.removeHandler('manga:command');
    ipcMain.handle('manga:command', globalThis.reviewOriginalHandler);
  });
}

if (!nodeOnly) {
  const env = { ...process.env, MANGA_CHANNEL: 'test', MANGA_PROFILE_ROOT: seed.profileRoot, MANGA_DOCUMENTS_DIR: path.join(seed.profileRoot, 'documents'), MANGA_POINTER_FILE: path.join(seed.profileRoot, 'launcher/pointer.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: path.join(desktopPackageDir, 'MANGA-win32-x64/MANGA.exe'), env });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await app.evaluate(({ session }) => {
      globalThis.reviewNetworkRequests = [];
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        globalThis.reviewNetworkRequests.push({ scheme: new URL(details.url).protocol, type: details.resourceType });
        callback({ cancel: true });
      });
    });
    await page.getByTestId('nav-reading').waitFor();
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1280, 840); w.webContents.setZoomFactor(1); });
    await page.getByTestId('nav-reading').click();
    for (const name of ['single', 'multiline']) await check('F-07', `packaged ${name} excerpt and source highlight`, async detail => {
      await page.getByTestId(`open-${books[name].resourceId}`).click();
      await page.waitForFunction(text => document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes(text), name === 'single' ? 'FIRST LINE' : 'THIRD LINE');
      detail.layer = await page.getByTestId('reading-pdf-text').innerText();
      detail.selection = await page.evaluate((name) => {
        const layer = document.querySelector('[data-testid="reading-pdf-text"]');
        const spans = [...layer.querySelectorAll('span')];
        const span = spans.find(s => s.textContent === (name === 'single' ? 'FIRST LINE' : 'SECOND LINE'));
        const range = document.createRange();
        range.selectNodeContents(span);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        const prefix = range.cloneRange();
        prefix.selectNodeContents(layer);
        prefix.setEnd(range.startContainer, range.startOffset);
        return { quote: range.toString(), prefix: prefix.toString(), html: layer.innerHTML };
      }, name);
      await page.getByTestId('reading-note').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="nav-notes"]')?.getAttribute('aria-current') === 'page' || !!document.querySelector('[data-testid="note-title"]'));
      detail.saved = await page.evaluate(async () => window.manga.command({ commandId: 'notes.list', input: {}, idempotencyKey: crypto.randomUUID() }));
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(dir, `${name}-note.png`), Buffer.from(png, 'base64'));
      await page.getByTestId('note-block-source-quote').click();
      await page.waitForFunction(() => !!document.querySelector('.textLayer .reading-quote-hit'));
      detail.highlights = await page.locator('.textLayer .reading-quote-hit').allTextContents();
      detail.sourceStatus = await page.getByTestId('reading-source-card').getAttribute('data-source-status');
      await page.getByTestId('reading-source-back').click();
      await page.getByTestId('note-title').waitFor();
      detail.returnedToNote = true;
      await page.getByTestId('nav-reading').click();
      assert.deepEqual(detail.highlights, [name === 'single' ? 'FIRST LINE' : 'SECOND LINE'], 'source highlight must mark only the quoted line');
    });
    await check('F-07', 'text-layer hit area follows Canvas glyph scale', async detail => {
      await page.getByTestId(`open-${books.single.resourceId}`).click();
      await page.waitForFunction(() => {
        const span = document.querySelector('[data-testid="reading-pdf-text"] span');
        return span?.textContent === 'FIRST LINE' && span.getBoundingClientRect().width > 50;
      });
      detail.geometry = await geometry(page, 120, 50);
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(dir, 'text-layer-geometry.png'), Buffer.from(png, 'base64'));
      assertHit(detail.geometry);
    });
    async function markStale() {
      await page.evaluate(() => document.querySelector('[data-testid="reading-pdf-text"] .textLayer')?.setAttribute('data-stale', ''));
    }
    async function waitForGlyph(text) {
      await page.waitForFunction(expected => {
        const span = document.querySelector('[data-testid="reading-pdf-text"] .textLayer:not([data-stale]) span');
        return span?.textContent === expected && span.getBoundingClientRect().width > 20;
      }, text);
    }
    await check('F-07', 'zoom and the next page keep the text-layer hit area', async detail => {
      await page.getByTestId(`open-${books.single.resourceId}`).click();
      await waitForGlyph('FIRST LINE');
      const before = await page.getByTestId('reading-pdf-canvas').evaluate(canvas => canvas.getBoundingClientRect().width);
      const epoch = await page.getByTestId('reading-page-render').getAttribute('data-pdf-epoch');
      await page.getByTestId('reading-zoom-in').click();
      await page.waitForFunction(previous => {
        const span = document.querySelector('[data-testid="reading-pdf-text"] span');
        const nextEpoch = document.querySelector('[data-testid="reading-page-render"]')?.getAttribute('data-pdf-epoch');
        return nextEpoch !== previous && span?.textContent === 'FIRST LINE' && span.getBoundingClientRect().width > 20;
      }, epoch);
      detail.zoomed = await geometry(page, 120, 50);
      detail.zoomed.canvasGrew = detail.zoomed.canvasWidth > before + 8;
      assert.equal(detail.zoomed.canvasGrew, true);
      assertHit(detail.zoomed);
      await markStale();
      await page.getByTestId(`open-${books.paged.resourceId}`).click();
      await waitForGlyph('FIRST LINE');
      detail.pageOne = await geometry(page, 120, 50);
      assertHit(detail.pageOne);
      await markStale();
      await page.getByTestId('reading-next').click();
      await waitForGlyph('PAGE TWO');
      detail.pageTwo = await geometry(page, 96, 50);
      assertHit(detail.pageTwo);
    });
    for (const name of ['multiline', 'repeated']) await check('F-07', `new PDF ${name} selection has a usable locator`, async detail => {
      await page.getByTestId(`open-${books[name].resourceId}`).click();
      await page.waitForFunction(text => document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes(text), name === 'repeated' ? 'REPEAT' : 'THIRD LINE');
      detail.selection = await page.evaluate(name => {
        const layer = document.querySelector('[data-testid="reading-pdf-text"]');
        const spans = [...layer.querySelectorAll('span')];
        const range = document.createRange();
        if (name === 'multiline') { range.setStart(spans[0].firstChild, 0); range.setEnd(spans[1].firstChild, spans[1].textContent.length); }
        else range.selectNodeContents(spans[1]);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return { quote: range.toString(), innerText: layer.innerText };
      }, name);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      detail.enabled = await page.getByTestId('reading-note').isEnabled();
      assert.equal(detail.enabled, true, 'a selection in the current representation must map even across EOL or repeated quotes');
    });
    await check('F-07', 'mouse drag selects a line with Chinese, emoji, NFC and spaces', async detail => {
      await page.getByTestId(`open-${books.unicode.resourceId}`).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes('中文'));
      detail.boxes = await dragText(page);
      await page.waitForFunction(() => !document.querySelector('[data-testid="reading-note"]').disabled);
      detail.selected = await page.getByTestId('reading-selected').textContent();
      assert.ok(detail.selected.includes('中文'));
      assert.ok(detail.selected.includes('😀'));
      assert.ok(detail.selected.includes('é'));
      assert.ok(detail.selected.includes(' '));
      assert.ok(!detail.selected.includes('\u0301'));
      await page.getByTestId('reading-note').click();
      await page.getByTestId('note-block-source-quote').waitFor();
      await page.getByTestId('note-block-source-quote').click();
      await page.waitForFunction(() => !!document.querySelector('.textLayer .reading-quote-hit'));
      detail.highlights = await page.locator('.textLayer .reading-quote-hit').allTextContents();
      const highlighted = detail.highlights.join('').normalize('NFC');
      assert.ok(highlighted.includes('中文'));
      assert.ok(highlighted.includes('é'));
      await page.getByTestId('reading-source-back').click();
      await page.getByTestId('note-title').waitFor();
      detail.returnedToNote = true;
    });
    await check('F-07', 'mouse drag across lines keeps the end-of-line in the quote', async detail => {
      await page.getByTestId('nav-reading').click();
      await page.getByTestId(`open-${books.eol.resourceId}`).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes('乙行'));
      detail.boxes = await dragText(page);
      await page.waitForFunction(() => !document.querySelector('[data-testid="reading-note"]').disabled);
      detail.selected = await page.getByTestId('reading-selected').textContent();
      assert.ok(detail.selected.includes('甲行') && detail.selected.includes('乙行'));
      await page.getByTestId('reading-note').click();
      detail.saved = await page.evaluate(async () => window.manga.command({ commandId: 'notes.list', input: {}, idempotencyKey: crypto.randomUUID() }));
      const saved = JSON.stringify(detail.saved);
      assert.ok(saved.includes('甲行\\n乙行'), 'the stored quote must keep the end-of-line code point');
      await page.getByTestId('note-block-source-quote').click();
      await page.waitForFunction(() => document.querySelectorAll('.textLayer .reading-quote-hit').length >= 2);
      detail.highlights = await page.locator('.textLayer .reading-quote-hit').allTextContents();
      assert.deepEqual(detail.highlights, ['甲行', '乙行']);
      await page.getByTestId('reading-source-back').click();
      await page.getByTestId('note-title').waitFor();
      detail.returnedToNote = true;
    });
    await check('F-07', 'scan page paints nonblank Canvas and has no selectable text', async detail => {
      await page.getByTestId('nav-reading').click();
      await page.getByTestId(`open-${books.standardScan.resourceId}`).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="reading-scan"]'));
      detail.canvas = await page.getByTestId('reading-pdf-canvas').evaluate(canvas => {
        const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let dark = 0;
        for (let i = 0; i < bytes.length; i += 4) if (bytes[i] < 100 && bytes[i + 1] < 100 && bytes[i + 2] < 100) dark++;
        return { width: canvas.width, height: canvas.height, dark };
      });
      detail.layer = await page.getByTestId('reading-pdf-text').innerText();
      assert.ok(detail.canvas.dark > 20);
      assert.equal(detail.layer, '');
    });
    await check('F-07', 'late original bytes cannot replace the current book', async detail => {
      await installLateOriginal(app, books.single.resourceId, 'success');
      try {
        await page.getByTestId(`open-${books.single.resourceId}`).click();
        for (let i = 0; i < 100; i++) {
          if (await app.evaluate(() => globalThis.reviewOriginalPending)) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(await app.evaluate(() => globalThis.reviewOriginalPending), true, 'delayed readOriginal was not reached');
        await page.getByTestId(`open-${books.repeated.resourceId}`).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes('REPEAT'));
        detail.sessionBefore = await currentSession(page);
        detail.before = await page.getByTestId('reading-pdf-text').innerText();
        await app.evaluate(() => globalThis.releaseReviewOriginal());
        await page.waitForFunction(() => document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes('FIRST LINE'), null, { timeout: 3000 }).catch(() => {});
        detail.after = await page.getByTestId('reading-pdf-text').innerText();
        detail.sessionAfter = await currentSession(page);
        detail.activeTitle = await page.locator('[data-testid="reading-title"]').textContent().catch(() => null);
        assert.ok(detail.after.includes('REPEAT'), 'late bytes from the prior book were rendered under the current book');
        assert.equal(detail.sessionAfter.id, detail.sessionBefore.id);
      } finally { await restoreCommand(app); }
    });
    await check('F-07', 'late original failure cannot clear the current book or its session', async detail => {
      await page.getByTestId(`open-${books.repeated.resourceId}`).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes('REPEAT'));
      detail.sessionBefore = await currentSession(page);
      const epoch = await page.getByTestId('reading-page-render').getAttribute('data-pdf-epoch');
      await installLateOriginal(app, books.single.resourceId, 'error');
      try {
        await page.getByTestId(`open-${books.single.resourceId}`).click();
        for (let i = 0; i < 100; i++) {
          if (await app.evaluate(() => globalThis.reviewOriginalPending)) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(await app.evaluate(() => globalThis.reviewOriginalPending), true, 'delayed readOriginal failure was not reached');
        await page.getByTestId(`open-${books.repeated.resourceId}`).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes('REPEAT'));
        detail.sessionBeforeRelease = await currentSession(page);
        await app.evaluate(() => globalThis.releaseReviewOriginal());
        await page.waitForTimeout(400);
        detail.after = await page.getByTestId('reading-pdf-text').innerText();
        detail.canvasWidth = await page.getByTestId('reading-pdf-canvas').evaluate(canvas => canvas.width);
        detail.sessionAfter = await currentSession(page);
        detail.epoch = await page.getByTestId('reading-page-render').getAttribute('data-pdf-epoch');
        assert.ok(detail.after.includes('REPEAT'));
        assert.ok(detail.canvasWidth > 0);
        assert.equal(detail.sessionAfter.id, detail.sessionBeforeRelease.id);
        assert.notEqual(detail.epoch, null);
        assert.ok(epoch !== undefined);
      } finally { await restoreCommand(app); }
    });
    await check('F-07', 'packaged PDF runs without HTTP or HTTPS', async detail => {
      const packaged = path.join(desktopPackageDir, 'MANGA-win32-x64/resources/pdfjs/cmaps/78-EUC-H.bcmap');
      const local = fs.readFileSync('node_modules/pdfjs-dist/cmaps/78-EUC-H.bcmap');
      detail.packagedAsset = fs.existsSync(packaged) && fs.readFileSync(packaged).equals(local);
      detail.blockedRequests = await app.evaluate(() => globalThis.reviewNetworkRequests);
      assert.equal(detail.packagedAsset, true);
      assert.equal(fs.existsSync('packages/app-core/src/domain/pdf-text.ts'), false);
      assert.deepEqual(detail.blockedRequests, []);
    });
  } finally { await app.close(); }

  const reopened = await startApp({ profileRoot: seed.profileRoot });
  try {
    await check('F-07', 'persisted PDF excerpts equal the selected quotes', async detail => {
      detail.objects = reopened.app.store.sqlite.prepare('SELECT id,payload_json FROM content_objects').all().map(row => ({ id: row.id, payload: JSON.parse(row.payload_json) }));
      detail.anchors = reopened.app.store.sqlite.prepare('SELECT * FROM anchors').all();
      detail.sources = [];
      for (const object of detail.objects) {
        const source = await call(reopened, 'notes.openSource', { objectId: object.id, blockId: 'quote' });
        detail.sources.push({ status: source.status, cardStatus: source.card?.status, quote: source.card?.quote });
        assert.equal(source.status, 'resolved');
        assert.equal(source.card?.status, 'resolved');
      }
      const all = JSON.stringify(detail.objects);
      assert.ok(all.includes('SECOND LINE'), 'second-line excerpt missing');
      assert.ok(!all.includes('\\nSECOND LIN'), 'second-line quote shifted by the missing EOL');
      assert.ok(all.includes('中文'));
      assert.ok(all.includes('é'));
      assert.ok(!all.includes('\u0301'));
      assert.ok(all.includes('甲行\\n乙行'));
    });
  } finally { reopened.app.close(); }
}

if (!nodeOnly) {
  const names = new Set(observations.map(row => row.name));
  for (const name of requiredPdfCounterexamples) {
    if (!names.has(name)) observations.push({ finding: 'F-07', name, status: 'failed', actual: 'observation was not recorded' });
  }
}
const report = {
  at: new Date().toISOString(),
  ...m1bFingerprints(process.cwd()),
  scriptFingerprint: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  status: observations.every(o => o.status === 'passed') ? 'passed' : 'rework-required',
  productAcceptance: 'not-run',
  humanChecks: 'not-run',
  observations,
};
fs.writeFileSync(path.join(dir, 'a-pdfjs-review.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, observations: observations.map(o => ({ name: o.name, status: o.status, actual: o.actual })) }, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
