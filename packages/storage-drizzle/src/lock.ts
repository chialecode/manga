import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { MangaError } from "@manga/contracts";

export type HostLock = {
  profileId: string;
  hostId: string;
  pid: number;
  startedAt: string;
};

const STALE_GUARD_MS = 10_000;

function lockPath(profileDir: string): string {
  return path.join(profileDir, "WRITE_LOCK.json");
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function readLockSafe(file: string): HostLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HostLock> | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.pid !== "number" || typeof parsed.hostId !== "string") {
      return null;
    }
    return parsed as HostLock;
  } catch {
    return null;
  }
}

function acquireGuard(guard: string): void {
  try {
    fs.mkdirSync(guard);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
      throw new MangaError("HOST_CONFLICT", "profile lock arbitration in progress or interrupted", { cause: error });
    }
  }
  // Recover a stale arbitration directory left behind by a hard crash (SIGKILL / power loss).
  try {
    const stat = fs.statSync(guard);
    if (Date.now() - stat.mtimeMs > STALE_GUARD_MS) {
      fs.rmSync(guard, { recursive: true, force: true });
      fs.mkdirSync(guard);
      return;
    }
  } catch (error) {
    throw new MangaError("HOST_CONFLICT", "profile lock arbitration in progress or interrupted", { cause: error });
  }
  throw new MangaError("HOST_CONFLICT", "profile lock arbitration in progress or interrupted");
}

export function acquireHostLock(profileDir: string, hostId: string): HostLock {
  fs.mkdirSync(profileDir, { recursive: true });
  const file = lockPath(profileDir);
  const guard = path.join(profileDir, ".WRITE_LOCK.guard");
  acquireGuard(guard);
  try {
    if (fs.existsSync(file)) {
      const existing = readLockSafe(file);
      if (existing && pidAlive(existing.pid)) {
        throw new MangaError("HOST_CONFLICT", "profile already has an active write host", {
          details: { existingHostId: existing.hostId },
        });
      }
      fs.rmSync(file, { force: true });
    }
    const lock: HostLock = {
      profileId: path.basename(profileDir),
      hostId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      throw new MangaError("HOST_CONFLICT", "another write host acquired the profile", { cause: error });
    }
    return lock;
  } finally {
    try { fs.rmdirSync(guard); } catch { /* ignore */ }
  }
}

export function releaseHostLock(profileDir: string, hostId: string): void {
  const file = lockPath(profileDir);
  const existing = readLockSafe(file);
  if (existing && existing.hostId === hostId && existing.pid === process.pid) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}
