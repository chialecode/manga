import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateStageEvidence } from "./stage/report.mjs";
import { hashTree, loadGate, p95, p99 } from "./stage/lib.mjs";

// Counterexamples for the stage gate: each mutation of an otherwise complete run must be rejected.
const config = loadGate();
const { targets, scale: requiredScale, scaleWindowSamples } = config.bench;
const fingerprints = {
  sourceFingerprint: "current",
  lockFingerprint: "lock-current",
  testScriptFingerprint: "test-current",
  buildScriptFingerprint: "build-current",
};

function write(dir, file, data) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
}
function read(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
}
const evaluate = (dir) => evaluateStageEvidence(dir, fingerprints, config);

// The required patterns are anchored regular expressions; a synthetic name is the text they match.
const literal = (pattern) => pattern.replace(/^\^/, "").replace(/\$$/, "").replace(/\\(.)/g, "$1");

/** One creative measurement that meets what the gate asks of it: enough samples, at the size named, from the engine named. */
function creativeEntry(wanted) {
  const unverified = wanted.metric === "btUnverifiedPieces";
  // A figure that must be none (pieces left unchecked, whole-file reads made by an import) is none in the passing fixture.
  const none = unverified || targets[wanted.metric] === 0;
  const entry = { kind: unverified ? "loopback-bt-download" : wanted.scale?.cards || wanted.scale?.nodes ? "electron-canvas" : wanted.scale?.comments || wanted.scale?.runs ? "electron-reader" : wanted.scale?.videos ? "service-video-import" : "service-semantic-search", scale: { ...wanted.scale }, raw: Array.from({ length: wanted.minSamples }, () => (none ? 0 : 1)) };
  if (wanted.engine) entry.engine = wanted.engine;
  if (unverified) entry.detail = { pieces: Math.ceil(wanted.scale.bytes / 262144), pieceLength: 262144, verifiedPieces: Math.ceil(wanted.scale.bytes / 262144), unverifiedPieces: 0, sha256Matches: true, stagingLeft: false, counts: { failed: 0, published: 1 } };
  if (entry.kind === "electron-canvas" || entry.kind === "electron-reader") entry.detail = { ok: true };
  return entry;
}

function passing() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-stage-report-"));
  const cases = config.cases.map((def) => ({
    caseId: def.id,
    kind: def.kind,
    status: "passed",
    tests: def.tests.map((pattern) => ({ file: "tests/synthetic.test.ts", name: literal(pattern), status: "passed" })),
  }));
  write(dir, "cases.json", { ...fingerprints, generator: "scripts/stage/test.mjs", productAcceptance: "not-run", cases });
  write(dir, "test-run.json", { ...fingerprints, status: "passed", productAcceptance: "not-run" });
  write(dir, "bench.json", {
    ...fingerprints,
    status: "passed",
    productAcceptance: "not-run",
    targets,
    metrics: Object.fromEntries(Object.keys(targets).map((key) => [key, targets[key] === 0 ? 0 : 1])),
    creative: Object.fromEntries(Object.entries(config.bench.creative ?? {}).map(([id, wanted]) => [id, creativeEntry(wanted)])),
    scanPane: {
      ok: true,
      scan: {
        files: Array.from({ length: config.bench.scan.runs }, () => config.bench.scan.files),
        added: Array.from({ length: config.bench.scan.runs }, () => config.bench.scan.files),
        loopLag: { raw: Array.from({ length: config.bench.scan.minLagSamples }, () => 1) },
        interaction: { raw: Array.from({ length: config.bench.scan.minAnswerSamples }, () => 1) },
      },
      pane: { kind: "electron-pane-1000", loaded: [1000, 1000, 1000] },
    },
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
    measurements: Object.fromEntries((config.bench.measurements ?? []).map((item) => [item.id, { raw: Array.from({ length: item.minSamples ?? 3 }, () => 1), p95: 1 }])),
  });
  write(dir, "package.json", {
    ...fingerprints,
    status: "passed",
    productAcceptance: "not-run",
    output: "dist/desktop/packages/MANGA-win32-x64",
    electron: "44.5.1",
    smoke: config.package.smoke,
    formats: { pages: true, modes: true, failureVisible: true },
    viewports: { wide: { innerWidth: 1280 }, narrow: { innerWidth: 720 } },
    loop06: { settled: { stable: true }, tagged: true, repainted: false, atEnd: { nodeConnected: true } },
    agent: { runningShown: true, stoppedShown: true, conversationShown: true },
    windowWalk: { ok: true, observations: config.scenarios.length },
    creative: { ok: true, observations: 13 },
    trace: { ok: true, observations: 1 },
    plugins: { ok: true, steps: (config.package.pluginSteps ?? []).map((id) => ({ id, ok: true })) },
    assets: Object.fromEntries((config.package.assets ?? []).map((name) => [name, true])),
    readingLoop: {
      readLastChapter: true,
      recordedNote: true,
      sourceCardOk: true,
      restoredProgress: true,
      timings: { importMs: 1, tailMs: 1, noteMs: 1, selectionMs: 1 },
    },
  });
  if (config.scenarios?.length) {
    write(dir, "scenarios.json", { ...fingerprints, productAcceptance: "not-run", observations: config.scenarios.map((name) => ({ name, status: "passed" })) });
  }
  return dir;
}

test("report rejects a missing evidence file", () => {
  const report = evaluate(fs.mkdtempSync(path.join(os.tmpdir(), "manga-stage-missing-")));
  assert.equal(report.engineeringReviewable, false);
  assert.equal(report.productAcceptance, "not-run");
  assert.ok(report.errors.some((error) => error.includes("missing")));
});

test("report rejects a stale fingerprint and a failed case", () => {
  const dir = passing();
  const cases = read(dir, "cases.json");
  cases.sourceFingerprint = "stale";
  cases.cases[0].status = "failed";
  write(dir, "cases.json", cases);
  const report = evaluate(dir);
  assert.equal(report.engineeringReviewable, false);
  assert.ok(report.errors.some((error) => error.includes("stale")));
});

test("report does not treat a complete self-check as product acceptance", () => {
  const report = evaluate(passing());
  assert.deepEqual(report.errors, []);
  assert.equal(report.automationStatus, "self-check-passed");
  assert.equal(report.productAcceptance, "not-run");
});

test("report rejects a package whose reading-loop smoke did not really run", () => {
  const dir = passing();
  const pack = read(dir, "package.json");
  pack.readingLoop.recordedNote = false;
  pack.smoke = pack.smoke.filter((phase) => phase !== "reading-loop-restart");
  write(dir, "package.json", pack);
  const report = evaluate(dir);
  assert.equal(report.engineeringReviewable, false);
  assert.ok(report.errors.some((error) => error.includes("reading-loop-restart smoke missing")));
  assert.ok(report.errors.some((error) => error.includes("reading-loop recordedNote")));
});

test("report rejects a package without a runtime version or without a required packaged asset", () => {
  const dir = passing();
  const pack = read(dir, "package.json");
  delete pack.electron;
  const asset = (config.package.assets ?? [])[0];
  if (asset) pack.assets[asset] = false;
  write(dir, "package.json", pack);
  const report = evaluate(dir);
  assert.equal(report.engineeringReviewable, false);
  assert.ok(report.errors.some((error) => error.includes("Electron version")));
  if (asset) assert.ok(report.errors.some((error) => error.includes(`asset ${asset}`)));
});

test("report rejects a required case that is mapped to the wrong test", () => {
  const dir = passing();
  const cases = read(dir, "cases.json");
  // An unrelated passing test must not satisfy a required case pattern.
  cases.cases[0].tests = cases.cases[0].tests.map((entry) => ({ ...entry, name: "some unrelated passing test" }));
  write(dir, "cases.json", cases);
  const report = evaluate(dir);
  assert.equal(report.engineeringReviewable, false);
  assert.ok(report.errors.some((error) => error.includes("missing test")));
});

test("report rejects a missing, failed or stale scenario observation", () => {
  if (!config.scenarios?.length) return;
  const mutations = [
    (data) => { data.observations = data.observations.slice(1); },
    (data) => { data.observations[0].status = "failed"; },
    (data) => { data.sourceFingerprint = "stale"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const dir = passing();
    const data = read(dir, "scenarios.json");
    mutate(data);
    write(dir, "scenarios.json", data);
    assert.equal(evaluate(dir).engineeringReviewable, false, `variant ${index}`);
  }
});

test("report rejects invalid, slow or inconsistent Electron timing samples", () => {
  for (const [key, metric] of [["windowContentMs", "contentAvailableP95Ms"], ["windowSaveMs", "saveReceiptP95Ms"], ["windowImportMs", "importToReadableP95Ms"]]) {
    const limit = targets[metric];
    for (const samples of [[1, 1, limit + 1], [-1, 1, 1], [null, 1, 1], ["fast", 1, 1], [2, 2, 2]]) {
      const dir = passing();
      const bench = read(dir, "bench.json");
      bench.raw[key] = samples;
      // A service metric of 1 cannot hide an invalid or slower real-window sample.
      bench.metrics[metric] = 1;
      write(dir, "bench.json", bench);
      assert.equal(evaluate(dir).engineeringReviewable, false, `${key}: ${JSON.stringify(samples)}`);
    }
  }
});

test("report rejects a missing, undersized or inconsistent same-scale window run", () => {
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
    const bench = read(dir, "bench.json");
    mutate(bench);
    write(dir, "bench.json", bench);
    assert.equal(evaluate(dir).engineeringReviewable, false, `variant ${index}`);
  }
});

test("report rejects a 5000-file scan that fell short, or a gated figure that does not follow from its samples", () => {
  const variants = [
    (bench) => { bench.scanPane.ok = false; },
    (bench) => { bench.scanPane.scan.files[0] = 100; },
    (bench) => { bench.scanPane.scan.added[1] = 100; },
    (bench) => { bench.scanPane.scan.files = [config.bench.scan.files]; bench.scanPane.scan.added = [config.bench.scan.files]; },
    (bench) => { bench.scanPane.scan.loopLag.raw = [1, 1, 1]; },
    (bench) => { bench.scanPane.scan.loopLag.raw[0] = -1; },
    // One long stall among many short delays moves the p99 only when the samples say so; the metric has to follow them.
    (bench) => { bench.scanPane.scan.loopLag.raw = bench.scanPane.scan.loopLag.raw.map((_, index) => (index % 50 === 0 ? 400 : 1)); bench.metrics.scanEventLoopP99Ms = 1; },
    (bench) => { bench.scanPane.scan.interaction.raw = bench.scanPane.scan.interaction.raw.map((_, index) => (index % 10 === 0 ? 300 : 1)); bench.metrics.scanInteractionP95Ms = 1; },
    (bench) => { bench.scanPane.scan.interaction.raw = [1, 1, 1]; },
    (bench) => { bench.metrics.scanEventLoopP99Ms = targets.scanEventLoopP99Ms + 1; },
    (bench) => { bench.scanPane.pane.loaded = [1000, 999, 1000]; },
    (bench) => { bench.scanPane.pane.kind = "service"; },
  ];
  for (const [index, mutate] of variants.entries()) {
    const dir = passing();
    const bench = read(dir, "bench.json");
    mutate(bench);
    write(dir, "bench.json", bench);
    assert.equal(evaluate(dir).engineeringReviewable, false, `variant ${index}`);
  }
  // The two gated figures are exactly the p99 / p95 of the raw samples.
  const dir = passing();
  const bench = read(dir, "bench.json");
  bench.scanPane.scan.loopLag.raw = bench.scanPane.scan.loopLag.raw.map((_, index) => (index % 200 === 0 ? 40 : 2));
  bench.scanPane.scan.interaction.raw = bench.scanPane.scan.interaction.raw.map((_, index) => (index % 20 === 0 ? 30 : 3));
  bench.metrics.scanEventLoopP99Ms = p99(bench.scanPane.scan.loopLag.raw);
  bench.metrics.scanInteractionP95Ms = p95(bench.scanPane.scan.interaction.raw);
  write(dir, "bench.json", bench);
  assert.deepEqual(evaluate(dir).errors, []);
});

test("report rejects a package run that lost the PDF selection, the agent controls or the window walk", () => {
  const variants = [
    (pack) => { pack.loop06.repainted = true; },
    (pack) => { pack.loop06.tagged = false; },
    (pack) => { pack.loop06.atEnd.nodeConnected = false; },
    (pack) => { pack.loop06.settled.stable = false; },
    (pack) => { delete pack.loop06; },
    (pack) => { pack.agent.stoppedShown = false; },
    (pack) => { pack.agent.conversationShown = false; },
    (pack) => { pack.windowWalk.ok = false; },
    (pack) => { pack.windowWalk.observations = 3; },
    (pack) => { pack.smoke = pack.smoke.filter((phase) => phase !== "window-walk"); },
    (pack) => { pack.smoke = pack.smoke.filter((phase) => phase !== "creative"); },
    (pack) => { pack.smoke = pack.smoke.filter((phase) => phase !== "plugins"); },
    (pack) => { pack.smoke = pack.smoke.filter((phase) => phase !== "trace"); },
    (pack) => { pack.creative.ok = false; },
    (pack) => { pack.trace.ok = false; },
    (pack) => { delete pack.trace; },
    (pack) => { pack.plugins.ok = false; },
    (pack) => { pack.plugins.steps = pack.plugins.steps.filter((step) => step.id !== "magnet-secret-never-shown-or-logged"); },
    (pack) => { pack.plugins.steps[0].ok = false; },
    (pack) => { delete pack.viewports.narrow; },
  ];
  for (const [index, mutate] of variants.entries()) {
    const dir = passing();
    const pack = read(dir, "package.json");
    mutate(pack);
    write(dir, "package.json", pack);
    assert.equal(evaluate(dir).engineeringReviewable, false, `variant ${index}`);
  }
});

test("report rejects a creative figure that is short of samples, size or engine, or does not follow from its samples", () => {
  const variants = [];
  for (const [id, wanted] of Object.entries(config.bench.creative ?? {})) {
    variants.push((bench) => { delete bench.creative[id]; });
    variants.push((bench) => { bench.creative[id].raw = bench.creative[id].raw.slice(1); if (wanted.minSamples === 1) bench.creative[id].raw = []; });
    variants.push((bench) => { bench.creative[id].raw[0] = -1; });
    for (const name of Object.keys(wanted.scale ?? {})) variants.push((bench) => { bench.creative[id].scale[name] = 1; });
    if (wanted.engine) variants.push((bench) => { bench.creative[id].engine = "other"; });
    if (wanted.stat === "p95") variants.push((bench) => { bench.creative[id].raw = bench.creative[id].raw.map(() => 5000); });
    if (wanted.stat === "max" && targets[wanted.metric] !== 0) variants.push((bench) => { bench.creative[id].raw[0] = 5000; });
    if (wanted.scale?.videos && targets[wanted.metric] === 0) variants.push((bench) => { bench.creative[id].raw[0] = 1; bench.metrics[wanted.metric] = 1; });
    if (id === "btLoopback") variants.push((bench) => { bench.creative[id].detail.unverifiedPieces = 1; });
    if (id === "btLoopback") variants.push((bench) => { bench.creative[id].detail.stagingLeft = true; });
    if (wanted.scale?.cards || wanted.scale?.nodes || wanted.scale?.comments || wanted.scale?.runs) variants.push((bench) => { bench.creative[id].detail.ok = false; });
  }
  for (const [index, mutate] of variants.entries()) {
    const dir = passing();
    const bench = read(dir, "bench.json");
    mutate(bench);
    write(dir, "bench.json", bench);
    assert.equal(evaluate(dir).engineeringReviewable, false, `variant ${index}`);
  }
});

test("report requires every measurement-only figure to carry its raw samples", () => {
  for (const item of config.bench.measurements ?? []) {
    for (const mutate of [
      (bench) => { delete bench.measurements[item.id]; },
      (bench) => { bench.measurements[item.id].raw = []; },
      (bench) => { bench.measurements[item.id].raw[0] = -1; },
      (bench) => { bench.measurements[item.id].p95 = 99; },
    ]) {
      const dir = passing();
      const bench = read(dir, "bench.json");
      mutate(bench);
      write(dir, "bench.json", bench);
      assert.equal(evaluate(dir).engineeringReviewable, false, item.id);
    }
  }
});

test("report accepts declared blocked and not-run limits only with an owner and a retest entry", () => {
  const dir = passing();
  write(dir, "limits.json", { entries: [{ id: "bangumi-live", status: "blocked", owner: "user", retest: "BANGUMI_LIVE=1 node scripts/stage.mjs test" }] });
  assert.equal(evaluate(dir).engineeringReviewable, true);
  write(dir, "limits.json", { entries: [{ id: "bangumi-live", status: "blocked" }] });
  assert.equal(evaluate(dir).engineeringReviewable, false);
  write(dir, "limits.json", { entries: [{ id: "x", status: "passed", owner: "a", retest: "b" }] });
  assert.equal(evaluate(dir).engineeringReviewable, false);
});

test("a fingerprint follows the stored text, not the line ends a tool left in the working tree", () => {
  const make = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-stage-hash-"));
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
    return dir;
  };
  const lf = make({ "a.ts": "one\ntwo\n", "b.bin": Buffer.from([0, 13, 10, 1]) });
  const crlf = make({ "a.ts": "one\r\ntwo\r\n", "b.bin": Buffer.from([0, 13, 10, 1]) });
  assert.equal(hashTree(lf, ["a.ts", "b.bin"]), hashTree(crlf, ["a.ts", "b.bin"]));
  // A changed character still changes it, and binary bytes are never rewritten.
  const edited = make({ "a.ts": "one\r\ntwo!\r\n", "b.bin": Buffer.from([0, 13, 10, 1]) });
  assert.notEqual(hashTree(lf, ["a.ts"]), hashTree(edited, ["a.ts"]));
  const binary = make({ "a.ts": "one\ntwo\n", "b.bin": Buffer.from([0, 10, 1]) });
  assert.notEqual(hashTree(lf, ["b.bin"]), hashTree(binary, ["b.bin"]));
  for (const dir of [lf, crlf, edited, binary]) fs.rmSync(dir, { recursive: true, force: true });
});
