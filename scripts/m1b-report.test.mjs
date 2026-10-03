import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateM1bEvidence, requiredBenchTargets, requiredPdfCounterexamples, requiredScale, scaleWindowSamples } from "./m1b-report.mjs";
import required from "./m1b-required-cases.json" with { type: "json" };

const fingerprints = {
  sourceFingerprint: "current",
  m1bSourceFingerprint: "m1b-current",
  lockFingerprint: "lock-current",
  testScriptFingerprint: "test-current",
  buildScriptFingerprint: "build-current",
};

function write(dir, file, data) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
}

function passing() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1b-report-"));
  const cases = required["cases.json"].map((def) => ({
    caseId: def.id,
    kind: def.kind,
    status: "passed",
    tests: def.tests.map((pattern) => ({ file: "tests/m1b/synthetic.test.ts", name: pattern, status: "passed" })),
  }));
  write(dir, "cases.json", { ...fingerprints, generator: "scripts/verify-m1b.mjs", productAcceptance: "not-run", cases });
  write(dir, "test-run.json", { ...fingerprints, status: "passed", productAcceptance: "not-run" });
  write(dir, "bench.json", {
    ...fingerprints,
    status: "passed",
    productAcceptance: "not-run",
    targets: requiredBenchTargets,
    metrics: Object.fromEntries(Object.keys(requiredBenchTargets).map((key) => [key, 1])),
    scale: requiredScale,
    raw: { searchMs: Array.from({ length: 20 }, () => 1), indexedFirstScreenMs: [1, 1, 1, 1, 1], reparseMs: [1, 1, 1], operationContentMs: [1, 1, 1, 1, 1, 1], operationSaveMs: [1, 1, 1, 1, 1, 1], windowContentMs: [1, 1, 1], windowSaveMs: [1, 1, 1], windowImportMs: [1, 1, 1] },
    scaleWindow: {
      kind: "electron-scale-profile",
      ok: true,
      scale: requiredScale,
      sizes: { txtBytes: 10 * 1024 * 1024, epubBytes: 30 * 1024 * 1024 + 1, backgroundBytes: 10 * 1024 * 1024 },
      raw: {
        ...Object.fromEntries(Object.values(scaleWindowSamples).map(([key, minimum]) => [key, Array.from({ length: minimum }, () => 1)])),
        samplesWhileParsing: [4, 4, 4],
      },
    },
    samples: {
      coldStartMs: { kind: "process" },
      interactionMs: { kind: "electron", waitedForContent: true },
      contentAvailableMs: { kind: "operation-to-content" },
      saveReceiptMs: { kind: "operation-to-commit-receipt" },
      windowContentMs: { kind: "electron-content-visible" },
      windowSaveMs: { kind: "electron-save-receipt" },
      windowImportMs: { kind: "electron-import-to-readable" },
    },
  });
  write(dir, "package.json", {
    ...fingerprints,
    status: "passed",
    productAcceptance: "not-run",
    output: "dist/m1a-package/MANGA-win32-x64",
    smoke: ["initial", "restart", "agent", "agent-restart", "reading", "closure", "closure-restart", "formats"],
    formats: { pages: true, modes: true, failureVisible: true },
    closure: {
      readLastChapter: true,
      recordedNote: true,
      sourceCardOk: true,
      restoredProgress: true,
      timings: { importMs: 1, tailMs: 1, noteMs: 1, selectionMs: 1 },
    },
  });
  return dir;
}

test("m1b report rejects a missing evidence file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1b-missing-"));
  const report = evaluateM1bEvidence(dir, fingerprints);
  assert.equal(report.engineeringReviewable, false);
  assert.equal(report.productAcceptance, "not-run");
  assert.ok(report.errors.some((error) => error.includes("missing")));
});

test("m1b report rejects a stale fingerprint and a failed case", () => {
  const dir = passing();
  const cases = JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8"));
  cases.m1bSourceFingerprint = "stale";
  cases.cases[0].status = "failed";
  fs.writeFileSync(path.join(dir, "cases.json"), JSON.stringify(cases));
  const report = evaluateM1bEvidence(dir, fingerprints);
  assert.equal(report.engineeringReviewable, false);
  assert.ok(report.errors.some((error) => error.includes("stale")));
});

test("m1b report does not treat a complete self-check as product acceptance", () => {
  const report = evaluateM1bEvidence(passing(), fingerprints);
  assert.deepEqual(report.errors, []);
  assert.equal(report.automationStatus, "self-check-passed");
  assert.equal(report.productAcceptance, "not-run");
});

test("m1b report rejects a package whose closure smoke did not really run", () => {
  const dir = passing();
  const pack = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  pack.closure.recordedNote = false;
  pack.smoke = pack.smoke.filter((phase) => phase !== "closure-restart");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pack));
  const report = evaluateM1bEvidence(dir, fingerprints);
  assert.equal(report.engineeringReviewable, false);
  assert.ok(report.errors.some((error) => error.includes("closure-restart smoke missing")));
  assert.ok(report.errors.some((error) => error.includes("closure recordedNote")));
});

test("m1b report rejects a required case that is mapped to the wrong test", () => {
  const dir = passing();
  const cases = JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8"));
  // An unrelated passing test must not satisfy a required case pattern.
  cases.cases[0].tests = cases.cases[0].tests.map((entry) => ({ ...entry, name: "some unrelated passing test" }));
  fs.writeFileSync(path.join(dir, "cases.json"), JSON.stringify(cases));
  const report = evaluateM1bEvidence(dir, fingerprints);
  assert.equal(report.engineeringReviewable, false);
  assert.ok(report.errors.some((error) => error.includes("missing test")));
});

test("m1b report rejects failed, empty and stale independent review evidence", () => {
  const dir = passing();
  for (const audit of [
    { ...fingerprints, status: "rework-required", observations: [{ status: "failed" }] },
    { ...fingerprints, status: "passed", observations: [] },
    { ...fingerprints, status: "passed", observations: [{ status: "failed" }] },
    { ...fingerprints, sourceFingerprint: "stale", status: "passed", observations: [{ status: "passed" }] },
  ]) {
    write(dir, "a-adversarial-review.json", audit);
    assert.equal(evaluateM1bEvidence(dir, fingerprints).engineeringReviewable, false);
  }
  write(dir, "a-adversarial-review.json", { ...fingerprints, status: "passed", observations: [{ status: "passed" }] });
  assert.equal(evaluateM1bEvidence(dir, fingerprints).engineeringReviewable, true);
});

test("m1b report rejects invalid, slow or inconsistent Electron timing samples", () => {
  for (const [key, metric, limit] of [
    ["windowContentMs", "contentAvailableP95Ms", 2000],
    ["windowSaveMs", "saveReceiptP95Ms", 1000],
    ["windowImportMs", "importToReadableP95Ms", 5000],
  ]) {
    for (const samples of [[1, 1, limit + 1], [-1, 1, 1], [null, 1, 1], ["fast", 1, 1], [2, 2, 2]]) {
      const dir = passing();
      const bench = JSON.parse(fs.readFileSync(path.join(dir, "bench.json"), "utf8"));
      bench.raw[key] = samples;
      // A service metric of 1 cannot hide an invalid or slower real-window sample.
      bench.metrics[metric] = 1;
      write(dir, "bench.json", bench);
      assert.equal(evaluateM1bEvidence(dir, fingerprints).engineeringReviewable, false, `${key}: ${JSON.stringify(samples)}`);
    }
  }
});

test("m1b report cannot hide the b6/b7/b8 independent dependency review behind passing self-checks", () => {
  for (const name of ["a-b6-deep-review.json", "a-b6-ui-review.json", "a-b7-rework-review.json", "a-b7-deep-review.json", "a-b7-ui-review.json", "a-b8-independent-review.json", "reader-engine-evidence.json"]) {
    const dir = passing();
    write(dir, name, { ...fingerprints, status: "rework-required", humanChecks: "not-run", productAcceptance: "not-run", observations: [{ status: "failed" }] });
    const report = evaluateM1bEvidence(dir, fingerprints);
    assert.equal(report.engineeringReviewable, false);
    assert.ok(report.errors.includes(`${name}: independent review failed or incomplete`));
  }
});

test("m1b report rejects a missing, undersized or inconsistent same-scale window run", () => {
  const variants = [
    (bench) => { delete bench.scaleWindow; },
    (bench) => { bench.scaleWindow.ok = false; },
    (bench) => { bench.scaleWindow.scale = { metadataCount: 30, searchBlocks: 30 }; },
    (bench) => { bench.scaleWindow.sizes.epubBytes = 1024; },
    (bench) => { bench.scaleWindow.raw.samplesWhileParsing = [0, 4, 4]; },
    (bench) => { bench.scaleWindow.raw.uiFeedbackMs = [1, 1]; },
    (bench) => { bench.scaleWindow.raw.largeTxtTailMs = [1, 1, 2001]; },
    (bench) => { bench.scaleWindow.raw.duringParseSaveMs = [-1]; },
    // A service or short-window figure written into the metric cannot replace the slow window sample.
    (bench) => { bench.scaleWindow.raw.saveReceiptMs = [1, 1, 1, 1, 1500]; bench.metrics.scaleSaveReceiptP95Ms = 1; },
    (bench) => { bench.metrics.scaleUiFeedbackP95Ms = 101; },
  ];
  for (const [index, mutate] of variants.entries()) {
    const dir = passing();
    const bench = JSON.parse(fs.readFileSync(path.join(dir, "bench.json"), "utf8"));
    mutate(bench);
    write(dir, "bench.json", bench);
    assert.equal(evaluateM1bEvidence(dir, fingerprints).engineeringReviewable, false, `variant ${index}`);
  }
});

test("m1b strict report requires the pdf counterexamples and a self-check does not", () => {
  const open = passing();
  assert.equal(evaluateM1bEvidence(open, fingerprints).engineeringReviewable, true);
  const missing = evaluateM1bEvidence(open, fingerprints, { requirePdfCounterexamples: true });
  assert.equal(missing.engineeringReviewable, false);
  assert.ok(missing.errors.some((error) => error.includes("a-adversarial-review.json")));
  const closed = passing();
  write(closed, "a-adversarial-review.json", {
    ...fingerprints,
    status: "passed",
    productAcceptance: "not-run",
    humanChecks: "not-run",
    observations: requiredPdfCounterexamples.map((name) => ({ name, status: "passed" })),
  });
  assert.equal(evaluateM1bEvidence(closed, fingerprints, { requirePdfCounterexamples: true }).engineeringReviewable, true);
  const partial = passing();
  write(partial, "a-adversarial-review.json", {
    ...fingerprints,
    status: "passed",
    productAcceptance: "not-run",
    humanChecks: "not-run",
    observations: [{ name: requiredPdfCounterexamples[0], status: "passed" }],
  });
  const incomplete = evaluateM1bEvidence(partial, fingerprints, { requirePdfCounterexamples: true });
  assert.equal(incomplete.engineeringReviewable, false);
  assert.ok(incomplete.errors.some((error) => error.includes("missing passed counterexample")));
});
