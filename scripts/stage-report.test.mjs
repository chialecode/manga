import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateStageEvidence } from "./stage/report.mjs";
import { fingerprintKey, findUncommentedSmokeSleeps, hashTree, loadGate, p95, p99, stageFingerprints } from "./stage/lib.mjs";
import { beginTestEvidence } from "./stage/test.mjs";

// Counterexamples for the stage gate: each mutation of an otherwise complete run must be rejected.
const config = loadGate();
const { targets, scale: requiredScale, scaleWindowSamples } = config.bench;
// One synthetic fingerprint per group of gate.json (source, lock, build, gate, and each entry's own code).
const fingerprints = Object.fromEntries(Object.keys(config.fingerprint).map((group) => [fingerprintKey(group), `${group}-current`]));

function write(dir, file, data) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
}
function read(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
}
const evaluate = (dir, now = fingerprints) => evaluateStageEvidence(dir, now, config);

const scratchDirs = [];
function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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
  const dir = scratch("manga-stage-report-");
  const updateCases = ["restart", "quit"].map((mode) => ({
    mode, downloader: "electron-updater", downloadBytes: mode === "restart" ? 2048 : 512, fullBytes: 2048, readyMs: 3000,
    usedDifferential: mode === "quit", oldProcessExited: true, newProcessStarted: true, verifiedInstallerExecuted: true,
    draftWasUnsaved: true, draftPreserved: true, backupContainsSavedDraft: true, workspaceRestored: true,
  }));
  const update = { downloadBytes: { fullBytes: 2048, differentialBytes: 512, savedRatio: 0.75 }, restartToReadyMs: 3000, installDevMs: 2000 };
  const cases = config.cases.map((def) => ({
    caseId: def.id,
    kind: def.kind,
    status: "passed",
    tests: def.tests.map((pattern) => ({ file: "tests/synthetic.test.ts", name: literal(pattern), status: "passed" })),
  }));
  write(dir, "cases.json", { ...fingerprints, generator: "scripts/stage/test.mjs", productAcceptance: "not-run", cases });
  write(dir, "test-run.json", { ...fingerprints, status: "passed", productAcceptance: "not-run", tempDirs: { before: 0, after: 0, removed: 1, left: 0, prefixes: [] } });
  write(dir, "bench.json", {
    ...fingerprints,
    status: "passed",
    productAcceptance: "not-run",
    records: { update: { kind: "electron-nsis", artifactKind: "test-identity-repackage", sourceEvidence: "installer.json", ...update, stageReleaseMs: null, stageRelease: { status: "not-run" } } },
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
    light: {
      kind: "electron-light-open",
      ok: true,
      failures: [],
      raw: {
        videoFirstFrameMs: Array.from({ length: config.bench.light?.runs ?? 5 }, () => 1),
        comicFirstPageMs: Array.from({ length: config.bench.light?.runs ?? 5 }, () => 1),
        secondOpenMs: Array.from({ length: config.bench.light?.runs ?? 5 }, () => 1),
      },
      records: {
        workingSetMiB: Array.from({ length: config.bench.light?.runs ?? 5 }, () => 120),
        firstEverMs: 900,
        fullAppOpenVideo: { firstFrameMs: 1400, listedMs: 600, note: "full app comparison" },
      },
    },
  });
  const installerSteps = [
    { name: 'release: "Open with" registered for 16 types, extension defaults untouched', ok: true },
    { name: 'development: "Open with" registered for 16 types, extension defaults untouched', ok: true },
    { name: 'release: the registered "Open with" command starts light open on the file', ok: true },
    { name: 'release: "Open with" registration preserved after 0.1.1 -> 0.1.2 over-install, extension defaults untouched', ok: true },
    { name: "update-rollback: two failed starts ask; 再试一次 keeps the new version", ok: true },
    { name: "update-rollback: 回到 0.1.1 reinstalls it, puts the backup back, keeps the library in use, skips 0.1.2 and logs it", ok: true },
    { name: "update-rollback", ok: true },
    { name: 'development: "Open with" registration removed, extension defaults untouched', ok: true },
    { name: 'release: "Open with" registration unaffected by development uninstall, extension defaults untouched', ok: true },
    { name: 'release: "Open with" registration removed, extension defaults untouched', ok: true },
  ];
  write(dir, "installer.json", {
    ...fingerprints, status: "passed", steps: installerSteps, updateRehearsal: {
      kind: "electron-nsis", artifactKind: "test-identity-repackage", ok: true, verifiedInstallerExecuted: true,
      dataIntact: true, backupCreated: true, tamperedRejected: true, justUpdatedOnce: true, realInstallationsUntouched: true,
      appAsarSha256: "a".repeat(64), previousAsarSha256: "a".repeat(64), cases: updateCases, records: update,
      development: { kind: "electron-nsis", timeoutMs: 30_000, installDevMs: 2000, installed: true, relaunched: true,
        draftWasUnsaved: true, draftPreserved: true, releaseProcessKeptRunning: true, releaseExecutableUntouched: true,
        timedOutWithoutForceKill: true, stayedAliveAfterWriteCompleted: true },
    },
  });
  write(dir, "package.json", {
    ...fingerprints,
    status: "passed",
    passStreak: config.package.passStreak ?? 1,
    productAcceptance: "not-run",
    output: "dist/desktop/packages/manga-win32-x64",
    electron: "44.5.1",
    smoke: config.package.smoke,
    formats: { pages: true, contexts: true, failureVisible: true },
    viewports: { wide: { innerWidth: 1280 }, narrow: { innerWidth: 720 } },
    loop06: { settled: { stable: true }, tagged: true, repainted: false, atEnd: { nodeConnected: true } },
    agent: { runningShown: true, stoppedShown: true, conversationShown: true },
    windowWalk: { ok: true, observations: config.scenarios.length, seconds: 1 },
    phaseTimings: { "window-walk": 1 },
    tempDirs: { removed: 1, left: 0, prefixes: [] },
    creative: { ok: true, observations: 13 },
    trace: { ok: true, observations: 1 },
    plugins: { ok: true, steps: (config.package.pluginSteps ?? []).map((id) => ({ id, ok: true })) },
    assets: Object.fromEntries((config.package.assets ?? []).map((name) => [name, true])),
    light: { ok: true, timings: { videoFirstFrameMs: 450, comicFirstPageMs: 320, videoMemoryMiB: 118 } },
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
  const report = evaluate(scratch("manga-stage-missing-"));
  assert.equal(report.engineeringReviewable, false);
  assert.equal(report.productAcceptance, "not-run");
  assert.ok(report.errors.some((error) => error.includes("missing")));
});

test("update evidence rejects service fixtures, a different executed installer, lost drafts and late exit after timeout", () => {
  for (const mutate of [
    (rehearsal) => { rehearsal.kind = "service-fixtures"; },
    (rehearsal) => { rehearsal.cases[0].verifiedInstallerExecuted = false; },
    (rehearsal) => { rehearsal.cases[1].backupContainsSavedDraft = false; },
    (rehearsal) => { rehearsal.cases[1].downloadBytes = rehearsal.cases[1].fullBytes; },
    (rehearsal) => { rehearsal.development.stayedAliveAfterWriteCompleted = false; },
  ]) {
    const dir = passing();
    const installer = read(dir, "installer.json");
    mutate(installer.updateRehearsal);
    write(dir, "installer.json", installer);
    const report = evaluate(dir);
    assert.equal(report.engineeringReviewable, false);
    assert.ok(report.errors.some((error) => error.startsWith("installer.json:")));
  }
});

test("update timing records must follow real installer evidence and explicitly distinguish an unrun release", () => {
  for (const mutate of [
    (records) => { records.restartToReadyMs = 20; },
    (records) => { records.downloadBytes.differentialBytes = 1; },
    (records) => { records.stageReleaseMs = 144; },
    (records) => { records.stageRelease = { status: "measured", sourceEvidence: "release.json" }; records.stageReleaseMs = 144; },
  ]) {
    const dir = passing();
    const bench = read(dir, "bench.json");
    mutate(bench.records.update);
    write(dir, "bench.json", bench);
    assert.equal(evaluate(dir).engineeringReviewable, false);
  }
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

test("a result goes stale only with the inputs it depends on (gate.json fingerprintOf)", () => {
  assert.equal(evaluate(passing()).engineeringReviewable, true);
  // The bench's own code changed: only the bench is stale.
  const benchOnly = evaluate(passing(), { ...fingerprints, benchScriptFingerprint: "bench-edited" });
  assert.deepEqual(benchOnly.errors.filter((error) => error.includes("stale")).map((error) => error.split(":")[0]), ["bench.json"]);
  // The tests changed: the test results only; the package and the bench were not made from them.
  const testOnly = evaluate(passing(), { ...fingerprints, testScriptFingerprint: "test-edited" });
  assert.deepEqual(testOnly.errors.filter((error) => error.includes("stale")).map((error) => error.split(":")[0]).sort(), ["cases.json", "test-run.json"]);
  // The product source changed: every result is stale.
  const source = evaluate(passing(), { ...fingerprints, sourceFingerprint: "source-edited" });
  const stale = new Set(source.errors.filter((error) => error.includes("stale")).map((error) => error.split(":")[0]));
  for (const file of ["cases.json", "test-run.json", "bench.json", "package.json", "installer.json", ...(config.scenarios?.length ? ["scenarios.json"] : [])]) assert.ok(stale.has(file), file);
  // A window walk changed: only the package results; the bench, the installer and the tests did not run it.
  const walkOnly = evaluate(passing(), { ...fingerprints, smokeWalkScriptFingerprint: "walk-edited" });
  assert.deepEqual(walkOnly.errors.filter((error) => error.includes("stale")).map((error) => error.split(":")[0]).sort(), ["package.json", ...(config.scenarios?.length ? ["scenarios.json"] : [])]);
  // A bench driver changed: only the bench.
  const benchDriver = evaluate(passing(), { ...fingerprints, smokeBenchScriptFingerprint: "bench-driver-edited" });
  assert.deepEqual(benchDriver.errors.filter((error) => error.includes("stale")).map((error) => error.split(":")[0]), ["bench.json"]);
});

test("the window walks are left out of the product source and fingerprinted by their own groups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-fingerprint-"));
  try {
    const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
    write("apps/desktop/src/main/index.ts", "product");
    write("apps/desktop/src/main/smoke/loop-walk.ts", "walk");
    const source = () => hashTree(root, ["apps/desktop", "!apps/desktop/src/main/smoke"]);
    const walk = () => hashTree(root, ["apps/desktop/src/main/smoke/loop-walk.ts"]);
    const [sourceBefore, walkBefore] = [source(), walk()];
    write("apps/desktop/src/main/smoke/loop-walk.ts", "walk edited");
    assert.equal(source(), sourceBefore);
    assert.notEqual(walk(), walkBefore);
    write("apps/desktop/src/main/index.ts", "product edited");
    assert.notEqual(source(), sourceBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // Every walk file is named by a group: a new walk that no group names is refused, not silently left out of every fingerprint.
  const narrowed = { ...config, fingerprint: { ...config.fingerprint, smokeWalk: config.fingerprint.smokeWalk.filter((entry) => !entry.endsWith("/loop-walk.ts")) } };
  assert.throws(() => stageFingerprints(process.cwd(), narrowed), /loop-walk.ts/);
});

test("every file of the gate's code belongs to a fingerprint group", () => {
  assert.doesNotThrow(() => stageFingerprints(process.cwd(), config));
  const narrowed = { ...config, fingerprint: { ...config.fingerprint, bench: config.fingerprint.bench.filter((entry) => entry !== "scripts/stage/bench-bt.mjs") } };
  assert.throws(() => stageFingerprints(process.cwd(), narrowed), /bench-bt.mjs/);
});

test("report rejects a package short of its consecutive passes, and a missing or failed installation", () => {
  const short = passing();
  const pack = read(short, "package.json");
  pack.passStreak = (config.package.passStreak ?? 1) - 1;
  write(short, "package.json", pack);
  assert.ok(evaluate(short).errors.some((error) => error.includes("consecutive passes")));
  const failed = passing();
  write(failed, "installer.json", { ...fingerprints, status: "failed" });
  assert.ok(evaluate(failed).errors.some((error) => error.includes("installer.json")));
  const missing = passing();
  fs.rmSync(path.join(missing, "installer.json"));
  assert.ok(evaluate(missing).errors.some((error) => error.includes("installer.json")));
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
    (pack) => { delete pack.windowWalk.seconds; },
    (pack) => { pack.windowWalk.seconds = config.package.windowWalkMaxSeconds + 1; pack.phaseTimings["window-walk"] = pack.windowWalk.seconds; },
    (pack) => { pack.phaseTimings["window-walk"] = 2; },
    (pack) => { pack.tempDirs.left = 1; },
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

test("report rejects a test-run that left temporary directories behind (LOOP-28)", () => {
  const dir = passing();
  const run = read(dir, "test-run.json");
  run.tempDirs = { before: 0, after: 2, removed: 1, left: 2, prefixes: ["manga-test-"] };
  write(dir, "test-run.json", run);
  const report = evaluate(dir);
  assert.equal(report.engineeringReviewable, false);
  assert.ok(report.errors.some((error) => error.includes("temporary directories left behind")));
});

test("starting another test attempt invalidates an earlier pass even if the new runner never produces a report", () => {
  const dir = passing();
  assert.equal(evaluate(dir).engineeringReviewable, true);
  beginTestEvidence(dir, fingerprints);
  assert.equal(fs.existsSync(path.join(dir, "cases.json")), false);
  assert.equal(read(dir, "test-run.json").status, "running");
  assert.equal(evaluate(dir).engineeringReviewable, false);
  write(dir, "test-run.json", { ...fingerprints, status: "failed", productAcceptance: "not-run" });
  assert.equal(evaluate(dir).engineeringReviewable, false);
});

test("report requires actual temporary directory counts instead of treating absent counts as zero", () => {
  const dir = passing();
  const run = read(dir, "test-run.json");
  delete run.tempDirs;
  write(dir, "test-run.json", run);
  assert.equal(evaluate(dir).engineeringReviewable, false);
});

test("smoke directory has zero uncommented sleep( calls, and counterexample is caught (LOOP-29)", () => {
  assert.deepEqual(findUncommentedSmokeSleeps(), []);
  const fakeSmoke = scratch("manga-smoke-sleep-");
  fs.writeFileSync(path.join(fakeSmoke, "walk.ts"), [
    "export function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }",
    "await sleep(200); // real time: hold key duration",
    "await sleep(300);",
  ].join("\n"));
  assert.deepEqual(findUncommentedSmokeSleeps(fakeSmoke), ["walk.ts:3: await sleep(300);"]);
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

test("report enforces packaged light open smoke, bench light raw samples/p95/records, and installer rollback/OpenWith steps", () => {
  // 1. `package.json`: `pack.light` must pass with finite timings and working-set memory.
  for (const mutate of [
    (pack) => { delete pack.light; },
    (pack) => { pack.light.ok = false; },
    (pack) => { delete pack.light.timings.videoFirstFrameMs; },
    (pack) => { pack.light.timings.comicFirstPageMs = -1; },
    (pack) => { pack.light.timings.videoMemoryMiB = 0; },
  ]) {
    const dir = passing();
    const pack = read(dir, "package.json");
    mutate(pack);
    write(dir, "package.json", pack);
    const report = evaluate(dir);
    assert.equal(report.engineeringReviewable, false);
    assert.ok(report.errors.some((error) => error.includes("package.json: light open smoke")));
  }

  // 2. `bench.json`: `bench.light` raw samples, p95 agreement, workingSetMiB and fullAppOpenVideo comparison record.
  for (const [index, mutate] of [
    (bench) => { delete bench.light; },
    (bench) => { bench.light.ok = false; },
    (bench) => { bench.light.kind = "service"; },
    (bench) => { bench.light.failures = ["video run 1 failed"]; },
    (bench) => { bench.light.raw.videoFirstFrameMs = [1, 1, 1, 1]; },
    (bench) => { bench.light.raw.comicFirstPageMs = [-1, 1, 1, 1, 1]; },
    (bench) => { bench.light.raw.secondOpenMs = [1, 1, 1, 1, 400]; bench.metrics.lightSecondOpenMs = 1; },
    (bench) => { bench.light.raw.secondOpenMs = [900, 900, 900, 900, 900]; bench.metrics.lightSecondOpenMs = 900; },
    (bench) => { bench.light.records.workingSetMiB = [120, 120]; },
    (bench) => { bench.light.records.workingSetMiB[0] = 0; },
    (bench) => { delete bench.light.records.fullAppOpenVideo; },
    (bench) => { bench.light.records.fullAppOpenVideo.firstFrameMs = 0; },
    (bench) => { bench.light.records.fullAppOpenVideo.listedMs = null; },
  ].entries()) {
    const dir = passing();
    const bench = read(dir, "bench.json");
    mutate(bench);
    write(dir, "bench.json", bench);
    const report = evaluate(dir);
    assert.equal(report.engineeringReviewable, false, `bench.light variant ${index}`);
    assert.ok(report.errors.some((error) => error.startsWith("bench.json:")), `bench.light error ${index}`);
  }
  {
    const dir = passing();
    const bench = read(dir, "bench.json");
    bench.light.raw.videoFirstFrameMs = [310, 320, 330, 340, 480];
    bench.light.raw.comicFirstPageMs = [200, 210, 220, 240, 350];
    bench.light.raw.secondOpenMs = [120, 130, 140, 150, 260];
    bench.metrics.lightVideoFirstFrameMs = p95(bench.light.raw.videoFirstFrameMs);
    bench.metrics.lightComicFirstPageMs = p95(bench.light.raw.comicFirstPageMs);
    bench.metrics.lightSecondOpenMs = p95(bench.light.raw.secondOpenMs);
    write(dir, "bench.json", bench);
    assert.deepEqual(evaluate(dir).errors, []);
  }

  // 3. `installer.json`: `update-rollback` and `Open with` registration / over-install / cross-channel / uninstall steps.
  for (const [index, dropPattern] of [
    /^update-rollback$/,
    /^update-rollback: 回到 /,
    /^release: "Open with" registered for /,
    /^development: "Open with" registered for /,
    /starts light open on the file/,
    /0\.1\.1 -> 0\.1\.2 over-install/,
    /unaffected by development uninstall/,
    /^development: "Open with" registration removed/,
    /^release: "Open with" registration removed/,
  ].entries()) {
    const dir = passing();
    const installer = read(dir, "installer.json");
    installer.steps = installer.steps.filter((step) => !dropPattern.test(step.name));
    write(dir, "installer.json", installer);
    const report = evaluate(dir);
    assert.equal(report.engineeringReviewable, false, `installer step variant ${index}`);
    assert.ok(report.errors.some((error) => error.startsWith("installer.json:")), `installer step error ${index}`);
  }
});
