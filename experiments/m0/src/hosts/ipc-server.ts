import { createInterface } from "node:readline";
import { MangaApp } from "../application/app.ts";

export async function serveIpc(profileDir: string, hostId = "ipc-host"): Promise<void> {
  const app = new MangaApp({ profileDir, hostId, useParseWorker: process.env.M0_PARSE_WORKER === "1" });
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const unsubscribe=app.store.onEvent(event=>send({type:"event",seq:event.seq,event}));
  await app.start();
  const lastSeq=()=>Number(app.store.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM domain_events").get()?.seq ?? 0);
  send({ type: "hello", seq: lastSeq() });
  const rl = createInterface({ input: process.stdin });
  const active = new Map<string, Promise<void>>();
  let closing = false;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message: { type: string; id: string; requestId?: string; payload?: unknown };
    try {
      message = JSON.parse(line);
      if (!message || typeof message.id !== "string" || !message.id || typeof message.type !== "string") throw new Error("invalid message");
    } catch {
      send({ type: "error", error: { code: "VALIDATION_ERROR", message: "malformed IPC message" } });
      continue;
    }
    const { id } = message;
    if (message.type === "cancel") {
      send({ type: "result", id, value: { cancelled: app.runtime.gateway.cancel(message.requestId ?? id) } });
    } else if (message.type === "snapshot") {
      send({ type: "snapshot", id, seq: lastSeq(), value: {...app.runtime.snapshot(),workspace:app.workspaceSnapshot(),lastEventSeq:lastSeq()} });
    } else if (message.type === "shutdown") {
      closing = true;
      for (const requestId of active.keys()) app.runtime.gateway.cancel(requestId);
      await Promise.allSettled(active.values());
      send({ type: "result", id, value: { ok: true } });
      break;
    } else if (message.type === "command" && !closing && !active.has(id)) {
      // The pipe is a trusted host boundary. Payloads cannot select their actor.
      const work = app.call({ kind: "user", id: hostId }, message.payload, id).then(value => { send({ type: "result", id, value }); }).finally(() => active.delete(id));
      active.set(id, work);
    } else {
      send({ type: "result", id, value: { status: "error", error: { code: "VALIDATION_ERROR", message: "unknown IPC request" } } });
    }
  }
  for (const requestId of active.keys()) app.runtime.gateway.cancel(requestId);
  await Promise.allSettled(active.values());
  unsubscribe();
  app.close();
}

if (process.argv[1]?.endsWith("ipc-server.ts")) {
  const profile = process.argv[process.argv.indexOf("--profile") + 1];
  if (!process.argv.includes("--profile") || !profile) throw new Error("missing --profile");
  serveIpc(profile).catch(error => { console.error(error); process.exitCode = 1; });
}
