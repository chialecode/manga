import fs from "node:fs";
import path from "node:path";
import { PluginRuntime } from "../../packages/app-core/src/plugins/runtime.ts";
import { nodeSpawner } from "../../packages/app-core/src/plugins/spawn-node.ts";
import { bundlePlugin } from "../../scripts/desktop-plugins.ts";
import { tmpDir } from "./plugin-fixtures.ts";

let bundled: Promise<string> | null = null;
/** The BitTorrent plugin's entry, bundled once per test process into a folder of its own. */
export function btEntry(): Promise<string> {
  bundled ??= (async () => {
    const { code, out } = await bundlePlugin(path.resolve(import.meta.dirname, "../../plugins/acquisition-bt"));
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, out), code);
    return path.join(dir, out);
  })();
  return bundled;
}

export type Event = { name: string; payload: Record<string, any> };

/** The engine on its own: a real plugin process, the calls the host makes, and every event it sent. */
export async function startEngine(limits: ConstructorParameters<typeof PluginRuntime>[0]["limits"] = {}) {
  const entry = await btEntry();
  const runtime = new PluginRuntime({ spawn: nodeSpawner, limits: { readyMs: 15_000, ...limits } });
  const events: Event[] = [];
  runtime.onEvent((_id, name, payload) => events.push({ name, payload: payload as Record<string, any> }));
  const data = tmpDir();
  await runtime.start({ pluginId: "manga.acquisition-bt", entry, cwd: path.dirname(entry), dataDir: data, granted: ["network", "files"] });
  const call = <T = any>(method: string, params: Record<string, unknown> = {}) => runtime.call("manga.acquisition-bt", method, params, { timeoutMs: 30_000 }) as Promise<T>;
  await call("engine.configure", { dht: false, lsd: false, natUpnp: false, natPmp: false });
  return {
    runtime, events, call,
    of: (jobId: string) => events.filter((event) => event.payload.jobId === jobId),
    async wait(jobId: string, name: string, ms = 20_000) {
      const started = Date.now();
      for (;;) {
        const hit = events.find((event) => event.name === name && event.payload.jobId === jobId);
        if (hit) return hit.payload;
        const failed = events.find((event) => event.name === "acq.error" && event.payload.jobId === jobId);
        if (failed && name !== "acq.error") throw new Error(`job ended with an error while waiting for ${name}: ${JSON.stringify(failed.payload)}`);
        if (Date.now() - started > ms) throw new Error(`gave up waiting for ${name} of ${jobId}; saw ${events.map((event) => event.name).join(", ")}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close: () => runtime.shutdown(),
  };
}
export type Engine = Awaited<ReturnType<typeof startEngine>>;
