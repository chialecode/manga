import { afterEach, describe, expect, it } from "vitest";
import { waitForRun } from "../helpers/app.ts";
import { call, deepseekApp } from "../helpers/provider-fixture.ts";

/**
 * The usage page with a provider's services (计划 4.9, AT-192): an answer whose cost the service does not state is estimated from the provider's price
 * list and says so with the date its prices were checked; speech and searches are rows of their own; a run refused for want of balance says what to do.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

type Row = { kind: string; id: string; status: string; costUsd: number | null; estimated: boolean; pricesCheckedAt: string | null; problem: string | null; service?: { name: string; unit: string; quantity: number } };
const usage = async (ctx: Awaited<ReturnType<typeof deepseekApp>>["ctx"]) => (await call(ctx, "usage.query", {})).value as { rows: Row[]; byModel: Array<{ key: string; runs: number }> };

describe("usage of a provider's services", () => {
  it("estimates the cost of an answer, lists speech and searches apart, and marks the estimates with the price date", async () => {
    const rig = await deepseekApp({ mock: { answer: "好的。" } });
    closers.push(rig.close);
    const session = await call(rig.ctx, "conversation.new", { contextId: null });
    const sessionId = String((session.value as { sessionId: string }).sessionId);
    const sent = await call(rig.ctx, "agent.send", { sessionId, text: "你好" });
    await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, String((sent.value as { runId: string }).runId));
    await rig.ctx.app.speech.speak({ text: "合成的朗读。" }, () => undefined, new AbortController().signal);
    const searched = await call(rig.ctx, "web.search", { query: "合成的查询" });
    expect(searched.status, JSON.stringify(searched)).toBe("ok");

    const found = await usage(rig.ctx);
    const run = found.rows.find((row) => row.kind === "run")!;
    expect(run.costUsd).toBeGreaterThan(0);
    expect(run).toMatchObject({ estimated: true, pricesCheckedAt: "2026-11-14" });

    const speech = found.rows.find((row) => row.service?.name === "speech")!;
    expect(speech).toMatchObject({ kind: "service", estimated: true, pricesCheckedAt: "2026-11-14", service: { unit: "char" } });
    expect(speech.costUsd).toBeCloseTo((speech.service!.quantity / 10_000) * 0.45, 8);
    expect(found.rows.find((row) => row.service?.name === "search")).toMatchObject({ kind: "service", service: { unit: "search", quantity: 1 } });
    expect(found.byModel.map((item) => item.key)).toEqual(expect.arrayContaining(["service:speech", "service:search"]));
  });

  it("says a run failed for want of balance", async () => {
    const rig = await deepseekApp({ mock: { fail: [{ path: "/chat/completions", status: 402, times: 5 }] } });
    closers.push(rig.close);
    const session = await call(rig.ctx, "conversation.new", { contextId: null });
    const sent = await call(rig.ctx, "agent.send", { sessionId: String((session.value as { sessionId: string }).sessionId), text: "你好" });
    await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, String((sent.value as { runId: string }).runId));
    const run = (await usage(rig.ctx)).rows.find((row) => row.kind === "run")!;
    expect(run.status).toBe("failed");
    expect(run.problem).toBe("billing");
  });
});
