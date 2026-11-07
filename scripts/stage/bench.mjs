import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { MangaProductApp, TestVault } from "../../packages/app-core/src/index.ts";
import { stageFingerprints, currentStage, loadGate, runDir, p95, repoRoot as root, packagedExecutable } from "./lib.mjs";
import { NORMALIZATION_V1 } from "../../packages/contracts/src/index.ts";
import { runScaleWindowBench, spawnWindow } from "./bench-scale.mjs";
import { runScanPaneBench } from "./bench-scan-pane.mjs";
import { runBtBench } from "./bench-bt.mjs";
import { runCanvasBench } from "./bench-canvas.mjs";
import { runNoteFileBench, runRoughcutBench, runSemanticBench, runTraceBench } from "./bench-creative.mjs";
import { runReaderBench } from "./bench-reader.mjs";
import { runWorkspaceBench } from "./bench-workspace.mjs";
import { runVideoImportBench } from "./bench-import.mjs";

const stage = currentStage();
const config = loadGate();
const requiredBenchTargets = config.bench.targets;
const requiredScale = config.bench.scale;
const METADATA = requiredScale.metadataCount;
const BLOCKS = requiredScale.searchBlocks;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-"));
const evidence = runDir();
const app = new MangaProductApp({
  profileRoot: profile,
  documentsDir: path.join(profile, "documents"),
  pointerPath: path.join(profile, "launcher", "pointer.json"),
  channel: "test",
  hostId: "bench",
  vault: new TestVault("bench"),
  useParseWorker: true,
});
await app.start();
const actor = { kind: "user", id: "bench" };
const grant = app.issueOwnerGrant(actor);
// A file is read from a library path (A-80): the folder the bench's books lie in is one.
const books = path.join(profile, "books");
fs.mkdirSync(books, { recursive: true });
const booksPath = await app.call(actor, { commandId: "library.paths.add", idempotencyKey: "bench-books", input: { pathHandle: app.registerPath("directory", books), mediaKind: "novel", autoScan: false } }, grant.handle);
if (booksPath.status !== "ok") throw new Error(booksPath.error?.message ?? "the library path for the bench's books could not be added");
const now = new Date().toISOString();
app.store.sqlite.exec("BEGIN");
const insertResource = app.store.sqlite.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)");
const insertRevision = app.store.sqlite.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)");
for (let i = 0; i < METADATA; i += 1) {
  const resourceId = `res_b${i}`;
  insertResource.run(resourceId, null, "novel", `r${i}`, JSON.stringify([`r${i}`]), now);
  insertRevision.run(`rev_b${i}`, resourceId, `fp${i}`, "bench-parser", JSON.stringify({ normalized: `检索块 ${i} 日本語` }), now);
}
for (let i = 0; i < BLOCKS; i += 1) {
  const resourceId = `res_b${i % METADATA}`;
  for (const mutation of app.store.indexFragment({ id: `frag_b${i}`, resourceId, resourceRevisionId: `rev_b${i % METADATA}`, partId: "body", start: 0, end: 8, kind: "body", text: `检索块 ${i} 日本語 中文` })) {
    app.store.sqlite.prepare(mutation.sql).run(...(mutation.params ?? []));
  }
}
app.store.sqlite.exec("COMMIT");

async function sample(times, run) {
  const values = [];
  for (let i = 0; i < times; i += 1) values.push(await run(i));
  return values;
}
const searchMs = await sample(40, async (i) => {
  const started = performance.now();
  const result = await app.call(actor, { commandId: "library.find", idempotencyKey: `s-${i}`, input: { text: "检索" } }, grant.handle);
  if (result.status !== "ok") throw new Error(result.error?.message ?? "search failed");
  return performance.now() - started;
});
const saveMs = await sample(10, async (i) => {
  const started = performance.now();
  const result = await app.call(actor, { commandId: "notes.create", idempotencyKey: `save-${i}`, input: { title: `bench-${i}`, text: "保存样本" } }, grant.handle);
  if (result.status !== "ok") throw new Error(result.error?.message ?? "save failed");
  return performance.now() - started;
});
const progressSaveMs = await sample(10, async (i) => {
  const started = performance.now();
  const result = await app.call(actor, {
    commandId: "progress.set",
    idempotencyKey: `progress-${i}`,
    input: {
      contextId: null,
      resourceId: "res_b0",
      resourceRevisionId: "rev_b0",
      consumed: false,
      locator: { kind: "text", partId: "body", representationId: "rev_b0", normalizationVersion: NORMALIZATION_V1, range: { start: 0, end: 2 }, quote: { exact: "检索" } },
    },
  }, grant.handle);
  if (result.status !== "ok") throw new Error(result.error?.message ?? "progress save failed");
  return performance.now() - started;
});
const contextMs = await sample(10, async (i) => {
  const started = performance.now();
  const result = await app.call(actor, { commandId: "library.contextSnapshot", idempotencyKey: `ctx-${i}`, input: { resourceId: "res_b0", resourceRevisionId: "rev_b0", start: 0, end: 2 } }, grant.handle);
  if (result.status !== "ok") throw new Error(result.error?.message ?? "context failed");
  return performance.now() - started;
});
const indexedFirstScreenMs = await sample(8, async (i) => {
  const started = performance.now();
  const result = await app.call(actor, { commandId: "library.read", idempotencyKey: `screen-${i}`, input: { resourceId: "res_b0", revisionId: "rev_b0" } }, grant.handle);
  if (result.status !== "ok" || !result.value?.slice) throw new Error(result.error?.message ?? "indexed read failed");
  return performance.now() - started;
});
const reparseFile = path.join(books, "reparse.txt");
fs.writeFileSync(reparseFile, `${"重解析".repeat(20_000)}末尾`);
const reparseMs = [];
for (let i = 0; i < 3; i += 1) {
  const handle = app.registerPath("file", reparseFile);
  const started = performance.now();
  const result = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: `reparse-${i}`, input: { title: `reparse-${i}`, pathHandle: handle, format: "txt" } }, grant.handle);
  if (result.status !== "ok") throw new Error(result.error?.message ?? "reparse failed");
  reparseMs.push(performance.now() - started);
}
const duringFile = path.join(books, "during.txt");
fs.writeFileSync(duringFile, "解析期间".repeat(200_000));
const duringHandle = app.registerPath("file", duringFile);
const pending = app.call(actor, { commandId: "library.importDocument", idempotencyKey: "during", input: { title: "during", pathHandle: duringHandle, format: "txt" } }, grant.handle);
const duringParseMs = [];
for (let i = 0; i < 5; i += 1) {
  const started = performance.now();
  const result = await app.call(actor, { commandId: "workspace.get", idempotencyKey: `during-${i}`, input: {} }, grant.handle);
  if (result.status !== "ok") throw new Error(result.error?.message ?? "interaction during parse failed");
  duringParseMs.push(performance.now() - started);
}
if ((await pending).status !== "ok") throw new Error("background parse failed");

// Operation-level timing: from a stored book to readable content, and to a durable save receipt.
const opBook = path.join(books, "operation.txt");
const opBody = `${"操作级正文。".repeat(4_000)}操作末尾标记`;
fs.writeFileSync(opBook, opBody);
// Read the final window so the sample really reaches the stored tail.
const opTailStart = Math.max(0, [...opBody].length - 40);
const operationImportMs = [];
let operationResourceId = "";
let operationRevisionId = "";
for (let i = 0; i < 3; i += 1) {
  const handle = app.registerPath("file", opBook);
  const started = performance.now();
  const result = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: `op-import-${i}`, input: { title: `op-${i}`, pathHandle: handle, format: "txt" } }, grant.handle);
  if (result.status !== "ok") throw new Error(result.error?.message ?? "operation import failed");
  operationImportMs.push(performance.now() - started);
  operationResourceId = String(result.value?.resourceId);
  operationRevisionId = String(result.value?.revisionId);
}
// Time until the last chapter is actually readable, not until a click returns.
const operationContentMs = [];
for (let i = 0; i < 8; i += 1) {
  const started = performance.now();
  const tail = await app.call(actor, { commandId: "library.readSlice", idempotencyKey: `op-read-${i}`, input: { resourceId: operationResourceId, revisionId: operationRevisionId, partId: "body", start: opTailStart, limit: 200 } }, grant.handle);
  const text = String(tail.value?.text ?? "");
  if (!text.includes("操作末尾标记")) throw new Error("operation read did not reach the stored tail");
  operationContentMs.push(performance.now() - started);
}
// Time from a save request to a committed revision receipt.
const operationSaveMs = [];
for (let i = 0; i < 8; i += 1) {
  const created = await app.call(actor, { commandId: "notes.create", idempotencyKey: `op-note-${i}`, input: { title: `op-note-${i}`, text: "操作级保存" } }, grant.handle);
  const objectId = String(created.value?.objectId);
  const started = performance.now();
  const saved = await app.call(actor, { commandId: "notes.replace", idempotencyKey: `op-save-${i}`, input: { objectId, expectedRevision: 1, blocks: [{ id: "b1", type: "paragraph", text: "操作级保存已提交" }] } }, grant.handle);
  if (saved.status !== "ok") throw new Error(saved.error?.message ?? "operation save failed");
  const revision = Number(saved.value?.revision ?? 0);
  if (revision < 2) throw new Error("operation save did not return a committed revision");
  operationSaveMs.push(performance.now() - started);
}
app.close();

const coldStartMs = [];
for (let i = 0; i < 3; i += 1) {
  const out = path.join(os.tmpdir(), `manga-cold-${process.pid}-${i}.json`);
  const child = spawnSync(process.execPath, ["scripts/stage/bench-cold-start.mjs", profile, out], { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (child.status !== 0) {
    process.stderr.write(child.stderr || child.error?.message || "cold start failed");
    process.exit(child.status ?? 1);
  }
  coldStartMs.push(JSON.parse(fs.readFileSync(out, "utf8")).ms);
}

function electronBin() {
  const name = process.platform === "win32" ? "electron.exe" : "electron";
  return [path.join(root, "node_modules/electron/dist", name), path.join(root, "apps/desktop/node_modules/electron/dist", name)].find((file) => fs.existsSync(file));
}
const packagedApp = packagedExecutable;
const interactionMs = [];
const readyMs = [];
const windowContentMs = [];
const windowSaveMs = [];
const windowImportMs = [];
for (let i = 0; i < 3; i += 1) {
  const uiProfile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-ui-"));
  const env = {
    ...process.env,
    MANGA_CHANNEL: "test",
    MANGA_PROFILE_ROOT: path.join(uiProfile, "root"),
    MANGA_DOCUMENTS_DIR: path.join(uiProfile, "documents"),
    MANGA_POINTER_FILE: path.join(uiProfile, "launcher", "pointer.json"),
    MANGA_SMOKE_PHASE: "bench",
    MANGA_SMOKE_LAUNCHED_AT: String(Date.now()),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = packagedApp();
  const electron = electronBin();
  const main = path.join(root, "apps/desktop/.vite/build/main.cjs");
  const child = packaged
    ? spawnSync(packaged, ["--manga-smoke"], { cwd: uiProfile, env, encoding: "utf8", timeout: 90_000, windowsHide: true })
    : electron && fs.existsSync(main)
      ? spawnSync(electron, [main, "--manga-smoke"], { cwd: uiProfile, env, encoding: "utf8", timeout: 90_000, windowsHide: true })
      : null;
  if (!child || child.status !== 0) {
    process.stderr.write(child?.stdout || "");
    process.stderr.write(child?.stderr || "interaction smoke failed");
    process.exit(child?.status ?? 1);
  }
  const windowMetrics = JSON.parse(fs.readFileSync(path.join(uiProfile, "root", "logs", "bench-window.json"), "utf8"));
  if (windowMetrics.waitedForContent !== true || windowMetrics.ok !== true) {
    process.stderr.write(`window bench did not reach visible content: ${JSON.stringify(windowMetrics)}\n`);
    process.exit(1);
  }
  for (const key of ["interactionMs", "contentAvailableMs", "saveReceiptMs", "importToReadableMs"]) {
    if (!Number.isFinite(windowMetrics[key]) || windowMetrics[key] < 0) {
      process.stderr.write(`window bench missing ${key}\n`);
      process.exit(1);
    }
  }
  interactionMs.push(windowMetrics.interactionMs);
  readyMs.push(windowMetrics.readyMs);
  windowContentMs.push(windowMetrics.contentAvailableMs);
  windowSaveMs.push(windowMetrics.saveReceiptMs);
  windowImportMs.push(windowMetrics.importToReadableMs);
}

// The same 6.2 baseline in a real window: seeded 10k/50k Profile, 10 MiB TXT and 30 MiB EPUB tails,
// and UI/save samples taken while another 10 MiB book is still parsing.
const appCommand = packagedApp()
  ? { executable: packagedApp(), args: ["--manga-smoke"] }
  : electronBin() && fs.existsSync(path.join(root, "apps/desktop/.vite/build/main.cjs"))
    ? { executable: electronBin(), args: [path.join(root, "apps/desktop/.vite/build/main.cjs"), "--manga-smoke"] }
    : undefined;
const scaleLauncher = appCommand && spawnWindow(appCommand.executable, appCommand.args);
if (!scaleLauncher) {
  process.stderr.write("scale window bench needs a packaged or built desktop app\n");
  process.exit(1);
}
const scaleWindow = await runScaleWindowBench({ launch: scaleLauncher });
if (!scaleWindow.ok) process.stderr.write(`scale window bench incomplete: ${JSON.stringify({ reason: scaleWindow.reason, failures: scaleWindow.failures, profile: scaleWindow.profile, measured: scaleWindow.measured, stderr: scaleWindow.stderr })}\n`);

// A 5000-file scan, cover reads from the image table, and the right pane with 1000 messages.
const scanPane = await runScanPaneBench({ launch: scaleLauncher });
if (!scanPane.ok) process.stderr.write(`scan and pane bench incomplete: ${JSON.stringify({ scan: scanPane.scan && { ok: scanPane.scan.ok, added: scanPane.scan.added, failed: scanPane.scan.failed }, pane: scanPane.pane && { ok: scanPane.pane.ok, reason: scanPane.pane.reason } })}\n`);
// The creative workspace at the sizes the stage gate names; each result keeps its raw samples so the report can recompute the figure.
const creative = {};
// The whiteboard and the mind map run in the real window, once, on a board and a map the window seeds for itself.
const canvasWanted = config.bench.canvas;
const canvas = await runCanvasBench({ launch: scaleLauncher, ...canvasWanted });
if (!canvas.ok) process.stderr.write(`canvas window bench incomplete: ${JSON.stringify({ reason: canvas.reason, failures: canvas.failures, stderr: canvas.stderr })}\n`);
// The video player in the real window: an episode with thousands of comments, and a player kept behind settings.
const readerWanted = config.bench.reader;
const reader = await runReaderBench({ ...appCommand, ...readerWanted });
if (!reader.danmaku?.ok || !reader.memory?.ok) process.stderr.write(`reader window bench incomplete: ${JSON.stringify({ reason: reader.reason, danmaku: reader.danmaku && { ok: reader.danmaku.ok, reason: reader.danmaku.reason, failures: reader.danmaku.failures, stderr: reader.danmaku.stderr }, memory: reader.memory && { ok: reader.memory.ok, reason: reader.memory.reason, failures: reader.memory.failures, stderr: reader.memory.stderr } })}
`);
// The workspace in the real window: tabs, contexts, readers kept loaded, and four columns with a video playing.
const workspace = await runWorkspaceBench({ ...appCommand, ...config.bench.workspace });
if (workspace.window?.ok !== true || workspace.memory?.ok !== true) process.stderr.write(`workspace window bench incomplete: ${JSON.stringify({ reason: workspace.reason, window: workspace.window && { ok: workspace.window.ok, reason: workspace.window.reason, failures: workspace.window.failures, stderr: workspace.window.stderr, counts: workspace.window.counts }, memory: workspace.memory && { ok: workspace.memory.ok, failures: workspace.memory.failures } })}
`);
const canvasRaw = {
  whiteboardOpen: { raw: canvas.whiteboardOpenMs, scale: { cards: canvas.scale?.cards ?? 0 } },
  whiteboardDrag: { raw: canvas.whiteboardDragMs, scale: { cards: canvas.scale?.cards ?? 0 } },
  whiteboardZoom: { raw: canvas.whiteboardZoomMs, scale: { cards: canvas.scale?.cards ?? 0 } },
  mindmapFold: { raw: canvas.mindmapFoldMs, scale: { nodes: canvas.scale?.nodes ?? 0 } },
};
let importRuns;
for (const [id, wanted] of Object.entries(config.bench.creative ?? {})) {
  if (id === "semantic" || id === "semanticFallback") {
    const result = await runSemanticBench({ segments: wanted.scale.segments, runs: wanted.minSamples, vec: wanted.engine === "vec0" });
    creative[id] = { kind: "service-semantic-search", engine: result.engine, scale: { segments: wanted.scale.segments, chunks: result.chunks, dim: result.dim }, buildMs: result.buildMs, raw: result.samples };
  }
  if (id === "btLoopback") {
    const result = await runBtBench({ bytes: wanted.scale.bytes });
    // The figure is the pieces that did not match the torrent's own hashes when the finished file was read back; the download counts only at none.
    const unverified = result.unverifiedPieces + (result.sha256Matches ? 0 : 1) + (result.stagingLeft ? 1 : 0);
    creative[id] = { kind: "loopback-bt-download", scale: { bytes: result.bytes }, raw: [unverified], detail: result };
  }
  if (canvasRaw[id]) {
    creative[id] = { kind: "electron-canvas", scale: canvasRaw[id].scale, raw: canvasRaw[id].raw ?? [], detail: { ok: canvas.ok, failures: canvas.failures, seedMs: canvas.seedMs, scale: canvas.scale, openCards: canvas.whiteboardOpenCards, frame: canvas.whiteboardFrame, series: canvas.whiteboardSeries, dropSaved: canvas.dropSaved, mindmapOpenMs: canvas.mindmapOpenMs, mindmapRenderedTopics: canvas.mindmapRenderedTopics, foldByLevelMs: canvas.mindmapFoldByLevelMs, waits: canvas.waits } };
  }
  if (id === "danmaku3000") {
    const d = reader.danmaku ?? {};
    creative[id] = { kind: "electron-reader", scale: { comments: d.shown ?? 0 }, raw: d.raw ?? [], detail: { ok: d.ok === true, failures: d.failures ?? [d.reason], comments: d.comments, shown: d.shown, usualIntervalMs: d.usualIntervalMs, baselineFrames: d.baselineFrames, baselineLatePct: d.baselineLatePct, baselineDropped: d.baselineDropped, runs: d.runs, playMs: d.playMs, requests: d.requests, signedOnly: d.signedOnly } };
  }
  if (id === "readerMemory") {
    const m = reader.memory ?? {};
    creative[id] = { kind: "electron-reader", scale: { runs: m.raw?.length ?? 0 }, raw: m.raw ?? [], detail: { ok: m.ok === true, failures: m.failures ?? [m.reason], unit: m.unit, rows: m.rows, processes: m.processes } };
  }
  if (id === "tabSwitch" || id === "contextSwitch" || id === "contextRestore" || id === "quadLateFrame" || id === "mountedReaders") {
    const w = workspace.window ?? {};
    const raw = { tabSwitch: w.tabSwitchMs, contextSwitch: w.contextSwitchMs, contextRestore: w.contextRestoreMs, quadLateFrame: w.quadLateFramePct, mountedReaders: w.mountedReadersOverColumns }[id] ?? [];
    const scale = { tabSwitch: { tabs: w.tabs?.length ?? 0 }, contextSwitch: { contexts: w.contexts ?? 0 }, contextRestore: { contexts: w.contexts ?? 0 }, quadLateFrame: { columns: w.quadRuns?.length ? 4 : 0 }, mountedReaders: { readers: w.readers?.opened ?? 0 } }[id];
    creative[id] = { kind: "electron-workspace", scale, raw, detail: { ok: w.ok === true, failures: w.failures ?? [workspace.reason], window: w.window, wait: w.waits?.[id], tabs: id === "tabSwitch" ? w.tabs : undefined, readers: id === "mountedReaders" ? w.readers : undefined, usualIntervalMs: id === "quadLateFrame" ? w.usualIntervalMs : undefined, baselineLatePct: id === "quadLateFrame" ? w.baselineLatePct : undefined, runs: id === "quadLateFrame" ? w.quadRuns : undefined, playMs: id === "quadLateFrame" ? w.playMs : undefined } };
  }
  if (id === "quadMemory") {
    const m = workspace.memory ?? {};
    creative[id] = { kind: "electron-workspace", scale: { columns: m.raw?.length ? 4 : 0 }, raw: m.raw ?? [], detail: { ok: m.ok === true, failures: m.failures ?? [workspace.reason], unit: m.unit, rows: m.rows, wait: "application working set, all processes, with a video in a single column and then with the four columns (two videos, a comic, a note), each in a window of its own" } };
  }
  if (id === "traceOverhead") {
    const result = await runTraceBench({ runs: wanted.minSamples });
    creative[id] = { kind: "service-trace-overhead", scale: { requestBytes: result.requestBytes }, raw: result.samples, detail: result.detail };
  }
  if (id === "noteFileWrite") {
    const result = await runNoteFileBench({ runs: wanted.minSamples, blocks: wanted.scale.blocks });
    creative[id] = { kind: "service-note-file-write", scale: { blocks: result.blocks }, raw: result.samples, detail: result.detail };
  }
  if (id === "videoImport" || id === "videoImportPacketReads") {
    // One import run feeds both figures: how long the season takes to be listed, and how many runs of the media tool read a whole file.
    importRuns ??= await runVideoImportBench({ videos: wanted.scale.videos, runs: wanted.minSamples });
    creative[id] = { kind: "service-video-import", scale: { videos: importRuns.videos }, raw: id === "videoImport" ? importRuns.browsableMs : importRuns.packetReads, detail: importRuns.detail };
  }
  if (id === "roughcut") {
    const result = await runRoughcutBench({ clips: wanted.scale.clips, runs: wanted.minSamples });
    creative[id] = { kind: "service-roughcut-export", scale: { clips: wanted.scale.clips }, raw: result.samples, detail: result.detail };
  }
}
const creativeMetrics = Object.fromEntries(Object.entries(config.bench.creative ?? {}).map(([id, wanted]) => [wanted.metric, creative[id]?.raw?.length ? (wanted.stat === "max" ? Math.max(...creative[id].raw) : p95(creative[id].raw)) : Number.POSITIVE_INFINITY]));
const measurement = (raw, unit, note) => ({ unit, note, raw, p95: p95(raw) });
const measurements = scanPane.ok
  ? {
    scanThroughputFilesPerS: measurement(scanPane.scan.throughputFilesPerS, "files/s", "one value per 5000-file scan, including the pictures and details read for the new works; recorded, not a limit"),
    coverImageReadMs: measurement(scanPane.covers.imageReadMs, "ms", "reading one cover's bytes from the images table"),
    coverHandleColdMs: measurement(scanPane.covers.handleColdMs, "ms", "covers.handles for one cover whose grid thumbnail is made from the images table"),
    coverHandleWarmMs: measurement(scanPane.covers.handleWarmMs, "ms", "covers.handles for one cover whose grid thumbnail already exists"),
    paneScrollMs: measurement(scanPane.pane.raw.scrollMs, "ms", "setting the 1000-message list's scroll position and reading the layout, real window"),
    paneInputMs: measurement(scanPane.pane.raw.inputMs, "ms", "typing into the input of the right pane with 1000 messages, to the React commit and a layout read, real window"),
  }
  : {};

const metrics = {
  searchP95Ms: p95(searchMs),
  contextP95Ms: p95(contextMs),
  indexedFirstScreenMs: p95(indexedFirstScreenMs),
  saveMs: p95(saveMs),
  progressSaveMs: p95(progressSaveMs),
  coldStartMs: p95(coldStartMs),
  interactionP95Ms: p95(interactionMs),
  // UI targets use the measured Electron path; service timings remain separate raw evidence.
  contentAvailableP95Ms: p95(windowContentMs),
  saveReceiptP95Ms: p95(windowSaveMs),
  importToReadableP95Ms: p95(windowImportMs),
  // Requirement 6.2 in the real window on the benchmark-scale Profile.
  scaleColdStartToLibraryMs: p95(scaleWindow.raw?.coldStartToLibraryMs ?? []),
  scaleUiFeedbackP95Ms: p95(scaleWindow.raw?.uiFeedbackMs ?? []),
  scaleRailSwitchP95Ms: p95(scaleWindow.raw?.railSwitchMs ?? []),
  scaleSearchNamesP95Ms: p95(scaleWindow.raw?.searchNamesMs ?? []),
  scaleSettingsP95Ms: p95(scaleWindow.raw?.settingsMs ?? []),
  scaleLargeTxtTailP95Ms: p95(scaleWindow.raw?.largeTxtTailMs ?? []),
  scaleLargeEpubTailP95Ms: p95(scaleWindow.raw?.largeEpubTailMs ?? []),
  scaleSaveReceiptP95Ms: p95(scaleWindow.raw?.saveReceiptMs ?? []),
  scaleDuringParseUiP95Ms: p95(scaleWindow.raw?.duringParseUiMs ?? []),
  scaleDuringParseSaveP95Ms: p95(scaleWindow.raw?.duringParseSaveMs ?? []),
  // A 5000-file library scan: the main process's event-loop delay (p99 of 5 ms timer samples) and the answer time of the commands the
  // shelf and settings use while it runs (p95).
  scanEventLoopP99Ms: scanPane.scan?.loopLag?.p99 ?? Number.POSITIVE_INFINITY,
  scanInteractionP95Ms: scanPane.scan?.interaction?.p95 ?? Number.POSITIVE_INFINITY,
  ...creativeMetrics,
};
const passed = scaleWindow.ok === true && scanPane.ok === true && canvas.ok === true && reader.danmaku?.ok === true && reader.memory?.ok === true && workspace.window?.ok === true && workspace.memory?.ok === true && Object.entries(requiredBenchTargets).every(([metric, limit]) => Number.isFinite(metrics[metric]) && metrics[metric] <= limit);
fs.writeFileSync(path.join(evidence, "bench.json"), `${JSON.stringify({
  status: passed ? "passed" : "failed",
  stage,
  ...stageFingerprints(root, config),
  productAcceptance: "not-run",
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  metrics,
  targets: requiredBenchTargets,
  scale: { metadataCount: METADATA, searchBlocks: BLOCKS },
  samples: {
    coldStartMs: { n: coldStartMs.length, kind: "process" },
    interactionMs: { n: interactionMs.length, kind: "electron", readyMs, waitedForContent: true },
    windowContentMs: { n: windowContentMs.length, kind: "electron-content-visible" },
    windowSaveMs: { n: windowSaveMs.length, kind: "electron-save-receipt" },
    windowImportMs: { n: windowImportMs.length, kind: "electron-import-to-readable" },
    indexedFirstScreenMs: { n: indexedFirstScreenMs.length, kind: "indexed-read" },
    reparseMs: { n: reparseMs.length, kind: "reparse" },
    duringParseMs: { n: duringParseMs.length, kind: "service-during-parse" },
    contentAvailableMs: { n: operationContentMs.length, kind: "operation-to-content" },
    saveReceiptMs: { n: operationSaveMs.length, kind: "operation-to-commit-receipt" },
    importToReadableMs: { n: operationImportMs.length, kind: "operation-import" },
  },
  scaleWindow: {
    kind: "electron-scale-profile",
    ok: scaleWindow.ok === true,
    failures: scaleWindow.failures ?? [scaleWindow.reason],
    scale: scaleWindow.scale,
    sizes: scaleWindow.sizes,
    seedMs: scaleWindow.seedMs,
    waits: scaleWindow.waits,
    raw: scaleWindow.raw,
    requirement: {
      scaleColdStartToLibraryMs: "6.2 冷启动至可操作资源库 ≤ 5 s",
      scaleUiFeedbackP95Ms: "6.2 本地界面反馈 p95 ≤ 100 ms",
      scaleRailSwitchP95Ms: "AT-119 点图标切换视图到侧栏列表画好 p95 ≤ 100 ms（规模样本）",
      scaleSearchNamesP95Ms: "AT-121 搜索框里输入后名字结果出现 p95 ≤ 200 ms（规模样本）",
      scaleSettingsP95Ms: "AT-122 进入设置与离开设置回到工作区画好 p95 ≤ 150 ms",
      scaleLargeTxtTailP95Ms: "6.2 已索引小说首屏 TXT ≤ 10 MiB p95 ≤ 2 s（恢复到末段）",
      scaleLargeEpubTailP95Ms: "6.2 已索引小说首屏 EPUB ≤ 30 MiB p95 ≤ 2 s（恢复到末章末段）",
      scaleSaveReceiptP95Ms: "6.2 自动保存：编辑草稿 ≤ 1 s",
      scaleDuringParseUiP95Ms: "6.2 本地界面反馈 p95 ≤ 100 ms，后台解析期间",
      scaleDuringParseSaveP95Ms: "6.2 自动保存 ≤ 1 s，后台解析期间",
    },
  },
  measurements,
  creative,
  scanPane: {
    kind: "service-scan-and-electron-pane",
    ok: scanPane.ok === true,
    scan: scanPane.scan,
    covers: scanPane.covers && { covers: scanPane.covers.covers, source: scanPane.covers.source },
    pane: scanPane.pane && { ok: scanPane.pane.ok, kind: scanPane.pane.kind, notes: scanPane.pane.notes, loaded: scanPane.pane.loaded, domNodes: scanPane.pane.domNodes, scrollHeight: scanPane.pane.scrollHeight, waits: scanPane.pane.waits },
    requirement: {
      scanEventLoopP99Ms: "14.6 5000 个文件扫描：主进程事件循环延迟 p99 ≤ 100 ms",
      scanInteractionP95Ms: "14.6 5000 个文件扫描期间：书架与设置所用命令的响应 p95 ≤ 100 ms",
    },
  },
  raw: { searchMs, saveMs, progressSaveMs, contextMs, indexedFirstScreenMs, reparseMs, duringParseMs, coldStartMs, interactionMs, readyMs, operationContentMs, operationSaveMs, operationImportMs, windowContentMs, windowSaveMs, windowImportMs },
  notes: "Indexed first screen reads an already stored revision. Reparse imports a text file again. duringParseMs is workspace.get while a worker parse is in flight. Service contentAvailableMs and saveReceiptMs remain operation receipts. Window contentAvailableMs, saveReceiptMs and importToReadableMs wait until the packaged or built Electron renderer shows the library page, the readable text, or a committed note save state. This file is a self-check, not product acceptance.",
}, null, 2)}\n`);
if (!passed) {
  console.error(JSON.stringify({ status: "failed", check: "stage-bench", metrics, targets: requiredBenchTargets }));
  process.exit(1);
}
console.log(JSON.stringify({ status: "passed", check: "stage-bench", ...metrics }));
