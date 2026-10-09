import { utilityProcess } from "electron";
import type { PluginChannel, PluginSpawner } from "@manga/app-core";

/** The environment variables a plugin's process gets from the application: what a process needs to start on this system, and nothing of the application's own, which may hold keys. */
const PASS_THROUGH = ["SystemRoot", "windir", "TEMP", "TMP", "TMPDIR", "LANG"];

/**
 * Starts a plugin as an Electron utility process: a process of its own, with no window, that talks to the application by messages. A process
 * is a fault boundary, not a sandbox (it can crash, hang or flood without taking the application down, but the operating system does not
 * confine it), which is why only plugins from a publisher the person trusts are started.
 */
export const utilitySpawner: PluginSpawner = (spec) => {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH) if (process.env[name]) env[name] = process.env[name]!;
  Object.assign(env, spec.env);
  const child = utilityProcess.fork(spec.entry, [], { cwd: spec.cwd, env, serviceName: `MANGA plugin ${spec.pluginId}`, stdio: ["ignore", "ignore", "pipe"] });
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-4096); });
  const channel: PluginChannel = {
    get pid() { return child.pid; },
    send: (message) => { child.postMessage(message); },
    onMessage: (listener) => { child.on("message", listener); },
    onExit: (listener) => { child.on("exit", (code) => listener(code, null)); },
    kill: () => { child.kill(); },
    stderrTail: () => tail,
  };
  return channel;
};
