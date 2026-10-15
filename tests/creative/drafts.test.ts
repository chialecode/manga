import { afterEach, describe, expect, it } from "vitest";
import type { LlmConnection, LlmPort } from "../../packages/app-core/src/voice/ports.ts";
import { compose } from "../../packages/app-core/src/creative/drafts.ts";
import { startApp, tempProfile } from "../helpers/app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
type Doc = { id: string; title: string; text: string; version: number };
type Suggestion = {
  id: string; kind: string; status: string; baseVersion: number; adoptedVersion: number | null; preview: string; baseChanged: boolean; stale: boolean; model: string | null; connectionId: string | null;
  error: { code: string; message: string } | null; range: { start: number; end: number } | null;
  sources: Array<{ kind: string; targetId: string; label: string; state: string; before?: string; after?: string | null }>;
  baseText?: string; resultText?: string; generated?: string; quoted?: Array<{ kind: string; label: string; text: string }>;
};

let counter = 0;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

/** A text model that answers from the test: records what it was asked, and can be made to wait, fail or return nothing. */
function controlledLlm() {
  const requests: Array<{ connection: LlmConnection; system: string; user: string }> = [];
  const state: { reply: (user: string, signal: AbortSignal) => string | Promise<string> } = { reply: () => "生成的内容" };
  const port: LlmPort = {
    resolve: (id) => (id && !["conn-a", "conn-b"].includes(id) ? null : { id: id ?? "conn-a", model: "test-model" }),
    complete: async (connection, request) => { requests.push({ connection, system: request.system, user: request.user }); return state.reply(request.user, request.signal); },
  };
  return { port, requests, state };
}

async function boot(llm?: LlmPort, profileRoot?: string) {
  const ctx = await startApp({ profileRoot, options: llm ? { llm } : undefined });
  apps.push(ctx);
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `drf-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const failure = (result: Call) => { expect(result.status).toBe("error"); return result.error as { code: string; details?: Record<string, unknown> }; };

async function setup(ctx: App, text = "第一段。\n\n第二段。") {
  const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "文案项目" }));
  const draft = ok<{ draft: Doc }>(await run(ctx, "draft.create", { projectId: project.id, title: "稿子", text })).draft;
  return { projectId: project.id, draft };
}
const suggest = async (ctx: App, draftId: string, input: Record<string, unknown>) => ok<{ suggestion: Suggestion }>(await run(ctx, "draft.suggest", { draftId, ...input })).suggestion;
const detail = async (ctx: App, id: string) => ok<{ suggestion: Suggestion }>(await run(ctx, "draft.suggestion", { suggestionId: id })).suggestion;
const getDraft = async (ctx: App, draftId: string) => ok<{ draft: Doc; versions: Array<{ version: number; label: string; current: boolean }>; suggestions: Suggestion[] }>(await run(ctx, "draft.get", { draftId }));
async function note(ctx: App, title: string, text: string) {
  const created = ok<{ objectId: string }>(await run(ctx, "notes.create", { title, text }));
  return created.objectId;
}
async function rewriteNote(ctx: App, objectId: string, text: string) {
  const got = ok<{ revision: number }>(await run(ctx, "notes.get", { objectId }));
  ok(await run(ctx, "notes.replace", { objectId, expectedRevision: got.revision, blocks: [{ id: "b1", type: "paragraph", text }] }));
}

describe("drafts and their versions (CRE-05)", () => {
  it("creates, saves, renames and deletes a draft, refuses a save made from a stale version, and keeps what was named", async () => {
    const ctx = await boot();
    const { projectId, draft } = await setup(ctx);
    expect(draft).toMatchObject({ version: 1, text: "第一段。\n\n第二段。" });
    expect(ok<{ drafts: Array<{ id: string; chars: number; pending: number }> }>(await run(ctx, "draft.list", { projectId })).drafts).toEqual([expect.objectContaining({ id: draft.id, chars: 10, pending: 0 })]);

    const saved = ok<{ draft: Doc }>(await run(ctx, "draft.save", { draftId: draft.id, expectedVersion: 1, text: "第一段改了。" })).draft;
    expect(saved.version).toBe(2);
    expect(ok<{ draft: Doc }>(await run(ctx, "draft.save", { draftId: draft.id, expectedVersion: 2, text: "第一段改了。" })).draft.version).toBe(2);
    expect(failure(await run(ctx, "draft.save", { draftId: draft.id, expectedVersion: 1, text: "旧窗口写的" })).code).toBe("REVISION_CONFLICT");
    expect((await getDraft(ctx, draft.id)).draft.text).toBe("第一段改了。");

    ok(await run(ctx, "draft.checkpoint", { draftId: draft.id, label: "初稿" }));
    const afterNamed = ok<{ draft: Doc }>(await run(ctx, "draft.save", { draftId: draft.id, expectedVersion: 2, text: "第三版" })).draft;
    expect(afterNamed.version).toBe(3);
    const versions = (await getDraft(ctx, draft.id)).versions;
    expect(versions.map((item) => [item.version, item.label, item.current])).toEqual([[3, "", true], [2, "初稿", false], [1, "", false]]);
    expect(ok<{ text: string }>(await run(ctx, "draft.version", { draftId: draft.id, version: 2 })).text).toBe("第一段改了。");

    expect(ok<{ draft: Doc }>(await run(ctx, "draft.rename", { draftId: draft.id, title: "新名字" })).draft.title).toBe("新名字");
    const removed = ok<{ versions: number }>(await run(ctx, "draft.delete", { draftId: draft.id }));
    expect(removed.versions).toBeGreaterThan(0);
    expect(failure(await run(ctx, "draft.get", { draftId: draft.id })).code).toBe("NOT_FOUND");
  });

  it("goes back to an earlier version as a new one, and keeps the text it left so going back can be gone back from", async () => {
    const ctx = await boot();
    const { draft } = await setup(ctx, "原文");
    ok(await run(ctx, "draft.checkpoint", { draftId: draft.id, label: "起点" }));
    ok(await run(ctx, "draft.save", { draftId: draft.id, expectedVersion: 1, text: "改过的" }));
    const back = ok<{ draft: Doc }>(await run(ctx, "draft.restore", { draftId: draft.id, version: 1 })).draft;
    expect(back).toMatchObject({ text: "原文", version: 3 });
    const labels = (await getDraft(ctx, draft.id)).versions;
    // What was there before going back is a version of its own, named for what happened.
    const left = labels.find((item) => item.label === "回到 v1 之前");
    expect(left).toBeTruthy();
    expect(ok<{ text: string }>(await run(ctx, "draft.version", { draftId: draft.id, version: left!.version })).text).toBe("改过的");
    expect(failure(await run(ctx, "draft.restore", { draftId: draft.id, version: 99 })).code).toBe("NOT_FOUND");
  });
});

describe("suggestions: written from the draft and its sources, kept apart until taken (AT-29)", () => {
  it("composes a suggestion for each kind and leaves the draft as it was until it is adopted", async () => {
    const llm = controlledLlm();
    const ctx = await boot(llm.port);
    const { draft } = await setup(ctx, "开头。结尾。");

    llm.state.reply = () => "1. 缘起\n2. 经过";
    let made = await suggest(ctx, draft.id, { kind: "outline" });
    expect(made.status).toBe("running");
    await ctx.app.drafts.settled();
    let done = await detail(ctx, made.id);
    expect(done).toMatchObject({ status: "pending", generated: "1. 缘起\n2. 经过", model: "test-model", connectionId: "conn-a" });
    expect(done.resultText).toBe("1. 缘起\n2. 经过\n\n开头。结尾。");
    expect((await getDraft(ctx, draft.id)).draft.text).toBe("开头。结尾。");

    llm.state.reply = () => "接下来的话。";
    made = await suggest(ctx, draft.id, { kind: "continue", instruction: "语气轻松" });
    await ctx.app.drafts.settled();
    done = await detail(ctx, made.id);
    expect(done.resultText).toBe("开头。结尾。\n\n接下来的话。");
    expect(llm.requests.at(-1)!.user).toContain("要求：语气轻松");

    // A range limits the work to that part: only it is replaced, the rest stays.
    llm.state.reply = () => "【润色后的开头】";
    made = await suggest(ctx, draft.id, { kind: "polish", range: { start: 0, end: 3 } });
    await ctx.app.drafts.settled();
    done = await detail(ctx, made.id);
    expect(done.resultText).toBe("【润色后的开头】结尾。");
    expect(done.range).toEqual({ start: 0, end: 3 });
    expect(llm.requests.at(-1)!.user).toContain("待处理的文字：\n开头。");
    expect(llm.requests.at(-1)!.user).not.toContain("结尾");

    llm.state.reply = () => "Opening. Ending.";
    made = await suggest(ctx, draft.id, { kind: "translate", language: "英文" });
    await ctx.app.drafts.settled();
    expect((await detail(ctx, made.id)).resultText).toBe("Opening. Ending.");
    expect(llm.requests.at(-1)!.user).toContain("翻译成英文");
  });

  it("rewrites by the project's term list, and quotes the chosen materials with their numbers", async () => {
    const llm = controlledLlm();
    const ctx = await boot(llm.port);
    const { projectId, draft } = await setup(ctx, "那个机械人很强。");
    expect(failure(await run(ctx, "draft.suggest", { draftId: draft.id, kind: "terms" })).details).toMatchObject({ reason: "noTerms" });
    ok(await run(ctx, "project.addTerm", { projectId, term: "机器人", heard: "机械人", note: "统一写法" }));
    llm.state.reply = () => "那个机器人很强。";
    const rewritten = await suggest(ctx, draft.id, { kind: "terms" });
    await ctx.app.drafts.settled();
    expect(llm.requests.at(-1)!.user).toContain("术语表：\n机器人（常被听成：机械人）：统一写法");
    expect(await detail(ctx, rewritten.id)).toMatchObject({ status: "pending", resultText: "那个机器人很强。", sources: [expect.objectContaining({ kind: "terms", label: "术语表", state: "same" })] });

    expect(failure(await run(ctx, "draft.suggest", { draftId: draft.id, kind: "cite" })).details).toMatchObject({ reason: "noSources" });
    const n1 = await note(ctx, "资料一", "机器人诞生于二十世纪。");
    const map = ok<{ map: { id: string } }>(await run(ctx, "mindmap.create", { projectId, title: "脉络", rootText: "机器人史" })).map.id;
    llm.state.reply = () => "机器人诞生于二十世纪 [1]。";
    const cited = await suggest(ctx, draft.id, { kind: "cite", sources: [{ kind: "note", targetId: n1 }, { kind: "mindmap", targetId: map }] });
    await ctx.app.drafts.settled();
    const user = llm.requests.at(-1)!.user;
    expect(user).toContain("[1] 资料一\n机器人诞生于二十世纪。");
    expect(user).toContain("[2] 脉络\n- 机器人史");
    const view = await detail(ctx, cited.id);
    // The quoted material is kept apart from what was generated.
    expect(view.quoted).toEqual([expect.objectContaining({ label: "资料一", text: "机器人诞生于二十世纪。" }), expect.objectContaining({ label: "脉络" })]);
    expect(view.generated).toBe("机器人诞生于二十世纪 [1]。");
    expect(view.resultText).toBe("那个机械人很强。\n\n机器人诞生于二十世纪 [1]。");
    // A draft cannot be made from itself, and a source that is not there is refused.
    expect(failure(await run(ctx, "draft.suggest", { draftId: draft.id, kind: "cite", sources: [{ kind: "draft", targetId: draft.id }] })).details).toMatchObject({ reason: "self" });
    expect(failure(await run(ctx, "draft.suggest", { draftId: draft.id, kind: "cite", sources: [{ kind: "note", targetId: "note-none" }] })).code).toBe("NOT_FOUND");
  });

  it("takes a suggestion into the draft, keeps the text from before as a version, and can undo it and take it again", async () => {
    const llm = controlledLlm();
    const ctx = await boot(llm.port);
    const { draft } = await setup(ctx, "原来的话");
    llm.state.reply = () => "润色过的话";
    const made = await suggest(ctx, draft.id, { kind: "polish" });
    await ctx.app.drafts.settled();

    const taken = ok<{ draft: Doc; suggestion: Suggestion }>(await run(ctx, "draft.adopt", { suggestionId: made.id }));
    expect(taken.draft).toMatchObject({ text: "润色过的话", version: 2 });
    expect(taken.suggestion).toMatchObject({ status: "adopted", adoptedVersion: 2 });
    const labels = (await getDraft(ctx, draft.id)).versions.map((item) => item.label);
    expect(labels).toEqual(expect.arrayContaining(["采纳前：润色", "采纳：润色"]));
    // Taken once, it cannot be taken again, and an adopted one is undone rather than put aside.
    expect(failure(await run(ctx, "draft.adopt", { suggestionId: made.id })).details).toMatchObject({ reason: "state" });
    expect(failure(await run(ctx, "draft.discardSuggestion", { suggestionId: made.id })).details).toMatchObject({ reason: "state" });

    const undone = ok<{ draft: Doc; suggestion: Suggestion }>(await run(ctx, "draft.undoAdopt", { suggestionId: made.id }));
    expect(undone.draft.text).toBe("原来的话");
    expect(undone.suggestion).toMatchObject({ status: "pending", adoptedVersion: null, baseChanged: false });
    expect((await getDraft(ctx, draft.id)).versions.map((item) => item.label)).toEqual(expect.arrayContaining(["撤销采纳：润色"]));
    expect(ok<{ draft: Doc }>(await run(ctx, "draft.adopt", { suggestionId: made.id })).draft.text).toBe("润色过的话");
    expect(failure(await run(ctx, "draft.undoAdopt", { suggestionId: (await suggest(ctx, draft.id, { kind: "continue" })).id })).details).toMatchObject({ reason: "state" });
  });

  it("does not overwrite a draft that changed after the suggestion, unless asked, and keeps what was typed as a version", async () => {
    const llm = controlledLlm();
    const ctx = await boot(llm.port);
    const { draft } = await setup(ctx, "一二三");
    llm.state.reply = () => "续写";
    const made = await suggest(ctx, draft.id, { kind: "continue" });
    await ctx.app.drafts.settled();
    ok(await run(ctx, "draft.save", { draftId: draft.id, expectedVersion: 1, text: "一二三四" }));
    expect((await detail(ctx, made.id)).baseChanged).toBe(true);
    expect(failure(await run(ctx, "draft.adopt", { suggestionId: made.id })).details).toMatchObject({ reason: "draftChanged", baseVersion: 1, version: 2 });
    expect((await getDraft(ctx, draft.id)).draft.text).toBe("一二三四");

    // Insisting makes the same change on the newer text, and the typed text stays reachable as a version.
    const forced = ok<{ draft: Doc }>(await run(ctx, "draft.adopt", { suggestionId: made.id, force: true })).draft;
    expect(forced.text).toBe("一二三四\n\n续写");
    const typed = (await getDraft(ctx, draft.id)).versions.find((item) => item.label === "采纳前：续写");
    expect(ok<{ text: string }>(await run(ctx, "draft.version", { draftId: draft.id, version: typed!.version })).text).toBe("一二三四");
  });

  it("says its basis changed when a source changes or goes, shows old against new, and lets the person keep it or have it made again", async () => {
    const llm = controlledLlm();
    const ctx = await boot(llm.port);
    const { draft } = await setup(ctx, "稿");
    const n1 = await note(ctx, "资料甲", "旧的说法");
    const n2 = await note(ctx, "资料乙", "不会变的");
    llm.state.reply = (user) => `依据：${user.includes("新的说法") ? "新" : "旧"}`;
    const made = await suggest(ctx, draft.id, { kind: "cite", sources: [{ kind: "note", targetId: n1 }, { kind: "note", targetId: n2 }] });
    await ctx.app.drafts.settled();
    expect((await detail(ctx, made.id)).stale).toBe(false);

    await rewriteNote(ctx, n1, "新的说法");
    const changed = await detail(ctx, made.id);
    expect(changed.stale).toBe(true);
    expect(changed.sources.map((item) => [item.label, item.state])).toEqual([["资料甲", "changed"], ["资料乙", "same"]]);
    expect(changed.sources[0]).toMatchObject({ before: "旧的说法", after: "新的说法" });
    // What it said is untouched; only its standing changed.
    expect(changed.generated).toBe("依据：旧");
    expect((await getDraft(ctx, draft.id)).suggestions.find((item) => item.id === made.id)!.stale).toBe(true);

    // Keeping takes the sources as they are now, and the warning goes.
    const kept = ok<{ suggestion: Suggestion }>(await run(ctx, "draft.keepSuggestion", { suggestionId: made.id })).suggestion;
    expect(kept.stale).toBe(false);
    expect((await detail(ctx, made.id)).sources[0]).toMatchObject({ state: "same", before: "新的说法" });

    // Another change, then redo: a new suggestion from what the sources say now, the same kind, instruction and sources.
    await rewriteNote(ctx, n2, "乙也变了");
    expect((await detail(ctx, made.id)).stale).toBe(true);
    const again = await suggest(ctx, draft.id, { kind: "polish", redoOf: made.id });
    await ctx.app.drafts.settled();
    const redone = await detail(ctx, again.id);
    expect(redone).toMatchObject({ kind: "cite", status: "pending", stale: false });
    expect(redone.quoted!.map((item) => item.text)).toEqual(["新的说法", "乙也变了"]);

    // A source that is gone is its own state; keeping drops it from the list.
    ok(await run(ctx, "notes.delete", { objectId: n2 }));
    const missing = await detail(ctx, redone.id);
    expect(missing.sources.map((item) => item.state)).toEqual(["same", "missing"]);
    expect(missing.stale).toBe(true);
    const trimmed = ok<{ suggestion: Suggestion }>(await run(ctx, "draft.keepSuggestion", { suggestionId: redone.id })).suggestion;
    expect(trimmed.sources.map((item) => item.label)).toEqual(["资料甲"]);
    expect(trimmed.stale).toBe(false);
  });

  it("reports a model that fails, answers nothing or is not there, and a suggestion that was cancelled while it was being written", async () => {
    const llm = controlledLlm();
    const ctx = await boot(llm.port);
    const { draft } = await setup(ctx, "稿");

    llm.state.reply = () => { throw Object.assign(new Error("service unavailable"), { code: "PROVIDER_UNAVAILABLE" }); };
    const bad = await suggest(ctx, draft.id, { kind: "continue" });
    await ctx.app.drafts.settled();
    expect(await detail(ctx, bad.id)).toMatchObject({ status: "failed", error: { code: "PROVIDER_UNAVAILABLE", message: "service unavailable" } });
    expect(failure(await run(ctx, "draft.adopt", { suggestionId: bad.id })).details).toMatchObject({ reason: "state" });

    llm.state.reply = () => "   ";
    const empty = await suggest(ctx, draft.id, { kind: "continue" });
    await ctx.app.drafts.settled();
    expect((await detail(ctx, empty.id)).error?.message).toContain("no text");

    // A suggestion waiting on the model can be cancelled, and nothing changes.
    llm.state.reply = (_user, signal) => new Promise<string>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted"))); });
    const slow = await suggest(ctx, draft.id, { kind: "continue" });
    expect(slow.status).toBe("running");
    expect(ok<{ drafts: Array<{ pending: number }> }>(await run(ctx, "draft.list", {})).drafts[0]!.pending).toBe(1);
    expect(failure(await run(ctx, "draft.discardSuggestion", { suggestionId: slow.id })).details).toMatchObject({ reason: "state" });
    ok(await run(ctx, "draft.cancelSuggestion", { suggestionId: slow.id }));
    await ctx.app.drafts.settled();
    expect((await detail(ctx, slow.id)).status).toBe("cancelled");
    expect(failure(await run(ctx, "draft.cancelSuggestion", { suggestionId: slow.id })).details).toMatchObject({ reason: "state" });
    expect((await getDraft(ctx, draft.id)).draft.text).toBe("稿");

    // Failed and cancelled ones can be put aside.
    expect(ok<{ suggestion: Suggestion }>(await run(ctx, "draft.discardSuggestion", { suggestionId: bad.id })).suggestion.status).toBe("discarded");

    // No text model, and a connection that is named but does not exist.
    const bare = await boot();
    const other = await setup(bare);
    expect(failure(await run(bare, "draft.suggest", { draftId: other.draft.id, kind: "continue" })).details).toMatchObject({ reason: "noTextModel" });
    expect(failure(await run(ctx, "draft.suggest", { draftId: draft.id, kind: "continue", connectionId: "conn-none" })).details).toMatchObject({ reason: "connection" });
  });

  it("uses the project's own text connection when it has one, and a named one over it", async () => {
    const llm = controlledLlm();
    const ctx = await boot(llm.port);
    const { projectId, draft } = await setup(ctx, "稿");
    const plain = await suggest(ctx, draft.id, { kind: "continue" });
    await ctx.app.drafts.settled();
    expect((await detail(ctx, plain.id)).connectionId).toBe("conn-a");
    // The project keeps the id of one of the person's connections; the double accepts its own ids.
    ctx.app.store.sqlite.prepare("UPDATE projects SET model_connection_id = ? WHERE id = ?").run("conn-b", projectId);
    const own = await suggest(ctx, draft.id, { kind: "continue" });
    await ctx.app.drafts.settled();
    expect((await detail(ctx, own.id)).connectionId).toBe("conn-b");
    const named = await suggest(ctx, draft.id, { kind: "continue", connectionId: "conn-a" });
    await ctx.app.drafts.settled();
    expect((await detail(ctx, named.id)).connectionId).toBe("conn-a");
  });

  it("limits how many suggestions are being written for one draft", async () => {
    const llm = controlledLlm();
    const ctx = await boot(llm.port);
    const { draft } = await setup(ctx, "稿");
    llm.state.reply = (_user, signal) => new Promise<string>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted"))); });
    for (let i = 0; i < 3; i += 1) await suggest(ctx, draft.id, { kind: "continue" });
    expect(failure(await run(ctx, "draft.suggest", { draftId: draft.id, kind: "continue" })).details).toMatchObject({ reason: "busy" });
    ctx.app.drafts.close();
    await ctx.app.drafts.settled();
  });

  it("marks a suggestion that was being written when the app stopped as failed, not running forever", async () => {
    const profileRoot = tempProfile();
    const first = await boot(undefined, profileRoot);
    const { draft } = await setup(first);
    first.app.store.sqlite.prepare("INSERT INTO draft_suggestions(id, draft_id, kind, instruction, status, base_version, base_text, result_text, sources_json, model_json, created_at, updated_at) VALUES ('dsg-x', ?, 'continue', '', 'running', 1, '', '', '[]', '{\"connectionId\":null}', 'a', 'a')").run(draft.id);
    first.app.close();
    apps.pop();
    const second = await boot(undefined, profileRoot);
    expect(await detail(second, "dsg-x")).toMatchObject({ status: "failed", error: { code: "INTERRUPTED" } });
  });
});

describe("what a suggestion becomes in the text", () => {
  it("composes each kind so the draft keeps what is around the part that was worked on", () => {
    expect(compose("outline", "", undefined, "提纲")).toBe("提纲");
    expect(compose("outline", "正文", undefined, "提纲")).toBe("提纲\n\n正文");
    expect(compose("continue", "甲  \n", undefined, "乙")).toBe("甲\n\n乙");
    expect(compose("continue", "甲丙", { start: 0, end: 1 }, "乙")).toBe("甲\n\n乙\n\n丙");
    expect(compose("cite", "", undefined, "乙")).toBe("乙");
    expect(compose("polish", "甲乙丙", { start: 1, end: 2 }, "X")).toBe("甲X丙");
    expect(compose("translate", "甲乙", undefined, "AB")).toBe("AB");
    // A range that no longer fits the text is clipped, never beyond it.
    expect(compose("polish", "甲乙", { start: 1, end: 9 }, "X")).toBe("甲X");
  });
});

describe("drafts belong to the owner and their project", () => {
  it("is not available to an agent, goes with its project, and is refused for a project that does not exist", async () => {
    const llm = controlledLlm();
    const ctx = await boot(llm.port);
    const { projectId, draft } = await setup(ctx);
    const grant = ctx.app.issueAgentGrant(ctx.grant, { kind: "agent", id: "agent-draft" }, { readResourceIds: [] });
    const denied = await ctx.app.call({ kind: "agent", id: "agent-draft" }, { commandId: "draft.list", idempotencyKey: "drf-agent", input: {} }, grant.handle);
    expect(denied.status).toBe("error");
    expect(failure(await run(ctx, "draft.create", { projectId: "prj-none", title: "x" })).code).toBe("NOT_FOUND");
    llm.state.reply = () => "写好了";
    await suggest(ctx, draft.id, { kind: "continue" });
    await ctx.app.drafts.settled();
    ok(await run(ctx, "project.delete", { projectId }));
    const sqlite = ctx.app.store.sqlite;
    expect([sqlite.prepare("SELECT COUNT(*) AS n FROM drafts").get(), sqlite.prepare("SELECT COUNT(*) AS n FROM draft_versions").get(), sqlite.prepare("SELECT COUNT(*) AS n FROM draft_suggestions").get()]).toEqual([{ n: 0 }, { n: 0 }, { n: 0 }]);
  });

  it("records the creative changes in the operation log without the text of the draft", async () => {
    const llm = controlledLlm();
    const ctx = await boot(llm.port);
    const { draft } = await setup(ctx, "私密的内容");
    const made = await suggest(ctx, draft.id, { kind: "continue" });
    await ctx.app.drafts.settled();
    ok(await run(ctx, "draft.adopt", { suggestionId: made.id }));
    const logged = ok<{ entries: Array<{ action: string; category: string; objectLabel: string | null }> }>(await run(ctx, "log.query", { category: "copy" })).entries;
    expect(logged.map((entry) => entry.action)).toEqual(expect.arrayContaining(["draft.adopt", "draft.suggest", "draft.create"]));
    expect(logged.every((entry) => entry.objectLabel === "稿子")).toBe(true);
    expect(JSON.stringify(logged)).not.toContain("私密的内容");
  });
});
