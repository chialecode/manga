import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import required from "./m0-required-cases.json" with { type: "json" };
import { evaluateEvidence, requiredBenchTargets } from "./m0-report.mjs";

test("report rejects missing cases, fingerprints, failed benchmarks and stale packages",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"manga-report-test-"));
  const write=(file,data)=>fs.writeFileSync(path.join(dir,file),JSON.stringify(data));
  try {
    for(const [file,cases] of Object.entries(required)) write(file,{sourceFingerprint:"current",cases:cases.map(x=>({caseId:x.id,kind:x.kind,status:"passed"}))});
    const fixture={status:"passed",sourceFingerprint:"current"};
    write("test-run.json",{...fixture,files:["closure-review.test.ts"]});
    const packageRun={...fixture,smokeResults:["initial","restart","permission"].map(phase=>({phase,status:"passed"}))};
    write("package.json",packageRun);write("format-matrix.json",fixture);
    write("media-electron.json",{...fixture,status:"recorded",h264:{status:"played"}});
    const benchmark={...fixture,metrics:Object.fromEntries(Object.keys(requiredBenchTargets).map(key=>[key,1])),targets:requiredBenchTargets,pending:["physical display timing not measured"]};
    write("bench.json",benchmark);
    assert.equal(evaluateEvidence(dir,"current").errors.length,0);
    write("package.json",{...packageRun,sourceFingerprint:"old"});
    assert.equal(evaluateEvidence(dir,"current").engineeringReviewable,false);
    write("package.json",packageRun);
    write("bench.json",{...benchmark,status:"failed"});
    assert.equal(evaluateEvidence(dir,"current").automationStatus,"failed-or-incomplete");
    write("bench.json",{...benchmark,metrics:{}});
    assert.ok(evaluateEvidence(dir,"current").errors.some(x=>x.includes("metric")));
    write("bench.json",{...benchmark,targets:{}});
    assert.ok(evaluateEvidence(dir,"current").errors.some(x=>x.includes("target")));
    write("bench.json",benchmark);
    write("poc-01.json",{sourceFingerprint:"current",cases:[]});
    assert.equal(evaluateEvidence(dir,"current").engineeringReviewable,false);
    fs.unlinkSync(path.join(dir,"poc-02.json"));
    assert.ok(evaluateEvidence(dir,"current").errors.some(x=>x.includes("poc-02.json")));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
