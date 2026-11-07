import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { resolveLocation } from "../../packages/app-core/src/library-locations.ts";
import { startApp, waitForRun } from "../helpers/app.ts";
import { inLibrary, requireSamples, samplePath } from "../helpers/samples.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";

// AT-144 / 计划 4.4: a task's stills are kept once per content and named by hash in the snapshot; after the retention period they go, the snapshot
// keeps their source and size, and a retry takes the same still again from an unchanged source or stops and says why.

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
type Seen = { url: string; body: Record<string, any> };
let counter = 0;
const apps: App[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) apps.pop()!.app.close();
  while (closers.length) await closers.pop()!();
});

const run = (ctx: App, commandId: string, input: Record<string, unknown>) => ctx.app.call(ctx.actor, { commandId, idempotencyKey: `amedia-${counter += 1}`, input }, ctx.grant.handle);
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const DAY = 86_400_000;
const count = (ctx: App, table: string) => (ctx.app.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const imageRequests = (seen: Seen[]) => seen.filter((request) => JSON.stringify(request.body).includes("image_url") && !JSON.stringify(request.body).includes("Reply with one word"));
const sentImage = (request: Seen) => /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(JSON.stringify(request.body))?.[1];

describe.skipIf(mediaPrerequisitesAbsent)("the stills of a task, kept once and let go after the retention period (AT-144)", () => {
  requireSamples(["cbz-basic"]);

  async function rig() {
    const ctx = await startApp();
    apps.push(ctx);
    const seen: Seen[] = [];
    const server = await startMockProvider({ onRequest: (request) => { seen.push(request as Seen); } });
    closers.push(server.close);
    const created = ok<{ id: string }>(await run(ctx, "connections.upsert", { label: "seeing", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "m", purpose: "text", credentialHandle: ctx.app.stashSecret("k") }));
    for (const capability of ["text", "vision"]) ok(await run(ctx, "connections.test", { connectionId: created.id, capability }));
    const comic = ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importDocument", { title: "有图的漫画", kind: "comic", pathHandle: ctx.app.registerPath("file", inLibrary(ctx.app, samplePath("cbz-basic"))) }));
    const pages = ok<{ pages: Array<{ id: string }> }>(await run(ctx, "comic.pages", { resourceId: comic.resourceId }));
    const sessionId = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" })).id;
    const still = ok<Record<string, any>>(await run(ctx, "material.region", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: pages.pages[1]!.id, region: { x: 0, y: 0, width: 0.5, height: 0.5 } }));
    const ask = async (text: string) => {
      const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId, text, imageMaterialIds: [still.materialId] }));
      await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
      return sent.runId;
    };
    /** As if the run had failed `days` ago, so a retry goes through the loop again and the clean-up sees it as over. */
    const endedAgo = (runId: string, days: number, status = "failed") => ctx.app.store.sqlite.prepare("UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date(Date.now() - days * DAY).toISOString(), runId);
    const retry = async (runId: string) => {
      ok(await run(ctx, "agent.retry", { runId }));
      return waitForRun(ctx.app, ctx.actor, ctx.grant.handle, runId);
    };
    return { ctx, seen, comic, still, ask, endedAgo, retry };
  }

  it("keeps one copy of a still two runs share, and names it by hash in each snapshot", async () => {
    const { ctx, still, ask } = await rig();
    const first = await ask("第一次");
    const second = await ask("第二次");
    expect(count(ctx, "agent_media")).toBe(1);
    expect(count(ctx, "agent_run_media")).toBe(2);
    for (const runId of [first, second]) {
      const snapshot = (ctx.app.store.sqlite.prepare("SELECT snapshot_json FROM agent_runs WHERE id = ?").get(runId) as { snapshot_json: string }).snapshot_json;
      expect(snapshot).not.toContain(still.base64.slice(0, 64));
      expect(snapshot).not.toContain("\"base64\"");
      expect(JSON.parse(snapshot).media.images[0].hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const kept = ctx.app.store.sqlite.prepare("SELECT bytes FROM agent_media").get() as { bytes: Buffer };
    expect(Buffer.from(kept.bytes).toString("base64")).toBe(still.base64);
  });

  it("lets the stills of ended runs go after the period, keeps those of running and recent runs, and a retry takes the same still from its unchanged source", async () => {
    const { ctx, seen, still, ask, endedAgo, retry } = await rig();
    const old = await ask("旧的");
    const recent = await ask("新的");
    const going = await ask("还在进行");
    endedAgo(old, 31);
    endedAgo(recent, 2);
    ctx.app.store.sqlite.prepare("UPDATE agent_runs SET status = 'running', updated_at = ? WHERE id = ?").run(new Date(Date.now() - 90 * DAY).toISOString(), going);
    expect(ctx.app.sweepAgentMedia()).toEqual({ runs: 1, removed: 0 });
    // The shared content stays: the recent and the running run still refer to it.
    expect(count(ctx, "agent_media")).toBe(1);
    expect((ctx.app.store.sqlite.prepare("SELECT run_id FROM agent_run_media ORDER BY run_id").all() as Array<{ run_id: string }>).map((row) => row.run_id).sort()).toEqual([going, recent].sort());
    const receipt = ok<Record<string, any>>(await run(ctx, "agent.getRun", { runId: old }));
    expect(receipt.media.images[0]).toMatchObject({ expired: true, width: still.width, height: still.height, origin: { kind: "comic_region" } });
    expect(receipt.media.images[0].stamp).toBeUndefined();
    // The recent run retries with the very bytes it froze.
    const before = seen.length;
    await retry(recent);
    for (const request of imageRequests(seen.slice(before))) expect(sentImage(request)).toBe(still.base64);
    // The expired one takes the still again from the same page of the same file, and the call record says so.
    const beforeOld = seen.length;
    const done = await retry(old);
    expect(String(done.value?.status ?? done.value?.run?.status)).toBe("succeeded");
    expect(imageRequests(seen.slice(beforeOld)).length).toBeGreaterThan(0);
    const trace = ok<{ entries: Array<{ kind: string; delivery: Array<{ kind: string; reason?: string; bytes?: number }> | null }> }>(await run(ctx, "agent.trace.list", { runId: old })).entries;
    const delivered = trace.filter((entry) => entry.kind === "model" && entry.delivery).at(-1)!.delivery!;
    expect(delivered).toEqual([expect.objectContaining({ kind: "image", reason: "expired-reextracted" })]);
    expect(JSON.stringify(delivered)).not.toContain(still.base64.slice(0, 32));
    // Once nothing refers to it, the content itself goes.
    endedAgo(recent, 40);
    endedAgo(going, 40);
    expect(ctx.app.sweepAgentMedia().removed).toBe(1);
    expect(count(ctx, "agent_media")).toBe(0);
  });

  it("stops a retry with the reason when the source of an expired still changed, and sends no other picture", async () => {
    const { ctx, seen, comic, ask, endedAgo } = await rig();
    const runId = await ask("看看这一块");
    endedAgo(runId, 60);
    ctx.app.sweepAgentMedia();
    const file = resolveLocation(ctx.app.store, comic.revisionId)!.path!;
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    const before = seen.length;
    ok(await run(ctx, "agent.retry", { runId }));
    const done = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, runId);
    expect(String(done.value?.status ?? done.value?.run?.status)).toBe("failed");
    const error = (ctx.app.store.sqlite.prepare("SELECT error_json FROM agent_runs WHERE id = ?").get(runId) as { error_json: string }).error_json;
    expect(JSON.parse(error)).toMatchObject({ code: "REVISION_CONFLICT", details: { reason: "media-source-changed" } });
    expect(JSON.parse(error).message).toContain("重新发起任务");
    expect(imageRequests(seen.slice(before))).toEqual([]);
  });

  it("keeps everything when the period is set to for ever, and the setting is checked", async () => {
    const { ctx, ask, endedAgo } = await rig();
    const runId = await ask("一直保留");
    endedAgo(runId, 400);
    ok(await run(ctx, "settings.setAgent", { media: { retentionDays: null } }));
    expect(ctx.app.sweepAgentMedia()).toEqual({ runs: 0, removed: 0 });
    expect(count(ctx, "agent_run_media")).toBe(1);
    expect((await run(ctx, "settings.setAgent", { media: { retentionDays: 0 } })).status).toBe("error");
    expect((await run(ctx, "settings.setAgent", { media: { retentionDays: 366 } })).status).toBe("error");
    expect(ok<{ media: { retentionDays: number | null } }>(await run(ctx, "settings.setAgent", { media: { retentionDays: 7 } })).media.retentionDays).toBe(7);
    expect(ctx.app.sweepAgentMedia().runs).toBe(1);
  });

  it("a clean-up at the same moment as a retry gives the retry either the kept bytes or the still taken again, never part of one", async () => {
    const { ctx, seen, still, ask, endedAgo } = await rig();
    for (let round = 0; round < 4; round += 1) {
      const runId = await ask(`第 ${round} 次`);
      endedAgo(runId, 45);
      const before = seen.length;
      const retried = run(ctx, "agent.retry", { runId });
      ctx.app.sweepAgentMedia();
      ok(await retried);
      const done = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, runId);
      expect(String(done.value?.status ?? done.value?.run?.status)).toBe("succeeded");
      const sent = imageRequests(seen.slice(before)).map(sentImage);
      expect(sent.length).toBeGreaterThan(0);
      // Taken again from the same page at the same size, the still is the same picture; either way it decodes as a whole JPEG.
      for (const base64 of sent) {
        const bytes = Buffer.from(base64!, "base64");
        expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
        expect(bytes.subarray(-2).toString("hex")).toBe("ffd9");
      }
      void still;
    }
  });
});
