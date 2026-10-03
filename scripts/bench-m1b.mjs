import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { MangaProductApp, TestVault } from "../packages/app-core/src/index.ts";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";
import { requiredBenchTargets, requiredScale } from "./m1b-report.mjs";
import { NORMALIZATION_V1 } from "../packages/contracts/src/index.ts";
import { desktopPackageDir } from "./desktop-paths.ts";
import { runScaleWindowBench, spawnWindow } from "./bench-m1b-scale.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const METADATA = requiredScale.metadataCount;
const BLOCKS = requiredScale.searchBlocks;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1b-bench-"));
const evidence = path.resolve(root, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/b-final");
fs.mkdirSync(evidence, { recursive: true });
const app = new MangaProductApp({
  profileRoot: profile,
  documentsDir: path.join(profile, "documents"),
  pointerPath: path.join(profile, "launcher", "pointer.json"),
  channel: "test",
  hostId: "m1b-bench",
  vault: new TestVault("m1b-bench"),
  useParseWorker: true,
});
await app.start();
const actor = { kind: "user", id: "bench" };
const grant = app.issueOwnerGrant(actor);
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
const reparseFile = path.join(profile, "reparse.txt");
fs.writeFileSync(reparseFile, `${"重解析".repeat(20_000)}末尾`);
const reparseMs = [];
for (let i = 0; i < 3; i += 1) {
  const handle = app.registerPath("file", reparseFile);
  const started = performance.now();
  const result = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: `reparse-${i}`, input: { title: `reparse-${i}`, pathHandle: handle, format: "txt" } }, grant.handle);
  if (result.status !== "ok") throw new Error(result.error?.message ?? "reparse failed");
  reparseMs.push(performance.now() - started);
}
const duringFile = path.join(profile, "during.txt");
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
const opBook = path.join(profile, "operation.txt");
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
  const out = path.join(os.tmpdir(), `manga-m1b-cold-${process.pid}-${i}.json`);
  const child = spawnSync(process.execPath, ["scripts/bench-m1a-process.mjs", profile, out], { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true });
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
function packagedApp() {
  const outDir = desktopPackageDir;
  if (!fs.existsSync(outDir)) return undefined;
  const built = fs.readdirSync(outDir).find((name) => name.startsWith("MANGA"));
  if (!built) return undefined;
  const exe = path.join(outDir, built, process.platform === "win32" ? "MANGA.exe" : "MANGA");
  return fs.existsSync(exe) ? exe : undefined;
}
const interactionMs = [];
const readyMs = [];
const windowContentMs = [];
const windowSaveMs = [];
const windowImportMs = [];
for (let i = 0; i < 3; i += 1) {
  const uiProfile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1b-bench-ui-"));
  const env = {
    ...process.env,
    MANGA_CHANNEL: "test",
    MANGA_PROFILE_ROOT: path.join(uiProfile, "root"),
    MANGA_DOCUMENTS_DIR: path.join(uiProfile, "documents"),
    MANGA_POINTER_FILE: path.join(uiProfile, "launcher", "pointer.json"),
    M1A_SMOKE_PHASE: "bench",
    M1A_LAUNCHED_AT: String(Date.now()),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = packagedApp();
  const electron = electronBin();
  const main = path.join(root, "apps/desktop/.vite/build/main.cjs");
  const child = packaged
    ? spawnSync(packaged, ["--m1a-smoke"], { cwd: uiProfile, env, encoding: "utf8", timeout: 90_000, windowsHide: true })
    : electron && fs.existsSync(main)
      ? spawnSync(electron, [main, "--m1a-smoke"], { cwd: uiProfile, env, encoding: "utf8", timeout: 90_000, windowsHide: true })
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
const scaleLauncher = packagedApp()
  ? spawnWindow(packagedApp(), ["--m1a-smoke"])
  : electronBin() && fs.existsSync(path.join(root, "apps/desktop/.vite/build/main.cjs"))
    ? spawnWindow(electronBin(), [path.join(root, "apps/desktop/.vite/build/main.cjs"), "--m1a-smoke"])
    : undefined;
if (!scaleLauncher) {
  process.stderr.write("scale window bench needs a packaged or built desktop app\n");
  process.exit(1);
}
const scaleWindow = await runScaleWindowBench({ launch: scaleLauncher });
if (!scaleWindow.ok) process.stderr.write(`scale window bench incomplete: ${JSON.stringify({ reason: scaleWindow.reason, failures: scaleWindow.failures, profile: scaleWindow.profile, measured: scaleWindow.measured, stderr: scaleWindow.stderr })}\n`);

const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
};
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
  scaleLargeTxtTailP95Ms: p95(scaleWindow.raw?.largeTxtTailMs ?? []),
  scaleLargeEpubTailP95Ms: p95(scaleWindow.raw?.largeEpubTailMs ?? []),
  scaleSaveReceiptP95Ms: p95(scaleWindow.raw?.saveReceiptMs ?? []),
  scaleDuringParseUiP95Ms: p95(scaleWindow.raw?.duringParseUiMs ?? []),
  scaleDuringParseSaveP95Ms: p95(scaleWindow.raw?.duringParseSaveMs ?? []),
};
const passed = scaleWindow.ok === true && Object.entries(requiredBenchTargets).every(([metric, limit]) => Number.isFinite(metrics[metric]) && metrics[metric] <= limit);
fs.writeFileSync(path.join(evidence, "bench.json"), `${JSON.stringify({
  status: passed ? "passed" : "failed",
  ...m1bFingerprints(root),
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
      scaleLargeTxtTailP95Ms: "6.2 已索引小说首屏 TXT ≤ 10 MiB p95 ≤ 2 s（恢复到末段）",
      scaleLargeEpubTailP95Ms: "6.2 已索引小说首屏 EPUB ≤ 30 MiB p95 ≤ 2 s（恢复到末章末段）",
      scaleSaveReceiptP95Ms: "6.2 自动保存：编辑草稿 ≤ 1 s",
      scaleDuringParseUiP95Ms: "6.2 本地界面反馈 p95 ≤ 100 ms，后台解析期间",
      scaleDuringParseSaveP95Ms: "6.2 自动保存 ≤ 1 s，后台解析期间",
    },
  },
  raw: { searchMs, saveMs, progressSaveMs, contextMs, indexedFirstScreenMs, reparseMs, duringParseMs, coldStartMs, interactionMs, readyMs, operationContentMs, operationSaveMs, operationImportMs, windowContentMs, windowSaveMs, windowImportMs },
  notes: "Indexed first screen reads an already stored revision. Reparse imports a text file again. duringParseMs is workspace.get while a worker parse is in flight. Service contentAvailableMs and saveReceiptMs remain operation receipts. Window contentAvailableMs, saveReceiptMs and importToReadableMs wait until the packaged or built Electron renderer shows the library page, the readable text, or a committed note save state. This file is a self-check, not product acceptance.",
}, null, 2)}\n`);
if (!passed) {
  console.error(JSON.stringify({ status: "failed", check: "m1b-bench", metrics, targets: requiredBenchTargets }));
  process.exit(1);
}
console.log(JSON.stringify({ status: "passed", check: "m1b-bench", ...metrics }));
