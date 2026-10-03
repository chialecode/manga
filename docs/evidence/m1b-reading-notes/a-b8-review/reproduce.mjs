import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startApp, tempProfile } from '../../../../tests/m1b/helpers.ts';
import { parsePdfBytes, buildEpubFixture } from '../../../../packages/app-core/src/domain/formats.ts';
import { exportLibraryPackage, importLibraryPackageResolved } from '../../../../packages/app-core/src/domain/library-package.ts';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
import { repoRoot, desktopPackageDir, latestDesktopPackage } from '../../../../scripts/desktop-paths.ts';
import { _electron as electron } from 'playwright-core';

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? 'docs/evidence/m1b-reading-notes/a-b8-review');
const observations = [];
async function check(finding, name, run) {
  const detail = {};
  try { await run(detail); observations.push({ finding, name, status: 'passed', detail }); }
  catch (error) { observations.push({ finding, name, status: 'failed', actual: error.message, detail }); }
}
async function call(ctx, commandId, input) {
  const result = await ctx.app.call(ctx.actor, {commandId, input, idempotencyKey: crypto.randomUUID()}, ctx.grant.handle);
  assert.equal(result.status, 'ok', result.error?.message);
  return result.value;
}
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
const fixtures = [
  ['indirect-simple-widths', pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm (AB) Tj (C) Tj ET', '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding /FirstChar 65 /LastChar 67 /Widths 6 0 R >>', ['[278 556 444]']), 58.34, 'ABC'],
  ['cid-array-widths', pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm <00410042> Tj <0043> Tj ET', '<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>', ['<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [65 [278 556 444]] >>']), 58.34, 'ABC'],
  ['cid-range-widths', pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm <00410042> Tj <0043> Tj ET', '<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>', ['<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [65 67 500] >>']), 60, 'ABC'],
  ['half-scale-text', pdf('BT /F1 20 Tf 50 Tz 1 0 0 1 50 320 Tm (HELLO) Tj (WORLD) Tj ET'), 80, 'HELLOWORLD'],
];
for (const [name, bytes, expectedX, text] of fixtures) {
  fs.writeFileSync(path.join(evidence, `${name}.pdf`), bytes);
  await check('F-07', name, detail => {
    const part = parsePdfBytes(bytes).parts[0];
    detail.normalized = part.normalized;
    detail.runs = part.render.items.filter(item => item.k === 't');
    detail.expectedSecondX = expectedX;
    assert.equal(part.id, 'page-1');
    assert.equal(part.normalized, text);
    assert.ok(Math.abs(detail.runs[1].x - expectedX) < 0.001, `expected second run x=${expectedX}, actual=${detail.runs[1].x}`);
  });
}
for (const variant of ['local-anchor-outside-package', 'duplicated-anchor-original-survives', 'copied-object-skipped-ref']) {
  await check('F-09', variant, async detail => {
    const ctx = await startApp();
    try {
      const book = await call(ctx, 'library.importDocument', {title:'合成来源',format:'txt',bytes:[...new TextEncoder().encode('甲乙丙丁。第二段文字。')]});
      const dir = tempProfile();
      if (variant === 'local-anchor-outside-package') exportLibraryPackage(ctx.app.store, dir);
      const note = await call(ctx, 'notes.create', {title:'合成本地笔记',text:'保留评论',resourceId:book.resourceId,resourceRevisionId:book.revisionId,locator:{kind:'text',partId:'body',representationId:book.revisionId,normalizationVersion:'nfc-lf-codepoint-v1',range:{start:0,end:4},quote:{exact:'甲乙丙丁'}}});
      const db = ctx.app.store.sqlite;
      const refs = () => db.prepare('SELECT * FROM refs WHERE from_object_id=? ORDER BY id').all(note.objectId);
      const history = () => db.prepare('SELECT * FROM object_revisions WHERE object_id=? ORDER BY revision').all(note.objectId);
      const beforeRefs = refs(), beforeHistory = history();
      const manifest = variant === 'local-anchor-outside-package' ? null : exportLibraryPackage(ctx.app.store, dir);
      const decisions = [{kind:'resource',id:book.resourceId,action:'duplicate'}, {kind:'resource_revision',id:book.revisionId,action:'replace'}];
      if (variant === 'duplicated-anchor-original-survives') decisions.push({kind:'object',id:note.objectId,action:'skip'},{kind:'anchor',id:manifest.anchors[0].id,action:'duplicate'});
      if (variant === 'copied-object-skipped-ref') decisions.push({kind:'object',id:note.objectId,action:'duplicate'},{kind:'ref',id:beforeRefs[0].id,action:'skip'});
      importLibraryPackageResolved(ctx.app.store, dir, {strategy:'replace',decisions});
      const opened = await call(ctx, 'notes.openSource', {objectId:note.objectId});
      const relation = db.prepare('SELECT a.resource_id AS anchorResource,v.resource_id AS revisionResource FROM anchors a JOIN resource_revisions v ON a.resource_revision_id=v.id WHERE a.id=?').get(beforeRefs[0].to_id);
      detail.decisions = decisions.map(({kind,action})=>({kind,action}));
      detail.packageContainsNote = Boolean(manifest);
      detail.originalRefsUnchanged = JSON.stringify(refs()) === JSON.stringify(beforeRefs);
      detail.originalHistoryUnchanged = JSON.stringify(history()) === JSON.stringify(beforeHistory);
      detail.revisionOwnerPreserved = relation.revisionResource === book.resourceId;
      detail.ownerPairAgrees = relation.anchorResource === relation.revisionResource;
      detail.topStatus = opened.status; detail.cardStatus = opened.card?.status;
      detail.topResourcePreserved = opened.resourceId === book.resourceId;
      detail.copies = [];
      for (const copy of db.prepare("SELECT id FROM content_objects WHERE type='notes.document' AND id<>?").all(note.objectId)) {
        const source = await call(ctx,'notes.openSource',{objectId:copy.id});
        const copyRefs = db.prepare("SELECT id FROM refs WHERE from_object_id=? AND to_kind='anchor'").all(copy.id);
        detail.copies.push({refCount:copyRefs.length,status:source.status,cardStatus:source.card?.status,historyCount:db.prepare('SELECT COUNT(*) AS n FROM object_revisions WHERE object_id=?').get(copy.id).n});
      }
      assert.ok(detail.originalRefsUnchanged && detail.originalHistoryUnchanged);
      assert.ok(detail.ownerPairAgrees && detail.revisionOwnerPreserved, 'a surviving local anchor lost its revision owner');
      assert.equal(detail.topResourcePreserved,true);
      assert.equal(opened.card?.status,'resolved');
      for (const copy of detail.copies) assert.ok(copy.refCount > 0 && copy.status === 'resolved' && copy.cardStatus === 'resolved' && copy.historyCount > 0, 'copied note must retain a public ref consistent with its source/history');
    } finally { ctx.app.close(); }
  });
}

const seed = await startApp();
let half, circle;
try {
  await call(seed,'settings.skipAi',{});
  half = await call(seed,'library.importDocument',{title:'缩放文本',format:'pdf',bytes:[...fixtures[3][1]]});
  const bytes = buildEpubFixture({title:'真实圆形',fixedLayout:true,chapters:[{id:'p1',title:'几何',html:'',svgBody:'<circle cx="200" cy="200" r="80" fill="red"/>'}]});
  fs.writeFileSync(path.join(evidence,'circle.epub'),bytes);
  circle = await call(seed,'library.importDocument',{title:'真实圆形',format:'epub',bytes:[...bytes]});
} finally { seed.app.close(); }
const env = {...process.env,MANGA_CHANNEL:'test',MANGA_PROFILE_ROOT:seed.profileRoot,MANGA_DOCUMENTS_DIR:path.join(seed.profileRoot,'documents'),MANGA_POINTER_FILE:path.join(seed.profileRoot,'launcher','pointer.json')};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({executablePath:path.join(desktopPackageDir,'MANGA-win32-x64/MANGA.exe'),env});
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  await page.getByTestId('nav-reading').waitFor();
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setContentSize(1600,900);win.webContents.setZoomFactor(1);});
  await page.getByTestId('nav-reading').click();
  for (const [name,book] of [['half-scale',half],['circle',circle]]) {
    await check('F-07',`packaged window ${name}`,async detail=>{
      await page.getByTestId(`open-${book.resourceId}`).click();
      await page.getByTestId('reading-page-render').waitFor();
      await page.getByTestId('reading-page-render').scrollIntoViewIfNeeded();
      await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
      const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(evidence,`${name}-independent.png`),Buffer.from(png,'base64'));
      if(name==='half-scale') {
        detail.runs=await page.locator('[data-testid="reading-page-render"] text').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {text:node.textContent,x:node.getAttribute('x'),left:r.left,right:r.right};}));
        assert.ok(detail.runs[1].left >= detail.runs[0].right - 1,'50 Tz advances the origin but leaves the visible glyphs full-width and overlapping');
      } else {
        detail.ellipses=await page.locator('[data-testid="reading-page-render"] ellipse').evaluateAll(nodes=>nodes.map(n=>({cx:n.getAttribute('cx'),rx:n.getAttribute('rx'),ry:n.getAttribute('ry'),fill:getComputedStyle(n).fill})));
        assert.deepEqual(detail.ellipses,[{cx:'200',rx:'80',ry:'80',fill:'rgb(255, 0, 0)'}]);
      }
    });
  }
} finally { await app.close(); }
const report={at:new Date().toISOString(),...m1bFingerprints(repoRoot),scriptFingerprint:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),package:JSON.parse(fs.readFileSync(latestDesktopPackage,'utf8')),status:observations.every(r=>r.status==='passed')?'passed':'rework-required',humanChecks:'not-run',productAcceptance:'not-run',observations};
fs.writeFileSync(path.join(evidence,'a-b8-independent-review.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.status!=='passed') process.exitCode=1;
