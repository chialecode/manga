import { describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { LOG_COALESCE_MS, LOG_RETENTION_DAYS, LOG_RETENTION_ROWS, OperationLog } from "../../packages/app-core/src/ops/operation-log.ts";
import { redactDeep, redactText } from "../../packages/app-core/src/ops/redact.ts";
import { recordsList } from "../../packages/app-core/src/ops/records.ts";
import { usageQuery } from "../../packages/app-core/src/ops/usage.ts";
import { BUILTIN_QUICK_TASKS, renderQuickTask, unknownPlaceholders } from "@manga/contracts";
import { seedComic } from "../helpers/media-seed.ts";
import { startApp, waitForRun } from "../helpers/app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle, actor: { kind: "user" | "agent"; id: string } = ctx.actor) {
  counter += 1;
  return ctx.app.call(actor, { commandId, idempotencyKey: `ops-${counter}`, input }, grantHandle);
}
const ok = <T = Record<string, any>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};
const sql = (ctx: App) => ctx.app.store.sqlite;

describe("operation log", () => {
  it("writes what changed, by whom and with what result, and leaves reads and replays out", async () => {
    const ctx = await startApp();
    try {
      const imported = ok<{ resourceId: string; workId: string }>(await run(ctx, "library.importText", { title: "日志之书", bytes: [...Buffer.from("日志测试正文")] }));
      const created = await run(ctx, "notes.create", { title: "一条笔记", text: "笔记正文", resourceId: imported.resourceId });
      ok(created);
      // Reading and listing are not logged; neither is a second delivery of the same request.
      await run(ctx, "notes.list", {});
      await run(ctx, "library.list", {});
      const replay = await ctx.app.call(ctx.actor, { commandId: "notes.create", idempotencyKey: `ops-${counter - 2}`, input: { title: "一条笔记", text: "笔记正文", resourceId: imported.resourceId } }, ctx.grant.handle);
      expect(replay.idempotentReplay).toBe(true);
      const failed = await run(ctx, "notes.delete", { objectId: "obj-missing" });
      expect(failed.status).toBe("error");
      const entries = ctx.app.log.query({}).entries.reverse();
      expect(entries.map((entry) => [entry.action, entry.outcome, entry.actorKind])).toEqual([
        ["library.importText", "ok", "user"],
        ["notes.create", "ok", "user"],
        ["notes.delete", "error", "user"],
      ]);
      expect(entries[0]).toMatchObject({ category: "library", objectKind: "work", objectId: imported.workId, objectLabel: "日志之书" });
      expect(entries[1]).toMatchObject({ category: "notes", objectKind: "resource", requestId: null });
      expect(entries[2]).toMatchObject({ errorCode: "NOT_FOUND" });
    } finally { ctx.app.close(); }
  });

  it("records the Agent's own writes with the run that made them, and says what the system did by itself", async () => {
    const server = await startMockProvider({ streamToolName: "notes.create", streamToolArguments: JSON.stringify({ title: "来自 Agent", text: "工具正文" }) });
    const ctx = await startApp();
    try {
      const secret = ctx.app.stashSecret("log-test-credential-value-123456");
      ok(await run(ctx, "connections.upsert", { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret }));
      const session = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" }));
      const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: session.id, text: "请记一条笔记" }));
      await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
      const entries = ctx.app.log.query({ actorKind: "agent" }).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ action: "notes.create", actorKind: "agent", runId: sent.runId, outcome: "ok", category: "notes" });
      // The log holds names and identifiers; not the credential, and not the text of the note.
      const everything = JSON.stringify(ctx.app.log.query({ limit: 200 }));
      expect(everything).not.toContain("log-test-credential-value-123456");
      expect(everything).not.toContain("工具正文");
      expect(ctx.app.log.query({ category: "connections" }).entries.map((entry) => entry.action)).toEqual(["connections.upsert"]);
    } finally { ctx.app.close(); await server.close(); }
  });

  it("keeps a run of reader view changes as one line, and starts a new one after a pause or another change", async () => {
    const ctx = await startApp();
    try {
      // Zoom and fit buttons in the reader write the reading settings on every click.
      for (const zoom of [0.9, 0.8, 0.7, 0.6, 0.5]) ok(await run(ctx, "settings.setMedia", { comic: { zoom } }));
      let entries = ctx.app.log.query({ category: "settings" }).entries;
      expect(entries.map((entry) => entry.action)).toEqual(["settings.setMedia"]);
      ok(await run(ctx, "settings.setModule", { featureId: "metadata", enabled: false }));
      ok(await run(ctx, "settings.setMedia", { comic: { fit: "width" } }));
      entries = ctx.app.log.query({ category: "settings" }).entries;
      expect(entries.map((entry) => entry.action)).toEqual(["settings.setMedia", "settings.setModule", "settings.setMedia"]);

      // A pause longer than the window, or a failure, is a line of its own.
      let clock = Date.now() + LOG_COALESCE_MS + 1;
      const log = new OperationLog(ctx.app.store, () => clock);
      log.record({ actorKind: "user", actorId: ctx.actor.id, category: "settings", action: "settings.setMedia", outcome: "ok" });
      clock += 1000;
      log.record({ actorKind: "user", actorId: ctx.actor.id, category: "settings", action: "settings.setMedia", outcome: "ok" });
      log.record({ actorKind: "user", actorId: ctx.actor.id, category: "settings", action: "settings.setMedia", outcome: "error", errorCode: "VALIDATION_ERROR" });
      entries = log.query({ category: "settings" }).entries;
      expect(entries.map((entry) => [entry.action, entry.outcome])).toEqual([
        ["settings.setMedia", "error"], ["settings.setMedia", "ok"], ["settings.setMedia", "ok"], ["settings.setModule", "ok"], ["settings.setMedia", "ok"],
      ]);
      expect(entries[1]!.at).toBe(new Date(clock).toISOString());
      // Other changes are never folded together.
      log.record({ actorKind: "user", category: "notes", action: "notes.delete", outcome: "ok", objectId: "n1" });
      log.record({ actorKind: "user", category: "notes", action: "notes.delete", outcome: "ok", objectId: "n1" });
      expect(log.query({ category: "notes" }).entries).toHaveLength(2);
    } finally { ctx.app.close(); }
  });

  it("keeps 180 days and 50 000 rows, pages newest first, and filters", async () => {
    const ctx = await startApp();
    try {
      const day = 86_400_000;
      let clock = Date.now();
      const log = new OperationLog(ctx.app.store, () => clock);
      sql(ctx).prepare("DELETE FROM operation_log").run();
      const insert = sql(ctx).prepare("INSERT INTO operation_log(at, actor_kind, category, action, summary_key, summary_params_json, outcome) VALUES (?,?,?,?,?,?,?)");
      sql(ctx).transaction(() => {
        insert.run(new Date(clock - (LOG_RETENTION_DAYS + 1) * day).toISOString(), "user", "library", "old.entry", "log.old", "{}", "ok");
        insert.run(new Date(clock - (LOG_RETENTION_DAYS - 1) * day).toISOString(), "user", "library", "recent.entry", "log.recent", "{}", "ok");
      })();
      expect(log.prune().removed).toBe(1);
      expect(log.query({}).entries.map((entry) => entry.action)).toEqual(["recent.entry"]);

      // Beyond the cap the oldest rows go first.
      sql(ctx).transaction(() => { for (let i = 0; i < LOG_RETENTION_ROWS + 25; i += 1) insert.run(new Date(clock - i * 1000).toISOString(), "system", "scan", `row.${i}`, "log.row", "{}", i % 7 === 0 ? "error" : "ok"); })();
      log.prune();
      const total = (sql(ctx).prepare("SELECT COUNT(*) AS n FROM operation_log").get() as { n: number }).n;
      expect(total).toBe(LOG_RETENTION_ROWS);
      expect(sql(ctx).prepare("SELECT COUNT(*) AS n FROM operation_log WHERE action = 'recent.entry'").get()).toEqual({ n: 0 });

      clock += 1;
      const page1 = log.query({ limit: 50, category: "scan" });
      expect(page1.entries).toHaveLength(50);
      expect(page1.nextBefore).toBe(page1.entries.at(-1)!.id);
      const page2 = log.query({ limit: 50, category: "scan", before: page1.nextBefore! });
      expect(page2.entries[0]!.id).toBeLessThan(page1.entries.at(-1)!.id);
      expect(log.query({ outcome: "error", limit: 5 }).entries.every((entry) => entry.outcome === "error")).toBe(true);
      expect(log.query({ q: "row.10" }).entries.every((entry) => entry.action.includes("row.10"))).toBe(true);
      expect(log.categories()).toContain("scan");
    } finally { ctx.app.close(); }
  });

  it("shows a task what happened without naming works it was not given, and keeps the owner's pages for the owner", async () => {
    const ctx = await startApp();
    try {
      const seen = ok<{ resourceId: string; workId: string }>(await run(ctx, "library.importText", { title: "给任务看的书", bytes: [...Buffer.from("可见")] }));
      const hidden = ok<{ resourceId: string; workId: string }>(await run(ctx, "library.importText", { title: "不给任务看的书", bytes: [...Buffer.from("不可见")] }));
      const agent = ctx.app.issueAgentGrant(ctx.grant, { kind: "agent", id: "agent:log" }, { readResourceIds: [seen.resourceId] });
      const read = ok<{ entries: Array<{ objectId: string; objectLabel: string | null }> }>(await run(ctx, "log.query", {}, agent.handle, { kind: "agent", id: "agent:log" }));
      expect(read.entries.find((entry) => entry.objectId === seen.workId)?.objectLabel).toBe("给任务看的书");
      expect(read.entries.find((entry) => entry.objectId === hidden.workId)?.objectLabel).toBeNull();
      for (const commandId of ["usage.query", "records.list", "quickTasks.list", "debug.context", "session.stream"]) {
        const denied = await run(ctx, commandId, commandId === "session.stream" ? { sessionId: "x" } : {}, agent.handle, { kind: "agent", id: "agent:log" });
        expect(denied.status, commandId).toBe("error");
        expect(denied.error?.code, commandId).toBe("FORBIDDEN");
      }
    } finally { ctx.app.close(); }
  });
});

describe("usage records", () => {
  it("records the model, tokens and time of each run, and says 'not recorded' for a run that predates them", async () => {
    const server = await startMockProvider({ protocolPrefix: "/v1" });
    const ctx = await startApp();
    try {
      const secret = ctx.app.stashSecret("usage-test-credential-value-123456");
      ok(await run(ctx, "connections.upsert", { label: "mock", protocol: "openai-responses", baseUrl: `${server.url}`, modelId: "demo-model", purpose: "text", credentialHandle: secret }));
      const session = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" }));
      const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: session.id, text: "说点什么" }));
      await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
      // A run saved before these columns existed.
      sql(ctx).prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, created_at, updated_at) VALUES ('old-run', ?, 'succeeded', 'h', '{}', '旧', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(session.id);
      const usage = ok<ReturnType<typeof usageQuery>>(await run(ctx, "usage.query", {}));
      const current = usage.rows.find((row) => row.id === sent.runId)!;
      expect(current).toMatchObject({ kind: "run", recorded: true, modelId: "demo-model", status: "succeeded" });
      expect(current.durationMs).toBeGreaterThanOrEqual(0);
      // The mock service states its tokens on the Responses protocol: they are added up over the steps.
      expect(current.inputTokens).toBeGreaterThan(0);
      expect(current.outputTokens).toBeGreaterThan(0);
      expect(usage.rows.find((row) => row.id === "old-run")).toMatchObject({ recorded: false, modelId: null, inputTokens: null, durationMs: null });
      expect(usage.models).toEqual(["demo-model"]);
      expect(usage.byModel.find((item) => item.key === "demo-model")!.runs).toBe(1);
      expect(usage.byModel.find((item) => item.key === "unrecorded")!.runs).toBe(1);
      const filtered = ok<ReturnType<typeof usageQuery>>(await run(ctx, "usage.query", { modelId: "demo-model" }));
      expect(filtered.rows.map((row) => row.id)).toEqual([sent.runId]);
    } finally { ctx.app.close(); await server.close(); }
  });

  it("leaves tokens empty when the service does not say, and lists transcriptions with the audio they covered", async () => {
    const server = await startMockProvider({});
    const ctx = await startApp();
    try {
      const secret = ctx.app.stashSecret("usage-test-credential-value-654321");
      ok(await run(ctx, "connections.upsert", { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "chat-model", purpose: "text", credentialHandle: secret }));
      const session = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" }));
      const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: session.id, text: "你好" }));
      await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
      sql(ctx).prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, stage, duration_ms) VALUES ('cap-usage', '{}', 'stopped', ?, 'done', 90000)").run(new Date().toISOString());
      const usage = ok<ReturnType<typeof usageQuery>>(await run(ctx, "usage.query", {}));
      expect(usage.rows.find((row) => row.id === sent.runId)).toMatchObject({ recorded: true, modelId: "chat-model", inputTokens: null, outputTokens: null });
      expect(usage.rows.find((row) => row.id === "cap-usage")).toMatchObject({ kind: "transcription", audioMs: 90000, status: "done" });
    } finally { ctx.app.close(); await server.close(); }
  });
});

describe("notes: delete and restore", () => {
  it("hides a deleted note from lists, search and the stream, keeps it, and brings it back as it was", async () => {
    const ctx = await startApp();
    try {
      const imported = ok<{ resourceId: string }>(await run(ctx, "library.importText", { title: "删除之书", bytes: [...Buffer.from("正文")] }));
      const note = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "待删", text: "独特检索词蓝鲸", resourceId: imported.resourceId }));
      const search = async () => ok<unknown[]>(await run(ctx, "library.find", { text: "蓝鲸" }) as never).length;
      expect(await search()).toBeGreaterThan(0);
      ok(await run(ctx, "notes.delete", { objectId: note.objectId }));
      expect(await search()).toBe(0);
      expect(ok<{ notes: unknown[] }>(await run(ctx, "notes.list", {}) as never).notes ?? ok<unknown[]>(await run(ctx, "notes.list", {}) as never)).toHaveLength(0);
      expect((await run(ctx, "notes.get", { objectId: note.objectId })).status).toBe("error");
      expect(recordsList(ctx.app.store, { deleted: true }).items.map((item) => item.id)).toEqual([note.objectId]);
      expect(recordsList(ctx.app.store, {}).items).toHaveLength(0);
      // Deleting twice is the same as once.
      expect(ok<{ deleted: boolean }>(await run(ctx, "notes.delete", { objectId: note.objectId })).deleted).toBe(true);
      const row = sql(ctx).prepare("SELECT revision, deleted_at FROM content_objects WHERE id = ?").get(note.objectId) as { revision: number; deleted_at: string | null };
      expect(row.deleted_at).not.toBeNull();
      expect(row.revision).toBe(1);
      ok(await run(ctx, "notes.undelete", { objectId: note.objectId }));
      expect(await search()).toBeGreaterThan(0);
      expect(ok<{ document: { blocks: Array<{ text: string }> } }>(await run(ctx, "notes.get", { objectId: note.objectId })).document.blocks[0]!.text).toBe("独特检索词蓝鲸");
      expect(recordsList(ctx.app.store, { deleted: true }).items).toHaveLength(0);
      expect((await run(ctx, "notes.undelete", { objectId: "none" })).error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("does not let a task delete a note it was not given", async () => {
    const ctx = await startApp();
    try {
      const imported = ok<{ resourceId: string }>(await run(ctx, "library.importText", { title: "书", bytes: [...Buffer.from("正文")] }));
      const note = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "别人的", text: "x", resourceId: imported.resourceId }));
      const agent = ctx.app.issueAgentGrant(ctx.grant, { kind: "agent", id: "agent:del" }, { readResourceIds: [imported.resourceId] });
      const denied = await run(ctx, "notes.delete", { objectId: note.objectId }, agent.handle, { kind: "agent", id: "agent:del" });
      expect(denied.status).toBe("error");
      expect(denied.error?.code).toBe("FORBIDDEN");
    } finally { ctx.app.close(); }
  });
});

describe("records list", () => {
  it("filters notes and recordings by type, work, medium, state and text, and pages in the database", async () => {
    const ctx = await startApp();
    try {
      const comic = seedComic(ctx.app, { title: "记录漫画", pageCount: 3 });
      const novel = ok<{ resourceId: string; workId?: string }>(await run(ctx, "library.importText", { title: "记录小说", bytes: [...Buffer.from("记录小说正文")] }));
      ok(await run(ctx, "notes.create", { title: "漫画笔记", text: "关于漫画的想法", resourceId: comic.resourceId }));
      ok(await run(ctx, "notes.create", { title: "小说笔记", text: "关于小说的想法", resourceId: novel.resourceId }));
      sql(ctx).prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, stage, duration_ms, work_id, audio_state) VALUES ('cap-1', '{}', 'stopped', ?, 'done', 5000, ?, 'retained')").run(new Date().toISOString(), comic.workId);
      sql(ctx).prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, stage, duration_ms, audio_state) VALUES ('cap-2', '{}', 'stopped', ?, 'failed', 3000, 'staged')").run(new Date().toISOString());
      sql(ctx).prepare("INSERT INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, state, precision, created_at, updated_at) VALUES ('seg1', 'cap-1', 0, 'k', 0, 1000, '录音里说的话', 'done', 'chunk', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
      const list = (filter: Parameters<typeof recordsList>[1]) => recordsList(ctx.app.store, filter);
      expect(list({}).total).toBe(4);
      expect(list({ type: "note" }).items.map((item) => item.title).sort()).toEqual(["小说笔记", "漫画笔记"]);
      expect(list({ type: "recording" }).items.map((item) => item.id).sort()).toEqual(["cap-1", "cap-2"]);
      expect(list({ workId: comic.workId }).items.map((item) => item.kind).sort()).toEqual(["note", "recording"]);
      expect(list({ mediaKind: "comic" }).total).toBe(2);
      expect(list({ state: "failed" }).items.map((item) => item.id)).toEqual(["cap-2"]);
      expect(list({ state: "retained" }).items.map((item) => item.id)).toEqual(["cap-1"]);
      expect(list({ q: "录音里" }).items.map((item) => item.id)).toEqual([]);
      expect(list({ q: "想法" }).total).toBe(2);
      expect(list({ q: "漫画" }).items.every((item) => item.workTitle === "记录漫画" || item.title.includes("漫画"))).toBe(true);
      const recording = list({ type: "recording", workId: comic.workId }).items[0]!;
      expect(recording).toMatchObject({ preview: "录音里说的话", stage: "done", audioState: "retained", workTitle: "记录漫画", mediaKind: "comic" });
      expect(list({ limit: 1, offset: 1 }).items).toHaveLength(1);
    } finally { ctx.app.close(); }
  });

  it("stays quick with ten thousand notes", async () => {
    const ctx = await startApp();
    try {
      const now = new Date().toISOString();
      const insert = sql(ctx).prepare("INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, tags_json, attachment_ids_json, preview_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      sql(ctx).transaction(() => {
        for (let i = 0; i < 10_000; i += 1) insert.run(`obj-bulk-${i}`, "notes.document", "manga.notes", "{}", 1, 1, `批量笔记 ${i}`, JSON.stringify({ blocks: [{ id: "b1", type: "paragraph", text: `正文 ${i}` }] }), "[]", "[]", JSON.stringify({ text: `正文 ${i}` }), new Date(Date.parse(now) - i * 1000).toISOString(), now);
      })();
      const started = performance.now();
      const first = ok<{ items: unknown[]; total: number }>(await run(ctx, "records.list", { limit: 30 }));
      const filtered = ok<{ items: unknown[]; total: number }>(await run(ctx, "records.list", { q: "批量笔记 99", limit: 30, offset: 30 }));
      const elapsed = performance.now() - started;
      expect(first.total).toBe(10_000);
      expect(first.items).toHaveLength(30);
      expect(filtered.total).toBe(111);
      expect(elapsed).toBeLessThan(800);
    } finally { ctx.app.close(); }
  });
});

describe("quick tasks", () => {
  it("starts with the built-in tasks, filters by page, and keeps a deleted one deleted until it is restored", async () => {
    const ctx = await startApp();
    try {
      const all = ok<{ tasks: Array<{ id: string; builtinKey: string | null; name: string; pages: string[]; enabled: boolean }>; placeholders: string[] }>(await run(ctx, "quickTasks.list", {}));
      expect(all.tasks.map((task) => task.builtinKey)).toEqual(BUILTIN_QUICK_TASKS.map((task) => task.builtinKey));
      expect(all.placeholders).toEqual(["作品", "作者", "当前位置", "选区", "字幕窗口", "用户输入"]);
      const onVideo = ok<{ tasks: Array<{ builtinKey: string }> }>(await run(ctx, "quickTasks.list", { page: "video" })).tasks.map((task) => task.builtinKey);
      expect(onVideo.length).toBeGreaterThan(0);
      expect(onVideo.length).toBeLessThan(all.tasks.length);
      expect(all.tasks.filter((task) => task.pages.includes("video")).map((task) => task.builtinKey)).toEqual(onVideo);
      const victim = all.tasks[0]!;
      ok(await run(ctx, "quickTasks.delete", { id: victim.id }));
      expect(ok<{ tasks: unknown[] }>(await run(ctx, "quickTasks.list", { includeDisabled: true })).tasks).toHaveLength(all.tasks.length - 1);
      // Listing again does not bring it back.
      expect(ok<{ tasks: unknown[] }>(await run(ctx, "quickTasks.list", {})).tasks).toHaveLength(all.tasks.length - 1);
      const restored = ok<{ restored: string[]; tasks: Array<{ builtinKey: string | null }> }>(await run(ctx, "quickTasks.restore", {}));
      expect(restored.restored).toEqual([victim.builtinKey]);
      expect(restored.tasks).toHaveLength(all.tasks.length);
      expect((await run(ctx, "quickTasks.restore", { builtinKey: "no-such-task" })).error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("checks the template before saving it, puts a changed built-in task back as shipped, and orders by the user's list", async () => {
    const ctx = await startApp();
    try {
      const base = { name: "我的任务", template: "解释{作品}里{选区}的意思", pages: ["novel", "comic"], includeFrame: false, includeLibrary: false, sendMode: "send" };
      const bad = await run(ctx, "quickTasks.save", { ...base, template: "解释{不存在的占位符}" });
      expect(bad.status).toBe("error");
      expect((bad.error?.details as { reason?: string }).reason).toBe("unknown-placeholder");
      expect(unknownPlaceholders("{作品}{选区}{甲乙}")).toEqual(["甲乙"]);
      const noFrame = await run(ctx, "quickTasks.save", { ...base, pages: ["novel"], includeFrame: true });
      expect((noFrame.error?.details as { reason?: string }).reason).toBe("frame-without-page");
      const saved = ok<{ task: { id: string; builtin: boolean } }>(await run(ctx, "quickTasks.save", base)).task;
      expect(saved.builtin).toBe(false);
      const edited = ok<{ task: { name: string; template: string } }>(await run(ctx, "quickTasks.save", { ...base, id: saved.id, name: "改名后" })).task;
      expect(edited.name).toBe("改名后");

      const builtins = ok<{ tasks: Array<{ id: string; builtinKey: string | null; template: string }> }>(await run(ctx, "quickTasks.list", {})).tasks;
      const first = builtins.find((task) => task.builtinKey)!;
      ok(await run(ctx, "quickTasks.save", { id: first.id, name: "被改过", template: "完全不同的问题", pages: ["novel"], includeFrame: false, includeLibrary: false, sendMode: "fill", enabled: false }));
      expect(ok<{ tasks: unknown[] }>(await run(ctx, "quickTasks.list", { page: "novel" })).tasks.some((task) => (task as { id: string }).id === first.id)).toBe(false);
      const back = ok<{ restored: string[]; tasks: Array<{ id: string; template: string; enabled: boolean; name: string }> }>(await run(ctx, "quickTasks.restore", { builtinKey: first.builtinKey! }));
      expect(back.restored).toEqual([first.builtinKey]);
      expect(back.tasks.find((task) => task.id === first.id)).toMatchObject({ template: first.template, enabled: true });
      expect(back.tasks.find((task) => task.id === first.id)!.name).not.toBe("被改过");

      const ids = ok<{ tasks: Array<{ id: string }> }>(await run(ctx, "quickTasks.list", { includeDisabled: true })).tasks.map((task) => task.id);
      const reversed = [...ids].reverse();
      expect(ok<{ tasks: Array<{ id: string }> }>(await run(ctx, "quickTasks.reorder", { ids: reversed })).tasks.map((task) => task.id)).toEqual(reversed);
    } finally { ctx.app.close(); }
  });

  it("fills a template from what is known and says what it could not fill", () => {
    const notes = { empty: (names: string) => `（没有${names}）`, truncated: "…" };
    const rendered = renderQuickTask("请解释{作品}里“{选区}”，位置：{当前位置}", { 作品: "测试作品", 选区: "一句话", 当前位置: undefined }, notes);
    expect(rendered.text).toContain("测试作品");
    expect(rendered.text).toContain("一句话");
    expect(rendered.text).toContain("（没有当前位置）");
    expect(rendered.text).not.toContain("{");
    expect(rendered.empty).toEqual(["当前位置"]);
    expect(rendered.truncated).toEqual([]);
    const long = renderQuickTask("{选区}", { 选区: "字".repeat(5000) }, notes);
    expect(long.truncated).toEqual(["选区"]);
    expect(long.text.length).toBeLessThan(2100);
  });
});

describe("the message stream of a session", () => {
  it("lists the notes, questions and answers of a resource in order, with page numbers, and leaves out what was deleted", async () => {
    const ctx = await startApp();
    try {
      const comic = seedComic(ctx.app, { title: "消息漫画", pageCount: 5 });
      const first = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "第三页", text: "这一页的想法", resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, locator: { kind: "image", pageId: comic.pageIds[2] }, quoteText: "第 3 页" }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const session = ok<{ id: string; reused: boolean }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId }));
      const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: session.id, text: "这页讲了什么", quickTask: { id: null, name: "解释这一页" } }));
      await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "没有来源", text: "随手记", resourceId: comic.resourceId }));
      const stream = ok<{ items: Array<Record<string, any>>; hasMore: boolean; session: { resourceId: string; workId: string } }>(await run(ctx, "session.stream", { sessionId: session.id }));
      expect(stream.session).toMatchObject({ resourceId: comic.resourceId, workId: comic.workId });
      expect(stream.items.map((item) => item.kind)).toEqual(["note", "user", "agent", "note"]);
      expect(stream.items[0]).toMatchObject({ id: first.objectId, text: "这一页的想法", quote: "第 3 页", pageNumber: 3, anchorId: expect.any(String) });
      expect(stream.items[1]).toMatchObject({ text: "这页讲了什么", quickTask: { name: "解释这一页" } });
      expect(stream.items[2]).toMatchObject({ status: "succeeded" });
      expect(stream.items[3]).toMatchObject({ id: second.objectId, pageNumber: null, quote: "" });
      ok(await run(ctx, "notes.delete", { objectId: first.objectId }));
      const after = ok<{ items: Array<Record<string, any>> }>(await run(ctx, "session.stream", { sessionId: session.id }));
      expect(after.items.map((item) => item.kind)).toEqual(["user", "agent", "note"]);
      expect(ok<{ items: unknown[] }>(await run(ctx, "session.stream", { sessionId: session.id, limit: 1 })).items).toHaveLength(1);
      expect((await run(ctx, "session.stream", { sessionId: "none" })).error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("says there are older messages when a source holds more than a page, and pages back through every one of them", async () => {
    const ctx = await startApp();
    try {
      const comic = seedComic(ctx.app, { title: "很多笔记", pageCount: 2 });
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) ids.push(ok<{ objectId: string }>(await run(ctx, "notes.create", { title: `笔记${index}`, text: `第${index}条`, resourceId: comic.resourceId })).objectId);
      // Each note has a time of its own, so paging by time never meets two notes at one instant.
      const update = sql(ctx).prepare("UPDATE content_objects SET created_at = ? WHERE id = ?");
      sql(ctx).transaction(() => { ids.forEach((id, index) => update.run(new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), id)); })();
      const session = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId }));
      type Page = { items: Array<{ id: string; at: string }>; hasMore: boolean };
      const seen: string[] = [];
      const more: boolean[] = [];
      let before: string | undefined;
      for (let guard = 0; guard < 6; guard += 1) {
        const page = ok<Page>(await run(ctx, "session.stream", { sessionId: session.id, limit: 3, ...(before ? { before } : {}) }));
        seen.unshift(...page.items.map((item) => item.id));
        more.push(page.hasMore);
        if (!page.hasMore) break;
        before = page.items[0]!.at;
      }
      expect(seen).toEqual(ids);
      expect(more).toEqual([true, true, false]);
      // A page that is exactly full is not "more"; one note over is.
      expect(ok<Page>(await run(ctx, "session.stream", { sessionId: session.id, limit: 7 })).hasMore).toBe(false);
      expect(ok<Page>(await run(ctx, "session.stream", { sessionId: session.id, limit: 6 })).hasMore).toBe(true);
    } finally { ctx.app.close(); }
  });

  it("gathers a work's notes from every one of its resources for the work page", async () => {
    const ctx = await startApp();
    try {
      const one = seedComic(ctx.app, { title: "第一卷", pageCount: 2 });
      const two = seedComic(ctx.app, { title: "第二卷", pageCount: 2, workId: one.workId });
      const other = seedComic(ctx.app, { title: "另一部", pageCount: 2 });
      ok(await run(ctx, "notes.create", { title: "甲", text: "第一卷的笔记", resourceId: one.resourceId }));
      ok(await run(ctx, "notes.create", { title: "乙", text: "第二卷的笔记", resourceId: two.resourceId }));
      ok(await run(ctx, "notes.create", { title: "丙", text: "在作品主页写的笔记", workId: one.workId }));
      ok(await run(ctx, "notes.create", { title: "丁", text: "另一部的笔记", resourceId: other.resourceId }));
      const session = ok<{ id: string; kind: string }>(await run(ctx, "session.open", { kind: "work", targetId: one.workId }));
      expect(session.kind).toBe("work");
      expect(ok<{ id: string; reused: boolean }>(await run(ctx, "session.open", { kind: "work", targetId: one.workId })).id).toBe(session.id);
      const stream = ok<{ items: Array<{ kind: string; text: string }> }>(await run(ctx, "session.stream", { sessionId: session.id }));
      expect(stream.items.map((item) => item.text).sort()).toEqual(["第一卷的笔记", "第二卷的笔记", "在作品主页写的笔记"].sort());
      expect((await run(ctx, "session.open", { kind: "work", targetId: "work-none" })).error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });
});

describe("context debug panel", () => {
  it("takes credentials and local paths out of what it shows, and reports what the last task was given", async () => {
    const server = await startMockProvider({});
    const ctx = await startApp();
    try {
      const secret = ctx.app.stashSecret("debug-test-credential-value-123456");
      ok(await run(ctx, "connections.upsert", { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "debug-model", purpose: "text", credentialHandle: secret }));
      const comic = seedComic(ctx.app, { title: "调试漫画", pageCount: 2 });
      const session = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId }));
      const fakeKey = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123"].join("-");
      const fakePath = ["C", ":", "\\", "Users", "someone", "secret-folder", "book.cbz"].join("");
      const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: session.id, text: `看看这个 ${fakeKey} 与 ${fakePath}`, readResourceIds: [comic.resourceId] }));
      await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
      const panel = ok<{ model: { modelId: string; host: string }; tools: Array<{ id: string }>; lastRun: { runId: string; question: string; materials: Array<{ title: string }> }; redactions: { secrets: number; paths: number } }>(await run(ctx, "debug.context", { sessionId: session.id, page: "comic" }));
      const text = JSON.stringify(panel);
      expect(text).not.toContain("debug-test-credential-value-123456");
      expect(text).not.toContain(fakeKey);
      expect(text).not.toContain("secret-folder");
      expect(panel.lastRun.question).toContain("[已隐去]");
      expect(panel.lastRun.question).toContain("[本机路径]");
      expect(panel.redactions.secrets).toBeGreaterThanOrEqual(1);
      expect(panel.redactions.paths).toBeGreaterThanOrEqual(1);
      expect(panel.model.modelId).toBe("debug-model");
      expect(panel.model.host).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(panel.lastRun.runId).toBe(sent.runId);
      expect(panel.lastRun.materials.map((material) => material.title)).toEqual(["调试漫画"]);
      expect(panel.tools.map((tool) => tool.id)).toContain("library.find");
      expect(panel.tools.map((tool) => tool.id)).not.toContain("library.paths.add");
      // Asking never starts a task.
      expect((sql(ctx).prepare("SELECT COUNT(*) AS n FROM agent_runs").get() as { n: number }).n).toBe(1);
    } finally { ctx.app.close(); await server.close(); }
  });

  it("redacts by key name and by shape, at any depth", () => {
    const fakeToken = ["gh", "p_", "a".repeat(30)].join("");
    const result = redactDeep({ apiKey: "abc", nested: { list: [{ authorization: "Bearer xyz", note: `see ${fakeToken}` }], path: ["D", ":/data/books/x.epub"].join("") }, plain: "保留" });
    expect(result.value).toEqual({ apiKey: "[已隐去]", nested: { list: [{ authorization: "[已隐去]", note: "see [已隐去]" }], path: "[本机路径]" }, plain: "保留" });
    expect(result.secrets).toBe(3);
    expect(result.paths).toBe(1);
    expect(redactText("http://" + "user:pw" + "@example.test/x").text).toBe("http://[已隐去]@example.test/x");
    expect(redactText("普通文本，没有需要处理的内容").secrets).toBe(0);
  });
});

describe("the session rows of the left rail", () => {
  it("carry the work's name and cover and where the reader is, for a resource and for a work page", async () => {
    const ctx = await startApp();
    try {
      const comic = seedComic(ctx.app, { title: "左栏漫画", pageCount: 5 });
      const cover = await ctx.app.covers.add(comic.workId, { bytes: await (await import("../helpers/fake-bangumi.ts")).picture("red", [200, 300]), source: "user", select: "user" });
      ok(await run(ctx, "progress.setPage", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[2] }));
      const resourceSession = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId }));
      const workSession = ok<{ id: string }>(await run(ctx, "session.open", { kind: "work", targetId: comic.workId }));
      const rows = ok<Array<Record<string, any>>>(await run(ctx, "workspace.sessions", {}) as never);
      const resourceRow = rows.find((row) => row.sessionId === resourceSession.id)!;
      expect(resourceRow).toMatchObject({ kind: "resource", title: "左栏漫画", workId: comic.workId, workTitle: "左栏漫画", mediaKind: "comic", coverId: cover.cover.id });
      expect(resourceRow.progress).toMatchObject({ unit: "pages", total: 5, locator: { kind: "image", pageId: comic.pageIds[2] } });
      expect(typeof resourceRow.progress.percent).toBe("number");
      const workRow = rows.find((row) => row.sessionId === workSession.id)!;
      expect(workRow).toMatchObject({ kind: "work", workId: comic.workId, coverId: cover.cover.id, mediaKind: "comic", progress: null });
    } finally { ctx.app.close(); }
  });

  it("forget a work's characters and staff when the work goes away", async () => {
    const ctx = await startApp();
    try {
      const comic = seedComic(ctx.app, { title: "将被删除", pageCount: 1 });
      const db = ctx.app.store.sqlite;
      db.prepare("INSERT INTO subject_characters(work_id, provider_id, subject_id, character_id, position, name, relation, summary, actors_json, image_hash, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(comic.workId, "bangumi", "1", "1", 0, "角色", null, null, "[]", null, new Date().toISOString());
      db.prepare("INSERT INTO subject_persons(work_id, provider_id, subject_id, person_id, position, name, relation, career_json, episodes, image_hash, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(comic.workId, "bangumi", "1", "2", 0, "人物", null, "[]", null, null, new Date().toISOString());
      // A work that loses its last resource is removed, with what was saved from its source.
      ok(await run(ctx, "works.moveResource", { resourceId: comic.resourceId, newWorkTitle: "新的作品" }));
      expect(db.prepare("SELECT COUNT(*) AS n FROM works WHERE id = ?").get(comic.workId)).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM subject_characters").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM subject_persons").get()).toEqual({ n: 0 });
    } finally { ctx.app.close(); }
  });
});
