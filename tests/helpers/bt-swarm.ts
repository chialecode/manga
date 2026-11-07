import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const stubs = path.join(repo, "plugins/acquisition-bt/stubs/register-stub.mjs");

export type SeedSpec = {
  id: string;
  /** The folder the seed's files are made under. */
  root: string;
  /** The torrent's name: the folder of a multi-file torrent, the file of a single-file one. */
  name: string;
  /** `text` makes a file with exactly that content (something the library can read); `bytes` makes that many deterministic bytes. */
  files: Array<{ path: string; bytes: number } | { path: string; text: string }>;
  pieceLength?: number;
  /** Flips one byte of a file after the torrent is made, so this seed serves a piece that fails its hash. */
  corrupt?: { file: string; offset: number };
};
export type Seeded = { infoHash: string; magnet: string; torrentFile: string; files: Array<{ path: string; length: number; sha256: string }>; totalLength: number; pieceLength: number };

/** A tracker and seeds on 127.0.0.1 in a process of their own (nothing reaches a public tracker, the DHT or the LAN). */
export type Swarm = {
  seed(spec: SeedSpec): Promise<Seeded>;
  stopSeed(id: string): Promise<void>;
  stats(id: string): Promise<{ uploaded: number; peers: number; uploadSpeed: number } | null>;
  throttle(kbps: number): Promise<void>;
  leech(magnet: string, dir: string): Promise<{ downloaded: number }>;
  announce: string;
  close(): Promise<void>;
};

export async function startSwarm(): Promise<Swarm> {
  const child: ChildProcess = fork(path.join(here, "bt-swarm.mjs"), [], { execArgv: ["--import", pathToFileURL(stubs).href], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let next = 1;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.on("message", (message: { ready?: boolean; id?: number; ok?: boolean; value?: unknown; error?: string }) => {
      if (message.ready) { resolve(); return; }
      const pending = typeof message.id === "number" ? waiting.get(message.id) : undefined;
      if (!pending) return;
      waiting.delete(message.id!);
      if (message.ok) pending.resolve(message.value); else pending.reject(new Error(message.error));
    });
    child.once("exit", (code) => { for (const pending of waiting.values()) pending.reject(new Error(`the swarm ended (${code})`)); waiting.clear(); });
  });
  const call = <T>(cmd: string, params: Record<string, unknown> = {}): Promise<T> => new Promise<T>((resolve, reject) => { const id = next++; waiting.set(id, { resolve, reject }); child.send({ id, cmd, params }); });
  const { announce } = await call<{ announce: string }>("start");
  return {
    announce,
    seed: (spec) => call<Seeded>("seed", spec),
    stopSeed: async (id) => { await call("stopSeed", { id }); },
    stats: (id) => call("stats", { id }),
    throttle: async (kbps) => { await call("throttle", { kbps }); },
    leech: (magnet, dir) => call("leech", { magnet, dir }),
    // The swarm holds nothing that needs to be written out, so it is ended outright: asking it to exit trips a libuv assertion on Windows.
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await gone;
    },
  };
}
