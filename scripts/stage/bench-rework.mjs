import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { MangaProductApp, TestVault } from "../../packages/app-core/src/index.ts";
import { renderCover } from "../samples/media-draw.mjs";
import { p95, p99 } from "./lib.mjs";

/**
 * Measurements the M2 rework adds (plan 14.6), taken on synthetic data only:
 *  - a 5000-file library scan: the main process's event-loop delay and the answer time of the commands the shelf and the settings page
 *    use while the scan runs (both gated), and the scan's throughput (recorded);
 *  - reading covers kept in the image table: the table read, and the handle for a grid thumbnail cold and warm (recorded);
 *  - the right pane with 1000 messages in the real window: scroll and input latency (recorded).
 */

const LAG_INTERVAL_MS = 5;
const SCAN_FILES = { folders: 20, perFolder: 100, loose: 3000 };
const COVERS = 200;
const PANE_NOTES = 1000;
const round = (value) => Math.round(value * 10) / 10;

async function call(app, actor, grant, commandId, input) {
  const result = await app.call(actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, grant.handle);
  if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
  return result.value;
}

async function openApp(dir, hostId) {
  const app = new MangaProductApp({
    profileRoot: path.join(dir, "root"),
    documentsDir: path.join(dir, "documents"),
    pointerPath: path.join(dir, "launcher", "pointer.json"),
    channel: "test",
    hostId,
    vault: new TestVault(hostId),
    useParseWorker: true,
  });
  await app.start();
  const actor = { kind: "user", id: hostId };
  const grant = app.issueOwnerGrant(actor);
  await call(app, actor, grant, "settings.skipAi", {});
  return { app, actor, grant, env: { profileRoot: path.join(dir, "root"), documentsDir: path.join(dir, "documents"), pointerPath: path.join(dir, "launcher", "pointer.json") } };
}

/** Each file is different, so none is read as a copy of another; series folders become works of many chapters, loose files one work each. */
function writeScanTree(root) {
  let files = 0;
  const body = (label) => `${label}\n${"样本正文，用于资源库扫描的基准。".repeat(8)}\n${label} 完。\n`;
  for (let folder = 0; folder < SCAN_FILES.folders; folder += 1) {
    const dir = path.join(root, `系列 ${String(folder).padStart(3, "0")}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let chapter = 1; chapter <= SCAN_FILES.perFolder; chapter += 1) {
      fs.writeFileSync(path.join(dir, `第${String(chapter).padStart(3, "0")}章.txt`), body(`系列${folder}第${chapter}章`));
      files += 1;
    }
  }
  for (let index = 0; index < SCAN_FILES.loose; index += 1) {
    fs.writeFileSync(path.join(root, `单本 ${String(index).padStart(4, "0")}.txt`), body(`单本${index}`));
    files += 1;
  }
  return files;
}

function startLagSampler() {
  const lags = [];
  let expected = performance.now() + LAG_INTERVAL_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + LAG_INTERVAL_MS;
  }, LAG_INTERVAL_MS);
  return { stop() { clearInterval(timer); return lags.map(round); } };
}

/** A 5000-file scan with the shelf's and the settings page's commands asked all the way through it. */
export async function measureScan(dir, { withCovers = false } = {}) {
  const { app, actor, grant } = await openApp(dir, "bench-rework-scan");
  const tree = path.join(dir, "library");
  fs.mkdirSync(tree, { recursive: true });
  const files = writeScanTree(tree);
  const sampler = startLagSampler();
  const interaction = [];
  const kinds = { "works.list": 0, "library.scan.status": 0, "library.paths.list": 0 };
  const probe = async (commandId, input) => {
    const started = performance.now();
    await call(app, actor, grant, commandId, input);
    interaction.push(round(performance.now() - started));
    kinds[commandId] += 1;
  };
  const started = performance.now();
  const added = await call(app, actor, grant, "library.paths.add", { pathHandle: app.registerPath("directory", tree), mediaKind: "novel", autoScan: false });
  let rounds = 0;
  let finished = null;
  for (;;) {
    await probe("works.list", { limit: 60 });
    await probe("library.scan.status", {});
    if (rounds % 5 === 0) await probe("library.paths.list", {});
    rounds += 1;
    const status = await call(app, actor, grant, "library.scan.status", {});
    // The scan is not over for the main process until the pictures and details it queued for the new works have been read as well.
    if (!status.running && status.queued.length === 0 && app.media.jobs.list({ active: true }).length === 0) {
      finished = status.recent.find((job) => job.pathId === added.path.id) ?? null;
      if (finished) break;
    }
    if (performance.now() - started > 20 * 60_000) throw new Error("the benchmark scan did not finish in 20 minutes");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const durationMs = performance.now() - started;
  const loopLag = sampler.stop();
  const works = app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM works").get().n;
  const result = {
    ok: finished?.status === "succeeded" || finished?.status === "completed" || finished?.failed === 0,
    files,
    status: finished?.status ?? null,
    added: finished?.added ?? 0,
    failed: finished?.failed ?? 0,
    works,
    durationMs: Math.round(durationMs),
    throughputFilesPerS: round(files / (durationMs / 1000)),
    loopLag: { intervalMs: LAG_INTERVAL_MS, raw: loopLag, p99: p99(loopLag), max: Math.max(...loopLag) },
    interaction: { raw: interaction, p95: p95(interaction), max: Math.max(...interaction), kinds },
  };
  // Covers are read on the library this scan made, so the works exist.
  const covers = withCovers ? await measureCovers(app, actor, grant) : null;
  app.close();
  return { scan: result, covers };
}

/** Cover pictures kept in the image table: the read itself, and the grid thumbnail's handle built cold and read again warm. */
async function measureCovers(app, actor, grant) {
  const workIds = app.store.sqlite.prepare("SELECT id FROM works ORDER BY id LIMIT ?").all(COVERS).map((row) => row.id);
  const coverIds = [];
  for (const [index, workId] of workIds.entries()) {
    const bytes = await renderCover({ width: 600, height: 900, label: String(index + 1), variant: index % 7 });
    const added = await app.covers.add(workId, { bytes: Buffer.from(bytes), source: "user", select: "user" });
    coverIds.push(added.cover.id);
  }
  const rows = app.store.sqlite.prepare(`SELECT id, image_hash AS hash, area FROM covers WHERE id IN (${coverIds.map(() => "?").join(",")})`).all(...coverIds);
  if (rows.some((row) => row.area !== "images" || !row.hash)) throw new Error("the benchmark covers were not stored in the image table");
  const imageReadMs = [];
  for (const row of rows) {
    const started = performance.now();
    const image = app.covers.images.read(row.hash);
    if (!image.bytes.length) throw new Error("an image-table read returned nothing");
    imageReadMs.push(round(performance.now() - started));
  }
  const handleMs = async (ids) => {
    const out = [];
    for (const id of ids) {
      const started = performance.now();
      const handles = await call(app, actor, grant, "covers.handles", { coverIds: [id], size: "grid" });
      if (!handles.covers?.[0]?.available) throw new Error("a cover handle was not available");
      out.push(round(performance.now() - started));
    }
    return out;
  };
  const coldMs = await handleMs(coverIds);
  const warmMs = await handleMs(coverIds);
  return { covers: coverIds.length, source: "images table", imageReadMs, handleColdMs: coldMs, handleWarmMs: warmMs };
}

/** A resource with 1000 notes bound to it, opened in the real window; the window run reads the pane's scroll and input latency. */
async function measurePane(dir, launch) {
  const { app, actor, grant, env } = await openApp(dir, "bench-rework-pane");
  const book = path.join(dir, "pane-book.txt");
  fs.writeFileSync(book, `${"右栏消息基准正文。".repeat(300)}末尾`);
  const imported = await call(app, actor, grant, "library.importDocument", { title: "右栏基准", pathHandle: app.registerPath("file", book), format: "txt" });
  const resourceId = String(imported.resourceId);
  const base = Date.now() - 24 * 3_600_000;
  const update = app.store.sqlite.prepare("UPDATE content_objects SET created_at = ? WHERE id = ?");
  const ids = [];
  for (let index = 0; index < PANE_NOTES; index += 1) {
    const created = await call(app, actor, grant, "notes.create", { title: `消息 ${index}`, text: `右栏消息 ${index}：一段用于滚动和输入基准的笔记文字。`, resourceId });
    ids.push(String(created.objectId));
  }
  // Each note gets its own time, so the stream's paging by time never meets two notes at one instant.
  app.store.sqlite.exec("BEGIN");
  ids.forEach((id, index) => update.run(new Date(base + index * 1000).toISOString(), id));
  app.store.sqlite.exec("COMMIT");
  app.close();
  const specFile = path.join(dir, "pane-spec.json");
  fs.writeFileSync(specFile, JSON.stringify({ resourceId, notes: PANE_NOTES }));
  const runs = [];
  for (let run = 0; run < 3; run += 1) {
    const launched = { ...process.env, MANGA_CHANNEL: "test", MANGA_PROFILE_ROOT: env.profileRoot, MANGA_DOCUMENTS_DIR: env.documentsDir, MANGA_POINTER_FILE: env.pointerPath, MANGA_SMOKE_PHASE: "bench-pane", MANGA_SMOKE_PANE_SPEC: specFile };
    delete launched.ELECTRON_RUN_AS_NODE;
    const child = launch(launched, dir);
    const file = path.join(env.profileRoot, "logs", "bench-pane-window.json");
    const measured = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
    if (!child || child.status !== 0 || !measured?.ok) return { ok: false, reason: `pane window run ${run} failed (exit ${child?.status})`, measured, stderr: child?.stderr?.slice(-1500) };
    fs.rmSync(file);
    runs.push(measured);
  }
  const merge = (key) => runs.flatMap((item) => item[key].map(round));
  return {
    ok: true,
    kind: "electron-pane-1000",
    notes: PANE_NOTES,
    loaded: runs.map((item) => item.loaded),
    domNodes: runs.map((item) => item.domNodes),
    scrollHeight: runs.map((item) => item.scrollHeight),
    raw: { scrollMs: merge("scrollMs"), inputMs: merge("inputMs") },
    waits: runs[0].waits,
  };
}

/** Three scans of 5000 files, each in a Profile of its own; the delay and answer samples of all of them are judged together. */
export async function runReworkBench({ launch }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-rework-"));
  try {
    const runs = [];
    let covers = null;
    for (let run = 0; run < 3; run += 1) {
      const measured = await measureScan(path.join(root, `scan-${run}`), { withCovers: run === 0 });
      runs.push(measured.scan);
      covers ??= measured.covers;
    }
    const pooled = (pick) => runs.flatMap((item) => pick(item));
    const lag = pooled((item) => item.loopLag.raw);
    const answers = pooled((item) => item.interaction.raw);
    const scan = {
      kind: "service-scan-5000",
      ok: runs.every((item) => item.ok === true && item.added >= item.files),
      files: runs.map((item) => item.files),
      added: runs.map((item) => item.added),
      failed: runs.map((item) => item.failed),
      works: runs.map((item) => item.works),
      durationMs: runs.map((item) => item.durationMs),
      throughputFilesPerS: runs.map((item) => item.throughputFilesPerS),
      loopLag: { intervalMs: LAG_INTERVAL_MS, raw: lag, p99: p99(lag), max: Math.max(...lag), maxPerRun: runs.map((item) => item.loopLag.max) },
      interaction: { raw: answers, p95: p95(answers), max: Math.max(...answers), maxPerRun: runs.map((item) => item.interaction.max), kinds: runs.map((item) => item.interaction.kinds) },
    };
    const pane = await measurePane(path.join(root, "pane"), launch);
    return { ok: scan.ok && pane.ok === true, scan, covers, pane };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
