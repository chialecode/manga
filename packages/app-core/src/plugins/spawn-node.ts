import { fork } from "node:child_process";
import type { PluginChannel, PluginSpawner } from "./runtime.ts";

/** The environment variables a plugin's process gets from the host: what a process needs to start and use the network on this system, and nothing of the host's own, which may hold keys. */
const PASS_THROUGH = ["SystemRoot", "windir", "TEMP", "TMP", "TMPDIR", "LANG"];

/**
 * Starts a plugin as a Node process connected by messages. The desktop application starts plugins as Electron utility processes instead and
 * gives the runtime that spawner; this one is for hosts that run on plain Node, and for tests.
 */
export const nodeSpawner: PluginSpawner = (spec) => {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH) if (process.env[name]) env[name] = process.env[name]!;
  Object.assign(env, spec.env);
  const child = fork(spec.entry, [], { cwd: spec.cwd, env, execArgv: [], serialization: "json", stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-4096); });
  const channel: PluginChannel = {
    get pid() { return child.pid; },
    send: (message) => { if (!child.connected) throw new Error("the plugin is not connected"); child.send(message as never); },
    onMessage: (listener) => { child.on("message", listener); },
    onExit: (listener) => { child.on("exit", (code, signal) => listener(code, signal)); child.on("error", () => listener(null, "error")); },
    kill: () => { child.kill(); },
    stderrTail: () => tail,
  };
  return channel;
};
