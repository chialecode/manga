import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
import { evaluateM1bEvidence } from '../../../../scripts/m1b-report.mjs';
const root=process.cwd(), dir=path.dirname(fileURLToPath(import.meta.url));
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const write=(name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value,null,2)+'\n');
const fingerprints=m1bFingerprints(root);
const original=JSON.parse(fs.readFileSync('docs/evidence/m1b-reading-notes/b10-pdfjs-mvp/report.json','utf8'));
for(const [key,value] of Object.entries(fingerprints))assert.equal(value,original[key],key);
const sources=['a-recheck-original.json','a-pdfjs-review.json'];
const observations=sources.flatMap(name=>{
  const r=read(name);for(const [key,value] of Object.entries(fingerprints))assert.equal(r[key],value,`${name}:${key}`);
  return r.observations.map(row=>({...row,evidence:name}));
});
write('a-adversarial-review.json',{at:new Date().toISOString(),...fingerprints,status:observations.every(row=>row.status==='passed')?'passed':'rework-required',productAcceptance:'not-run',humanChecks:'not-run',observations});
write('report.json',{...evaluateM1bEvidence(dir,fingerprints),...fingerprints,at:new Date().toISOString()});
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const base=git('rev-parse','bd1fcbe');
const protectedDirs=['a-b9-review','b9-rework','a-b9-rework-review'].flatMap(name=>['m1b-reading-notes','m1b-m1a-regression'].map(group=>`docs/evidence/${group}/${name}`));
const protectedResults=protectedDirs.map(directory=>{
  const entries=git('ls-tree','-r',base,'--',directory).split('\n').filter(Boolean);
  for(const row of entries){const [,expected,file]=/^\d+ blob (\w+)\t(.+)$/.exec(row);assert.equal(git('hash-object',file),expected,file);}
  return {directory,files:entries.length,unchanged:true};
});
const require=createRequire(import.meta.url), asar=require('@electron/asar');
const pack='dist/desktop/packages/MANGA-win32-x64';
const archive=path.join(pack,'resources/app.asar');
const files=asar.listPackage(archive).map(name=>name.replaceAll('\\','/'));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const offlineAssets=[];
for(const kind of ['cmaps','standard_fonts','wasm','iccs','legacy/build']){
  const target=path.join(pack,'resources/pdfjs',kind);
  const entries=fs.readdirSync(target,{withFileTypes:true}).filter(row=>row.isFile());
  for(const entry of entries)assert.equal(sha(path.join(target,entry.name)),sha(path.join('node_modules/pdfjs-dist',kind,entry.name)));
  offlineAssets.push({kind,files:entries.length,installedBytesMatch:true});
}
const licenseMatch=sha(path.join(pack,'resources/pdfjs/LICENSE'))===sha('node_modules/pdfjs-dist/LICENSE');assert.ok(licenseMatch);
const previous=fs.existsSync(path.join(dir,'integrity.json'))?read('integrity.json'):null;
const ci=previous?.ci?.runs??JSON.parse(execFileSync('gh',['run','list','--commit',base,'--limit','5','--json','databaseId,headSha,status,conclusion,workflowName,url'],{encoding:'utf8'}));
write('integrity.json',{
  at:new Date().toISOString(),reviewedCommit:base,parent:git('rev-parse',base+'^'),...fingerprints,
  sameFingerprintsAsB:true,protectedResults,
  package:{path:pack,asarSha256:sha(archive),executableSha256:sha(path.join(pack,'MANGA.exe')),offlineAssets,licenseMatch,
    rendererAssets:files.filter(name=>name.includes('/pdfjs/')).length,
    pdfWorker:files.filter(name=>/pdf\.worker.*\.mjs$/.test(name)),
    oldPdfSourceRemoved:!fs.existsSync('packages/app-core/src/domain/pdf-text.ts')},
  reviewScripts:fs.readdirSync(dir).filter(name=>name.endsWith('.mjs')).map(name=>({name,sha256:sha(path.join(dir,name))})),
  ci:{query:'gh run list --commit <reviewedCommit> --limit 5',queriedAt:previous?.ci?.queriedAt??previous?.at??new Date().toISOString(),runs:ci,status:ci.length?'see-runs':'not-run'},
  productAcceptance:'not-run',formalH:'not-run',q08:'not-run',realProfileMigration:'not-run',
});
console.log(JSON.stringify({report:read('report.json'),protectedFiles:protectedResults.reduce((n,row)=>n+row.files,0),ciRuns:ci.length},null,2));
