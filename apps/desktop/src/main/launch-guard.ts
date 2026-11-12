import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appRootOf, channelInfoOf, packagedVersion } from "./launch-paths.ts";

/**
 * The way back after an update that does not start (4.2, LOOP-32), Node only so the bootstrap entry can run it before anything else is loaded.
 *
 * - Before a release runs the installer of a new version, the update service keeps the installer of the version that is running in
 *   `cache\updater\previous\` with its version and SHA-512 (`previous.json`, one at a time; see `UpdateService.keepPreviousInstaller`).
 * - For the first three starts of a version that came by an update, the bootstrap writes `runtime\launch-attempt.json` before it loads the full
 *   application, which removes it once its window is ready. A start that finds the marker of the start before it counts that one as failed.
 * - After two failed starts in a row the third asks: back to the previous version, try again, or open the download page. Nothing is undone
 *   without that answer, and only an installer whose SHA-512 is still the recorded one is run.
 */
export const LAUNCH_ATTEMPT_FILE = "launch-attempt.json";
export const LAUNCH_HISTORY_FILE = "launch-history.json";
/** Starts of a new version that are watched; after that a start is an ordinary one. */
export const WATCHED_LAUNCHES = 3;
/** Failed starts in a row before the question is asked. */
export const FAILURES_BEFORE_ASKING = 2;
export const RELEASES_PAGE = "https://github.com/chialecode/manga/releases";

export type PreviousInstaller = {
  version: string;
  sha512Hex: string;
  file: string;
  /** The schema of the library the previous version used, and the one the version installed after it moved it to (null when not known). */
  schemaVersion: number | null;
  targetVersion: string | null;
  targetSchemaVersion: number | null;
  /** Where the library and the backup written just before the update are (absolute; the library may have been moved by the person). */
  database: string | null;
  backup: string | null;
  keptAt: string;
};

export type LaunchHistory = { version: string; launches: number; failures: number };
export type LaunchAttempt = { version: string; attempt: number; pid: number; at: string };
export type SkippedUpdate = { version: string; at: string };

export type GuardPaths = { runtime: string; updaterCache: string; data: string };

export function guardPaths(appRoot: string): GuardPaths {
  return { runtime: path.join(appRoot, "runtime"), updaterCache: path.join(appRoot, "cache", "updater"), data: path.join(appRoot, "data") };
}

const readJson = <T>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
};
const writeJson = (file: string, body: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staging, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(staging, file);
};

/** Whether this version reached the machine by an update (the installer helper's record of the last install names it). */
export function cameByUpdate(paths: GuardPaths, version: string): boolean {
  const done = readJson<{ status?: string; version?: string; actualVersion?: string }>(path.join(paths.updaterCache, "last-installed.json"));
  return done?.status === "installed" && (done.actualVersion ?? done.version) === version;
}

export function readPrevious(paths: GuardPaths): PreviousInstaller | null {
  const record = readJson<PreviousInstaller>(path.join(paths.updaterCache, "previous", "previous.json"));
  return record && typeof record.version === "string" && typeof record.sha512Hex === "string" && typeof record.file === "string" ? record : null;
}

export function sha512HexOf(file: string): string {
  const hash = crypto.createHash("sha512");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** The kept installer, only when its bytes are still the recorded ones. */
export function verifiedPrevious(paths: GuardPaths): PreviousInstaller | null {
  const record = readPrevious(paths);
  if (!record) return null;
  const file = path.join(paths.updaterCache, "previous", path.basename(record.file));
  try {
    return fs.statSync(file).isFile() && sha512HexOf(file) === record.sha512Hex.toLowerCase() ? { ...record, file } : null;
  } catch {
    return null;
  }
}

export type LaunchDecision =
  | { kind: "ordinary" }
  | { kind: "watched"; attempt: number }
  | { kind: "ask"; version: string; failures: number; previous: PreviousInstaller | null };

/**
 * What this start is: ordinary, one of the watched starts of a new version (the marker is written), or the start that asks. A marker left by the
 * start before (it never reached its window) is a failure; no marker after a watched start means that start was fine and the count starts again.
 */
export function beginLaunch(paths: GuardPaths, version: string, now = new Date()): LaunchDecision {
  if (!cameByUpdate(paths, version)) return { kind: "ordinary" };
  const historyFile = path.join(paths.runtime, LAUNCH_HISTORY_FILE);
  const attemptFile = path.join(paths.runtime, LAUNCH_ATTEMPT_FILE);
  const saved = readJson<LaunchHistory>(historyFile);
  const history: LaunchHistory = saved && saved.version === version ? saved : { version, launches: 0, failures: 0 };
  const left = readJson<LaunchAttempt>(attemptFile);
  if (left && left.version === version) history.failures += 1;
  else if (history.launches > 0) history.failures = 0;
  if (history.failures >= FAILURES_BEFORE_ASKING) {
    writeJson(historyFile, history);
    try { fs.rmSync(attemptFile, { force: true }); } catch { /* best effort */ }
    return { kind: "ask", version, failures: history.failures, previous: readPrevious(paths) };
  }
  if (history.launches >= WATCHED_LAUNCHES && history.failures === 0) {
    writeJson(historyFile, history);
    return { kind: "ordinary" };
  }
  history.launches += 1;
  writeJson(historyFile, history);
  writeJson(attemptFile, { version, attempt: history.launches, pid: process.pid, at: now.toISOString() } satisfies LaunchAttempt);
  return { kind: "watched", attempt: history.launches };
}

/** The full application's window is ready: this start counts as a good one. */
export function launchSucceeded(attemptFile: string): void {
  try { fs.rmSync(attemptFile, { force: true }); } catch { /* best effort */ }
}

/** "Try again": the count of failures starts again, the starts stay watched. */
export function retryLaunch(paths: GuardPaths, version: string): void {
  const historyFile = path.join(paths.runtime, LAUNCH_HISTORY_FILE);
  const saved = readJson<LaunchHistory>(historyFile);
  writeJson(historyFile, { version, launches: Math.min(saved?.launches ?? 0, WATCHED_LAUNCHES - 1), failures: 0 } satisfies LaunchHistory);
}

/** Where `update-skip.json` and `rollback-record.json` live: beside `previous.database` when the library data dir was relocated, else `paths.data`. */
export function guardDataDir(paths: GuardPaths, previous?: Pick<PreviousInstaller, "database"> | null): string {
  return previous?.database ? path.dirname(previous.database) : paths.data;
}

export function readSkipped(paths: GuardPaths, previous?: Pick<PreviousInstaller, "database"> | null): SkippedUpdate | null {
  const dataDir = guardDataDir(paths, previous ?? readPrevious(paths));
  const body = readJson<SkippedUpdate>(path.join(dataDir, "update-skip.json"))
    ?? (dataDir !== paths.data ? readJson<SkippedUpdate>(path.join(paths.data, "update-skip.json")) : null);
  return body && typeof body.version === "string" ? body : null;
}

export type RollbackPlan = {
  previous: PreviousInstaller;
  from: string;
  /** The library is put back to the backup from before the update; the one now in use is kept beside it under this name. */
  database: { restoreFrom: string; current: string; keptAs: string } | null;
};

/** Whether going back means putting back the library from before the update (the new version moved it to a newer schema, or that is not known). */
export function rollbackPlan(previous: PreviousInstaller, from: string, now = new Date()): RollbackPlan {
  const upgraded = previous.targetSchemaVersion === null || previous.schemaVersion === null || previous.targetSchemaVersion > previous.schemaVersion;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const premigrate = previous.database && previous.schemaVersion !== null ? `${previous.database}.premigrate-v${previous.schemaVersion}` : null;
  const restoreFrom = premigrate && fs.existsSync(premigrate)
    ? premigrate
    : previous.backup && fs.existsSync(previous.backup)
      ? previous.backup
      : null;
  const database = upgraded && previous.database && restoreFrom
    ? { restoreFrom, current: previous.database, keptAs: `${previous.database}.rolledback-${stamp}` }
    : null;
  return { previous, from, database };
}

/**
 * Put the library back (when the plan says so), skip the version that did not start and leave a record for the previous version to put in its
 * operation log. Runs before the installer; the library is not open because the full application was never loaded.
 */
export function prepareRollback(paths: GuardPaths, plan: RollbackPlan, now = new Date()): { databaseRestored: boolean; keptAs: string | null } {
  let databaseRestored = false;
  let keptAs: string | null = null;
  if (plan.database) {
    const { current, restoreFrom } = plan.database;
    keptAs = plan.database.keptAs;
    // The library in use is kept whole (with its write-ahead log) under the new name before the backup is copied in.
    if (fs.existsSync(current)) fs.renameSync(current, keptAs);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(`${current}${suffix}`)) fs.renameSync(`${current}${suffix}`, `${keptAs}${suffix}`);
    }
    const staging = `${current}.restore.part`;
    fs.copyFileSync(restoreFrom, staging);
    fs.renameSync(staging, current);
    databaseRestored = true;
  }
  const dataDir = guardDataDir(paths, plan.previous);
  writeJson(path.join(dataDir, "update-skip.json"), { version: plan.from, at: now.toISOString() } satisfies SkippedUpdate);
  writeJson(path.join(dataDir, "rollback-record.json"), { from: plan.from, to: plan.previous.version, at: now.toISOString(), databaseRestored, keptAs: keptAs ? path.basename(keptAs) : null });
  // The version that is going away is not watched any more; the previous one did not come by an update.
  for (const file of [path.join(paths.runtime, LAUNCH_HISTORY_FILE), path.join(paths.runtime, LAUNCH_ATTEMPT_FILE), path.join(paths.updaterCache, "last-installed.json")]) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
  return { databaseRestored, keptAs };
}

export type CommitRollbackResult =
  | { kind: "rolled-back"; previous: PreviousInstaller; plan: RollbackPlan; databaseRestored: boolean; keptAs: string | null }
  | { kind: "unverified-fallback-download" };

/**
 * Re-verify the kept installer right after the person chooses "back" before `prepareRollback` swaps the library or spawns the installer.
 * If the kept installer's SHA-512 no longer matches (or the file was removed while the dialog was open), nothing in the data directory is touched.
 */
export function commitVerifiedRollback(paths: GuardPaths, fromVersion: string, now = new Date()): CommitRollbackResult {
  const verified = verifiedPrevious(paths);
  if (!verified) return { kind: "unverified-fallback-download" };
  const plan = rollbackPlan(verified, fromVersion, now);
  const { databaseRestored, keptAs } = prepareRollback(paths, plan, now);
  return { kind: "rolled-back", previous: verified, plan, databaseRestored, keptAs };
}

export type GuardedBootstrapStart = {
  paths: GuardPaths;
  decision: LaunchDecision;
  version: string;
  testIdentity: boolean;
};

export type BootstrapStartOutcome =
  | { mode: "light" }
  | { mode: "full"; guarded: null; attemptFile: null; failOnPurpose: false }
  | { mode: "full"; guarded: GuardedBootstrapStart & { decision: Exclude<LaunchDecision, { kind: "ask" }> }; attemptFile: string | null; failOnPurpose: boolean }
  | { mode: "ask"; guarded: GuardedBootstrapStart & { decision: Extract<LaunchDecision, { kind: "ask" }> }; attemptFile: null; failOnPurpose: false };

/**
 * Pure bootstrap start classifier (`bootstrap.ts`, 4.1, 4.2):
 * - `--manga-light` goes straight to light open and never touches launch guard state.
 * - Unpackaged `pnpm dev`, `development` / `test` channels, `--quit-for-update`, and ordinary `--manga-smoke` runs never count as watched launches.
 * - `MANGA_TEST_FAIL_LAUNCH` is honored only when `testIdentity === true` on a watched launch.
 */
export function evaluateBootstrapStart(input: {
  packaged: boolean;
  resourcesPath: string;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): BootstrapStartOutcome {
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  if (argv.includes("--manga-light")) return { mode: "light" };
  if (!input.packaged || argv.includes("--quit-for-update")) {
    return { mode: "full", guarded: null, attemptFile: null, failOnPurpose: false };
  }
  const info = channelInfoOf({ resourcesPath: input.resourcesPath, packaged: true, env });
  if (info.channel !== "release") {
    return { mode: "full", guarded: null, attemptFile: null, failOnPurpose: false };
  }
  if (argv.includes("--manga-smoke") && !(info.testIdentity && env.MANGA_TEST_LAUNCH_GUARD === "1")) {
    return { mode: "full", guarded: null, attemptFile: null, failOnPurpose: false };
  }
  const version = packagedVersion(input.resourcesPath);
  if (!version) {
    return { mode: "full", guarded: null, attemptFile: null, failOnPurpose: false };
  }
  const paths = guardPaths(appRootOf(info, env));
  let decision: LaunchDecision;
  try {
    decision = beginLaunch(paths, version, input.now);
  } catch {
    return { mode: "full", guarded: null, attemptFile: null, failOnPurpose: false };
  }
  if (decision.kind === "ask") {
    return { mode: "ask", guarded: { paths, decision, version, testIdentity: info.testIdentity }, attemptFile: null, failOnPurpose: false };
  }
  const watched = decision.kind === "watched";
  const attemptFile = watched ? path.join(paths.runtime, LAUNCH_ATTEMPT_FILE) : null;
  const failOnPurpose = watched && info.testIdentity && env.MANGA_TEST_FAIL_LAUNCH === version;
  return { mode: "full", guarded: { paths, decision, version, testIdentity: info.testIdentity }, attemptFile, failOnPurpose };
}

/** The question's words (交互设计: system dialog, because the window may not come up). */
export function questionText(version: string, previous: PreviousInstaller | null): { message: string; detail: string; buttons: string[] } {
  const back = previous ? `回到 ${previous.version}` : "回到上一版";
  const detail = previous
    ? [
      `“${back}”会安装之前的版本，并跳过 ${version}，直到有更新的版本。`,
      previous.targetSchemaVersion === null || previous.schemaVersion === null || previous.targetSchemaVersion > previous.schemaVersion
        ? "会恢复更新前自动备份的资料库，更新后的改动会丢失；现在的资料库会改名留下。"
        : "资料库不变。",
      "“再试一次”照常启动这个版本；“打开下载页”可以手动下载其他版本。",
    ].join("\n")
    : "没有找到上一版的安装包，无法一键回到上一版。“打开下载页”可以手动下载其他版本；“再试一次”照常启动这个版本。";
  return { message: `MANGA ${version} 上次没能正常启动。`, detail, buttons: previous ? [back, "再试一次", "打开下载页"] : ["再试一次", "打开下载页"] };
}
