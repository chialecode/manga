// Reproduce this independent review from the repository root; all profiles are synthetic.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
const root=process.cwd(), dir=path.dirname(fileURLToPath(import.meta.url));
const relative=p=>path.relative(root,p).replaceAll('\\','/');
const logs=path.join(root,'dist/desktop/review-runs/a-b9-rework-review');
fs.mkdirSync(logs,{recursive:true});
const env={...process.env,M1B_EVIDENCE_DIR:relative(dir),M1A_EVIDENCE_DIR:'docs/evidence/m1b-m1a-regression/a-b9-rework-review'};
delete env.M1B_REQUIRE_REPORT;
delete env.M1A_REQUIRE_REPORT;
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const record=path.join(dir,'a-command-results.json');
const commands=fs.existsSync(record)?JSON.parse(fs.readFileSync(record,'utf8')):[];
function run(file,extraEnv={}){
  const log=path.join(logs,`${path.basename(file,'.mjs')}-${commands.length+1}.log`),fd=fs.openSync(log,'w');
  const start=new Date().toISOString();
  const result=spawnSync(process.execPath,[file],{cwd:root,env:{...env,...extraEnv},stdio:['ignore',fd,fd],windowsHide:true});
  fs.closeSync(fd);
  const row={command:`node ${file}`,start,end:new Date().toISOString(),exitCode:result.status,log:relative(log),...m1bFingerprints(root)};
  commands.push(row);fs.writeFileSync(record,JSON.stringify(commands,null,2)+'\n');
  console.log(JSON.stringify({command:row.command,exitCode:row.exitCode,log:row.log}));
  return result.status;
}
const phase=process.argv[2];
if(phase==='prepare'){
  const protectedDirs=['docs/evidence/m1b-reading-notes/a-b9-review','docs/evidence/m1b-reading-notes/b9-rework','docs/evidence/m1b-m1a-regression/a-b9-review','docs/evidence/m1b-m1a-regression/b9-rework'];
  const files={};
  function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())walk(f);else files[relative(f)]=hash(f);}}
  protectedDirs.forEach(walk);
  fs.writeFileSync(path.join(dir,'freeze-baseline.json'),JSON.stringify({at:new Date().toISOString(),...m1bFingerprints(root),protectedFiles:files},null,2)+'\n');
  for(const name of ['standard-scan.pdf','relative-image.epub']){
    const from=path.join(root,'docs/evidence/m1b-reading-notes/a-b7-review/final',name),to=path.join(dir,name);
    fs.copyFileSync(from,to);if(hash(from)!==hash(to))throw Error('fixture hash mismatch');
  }
  fs.copyFileSync(path.join(root,'docs/evidence/m1b-reading-notes/b9-rework/supplementary-review.mjs'),path.join(dir,'supplementary-review.mjs'));
  if(run('scripts/package-m1b.mjs')!==0)process.exitCode=1;
} else if(phase==='legacy'){
  for(const name of ['review-m1b-a-b8','audit-m1b-b5-review','audit-m1b-b6-review','audit-m1b-b7-rework','audit-m1b-a-b7-review','audit-m1b-recheck','review-m1b-a-b7-ui','review-m1b-ui','review-m1b-reading','review-m1b-recheck','review-m1b-b6-ui','review-m1b-b5-h-checks','review-m1b-b9-reader-engines'])run(`scripts/${name}.mjs`);
  fs.copyFileSync(path.join(dir,'a-adversarial-review.json'),path.join(dir,'a-recheck-original.json'));
  run(relative(path.join(dir,'supplementary-review.mjs')));
  run('scripts/audit-m1a-reverify.mjs');
  run('scripts/bench-m1b.mjs');
} else if(phase==='new'){
  run(relative(path.join(dir,'glyph-ref-review.mjs')));
} else if(phase==='strict'){
  run('scripts/verify-m1b.mjs',{M1B_REQUIRE_REPORT:'1'});
} else if(phase==='repository'){
  const exitCode=run('scripts/verify.mjs');
  fs.writeFileSync(path.join(dir,'repository-quality.json'),JSON.stringify({at:new Date().toISOString(),...m1bFingerprints(root),command:'node scripts/verify.mjs',exitCode,status:exitCode===0?'passed':'failed',log:commands.at(-1).log,productAcceptance:'not-run'},null,2)+'\n');
} else throw Error('expected prepare, legacy, strict or repository');
