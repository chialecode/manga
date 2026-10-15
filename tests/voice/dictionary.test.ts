import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildPrompt, isPromptEcho } from "../../packages/app-core/src/voice/dictionary.ts";
import { readRecordingSettings, writeRecordingSettings } from "../../packages/app-core/src/voice/settings.ts";
import { startApp } from "../helpers/app.ts";
import { startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { seedComic } from "../helpers/media-seed.ts";
import { EnergyVad, FakeAsr, FakeLlm, feed, join, quiet, seedResource, tone, voiceHarness, type Harness } from "../helpers/voice.ts";

describe("the hint built from the dictionary", () => {
  it("joins terms in order, drops repeats and stops at the limit, saying how many were left out", () => {
    const built = buildPrompt(["魔王城", "勇者", "魔王城", "星之海"], 100);
    expect(built).toMatchObject({ text: "魔王城, 勇者, 星之海", included: ["魔王城", "勇者", "星之海"], total: 3, cut: 0 });
    const tight = buildPrompt(["魔王城", "勇者", "星之海"], 8);
    expect(tight).toMatchObject({ text: "魔王城, 勇者", included: ["魔王城", "勇者"], total: 3, cut: 1, limit: 8 });
    // The limit counts characters, not bytes: a term that would cross it is not clipped in the middle.
    expect(buildPrompt(["甲乙丙丁戊"], 4)).toMatchObject({ text: "", included: [], cut: 1 });
    expect(buildPrompt([], 600)).toMatchObject({ text: "", total: 0, cut: 0 });
  });
});

describe("telling a transcript from the hint it was given", () => {
  const hint = ["魔王城", "勇者", "星之海", "桐谷", "神乐坂"];
  it("takes terms that run in the hint's order, or one term over and over, or the hint itself, for an echo", () => {
    expect(isPromptEcho("魔王城, 勇者, 星之海", hint)).toBe(true);
    expect(isPromptEcho("魔王城 勇者 星之海 桐谷 神乐坂", hint)).toBe(true);
    expect(isPromptEcho("勇者勇者勇者勇者", hint)).toBe(true);
    expect(isPromptEcho("星之海，桐谷，神乐坂。", hint)).toBe(true);
  });

  it("leaves a real sentence that mentions a term or two alone", () => {
    expect(isPromptEcho("勇者走进了魔王城，然后看见了很多人", hint)).toBe(false);
    expect(isPromptEcho("魔王城", hint)).toBe(false);
    expect(isPromptEcho("魔王城和勇者", hint)).toBe(false);
    expect(isPromptEcho("", hint)).toBe(false);
    expect(isPromptEcho("魔王城, 勇者, 星之海", [])).toBe(false);
    // Out of the hint's order and only two terms: the audio may really say so.
    expect(isPromptEcho("星之海 魔王城", hint)).toBe(false);
  });
});

describe("what a block of audio is sent with", () => {
  const harnesses: Harness[] = [];
  afterEach(() => { while (harnesses.length) harnesses.pop()!.close(); });
  const make = () => { const h = voiceHarness(); harnesses.push(h); return h; };

  async function record(h: Harness, workId: string) {
    const r = seedResource(h.store, { workId });
    const { sessionId } = h.service.start({ mode: "toggle", resourceId: r.resourceId, resourceRevisionId: r.revisionId });
    feed(h.service, sessionId, join(quiet(500), tone(2000), quiet(500)));
    await h.service.stop({ sessionId });
    await h.settle(sessionId);
    return sessionId;
  }
  const work = (h: Harness) => seedResource(h.store).workId;

  it("puts the work's own terms first, then those taken from its data, then the global ones", async () => {
    const h = make();
    const workId = work(h);
    h.service.dictionary.add({ scope: "global", term: "全局甲" });
    h.service.dictionary.add({ scope: "work", workId, term: "手写甲" });
    const at = new Date().toISOString();
    h.store.sqlite.prepare("INSERT INTO dictionary_terms(id, scope, work_id, term, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run("auto-1", "work", workId, "自动甲", "metadata:bangumi:character:1", at, at);
    h.service.dictionary.add({ scope: "work", workId, term: "手写乙" });
    h.service.dictionary.add({ scope: "global", term: "全局乙" });
    await record(h, workId);
    expect(h.asr.calls[0]!.prompt).toBe("手写甲, 手写乙, 自动甲, 全局甲, 全局乙");
  });

  it("cuts the hint to the length set for the connection and says how much was left out", async () => {
    const h = make();
    const workId = work(h);
    const terms = ["一二三四五六七八九", "甲乙丙丁戊己庚辛壬", "子丑寅卯辰巳午未申", "春夏秋冬风花雪月天", "东南西北中发白红青", "金木水火土日月星辰"];
    for (const term of terms) h.service.dictionary.add({ scope: "work", workId, term });
    // At the default length everything fits.
    expect(h.service.dictionary.prompt(workId, readRecordingSettings(h.store).promptChars)).toMatchObject({ cut: 0, total: 6, limit: 600 });
    // A limit for this connection only wins over the general one: four terms (9 + 2 each, minus the last comma) fit in 50 and no more.
    writeRecordingSettings(h.store, { promptChars: 500, promptCharsByConnection: { "conn-asr": 50 } });
    await record(h, workId);
    expect(h.asr.calls[0]!.prompt).toBe(terms.slice(0, 4).join(", "));
    expect(h.service.dictionary.prompt(workId, 50)).toMatchObject({ included: terms.slice(0, 4), cut: 2, total: 6, limit: 50 });
    // Going back to the general limit.
    writeRecordingSettings(h.store, { promptCharsByConnection: { "conn-asr": null } });
    expect(readRecordingSettings(h.store)).toMatchObject({ promptChars: 500, promptCharsByConnection: {} });
    expect(() => writeRecordingSettings(h.store, { promptChars: 10 })).toThrow(/between/);
    expect(() => writeRecordingSettings(h.store, { promptCharsByConnection: { x: 5000 } })).toThrow(/between/);
  });

  it("sends the language set for recordings", async () => {
    const h = make();
    const workId = work(h);
    writeRecordingSettings(h.store, { language: "ja" });
    await record(h, workId);
    expect(h.asr.calls[0]!.language).toBe("ja");
  });

  it("marks a block that only repeats the hint as failed, writes nothing, and sends it again without the hint when retried", async () => {
    const h = make();
    const workId = work(h);
    for (const term of ["魔王城", "勇者", "星之海"]) h.service.dictionary.add({ scope: "work", workId, term });
    h.asr.text = () => "魔王城, 勇者, 星之海";
    const sessionId = await record(h, workId);
    // One call: an echo is not retried with the same hint.
    expect(h.asr.calls).toHaveLength(1);
    expect(h.asr.calls[0]!.prompt).toBe("魔王城, 勇者, 星之海");
    const failed = h.store.sqlite.prepare("SELECT state, text, error_json FROM transcript_segments WHERE session_id = ?").all(sessionId) as Array<{ state: string; text: string; error_json: string }>;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ state: "failed", text: "" });
    expect(JSON.parse(failed[0]!.error_json)).toMatchObject({ code: "PROVIDER_UNAVAILABLE", reason: "prompt-echo" });
    expect(h.service.view(h.service.row(sessionId)).segments).toMatchObject({ failed: 1, done: 0 });

    h.asr.text = () => "这是真的说话";
    void h.service.pipeline.retry(sessionId);
    await h.settle(sessionId);
    expect(h.asr.calls).toHaveLength(2);
    expect(h.asr.calls[1]!.prompt).toBeUndefined();
    const done = h.store.sqlite.prepare("SELECT state, text FROM transcript_segments WHERE session_id = ?").all(sessionId);
    expect(done).toEqual([{ state: "done", text: "这是真的说话" }]);
  });

  it("does not stop a recording whose blocks echo: the run goes on to the others", async () => {
    const h = make();
    const workId = work(h);
    for (const term of ["魔王城", "勇者", "星之海"]) h.service.dictionary.add({ scope: "work", workId, term });
    const r = seedResource(h.store, { workId });
    const { sessionId } = h.service.start({ mode: "toggle", resourceId: r.resourceId, resourceRevisionId: r.revisionId });
    feed(h.service, sessionId, join(quiet(500), tone(2000), quiet(3000), tone(2000), quiet(3000), tone(2000), quiet(500)));
    await h.service.stop({ sessionId });
    await h.settle(sessionId);
    const states = h.store.sqlite.prepare("SELECT state FROM transcript_segments WHERE session_id = ? ORDER BY start_ms").all(sessionId) as Array<{ state: string }>;
    // The default fake answers with ordinary text, so everything finishes; with echoes in the first two blocks the third is still sent.
    expect(states.every((item) => item.state === "done")).toBe(true);
    const total = h.asr.calls.length;
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it("gives the organizer the work's dictionary and the project's terms as the glossary", async () => {
    const h = make();
    const workId = work(h);
    h.service.dictionary.add({ scope: "work", workId, term: "魔王城" });
    h.service.dictionary.add({ scope: "global", term: "全局词" });
    const sessionId = await record(h, workId);
    await h.service.organizer.organize(sessionId, undefined, ["项目词", "魔王城"]);
    expect(h.llm.calls[0]!.user).toContain("术语表：魔王城、全局词、项目词");
  });
});

describe("the dictionary and the data of a linked work (AT-76)", () => {
  type App = Awaited<ReturnType<typeof startApp>>;
  type Call = Awaited<ReturnType<App["app"]["call"]>>;
  let fake: FakeBangumi;
  const apps: App[] = [];
  let counter = 0;
  beforeAll(async () => { fake = await startFakeBangumi(); });
  afterAll(async () => { await fake.stop(); });
  afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

  async function boot() {
    fake.reset();
    await fake.addImage("a.png", "red");
    fake.subject(101, { type: 1, platform: "漫画", name: "Synthetic Series", name_cn: "合成系列", imageName: "a.png", volumes: 3, eps: 0, total_episodes: 0, infobox: [{ key: "作者", value: "A. Writer" }, { key: "别名", value: [{ v: "合成别名" }, { v: "Synth Alias" }] }] });
    fake.character(101, 1, { relation: "主角" });
    fake.character(101, 2, { relation: "配角", actors: [] });
    fake.person(101, 11, { relation: "导演", career: ["mangaka"], eps: "ep1" });
    await fake.addAvatars();
    const ctx = await startApp({ options: { vad: new EnergyVad(), asr: new FakeAsr(), llm: new FakeLlm(), voiceRetryBaseMs: 0, bangumi: fake.clientOptions } });
    apps.push(ctx);
    return ctx;
  }
  async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
    counter += 1;
    return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `dic-${counter}`, input }, ctx.grant.handle);
  }
  function ok<T = Record<string, any>>(result: Call): T {
    expect(result.status, JSON.stringify(result)).toBe("ok");
    return result.value as T;
  }
  type Term = { id: string; scope: string; workId: string | null; term: string; heard: string | null; source: string; auto: boolean };
  const terms = async (ctx: App, workId: string) => ok<{ terms: Term[] }>(await run(ctx, "dictionary.list", { scope: "work", workId })).terms;

  it("adds names from the cached data without going to the network, marks where each came from, and lets hand-written terms win", async () => {
    const ctx = await boot();
    const target = seedComic(ctx.app, { title: "文件名里的漫画", pageCount: 2 });
    ctx.app.metadata.reproject(target.workId);
    // Not linked yet: nothing to take names from.
    const unlinked = await run(ctx, "dictionary.importMetadata", { workId: target.workId });
    expect(unlinked.status).toBe("error");
    expect(unlinked.error?.details).toMatchObject({ reason: "not-linked" });
    ok(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
    // A hand-written term comes first, and is the one that stays when the data has the same name.
    ok(await run(ctx, "dictionary.add", { scope: "work", workId: target.workId, term: "Synthetic Character 1", heard: "合成角色" }));

    const requestsBefore = fake.requests.length;
    const imported = ok<{ linked: boolean; added: number; manualWins: number }>(await run(ctx, "dictionary.importMetadata", { workId: target.workId }));
    expect(fake.requests.length).toBe(requestsBefore);
    expect(imported).toMatchObject({ linked: true, manualWins: 1 });
    const shown = await terms(ctx, target.workId);
    const byTerm = new Map(shown.map((item) => [item.term, item]));
    expect(byTerm.get("Synthetic Character 1")).toMatchObject({ auto: false, source: "manual", heard: "合成角色" });
    expect(byTerm.get("Synthetic Character 2")).toMatchObject({ auto: true, source: "metadata:bangumi:character:2" });
    expect(byTerm.get("Synthetic Actor 1")).toMatchObject({ auto: true, source: expect.stringMatching(/^metadata:bangumi:actor:/) });
    expect(byTerm.get("合成系列")).toMatchObject({ auto: true, source: "metadata:bangumi:work:101" });
    expect(byTerm.get("合成别名")).toMatchObject({ auto: true });
    expect(byTerm.get("Synth Alias")).toMatchObject({ auto: true });
    // Staff are not voices in the recording; only the cast and the work's names are taken.
    expect([...byTerm.keys()].some((name) => /Person/.test(name))).toBe(false);
    // Importing again changes nothing.
    expect(ok<{ added: number; removed: number }>(await run(ctx, "dictionary.importMetadata", { workId: target.workId }))).toMatchObject({ added: 0, removed: 0 });
    expect((await terms(ctx, target.workId)).length).toBe(shown.length);
  });

  it("follows a refresh by adding and removing automatic terms only, and drops them when the work is unlinked", async () => {
    const ctx = await boot();
    const target = seedComic(ctx.app, { title: "刷新的漫画", pageCount: 2 });
    ctx.app.metadata.reproject(target.workId);
    ok(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
    ok(await run(ctx, "dictionary.importMetadata", { workId: target.workId }));
    ok(await run(ctx, "dictionary.add", { scope: "work", workId: target.workId, term: "我自己的词" }));
    const before = await terms(ctx, target.workId);
    expect(before.some((item) => item.term === "Synthetic Character 2")).toBe(true);

    // The entry changes: character 2 is gone, a new one arrives.
    fake.characters.set(101, [fake.characters.get(101)![0]!, { ...fake.characters.get(101)![0]!, id: 9, name: "New Character 9", actors: [] }]);
    ok(await run(ctx, "metadata.refresh", { workId: target.workId }));
    const after = await terms(ctx, target.workId);
    expect(after.some((item) => item.term === "Synthetic Character 2")).toBe(false);
    expect(after.find((item) => item.term === "New Character 9")).toMatchObject({ auto: true, source: "metadata:bangumi:character:9" });
    expect(after.find((item) => item.term === "我自己的词")).toMatchObject({ auto: false });

    // A term the user edited is theirs from then on: the next refresh does not remove it.
    const keep = after.find((item) => item.term === "New Character 9")!;
    ok(await run(ctx, "dictionary.update", { termId: keep.id, heard: "新角色" }));
    fake.characters.set(101, [fake.characters.get(101)![0]!]);
    ok(await run(ctx, "metadata.refresh", { workId: target.workId }));
    expect((await terms(ctx, target.workId)).find((item) => item.term === "New Character 9")).toMatchObject({ auto: false, heard: "新角色" });

    ok(await run(ctx, "metadata.unlink", { workId: target.workId, providerId: "bangumi" }));
    const unlinked = await terms(ctx, target.workId);
    expect(unlinked.every((item) => !item.auto)).toBe(true);
    expect(unlinked.map((item) => item.term).sort()).toEqual(["New Character 9", "我自己的词"].sort());
  });

  it("keeps a work's dictionary when its last resource moves away, keeps the global terms, and carries the dictionary through the older term commands", async () => {
    const ctx = await boot();
    const target = seedComic(ctx.app, { title: "要删的漫画", pageCount: 1 });
    ok(await run(ctx, "dictionary.add", { scope: "work", workId: target.workId, term: "作品词" }));
    ok(await run(ctx, "dictionary.add", { scope: "global", term: "全局词" }));
    // The older commands see the work's terms and add hand-written ones to the same dictionary.
    ok(await run(ctx, "capture.addTerm", { workId: target.workId, term: "旧命令词", heard: "旧命令" }));
    expect(ok<{ terms: Array<{ term: string; heard: string | null }> }>(await run(ctx, "capture.terms", { workId: target.workId })).terms).toEqual([{ term: "作品词", heard: null }, { term: "旧命令词", heard: "旧命令" }]);
    expect(ok<{ removed: boolean }>(await run(ctx, "capture.removeTerm", { workId: target.workId, term: "旧命令词" })).removed).toBe(true);
    expect((await run(ctx, "dictionary.add", { scope: "global", workId: target.workId, term: "错" })).status).toBe("error");
    expect((await run(ctx, "dictionary.add", { scope: "work", term: "没有作品" })).status).toBe("error");
    ok(await run(ctx, "dictionary.remove", { termId: (await terms(ctx, target.workId))[0]!.id }));
    ok(await run(ctx, "dictionary.add", { scope: "work", workId: target.workId, term: "留给删除" }));
    expect((await terms(ctx, target.workId)).length).toBe(1);
    // A work whose last resource is moved to another work stays as a work with no resource: the dictionary is something the user wrote (A-67).
    const keeper = seedComic(ctx.app, { title: "留下的漫画", pageCount: 1 });
    ok(await run(ctx, "works.moveResource", { resourceId: target.resourceId, toWorkId: keeper.workId }));
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM works WHERE id = ?").get(target.workId)).toEqual({ n: 1 });
    const listed = ok<{ terms: Term[]; promptChars: number }>(await run(ctx, "dictionary.list", {}));
    expect(listed.terms.filter((item) => item.scope === "work").map((item) => item.term)).toEqual(["留给删除"]);
    expect(listed.terms.map((item) => item.term).sort()).toEqual(["全局词", "留给删除"].sort());
  });
});
