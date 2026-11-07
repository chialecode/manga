import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginPermission } from "@manga/contracts";
import { startApp, tempProfile } from "../helpers/app.ts";
import { makeKey, packageBytes, tmpDir, writePackage, type FixtureOptions, type TestKey } from "../helpers/plugin-fixtures.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
type View = { id: string; version: string; state: string; error: string | null; enabled: boolean; trust: string; granted: PluginPermission[]; previousVersion: string | null; dataBytes: number; facets: string[] };

const first = makeKey("MANGA（第一方，测试）");
const stranger = makeKey("陌生发布者");
const LIMITS = { readyMs: 1500, pingMs: 40, missedPings: 3, graceMs: 150, callMs: 3000, maxRestarts: 2, restartBaseMs: 20, restartWindowMs: 60_000 };

const apps: App[] = [];
afterEach(() => { while (apps.length) { try { apps.pop()!.app.close(); } catch { /* closed already */ } } });

let counter = 0;
async function boot(restartOf?: { profileRoot: string }, bundledDir?: string, limits: Partial<typeof LIMITS & { messagesPerSecond: number }> = {}): Promise<App> {
  const ctx = await startApp({ profileRoot: restartOf?.profileRoot ?? tempProfile(), options: { plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], limits: { ...LIMITS, ...limits }, bundledDir } } });
  apps.push(ctx);
  return ctx;
}
function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `pl-${counter}`, input }, ctx.grant.handle);
}
const ok = <T = Record<string, any>>(result: Call): T => { expect(result.status, JSON.stringify(result)).toBe("ok"); return result.value as T; };
const fails = (result: Call) => { expect(result.status, JSON.stringify(result)).toBe("error"); return (result as { error: { code: string; details?: { reason?: string; missing?: string[] } } }).error; };
const fileHandle = (ctx: App, file: string) => ctx.app.registerPath("file", file);
const install = (ctx: App, options: FixtureOptions, grant?: PluginPermission[], extra: Record<string, unknown> = {}) =>
  run(ctx, "plugin.install", { pathHandle: fileHandle(ctx, writePackage(options)), grant: grant ?? options.permissions ?? [], ...extra });
const list = async (ctx: App) => ok<{ plugins: View[]; leftovers: Array<{ pluginId: string; bytes: number }> }>(await run(ctx, "plugin.list", {}));
const view = async (ctx: App, id = "demo.tool") => (await list(ctx)).plugins.find((item) => item.id === id)!;
const trust = (ctx: App, key: TestKey) => run(ctx, "plugin.trust.add", { publicKey: key.publicKey, label: key.label });
const call = (ctx: App, method: string, params: unknown = {}, id = "demo.tool") => ctx.app.pluginRuntime.call(id, method, params, { timeoutMs: 2000 });
async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, ms = 4000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > ms) throw new Error(`gave up waiting; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

describe("installing a plugin package: only what the host trusts, and only with the permissions the person confirmed", () => {
  it("installs and runs a package the first party signed, and calls it", async () => {
    const ctx = await boot();
    const result = ok<{ pluginId: string; version: string; action: string; enabled: boolean; error: string | null }>(await install(ctx, { key: first }));
    expect(result).toMatchObject({ pluginId: "demo.tool", version: "1.0.0", action: "install", enabled: true, error: null });
    const item = await view(ctx);
    expect(item).toMatchObject({ state: "running", trust: "first-party", enabled: true });
    expect(await call(ctx, "echo", { n: 1 })).toEqual({ n: 1 });
    const pid = ctx.app.pluginRuntime.info("demo.tool").pid;
    expect(alive(pid)).toBe(true);
  });

  it("refuses a package signed by a key nobody trusts, even when its manifest says it is the first party's (AT-34)", async () => {
    const ctx = await boot();
    const forged = { key: stranger, publisher: { id: "manga", name: "MANGA（第一方）" } };
    expect(fails(await install(ctx, forged)).details?.reason).toBe("untrusted");
    const file = fileHandle(ctx, writePackage(forged));
    expect(ok<{ trust: string; refusal: { reason: string } }>(await run(ctx, "plugin.inspect", { pathHandle: file }))).toMatchObject({ trust: "unknown", refusal: { reason: "untrusted" } });
    expect((await list(ctx)).plugins).toEqual([]);
  });

  it("refuses an unsigned package, one changed after signing, and one whose files were swapped", async () => {
    const ctx = await boot();
    const dir = tmpDir();
    const bytes = packageBytes({ key: first });
    const unzipped = unzipSync(bytes);
    const { zipSync, strToU8 } = await import("fflate");
    const unsigned = path.join(dir, "unsigned.zip");
    const { "signature.json": _drop, ...withoutSignature } = unzipped;
    fs.writeFileSync(unsigned, zipSync(withoutSignature));
    expect(fails(await run(ctx, "plugin.install", { pathHandle: fileHandle(ctx, unsigned), grant: [] })).details?.reason).toBe("unsigned");
    const swapped = path.join(dir, "swapped.zip");
    fs.writeFileSync(swapped, zipSync({ ...unzipped, "payload/main.mjs": strToU8("require('child_process').exec('calc')") }));
    expect(fails(await run(ctx, "plugin.install", { pathHandle: fileHandle(ctx, swapped), grant: [] })).details?.reason).toBe("signature");
    const notZip = path.join(dir, "text.zip");
    fs.writeFileSync(notZip, "hello");
    expect(fails(await run(ctx, "plugin.install", { pathHandle: fileHandle(ctx, notZip), grant: [] })).details?.reason).toBe("format");
    expect((await list(ctx)).plugins).toEqual([]);
  });

  it("installs a package from a publisher the person chose to trust, and stops trusting it when the person takes the key away", async () => {
    const ctx = await boot();
    expect(fails(await install(ctx, { key: stranger })).details?.reason).toBe("untrusted");
    const added = ok<{ key: { keyId: string; trust: string; fingerprint: string } }>(await trust(ctx, stranger));
    expect(added.key.trust).toBe("user");
    expect(added.key.fingerprint).toMatch(/^([a-f0-9]{4} ){7}[a-f0-9]{4}$/);
    ok(await install(ctx, { key: stranger }));
    const running = await view(ctx);
    expect(running).toMatchObject({ state: "running", trust: "user" });
    const pid = ctx.app.pluginRuntime.info("demo.tool").pid;
    ok(await run(ctx, "plugin.trust.remove", { keyId: added.key.keyId }));
    const after = await until(() => view(ctx), (item) => item.state === "untrusted");
    expect(after.error).toMatch(/no longer trusted/);
    await until(() => alive(pid), (value) => !value);
    expect(ok<{ keys: Array<{ trust: string }> }>(await run(ctx, "plugin.trust.list", {})).keys.map((key) => key.trust)).toEqual(["first-party"]);
    // Trusting it again lets what the person had enabled run again.
    ok(await trust(ctx, stranger));
    await until(() => view(ctx), (item) => item.state === "running");
  });

  it("does not let the first party's own key be removed, and says so for a key that is not trusted", async () => {
    const ctx = await boot();
    const own = ok<{ keys: Array<{ keyId: string }> }>(await run(ctx, "plugin.trust.list", {})).keys[0]!.keyId;
    expect(fails(await run(ctx, "plugin.trust.remove", { keyId: own })).details?.reason).toBe("key");
    expect(fails(await run(ctx, "plugin.trust.remove", { keyId: "0123456789abcdef" })).code).toBe("NOT_FOUND");
    expect(fails(await run(ctx, "plugin.trust.add", { publicKey: "not-a-key-but-long-enough-to-pass-the-length-check-1234", label: "x" })).details?.reason).toBe("key");
  });

  it("needs every permission the package declares to be confirmed, and runs with exactly those", async () => {
    const ctx = await boot();
    const options = { key: first, permissions: ["network", "files"] as PluginPermission[] };
    expect(fails(await install(ctx, options, [])).details?.missing).toEqual(["network", "files"]);
    expect(fails(await install(ctx, options, ["network"])).details?.missing).toEqual(["files"]);
    expect((await list(ctx)).plugins).toEqual([]);
    ok(await install(ctx, options, ["network", "files", "files"]));
    expect((await view(ctx)).granted).toEqual(["network", "files"]);
  });

  it("refuses a plugin that is not made for this version of the application", async () => {
    const ctx = await boot();
    expect(fails(await install(ctx, { key: first, host: { min: "9.0.0" } })).details?.reason).toBe("incompatible");
    // The newest version the plugin works with may be the one the application is.
    ok(await install(ctx, { key: first, host: { min: "0.0.0", max: "0.0.0" }, version: "1.0.0" }));
  });

  it("is run only by the owner", async () => {
    const ctx = await boot();
    const agent = ctx.app.issueAgentGrant(ctx.grant, { kind: "agent", id: "agent-plugin" }, { readResourceIds: [] });
    const denied = await ctx.app.call({ kind: "agent", id: "agent-plugin" }, { commandId: "plugin.list", idempotencyKey: "pl-agent", input: {} }, agent.handle);
    expect(denied.status).toBe("error");
    expect(fails(await run(ctx, "plugin.install", { pathHandle: "path_unknown", grant: [] })).code).toBe("FORBIDDEN");
    expect(fails(await run(ctx, "plugin.install", { grant: [] })).code).toBe("VALIDATION_ERROR");
    expect(fails(await run(ctx, "plugin.enable", { pluginId: "nothing.here" })).code).toBe("NOT_FOUND");
  });
});

describe("upgrading, going back, and the version that cannot start", () => {
  it("keeps the version it replaces and goes back to it, and back again", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first, version: "1.0.0" }));
    expect(await call(ctx, "version")).toBe("1.0.0");
    const upgraded = ok<{ action: string; version: string; enabled: boolean }>(await install(ctx, { key: first, version: "1.1.0" }));
    expect(upgraded).toMatchObject({ action: "upgrade", version: "1.1.0", enabled: true });
    expect(await call(ctx, "version")).toBe("1.1.0");
    expect(await view(ctx)).toMatchObject({ version: "1.1.0", previousVersion: "1.0.0" });
    ok(await run(ctx, "plugin.rollback", { pluginId: "demo.tool" }));
    expect(await view(ctx)).toMatchObject({ version: "1.0.0", previousVersion: "1.1.0", state: "running" });
    expect(await call(ctx, "version")).toBe("1.0.0");
    ok(await run(ctx, "plugin.rollback", { pluginId: "demo.tool" }));
    expect(await call(ctx, "version")).toBe("1.1.0");
  });

  it("keeps only the current version and the one before it", async () => {
    const ctx = await boot();
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) ok(await install(ctx, { key: first, version }));
    const root = path.join(ctx.profileRoot, "data", "plugins", "demo.tool");
    expect(fs.readdirSync(root).sort()).toEqual(["1.1.0", "1.2.0"]);
    expect(await view(ctx)).toMatchObject({ version: "1.2.0", previousVersion: "1.1.0" });
  });

  it("refuses the same version, an older one, and going back when nothing is kept", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first, version: "1.1.0" }));
    expect(fails(await install(ctx, { key: first, version: "1.1.0" })).details?.reason).toBe("same-version");
    expect(fails(await install(ctx, { key: first, version: "1.0.0" })).details?.reason).toBe("older");
    expect(fails(await run(ctx, "plugin.rollback", { pluginId: "demo.tool" })).details?.reason).toBe("no-previous");
    expect((await view(ctx)).version).toBe("1.1.0");
  });

  it("puts the working version back when the new one cannot start", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first, version: "1.0.0" }));
    const result = ok<{ rolledBack: boolean; version: string; enabled: boolean; error: string | null }>(await install(ctx, { key: first, version: "2.0.0", mode: "crash-start" }));
    expect(result).toMatchObject({ rolledBack: true, version: "1.0.0", enabled: true });
    expect(result.error).toBeTruthy();
    expect(await view(ctx)).toMatchObject({ version: "1.0.0", state: "running", previousVersion: "2.0.0" });
    expect(await call(ctx, "version")).toBe("1.0.0");
  });

  it("leaves a first install that cannot start installed, stopped, with the reason", async () => {
    const ctx = await boot();
    const result = ok<{ enabled: boolean; error: string | null; rolledBack: boolean }>(await install(ctx, { key: first, mode: "crash-start" }));
    expect(result).toMatchObject({ enabled: false, rolledBack: false });
    expect(result.error).toBeTruthy();
    expect(await view(ctx)).toMatchObject({ enabled: false, state: "failed" });
    expect((await view(ctx)).error).toBeTruthy();
    // Turning it off clears the failure it was left with.
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.tool" }));
    expect(await view(ctx)).toMatchObject({ enabled: false, state: "disabled", error: null });
  });

  it("needs a new confirmation for a permission the new version adds, and does not let a refusal change what runs (AT-48)", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first, version: "1.0.0", permissions: ["network"] }));
    const file = fileHandle(ctx, writePackage({ key: first, version: "1.1.0", permissions: ["network", "files"] }));
    const inspected = ok<{ action: string; newPermissions: string[] }>(await run(ctx, "plugin.inspect", { pathHandle: file }));
    expect(inspected).toMatchObject({ action: "upgrade", newPermissions: ["files"] });
    const denied = fails(await run(ctx, "plugin.install", { pathHandle: file, grant: ["network"] }));
    expect(denied.details?.missing).toEqual(["files"]);
    expect(await view(ctx)).toMatchObject({ version: "1.0.0", state: "running", granted: ["network"] });
    ok(await run(ctx, "plugin.install", { pathHandle: file, grant: ["network", "files"] }));
    expect(await view(ctx)).toMatchObject({ version: "1.1.0", granted: ["network", "files"] });
  });

  it("does not start an earlier version that needs permissions the person never confirmed", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first, version: "1.0.0", permissions: ["files"] }));
    ok(await install(ctx, { key: first, version: "1.1.0", permissions: [] }));
    expect((await view(ctx)).granted).toEqual([]);
    expect(fails(await run(ctx, "plugin.rollback", { pluginId: "demo.tool" })).details?.reason).toBe("permissions");
    expect((await view(ctx)).version).toBe("1.1.0");
  });
});

describe("enabling, disabling and the processes behind them", () => {
  it("stops the process when the plugin is turned off and starts a new one when it is turned on", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first }));
    const first_pid = ctx.app.pluginRuntime.info("demo.tool").pid;
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.tool" }));
    expect(await view(ctx)).toMatchObject({ state: "disabled", enabled: false });
    await until(() => alive(first_pid), (value) => !value);
    await expect(call(ctx, "echo")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    ok(await run(ctx, "plugin.enable", { pluginId: "demo.tool" }));
    const second_pid = ctx.app.pluginRuntime.info("demo.tool").pid;
    expect(second_pid).not.toBe(first_pid);
    expect(alive(second_pid)).toBe(true);
  });

  it("starts what was enabled when the application starts again, and not what was turned off", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first }));
    ok(await install(ctx, { key: first, id: "demo.off" }));
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.off" }));
    const pid = ctx.app.pluginRuntime.info("demo.tool").pid;
    ctx.app.close();
    await until(() => alive(pid), (value) => !value);
    const again = await boot(ctx);
    const states = Object.fromEntries((await until(() => list(again), (value) => value.plugins.some((item) => item.id === "demo.tool" && item.state === "running"))).plugins.map((item) => [item.id, item.state]));
    expect(states).toEqual({ "demo.off": "disabled", "demo.tool": "running" });
  });

  it("ends a process that does not stop when asked, after the grace period", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first, mode: "ignore-stop" }));
    const pid = ctx.app.pluginRuntime.info("demo.tool").pid;
    const started = Date.now();
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.tool" }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(LIMITS.graceMs - 20);
    await until(() => alive(pid), (value) => !value);
  });

  it("does not start a plugin whose installed files were changed on disk", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first }));
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.tool" }));
    fs.writeFileSync(path.join(ctx.profileRoot, "data", "plugins", "demo.tool", "1.0.0", "payload", "main.mjs"), "process.exit(0)");
    const refused = fails(await run(ctx, "plugin.enable", { pluginId: "demo.tool" }));
    expect(refused.details?.reason).toBe("integrity");
    expect(await view(ctx)).toMatchObject({ enabled: false, state: "failed" });
    expect((await view(ctx)).error).toMatch(/signature/);
    expect(ctx.app.pluginRuntime.info("demo.tool").state).toBe("stopped");
  });

  it("records why a plugin that was enabled cannot start when the application starts, and starts the others", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first }));
    ok(await install(ctx, { key: first, id: "demo.other" }));
    ctx.app.close();
    fs.rmSync(path.join(ctx.profileRoot, "data", "plugins", "demo.tool", "1.0.0", "payload", "main.mjs"));
    const again = await boot(ctx);
    const listing = await until(() => list(again), (value) => value.plugins.find((item) => item.id === "demo.other")?.state === "running");
    expect(listing.plugins.find((item) => item.id === "demo.tool")).toMatchObject({ state: "failed" });
    expect(listing.plugins.find((item) => item.id === "demo.tool")!.error).toMatch(/missing|match|read/);
  });

  it("stops every plugin when the plugin feature is switched off, and starts them again when it is switched on", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first }));
    const pid = ctx.app.pluginRuntime.info("demo.tool").pid;
    ok(await run(ctx, "settings.setModule", { featureId: "plugins", enabled: false }));
    await until(() => alive(pid), (value) => !value);
    expect(fails(await run(ctx, "plugin.list", {})).code).toBe("CAPABILITY_UNAVAILABLE");
    ok(await run(ctx, "settings.setModule", { featureId: "plugins", enabled: true }));
    await until(() => view(ctx), (item) => item.state === "running");
  });

  it("ends the processes when the application closes", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first }));
    const pid = ctx.app.pluginRuntime.info("demo.tool").pid;
    ctx.app.close();
    await until(() => alive(pid), (value) => !value);
  });
});

describe("what a plugin turns on", () => {
  it("offers the interface part a plugin declares only while it is enabled and trusted", async () => {
    const ctx = await boot();
    const facets = async () => ok<{ uiFacets: string[] }>(await run(ctx, "workspace.get", {})).uiFacets;
    expect(await facets()).not.toContain("acquisition");
    ok(await install(ctx, { key: first, facets: ["acquisition"], provides: [{ slot: "acquisition.engine", id: "demo-engine" }] }));
    expect(await facets()).toContain("acquisition");
    expect(ctx.app.plugins.providers("acquisition.engine")).toEqual([{ pluginId: "demo.tool", id: "demo-engine", running: true, enabled: true }]);
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.tool" }));
    expect(await facets()).not.toContain("acquisition");
    expect(ctx.app.plugins.providers("acquisition.engine")).toEqual([]);
    ok(await run(ctx, "plugin.enable", { pluginId: "demo.tool" }));
    ok(await run(ctx, "settings.setModule", { featureId: "plugins", enabled: false }));
    expect(await facets()).not.toContain("acquisition");
  });

  it("notifies the interface when what is installed changes", async () => {
    const ctx = await boot();
    const seen: string[] = [];
    ctx.app.onNotice(({ topic, payload }) => { if (topic === "plugin.changed") seen.push(String(payload.change)); });
    ok(await install(ctx, { key: first }));
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.tool" }));
    expect(seen).toEqual(["install", "disabled"]);
  });
});

describe("uninstalling keeps what the plugin kept, until the person says otherwise", () => {
  async function installedWithData(ctx: App) {
    ok(await install(ctx, { key: first }));
    await call(ctx, "write", { name: "state.json", text: "{\"downloads\":3}" });
    await call(ctx, "write", { name: "notes.txt", text: "kept" });
  }

  it("removes the plugin and its process, keeps its data, and lists it as left behind", async () => {
    const ctx = await boot();
    await installedWithData(ctx);
    const pid = ctx.app.pluginRuntime.info("demo.tool").pid;
    expect(ok(await run(ctx, "plugin.uninstall", { pluginId: "demo.tool" }))).toMatchObject({ pluginId: "demo.tool", keptData: true });
    await until(() => alive(pid), (value) => !value);
    const listing = await list(ctx);
    expect(listing.plugins).toEqual([]);
    expect(listing.leftovers).toMatchObject([{ pluginId: "demo.tool", name: "演示插件" }]);
    expect(listing.leftovers[0]!.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(ctx.profileRoot, "data", "plugins", "demo.tool"))).toBe(false);
    expect(fs.existsSync(path.join(ctx.profileRoot, "data", "plugin-data", "demo.tool", "state.json"))).toBe(true);
    // Reinstalling finds it again, and it is no longer left behind.
    ok(await install(ctx, { key: first }));
    expect((await list(ctx)).leftovers).toEqual([]);
    expect(await view(ctx)).toMatchObject({ state: "running" });
  });

  it("exports what the plugin kept to a folder the person chose, installed or not", async () => {
    const ctx = await boot();
    await installedWithData(ctx);
    const out = tmpDir();
    const handle = ctx.app.registerPath("directory", out);
    const live = ok<{ fileName: string; files: number }>(await run(ctx, "plugin.exportData", { pluginId: "demo.tool", pathHandle: handle }));
    expect(live.files).toBe(2);
    ok(await run(ctx, "plugin.uninstall", { pluginId: "demo.tool" }));
    const left = ok<{ fileName: string; files: number }>(await run(ctx, "plugin.exportData", { pluginId: "demo.tool", pathHandle: handle }));
    expect(left.fileName).not.toBe(live.fileName);
    const unzipped = unzipSync(fs.readFileSync(path.join(out, left.fileName)));
    expect(Object.keys(unzipped).sort()).toEqual(["data/notes.txt", "data/state.json", "export.json"]);
    expect(Buffer.from(unzipped["data/state.json"]!).toString()).toBe("{\"downloads\":3}");
    expect(fails(await run(ctx, "plugin.exportData", { pluginId: "never.was", pathHandle: handle })).code).toBe("NOT_FOUND");
  });

  it("deletes what was kept only when the plugin is not running, and with the plugin when asked to", async () => {
    const ctx = await boot();
    await installedWithData(ctx);
    expect(fails(await run(ctx, "plugin.deleteData", { pluginId: "demo.tool" })).details?.reason).toBe("running");
    ok(await run(ctx, "plugin.uninstall", { pluginId: "demo.tool" }));
    ok(await run(ctx, "plugin.deleteData", { pluginId: "demo.tool" }));
    expect((await list(ctx)).leftovers).toEqual([]);
    expect(fs.existsSync(path.join(ctx.profileRoot, "data", "plugin-data", "demo.tool"))).toBe(false);
    expect(fails(await run(ctx, "plugin.deleteData", { pluginId: "demo.tool" })).code).toBe("NOT_FOUND");
    await installedWithData(ctx);
    expect(ok(await run(ctx, "plugin.uninstall", { pluginId: "demo.tool", deleteData: true }))).toMatchObject({ keptData: false });
    expect((await list(ctx)).leftovers).toEqual([]);
    expect(fs.existsSync(path.join(ctx.profileRoot, "data", "plugin-data", "demo.tool"))).toBe(false);
  });

  it("keeps nothing behind for a plugin that kept nothing", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first }));
    expect(ok(await run(ctx, "plugin.uninstall", { pluginId: "demo.tool" }))).toMatchObject({ keptData: false });
    expect((await list(ctx)).leftovers).toEqual([]);
  });
});

describe("the door a plugin asks the host through", () => {
  it("answers a request only when the person confirmed the permission it needs (AT-47)", async () => {
    const ctx = await boot();
    const seen: unknown[] = [];
    ctx.app.pluginRuntime.registerHostMethod("files.read", "files", (params, caller) => { seen.push({ params, caller }); return { ok: true }; });
    ctx.app.pluginRuntime.registerHostMethod("time", null, () => ({ now: 1 }));
    ok(await install(ctx, { key: first, permissions: [] }));
    expect(await call(ctx, "host", { method: "files.read", params: { a: 1 } })).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(await call(ctx, "host", { method: "time", params: {} })).toMatchObject({ ok: true, value: { now: 1 } });
    expect(await call(ctx, "host", { method: "no.such", params: {} })).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
    expect(seen).toEqual([]);
    ok(await install(ctx, { key: first, version: "1.1.0", permissions: ["files"] }));
    expect(await call(ctx, "host", { method: "files.read", params: { a: 1 } })).toMatchObject({ ok: true, value: { ok: true } });
    expect(seen).toEqual([{ params: { a: 1 }, caller: { pluginId: "demo.tool" } }]);
  });

  it("gives the plugin its own folder and none of the host's environment", async () => {
    process.env.MANGA_TEST_SECRET_FOR_PLUGIN = "must-not-reach-the-plugin";
    try {
      const ctx = await boot();
      ok(await install(ctx, { key: first }));
      const names = (await call(ctx, "env")) as string[];
      expect(names).toContain("MANGA_PLUGIN_ID");
      expect(names).toContain("MANGA_PLUGIN_DATA");
      expect(names).not.toContain("MANGA_TEST_SECRET_FOR_PLUGIN");
      expect(names).not.toContain("MANGA_TEST_LIBRARY_NOVEL");
      expect(names.some((name) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name))).toBe(false);
    } finally { delete process.env.MANGA_TEST_SECRET_FOR_PLUGIN; }
  });
});

describe("a plugin that misbehaves does not take the application with it", () => {
  it("ends a plugin that stops answering, and says why", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first, mode: "no-pong" }));
    const pid = ctx.app.pluginRuntime.info("demo.tool").pid;
    const item = await until(() => view(ctx), (value) => value.state !== "running", 6000);
    expect(item.error).toMatch(/stopped answering/);
    await until(() => alive(pid), (value) => !value);
    // The application itself carries on.
    expect(ok(await run(ctx, "plugin.list", {}))).toBeTruthy();
  });

  it("ends a plugin that floods the host with messages, and one that sends a message that is too large", async () => {
    const ctx = await boot(undefined, undefined, { pingMs: 5000, messagesPerSecond: 500 });
    ok(await install(ctx, { key: first, mode: "flood" }));
    expect((await until(() => view(ctx), (value) => Boolean(value.error), 6000)).error).toMatch(/more messages than it may/);
    ok(await install(ctx, { key: first, id: "demo.big", mode: "oversize" }));
    expect((await until(() => view(ctx, "demo.big"), (value) => Boolean(value.error), 6000)).error).toMatch(/too large/);
  });

  it("starts a plugin that ended by itself again a few times with a wait, then leaves it stopped with the reason", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first, mode: "exit-after-ready" }));
    const item = await until(() => view(ctx), (value) => Boolean(value.error?.includes("left stopped")), 8000);
    expect(item.state).toBe("failed");
    expect(item.error).toMatch(/ended by itself/);
    expect(ctx.app.pluginRuntime.info("demo.tool").state).toBe("failed");
  });

  it("does not wait for a plugin that never says it is ready", async () => {
    const ctx = await boot();
    const started = Date.now();
    const result = ok<{ enabled: boolean; error: string | null }>(await install(ctx, { key: first, mode: "never-ready" }));
    expect(Date.now() - started).toBeLessThan(LIMITS.readyMs + 2500);
    expect(result).toMatchObject({ enabled: false });
    expect(result.error).toMatch(/ready/);
    expect(ctx.app.pluginRuntime.info("demo.tool").pid).toBeNull();
  });

  it("answers a call with an error when the plugin stops before it answers", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first }));
    const pending = call(ctx, "no-such-method");
    await expect(pending).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const slow = ctx.app.pluginRuntime.call("demo.tool", "echo", {}, { timeoutMs: 1000 });
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.tool" }));
    await slow.catch(() => undefined);
    await expect(call(ctx, "echo")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("the packages that come with the application", () => {
  it("offers a signed package for installation without installing it, and installs it by its id", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "demo-tool.manga-plugin"), packageBytes({ key: first, version: "2.3.4" }));
    fs.writeFileSync(path.join(dir, "forged.manga-plugin"), packageBytes({ key: stranger, id: "forged.tool" }));
    fs.writeFileSync(path.join(dir, "broken.manga-plugin"), "nothing");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a package");
    const ctx = await boot(undefined, dir);
    const offered = ok<{ bundled: Array<{ id: string; installed: boolean; trust: string; version: string }> }>(await run(ctx, "plugin.bundled", {})).bundled;
    expect(offered).toMatchObject([{ id: "demo.tool", installed: false, trust: "first-party", version: "2.3.4" }]);
    expect((await list(ctx)).plugins).toEqual([]);
    ok(await run(ctx, "plugin.install", { bundledId: "demo.tool", grant: [] }));
    expect(await view(ctx)).toMatchObject({ version: "2.3.4", state: "running" });
    expect(ok<{ bundled: Array<{ installed: boolean }> }>(await run(ctx, "plugin.bundled", {})).bundled[0]!.installed).toBe(true);
    expect(fails(await run(ctx, "plugin.install", { bundledId: "forged.tool", grant: [] })).code).toBe("NOT_FOUND");
  });

  it("offers nothing when the application carries no plugins", async () => {
    const ctx = await boot();
    expect(ok<{ bundled: unknown[] }>(await run(ctx, "plugin.bundled", {})).bundled).toEqual([]);
  });
});

describe("the operation log and the half-written install", () => {
  it("records plugin changes by the plugin's name and never the paths of the files", async () => {
    const ctx = await boot();
    ok(await install(ctx, { key: first }));
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.tool" }));
    ok(await run(ctx, "plugin.uninstall", { pluginId: "demo.tool" }));
    const rows = ctx.app.store.sqlite.prepare("SELECT action, category, object_kind AS kind, object_id AS id, object_label AS label FROM operation_log WHERE category = 'plugins' ORDER BY id").all();
    expect(rows).toEqual([
      { action: "plugin.install", category: "plugins", kind: "plugin", id: "demo.tool", label: "演示插件" },
      { action: "plugin.disable", category: "plugins", kind: "plugin", id: "demo.tool", label: "演示插件" },
      { action: "plugin.uninstall", category: "plugins", kind: "plugin", id: "demo.tool", label: "演示插件" },
    ]);
    // What an uninstalled plugin left is still named by the plugin it came from.
    ok(await install(ctx, { key: first }));
    await call(ctx, "write", { name: "a.txt", text: "kept" });
    ok(await run(ctx, "plugin.uninstall", { pluginId: "demo.tool" }));
    ok(await run(ctx, "plugin.deleteData", { pluginId: "demo.tool" }));
    expect(ctx.app.store.sqlite.prepare("SELECT object_label AS label FROM operation_log WHERE action = 'plugin.deleteData'").get()).toEqual({ label: "演示插件" });
    expect(JSON.stringify(ctx.app.store.sqlite.prepare("SELECT * FROM operation_log").all())).not.toContain(ctx.profileRoot.replace(/\\/g, "\\\\"));
  });

  it("discards a package that was half unpacked when the application ended", async () => {
    const ctx = await boot();
    const staging = path.join(ctx.profileRoot, "data", "plugins", ".staging", "demo.tool-1.0.0-dead");
    fs.mkdirSync(path.join(staging, "payload"), { recursive: true });
    fs.writeFileSync(path.join(staging, "payload", "main.mjs"), "x");
    ctx.app.close();
    const again = await boot(ctx);
    expect(fs.existsSync(staging)).toBe(false);
    expect((await list(again)).plugins).toEqual([]);
  });
});
