import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { MangaProductApp, TestVault } from "../../packages/app-core/src/index.ts";
import { p95 } from "./lib.mjs";

// Service-level benchmarks of the creative workspace: they need no window. The windowed ones (whiteboard, mind map) are measured by the
// desktop smoke runs and handed to bench.mjs through the same evidence files.

const DIM = 768;
const VOCABULARY = "雨夜桥灯光水面城市石板路手风琴老人琴键曲子等待回来钢琴比赛评委肖邦夜曲观众掌声少年老师花束火车站大钟旅客站台广播队伍列车煤烟咖啡馆诗集梧桐叶店员杯子海边灯塔渔船沙漠驼队黄昏星空集市面包街角河边钓鱼浮标山路松林溪流清晨薄雾田野麦浪风车";

/** A fixed text from a seed: the same seed gives the same text, so a run can be repeated. */
function textOf(seed, length) {
  let state = (seed * 2654435761) >>> 0;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += VOCABULARY[state % VOCABULARY.length];
    if (i % 17 === 16) out += "，";
  }
  return `${out}。`;
}

/** Hashes character pairs into DIM buckets: texts that share words land close, which is all a controlled provider has to do. */
function embed(text) {
  const vector = new Array(DIM).fill(0);
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const one = chars[i].codePointAt(0);
    vector[(one * 31) % DIM] += 0.4;
    if (i + 1 < chars.length) vector[(one * 131 + chars[i + 1].codePointAt(0) * 17) % DIM] += 1;
  }
  return vector;
}

const controlled = {
  resolve: (id) => ({ id: id ?? "bench-embedding", model: "bench-model", label: "bench" }),
  list: () => [{ id: "bench-embedding", model: "bench-model", label: "bench" }],
  embed: async (_connection, request) => request.inputs.map(embed),
};

/**
 * Semantic search over `segments` recorded sentences: the index is built with a controlled provider, then `runs` different questions are
 * asked through the command, each timed from the call to the answer (the question's vector, the nearest passages and where each one is).
 */
export async function runSemanticBench({ segments, runs, vec }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-semantic-"));
  const app = new MangaProductApp({
    profileRoot: profile, documentsDir: path.join(profile, "documents"), pointerPath: path.join(profile, "launcher", "pointer.json"),
    channel: "test", hostId: "bench-semantic", vault: new TestVault("bench-semantic"), embedding: controlled, semantic: { vec, retryBaseMs: 0 },
  });
  try {
    await app.start();
    const actor = { kind: "user", id: "bench-semantic" };
    const grant = app.issueOwnerGrant(actor);
    const call = async (commandId, input, key) => {
      const result = await app.call(actor, { commandId, idempotencyKey: key, input }, grant.handle);
      if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
      return result.value;
    };
    const sql = app.store.sqlite;
    const at = new Date().toISOString();
    sql.exec("BEGIN");
    const session = sql.prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, updated_at, stage) VALUES (?,?,?,?,?,?)");
    const segment = sql.prepare("INSERT INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, revised_text, state, precision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    const PER = 100;
    for (let s = 0; s < segments / PER; s += 1) {
      session.run(`bench-cap-${s}`, "{}", "done", at, at, "done");
      for (let i = 0; i < PER; i += 1) {
        const n = s * PER + i;
        segment.run(`bench-seg-${n}`, `bench-cap-${s}`, i + 1, `c${n}`, i * 5000, i * 5000 + 4000, textOf(n, 48), null, "done", "segment", at, at);
      }
    }
    sql.exec("COMMIT");

    const built = performance.now();
    await call("semantic.configure", { enabled: true, connectionId: "bench-embedding", segmentation: "paragraph-300" }, "bench-semantic-on");
    await app.semantic.settled();
    const buildMs = performance.now() - built;
    const status = await call("semantic.status", {}, "bench-semantic-status");
    if (!status.active || status.failed) throw new Error(`the semantic index was not built: ${JSON.stringify(status.failed)}`);
    if (status.active.engine !== (vec ? "vec0" : "blob")) throw new Error(`the index was built with ${status.active.engine}, not ${vec ? "vec0" : "blob"}`);

    const samples = [];
    for (let i = 0; i < runs + 5; i += 1) {
      const started = performance.now();
      const found = await call("semantic.search", { text: textOf(segments + i, 24), limit: 10 }, `bench-semantic-q-${i}`);
      const elapsed = performance.now() - started;
      if (found.state !== "ok" || found.results.length === 0) throw new Error(`the search answered ${found.state} with ${found.results.length} results`);
      if (i >= 5) samples.push(elapsed);
    }
    return { engine: status.active.engine, chunks: status.active.chunks, dim: status.active.dim, buildMs, samples, p95: p95(samples) };
  } finally {
    app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const SAMPLE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../dist/samples/media/video/roughcut");

/**
 * A rough cut of `clips` clips from two real videos, checked and exported with the media tool, `runs` times. The figure is what the application
 * itself spends: the time from asking for the check to the finished file, less the time the media tool's own processes ran. The first run reads the
 * videos' frame times (the tool does that work), the others find them kept. Every export is checked for what it holds, so a fast wrong answer fails.
 */
export async function runRoughcutBench({ clips, runs }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-roughcut-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-roughcut-out-"));
  const app = new MangaProductApp({
    profileRoot: profile, documentsDir: path.join(profile, "documents"), pointerPath: path.join(profile, "launcher", "pointer.json"),
    channel: "test", hostId: "bench-roughcut", vault: new TestVault("bench-roughcut"),
  });
  try {
    await app.start();
    if (!app.media.ffmpeg.available) throw new Error("the media tool is not installed");
    const actor = { kind: "user", id: "bench-roughcut" };
    const grant = app.issueOwnerGrant(actor);
    let n = 0;
    const call = async (commandId, input) => {
      n += 1;
      const result = await app.call(actor, { commandId, idempotencyKey: `bench-roughcut-${n}`, input }, grant.handle);
      if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
      return result.value;
    };
    // A file is read from a library path (A-80): the folder of the samples is one.
    await call("library.paths.add", { pathHandle: app.registerPath("directory", SAMPLE_DIR), mediaKind: "video", autoScan: false });
    const videos = [];
    for (const name of ["a.mp4", "b.mp4"]) {
      const file = path.join(SAMPLE_DIR, name);
      if (!fs.existsSync(file)) throw new Error(`the sample ${name} is missing; run node scripts/samples/generate-media-samples.mjs`);
      videos.push((await call("library.importDocument", { title: name, kind: "video", pathHandle: app.registerPath("file", file) })).resourceId);
    }
    const projectId = (await call("project.create", { name: "bench" })).id;
    const cutId = (await call("roughcut.create", { projectId, title: "bench" })).cut.id;
    // Clips of a second and a bit, off the keyframes, two videos in turn: every cut needs a keyframe before it and a frame after it.
    await call("roughcut.edit", { cutId, actions: Array.from({ length: clips }, (_, i) => ({ type: "add", resourceId: videos[i % 2], inMs: (i % 10) * 1000 + 300, outMs: (i % 10) * 1000 + 1500 })) });

    // Every run of the media tool, and how long it ran, whoever asked: the plan's probes and frame times, the cuts, the join, the check.
    const ffmpeg = app.media.ffmpeg;
    const original = ffmpeg.run.bind(ffmpeg);
    // The time the tool was running is the union of those intervals, so two processes at once count once and the figure never undercounts the application's own time.
    let spans = [];
    ffmpeg.run = async (...args) => {
      const from = performance.now();
      try { return await original(...args); } finally { spans.push([from, performance.now()]); }
    };
    const covered = () => {
      let total = 0;
      let end = -Infinity;
      for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
        if (to <= end) continue;
        total += to - Math.max(from, end);
        end = to;
      }
      return total;
    };

    const samples = [];
    const detail = [];
    for (let run = 0; run < runs; run += 1) {
      spans = [];
      const started = performance.now();
      const plan = (await call("roughcut.plan", { cutId })).plan;
      if (!plan.compatible || plan.clips.length !== clips) throw new Error(`the plan was not compatible: ${JSON.stringify(plan.problems)}`);
      const exported = (await call("roughcut.export", { cutId, pathHandle: app.registerPath("directory", out), fileName: `bench-${run}` })).export;
      await app.roughcuts.exports.whenIdle();
      const finished = performance.now();
      const done = app.roughcuts.exports.get(exported.id);
      if (done.state !== "done" || !done.check?.ok) throw new Error(`the export ended ${done.state}: ${JSON.stringify(done.error ?? done.check)}`);
      const expected = plan.clips.reduce((sum, clip) => sum + clip.frames, 0);
      if (done.check.actualFrames !== expected) throw new Error(`the export holds ${done.check.actualFrames} frames, not ${expected}`);
      if (!fs.existsSync(path.join(out, done.fileName))) throw new Error("the finished file is not in the folder");
      const total = finished - started;
      const toolMs = covered();
      samples.push(Math.max(0, total - toolMs));
      detail.push({ totalMs: Math.round(total), toolMs: Math.round(toolMs), frames: expected, recordedOverheadMs: done.timing?.overheadMs ?? null });
    }
    return { clips, samples, detail, p95: p95(samples) };
  } finally {
    app.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

/**
 * What keeping the record of a request costs the application (AT-97). A request of the size a long context makes (about 64 KiB of messages and 12 tool
 * definitions) is begun, gets its first words and is finished with a reply and its tokens, `runs` times, the way the agent loop does it for every request to a
 * model. The figure is the time of those three calls: they run in the main process before and after the request, so what they take is what the task waits.
 * The table already holds a few hundred earlier requests, because a long-lived Profile does. The mode that keeps only sizes is measured too, as a record.
 */
export async function runTraceBench({ runs }) {
  const { DrizzleStore } = await import("@manga/storage-drizzle");
  const { DEFAULT_AGENT_TRACE_SETTINGS } = await import("@manga/contracts/models");
  const { AgentTrace } = await import("../../packages/app-core/src/agent-trace.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-trace-"));
  const store = new DrizzleStore({ profileDir: dir, hostId: "bench-trace" });
  try {
    let settings = { ...DEFAULT_AGENT_TRACE_SETTINGS, mode: "full" };
    const trace = new AgentTrace(store, () => settings);
    const connection = { id: "bench-connection", modelId: "bench-model", protocol: "openai-chat-completions" };
    const messages = [{ role: "system", content: textOf(1, 2000) }];
    for (let i = 0; i < 40; i += 1) messages.push({ role: i % 2 ? "assistant" : "user", content: textOf(100 + i, 520) });
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: `bench.tool${i}`, description: textOf(300 + i, 160), inputSchema: { type: "object", properties: { text: { type: "string", description: textOf(400 + i, 40) }, limit: { type: "integer" } }, required: ["text"] } }));
    const request = { model: "bench-model", messages, tools, temperature: 0.2, maxOutputTokens: 2048 };
    const response = { text: textOf(500, 800), toolCalls: [{ id: "call_1", name: "bench.tool1", arguments: '{"text":"x"}' }] };
    const requestBytes = Buffer.byteLength(JSON.stringify(request));
    const once = (runId, step) => {
      const started = performance.now();
      const handle = trace.begin({ runId, step, kind: "model", connection, request, secrets: [["sk", "bench-credential-0123456789"].join("-")] });
      handle.firstToken();
      handle.finish(response, { inputTokens: 21_000, outputTokens: 400 });
      return performance.now() - started;
    };
    for (let i = 0; i < 400; i += 1) once("bench-history", i);
    for (let i = 0; i < 10; i += 1) once("bench-warm", i);
    const samples = [];
    for (let i = 0; i < runs; i += 1) samples.push(once("bench-run", i));
    settings = { ...settings, mode: "metadata" };
    const metadata = [];
    for (let i = 0; i < Math.min(runs, 100); i += 1) metadata.push(once("bench-metadata", i));
    const kept = trace.list("bench-run").length;
    if (kept !== runs) throw new Error(`the trace holds ${kept} of ${runs} requests`);
    return { samples, requestBytes, detail: { ok: true, requestBytes, historyRequests: 400, kept, metadataModeP95Ms: p95(metadata), metadataModeSamples: metadata.length, mode: "full" } };
  } finally {
    store.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What writing a note as a Markdown file costs the application (AT-102). A note of `blocks` blocks (headings, paragraphs, lists, quotes, code) belongs to a
 * resource; for each of `runs` saves one block's text is changed, and the write that save queues is made at once (the application makes it after a short wait,
 * in the main process, so what it takes is what the window waits for while it runs). The figure is the time of that write: reading the note, making the Markdown,
 * writing the file and keeping its record. The time the save itself takes to be answered is recorded beside it, not counted: the write is not part of it.
 * Every run is checked for what it wrote, so a fast wrong answer fails.
 */
export async function runNoteFileBench({ runs, blocks }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-notefile-"));
  const library = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-notefile-lib-"));
  const app = new MangaProductApp({
    profileRoot: profile, documentsDir: path.join(profile, "documents"), pointerPath: path.join(profile, "launcher", "pointer.json"),
    channel: "test", hostId: "bench-notefile", vault: new TestVault("bench-notefile"),
  });
  try {
    await app.start();
    const actor = { kind: "user", id: "bench-notefile" };
    const grant = app.issueOwnerGrant(actor);
    let n = 0;
    const call = async (commandId, input) => {
      n += 1;
      const result = await app.call(actor, { commandId, idempotencyKey: `bench-notefile-${n}`, input }, grant.handle);
      if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
      return result.value;
    };
    const book = path.join(library, "书", "第1卷.txt");
    fs.mkdirSync(path.dirname(book), { recursive: true });
    fs.writeFileSync(book, `第一章\n\n${textOf(7, 600)}\n`);
    await call("library.paths.add", { pathHandle: app.registerPath("directory", library), mediaKind: "novel", autoScan: false });
    const resourceId = (await call("library.importDocument", { title: "第1卷", kind: "novel", pathHandle: app.registerPath("file", book) })).resourceId;
    const note = await call("notes.create", { title: "笔记写成文件", text: "开头", resourceId });
    const list = [];
    for (let i = 0; i < blocks; i += 1) {
      const kind = i % 10 === 0 ? "heading" : i % 10 === 5 ? "quote" : i % 10 === 8 ? "code" : i % 10 >= 6 ? "list" : "paragraph";
      list.push({ id: `b${i}`, type: kind, ...(kind === "heading" ? { level: 2 } : {}), text: kind === "code" ? `${textOf(2000 + i, 40)}\n${textOf(3000 + i, 40)}` : textOf(1000 + i, 90) });
    }
    let revision = (await call("notes.replace", { objectId: note.objectId, expectedRevision: note.revision, blocks: list })).revision;
    app.noteFiles.flush();
    const file = () => app.workFolders.pathOf(app.store.sqlite.prepare("SELECT id FROM work_files WHERE kind = 'note' AND ref_id = ?").get(note.objectId).id);
    const samples = [];
    const saveMs = [];
    for (let run = 0; run < runs; run += 1) {
      const marker = `第${run}次保存`;
      const target = list[(run * 7) % blocks];
      const before = app.noteFiles.writes;
      const savedFrom = performance.now();
      revision = (await call("notes.update", { objectId: note.objectId, expectedRevision: revision, blockId: target.id, text: `${marker}${target.text}` })).revision;
      saveMs.push(performance.now() - savedFrom);
      const started = performance.now();
      app.noteFiles.flush();
      samples.push(performance.now() - started);
      if (app.noteFiles.writes - before !== 1) throw new Error(`the save of run ${run} made ${app.noteFiles.writes - before} writes`);
      if (!fs.readFileSync(file(), "utf8").includes(marker)) throw new Error(`the file does not hold the change of run ${run}`);
    }
    const bytes = fs.statSync(file()).size;
    return { samples, blocks, detail: { ok: true, blocks, fileBytes: bytes, saveReceiptP95Ms: p95(saveMs), saveSamples: saveMs.length } };
  } finally {
    app.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(library, { recursive: true, force: true });
  }
}

/**
 * Pending proposals in a project of `objects` objects (计划第 7 节, AT-151—AT-156):
 * - `propose`: time to propose deleting an object (`proposal.delete`, including backlink query across embeds, whiteboard reference cards and mind map node refs, plus preview generation) in a project with 500 objects;
 * - `apply`: time from confirming a proposal (`proposal.apply`) until both the target object and the proposal card (`proposal.list`) are updated;
 * - `migrationV14`: recorded time to migrate a v13 profile database (with projects, sessions, runs and messages) to schema v14 with pre-migration backup.
 */
export async function runProposalBench({ objects = 500, proposeRuns = 30, applyRuns = 20 }) {
  const { DrizzleStore } = await import("@manga/storage-drizzle");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-proposals-"));
  const v13Root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-v14mig-"));
  const app = new MangaProductApp({
    profileRoot: profile,
    documentsDir: path.join(profile, "documents"),
    pointerPath: path.join(profile, "launcher", "pointer.json"),
    channel: "test",
    hostId: "bench-proposals",
    vault: new TestVault("bench-proposals"),
  });
  try {
    await app.start();
    const ownerActor = { kind: "user", id: "bench-proposals" };
    const ownerGrant = app.issueOwnerGrant(ownerActor);
    let seq = 0;
    const callOwner = async (commandId, input) => {
      seq += 1;
      const result = await app.call(ownerActor, { commandId, idempotencyKey: `bench-prop-owner-${seq}`, input }, ownerGrant.handle);
      if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
      return result.value;
    };

    const projectId = (await callOwner("project.create", { name: "500对象基准项目" })).id;
    const session = await callOwner("session.open", { kind: "project", targetId: projectId, contextId: projectId });
    const sessionId = session.id;

    // Seed 500 objects in the project (200 whiteboards, 150 mindmaps, 150 drafts) and cross-references in a transaction.
    const wbCount = 200;
    const mmCount = 150;
    const drCount = Math.max(1, objects - wbCount - mmCount);
    const totalObjects = wbCount + mmCount + drCount;
    const now = new Date().toISOString();
    const sql = app.store.sqlite;
    sql.exec("BEGIN");
    const insWb = sql.prepare("INSERT INTO whiteboards(id, project_id, title, viewport_json, created_at, updated_at) VALUES (?, ?, ?, '{\"x\":0,\"y\":0,\"zoom\":1}', ?, ?)");
    const insWbNode = sql.prepare("INSERT INTO whiteboard_nodes(id, board_id, kind, x, y, w, h, z, parent_id, data_json, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 160, 90, 1, NULL, ?, ?, ?)");
    const insMm = sql.prepare("INSERT INTO mindmaps(id, project_id, title, theme, created_at, updated_at) VALUES (?, ?, ?, 'pink', ?, ?)");
    const insMmNode = sql.prepare("INSERT INTO mindmap_nodes(id, map_id, parent_id, sort_key, text, collapsed, refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)");
    const insDr = sql.prepare("INSERT INTO drafts(id, project_id, title, text, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)");
    const insEmbed = sql.prepare("INSERT INTO embeds(id, source_kind, source_id, slot, target_kind, target_id, locator_json, mode, snapshot_json, snapshot_version, created_at, updated_at) VALUES (?, ?, ?, ?, 'whiteboard', ?, '{}', 'live', NULL, NULL, ?, ?)");

    for (let i = 0; i < wbCount; i += 1) {
      const wbId = `wb_bench_${i}`;
      insWb.run(wbId, projectId, `基准白板${i}`, now, now);
      insWbNode.run(`wbn_card_${i}`, wbId, "card", JSON.stringify({ title: `卡片${i}`, text: textOf(i + 1, 24) }), now, now);
      if (i > 0) {
        const refTarget = `wb_bench_${(i - 1) % 60}`;
        insWbNode.run(`wbn_ref_${i}`, wbId, "ref", JSON.stringify({ refKind: "whiteboard", refId: refTarget, title: `引用${refTarget}` }), now, now);
      }
    }
    for (let i = 0; i < mmCount; i += 1) {
      const mmId = `mm_bench_${i}`;
      const refTarget = `wb_bench_${i % 60}`;
      insMm.run(mmId, projectId, `基准导图${i}`, now, now);
      insMmNode.run(`mmn_root_${i}`, mmId, null, "0", `导图根${i}`, JSON.stringify([{ kind: "whiteboard", targetId: refTarget }]), now, now);
      insEmbed.run(`emb_bench_${i}`, "mindmap", mmId, `slot_${i}`, refTarget, now, now);
    }
    for (let i = 0; i < drCount; i += 1) {
      insDr.run(`dr_bench_${i}`, projectId, `基准文稿${i}`, textOf(500 + i, 80), now, now);
    }
    sql.exec("COMMIT");

    const runId = "run_bench_proposals";
    sql.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, live_text, created_at, updated_at) VALUES (?, ?, 'running', 'g_bench', '{}', '基准测试', '', ?, ?)").run(runId, sessionId, now, now);
    const agentActor = { kind: "agent", id: `agent:${runId}` };
    const agentGrant = app.issueAgentGrant(ownerGrant, agentActor, { sessionId, runId, readResourceIds: [], projectId });

    // 1. Measure proposal.delete (with backlink query & preview generation) across 500 objects.
    const proposeSamples = [];
    for (let i = 0; i < proposeRuns + 5; i += 1) {
      const targetId = `wb_bench_${i % 50}`;
      const t0 = performance.now();
      const res = await app.call(
        agentActor,
        { commandId: "proposal.delete", idempotencyKey: `bench-propose-${i}`, input: { kind: "whiteboard", targetId, reason: "基准测试删除预览" } },
        agentGrant.handle,
      );
      const elapsed = performance.now() - t0;
      // Agent replies intentionally contain only the compact receipt. Inspect the owner-only card
      // to keep this benchmark checking the full preview and backlink query without widening the
      // model-visible result contract.
      const card = res.status === "ok" && res.value?.proposalId ? app.proposals.getCard(res.value.proposalId) : null;
      if (
        res.status !== "ok" ||
        !res.value?.proposalId ||
        typeof res.value?.summary !== "string" ||
        !card ||
        !Array.isArray(card.preview.lines) ||
        typeof card.preview.meta?.backlinks !== "number"
      ) {
        throw new Error(`proposal.delete failed in bench: ${JSON.stringify(res)}`);
      }
      if (i >= 5) proposeSamples.push(elapsed);
      // Reject immediately so pending count stays below the per-session cap (20).
      await callOwner("proposal.reject", { proposalId: res.value.proposalId });
    }

    // 2. Measure proposal.apply -> object & card both updated.
    const applySamples = [];
    for (let i = 0; i < applyRuns + 3; i += 1) {
      const targetId = `dr_bench_${i % drCount}`;
      const newTitle = `已确认改名文稿_${i}`;
      const proposed = await app.call(
        agentActor,
        { commandId: "proposal.rename", idempotencyKey: `bench-apply-prep-${i}`, input: { kind: "draft", targetId, title: newTitle, reason: "基准确认耗时" } },
        agentGrant.handle,
      );
      if (proposed.status !== "ok") throw new Error(`proposal.rename prep failed: ${JSON.stringify(proposed)}`);
      const proposalId = proposed.value.proposalId;

      const t0 = performance.now();
      const applied = await callOwner("proposal.apply", { proposalId });
      const listed = await callOwner("proposal.list", { sessionId });
      const draftNow = await callOwner("draft.get", { draftId: targetId });
      const elapsed = performance.now() - t0;

      const card = listed.proposals.find((p) => p.id === proposalId);
      if (applied.proposal.status !== "applied" || card?.status !== "applied" || draftNow.draft.title !== newTitle) {
        throw new Error(`proposal.apply did not update both object and card in run ${i}`);
      }
      if (i >= 3) applySamples.push(elapsed);
    }

    // 3. Measure schema v13 -> v14 migration (recorded metric).
    const v13DataDir = path.join(v13Root, "data");
    fs.mkdirSync(v13DataDir, { recursive: true });
    const seedStore = new DrizzleStore({ profileDir: v13DataDir, hostId: "bench-v13-seed" });
    seedStore.sqlite.exec("BEGIN");
    for (let p = 0; p < 10; p += 1) {
      seedStore.sqlite.prepare("INSERT INTO projects(id, name, goal, status, created_at, updated_at) VALUES (?, ?, '', 'active', ?, ?)").run(`proj_${p}`, `项目${p}`, now, now);
      seedStore.sqlite.prepare("INSERT INTO agent_sessions(id, title, kind, target_id, project_id, grant_handle, created_at, updated_at) VALUES (?, ?, 'project', ?, ?, 'g', ?, ?)").run(`ses_${p}`, `对话${p}`, `proj_${p}`, `proj_${p}`, now, now);
      for (let r = 0; r < 10; r += 1) {
        seedStore.sqlite.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, live_text, created_at, updated_at) VALUES (?, ?, 'succeeded', 'g', '{}', '问题', '回答', ?, ?)").run(`run_${p}_${r}`, `ses_${p}`, now, now);
      }
    }
    seedStore.sqlite.exec("COMMIT");
    seedStore.sqlite.exec("DROP TABLE IF EXISTS agent_proposals");
    seedStore.sqlite.prepare("UPDATE schema_meta SET value = '13' WHERE key = 'schemaVersion'").run();
    seedStore.close();

    const migStart = performance.now();
    const migApp = new MangaProductApp({
      profileRoot: v13Root,
      documentsDir: path.join(v13Root, "documents"),
      pointerPath: path.join(v13Root, "launcher", "pointer.json"),
      channel: "test",
      hostId: "bench-v14-mig",
      vault: new TestVault("bench-v14-mig"),
    });
    await migApp.start();
    const migrateV14Ms = Math.round((performance.now() - migStart) * 100) / 100;
    const migInfo = migApp.store.migration;
    const backupExists = fs.existsSync(path.join(v13DataDir, "manga.sqlite.premigrate-v13"));
    migApp.close();
    if (migInfo?.from !== 13 || (migInfo?.to ?? 0) < 14 || !backupExists) {
      throw new Error(`v13 -> v14+ migration benchmark check failed: ${JSON.stringify({ migInfo, backupExists })}`);
    }

    return {
      objects: totalObjects,
      propose: { samples: proposeSamples, p95: p95(proposeSamples), detail: { ok: true, objects: totalObjects, backlinksQueried: true } },
      apply: { samples: applySamples, p95: p95(applySamples), detail: { ok: true, objects: totalObjects } },
      migrationV14: { ok: true, ms: migrateV14Ms, from: 13, to: migInfo.to, backupCreated: backupExists, runs: 100 },
    };
  } finally {
    app.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(v13Root, { recursive: true, force: true });
  }
}
