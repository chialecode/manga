import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startApp, tempProfile } from '../tests/m1b/helpers.ts';
import { parsePdfBytes, buildEpubFixture } from '../packages/app-core/src/domain/formats.ts';
import { exportLibraryPackage, importLibraryPackageResolved } from '../packages/app-core/src/domain/library-package.ts';
import { m1bFingerprints } from '../scripts/m1b-fingerprint.mjs';
import { repoRoot, desktopPackageDir, latestDesktopPackage } from '../scripts/desktop-paths.ts';
import { _electron as electron } from 'playwright-core';

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? 'docs/evidence/m1b-reading-notes/a-b8-review');
fs.mkdirSync(evidence, {recursive:true});
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
// Identity-H makes character codes equal CIDs; ToUnicode independently supplies A/B/C.
// This avoids relying on a predefined CMap's Unicode-to-CID mapping when checking /W.
const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0041> <0043> <0041> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end';
const cmapStream = `<< /Length ${Buffer.byteLength(cmap,'ascii')} >>\nstream\n${cmap}\nendstream`;
const cidFont = '<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H /ToUnicode 7 0 R /DescendantFonts [6 0 R] >>';
const fixtures = [
  ['indirect-simple-widths', pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm (AB) Tj (C) Tj ET', '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding /FirstChar 65 /LastChar 67 /Widths 6 0 R >>', ['[278 556 444]']), 12.78, 'ABC'],
  ['cid-array-widths', pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm <00410042> Tj <0043> Tj ET', cidFont, ['<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [65 [278 556 444]] >>', cmapStream]), null, 'ABC'],
  ['cid-range-widths', pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm <00410042> Tj <0043> Tj ET', cidFont, ['<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [65 67 500] >>', cmapStream]), null, 'ABC'],
  ['half-scale-text', pdf('BT /F1 20 Tf 50 Tz 1 0 0 1 50 320 Tm (HELLO) Tj (WORLD) Tj ET'), 60, 'HELLOWORLD'],
];
for (const [name, bytes, expectedWidth, text] of fixtures) {
  fs.writeFileSync(path.join(evidence, `${name}.pdf`), bytes);
  await check('F-07', name, async detail => {
    const part = (await parsePdfBytes(bytes)).parts[0];
    const runs = part.textRuns ?? [];
    const width = runs.reduce((sum, run) => sum + (run.width ?? 0), 0);
    detail.normalized = part.normalized;
    detail.runs = runs;
    detail.width = width;
    assert.equal(part.id, 'page-1');
    assert.equal(part.normalized, text);
    assert.equal(part.render, undefined, 'pdf text is no longer an SVG operator list');
    if (expectedWidth == null) assert.ok(width > 0, `${name} recorded no advance`);
    else assert.ok(Math.abs(width - expectedWidth) < 0.05, `expected width ${expectedWidth}, actual ${width}`);
  });
}
for (const variant of ['implicit-revision-copy', 'explicit-revision-replace', 'copied-object-replaced-ref', 'duplicate-with-skipped-revision', 'local-anchor-outside-package', 'duplicated-anchor-original-survives', 'copied-object-skipped-ref']) {
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
      if (variant === 'implicit-revision-copy' || variant === 'copied-object-replaced-ref') decisions.pop();
      if (variant === 'implicit-revision-copy' || variant === 'explicit-revision-replace') decisions.push({kind:'object',id:note.objectId,action:'skip'});
      if (variant === 'copied-object-replaced-ref') decisions.push({kind:'object',id:note.objectId,action:'duplicate'});
      if (variant === 'duplicate-with-skipped-revision') decisions.splice(0,decisions.length,{kind:'resource_revision',id:book.revisionId,action:'skip'});
      if (variant === 'duplicated-anchor-original-survives') decisions.push({kind:'object',id:note.objectId,action:'skip'},{kind:'anchor',id:manifest.anchors[0].id,action:'duplicate'});
      if (variant === 'copied-object-skipped-ref') decisions.push({kind:'object',id:note.objectId,action:'duplicate'},{kind:'ref',id:beforeRefs[0].id,action:'skip'});
      importLibraryPackageResolved(ctx.app.store, dir, {strategy:variant === 'duplicate-with-skipped-revision' ? 'duplicate' : 'replace',decisions});
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
      detail.bodyIndexMismatches = db.prepare('SELECT COUNT(*) AS n FROM text_fragments f JOIN resource_revisions v ON v.id=f.resource_revision_id WHERE f.object_id IS NULL AND f.resource_id<>v.resource_id').get().n;
      detail.noteChains = [];
      for (const object of db.prepare("SELECT id,payload_json FROM content_objects WHERE type='notes.document'").all()) {
        const blocks = JSON.parse(object.payload_json).blocks.filter(block=>block.anchorId);
        const sources = await call(ctx,'notes.openSource',{objectId:object.id});
        const chain = blocks.map(block=>{
          const anchor = db.prepare('SELECT * FROM anchors WHERE id=?').get(block.anchorId);
          const revision = db.prepare('SELECT resource_id FROM resource_revisions WHERE id=?').get(anchor.resource_revision_id);
          const ref = db.prepare("SELECT to_id FROM refs WHERE from_object_id=? AND from_block_id=? AND to_kind='anchor'").get(object.id,block.id);
          const indices = db.prepare('SELECT resource_id FROM text_fragments WHERE object_id=?').all(object.id);
          const historyRows = db.prepare('SELECT payload_json FROM object_revisions WHERE object_id=?').all(object.id);
          return {ownerPairAgrees:anchor.resource_id===revision?.resource_id,locatorRevisionAgrees:JSON.parse(anchor.locator_json).representationId===anchor.resource_revision_id,refAgrees:ref?.to_id===anchor.id,indexAgrees:indices.length>0 && indices.every(row=>row.resource_id===anchor.resource_id),historyAgrees:historyRows.length>0 && historyRows.every(row=>JSON.parse(row.payload_json).blocks.filter(b=>b.anchorId).every(b=>Boolean(db.prepare('SELECT id FROM anchors WHERE id=?').get(b.anchorId)))),sourceAgrees:sources.status==='resolved' && sources.card?.status==='resolved' && sources.resourceId===anchor.resource_id};
        });
        detail.noteChains.push({original:object.id===note.objectId,blocks:chain});
      }
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
      assert.equal(detail.bodyIndexMismatches,0);
      for (const note of detail.noteChains) for (const block of note.blocks) assert.ok(Object.values(block).every(Boolean),'resource/revision/locator/ref/index/history/source chain must agree');
    } finally { ctx.app.close(); }
  });
}

await check('F-09','conflicting pins reject without changing content',async detail=>{
  const ctx=await startApp();
  try {
    const book=await call(ctx,'library.importDocument',{title:'冲突来源',format:'txt',bytes:[...new TextEncoder().encode('冲突正文。')]});
    const notes=[];
    for(const title of ['甲','乙']) notes.push(await call(ctx,'notes.create',{title,text:'合成评论',resourceId:book.resourceId,resourceRevisionId:book.revisionId,locator:{kind:'text',partId:'body',representationId:book.revisionId,normalizationVersion:'nfc-lf-codepoint-v1',range:{start:0,end:4},quote:{exact:'冲突正文'}}}));
    const dir=tempProfile(); exportLibraryPackage(ctx.app.store,dir);
    const db=ctx.app.store.sqlite;
    db.prepare("UPDATE anchors SET resource_id='res_diverged' WHERE id=(SELECT to_id FROM refs WHERE from_object_id=?)").run(notes[1].objectId);
    const snapshot=()=>JSON.stringify(['resources','resource_revisions','anchors','refs','content_objects','object_revisions','text_fragments'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const before=snapshot(); let error;
    try { importLibraryPackageResolved(ctx.app.store,dir,{strategy:'replace',decisions:[...notes.map(note=>({kind:'object',id:note.objectId,action:'skip'})),{kind:'resource_revision',id:book.revisionId,action:'replace'}]}); }
    catch(thrown){error=thrown;}
    detail.errorCode=error?.code; detail.contentUnchanged=snapshot()===before;
    assert.equal(detail.errorCode,'PUBLISH_CONFLICT'); assert.equal(detail.contentUnchanged,true);
  } finally {ctx.app.close();}
});

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
      if (name === 'half-scale') await page.waitForFunction(() => document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.replace(/\s+/g, '') === 'HELLOWORLD');
      await page.getByTestId('reading-page-render').scrollIntoViewIfNeeded();
      await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
      const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(evidence,`${name}-independent.png`),Buffer.from(png,'base64'));
      if(name==='half-scale') {
        detail.layer = (await page.getByTestId('reading-pdf-text').innerText()).replace(/\s+/g, '');
        detail.ink = await page.getByTestId('reading-pdf-canvas').evaluate((canvas) => {
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let dark = 0;
          for (let index = 0; index < data.length; index += 16) if (data[index] < 40 && data[index + 1] < 40 && data[index + 2] < 40) dark += 1;
          return dark;
        });
        assert.equal(detail.layer, 'HELLOWORLD');
        assert.ok(detail.ink > 10, '50 Tz left the canvas without painted glyphs');
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
