import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { sha256File } from "../shared/utils.ts";
import { comparablePath, copyOwnedFile, fingerprintTree, listCopyFiles, ownedFileFingerprint, pathsOverlap } from "./file-ownership.ts";

export type RecoveryOutcome = { jobs: number; removed: string[]; needsReview: string[]; recovered: string[] };

export const PACKAGE_COPIED_MANIFEST = ".copied.json";

function sameFile(a: string, b: string): boolean {
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    return left.ino === right.ino && left.dev === right.dev && left.size === right.size;
  } catch {
    return false;
  }
}

function readCopiedManifest(stagingPath: string): Set<string> {
  const file = path.join(stagingPath, PACKAGE_COPIED_MANIFEST);
  if (!fs.existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === "string")) : new Set();
  } catch {
    return new Set();
  }
}

type LocationPayload = {
  copies?: Array<{ partition: string; source: string; target: string; indexedOnly?: boolean }>;
  targetRoot?: string;
  liveRoot?: string;
  verified?: Array<{ partition: string; bytes: number; fingerprint: string }>;
};

export function recoverOrRollback(store: DrizzleStore, action: "recover" | "rollback", liveRoot?: string): RecoveryOutcome {
  const jobs = store.sqlite.prepare("SELECT * FROM recovery_jobs WHERE status IN ('running','interrupted','failed','planned','needs-review')").all() as Array<{ id: string; kind: string; stage: string; status: string; staging_path: string | null; payload_json: string }>;
  const removed: string[] = [];
  const needsReview: string[] = [];
  const recovered: string[] = [];
  for (const job of jobs) {
    if (job.kind === "location-migrate") {
      if (action === "rollback") {
        const outcome = rollbackLocationJob(store, job, liveRoot ?? JSON.parse(job.payload_json).liveRoot);
        removed.push(...outcome.removed);
        needsReview.push(...outcome.needsReview);
        continue;
      }
      const outcome = resumeLocationCopy(store, job, liveRoot);
      needsReview.push(...outcome.needsReview);
      if (outcome.status === "copied") recovered.push(job.id);
      continue;
    }
    if (action !== "rollback") {
      store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
      needsReview.push(job.id);
      continue;
    }
    const payload = JSON.parse(job.payload_json) as { attachments?: string[]; managed?: string[] };
    if (job.kind === "package-import" && job.staging_path) {
      // The transaction never committed, so published hard links (or recorded cross-device copies) of staged files are orphans.
      const managed = new Set(payload.managed ?? []);
      const copied = readCopiedManifest(job.staging_path);
      for (const name of payload.attachments ?? []) {
        const staged = path.join(job.staging_path, name);
        const target = path.join(managed.has(name) ? store.managedLibraryDir : store.attachmentsDir, name);
        if (!fs.existsSync(staged) || !fs.existsSync(target)) continue;
        const ownedByJob = sameFile(staged, target)
          || (copied.has(name) && fs.statSync(staged).size === fs.statSync(target).size && sha256File(staged) === sha256File(target));
        if (ownedByJob) {
          fs.unlinkSync(target);
          removed.push(target);
        }
      }
      if (fs.existsSync(job.staging_path)) {
        fs.rmSync(job.staging_path, { recursive: true, force: true });
        removed.push(job.staging_path);
      }
    }
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'rolled-back', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
  }
  return { jobs: jobs.length, removed, needsReview, recovered };
}

export function resumeLocationCopy(
  store: DrizzleStore,
  job: { id: string; payload_json: string; status: string },
  liveRoot?: string,
): { status: "copied" | "needs-review" | "blocked"; needsReview: string[]; verified: Array<{ partition: string; bytes: number; fingerprint: string }>; targetRoot?: string } {
  const payload = JSON.parse(job.payload_json) as LocationPayload;
  const live = liveRoot ? comparablePath(liveRoot) : undefined;
  const targetRoot = payload.targetRoot ? comparablePath(payload.targetRoot) : undefined;
  const relocated = store.getMeta("relocatedRoot");
  const published = relocated && targetRoot ? comparablePath(relocated) === targetRoot : false;
  if (live && targetRoot && pathsOverlap(live, targetRoot) && !published) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return { status: "blocked", needsReview: [job.id], verified: [], targetRoot: payload.targetRoot };
  }
  if (published) {
    return { status: "copied", needsReview: [], verified: payload.verified ?? [], targetRoot: payload.targetRoot };
  }
  if (!payload.copies?.length || !payload.targetRoot) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return { status: "needs-review", needsReview: [job.id], verified: [] };
  }
  try {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'running', stage = 'copy', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    const verified: Array<{ partition: string; bytes: number; fingerprint: string }> = [];
    for (const copy of payload.copies) {
      if (copy.indexedOnly) continue;
      const dest = copy.target;
      fs.mkdirSync(dest, { recursive: true });
      const files = listCopyFiles(copy.source);
      if (copy.partition === "data") {
        // Record copying ownership before checkpointing so the live SQLite file does not mutate mid-copy.
        const toCopy: Array<{ source: string; target: string; relative: string }> = [];
        for (const file of files) {
          const relative = file.relativePath.replace(/^\.\//, "");
          const targetFile = path.join(dest, relative);
          const owned = store.sqlite.prepare("SELECT state, fingerprint, absolute_path AS path FROM migration_owned_files WHERE job_id = ? AND partition = ? AND relative_path = ?").get(job.id, copy.partition, relative) as { state: string; fingerprint: string | null; path: string } | undefined;
          if (owned?.state === "committed" && fs.existsSync(targetFile)) {
            const destHash = ownedFileFingerprint(targetFile);
            if (destHash === owned.fingerprint || destHash === ownedFileFingerprint(file.absolutePath)) continue;
            if (targetFile.endsWith(".sqlite")) continue;
            store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
            return { status: "needs-review", needsReview: [job.id], verified };
          }
          if (owned?.state === "copying" && fs.existsSync(targetFile)) {
            try { fs.unlinkSync(targetFile); } catch {
              store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
              return { status: "needs-review", needsReview: [job.id], verified };
            }
          } else if (fs.existsSync(targetFile)) {
            store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
            return { status: "needs-review", needsReview: [job.id], verified };
          }
          store.sqlite.prepare("INSERT OR REPLACE INTO migration_owned_files(job_id, partition, relative_path, absolute_path, state, fingerprint) VALUES (?,?,?,?,?,?)").run(
            job.id, copy.partition, relative, targetFile, "copying", null,
          );
          toCopy.push({ source: file.absolutePath, target: targetFile, relative });
        }
        if (toCopy.length) store.sqlite.pragma("wal_checkpoint(TRUNCATE)");
        const committed: Array<{ relative: string; hash: string }> = [];
        for (const item of toCopy) committed.push({ relative: item.relative, hash: copyOwnedFile(item.source, item.target) });
        const destTree = fingerprintTree(dest);
        for (const file of files) {
          const relative = file.relativePath.replace(/^\.\//, "");
          const targetFile = path.join(dest, relative);
          if (!fs.existsSync(targetFile) || (
            ownedFileFingerprint(targetFile) !== ownedFileFingerprint(file.absolutePath)
            && !targetFile.endsWith(".sqlite")
          )) {
            throw new MangaError("VALIDATION_ERROR", `copied ${copy.partition} is missing a source file`, { details: { partition: copy.partition, relative } });
          }
        }
        for (const item of committed) {
          store.sqlite.prepare("UPDATE migration_owned_files SET state = 'committed', fingerprint = ? WHERE job_id = ? AND partition = ? AND relative_path = ?").run(item.hash, job.id, copy.partition, item.relative);
        }
        verified.push({ partition: copy.partition, bytes: destTree.bytes, fingerprint: destTree.hash });
        continue;
      }
      for (const file of files) {
        const relative = file.relativePath.replace(/^\.\//, "");
        const targetFile = path.join(dest, relative);
        const owned = store.sqlite.prepare("SELECT state, fingerprint, absolute_path AS path FROM migration_owned_files WHERE job_id = ? AND partition = ? AND relative_path = ?").get(job.id, copy.partition, relative) as { state: string; fingerprint: string | null; path: string } | undefined;
        if (owned?.state === "committed" && fs.existsSync(targetFile)) {
          const destHash = ownedFileFingerprint(targetFile);
          if (destHash === owned.fingerprint || destHash === ownedFileFingerprint(file.absolutePath)) continue;
          store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
          return { status: "needs-review", needsReview: [job.id], verified };
        }
        if (owned?.state === "copying" && fs.existsSync(targetFile)) {
          try { fs.unlinkSync(targetFile); } catch {
            store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
            return { status: "needs-review", needsReview: [job.id], verified };
          }
        } else if (fs.existsSync(targetFile)) {
          store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
          return { status: "needs-review", needsReview: [job.id], verified };
        }
        store.sqlite.prepare("INSERT OR REPLACE INTO migration_owned_files(job_id, partition, relative_path, absolute_path, state, fingerprint) VALUES (?,?,?,?,?,?)").run(
          job.id, copy.partition, relative, targetFile, "planned", null,
        );
        store.sqlite.prepare("UPDATE migration_owned_files SET state = 'copying' WHERE job_id = ? AND partition = ? AND relative_path = ?").run(job.id, copy.partition, relative);
        const hash = copyOwnedFile(file.absolutePath, targetFile);
        store.sqlite.prepare("UPDATE migration_owned_files SET state = 'committed', fingerprint = ? WHERE job_id = ? AND partition = ? AND relative_path = ?").run(hash, job.id, copy.partition, relative);
      }
      const destTree = fingerprintTree(dest);
      for (const file of files) {
        const relative = file.relativePath.replace(/^\.\//, "");
        const targetFile = path.join(dest, relative);
        if (!fs.existsSync(targetFile) || ownedFileFingerprint(targetFile) !== ownedFileFingerprint(file.absolutePath)) {
          throw new MangaError("VALIDATION_ERROR", `copied ${copy.partition} is missing a source file`, { details: { partition: copy.partition, relative } });
        }
      }
      verified.push({ partition: copy.partition, bytes: destTree.bytes, fingerprint: destTree.hash });
    }
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'running', stage = 'verify', payload_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ ...payload, verified }), new Date().toISOString(), job.id,
    );
    return { status: "copied", needsReview: [], verified, targetRoot: payload.targetRoot };
  } catch (error) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    throw error;
  }
}

function rollbackLocationJob(
  store: DrizzleStore,
  job: { id: string; payload_json: string },
  liveRoot?: string,
): { removed: string[]; needsReview: string[] } {
  const owned = store.sqlite.prepare("SELECT absolute_path AS path, state, fingerprint FROM migration_owned_files WHERE job_id = ?").all(job.id) as Array<{ path: string; state: string; fingerprint: string | null }>;
  const live = liveRoot ? comparablePath(liveRoot) : undefined;
  const payload = JSON.parse(job.payload_json) as { targetRoot?: string };
  const targetRoot = payload.targetRoot ? comparablePath(payload.targetRoot) : undefined;
  // A root this library already published to is authoritative even if the job row still looks unfinished.
  const relocated = store.getMeta("relocatedRoot");
  const published = relocated && targetRoot ? comparablePath(relocated) === targetRoot : false;
  if (published || (live && targetRoot && pathsOverlap(live, targetRoot))) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return { removed: [], needsReview: [job.id] };
  }
  if (!owned.length) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return { removed: [], needsReview: [job.id] };
  }
  const removed: string[] = [];
  let uncertain = false;
  for (const file of owned) {
    try {
      if (!fs.existsSync(file.path)) continue;
      const resolved = comparablePath(file.path);
      const real = comparablePath(fs.realpathSync(file.path));
      if (!targetRoot || !resolved.startsWith(targetRoot + path.sep) || real !== resolved
        || (live && pathsOverlap(live, resolved)) || file.state !== "committed"
        || !file.fingerprint || ownedFileFingerprint(file.path) !== file.fingerprint) {
        uncertain = true;
        continue;
      }
      fs.unlinkSync(file.path);
      removed.push(file.path);
    } catch {
      uncertain = true;
    }
  }
  if (uncertain) {
    store.sqlite.prepare("UPDATE recovery_jobs SET status = 'needs-review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    return { removed, needsReview: [job.id] };
  }
  store.sqlite.prepare("DELETE FROM migration_owned_files WHERE job_id = ?").run(job.id);
  store.sqlite.prepare("UPDATE recovery_jobs SET status = 'rolled-back', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
  return { removed, needsReview: [] };
}
