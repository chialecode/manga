import { afterEach, describe, expect, it } from "vitest";
import { waitForRun } from "../helpers/app.ts";
import { call, deepseekApp } from "../helpers/provider-fixture.ts";

/** `web.search` through the provider's search service (计划 4.5, AT-189): results, retries, refusals, and the Agent's tool when the model does not search by itself. */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function boot(mock: NonNullable<Parameters<typeof deepseekApp>[0]>["mock"] = {}, add = { models: [] as string[], services: ["search"] }) {
  const rig = await deepseekApp({ mock, add });
  closers.push(rig.close);
  return rig;
}
const searches = (rig: Awaited<ReturnType<typeof boot>>) => rig.server.requests.filter((request) => request.path === "/v1/tools/search");

describe("web.search", () => {
  it("returns titles, links, sites and summaries, cuts long words to 128 characters, and records the use", async () => {
    const rig = await boot();
    const found = await call(rig.ctx, "web.search", { query: "  合成的   关键词  ", count: 3 });
    expect(found.status, JSON.stringify(found)).toBe("ok");
    const value = found.value as { query: string; truncated: boolean; results: Array<Record<string, unknown>> };
    expect(value).toMatchObject({ query: "合成的 关键词", truncated: false });
    expect(value.results.length).toBeGreaterThan(0);
    expect(value.results[0]).toEqual(expect.objectContaining({ title: expect.any(String), url: expect.stringMatching(/^https:\/\//), site: expect.any(String) }));
    expect(searches(rig)[0]!.body).toMatchObject({ query: "合成的 关键词", count: 3, need_content: false });

    const long = await call(rig.ctx, "web.search", { query: "长".repeat(300) });
    expect((long.value as { truncated: boolean; query: string })).toMatchObject({ truncated: true });
    expect([...(long.value as { query: string }).query]).toHaveLength(128);

    const empty = await call(rig.ctx, "web.search", { query: "没有结果的词" });
    expect((empty.value as { results: unknown[] }).results).toEqual([]);
    const used = rig.ctx.app.store.sqlite.prepare("SELECT status, task FROM service_usage WHERE service = 'search'").all();
    expect(used).toEqual([{ status: "ok", task: "research" }, { status: "ok", task: "research" }, { status: "ok", task: "research" }]);
  });

  it("tries again twice on 503 and 429, not on 401 or 402", async () => {
    const rig = await boot({ fail: [{ path: "/v1/tools/search", status: 503, times: 2 }] });
    const recovered = await call(rig.ctx, "web.search", { query: "重试" });
    expect(recovered.status, JSON.stringify(recovered)).toBe("ok");
    expect(searches(rig)).toHaveLength(3);

    const failing = await boot({ fail: [{ path: "/v1/tools/search", status: 429, times: 5 }] });
    const limited = await call(failing.ctx, "web.search", { query: "限流" });
    expect(limited.status).toBe("error");
    expect(searches(failing)).toHaveLength(3);

    const broke = await boot({ fail: [{ path: "/v1/tools/search", status: 402, times: 5 }] });
    const billing = await call(broke.ctx, "web.search", { query: "余额" });
    expect(billing.status).toBe("error");
    expect(JSON.stringify(billing)).toContain("billing");
    expect(searches(broke)).toHaveLength(1);
    expect(broke.ctx.app.store.sqlite.prepare("SELECT status, error_code FROM service_usage").get()).toEqual({ status: "error", error_code: "PROVIDER_UNAVAILABLE" });
  });

  it("says how to add a search service when there is none, and makes no request while the plugin is off", async () => {
    const none = await boot({}, { models: [], services: [] });
    const missing = await call(none.ctx, "web.search", { query: "没有服务" });
    expect(missing.status).toBe("error");
    expect(JSON.stringify(missing)).toContain("no_search_service");

    const rig = await boot();
    expect((await call(rig.ctx, "plugin.disable", { pluginId: "demo.provider" })).status).toBe("ok");
    const off = await call(rig.ctx, "web.search", { query: "停用" });
    expect(off.status).toBe("error");
    expect(JSON.stringify(off)).toContain("plugin_disabled");
    expect(searches(rig)).toHaveLength(0);
  });

  it("is the Agent's tool under 联网搜索 when the model does not search by itself, and is not offered otherwise", async () => {
    const rig = await boot({ toolScript: [{ name: "web.search", arguments: JSON.stringify({ query: "合成的新闻" }) }], answer: "搜到了。" }, { models: ["deepseek-v4-pro"], services: ["search"] });
    // The model's profile without its own search: the service's tool is used instead.
    const text = rig.connection("text")!;
    expect((await call(rig.ctx, "connections.setProfile", { connectionId: text, profile: { capabilities: ["tools", "reasoning"] } })).status).toBe("ok");
    const session = String(((await call(rig.ctx, "conversation.new", { contextId: null })).value as { sessionId: string }).sessionId);

    const sent = await call(rig.ctx, "agent.send", { sessionId: session, text: "联网查", allowCommands: ["web.search"] });
    const runId = String((sent.value as { runId: string }).runId);
    const done = await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, runId);
    expect(done.value?.status, JSON.stringify(done.value?.error)).toBe("succeeded");
    expect(searches(rig).length).toBeGreaterThan(0);
    expect((searches(rig).at(-1)!.body as { query: string }).query).toBe("合成的新闻");
    const bodies = rig.server.requests.filter((request) => request.path.endsWith("/chat/completions")).map((request) => request.body as { tools?: Array<Record<string, any>> });
    expect(bodies.at(-1)!.tools?.some((tool) => tool.type === "deepseek_web_search")).toBe(false);
    expect(rig.ctx.app.store.sqlite.prepare("SELECT task, run_id FROM service_usage WHERE service = 'search' AND status = 'ok'").all()).toEqual([{ task: "agent", run_id: runId }]);

    // Without 联网搜索 the tool is not offered (the scripted call is spent; this run answers in words).
    const plain = await call(rig.ctx, "agent.send", { sessionId: session, text: "不联网" });
    await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, String((plain.value as { runId: string }).runId));
    const plainTools = (rig.server.requests.filter((request) => request.path.endsWith("/chat/completions")).at(-1)!.body as { tools?: Array<{ function?: { name: string } }> }).tools ?? [];
    expect(plainTools.some((tool) => tool.function?.name === "web.search")).toBe(false);
  });
});
