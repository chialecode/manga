import { afterEach, describe, expect, it } from "vitest";
import { readShell } from "@manga/app-core";
import { EMPTY_WORKSPACE_STATE, WORKSPACE_STATE_BYTES, type WorkspaceState } from "@manga/contracts/workspace-state";
import { startApp } from "../helpers/app.ts";

/** The saved tabs and layout of each context, and the list of contexts the sidebar shows (A-94, UI-07). */
type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `ws-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const tab = (id: string, kind = "library", extra: Record<string, unknown> = {}) => ({ id, kind, target: { section: "works" }, title: id, view: {}, ...extra });
const state = (patch: Partial<WorkspaceState> = {}): WorkspaceState => ({ ...EMPTY_WORKSPACE_STATE, ...patch });
const load = async (ctx: App, contextId: string | null) => ok<{ contextId: string | null; state: WorkspaceState; updatedAt: string | null; damaged: boolean }>(await run(ctx, "workspace.loadContext", { contextId }));
const project = async (ctx: App, name: string) => ok<{ id: string }>(await run(ctx, "project.create", { name })).id;

describe("loading and saving the tabs of a context", () => {
  it("answers a context that was never saved with the empty state, and gives back exactly what was saved", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const never = await load(ctx, a);
    expect(never).toMatchObject({ contextId: a, state: EMPTY_WORKSPACE_STATE, updatedAt: null, damaged: false });

    const saved = state({
      preset: "three", focusedTab: "t2", layout: { grid: { root: { type: "branch" } } },
      tabs: [tab("t1"), tab("t2", "hologram", { target: { shape: "cube" }, future: { a: 1 } })],
      closed: [tab("t0", "note")],
    });
    const result = ok<{ contextId: string | null; trimmed: boolean; bytes: number; updatedAt: string }>(await run(ctx, "workspace.saveContext", { contextId: a, state: saved }));
    expect(result).toMatchObject({ contextId: a, trimmed: false });
    expect(result.bytes).toBeGreaterThan(0);
    const back = await load(ctx, a);
    expect(back.state).toEqual(saved);
    expect(back.updatedAt).toBe(result.updatedAt);
    // A tab of a kind this version cannot open, and the fields it does not know, come back as they went.
    expect(back.state.tabs[1]).toMatchObject({ kind: "hologram", future: { a: 1 } });
  });

  it("keeps a context apart from the others: 最近 and each project have their own tabs, and saving one leaves the others as they were", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const b = await project(ctx, "项目乙");
    ok(await run(ctx, "workspace.saveContext", { contextId: null, state: state({ tabs: [tab("recent-1")], focusedTab: "recent-1" }) }));
    ok(await run(ctx, "workspace.saveContext", { contextId: a, state: state({ tabs: [tab("a-1"), tab("a-2")], focusedTab: "a-2" }) }));
    const bBefore = await load(ctx, b);
    const recentBefore = await load(ctx, null);
    ok(await run(ctx, "workspace.saveContext", { contextId: a, state: state({ tabs: [tab("a-3")], focusedTab: "a-3" }) }));
    expect((await load(ctx, a)).state.tabs.map((item) => item.id)).toEqual(["a-3"]);
    expect(await load(ctx, null)).toEqual(recentBefore);
    expect(await load(ctx, b)).toEqual(bBefore);
    expect(ctx.app.store.sqlite.prepare("SELECT context_id FROM workspace_contexts ORDER BY context_id").all()).toEqual([{ context_id: "" }, { context_id: a }]);
  });

  it("cuts a state that is too large instead of refusing it, and says so", async () => {
    const ctx = await boot();
    const heavy = (id: string) => tab(id, "reader", { view: { blob: "x".repeat(60_000) } });
    const big = state({ tabs: [heavy("focus"), heavy("b"), heavy("c")], focusedTab: "focus", closed: [heavy("d"), heavy("e")] });
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeGreaterThan(WORKSPACE_STATE_BYTES);
    const result = ok<{ trimmed: boolean; bytes: number }>(await run(ctx, "workspace.saveContext", { contextId: null, state: big }));
    expect(result.trimmed).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(WORKSPACE_STATE_BYTES);
    const back = (await load(ctx, null)).state;
    expect(back.tabs.map((item) => item.id)).toEqual(["focus", "b", "c"]);
    expect(back.focusedTab).toBe("focus");
    expect(back.tabs[0]!.view).toEqual({ blob: "x".repeat(60_000) });
    expect(back.closed.length).toBeLessThan(2);
  });

  it("answers a row that cannot be read with the empty state and says so, leaves it where it is, and replaces it at the next save", async () => {
    const ctx = await boot();
    const sqlite = ctx.app.store.sqlite;
    sqlite.prepare("INSERT INTO workspace_contexts(context_id, state_json, updated_at) VALUES ('', ?, ?)").run("{not json", "2026-10-01T00:00:00.000Z");
    const read = await load(ctx, null);
    expect(read).toMatchObject({ state: EMPTY_WORKSPACE_STATE, damaged: true, updatedAt: "2026-10-01T00:00:00.000Z" });
    expect(sqlite.prepare("SELECT state_json FROM workspace_contexts WHERE context_id = ''").get()).toEqual({ state_json: "{not json" });
    sqlite.prepare("UPDATE workspace_contexts SET state_json = ? WHERE context_id = ''").run(JSON.stringify({ version: 9, tabs: "no" }));
    expect((await load(ctx, null)).damaged).toBe(true);
    ok(await run(ctx, "workspace.saveContext", { contextId: null, state: state({ tabs: [tab("fresh")] }) }));
    expect(await load(ctx, null)).toMatchObject({ damaged: false, state: { tabs: [expect.objectContaining({ id: "fresh" })] } });
  });

  it("refuses a state that is not one, and a project that does not exist, and writes nothing", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    expect((await run(ctx, "workspace.saveContext", { contextId: a, state: { ...EMPTY_WORKSPACE_STATE, version: 2 } })).error?.code).toBe("VALIDATION_ERROR");
    expect((await run(ctx, "workspace.saveContext", { contextId: "prj_none", state: EMPTY_WORKSPACE_STATE })).error?.code).toBe("NOT_FOUND");
    expect((await run(ctx, "workspace.loadContext", { contextId: "prj_none" })).error?.code).toBe("NOT_FOUND");
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_contexts").get()).toEqual({ n: 0 });
    // Deleting a project takes its tabs with it.
    ok(await run(ctx, "workspace.saveContext", { contextId: a, state: state({ tabs: [tab("a-1")] }) }));
    ok(await run(ctx, "project.delete", { projectId: a }));
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_contexts").get()).toEqual({ n: 0 });
    expect((await run(ctx, "workspace.loadContext", { contextId: a })).error?.code).toBe("NOT_FOUND");
  });
});

describe("the contexts of the sidebar", () => {
  it("lists 最近 first and then the projects, newest activity first, with what each holds; archived projects only when asked for", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const b = await project(ctx, "项目乙");
    const archived = await project(ctx, "归档项目");
    ok(await run(ctx, "project.update", { projectId: archived, status: "archived" }));
    ok(await run(ctx, "workspace.saveContext", { contextId: null, state: state({ tabs: [tab("r1"), tab("r2"), tab("r3")] }) }));
    ok(await run(ctx, "workspace.saveContext", { contextId: b, state: state({ tabs: [tab("b1")] }) }));
    ok(await run(ctx, "conversation.new", { contextId: null }));
    const sqlite = ctx.app.store.sqlite;
    sqlite.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run("2026-10-01T00:00:00.000Z", a);
    sqlite.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run("2026-10-03T00:00:00.000Z", b);
    sqlite.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run("2026-09-01T00:00:00.000Z", archived);
    sqlite.prepare("UPDATE workspace_contexts SET updated_at = ? WHERE context_id = ?").run("2026-10-02T00:00:00.000Z", b);

    const listed = ok<{ contexts: Array<{ contextId: string | null; kind: string; name: string; status: string; conversationCount: number; tabCount: number; lastActivityAt: string | null }> }>(await run(ctx, "workspace.contexts", {})).contexts;
    expect(listed.map((item) => [item.contextId, item.kind, item.name, item.status])).toEqual([[null, "recent", "最近", "active"], [b, "project", "项目乙", "active"], [a, "project", "项目甲", "active"]]);
    expect(listed[0]).toMatchObject({ tabCount: 3, conversationCount: 1 });
    expect(listed[1]).toMatchObject({ tabCount: 1, conversationCount: 0, lastActivityAt: "2026-10-03T00:00:00.000Z" });
    expect(listed[2]).toMatchObject({ tabCount: 0, conversationCount: 0, lastActivityAt: "2026-10-01T00:00:00.000Z" });
    const all = ok<{ contexts: Array<{ contextId: string | null; status: string }> }>(await run(ctx, "workspace.contexts", { includeArchived: true })).contexts;
    expect(all.map((item) => item.contextId)).toEqual([null, b, a, archived]);
    expect(all.at(-1)).toMatchObject({ status: "archived" });
  });

  it("remembers the context the person left in, and forgets one that does not exist", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    expect(readShell(ctx.app.store).lastContext).toBeNull();
    ok(await run(ctx, "workspace.setLastContext", { contextId: a }));
    expect(readShell(ctx.app.store).lastContext).toBe(a);
    ok(await run(ctx, "workspace.setLastContext", { contextId: null }));
    expect(readShell(ctx.app.store).lastContext).toBeNull();
    ok(await run(ctx, "workspace.setLastContext", { contextId: a }));
    // A project that is not there is not somewhere to come back to.
    ok(await run(ctx, "workspace.setLastContext", { contextId: "prj_none" }));
    expect(readShell(ctx.app.store).lastContext).toBeNull();
    // The rest of the preference is as it was.
    expect(readShell(ctx.app.store)).toMatchObject({ version: 2, sidebar: { visible: true, width: 260 }, dock: { visible: true, width: 360 } });
  });
});
