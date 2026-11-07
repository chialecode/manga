import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { MangaProductApp, TestVault } from "../packages/app-core/src/index.ts";
import { sourceFingerprint, m1aSourceFingerprint } from "./m1a-fingerprint.mjs";
import { requiredBenchTargets, requiredScale } from "./m1a-report.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const METADATA = requiredScale.metadataCount;
const BLOCKS = requiredScale.searchBlocks;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1a-bench-"));
const evidence = path.resolve(root, process.env.M1A_EVIDENCE_DIR ?? "docs/evidence/m1a-review");
fs.mkdirSync(evidence, { recursive: true });

const app = new MangaProductApp({
  profileRoot: profile,
  documentsDir: path.join(profile, "documents"),
  pointerPath: path.join(profile, "launcher", "pointer.json"),
  channel: "test",
  hostId: "bench",
  vault: new TestVault("bench"),
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
  const mutations = app.store.indexFragment({
    id: `frag_b${i}`,
    resourceId,
    kind: "body",
    text: `检索块 ${i} 日本語 中文`,
  });
  for (const mutation of mutations) app.store.sqlite.prepare(mutation.sql).run(...(mutation.params ?? []));
}
app.store.sqlite.exec("COMMIT");

const searchMs = [];
for (let i = 0; i < 100; i += 1) {
  const started = performance.now();
  const result = await app.call(actor, { commandId: "library.find", idempotencyKey: `s-${i}`, input: { text: "检索" } }, grant.handle);
  if (result.status !== "ok") throw new Error(result.error?.message ?? "search failed");
  searchMs.push(performance.now() - started);
}

const saveMs = [];
for (let i = 0; i < 30; i += 1) {
  const started = performance.now();
  const result = await app.call(actor, { commandId: "notes.create", idempotencyKey: `save-${i}`, input: { title: `bench-${i}`, text: "ok" } }, grant.handle);
  if (result.status !== "ok") throw new Error(result.error?.message ?? "save failed");
  saveMs.push(performance.now() - started);
}

const contextMs = [];
for (let i = 0; i < 30; i += 1) {
  const started = performance.now();
  const result = await app.call(actor, {
    commandId: "library.contextSnapshot",
    idempotencyKey: `ctx-${i}`,
    input: { resourceId: "res_b0", resourceRevisionId: "rev_b0", start: 0, end: 6 },
  }, grant.handle);
  if (result.status !== "ok" || !result.value?.quote) throw new Error(result.error?.message ?? "context snapshot empty");
  contextMs.push(performance.now() - started);
}
app.close();

const processScript = path.join(root, "scripts/bench-m1a-process.mjs");
const coldStartMs = [];
for (let i = 0; i < 5; i += 1) {
  const out = path.join(os.tmpdir(), `manga-m1a-cold-${process.pid}-${i}.json`);
  const child = spawnSync(process.execPath, [processScript, profile, out], { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (child.status !== 0) {
    process.stderr.write(child.stderr || child.error?.message || "cold start process failed");
    process.exit(child.status ?? 1);
  }
  const recorded = JSON.parse(fs.readFileSync(out, "utf8"));
  if (!Number.isFinite(recorded.ms)) throw new Error("cold start process did not record ms");
  coldStartMs.push(recorded.ms);
}

function electronBin() {
  const name = process.platform === "win32" ? "electron.exe" : "electron";
  return [
    path.join(root, "node_modules/electron/dist", name),
    path.join(root, "apps/desktop/node_modules/electron/dist", name),
  ].find((file) => fs.existsSync(file));
}

function packagedApp() {
  const outDir = path.join(root, "dist/m1a-package");
  if (!fs.existsSync(outDir)) return undefined;
  const built = fs.readdirSync(outDir).find((name) => name.startsWith("MANGA"));
  if (!built) return undefined;
  const exe = path.join(outDir, built, process.platform === "win32" ? "MANGA.exe" : "MANGA");
  return fs.existsSync(exe) ? exe : undefined;
}

const interactionMs = [];
const readyMs = [];
for (let i = 0; i < 3; i += 1) {
  const uiProfile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1a-bench-ui-"));
  const env = {
    ...process.env,
    MANGA_CHANNEL: "test",
    MANGA_PROFILE_ROOT: path.join(uiProfile, "root"),
    MANGA_DOCUMENTS_DIR: path.join(uiProfile, "documents"),
    MANGA_POINTER_FILE: path.join(uiProfile, "launcher", "pointer.json"),
    M1A_SMOKE_PHASE: "bench",
    M1A_LAUNCHED_AT: String(Date.now()),
    M1A_EVIDENCE_DIR: evidence,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = packagedApp();
  const electron = electronBin();
  const main = path.join(root, "apps/desktop/.vite/build/main.cjs");
  let child;
  if (packaged) {
    child = spawnSync(packaged, ["--m1a-smoke"], { cwd: uiProfile, env, encoding: "utf8", timeout: 60_000, windowsHide: true });
  } else if (electron && fs.existsSync(main)) {
    child = spawnSync(electron, [main, "--m1a-smoke"], { cwd: uiProfile, env, encoding: "utf8", timeout: 60_000, windowsHide: true });
  } else {
    throw new Error("visible interaction requires a packaged MANGA.exe or apps/desktop/.vite/build/main.cjs");
  }
  if (child.status !== 0) {
    process.stderr.write(child.stdout || "");
    process.stderr.write(child.stderr || child.error?.message || "interaction smoke failed");
    process.exit(child.status ?? 1);
  }
  const windowFile = path.join(uiProfile, "root", "logs", "bench-window.json");
  if (!fs.existsSync(windowFile)) throw new Error("interaction smoke did not write bench-window.json");
  const windowMetrics = JSON.parse(fs.readFileSync(windowFile, "utf8"));
  if (!Number.isFinite(windowMetrics.interactionMs) || !Number.isFinite(windowMetrics.readyMs)) {
    throw new Error("interaction smoke metrics missing");
  }
  interactionMs.push(windowMetrics.interactionMs);
  readyMs.push(windowMetrics.readyMs);
}

const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
};

const metrics = {
  searchP95Ms: p95(searchMs),
  saveMs: p95(saveMs),
  coldStartMs: p95(coldStartMs),
  contextP95Ms: p95(contextMs),
  interactionP95Ms: p95(interactionMs),
};
const passed = Object.entries(requiredBenchTargets).every(([metric, limit]) => Number.isFinite(metrics[metric]) && metrics[metric] <= limit);
fs.writeFileSync(path.join(evidence, "bench.json"), `${JSON.stringify({
  status: passed ? "passed" : "failed",
  sourceFingerprint: sourceFingerprint(root),
  m1aSourceFingerprint: m1aSourceFingerprint(root),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  metrics,
  targets: requiredBenchTargets,
  scale: { metadataCount: METADATA, searchBlocks: BLOCKS },
  samples: {
    searchMs: { n: searchMs.length, p95: metrics.searchP95Ms, max: Math.max(...searchMs) },
    saveMs: { n: saveMs.length, p95: metrics.saveMs },
    contextMs: { n: contextMs.length, p95: metrics.contextP95Ms },
    coldStartMs: { n: coldStartMs.length, p95: metrics.coldStartMs, kind: "process" },
    interactionMs: { n: interactionMs.length, p95: metrics.interactionP95Ms, kind: "electron", readyMs },
  },
  raw: { searchMs, saveMs, contextMs, coldStartMs, interactionMs, readyMs },
  notes: "10,000 metadata rows and 50,000 search blocks. Cold start is a spawned Node process reopening the same library. Interaction is Electron smoke first paint plus a library tab click. Display-compositor latency is not claimed.",
}, null, 2)}\n`);
if (!passed) {
  console.error(JSON.stringify({ status: "failed", check: "m1a-bench", metrics, targets: requiredBenchTargets }));
  process.exit(1);
}
console.log(JSON.stringify({ status: "passed", check: "m1a-bench", ...metrics, metadataCount: METADATA, searchBlocks: BLOCKS }));
