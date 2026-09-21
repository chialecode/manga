import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type IpcClient = {
  send: (value: unknown) => Promise<unknown>;
  cancel: (id: string) => Promise<unknown>;
  snapshot: () => Promise<unknown>;
  close: () => Promise<void>;
  child: ChildProcessWithoutNullStreams;
};

export function startIpcClient(profileDir: string): IpcClient {
  const server = fileURLToPath(new URL("./ipc-server.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", server, "--profile", profileDir], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.."),
    env: { ...process.env },
  });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("IPC host stopped")); }
    pending.clear();
  };
  child.on("exit", fail);
  child.on("error", fail);
  child.stderr.resume();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try {
      const message = JSON.parse(line) as { type: string; id?: string; value?: unknown };
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id)!;
        clearTimeout(item.timer);
        item.resolve(message.value ?? message);
        pending.delete(message.id);
      }
    } catch {
      // ignore non-json
    }
  });
  let next = 0;
  const send = (value: Record<string, unknown>) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || !child.stdin.writable) return reject(new Error("IPC unavailable"));
    const id = String(value.id ?? `ipc-${next++}`);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("IPC timeout")); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ ...value, id })}\n`, error => { if(error) { clearTimeout(timer); pending.delete(id); reject(error); } });
  });
  return {
    child,
    send: (payload) => send({ type: "command", actor: { kind: "user", id: "ipc" }, payload }),
    cancel: (requestId) => send({ type: "cancel", requestId }),
    snapshot: () => send({ type: "snapshot" }),
    close: async () => {
      await send({ type: "shutdown" });
      child.kill();
    },
  };
}

export function ipcServerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "ipc-server.ts");
}
