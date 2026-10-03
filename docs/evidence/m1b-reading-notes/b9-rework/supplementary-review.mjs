// Run from the repository root. All data is synthetic; the product package must match the source.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startApp, tempProfile } from '../../../../tests/m1b/helpers.ts';
import { parsePdfBytes } from '../../../../packages/app-core/src/domain/formats.ts';
import { exportLibraryPackage, importLibraryPackageResolved } from '../../../../packages/app-core/src/domain/library-package.ts';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
import { repoRoot, desktopPackageDir, latestDesktopPackage } from '../../../../scripts/desktop-paths.ts';
import { _electron as electron } from 'playwright-core';
const evidence=path.dirname(fileURLToPath(import.meta.url));
const observations=[];
async function check(finding,name,fn){ const detail={}; try {await fn(detail);observations.push({finding,name,status:'passed',detail});} catch(error){observations.push({finding,name,status:'failed',actual:error.message,detail});} }
async function call(ctx,commandId,input){const r=await ctx.app.call(ctx.actor,{commandId,input,idempotencyKey:crypto.randomUUID()},ctx.grant.handle);assert.equal(r.status,'ok',r.error?.message);return r.value;}
function pdf(content,font,extra=[]){
 const bodies=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(content,'ascii')} >>\nstream\n${content}\nendstream`,font??'<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',...extra];
 let s='%PDF-1.4\n';const offsets=[];bodies.forEach((b,i)=>{offsets.push(Buffer.byteLength(s,'ascii'));s+=`${i+1} 0 obj\n${b}\nendobj\n`;});const x=Buffer.byteLength(s,'ascii');s+=`xref\n0 ${bodies.length+1}\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer << /Size ${bodies.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(s,'ascii');
}
const font='<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding /FirstChar 65 /LastChar 67 /Widths [1000 100 100] >>';
const samples=[
 {name:'unequal-widths',bytes:pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm (ABC) Tj 1 0 0 1 50 280 Tm (A) Tj (B) Tj (C) Tj ET',font),expected:[50,60,61]},
 {name:'word-spacing',bytes:pdf('BT /F1 10 Tf 2 Tc 10 Tw 1 0 0 1 50 320 Tm (A A) Tj 1 0 0 1 50 280 Tm (A) Tj ( ) Tj (A) Tj ET'),expected:[50,58,76]},
];
const cmap='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0020> <0043> <0020> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end';
const cid='<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H /ToUnicode 7 0 R /DescendantFonts [6 0 R] >>';
for(const [name,widths,content,expected] of [
 ['zero-default-cid-width','/DW 0','<0041> Tj <0042> Tj',50],
 // Cross-check with installed PDF.js 6.3.289 also puts C at 75; do not assert the initially
 // suspected 65 as a proven defect without reconciling the engine/spec semantics.
 ['two-byte-space-Tw-control','/DW 500','10 Tw <004100200042> Tj <0043> Tj',75],
 ['indirect-mixed-cid-widths','/DW 750 /W 8 0 R','<0041004200430044> Tj <0041> Tj',73.34],
]) await check('F-07',name,detail=>{
 const bytes=pdf(`BT /F1 10 Tf 1 0 0 1 50 320 Tm ${content} ET`,cid,[`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ${widths} >>`,`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,'[65 [278 556] 67 67 750]']);
 fs.writeFileSync(path.join(evidence,`${name}.pdf`),bytes);
 const part=parsePdfBytes(bytes).parts[0];detail.runs=part.render.items.filter(i=>i.k==='t');detail.expectedSecondX=expected;detail.normalized=part.normalized;
 assert.ok(Math.abs(detail.runs[1].x-expected)<0.01,`expected x=${expected}; actual=${detail.runs[1].x}`);
});
for(const anchorAction of ['replace','duplicate']) await check('F-09',`explicit ref skip survives object replace with anchor ${anchorAction}`,async detail=>{
 const ctx=await startApp();try{
  const book=await call(ctx,'library.importDocument',{title:'显式策略反例',format:'txt',bytes:[...new TextEncoder().encode('来源正文。')]});
  const note=await call(ctx,'notes.create',{title:'合成笔记',text:'评论',resourceId:book.resourceId,resourceRevisionId:book.revisionId,locator:{kind:'text',partId:'body',representationId:book.revisionId,normalizationVersion:'nfc-lf-codepoint-v1',range:{start:0,end:4},quote:{exact:'来源正文'}}});
  const db=ctx.app.store.sqlite,dir=tempProfile(),manifest=exportLibraryPackage(ctx.app.store,dir),ref=manifest.refs[0];
  // A valid local reference can change its presentation metadata after the export. It still targets
  // the same source; explicit skip must keep this row or reject incompatible requested decisions.
  db.prepare('UPDATE refs SET instance_layout_json=? WHERE id=?').run(JSON.stringify({reviewMarker:'local-after-export'}),ref.id);
  const localBefore=db.prepare('SELECT * FROM refs WHERE id=?').get(ref.id);
  const snapshot=()=>JSON.stringify(['resources','resource_revisions','anchors','refs','content_objects','object_revisions','text_fragments'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  const before=snapshot();let error;
  try{importLibraryPackageResolved(ctx.app.store,dir,{strategy:'replace',decisions:[{kind:'object',id:note.objectId,action:'replace'},{kind:'anchor',id:ref.to_id,action:anchorAction},{kind:'ref',id:ref.id,action:'skip'}]});}catch(e){error=e;}
  const localAfter=db.prepare('SELECT * FROM refs WHERE id=?').get(ref.id);
  detail.errorCode=error?.code??null;detail.explicitRefUnchanged=JSON.stringify(localAfter)===JSON.stringify(localBefore);detail.contentUnchanged=snapshot()===before;
  detail.localBefore=localBefore;detail.localAfter=localAfter;
  detail.publicRefs=db.prepare('SELECT * FROM refs WHERE from_object_id=?').all(note.objectId);
  if(error){assert.equal(error.code,'PUBLISH_CONFLICT');assert.equal(detail.contentUnchanged,true);}else assert.equal(detail.explicitRefUnchanged,true,'object replacement deleted and rewrote the explicitly skipped local ref');
 }finally{ctx.app.close();}
});
const seed=await startApp();const books=[];
try{await call(seed,'settings.skipAi',{});for(const s of samples){fs.writeFileSync(path.join(evidence,`${s.name}.pdf`),s.bytes);books.push({...s,...await call(seed,'library.importDocument',{title:s.name,format:'pdf',bytes:[...s.bytes]})});}}finally{seed.app.close();}
const env={...process.env,MANGA_CHANNEL:'test',MANGA_PROFILE_ROOT:seed.profileRoot,MANGA_DOCUMENTS_DIR:path.join(seed.profileRoot,'documents'),MANGA_POINTER_FILE:path.join(seed.profileRoot,'launcher','pointer.json')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(desktopPackageDir,'MANGA-win32-x64/MANGA.exe'),env});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(10000);await page.getByTestId('nav-reading').waitFor();await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1600,900);w.webContents.setZoomFactor(1);});await page.getByTestId('nav-reading').click();
 for(const book of books)await check('F-07',`packaged joined/split equivalence: ${book.name}`,async detail=>{
  await page.getByTestId(`open-${book.resourceId}`).click();await page.getByTestId('reading-page-render').waitFor();await page.getByTestId('reading-page-render').scrollIntoViewIfNeeded();await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
  detail.runs=await page.locator('[data-testid="reading-page-render"] text').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,x:Number(n.getAttribute('x')),w:Number(n.getAttribute('textLength')),charX:Array.from({length:n.getNumberOfChars()},(_,i)=>n.getStartPositionOfChar(i).x)})));
  const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));fs.writeFileSync(path.join(evidence,`${book.name}.png`),Buffer.from(png,'base64'));
  detail.expected=book.expected;detail.joined=detail.runs[0].charX;detail.split=detail.runs.slice(1).map(r=>r.x);
  assert.deepEqual(detail.split,detail.expected);
  assert.ok(detail.joined.every((x,i)=>Math.abs(x-detail.expected[i])<0.1),'equivalent joined and split Tj sequences draw different glyph origins');
 });
}finally{await app.close();}
const report={at:new Date().toISOString(),...m1bFingerprints(repoRoot),scriptFingerprint:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),package:JSON.parse(fs.readFileSync(latestDesktopPackage,'utf8')),status:observations.every(o=>o.status==='passed')?'passed':'rework-required',productAcceptance:'not-run',humanChecks:'not-run',observations};
fs.writeFileSync(path.join(evidence,'a-b9-supplementary-review.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.status!=='passed')process.exitCode=1;
