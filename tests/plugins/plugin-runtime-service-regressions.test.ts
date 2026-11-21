import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginPermission } from "@manga/contracts";
import { PluginRuntime, type PluginChannel } from "../../packages/app-core/src/plugins/runtime.ts";
import { startApp, tempProfile } from "../helpers/app.ts";
import { makeKey, writePackage, type FixtureOptions } from "../helpers/plugin-fixtures.ts";

type App = Awaited<ReturnType<typeof startApp>>;
const first = makeKey("MANGA（第一方，测试）");
const LIMITS = { readyMs: 1500, pingMs: 50, missedPings: 3, graceMs: 100, callMs: 2000, maxRestarts: 3, restartBaseMs: 40, restartWindowMs: 60_000 };

const apps: App[] = [];
const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.shutdown().catch(() => undefined);
  while (apps.length) {
    try { apps.pop()!.app.close(); } catch { /* closed */ }
  }
});

function fakeChannel() {
  const msgListeners: Array<(msg: unknown) => void> = [];
  const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  const sent: unknown[] = [];
  let killed = false;
  const channel: PluginChannel = {
    pid: 99999,
    send: (msg) => { sent.push(msg); },
    onMessage: (fn) => { msgListeners.push(fn); },
    onExit: (fn) => { exitListeners.push(fn); },
    kill: () => {
      if (killed) return;
      killed = true;
      for (const fn of exitListeners) fn(null, "SIGTERM");
    },
  };
  return {
    channel,
    sent,
    emitMessage: (msg: unknown) => { for (const fn of msgListeners) fn(msg); },
    emitExit: (code: number | null, signal: string | null = null) => { for (const fn of exitListeners) fn(code, signal); },
  };
}

describe("PluginRuntime & PluginService regressions (A-02, A-10)", () => {
  it("A-02: stop() cancels pending crash restart and duplicate ready frames do not leak ping timers", async () => {
    const spawned: Array<ReturnType<typeof fakeChannel>> = [];
    const runtime = new PluginRuntime({
      limits: { ...LIMITS, pingMs: 30, restartBaseMs: 60 },
      spawn: () => {
        const ch = fakeChannel();
        spawned.push(ch);
        queueMicrotask(() => ch.emitMessage({ t: "ready" }));
        return ch.channel;
      },
    });
    runtimes.push(runtime);

    await runtime.start({ pluginId: "demo.rt", entry: "index.mjs", cwd: ".", dataDir: ".", granted: [] });
    expect(spawned).toHaveLength(1);

    // Send duplicate ready frames while already running — only one ping timer may exist.
    spawned[0]!.emitMessage({ t: "ready" });
    spawned[0]!.emitMessage({ t: "ready" });
    await new Promise((r) => setTimeout(r, 75));
    const pingsBeforeStop = spawned[0]!.sent.filter((m) => (m as { t?: string })?.t === "ping").length;
    expect(pingsBeforeStop).toBeLessThanOrEqual(4);

    // Crash the plugin -> schedules restart in 60ms -> call stop() before timer fires -> must NEVER respawn!
    spawned[0]!.emitExit(1, null);
    await runtime.stop("demo.rt");
    await new Promise((r) => setTimeout(r, 150));
    expect(spawned).toHaveLength(1);
    expect(runtime.info("demo.rt").state).toBe("stopped");
  });

  it("A-10: failed-upgrade auto-rollback restores prior permissions and view/startProcess intersect with active manifest", async () => {
    const ctx = await startApp({
      profileRoot: tempProfile(),
      options: { plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], limits: { ...LIMITS, readyMs: 400, pingMs: 1000 } } },
    });
    apps.push(ctx);
    let seq = 0;
    const run = (commandId: string, input: Record<string, unknown>) =>
      ctx.app.call(ctx.actor, { commandId, idempotencyKey: `a10-${++seq}`, input }, ctx.grant.handle);
    const install = (options: FixtureOptions, grant: PluginPermission[]) =>
      run("plugin.install", { pathHandle: ctx.app.registerPath("file", writePackage(options)), grant });

    // Install v1.0.0 with ["files"] permission.
    const v1 = await install({ key: first, id: "demo.perm", version: "1.0.0", permissions: ["files"] }, ["files"]);
    expect(v1.status, JSON.stringify(v1)).toBe("ok");

    // Attempt upgrade to v2.0.0 with fewer permissions ([]) whose entry crashes on start -> triggers auto-rollback!
    const v2 = await install({
      key: first,
      id: "demo.perm",
      version: "2.0.0",
      permissions: [],
      mode: "crash-start",
    }, []);
    expect(v2.status, JSON.stringify(v2)).toBe("ok");
    expect(v2.value).toMatchObject({ rolledBack: true, version: "1.0.0", enabled: true });

    // After auto-rollback to v1.0.0, v1.0.0 MUST be running again with ["files"] restored!
    const listed = await run("plugin.list", {});
    expect(listed.status).toBe("ok");
    const plugin = (listed.value as { plugins: Array<{ id: string; version: string; state: string; granted: PluginPermission[] }> }).plugins
      .find((p) => p.id === "demo.perm")!;
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.state).toBe("running");
    expect(plugin.granted).toEqual(["files"]);

    // Extra stale permission injected into granted_json must never be exposed by view() or passed to runtime.
    ctx.app.store.sqlite.prepare("UPDATE plugins SET granted_json = ? WHERE id = ?").run(JSON.stringify(["files", "network"]), "demo.perm");
    const listed2 = await run("plugin.list", {});
    const plugin2 = (listed2.value as { plugins: Array<{ id: string; granted: PluginPermission[] }> }).plugins
      .find((p) => p.id === "demo.perm")!;
    expect(plugin2.granted).toEqual(["files"]);
    expect(fs.existsSync(path.join(ctx.profileRoot))).toBe(true);
  });
});
