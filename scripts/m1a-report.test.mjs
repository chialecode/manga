import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateM1aEvidence, requiredBenchTargets } from "./m1a-report.mjs";
import required from "./m1a-required-cases.json" with { type: "json" };

function write(dir, file, data) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
}

function generatedCases(overrides = {}) {
  return {
    sourceFingerprint: "current",
    m1aSourceFingerprint: "m1a-current",
    generator: "scripts/verify-m1a.mjs",
    cases: required["cases.json"].map((def) => ({
      caseId: def.id,
      kind: def.kind,
      status: "passed",
      tests: def.tests.map((pattern) => ({ file: "tests/m1a/synthetic.test.ts", name: pattern.replace(/^\^|\$$/g, ""), status: "passed" })),
    })),
    ...overrides,
  };
}

function passingBench(overrides = {}) {
  const raw = {
    searchMs: Array.from({ length: 100 }, () => 1),
    saveMs: Array.from({ length: 10 }, () => 1),
    contextMs: Array.from({ length: 10 }, () => 1),
    coldStartMs: [1, 1, 1],
    interactionMs: [1, 1, 1],
  };
  return {
    status: "passed",
    sourceFingerprint: "current",
    m1aSourceFingerprint: "m1a-current",
    metrics: { searchP95Ms: 1, saveMs: 1, coldStartMs: 1, contextP95Ms: 1, interactionP95Ms: 1 },
    targets: requiredBenchTargets,
    scale: { metadataCount: 10_000, searchBlocks: 50_000 },
    samples: {
      searchMs: { n: raw.searchMs.length, p95: 1 },
      saveMs: { n: raw.saveMs.length },
      contextMs: { n: raw.contextMs.length },
      coldStartMs: { n: raw.coldStartMs.length, kind: "process" },
      interactionMs: { n: raw.interactionMs.length, kind: "electron" },
    },
    raw,
    ...overrides,
  };
}

test("m1a report rejects missing cases, fingerprints, failed benches and stale packages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1a-report-"));
  const fingerprints = { sourceFingerprint: "current", m1aSourceFingerprint: "m1a-current" };
  try {
    write(dir, "cases.json", generatedCases());
    write(dir, "test-run.json", { status: "passed", sourceFingerprint: "current", m1aSourceFingerprint: "m1a-current" });
    write(dir, "bench.json", passingBench());
    write(dir, "package.json", {
      status: "passed",
      sourceFingerprint: "current",
      m1aSourceFingerprint: "m1a-current",
      smoke: ["initial", "restart", "agent", "agent-restart"],
    });
    assert.equal(evaluateM1aEvidence(dir, fingerprints).errors.length, 0);

    for (const file of ["cases.json", "test-run.json", "bench.json", "package.json"]) {
      const valid = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const missing = { ...valid };
      delete missing.m1aSourceFingerprint;
      write(dir, file, missing);
      assert.equal(evaluateM1aEvidence(dir, fingerprints).engineeringReviewable, false, `${file} must have its M1a fingerprint`);
      write(dir, file, valid);
    }
    const unmapped = generatedCases();
    unmapped.cases[0].tests = unmapped.cases[0].tests.map((entry) => ({ ...entry, name: "unrelated passing assertion" }));
    write(dir, "cases.json", unmapped);
    assert.equal(evaluateM1aEvidence(dir, fingerprints).engineeringReviewable, false);
    write(dir, "cases.json", generatedCases());

    write(dir, "package.json", { status: "passed", sourceFingerprint: "old", m1aSourceFingerprint: "m1a-current", smoke: ["initial", "restart", "agent", "agent-restart"] });
    assert.equal(evaluateM1aEvidence(dir, fingerprints).engineeringReviewable, false);

    write(dir, "package.json", { status: "passed", sourceFingerprint: "current", m1aSourceFingerprint: "m1a-current", smoke: ["initial", "restart", "agent", "agent-restart"] });
    write(dir, "bench.json", passingBench({ status: "failed" }));
    assert.equal(evaluateM1aEvidence(dir, fingerprints).automationStatus, "failed-or-incomplete");

    write(dir, "bench.json", passingBench({ metrics: {} }));
    assert.ok(evaluateM1aEvidence(dir, fingerprints).errors.some((item) => item.includes("metric")));

    write(dir, "bench.json", passingBench({ metrics: { searchP95Ms: 1, saveMs: 1, coldStartMs: 1 }, targets: {}, scale: { metadataCount: 200, searchBlocks: 200 } }));
    const scaleErrors = evaluateM1aEvidence(dir, fingerprints).errors;
    assert.ok(scaleErrors.some((item) => item.includes("target")));
    assert.ok(scaleErrors.some((item) => item.includes("metadataCount")));

    write(dir, "bench.json", passingBench({
      raw: { searchMs: [1], saveMs: [1], contextMs: [1], coldStartMs: [1], interactionMs: [1] },
      samples: { coldStartMs: { n: 1, kind: "host" }, interactionMs: { n: 1, kind: "service" } },
    }));
    const rawErrors = evaluateM1aEvidence(dir, fingerprints).errors;
    assert.ok(rawErrors.some((item) => item.includes("raw samples") || item.includes("process cold start")));
    assert.ok(rawErrors.some((item) => item.includes("Electron sample") || item.includes("visible interaction")));

    write(dir, "bench.json", passingBench());
    // A hand-written status list without executed tests is a claim, not evidence.
    write(dir, "cases.json", {
      sourceFingerprint: "current",
      m1aSourceFingerprint: "m1a-current",
      cases: required["cases.json"].map((def) => ({ caseId: def.id, kind: def.kind, status: "passed" })),
    });
    const handWritten = evaluateM1aEvidence(dir, fingerprints).errors;
    assert.ok(handWritten.some((item) => item.includes("executed tests missing")));
    assert.ok(handWritten.some((item) => item.includes("not generated by scripts/verify-m1a.mjs")));

    // A generated file whose mapped test did not run (pattern unmatched) is incomplete.
    const partial = generatedCases();
    partial.cases[0].status = "not-run";
    partial.cases[0].tests = [{ pattern: "^missing$", status: "not-run" }];
    write(dir, "cases.json", partial);
    assert.ok(evaluateM1aEvidence(dir, fingerprints).errors.some((item) => item.includes("F-24-owned-rollback")));

    write(dir, "cases.json", generatedCases());
    assert.equal(evaluateM1aEvidence(dir, fingerprints).errors.length, 0);
    write(dir, "audit.json", { ...fingerprints, status: "open-findings-reproduced", observations: [{ finding: "F-25", status: "failed", scenario: "authority" }] });
    assert.equal(evaluateM1aEvidence(dir, fingerprints).engineeringReviewable, false);
    fs.unlinkSync(path.join(dir, "audit.json"));
    fs.unlinkSync(path.join(dir, "cases.json"));
    assert.ok(evaluateM1aEvidence(dir, fingerprints).errors.some((item) => item.includes("cases.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
