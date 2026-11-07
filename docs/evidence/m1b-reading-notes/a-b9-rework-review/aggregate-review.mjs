// Preserve raw observations and feed all independent counterexamples into the existing strict gate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url)),current=m1bFingerprints(process.cwd());
const sourceReports=['a-recheck-original.json','a-b9-supplementary-review.json','a-glyph-ref-review.json'];
const observations=[],sources=[];
for(const file of sourceReports){
  const bytes=fs.readFileSync(path.join(dir,file)),r=JSON.parse(bytes);
  for(const [key,value] of Object.entries(current))if(r[key]!==value)throw Error(`${file}: stale ${key}`);
  if(!r.observations?.length)throw Error(`${file}: empty observations`);
  observations.push(...r.observations.map(o=>({...o,evidenceFile:file})));
  sources.push({file,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const result={at:new Date().toISOString(),...current,generator:'docs/evidence/m1b-reading-notes/a-b9-rework-review/aggregate-review.mjs',scriptFingerprint:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),sourceReports,sources,status:observations.every(o=>o.status==='passed')?'passed':'rework-required',humanChecks:'not-run',productAcceptance:'not-run',observations};
fs.writeFileSync(path.join(dir,'a-adversarial-review.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,passed:observations.filter(o=>o.status==='passed').length,failed:observations.filter(o=>o.status==='failed').length}));
