import fs from "node:fs";
import path from "node:path";
import required from "./m0-required-cases.json" with { type: "json" };

export const requiredBenchTargets={searchP95Ms:500,inputStateP95Ms:100,processStartupMaxMs:5000,autoSaveMs:1000,contextP95Ms:150,firstScreenTxtP95Ms:2000,progressP95Ms:2000,recordStatusMs:300};

export function evaluateEvidence(dir, fingerprint) {
  const errors=[],checks=[],humanOpen=[],pendingAutomated=[];
  const read=name=>{
    try {return JSON.parse(fs.readFileSync(path.join(dir,name),"utf8"));}
    catch {errors.push(`${name}: missing or invalid JSON`);return null;}
  };
  const current=(name,item)=>{
    if(!item || item.sourceFingerprint!==fingerprint) {errors.push(`${name}: missing or stale sourceFingerprint`);return false;}
    return true;
  };
  for(const [file,expected] of Object.entries(required)) {
    const item=read(file),valid=current(file,item),cases=Array.isArray(item?.cases)?item.cases:[];
    for(const def of expected) {
      const matches=cases.filter(entry=>entry.caseId===def.id);
      if(matches.length!==1 || matches[0].kind!==def.kind) {errors.push(`${file}: missing, duplicate or reclassified case ${def.id}`);continue;}
      const entry=matches[0];
      if(!["passed","failed","not-run","blocked"].includes(entry.status)) errors.push(`${def.id}: invalid status`);
      else if(def.kind==="human" || def.kind==="device") {if(entry.status!=="passed") humanOpen.push(def.id);}
      else if(entry.status==="failed") errors.push(`${def.id}: failed`);
      else if(entry.status!=="passed") pendingAutomated.push(def.id);
    }
    for(const entry of cases) if(entry.status==="failed") errors.push(`${entry.caseId}: failed`);
    checks.push({file,stale:!valid,cases:cases.length});
  }
  const supplementary={};
  for(const file of ["test-run.json","package.json","bench.json","format-matrix.json","media-electron.json"]) {
    const item=read(file),valid=current(file,item);
    if(file==="media-electron.json") {
      if(item?.status!=="recorded" || item?.h264?.status!=="played") errors.push(`${file}: actual baseline playback missing`);
    } else if(item?.status!=="passed") errors.push(`${file}: result is not passed`);
    if(file==="test-run.json" && (!Array.isArray(item?.files) || !item.files.some(name=>name.endsWith("closure-review.test.ts")))) errors.push(`${file}: closure review regressions missing`);
    if(file==="bench.json") {
      for(const [metric,limit] of Object.entries(requiredBenchTargets)) {
        if(item?.targets?.[metric]!==limit) errors.push(`${file}: target ${metric} missing or changed`);
        if(!Number.isFinite(item?.metrics?.[metric]) || item.metrics[metric]<0 || item.metrics[metric]>limit) errors.push(`${file}: metric ${metric} missing or over target`);
      }
      if(item?.unmet?.length) errors.push(`${file}: unmet targets`);
    }
    if(file==="package.json") for(const phase of ["initial","restart","permission"]) if(!item?.smokeResults?.some(result=>result.phase===phase && result.status==="passed")) errors.push(`${file}: ${phase} smoke missing`);
    supplementary[file]={status:item?.status ?? "not-run",stale:!valid,pending:item?.pending ?? []};
  }
  // These two old inline placeholders have independently executed evidence.
  const resolvedExternally=[];
  if(supplementary["package.json"].status==="passed" && !supplementary["package.json"].stale) resolvedExternally.push("POC-06/package-smoke");
  if(supplementary["format-matrix.json"].status==="passed" && !supplementary["format-matrix.json"].stale && supplementary["media-electron.json"].status==="recorded" && !supplementary["media-electron.json"].stale) resolvedExternally.push("POC-03/mkv-hevc-ass");
  const pending=pendingAutomated.filter(id=>!resolvedExternally.includes(id));
  for(const id of pending) errors.push(`${id}: required automated case not completed`);
  return {checks,supplementary,humanOpen,pendingAutomated:pending,resolvedExternally,errors:[...new Set(errors)],automationStatus:errors.length?"failed-or-incomplete":"tested-subset-passed",engineeringReviewable:errors.length===0};
}
