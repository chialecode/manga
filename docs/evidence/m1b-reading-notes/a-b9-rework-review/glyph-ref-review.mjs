// Stronger F-07/F-09 invariants. No product source or previous evidence is modified.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startApp, tempProfile } from '../../../../tests/m1b/helpers.ts';
import { exportLibraryPackage, importLibraryPackageResolved } from '../../../../packages/app-core/src/domain/library-package.ts';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
import { desktopPackageDir } from '../../../../scripts/desktop-paths.ts';
import { _electron as electron } from 'playwright-core';
const dir=path.dirname(fileURLToPath(import.meta.url)), observations=[];
async function check(finding,name,fn){const detail={};try{await fn(detail);observations.push({finding,name,status:'passed',detail});}catch(e){observations.push({finding,name,status:'failed',actual:e.message,detail});}}
async function call(ctx,commandId,input){const r=await ctx.app.call(ctx.actor,{commandId,input,idempotencyKey:crypto.randomUUID()},ctx.grant.handle);assert.equal(r.status,'ok',r.error?.message);return r.value;}
const tables=['works','resources','resource_revisions','anchors','refs','content_objects','object_revisions','text_fragments','resource_assets','file_locations','progress','bookmarks'];
function snapshot(db){return JSON.stringify(tables.map(t=>({table:t,rows:db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()})));}
function attachmentSnapshot(root){const out={};function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())walk(f);else out[path.relative(root,f).replaceAll('\\','/')]=createHash('sha256').update(fs.readFileSync(f)).digest('hex');}}walk(root);return out;}
// All four inputs begin with a valid, product-created source, note, history and reference graph.
for(const variant of [
  {name:'replace anchor control',anchor:'replace',resource:'replace'},
  {name:'duplicate anchor retains payload/ref/history agreement',anchor:'duplicate',resource:'replace'},
  {name:'duplicate resource and anchor keeps skipped ref revision owner',anchor:'duplicate',resource:'duplicate'},
  {name:'duplicate resource with replaced anchor keeps skipped source identity',anchor:'replace',resource:'duplicate'},
])await check('F-09',variant.name,async detail=>{
  const ctx=await startApp();try{
    const book=await call(ctx,'library.importDocument',{title:'保留来源的合成书',format:'txt',bytes:[...new TextEncoder().encode('来源正文。第二段。')]});
    const note=await call(ctx,'notes.create',{title:'保留来源的合成笔记',text:'评论',resourceId:book.resourceId,resourceRevisionId:book.revisionId,locator:{kind:'text',partId:'body',representationId:book.revisionId,normalizationVersion:'nfc-lf-codepoint-v1',range:{start:0,end:4},quote:{exact:'来源正文'}}});
    const db=ctx.app.store.sqlite,pkg=tempProfile(),manifest=exportLibraryPackage(ctx.app.store,pkg),ref=manifest.refs[0];
    db.prepare('UPDATE refs SET mode=?,instance_layout_json=? WHERE id=?').run('snapshot',JSON.stringify({marker:'local-after-export'}),ref.id);
    const sourceBefore=await call(ctx,'notes.openSource',{objectId:note.objectId,blockId:'quote'});
    assert.equal(sourceBefore.status,'resolved');assert.equal(sourceBefore.card.status,'resolved');
    const before=snapshot(db),beforeFiles=attachmentSnapshot(ctx.app.store.attachmentsDir);
    const refBefore=db.prepare('SELECT * FROM refs WHERE id=?').get(ref.id);
    let error;
    try{importLibraryPackageResolved(ctx.app.store,pkg,{strategy:'replace',decisions:[{kind:'object',id:note.objectId,action:'replace'},{kind:'ref',id:ref.id,action:'skip'},{kind:'anchor',id:ref.to_id,action:variant.anchor},{kind:'resource',id:book.resourceId,action:variant.resource},{kind:'resource_revision',id:book.revisionId,action:'replace'}]});}catch(e){error=e;}
    detail.errorCode=error?.code??null;detail.contentUnchanged=snapshot(db)===before;detail.attachmentsUnchanged=JSON.stringify(attachmentSnapshot(ctx.app.store.attachmentsDir))===JSON.stringify(beforeFiles);
    detail.refBefore=refBefore;detail.refAfter=db.prepare('SELECT * FROM refs WHERE id=?').get(ref.id);
    if(error){assert.equal(error.code,'PUBLISH_CONFLICT');assert.equal(detail.contentUnchanged,true);assert.equal(detail.attachmentsUnchanged,true);return;}
    detail.sourceBefore=sourceBefore;detail.sourceAfter=await call(ctx,'notes.openSource',{objectId:note.objectId,blockId:'quote'});
    detail.payload=JSON.parse(db.prepare('SELECT payload_json FROM content_objects WHERE id=?').get(note.objectId).payload_json);
    detail.history=db.prepare('SELECT revision,payload_json FROM object_revisions WHERE object_id=? ORDER BY revision').all(note.objectId).map(r=>({revision:r.revision,payload:JSON.parse(r.payload_json)}));
    detail.refs=db.prepare('SELECT * FROM refs WHERE from_object_id=?').all(note.objectId);
    detail.anchors=db.prepare('SELECT a.id,a.resource_id,a.resource_revision_id,v.resource_id AS revisionOwner FROM anchors a LEFT JOIN resource_revisions v ON a.resource_revision_id=v.id').all();
    detail.indices=db.prepare('SELECT object_id,resource_id,resource_revision_id FROM text_fragments WHERE object_id=?').all(note.objectId);
    const violations=[];
    if(JSON.stringify(detail.refAfter)!==JSON.stringify(refBefore))violations.push('explicitly skipped ref row changed');
    if(detail.sourceAfter.status!=='resolved'||detail.sourceAfter.card?.status!=='resolved')violations.push(`source/card no longer resolved: ${detail.sourceAfter.status}/${detail.sourceAfter.card?.status}`);
    if(detail.sourceAfter.card?.resourceId!==book.resourceId)violations.push('skipped source silently moved to another resource');
    for(const a of detail.anchors)if(a.resource_id!==a.revisionOwner)violations.push(`anchor ${a.id} disagrees with revision owner`);
    for(const payload of [detail.payload,...detail.history.map(h=>h.payload)])for(const block of payload.blocks??[]){if(!block.anchorId)continue;const r=detail.refs.find(r=>r.from_block_id===block.id&&r.to_kind==='anchor');if(r?.to_id!==block.anchorId)violations.push(`block ${block.id} payload/history anchor disagrees with public ref`);}
    detail.violations=[...new Set(violations)];assert.deepEqual(detail.violations,[],'skip must preserve a coherent source graph or reject before content writes');
  }finally{ctx.app.close();}
});
function pdf(content,font='<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'){
  const bodies=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,font];
  let s='%PDF-1.4\n';const offsets=[];bodies.forEach((b,i)=>{offsets.push(Buffer.byteLength(s,'ascii'));s+=`${i+1} 0 obj\n${b}\nendobj\n`;});const x=Buffer.byteLength(s,'ascii');s+=`xref\n0 ${bodies.length+1}\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer << /Size ${bodies.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(s,'ascii');
}
const samples=[
  {name:'unequal-glyph-extents',bytes:pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm (ABC) Tj 1 0 0 1 50 280 Tm (A) Tj (B) Tj (C) Tj ET','<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding /FirstChar 65 /LastChar 67 /Widths [1000 100 100] >>')},
  {name:'courier-spacing-glyph-extents',bytes:pdf('BT /F1 10 Tf 2 Tc 10 Tw 1 0 0 1 50 320 Tm (A A) Tj 1 0 0 1 50 280 Tm (A) Tj ( ) Tj (A) Tj ET')},
  {name:'courier-half-scale-control',bytes:pdf('BT /F1 20 Tf 50 Tz 1 0 0 1 50 320 Tm (ABC) Tj 1 0 0 1 50 280 Tm (A) Tj (B) Tj (C) Tj ET')},
  {name:'courier-spacing-does-not-stretch-ink',spacingOnly:true,bytes:pdf('BT /F1 10 Tf 1 0 0 1 50 320 Tm (AAA) Tj 2 Tc 1 0 0 1 50 280 Tm (AAA) Tj ET')},
];
const seed=await startApp(),books=[];
try{await call(seed,'settings.skipAi',{});for(const s of samples){fs.writeFileSync(path.join(dir,s.name+'.pdf'),s.bytes);books.push({...s,...await call(seed,'library.importDocument',{title:s.name,format:'pdf',bytes:[...s.bytes]})});}}finally{seed.app.close();}
const env={...process.env,MANGA_CHANNEL:'test',MANGA_PROFILE_ROOT:seed.profileRoot,MANGA_DOCUMENTS_DIR:path.join(seed.profileRoot,'documents'),MANGA_POINTER_FILE:path.join(seed.profileRoot,'launcher/pointer.json')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(desktopPackageDir,'MANGA-win32-x64/MANGA.exe'),env});
try{
  const page=await app.firstWindow();page.setDefaultTimeout(10000);await page.getByTestId('nav-reading').waitFor();await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1600,900);w.webContents.setZoomFactor(1);});await page.getByTestId('nav-reading').click();
  for(const b of books)await check('F-07',b.name,async detail=>{
    await page.getByTestId(`open-${b.resourceId}`).click();await page.getByTestId('reading-page-render').waitFor();await page.getByTestId('reading-page-render').scrollIntoViewIfNeeded();await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
    detail.runs=await page.locator('[data-testid="reading-page-render"] text').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,x:n.getAttribute('x'),textLength:n.getAttribute('textLength'),font:getComputedStyle(n).fontFamily,chars:Array.from({length:n.getNumberOfChars()},(_,i)=>{const p=n.getStartPositionOfChar(i),e=n.getEndPositionOfChar(i),b=n.getExtentOfChar(i);return {start:{x:p.x,y:p.y},end:{x:e.x,y:e.y},extent:{x:b.x,y:b.y,width:b.width,height:b.height}};})})));
    const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));fs.writeFileSync(path.join(dir,b.name+'.png'),Buffer.from(png,'base64'));
    // A standalone space is collapsed by SVG; compare only painted non-space characters in both rows.
    const painted=r=>r.chars.filter((_,i)=>r.text[i]!==' ');
    const joined=painted(detail.runs[0]),split=b.spacingOnly?painted(detail.runs[1]):detail.runs.slice(1).flatMap(painted);
    detail.joinedWidths=joined.map(c=>c.extent.width);detail.otherWidths=split.map(c=>c.extent.width);
    detail.originAgreement=b.spacingOnly?'spacing intentionally changes origins':joined.every((c,i)=>Math.abs(c.start.x-split[i].start.x)<0.1);
    if(!b.spacingOnly)assert.equal(detail.originAgreement,true);
    assert.ok(joined.every((c,i)=>Math.abs(c.extent.width-split[i].extent.width)<0.1),b.spacingOnly?'Tc adds advance but must not stretch each glyph':'equivalent joined/split operators must preserve per-glyph horizontal shape and extent, not only origins');
  });
}finally{await app.close();}
const report={at:new Date().toISOString(),...m1bFingerprints(process.cwd()),scriptFingerprint:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),status:observations.every(o=>o.status==='passed')?'passed':'rework-required',productAcceptance:'not-run',humanChecks:'not-run',observations};
fs.writeFileSync(path.join(dir,'a-glyph-ref-review.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,observations:observations.map(o=>({name:o.name,status:o.status,actual:o.actual,violations:o.detail.violations,joined:o.detail.joinedWidths,other:o.detail.otherWidths}))},null,2));if(report.status!=='passed')process.exitCode=1;
