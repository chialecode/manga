/**
 * A download engine that does nothing but what the test tells it: a real plugin process that provides the `acquisition.engine` slot, records every call the
 * host makes of it, and sends the events the test asks for (`fake.emit`). With it the host's side of a download (what it accepts, what it writes, what it
 * does after a crash or when the engine goes away) is tested exactly, without a network.
 */
export const FAKE_ENGINE_ID = "demo.engine";

export function fakeEngineScript(version: string): string {
  return `
import fs from "node:fs";
import crypto from "node:crypto";
const VERSION = ${JSON.stringify(version)};
const FORMAT = "fake-v" + VERSION.split(".")[0];
const send = (message) => process.send(message);
const log = [];
const jobs = new Map();
const hashOf = (params) => {
  const m = /xt=urn:btih:([0-9a-fA-F]{40})/.exec(String(params.magnet ?? ""));
  if (m) return m[1].toLowerCase();
  if (params.torrentPath) return crypto.createHash("sha1").update(fs.readFileSync(params.torrentPath)).digest("hex");
  return "0".repeat(40);
};
const methods = {
  "engine.configure": (p) => { log.push({ method: "engine.configure", params: p }); return { ok: true }; },
  "engine.info": () => ({ engine: "fake", resumeFormat: FORMAT, version: VERSION }),
  "engine.limits": (p) => { log.push({ method: "engine.limits", params: p }); return { ok: true }; },
  "engine.add": (p) => {
    if (String(p.magnet ?? "").startsWith("magnet:?xt=urn:btih:" + "bad".padEnd(40, "0"))) throw new Error("this is not a magnet link");
    if (jobs.has(p.jobId)) throw new Error("that job is already running");
    jobs.set(p.jobId, p);
    log.push({ method: "engine.add", params: { jobId: p.jobId, dir: p.dir, stateDir: p.stateDir, selected: p.selected, source: p.magnet ? "magnet" : "torrent" } });
    return { infoHash: hashOf(p) };
  },
  "engine.select": (p) => { log.push({ method: "engine.select", params: p }); return { ok: true }; },
  "engine.remove": (p) => {
    log.push({ method: "engine.remove", params: p });
    const job = jobs.get(p.jobId);
    jobs.delete(p.jobId);
    if (job && p.deleteFiles) fs.rmSync(job.dir, { recursive: true, force: true });
    return { ok: true };
  },
  "engine.seed": (p) => { log.push({ method: "engine.seed", params: p }); if (jobs.has(p.jobId)) throw new Error("that job is already running"); jobs.set(p.jobId, p); return { infoHash: "0".repeat(40) }; },
  "engine.status": () => ({ jobs: [...jobs.keys()].map((jobId) => ({ jobId })) }),
  // The real engine lets go of a job before it says the job is verified, failed or has stopped sharing.
  "fake.emit": (p) => { if (["acq.verified", "acq.error", "acq.seedStopped"].includes(p.name)) jobs.delete(p.payload.jobId); send({ t: "event", name: p.name, payload: p.payload }); return true; },
  "fake.log": () => log,
  "fake.reset": () => { log.length = 0; return true; },
};
process.on("message", async (m) => {
  if (m.t === "init") send({ t: "ready" });
  else if (m.t === "ping") send({ t: "pong", id: m.id });
  else if (m.t === "stop") process.exit(0);
  else if (m.t === "call") {
    const handler = methods[m.method];
    if (!handler) { send({ t: "result", id: m.id, ok: false, error: { code: "NO_METHOD", message: "no such method" } }); return; }
    try { send({ t: "result", id: m.id, ok: true, value: await handler(m.params ?? {}) }); } catch (error) { send({ t: "result", id: m.id, ok: false, error: { code: "FAILED", message: String(error.message) } }); }
  }
});
`;
}
