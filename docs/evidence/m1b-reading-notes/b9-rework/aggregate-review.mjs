// Compose independently recorded service and window reviews into the existing report-gate input.
// The original legacy audit and the supplementary review remain separate, unchanged source records.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
const root=process.cwd(),dir=path.dirname(fileURLToPath(import.meta.url));
const reports=['a-recheck-original.json','a-b9-supplementary-review.json'];
const current=m1bFingerprints(root),observations=[];
for(const file of reports){const r=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));for(const [key,value] of Object.entries(current))if(r[key]!==value)throw new Error(`${file}: stale ${key}`);observations.push(...r.observations.map(o=>({...o,evidenceFile:file})));}
const result={at:new Date().toISOString(),...current,generator:'docs/evidence/m1b-reading-notes/b9-rework/aggregate-review.mjs',scriptFingerprint:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),sourceReports:reports,status:observations.every(o=>o.status==='passed')?'passed':'rework-required',humanChecks:'not-run',productAcceptance:'not-run',observations};
fs.writeFileSync(path.join(dir,'a-adversarial-review.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,passed:observations.filter(o=>o.status==='passed').length,failed:observations.filter(o=>o.status==='failed').length}));
