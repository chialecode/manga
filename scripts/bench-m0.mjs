import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { SqliteStore } from "../packages/storage-sqlite/src/store.ts";
import { sourceFingerprint } from "../experiments/m0/src/report.ts";
import { MangaApp } from "../experiments/m0/src/application/app.ts";
import { generateFixtures } from "../experiments/m0/src/fixtures/generate.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m0-bench-"));
const store = new SqliteStore({ profileDir: profile, hostId: "benchmark" });
const start = performance.now();
store.db.exec("BEGIN");
const insert = store.db.prepare("INSERT INTO resources(id,kind,title,aliases_json,created_at) VALUES (?,'novel',?,'[]','fixture')");
for (let i = 0; i < 10000; i++) insert.run(`bench-${i}`, `作品 ${i}`);
for (let i = 0; i < 50000; i++) for (const item of store.indexFragment({ id: `fragment-${i}`, resourceId: `bench-${i % 10000}`, kind: i % 3 === 0 ? "title" : i % 3 === 1 ? "body" : "note", text: `作品 ${i % 10000} 日本語 中文 段落 ${i}` })) store.db.prepare(item.sql).run(...item.params);
const tenMiB = "TXT indexed source ".repeat(Math.ceil(10 * 1024 * 1024 / 19)).slice(0, 10 * 1024 * 1024);
store.db.prepare("INSERT INTO resource_revisions(id,resource_id,fingerprint,parser_version,payload_json,created_at) VALUES ('bench-rev','bench-0','synthetic','v1',?,'fixture')").run(JSON.stringify({ normalized: tenMiB }));
store.db.exec("COMMIT");
const indexBuildMs = performance.now() - start;
const queries = ["作品12", "日本語", "中文", "段落", "absent"];
const search = [];
for (let i = 0; i < 100; i++) {
  const query = queries[i % queries.length];
  const started = performance.now();
  const hits = store.search({ text: query, limit: 20 });
  search.push({ query, ms: performance.now() - started, hits: hits.length });
}
store.close();

const actor = { kind: "user", id: "tester" };
const app = new MangaApp({ profileDir: profile, hostId: "benchmark" });
await app.start(["library", "notes"]);
const firstScreenTxt = [];
for (let i = 0; i < 30; i++) {
  const started = performance.now();
  const result = await app.call(actor, { commandId: "library.getResource", idempotencyKey: `fs-${i}`, input: { resourceId: "bench-0" } });
  if (result.status !== "ok") throw new Error(result.error?.message ?? "bench-0 getResource failed");
  const text = (result.value?.parts ?? []).map((part) => part.normalized).join("\n").slice(0, 8000);
  if (!text.length) throw new Error("bench-0 first screen empty");
  firstScreenTxt.push(performance.now() - started);
}
const contextMs = [];
for (let i = 0; i < 30; i++) {
  const started = performance.now();
  const result = await app.call(actor, { commandId: "library.contextSnapshot", idempotencyKey: `ctx-${i}`, input: { resourceId: "bench-0", resourceRevisionId: "bench-rev", start: 0, end: 160 } });
  if (!result.value?.quote) throw new Error("context snapshot empty");
  contextMs.push(performance.now() - started);
}
const progressMs = [];
for (let i = 0; i < 30; i++) {
  const started = performance.now();
  const progressResult = await app.call(actor, {
    commandId: "progress.set",
    idempotencyKey: `prog-${i}`,
    input: {
      resourceId: "bench-0",
      resourceRevisionId: "bench-rev",
      locator: { kind: "text", partId: "body", representationId: "bench-rev", normalizationVersion: "text-nfc-lf-v1", range: { start: 0, end: 4 } },
    },
  });
  if(progressResult.status!=="ok") throw new Error("progress benchmark command failed");
  progressMs.push(performance.now() - started);
}
const generated = await generateFixtures();
const epub = generated.items.find((item) => item.id === "basic.epub");
const firstScreenEpub = [];
if (epub) {
  const imported = await app.call(actor, { commandId: "library.importEpub", idempotencyKey: "bench-epub", input: { title: "bench-epub", bytes: [...fs.readFileSync(epub.path)] } });
  const resourceId = imported.value.resourceId;
  for (let i = 0; i < 30; i++) {
    const started = performance.now();
    const result = await app.call(actor, { commandId: "library.getResource", idempotencyKey: `epub-fs-${i}`, input: { resourceId } });
    const text = (result.value?.parts ?? []).map((part) => part.normalized).join("\n");
    if (!text.length) throw new Error("epub first screen empty");
    firstScreenEpub.push(performance.now() - started);
  }
}
app.close();

const build = spawnSync(process.execPath, ["experiments/m0-desktop/build.mjs"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(1);
const electron = path.join(root, "experiments/m0-desktop/node_modules/electron/dist/electron.exe");
const startup = [];
let ui;
for (let i = 0; i < 30; i++) {
  const env = { ...process.env, MANGA_NODE_BIN: process.execPath, MANGA_M0_DIR: profile, M0_SMOKE_PHASE: i === 0 ? "bench-detail" : "bench-startup", M0_LAUNCHED_AT: String(Date.now()) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electron, [path.join(root, "experiments/m0-desktop/dist/main.cjs"), "--m0-smoke"], { cwd: profile, env, encoding: "utf8", windowsHide: true, timeout: 60000 });
  if (child.status !== 0) throw new Error(child.stderr || child.error?.message || "benchmark window failed");
  const result = JSON.parse(fs.readFileSync(path.join(profile, "bench-window.json"), "utf8"));
  startup.push(result.startupMs);
  if (i === 0) ui = result;
}
const denyProfile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m0-bench-deny-"));
const denyEnv = { ...process.env, MANGA_NODE_BIN: process.execPath, MANGA_M0_DIR: denyProfile, M0_SMOKE_PHASE: "permission", M0_FORCE_PERMISSION_DENY: "1", M0_LAUNCHED_AT: String(Date.now()) };
delete denyEnv.ELECTRON_RUN_AS_NODE;
const denyStarted = performance.now();
const deny = spawnSync(electron, [path.join(root, "experiments/m0-desktop/dist/main.cjs"), "--m0-smoke"], { cwd: denyProfile, env: denyEnv, encoding: "utf8", windowsHide: true, timeout: 30000 });
const deviceErrorLaunchMs = performance.now() - denyStarted;
if (deny.status !== 0) throw new Error(deny.stderr || deny.error?.message || "permission bench failed");

const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const metrics = {
  searchP95Ms: p95(search.map((item) => item.ms)),
  inputStateP95Ms: p95(ui.inputStateMs),
  processStartupP95Ms: p95(startup),
  processStartupMaxMs: Math.max(...startup),
  autoSaveMs: ui.autoSaveMs,
  contextP95Ms: p95(contextMs),
  firstScreenTxtP95Ms: p95(firstScreenTxt),
  firstScreenEpubP95Ms: firstScreenEpub.length ? p95(firstScreenEpub) : null,
  progressP95Ms: p95(progressMs),
  recordStatusMs: ui.recordStatusMs ?? null,
  firstScreenUiMs: ui.firstScreenUiMs ?? null,
  deviceErrorLaunchMs,
};
const targets = {
  searchP95Ms: 500,
  inputStateP95Ms: 100,
  processStartupMaxMs: 5000,
  autoSaveMs: 1000,
  contextP95Ms: 150,
  firstScreenTxtP95Ms: 2000,
  progressP95Ms: 2000,
  recordStatusMs: 300,
};
const unmet = Object.entries(targets).filter(([key, limit]) => !Number.isFinite(metrics[key]) || metrics[key] > limit).map(([key, limit]) => ({ metric: key, actual: metrics[key] ?? null, limit }));
const passed = unmet.length === 0;
const report = {
  status: passed ? "passed" : "failed",
  scope: "measured prototype subset on current Windows 11 reference PC",
  at: new Date().toISOString(),
  sourceFingerprint: sourceFingerprint(root),
  machine: { platform: os.platform(), arch: os.arch(), release: os.release() },
  build: { node: process.version, electron: "37.4.0", mode: "unminified bundled service" },
  dataset: { resources: 10000, fragments: 50000, indexedTxtBytes: tenMiB.length, epubBytes: epub ? fs.statSync(epub.path).size : 0, firstScreenRenderCharacters: 8000 },
  method: {
    startup: "30 new Electron and service processes, OS disk cache not cleared",
    search: "100 queries; high-resolution clock; raw order preserved",
    input: "100 real textarea input events to DOM state acknowledgment; excludes compositor/display latency",
    autosave: "one edit to persisted acknowledgment; sample size 1",
    firstScreenTxt: "30 library.getResource calls of a 10 MiB indexed TXT, then slice 8000 characters as operable first screen",
    firstScreenEpub: "30 library.getResource calls of the synthetic basic.epub; not a 30 MiB EPUB",
    context: "30 library.contextSnapshot calls on the indexed TXT",
    progress: "30 progress.set calls",
    recordStatus: "one fake-microphone start to visible status in the Electron window",
    deviceError: "one permission-deny smoke launch",
  },
  targets,
  unmet,
  indexBuildMs,
  metrics,
  raw: { search, startupMs: startup, inputStateMs: ui.inputStateMs, firstScreenTxt, firstScreenEpub, contextMs, progressMs },
  pending: [
    "display compositor latency is not included in inputStateP95Ms",
    "30 MiB EPUB first-screen sample was not generated",
    "hardware microphone start-to-status is not this fake-device sample",
  ],
};
const dir = path.resolve(root, process.env.M0_EVIDENCE_DIR ?? "docs/evidence/m0-closure");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "bench.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, metrics, unmet, pending: report.pending }, null, 2));
process.exitCode = passed ? 0 : 1;
