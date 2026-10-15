/**
 * The plugin's end of the link to the host. The host starts a plugin as an Electron utility process (messages arrive on `process.parentPort`) or,
 * in tests and tools, as a Node process (`process.send`). Either way the messages are the same:
 * host to plugin: `init`, `call`, `reply`, `ping`, `stop`; plugin to host: `ready`, `result`, `host`, `event`, `pong`.
 */
const port = process.parentPort ?? null;
const post = (message) => { if (port) port.postMessage(message); else process.send?.(message); };
const listen = (handler) => { if (port) port.on("message", (event) => handler(event.data)); else process.on("message", handler); };

export function connect({ init, methods, stop }) {
  let seq = 1;
  const waiting = new Map();
  const hostCall = (method, params) => new Promise((resolve, reject) => {
    const id = seq++;
    waiting.set(id, { resolve, reject });
    post({ t: "host", id, method, params });
  });
  const event = (name, payload) => post({ t: "event", name, payload });
  const answer = (id, ok, value, error) => post({ t: "result", id, ok, ...(ok ? { value } : { error }) });

  listen(async (message) => {
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "init":
        try { await init({ pluginId: message.pluginId, dataDir: message.dataDir, granted: message.granted, event, hostCall }); post({ t: "ready" }); } catch (error) {
          console.error(error instanceof Error ? error.stack ?? error.message : String(error));
          process.exit(2);
        }
        break;
      case "ping": post({ t: "pong", id: message.id }); break;
      case "reply": {
        const pending = waiting.get(message.id);
        if (!pending) break;
        waiting.delete(message.id);
        if (message.ok) pending.resolve(message.value); else pending.reject(Object.assign(new Error(message.error?.message ?? "the host refused"), { code: message.error?.code }));
        break;
      }
      case "stop":
        try { await stop(); } finally { process.exit(0); }
        break;
      case "call": {
        const handler = methods[message.method];
        if (!handler) { answer(message.id, false, undefined, { code: "NO_METHOD", message: `no such method: ${String(message.method).slice(0, 60)}` }); break; }
        try { answer(message.id, true, await handler(message.params ?? {})); } catch (error) {
          answer(message.id, false, undefined, { code: typeof error?.code === "string" ? error.code : "FAILED", message: String(error?.message ?? error).slice(0, 500) });
        }
        break;
      }
      default: break;
    }
  });
}
