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

function lockPath(profileDir: string): string {
  return path.join(profileDir, "WRITE_LOCK.json");
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireHostLock(profileDir: string, hostId: string): HostLock {
  fs.mkdirSync(profileDir, { recursive: true });
  const file = lockPath(profileDir);
  // Serialize stale-owner reclamation as well as creation. A stranded guard fails closed.
  const guard = path.join(profileDir, ".WRITE_LOCK.guard");
  try { fs.mkdirSync(guard); } catch (error) {
    throw new MangaError("HOST_CONFLICT", "profile lock arbitration in progress or interrupted", { cause: error });
  }
  try {
  // Exclusive creation arbitrates concurrent hosts, including hosts with the same name.
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as HostLock;
    if (pidAlive(existing.pid)) {
      throw new MangaError("HOST_CONFLICT", "profile already has an active write host", {
        details: { existing },
      });
    }
    // A dead owner cannot remove its lock. Never replace a live owner's file.
    fs.unlinkSync(file);
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
  } finally { fs.rmdirSync(guard); }
}

export function releaseHostLock(profileDir: string, hostId: string): void {
  const file = lockPath(profileDir);
  if (!fs.existsSync(file)) return;
  const existing = JSON.parse(fs.readFileSync(file, "utf8")) as HostLock;
  if (existing.hostId === hostId && existing.pid === process.pid) {
    fs.unlinkSync(file);
  }
}
