import fs from "node:fs";
import path from "node:path";
import type { AcquisitionOptions } from "../../packages/app-core/src/acquisition/service.ts";
import type { AcquisitionJobView } from "../../packages/app-core/src/acquisition/service.ts";
import { startApp, tempProfile } from "./app.ts";
import { FAKE_ENGINE_ID, fakeEngineScript } from "./fake-engine.ts";
import { makeKey, packageBytes, tmpDir } from "./plugin-fixtures.ts";

export type Rig = Awaited<ReturnType<typeof startApp>> & { n: { value: number } };
type Call = Awaited<ReturnType<Rig["app"]["call"]>>;

/** The key the tests sign with; the application is told to trust it as it trusts the first party's. */
export const testKey = makeKey("MANGA（第一方，测试）");
export const LOOPBACK = { dht: false, lsd: false, natUpnp: false, natPmp: false } as const;

export async function boot(options: { profileRoot?: string; acquisition?: Partial<NonNullable<AcquisitionOptions>>; limits?: Record<string, number> } = {}): Promise<Rig> {
  const ctx = await startApp({
    profileRoot: options.profileRoot ?? tempProfile(),
    options: {
      appVersion: "0.1.0",
      plugins: { firstPartyKeys: [{ publicKey: testKey.publicKey, label: testKey.label }], limits: { readyMs: 15_000, pingMs: 5000, graceMs: 800, callMs: 30_000, ...options.limits } },
      acquisition: { network: LOOPBACK, progressNoticeMs: 20, progressPersistMs: 100, ...options.acquisition } as never,
    },
  });
  return Object.assign(ctx, { n: { value: 0 } });
}

export async function run(ctx: Rig, commandId: string, input: Record<string, unknown>): Promise<Call> {
  ctx.n.value += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `acq-${ctx.n.value}-${Math.random().toString(36).slice(2, 8)}`, input }, ctx.grant.handle);
}
/** The value of a command that succeeded; anything else is an error carrying what the host said. */
export function ok<T = Record<string, any>>(result: Call): T {
  if (result.status !== "ok") throw new Error(`the command failed: ${JSON.stringify(result)}`);
  return result.value as T;
}
let btFile: Promise<string> | null = null;
/** The BitTorrent plugin, built from its source and signed with the test key, once per test process. */
export function btPackage(): Promise<string> {
  // Loaded when needed: the bundler cannot run in the DOM test environment, which only uses the fake engine.
  btFile ??= import("../../scripts/desktop-plugins.ts").then(({ packPlugin }) => packPlugin(path.resolve(import.meta.dirname, "../../plugins/acquisition-bt"), { out: tmpDir(), privateKeyPem: testKey.privateKeyPem })).then((built) => built.file);
  return btFile;
}

/** The fake engine, signed with the test key; a different version gives a different resume format. */
export function fakePackage(version = "1.0.0"): string {
  const file = path.join(tmpDir(), `fake-${version}.manga-plugin`);
  fs.writeFileSync(file, packageBytes({
    key: testKey, id: FAKE_ENGINE_ID, version, permissions: ["files"], provides: [{ slot: "acquisition.engine", id: "bittorrent" }], facets: ["acquisition"],
    files: { "main.mjs": fakeEngineScript(version) },
  }));
  return file;
}

export async function installPlugin(ctx: Rig, file: string, grant: string[]): Promise<void> {
  ok(await run(ctx, "plugin.install", { pathHandle: ctx.app.registerPath("file", file), grant }));
}
export const installBt = async (ctx: Rig) => installPlugin(ctx, await btPackage(), ["network", "files"]);
export const installFake = (ctx: Rig, version = "1.0.0") => installPlugin(ctx, fakePackage(version), ["files"]);

/** A library path of the kind given, in a fresh folder; returns the folder and the path's id. */
export async function addLibrary(ctx: Rig, kind: "novel" | "comic" | "video" = "novel", dir = tmpDir()): Promise<{ dir: string; pathId: string }> {
  const added = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", dir), mediaKind: kind, autoScan: false }));
  await ctx.app.scan.whenIdle();
  return { dir, pathId: added.path.id };
}

export async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, ms = 30_000, what = "the condition"): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > ms) throw new Error(`gave up waiting for ${what}; last: ${JSON.stringify(value).slice(0, 1500)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export const jobOf = async (ctx: Rig, jobId: string): Promise<AcquisitionJobView> => ok<{ job: AcquisitionJobView }>(await run(ctx, "acquisition.get", { jobId })).job;
export const waitState = async (ctx: Rig, jobId: string, states: string[], ms = 30_000): Promise<AcquisitionJobView> =>
  until(() => jobOf(ctx, jobId), (job) => states.includes(job.state), ms, `job ${jobId} to be ${states.join("/")}`);

export const engineLog = async (ctx: Rig): Promise<Array<{ method: string; params: Record<string, any> }>> => (await ctx.app.pluginRuntime.call(FAKE_ENGINE_ID, "fake.log", {}, { timeoutMs: 5000 })) as never;
export const emit = (ctx: Rig, name: string, payload: Record<string, unknown>) => ctx.app.pluginRuntime.call(FAKE_ENGINE_ID, "fake.emit", { name, payload }, { timeoutMs: 5000 });

export const MAGNET = (hash: string) => `magnet:?xt=urn:btih:${hash}&dn=demo&tr=${encodeURIComponent("http://tracker.example.invalid:6969/announce?passkey=SECRETKEY123")}`;
export const HASH = (n: number) => String(n).padStart(40, "a");

/** Writes a staged file where the host expects the engine to have put it. */
export function stage(ctx: Rig, jobId: string, rel: string, body: string | Buffer): string {
  const file = path.join(ctx.app.acquisition.stagingOf(jobId), "data", ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
