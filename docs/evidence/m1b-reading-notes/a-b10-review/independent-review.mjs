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
const tables=['works','resources','resource_revisions','anchors','refs','content_objects','object_revisions','text_fragments','search_idx','resource_assets','file_locations','progress','bookmarks'];
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
const { buildPdfFixture } = await import('../../../../packages/app-core/src/domain/formats.ts');
const seed = await startApp();
const books = {};
try {
  await call(seed, 'settings.skipAi', {});
  for (const [name, bytes] of Object.entries({
    single: pdf('BT /F1 20 Tf 1 0 0 1 50 320 Tm (FIRST LINE) Tj ET'),
    multiline: pdf('BT /F1 20 Tf 24 TL 1 0 0 1 50 320 Tm (FIRST LINE) Tj T* (SECOND LINE) Tj T* (THIRD LINE) Tj ET'),
    repeated: pdf('BT /F1 20 Tf 24 TL 1 0 0 1 50 320 Tm (REPEAT) Tj T* (REPEAT) Tj ET'),
    standardScan: fs.readFileSync(path.join(dir,'../a-b9-rework-review/standard-scan.pdf')),
    scan: buildPdfFixture([{text:'SCAN CONTROL'}, {scan:true}, {}]),
  })) {
    fs.writeFileSync(path.join(dir, name + '.pdf'), bytes);
    books[name] = await call(seed,'library.importDocument',{title:name,format:'pdf',bytes:[...bytes]});
  }
} finally { seed.app.close(); }
const env={...process.env,MANGA_CHANNEL:'test',MANGA_PROFILE_ROOT:seed.profileRoot,MANGA_DOCUMENTS_DIR:path.join(seed.profileRoot,'documents'),MANGA_POINTER_FILE:path.join(seed.profileRoot,'launcher/pointer.json')};
delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(desktopPackageDir,'MANGA-win32-x64/MANGA.exe'),env});
try {
  const page=await app.firstWindow(); page.setDefaultTimeout(15000);
  await app.evaluate(({session})=>{
    globalThis.reviewNetworkRequests=[];
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{
      globalThis.reviewNetworkRequests.push({scheme:new URL(details.url).protocol,type:details.resourceType});callback({cancel:true});
    });
  });
  await page.getByTestId('nav-reading').waitFor();
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0]; w.setContentSize(1280,840);w.webContents.setZoomFactor(1);});
  await page.getByTestId('nav-reading').click();
  for (const name of ['single','multiline']) await check('F-07',`packaged ${name} excerpt and source highlight`,async detail=>{
    await page.getByTestId(`open-${books[name].resourceId}`).click();
    await page.waitForFunction(text=>document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes(text),name==='single'?'FIRST LINE':'THIRD LINE');
    detail.layer=await page.getByTestId('reading-pdf-text').innerText();
    detail.selection=await page.evaluate((name)=>{
      const layer=document.querySelector('[data-testid="reading-pdf-text"]');
      const spans=[...layer.querySelectorAll('span')];
      const span=spans.find(s=>s.textContent===(name==='single'?'FIRST LINE':'SECOND LINE'));
      const range=document.createRange(); range.selectNodeContents(span);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      const prefix=range.cloneRange();prefix.selectNodeContents(layer);prefix.setEnd(range.startContainer,range.startOffset);
      return {quote:range.toString(),prefix:prefix.toString(),html:layer.innerHTML};
    },name);
    await page.getByTestId('reading-note').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="nav-notes"]')?.getAttribute('aria-current')==='page'||!!document.querySelector('[data-testid="note-title"]'));
    detail.saved=await page.evaluate(async()=>{
      const r=await window.manga.command({commandId:'notes.list',input:{},idempotencyKey:crypto.randomUUID()});
      return r;
    });
    const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(dir,`${name}-note.png`),Buffer.from(png,'base64'));
    await page.getByTestId('note-block-source-quote').click();
    await page.waitForFunction(()=>!!document.querySelector('.textLayer .reading-quote-hit'));
    detail.highlights=await page.locator('.textLayer .reading-quote-hit').allTextContents();
    detail.sourceStatus=await page.getByTestId('reading-source-card').getAttribute('data-source-status');
    await page.getByTestId('reading-source-back').click();
    await page.getByTestId('note-title').waitFor();
    detail.returnedToNote=true;
    await page.getByTestId('nav-reading').click();
    assert.deepEqual(detail.highlights,[name==='single'?'FIRST LINE':'SECOND LINE'],'source highlight must mark only the quoted line');
  });
  await check('F-07','text-layer hit area follows Canvas glyph scale',async detail=>{
    await page.getByTestId(`open-${books.single.resourceId}`).click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="reading-pdf-text"]')?.innerText==='FIRST LINE');
    detail.geometry=await page.getByTestId('reading-pdf-text').evaluate(layer=>{
      const span=layer.querySelector('span'), box=span.getBoundingClientRect();
      const canvas=layer.parentElement.querySelector('canvas');
      const scale=canvas.getBoundingClientRect().width/400;
      return {fontSize:getComputedStyle(span).fontSize,transform:getComputedStyle(span).transform,layerStyle:layer.getAttribute('style'),canvasWidth:canvas.width,actualWidth:box.width,expectedWidth:120*scale,scale};
    });
    const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(dir,'text-layer-geometry.png'),Buffer.from(png,'base64'));
    assert.ok(Number.isFinite(detail.geometry.expectedWidth));
    assert.ok(Math.abs(detail.geometry.actualWidth-detail.geometry.expectedWidth)<2,'text-layer selection area must overlay the rendered text');
  });
  for (const name of ['multiline','repeated']) await check('F-07',`new PDF ${name} selection has a usable locator`,async detail=>{
    await page.getByTestId(`open-${books[name].resourceId}`).click();
    await page.waitForFunction(text=>document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes(text),name==='repeated'?'REPEAT':'THIRD LINE');
    detail.selection=await page.evaluate(name=>{
      const layer=document.querySelector('[data-testid="reading-pdf-text"]'), spans=[...layer.querySelectorAll('span')];
      const range=document.createRange();
      if(name==='multiline'){range.setStart(spans[0].firstChild,0);range.setEnd(spans[1].firstChild,spans[1].textContent.length);}
      else range.selectNodeContents(spans[1]);
      const s=window.getSelection();s.removeAllRanges();s.addRange(range);document.dispatchEvent(new Event('selectionchange'));
      return {quote:range.toString(),innerText:layer.innerText};
    },name);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    detail.enabled=await page.getByTestId('reading-note').isEnabled();
    assert.equal(detail.enabled,true,'a selection in the current representation must map even across EOL or repeated quotes');
  });
  await check('F-07','scan page paints nonblank Canvas and has no selectable text',async detail=>{
    await page.getByTestId(`open-${books.standardScan.resourceId}`).click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="reading-scan"]'));
    detail.canvas=await page.getByTestId('reading-pdf-canvas').evaluate(canvas=>{
      const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let dark=0;
      for(let i=0;i<bytes.length;i+=4)if(bytes[i]<100&&bytes[i+1]<100&&bytes[i+2]<100)dark++;
      return {width:canvas.width,height:canvas.height,dark};
    });
    detail.layer=await page.getByTestId('reading-pdf-text').innerText();
    assert.ok(detail.canvas.dark>20);assert.equal(detail.layer,'');
  });
  await check('F-07','late original bytes cannot replace the current book',async detail=>{
    await app.evaluate(({ipcMain},id)=>{
      const original=ipcMain._invokeHandlers.get('manga:command');
      globalThis.reviewOriginalHandler=original;
      globalThis.reviewOriginalPending=false;
      ipcMain.removeHandler('manga:command');
      ipcMain.handle('manga:command',async(event,payload)=>{
        const result=await original(event,payload);
        if(payload.commandId==='library.readOriginal'&&payload.input.resourceId===id){
          globalThis.reviewOriginalPending=true;
          await new Promise(resolve=>{globalThis.releaseReviewOriginal=resolve;});
        }
        return result;
      });
    },books.single.resourceId);
    try {
      await page.getByTestId(`open-${books.single.resourceId}`).click();
      for(let i=0;i<100;i++) {
        if(await app.evaluate(()=>globalThis.reviewOriginalPending))break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.equal(await app.evaluate(()=>globalThis.reviewOriginalPending),true,'delayed readOriginal was not reached');
      await page.getByTestId(`open-${books.repeated.resourceId}`).click();
      await page.waitForFunction(()=>document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes('REPEAT'));
      detail.before=await page.getByTestId('reading-pdf-text').innerText();
      await app.evaluate(()=>globalThis.releaseReviewOriginal());
      // Synchronize on the delayed IPC response and a completed replacement render.
      await page.waitForFunction(()=>document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes('FIRST LINE'),null,{timeout:3000}).catch(()=>{});
      detail.after=await page.getByTestId('reading-pdf-text').innerText();
      detail.activeTitle=await page.locator('[data-testid="reading-title"]').textContent().catch(()=>null);
      assert.ok(detail.after.includes('REPEAT'),'late bytes from the prior book were rendered under the current book');
    } finally {
      await app.evaluate(({ipcMain})=>{globalThis.releaseReviewOriginal?.();ipcMain.removeHandler('manga:command');ipcMain.handle('manga:command',globalThis.reviewOriginalHandler);});
    }
  });
  await check('F-07','packaged PDF runs without HTTP or HTTPS',async detail=>{
    detail.blockedRequests=await app.evaluate(()=>globalThis.reviewNetworkRequests);
    assert.deepEqual(detail.blockedRequests,[]);
  });
} finally {await app.close();}
const reopened=await startApp({profileRoot:seed.profileRoot});
try {
  await check('F-07','persisted PDF excerpts equal the selected quotes',async detail=>{
    detail.objects=reopened.app.store.sqlite.prepare('SELECT id,payload_json FROM content_objects').all().map(row=>({id:row.id,payload:JSON.parse(row.payload_json)}));
    detail.anchors=reopened.app.store.sqlite.prepare('SELECT * FROM anchors').all();
    detail.sources=[];
    for(const object of detail.objects) {
      const source=await call(reopened,'notes.openSource',{objectId:object.id,blockId:'quote'});
      detail.sources.push({status:source.status,cardStatus:source.card?.status,quote:source.card?.quote});
      assert.equal(source.status,'resolved');assert.equal(source.card?.status,'resolved');
    }
    const all=JSON.stringify(detail.objects);
    assert.ok(all.includes('SECOND LINE'),'second-line excerpt missing');
    assert.ok(!all.includes('\\nSECOND LIN'),'second-line quote shifted by the missing EOL');
  });
} finally {reopened.app.close();}
const report={at:new Date().toISOString(),...m1bFingerprints(process.cwd()),scriptFingerprint:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),status:observations.every(o=>o.status==='passed')?'passed':'rework-required',productAcceptance:'not-run',humanChecks:'not-run',observations};
fs.writeFileSync(path.join(dir,'a-pdfjs-review.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,observations:observations.map(o=>({name:o.name,status:o.status,actual:o.actual,detail:o.detail}))},null,2));
if(report.status!=='passed')process.exitCode=1;
