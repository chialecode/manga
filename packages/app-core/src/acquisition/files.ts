import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Putting a downloaded file where the person's library keeps its files, without ever replacing a file that is already there. A file is first made whole
 * and checked (staged), then made visible under its final name in one step (published), and only then is the staged copy let go. Every step can be
 * repeated after a crash and ends in the same place.
 */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Whether a path a source names can be written under a folder on every system: relative, no way out of the folder, no names a system refuses. The engine checks the same; the host does not trust it to. */
export function unsafeEntryPath(rel: unknown): boolean {
  if (typeof rel !== "string" || !rel || rel.length > 500 || rel.includes("\\") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return true;
  return rel.split("/").some((part) => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || RESERVED.test(part) || part.length > 200);
}

/** A folder below a library path that the person typed: empty, or safe segments. Returns null for something that is not one. */
export function normalizeSubdir(value: string | undefined): string | null {
  const text = (value ?? "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!text) return "";
  return unsafeEntryPath(text) ? null : text;
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/** `name.ext` → `name (2).ext`, the way a person would name a second copy. */
export function withCopyNumber(rel: string, n: number): string {
  if (n <= 1) return rel;
  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : "";
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = name.lastIndexOf(".");
  return dir + (dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`);
}

export const absUnder = (root: string, rel: string): string => path.join(root, ...rel.split("/"));

/** What one attempt to find a place for a file found: a name that is free, or a file that is already there and is the same file. */
export type Placement = { rel: string; adopted: boolean };

/**
 * Finds the name a file will have in the library: the wanted name when nothing is there, the same name when the file that is there is this very file
 * (it was published before and the record of it was lost), otherwise the first free `name (n)`. Nothing is written.
 */
export async function decidePlacement(root: string, wanted: string, length: number, fingerprint: string, attempts = 500): Promise<Placement | null> {
  for (let n = 1; n <= attempts; n += 1) {
    const rel = withCopyNumber(wanted, n);
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(absUnder(root, rel)); } catch { stat = null; }
    if (!stat) return { rel, adopted: false };
    if (stat.isFile() && stat.size === length && (await sha256File(absUnder(root, rel))) === fingerprint) return { rel, adopted: true };
  }
  return null;
}

const LINK_FALLBACK = new Set(["EXDEV", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "UNKNOWN", "EMLINK", "EACCES"]);
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const exists = (file: string) => { try { fs.lstatSync(file); return true; } catch { return false; } };

export class TargetTaken extends Error {
  constructor() { super("something else is at the target name"); }
}

/** Makes `tmp` appear as `target` without replacing anything: a hard link when the system allows it, a rename after looking when it does not. */
export function placeNoReplace(tmp: string, target: string): void {
  try {
    fs.linkSync(tmp, target);
    fs.unlinkSync(tmp);
    return;
  } catch (error) {
    if (codeOf(error) === "EEXIST") throw new TargetTaken();
    if (!LINK_FALLBACK.has(codeOf(error) ?? "")) throw error;
  }
  if (exists(target)) throw new TargetTaken();
  fs.renameSync(tmp, target);
}

export type PublishFiles = {
  /** How much room there is where the file will go, or null when it cannot be told. */
  freeBytes: (dir: string) => number | null;
  /** The temporary name a copy is made under, so a crash leaves only one file to find and remove. */
  tempName: (target: string) => string;
  /** Skips the hard link and copies, as it must across volumes; for tests that have only one volume. */
  forceCopy?: boolean;
};

/**
 * Publishes one verified staged file under `target`. On the same volume it is a hard link: nothing is copied, and the staged name is removed after.
 * Across volumes it is copied to a temporary name next to the target, flushed and checked against the fingerprint, and only then linked or renamed into
 * place. Never replaces: if something is at `target` it throws `TargetTaken` and the caller decides on another name.
 */
export async function publishFile(src: string, target: string, expected: { length: number; fingerprint: string }, hooks: PublishFiles): Promise<"linked" | "copied"> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!hooks.forceCopy) {
    try {
      fs.linkSync(src, target);
      return "linked";
    } catch (error) {
      if (codeOf(error) === "EEXIST") throw new TargetTaken();
      if (!LINK_FALLBACK.has(codeOf(error) ?? "")) throw error;
    }
  } else if (exists(target)) throw new TargetTaken();
  const free = hooks.freeBytes(path.dirname(target));
  if (free !== null && free < expected.length + 1024 * 1024) throw Object.assign(new Error("not enough room where the file goes"), { code: "ENOSPC" });
  const tmp = hooks.tempName(target);
  fs.rmSync(tmp, { force: true });
  try {
    await fs.promises.copyFile(src, tmp, fs.constants.COPYFILE_EXCL);
    const handle = await fs.promises.open(tmp, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    if (fs.statSync(tmp).size !== expected.length || (await sha256File(tmp)) !== expected.fingerprint) throw Object.assign(new Error("the copy does not match the file"), { code: "COPY_MISMATCH" });
    placeNoReplace(tmp, target);
    return "copied";
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
