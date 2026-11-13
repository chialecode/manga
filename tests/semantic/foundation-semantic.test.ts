import { afterEach, describe, expect, it } from "vitest";
import { controlled } from "../helpers/embedder.ts";
import { startApp } from "../helpers/app.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) {
    try { closers.pop()!(); } catch { /* closed */ }
  }
});

describe("semantic service edge cases (F-03, F-12, F-25)", () => {
  it.each([true, false])("returns empty ok result when searching an active empty index (vec=%s) without calling embed (F-03)", async (vec) => {
    const model = controlled();
    const ctx = await startApp({ options: { embedding: model.port, semantic: { vec, retryBaseMs: 0 } } });
    closers.push(() => ctx.app.close());

    const cfg = await ctx.app.call(ctx.actor, {
      commandId: "semantic.configure",
      idempotencyKey: `sem-empty-cfg-${vec}`,
      input: { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" },
    }, ctx.grant.handle);
    expect(cfg.status).toBe("ok");
    await ctx.app.semantic.settled();

    const callsBefore = model.state.calls.length;
    const res = await ctx.app.call(ctx.actor, {
      commandId: "semantic.search",
      idempotencyKey: `sem-empty-search-${vec}`,
      input: { text: "任意问题" },
    }, ctx.grant.handle);
    expect(res.status).toBe("ok");
    expect(res.value).toMatchObject({ state: "ok", results: [], version: { dim: null } });
    expect(model.state.calls.length).toBe(callsBefore);
  });

  it("serializes concurrent rebuild/configure calls cleanly and leaves one active version (F-12)", async () => {
    const model = controlled();
    const ctx = await startApp({ options: { embedding: model.port, semantic: { vec: false, retryBaseMs: 0 } } });
    closers.push(() => ctx.app.close());

    await ctx.app.call(ctx.actor, {
      commandId: "notes.create",
      idempotencyKey: "sem-race-note",
      input: { title: "笔记", text: "海风吹过海岸线，灯塔闪着微光。" },
    }, ctx.grant.handle);

    const p1 = ctx.app.semantic.configure({ enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    const p2 = ctx.app.semantic.configure({ enabled: true, connectionId: "emb-b", segmentation: "paragraph-600" });
    const p3 = ctx.app.semantic.rebuild();
    await Promise.all([p1, p2, p3]);
    await ctx.app.semantic.settled();

    const versions = ctx.app.store.sqlite.prepare("SELECT id, model, status FROM index_versions ORDER BY id").all() as Array<{ id: number; model: string; status: string }>;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ model: "model-b", status: "active" });
  });

  it("preserves active index_versions counts on cancelled update and sub-batches >32-chunk sources (F-25)", async () => {
    const model = controlled();
    const ctx = await startApp({ options: { embedding: model.port, semantic: { vec: false, retryBaseMs: 0 } } });
    closers.push(() => ctx.app.close());

    // Create a single long document that splits into >32 chunks under paragraph-300.
    const bigText = Array.from({ length: 45 }, (_, i) => `第${i}段：${"这是一个用于测试分批嵌入的长段落内容。".repeat(16)}`).join("\n\n");
    await ctx.app.call(ctx.actor, {
      commandId: "notes.create",
      idempotencyKey: "sem-big-note",
      input: { title: "长笔记", text: bigText },
    }, ctx.grant.handle);

    await ctx.app.semantic.configure({ enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
    await ctx.app.semantic.settled();
    // Every single provider embed call must respect BATCH <= 32.
    expect(model.state.calls.length).toBeGreaterThanOrEqual(2);
    expect(model.state.calls.every((call) => call.inputs.length <= 32)).toBe(true);

    const beforeRow = ctx.app.store.sqlite.prepare("SELECT done, total FROM index_versions WHERE status = 'active'").get() as { done: number; total: number };
    expect(beforeRow.done).toBeGreaterThan(32);
    expect(beforeRow.total).toBe(beforeRow.done);

    // Add a new note, hold emb-a during update, then cancel: active row's done/total must stay untouched.
    await ctx.app.call(ctx.actor, {
      commandId: "notes.create",
      idempotencyKey: "sem-inc-note",
      input: { title: "新笔记", text: "增量更新的测试内容。" },
    }, ctx.grant.handle);

    const release = model.hold("emb-a");
    await ctx.app.semantic.update();
    const midRow = ctx.app.store.sqlite.prepare("SELECT done, total FROM index_versions WHERE status = 'active'").get() as { done: number; total: number };
    expect(midRow).toEqual(beforeRow);
    await ctx.app.semantic.cancel();
    release();
    const afterRow = ctx.app.store.sqlite.prepare("SELECT done, total FROM index_versions WHERE status = 'active'").get() as { done: number; total: number };
    expect(afterRow).toEqual(beforeRow);
  });
});
