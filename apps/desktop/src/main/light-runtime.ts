import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * How an installer asks light open to leave (4.6). Light open writes `light-instance.json` into its own `runtime` folder while it runs and watches
 * for `quit-request.json` there; it then has every window remember its place and exits. Whoever is about to run an installer (`stage install-dev`,
 * the release's "restart to update" and install on quit) writes the request and waits for the process to be gone, ten seconds at most. Node only:
 * the full application, light open and the stage scripts all use it.
 */
export const LIGHT_QUIT_WAIT_MS = 10_000;
export const LIGHT_INSTANCE_FILE = "light-instance.json";
export const LIGHT_QUIT_REQUEST_FILE = "quit-request.json";
export const LIGHT_QUIT_ACK_FILE = "quit-ack.json";

export type LightInstance = { pid: number; execPath: string; channel: string; testIdentity: boolean; startedAt: string };
export type LightQuitRequest = { id: string; requestedAt: string; reason: "update" };
export type LightQuitOutcome = { ok: true; running: boolean; waitedMs: number } | { ok: false; reason: "light-open-running"; waitedMs: number; pid: number };

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function readLightInstance(runtimeDir: string): LightInstance | null {
  try {
    const body = JSON.parse(fs.readFileSync(path.join(runtimeDir, LIGHT_INSTANCE_FILE), "utf8")) as Partial<LightInstance>;
    return typeof body.pid === "number" && typeof body.execPath === "string" ? body as LightInstance : null;
  } catch {
    return null;
  }
}

export function writeLightInstance(runtimeDir: string, instance: LightInstance): void {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const file = path.join(runtimeDir, LIGHT_INSTANCE_FILE);
  fs.writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(instance, null, 2)}\n`);
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
}

export function clearLightInstance(runtimeDir: string, pid = process.pid): void {
  const current = readLightInstance(runtimeDir);
  if (current && current.pid !== pid) return;
  for (const name of [LIGHT_INSTANCE_FILE, LIGHT_QUIT_REQUEST_FILE]) {
    try { fs.rmSync(path.join(runtimeDir, name), { force: true }); } catch { /* best effort */ }
  }
}

export function readQuitRequest(runtimeDir: string): LightQuitRequest | null {
  try {
    const body = JSON.parse(fs.readFileSync(path.join(runtimeDir, LIGHT_QUIT_REQUEST_FILE), "utf8")) as Partial<LightQuitRequest>;
    return typeof body.id === "string" ? body as LightQuitRequest : null;
  } catch {
    return null;
  }
}

export function answerQuitRequest(runtimeDir: string, request: LightQuitRequest, status: "leaving" | "refused"): void {
  try {
    fs.writeFileSync(path.join(runtimeDir, LIGHT_QUIT_ACK_FILE), `${JSON.stringify({ id: request.id, pid: process.pid, status, at: new Date().toISOString() })}\n`);
  } catch { /* the requester also watches the process itself */ }
}

function readAck(runtimeDir: string): { id?: string; status?: string } | null {
  try { return JSON.parse(fs.readFileSync(path.join(runtimeDir, LIGHT_QUIT_ACK_FILE), "utf8")) as { id?: string; status?: string }; } catch { return null; }
}

/**
 * Ask a running light open to remember its places and leave, and wait for its process to end. Nothing running (or a marker left by a process that
 * is gone) is a plain yes. A process still there after `timeoutMs` is a no: the caller does not run the installer and says why.
 */
export async function askLightToQuit(runtimeDir: string, options: { timeoutMs?: number; alive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void> } = {}): Promise<LightQuitOutcome> {
  const alive = options.alive ?? pidAlive;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? LIGHT_QUIT_WAIT_MS;
  const instance = readLightInstance(runtimeDir);
  if (!instance || !alive(instance.pid)) {
    if (instance) clearLightInstance(runtimeDir, instance.pid);
    return { ok: true, running: false, waitedMs: 0 };
  }
  const request: LightQuitRequest = { id: randomUUID(), requestedAt: new Date().toISOString(), reason: "update" };
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, LIGHT_QUIT_REQUEST_FILE), `${JSON.stringify(request)}\n`);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!alive(instance.pid)) return { ok: true, running: true, waitedMs: Date.now() - started };
    // A light open that said it will not leave (a test identity's switch) is not waited for.
    if (readAck(runtimeDir)?.id === request.id && readAck(runtimeDir)?.status === "refused") break;
    await sleep(100);
  }
  if (!alive(instance.pid)) return { ok: true, running: true, waitedMs: Date.now() - started };
  // A request nobody answered is taken back, so a light open that frees itself later does not leave for an install that is not going to happen.
  try {
    if (readQuitRequest(runtimeDir)?.id === request.id) fs.rmSync(path.join(runtimeDir, LIGHT_QUIT_REQUEST_FILE), { force: true });
  } catch { /* best effort */ }
  return { ok: false, reason: "light-open-running", waitedMs: Date.now() - started, pid: instance.pid };
}
