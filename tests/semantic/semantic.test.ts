import { afterEach, describe, expect, it } from "vitest";
import { MangaError, NORMALIZATION_V1 } from "@manga/contracts";
import { BOOK, THEMES, controlled } from "../helpers/embedder.ts";
import { startApp, tempProfile } from "../helpers/app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
type Hit = {
  kind: string; score: number; text: string; title: string; resourceId?: string; workId?: string; revisionId?: string;
  locator?: { kind: "text"; partId: string; representationId: string; range: { start: number; end: number } };
  objectId?: string; blockId?: string; sessionId?: string; startMs?: number; excerptId?: string;
};
type Search = { state: string; results: Hit[]; version: { id: number; model: string; segmentation: string; dim: number | null } | null };
type Status = {
  enabled: boolean; connectionId: string | null; segmentation: string; stale: boolean; pending: number; engine: string;
  connections: Array<{ id: string; label: string; model: string }>;
  active: { id: number; model: string; dim: number | null; segmentation: string; engine: string; chunks: number } | null;
  building: { id: number; model: string; done: number; total: number; status: string; kind: string } | null;
  failed: { id: number; model: string; error: { code: string; message: string } } | null;
  estimate: { chars: number; chunks: number };
};

let counter = 0;
const apps: App[] = [];
afterEach(() => { while (apps.length) { try { apps.pop()!.app.close(); } catch { /* already closed */ } } });

let step = 0;
async function boot(options: { vec: boolean; profileRoot?: string; port?: ReturnType<typeof controlled> }) {
  const model = options.port ?? controlled();
  const ctx = await startApp({ profileRoot: options.profileRoot, options: { embedding: model.port, semantic: { vec: options.vec, retryBaseMs: 0 } } });
  apps.push(ctx);
  const run = async (commandId: string, input: Record<string, unknown> = {}): Promise<Call> => {
    step += 1;
    return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `sem-${counter += 1}-${step}`, input }, ctx.grant.handle);
  };
  const ok = async <T = Record<string, any>>(commandId: string, input: Record<string, unknown> = {}): Promise<T> => {
    const result = await run(commandId, input);
    expect(result.status, `${commandId}: ${JSON.stringify(result)}`).toBe("ok");
    return result.value as T;
  };
  const fail = async (commandId: string, input: Record<string, unknown> = {}) => {
    const result = await run(commandId, input);
    expect(result.status).toBe("error");
    return result.error as { code: string; details?: Record<string, unknown> };
  };
  return {
    ctx, model, run, ok, fail,
    status: () => ok<Status>("semantic.status"),
    ask: (text: string, extra: Record<string, unknown> = {}) => ok<Search>("semantic.search", { text, ...extra }),
    settled: () => ctx.app.semantic.settled(),
    versions: () => ctx.app.store.sqlite.prepare("SELECT id, model, dim, segmentation, status, engine FROM index_versions ORDER BY id").all() as Array<{ id: number; model: string; dim: number | null; segmentation: string; status: string; engine: string }>,
    chunkVersions: () => (ctx.app.store.sqlite.prepare("SELECT DISTINCT version_id AS id FROM semantic_chunks ORDER BY version_id").all() as Array<{ id: number }>).map((row) => row.id),
    vecTables: () => (ctx.app.store.sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'semantic_vec_%'").all() as Array<{ name: string }>).map((row) => row.name).filter((name) => /^semantic_vec_\d+$/.test(name)),
  };
}
type Booted = Awaited<ReturnType<typeof boot>>;

async function seed(h: Booted) {
  const book = await h.ok<{ resourceId: string; revisionId: string; workId: string }>("library.importText", { title: "雨夜行人", bytes: [...Buffer.from(BOOK)] });
  const note = await h.ok<{ objectId: string }>("notes.create", { title: "灯下记", text: "今天在咖啡馆里读完了整本诗集，窗外的梧桐叶落了一地，店员安静地擦着杯子。" });
  const sql = h.ctx.app.store.sqlite;
  sql.prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, updated_at, stage, work_id) VALUES (?,?,?,?,?,?,?)").run("cap-1", "{}", "done", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z", "done", book.workId);
  sql.prepare("INSERT INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, revised_text, state, precision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("seg-1", "cap-1", 1, "c1", 61_000, 66_000, "语音里提到了海边的灯塔和夜航的渔船", null, "done", "segment", "2026-10-01T10:00:01.000Z", "2026-10-01T10:00:01.000Z");
  sql.prepare("INSERT INTO excerpt_pages(id, url, title, fetched_at, content_hash, body_text, version, previous_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("pg-1", "https://pages.example.org/a", "网页", "2026-10-01T10:00:00.000Z", "h", "沙漠里的驼队在黄昏时分才开始赶路，星空低得像要落下来。", 1, null, "2026-10-01T10:00:00.000Z");
  const excerpt = await h.ok<{ excerpt: { id: string } }>("excerpt.create", { pageId: "pg-1", start: 0, end: 26, title: "驼队" });
  return { book, noteId: note.objectId, excerptId: excerpt.excerpt.id };
}

/** The hit's text is the piece with its white space collapsed and cut at the snippet length; the locator names the whole piece. */
const sameText = (piece: string, hit: Hit) => {
  const collapsed = piece.replace(/\s+/g, " ");
  return hit.text.endsWith("…") ? collapsed.startsWith(hit.text.slice(0, -1)) : collapsed === hit.text;
};
const sliceOf = async (h: Booted, hit: Hit) => (await h.ok<{ text: string }>("library.readSlice", { resourceId: hit.resourceId!, partId: hit.locator!.partId, start: hit.locator!.range.start, limit: hit.locator!.range.end - hit.locator!.range.start })).text;

describe.each([{ name: "vec0 extension", vec: true }, { name: "JavaScript fallback", vec: false }])("the semantic index, $name (SEARCH-02, AT-31)", ({ vec }) => {
  it("is off until it is turned on, and turning it on needs an embedding connection", async () => {
    const h = await boot({ vec });
    expect(await h.status()).toMatchObject({ enabled: false, active: null, building: null, failed: null, stale: false, engine: vec ? "vec0" : "blob", connections: [{ id: "emb-a", model: "model-a" }, { id: "emb-b", model: "model-b" }] });
    expect(await h.ask("手风琴")).toMatchObject({ state: "off", results: [], version: null });
    expect(h.model.state.calls).toEqual([]);
    h.model.state.connections = [];
    expect(await h.fail("semantic.configure", { enabled: true })).toMatchObject({ code: "MODEL_CAPABILITY_MISSING", details: { reason: "noConnection" } });
    expect((await h.status()).enabled).toBe(false);
  });

  it("builds in the background when turned on, then answers with passages that say what and where they are", async () => {
    const h = await boot({ vec });
    const { book, noteId, excerptId } = await seed(h);
    const started = await h.ok<Status>("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    expect(started.enabled).toBe(true);
    await h.settled();
    const status = await h.status();
    expect(status).toMatchObject({ enabled: true, connectionId: "emb-a", building: null, failed: null, stale: false, pending: 0, active: { model: "model-a", dim: 48, segmentation: "paragraph-300", engine: vec ? "vec0" : "blob" } });
    expect(status.active!.chunks).toBeGreaterThanOrEqual(5);
    expect(h.versions()).toEqual([expect.objectContaining({ status: "active", dim: 48 })]);

    const found = await h.ask("手风琴的声音在雨夜的桥上");
    expect(found.state).toBe("ok");
    expect(found.version).toMatchObject({ model: "model-a", dim: 48 });
    const top = found.results[0]!;
    expect(top).toMatchObject({ kind: "body", resourceId: book.resourceId, workId: book.workId, title: "雨夜行人" });
    expect(top.text).toContain("手风琴");
    expect(top.locator).toMatchObject({ kind: "text", partId: "body", representationId: book.revisionId });
    // The place named by the locator is the text of the hit, in the book as it is stored.
    expect(sameText(await sliceOf(h, top), top)).toBe(true);
    for (let i = 1; i < found.results.length; i += 1) expect(found.results[i]!.score).toBeLessThanOrEqual(found.results[i - 1]!.score);
    expect(top.score).toBeGreaterThan(0.5);
    expect(top.score).toBeLessThanOrEqual(1.0001);

    expect((await h.ask("钢琴比赛的决赛评委聆听肖邦")).results[0]).toMatchObject({ kind: "body" });
    expect((await h.ask("钢琴比赛的决赛评委聆听肖邦")).results[0]!.text).toContain("肖邦夜曲");
    // The book is stored in fragments, so the best piece can be either end of the passage; it is from this one and from no other.
    expect(THEMES.station).toContain((await h.ask("火车站的大钟旅客站台")).results[0]!.text.replace(/…$/, ""));
    expect((await h.ask("咖啡馆读完诗集梧桐叶")).results[0]).toMatchObject({ kind: "note", objectId: noteId, title: "灯下记" });
    expect((await h.ask("海边的灯塔和夜航的渔船")).results[0]).toMatchObject({ kind: "recording", sessionId: "cap-1", startMs: 61_000 });
    expect((await h.ask("沙漠驼队黄昏赶路星空")).results[0]).toMatchObject({ kind: "excerpt", excerptId });
    expect((await h.ask("手风琴", { kinds: ["note"] })).results.every((hit) => hit.kind === "note")).toBe(true);
    expect((await h.ask("手风琴", { limit: 2 })).results.length).toBeLessThanOrEqual(2);
  });

  it("builds a new version when the model or the vector length changes, while the version in use keeps answering and nothing is mixed", async () => {
    const h = await boot({ vec });
    const { book } = await seed(h);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await h.settled();
    const first = (await h.status()).active!;
    expect(h.vecTables()).toEqual(vec ? [`semantic_vec_${first.id}`] : []);

    const release = h.model.hold("emb-b");
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-b", segmentation: "paragraph-300" });
    await waitFor(() => h.model.state.calls.some((call) => call.model === "model-b"));
    const during = await h.status();
    expect(during.active).toMatchObject({ id: first.id, model: "model-a", dim: 48 });
    expect(during.building).toMatchObject({ model: "model-b", status: "building", kind: "build" });
    expect(h.versions().map((row) => [row.model, row.status])).toEqual([["model-a", "active"], ["model-b", "building"]]);

    // A search now is answered from the version in use, and its question is turned into a vector by that version's model only.
    const asked = "手风琴的声音在雨夜的桥上";
    const before = h.model.state.calls.length;
    const result = await h.ask(asked);
    expect(result).toMatchObject({ state: "ok", version: { model: "model-a", dim: 48 } });
    expect(result.results[0]).toMatchObject({ kind: "body", resourceId: book.resourceId });
    const newCalls = h.model.state.calls.slice(before);
    expect(newCalls).toEqual([{ connectionId: "emb-a", model: "model-a", inputs: [asked] }]);
    // Full-text search is unaffected.
    expect((await h.ok<{ results: Array<{ kind: string }> }>("research.search", { text: "手风琴", scopes: ["work"] })).results[0]).toMatchObject({ kind: "work" });
    expect(h.chunkVersions()).toEqual([first.id]);

    release();
    await h.settled();
    const after = await h.status();
    expect(after).toMatchObject({ building: null, failed: null, stale: false, active: { model: "model-b", dim: 32 } });
    expect(after.active!.id).not.toBe(first.id);
    expect(h.versions()).toEqual([expect.objectContaining({ model: "model-b", status: "active", dim: 32 })]);
    expect(h.chunkVersions()).toEqual([after.active!.id]);
    expect(h.vecTables()).toEqual(vec ? [`semantic_vec_${after.active!.id}`] : []);
    const now = await h.ask(asked);
    expect(now).toMatchObject({ state: "ok", version: { model: "model-b", dim: 32 } });
    expect(now.results[0]).toMatchObject({ kind: "body", resourceId: book.resourceId });
    expect(h.model.state.calls.at(-1)).toEqual({ connectionId: "emb-b", model: "model-b", inputs: [asked] });
    // The hit still names a place that exists in the book.
    expect(sameText(await sliceOf(h, now.results[0]!), now.results[0]!)).toBe(true);
  });

  it("builds a new version when the way of cutting changes, with fewer and larger pieces, and the hits keep valid places", async () => {
    const h = await boot({ vec });
    await seed(h);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await h.settled();
    const small = (await h.status()).active!;
    await h.ok("semantic.configure", { enabled: true, segmentation: "paragraph-1200" });
    await h.settled();
    const large = (await h.status()).active!;
    expect(large).toMatchObject({ segmentation: "paragraph-1200", model: "model-a" });
    expect(large.id).not.toBe(small.id);
    expect(large.chunks).toBeLessThan(small.chunks);
    expect(h.versions()).toHaveLength(1);
    const hit = (await h.ask("手风琴的声音在雨夜的桥上", { kinds: ["body"] })).results[0]!;
    expect(hit.kind).toBe("body");
    expect(hit.text.length).toBeGreaterThan(0);
    expect(sameText(await sliceOf(h, hit), hit)).toBe(true);
    // Asking for the setting it already has builds nothing.
    await h.ok("semantic.configure", { enabled: true, segmentation: "paragraph-1200" });
    expect(h.versions()).toHaveLength(1);
    expect(h.versions()[0]!.id).toBe(large.id);
  });

  it("keeps the version in use when a new one fails, says why, and builds again when asked", async () => {
    const h = await boot({ vec });
    await seed(h);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await h.settled();
    const first = (await h.status()).active!;
    h.model.state.failWith = (_n, connectionId) => (connectionId === "emb-b" ? new MangaError("AUTHENTICATION_FAILED", "refused") : null);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-b" });
    await h.settled();
    const failed = await h.status();
    expect(failed.active).toMatchObject({ id: first.id, model: "model-a" });
    expect(failed.building).toBeNull();
    expect(failed.failed).toMatchObject({ model: "model-b", error: { code: "AUTHENTICATION_FAILED" } });
    expect((await h.ask("手风琴的声音在雨夜的桥上")).results[0]).toMatchObject({ kind: "body" });
    h.model.state.failWith = null;
    await h.ok("semantic.rebuild");
    await h.settled();
    const rebuilt = await h.status();
    expect(rebuilt).toMatchObject({ failed: null, building: null, active: { model: "model-b", dim: 32 } });
  });

  it("tries a transient failure again, and gives up on a vector set that cannot be used", async () => {
    const h = await boot({ vec });
    await seed(h);
    h.model.state.failWith = (n) => (n < 2 ? new MangaError("PROVIDER_UNAVAILABLE", "busy", { retryable: true }) : null);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await h.settled();
    expect(await h.status()).toMatchObject({ failed: null, active: { model: "model-a" } });
    expect(h.model.state.failures).toBe(2);

    for (const [wrong, code] of [["count", "PROVIDER_UNAVAILABLE"], ["nan", "MODEL_CAPABILITY_MISSING"]] as const) {
      h.model.state.failWith = null;
      h.model.state.wrong = wrong;
      await h.ok("semantic.configure", { enabled: true, connectionId: "emb-b", segmentation: wrong === "count" ? "paragraph-600" : "paragraph-1200" });
      await h.settled();
      expect((await h.status()).failed).toMatchObject({ error: { code } });
      expect((await h.status()).active).toMatchObject({ model: "model-a" });
    }
  });

  it("can be cancelled while it builds, and the version in use stays", async () => {
    const h = await boot({ vec });
    await seed(h);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await h.settled();
    const first = (await h.status()).active!;
    h.model.hold("emb-b");
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-b" });
    await waitFor(() => h.model.state.calls.some((call) => call.model === "model-b"));
    expect((await h.status()).building).not.toBeNull();
    const cancelled = await h.ok<Status>("semantic.cancel");
    expect(cancelled.building).toBeNull();
    expect(cancelled.active).toMatchObject({ id: first.id });
    expect(h.versions()).toHaveLength(1);
    expect(h.chunkVersions()).toEqual([first.id]);
  });

  it("picks an interrupted build up again at the next start, and only does what is missing", async () => {
    const profileRoot = tempProfile();
    const model = controlled();
    const h = await boot({ vec, profileRoot, port: model });
    // Forty notes make more than one batch: the first goes through, the second is held, and the application closes.
    for (let i = 0; i < 40; i += 1) await h.ok("notes.create", { title: `记${i}`, text: `第${i}天的记录：今天天气${i % 2 ? "晴" : "阴"}，去了第${i}号站台，看见了第${i * 7}只鸽子。` });
    const release = model.hold("emb-a", 1);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-600" });
    await waitFor(() => model.state.calls.length >= 2);
    h.ctx.app.close();
    apps.pop();
    release();
    const firstInputs = model.state.calls[0]!.inputs.length;
    expect(firstInputs).toBe(32);

    const callsBefore = model.state.calls.length;
    model.state.gate.clear();
    const again = await boot({ vec, profileRoot, port: model });
    await again.settled();
    const done = await again.status();
    expect(done).toMatchObject({ building: null, failed: null, active: { model: "model-a", chunks: 40 } });
    // The passages already indexed were not asked for again.
    const asked = model.state.calls.slice(callsBefore).reduce((sum, call) => sum + call.inputs.length, 0);
    expect(asked).toBe(8);
    expect(again.versions()).toHaveLength(1);
  });

  it("adds what was written after the index was made, and leaves out what changed or went until it is updated", async () => {
    const h = await boot({ vec });
    const { noteId, excerptId } = await seed(h);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await h.settled();
    expect((await h.status()).pending).toBe(0);

    const fresh = await h.ok<{ objectId: string }>("notes.create", { title: "新记", text: "新写的一条：潜水员在沉船旁边看见了发光的水母群。" });
    expect(await h.status()).toMatchObject({ pending: 1 });
    expect((await h.ask("潜水员沉船水母")).results.some((hit) => hit.objectId === fresh.objectId)).toBe(false);
    await h.ok("semantic.update");
    await h.settled();
    expect((await h.status()).pending).toBe(0);
    expect((await h.ask("潜水员沉船水母")).results[0]).toMatchObject({ kind: "note", objectId: fresh.objectId });

    // An excerpt whose words changed is not answered from its old vector.
    await h.ok("excerpt.update", { excerptId, title: "驼队", note: "关于星空与迁徙的随想" });
    expect((await h.ask("沙漠驼队黄昏赶路星空")).results.some((hit) => hit.excerptId === excerptId)).toBe(false);
    await h.ok("semantic.update");
    await h.settled();
    expect((await h.ask("星空与迁徙的随想")).results[0]).toMatchObject({ kind: "excerpt", excerptId });
    // A note that was deleted is not answered either.
    await h.ok("notes.delete", { objectId: noteId });
    expect((await h.ask("咖啡馆读完诗集梧桐叶")).results.some((hit) => hit.objectId === noteId)).toBe(false);
  });

  it("refuses to compare vectors across models: a changed model or a removed connection stops semantic search until the index is rebuilt", async () => {
    const h = await boot({ vec });
    await seed(h);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await h.settled();
    h.model.state.connections[0]!.model = "model-a2";
    const before = h.model.state.calls.length;
    expect(await h.status()).toMatchObject({ stale: true, active: { model: "model-a" } });
    expect(await h.ask("手风琴")).toMatchObject({ state: "needsRebuild", results: [] });
    expect(h.model.state.calls.length).toBe(before);
    await h.ok("semantic.rebuild");
    await h.settled();
    expect(await h.status()).toMatchObject({ stale: false, active: { model: "model-a2" } });
    expect((await h.ask("手风琴的声音在雨夜的桥上")).state).toBe("ok");
    h.model.state.connections = [];
    expect(await h.ask("手风琴")).toMatchObject({ state: "unavailable", results: [] });
    expect((await h.status()).stale).toBe(true);
  });

  it("limits what is found to a project, a book, and what has been read", async () => {
    const h = await boot({ vec });
    const { book, noteId, excerptId } = await seed(h);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await h.settled();
    const project = await h.ok<{ id: string }>("project.create", { name: "雨夜" });
    const all = await h.ask("灯塔 渔船 驼队 咖啡馆 手风琴", { limit: 20 });
    expect(new Set(all.results.map((hit) => hit.kind))).toEqual(new Set(["body", "note", "recording", "excerpt"]));
    expect((await h.ask("灯塔 渔船 驼队 咖啡馆 手风琴", { projectId: project.id, limit: 20 })).results).toEqual([]);

    await h.ok("project.addMaterial", { projectId: project.id, kind: "work", targetId: book.workId });
    await h.ok("project.addMaterial", { projectId: project.id, kind: "note", targetId: noteId });
    const inProject = await h.ask("灯塔 渔船 驼队 咖啡馆 手风琴", { projectId: project.id, limit: 20 });
    expect(new Set(inProject.results.map((hit) => hit.kind))).toEqual(new Set(["body", "note"]));
    await h.ok("project.addMaterial", { projectId: project.id, kind: "recording", targetId: "cap-1" });
    await h.ok("project.addMaterial", { projectId: project.id, kind: "excerpt", targetId: excerptId });
    expect(new Set((await h.ask("灯塔 渔船 驼队 咖啡馆 手风琴", { projectId: project.id, limit: 20 })).results.map((hit) => hit.kind))).toEqual(new Set(["body", "note", "recording", "excerpt"]));

    const one = await h.ask("灯塔 渔船 驼队 咖啡馆 手风琴", { resourceId: book.resourceId, limit: 20 });
    expect(one.results.length).toBeGreaterThan(0);
    expect(one.results.every((hit) => hit.kind === "body" && hit.resourceId === book.resourceId)).toBe(true);

    // Only what has been read: nothing at first, then the part that was marked.
    expect((await h.ask("手风琴的声音在雨夜的桥上", { withinProgress: true, kinds: ["body"] })).results).toEqual([]);
    const top = (await h.ask("手风琴的声音在雨夜的桥上", { kinds: ["body"] })).results[0]!;
    await h.ok("progress.set", { contextId: null, resourceId: book.resourceId, resourceRevisionId: book.revisionId, consumed: true, locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: NORMALIZATION_V1, range: top.locator!.range, quote: { exact: top.text } } });
    const read = await h.ask("手风琴的声音在雨夜的桥上", { withinProgress: true, kinds: ["body"], limit: 20 });
    expect(read.results).toHaveLength(1);
    expect(read.results[0]!.locator!.range).toEqual(top.locator!.range);
  });

  it("can be turned off without losing the index, and cleared without touching what it was made from", async () => {
    const h = await boot({ vec });
    const { book } = await seed(h);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await h.settled();
    const first = (await h.status()).active!;
    await h.ok("semantic.configure", { enabled: false });
    expect(await h.status()).toMatchObject({ enabled: false, active: { id: first.id } });
    expect(await h.ask("手风琴")).toMatchObject({ state: "off", results: [] });
    const asked = h.model.state.calls.length;
    await h.ok("semantic.configure", { enabled: true });
    await h.settled();
    expect((await h.status()).active!.id).toBe(first.id);
    expect(h.versions()).toHaveLength(1);
    expect(h.model.state.calls.length).toBe(asked);
    expect((await h.ask("手风琴的声音在雨夜的桥上")).state).toBe("ok");

    const cleared = await h.ok<Status>("semantic.clear");
    expect(cleared).toMatchObject({ active: null, building: null, failed: null });
    expect(h.versions()).toEqual([]);
    expect(h.chunkVersions()).toEqual([]);
    expect(h.vecTables()).toEqual([]);
    expect(await h.ask("手风琴")).toMatchObject({ state: "off" });
    // The book is untouched.
    const reread = await h.ok<{ text: string }>("library.readSlice", { resourceId: book.resourceId, partId: "body", start: 0, limit: 8 });
    expect(reread.text).toBe(BOOK.slice(0, 8));
  });

  it("is switched off with its module, and what it does is written in the log without any text", async () => {
    const h = await boot({ vec });
    await seed(h);
    await h.ok("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await h.settled();
    const entries = (await h.ok<{ entries: Array<{ action: string; category: string; summaryKey: string }> }>("log.query", { category: "semantic" })).entries;
    expect(entries).toEqual([expect.objectContaining({ action: "semantic.configure", category: "semantic", summaryKey: "log.semantic.configure" })]);
    await h.ok("settings.setModule", { featureId: "semantic", enabled: false });
    for (const commandId of ["semantic.status", "semantic.search", "semantic.configure"]) {
      expect((await h.run(commandId, commandId === "semantic.search" ? { text: "手风琴" } : commandId === "semantic.configure" ? { enabled: true } : {})).error?.code, commandId).toBe("CAPABILITY_UNAVAILABLE");
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
