import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginManifest, PluginPermission } from "@manga/contracts";
import { buildPluginPackage, rawPublicKey } from "../../packages/app-core/src/plugins/package.ts";

/** A signing key for tests: the private half as the text the signing tool reads, the public half as publishers hand it out. */
export type TestKey = { privateKeyPem: string; publicKey: string; label: string };

export function makeKey(label = "测试发布者"): TestKey {
  const pair = generateKeyPairSync("ed25519");
  const exported = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }).toString();
  return { privateKeyPem: exported(pair.privateKey), publicKey: rawPublicKey(pair.publicKey).toString("base64"), label };
}

export type Mode = "ok" | "crash-start" | "never-ready" | "no-pong" | "exit-after-ready" | "flood" | "oversize" | "ignore-stop";

/**
 * A plugin's entry script for tests: a real process that speaks the host's protocol, with one behaviour chosen by `mode`. Calls it answers:
 * `echo` returns its parameters, `version` its own version, `host` makes a request of the host and reports what came back, `write` writes a file
 * into its data folder, `env` lists the names of the environment variables it was given.
 */
export function entryScript(mode: Mode, version = "1.0.0"): string {
  return `
const MODE = ${JSON.stringify(mode)};
const VERSION = ${JSON.stringify(version)};
import fs from "node:fs";
import path from "node:path";
const send = (message) => process.send(message);
let seq = 1;
const waiting = new Map();
const hostCall = (method, params) => new Promise((resolve) => { const id = seq++; waiting.set(id, resolve); send({ t: "host", id, method, params }); });
process.on("message", async (m) => {
  if (m.t === "init") {
    if (MODE === "crash-start") process.exit(3);
    if (MODE === "never-ready") return;
    send({ t: "ready" });
    if (MODE === "exit-after-ready") setTimeout(() => process.exit(1), 30);
    if (MODE === "flood") setTimeout(() => { for (let i = 0; i < 30000; i += 1) send({ t: "event", name: "tick", payload: i }); }, 30);
    if (MODE === "oversize") setTimeout(() => send({ t: "event", name: "big", payload: "x".repeat(5 * 1024 * 1024) }), 30);
  } else if (m.t === "ping") {
    if (MODE !== "no-pong") send({ t: "pong", id: m.id });
  } else if (m.t === "reply") {
    const resolve = waiting.get(m.id); waiting.delete(m.id); if (resolve) resolve(m);
  } else if (m.t === "stop") {
    if (MODE !== "ignore-stop") process.exit(0);
  } else if (m.t === "call") {
    const ok = (value) => send({ t: "result", id: m.id, ok: true, value });
    if (m.method === "echo") ok(m.params);
    else if (m.method === "version") ok(VERSION);
    else if (m.method === "host") ok(await hostCall(m.params.method, m.params.params));
    else if (m.method === "write") { fs.writeFileSync(path.join(process.env.MANGA_PLUGIN_DATA, m.params.name), m.params.text); ok(true); }
    else if (m.method === "env") ok(Object.keys(process.env).sort());
    else send({ t: "result", id: m.id, ok: false, error: { code: "NO_METHOD", message: "no such method" } });
  }
});
`;
}

export type FixtureOptions = {
  id?: string;
  version?: string;
  mode?: Mode;
  permissions?: PluginPermission[];
  /** null makes a package that declares what it provides without running anything. */
  entry?: string | null;
  host?: PluginManifest["host"];
  provides?: PluginManifest["provides"];
  facets?: PluginManifest["facets"];
  files?: Record<string, string | Uint8Array>;
  key: TestKey;
  signedAt?: string;
  publisher?: { id: string; name: string };
};

export function manifestOf(options: FixtureOptions): PluginManifest {
  return {
    format: "manga-plugin-v1", id: options.id ?? "demo.tool", name: "演示插件", version: options.version ?? "1.0.0",
    publisher: options.publisher ?? { id: "demo", name: "演示发布者" }, description: "只用于测试的插件",
    host: options.host ?? { min: "0.0.0" }, permissions: options.permissions ?? [],
    entry: options.entry === undefined ? "main.mjs" : options.entry, provides: options.provides ?? [], facets: options.facets ?? [],
  };
}

export function packageBytes(options: FixtureOptions): Buffer {
  const manifest = manifestOf(options);
  const files: Record<string, string | Uint8Array> = { ...(manifest.entry ? { [manifest.entry]: entryScript(options.mode ?? "ok", options.version ?? "1.0.0") } : {}), ...options.files };
  return buildPluginPackage({ manifest, files, privateKeyPem: options.key.privateKeyPem, signedAt: options.signedAt });
}

let dirs = 0;
export function tmpDir(): string {
  dirs += 1;
  return mkdtempSync(path.join(os.tmpdir(), `manga-plugin-${dirs}-`));
}

/** Writes a package into a fresh folder and returns its path. */
export function writePackage(options: FixtureOptions, name = "pkg.manga-plugin"): string {
  const file = path.join(tmpDir(), name);
  writeFileSync(file, packageBytes(options));
  return file;
}
