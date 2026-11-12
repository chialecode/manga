import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";
import { sumRequiredModelBytes, type AsrCatalogModel, type AsrModelRequiredFile } from "./catalog.ts";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const TAR_MODE_RE = /^[-d][rwxstST-]{9}\s/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const MAX_TAR_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TAR_TIMEOUT_MS = 5 * 60_000;

export const MISSING_TAR_MESSAGE =
  "未找到系统解压组件（System32\\tar.exe），请在其他设备解压后使用「导入文件夹」安装模型";

export type ResolveTarOptions = {
  env?: NodeJS.ProcessEnv;
  explicitTarExe?: string;
  platform?: NodeJS.Platform;
};

/**
 * Resolves the OS-bundled `tar.exe` using absolute paths only (`%SystemRoot%\Sysnative\tar.exe` or `%SystemRoot%\System32\tar.exe`).
 * Never searches `PATH` so untrusted binaries in a working directory or user `PATH` cannot be executed.
 */
export function resolveSystemTarExe(options: ResolveTarOptions = {}): string {
  if (options.explicitTarExe !== undefined) {
    const explicit = options.explicitTarExe.trim();
    if (explicit && path.isAbsolute(explicit) && fs.existsSync(explicit)) {
      const stat = fs.lstatSync(explicit);
      if (stat.isFile() && !stat.isSymbolicLink()) return explicit;
    }
    throw new MangaError("CAPABILITY_UNAVAILABLE", MISSING_TAR_MESSAGE);
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    const sysRoot = (env.SystemRoot ?? env.windir ?? path.win32.join(env.SystemDrive ?? "C:", "Windows")).trim();
    if (!path.isAbsolute(sysRoot)) {
      throw new MangaError("CAPABILITY_UNAVAILABLE", MISSING_TAR_MESSAGE);
    }
    const candidates = [
      path.join(sysRoot, "Sysnative", "tar.exe"),
      path.join(sysRoot, "System32", "tar.exe"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const stat = fs.lstatSync(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
      }
    }
    throw new MangaError("CAPABILITY_UNAVAILABLE", MISSING_TAR_MESSAGE);
  }

  for (const candidate of ["/usr/bin/tar", "/bin/tar"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new MangaError("CAPABILITY_UNAVAILABLE", MISSING_TAR_MESSAGE);
}

export async function sha256File(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  if (signal?.aborted) {
    throw new MangaError("CANCELLED", "模型校验已取消");
  }
  return new Promise<{ bytes: number; sha256: string }>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    let settled = false;
    const stream = fs.createReadStream(filePath);

    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      stream.destroy();
      reject(err);
    };

    const onAbort = () => {
      finishErr(new MangaError("CANCELLED", "模型校验已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buf.length;
      hash.update(buf);
    });
    stream.on("error", (err) => {
      finishErr(
        new MangaError("VALIDATION_ERROR", `读取模型文件失败：${err.message}`, {
          cause: err,
        }),
      );
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve({ bytes, sha256: hash.digest("hex") });
    });
  });
}

type RunTarResult = {
  stdout: Buffer;
  stderr: string;
};

function buildMinimalTarEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "windir", "TEMP", "TMP", "TMPDIR"] as const) {
    if (env[key]) clean[key] = env[key];
  }
  clean.LC_ALL = "C";
  return clean;
}

async function runTarCommand(
  tarExe: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunTarResult> {
  if (options.signal?.aborted) {
    throw new MangaError("CANCELLED", "模型解压已取消");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TAR_TIMEOUT_MS;
  return new Promise<RunTarResult>((resolve, reject) => {
    const child = spawn(tarExe, [...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildMinimalTarEnv(options.env),
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrText = "";
    let killedForCancel = false;
    let killedForTimeout = false;
    let killedForCap = false;

    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill();
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      killedForCancel = true;
      child.kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_TAR_STDOUT_BYTES) {
        killedForCap = true;
        child.kill();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText = (stderrText + chunk.toString("utf8")).slice(-4096);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(
        new MangaError("CAPABILITY_UNAVAILABLE", `调用系统 tar 解压失败：${err.message}`, {
          cause: err,
        }),
      );
    });

    // Always wait for `close` before resolving/rejecting so Windows file handles inside staging directories are released.
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (killedForCancel || options.signal?.aborted) {
        reject(new MangaError("CANCELLED", "模型解压已取消"));
        return;
      }
      if (killedForTimeout) {
        reject(new MangaError("PROVIDER_UNAVAILABLE", "模型包解压超时", { retryable: true }));
        return;
      }
      if (killedForCap) {
        reject(new MangaError("VALIDATION_ERROR", "模型压缩包目录项过多，拒绝解压"));
        return;
      }
      if (code !== 0) {
        const enoSpc = /No space left on device|ENOSPC|磁盘空间不足/i.test(stderrText);
        if (enoSpc) {
          reject(new MangaError("DISK_FULL", "磁盘空间不足，无法完成模型解压，请清理空间后重试"));
          return;
        }
        const detail = stderrText.trim().split(/\r?\n/).pop()?.slice(0, 200) ?? `退出码 ${code ?? "未知"}`;
        reject(new MangaError("UNSUPPORTED_FORMAT", `模型压缩包损坏或格式不受支持（${detail}）`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr: stderrText });
    });
  });
}

function splitTarLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function validateTarEntryPath(entry: string, targetRoot: string): { normalized: string; isDirectory: boolean } {
  if (!entry || entry.length > 512) {
    throw new MangaError("PATH_ESCAPE", "模型压缩包含空路径或超长路径条目，已拒绝解压");
  }
  if (CONTROL_CHAR_RE.test(entry)) {
    throw new MangaError("PATH_ESCAPE", "模型压缩包含控制字符路径条目，已拒绝解压");
  }
  if (entry.startsWith("/") || entry.startsWith("\\") || entry.includes("\\") || entry.includes(":")) {
    throw new MangaError("PATH_ESCAPE", `模型压缩包含非法路径条目「${entry}」，已拒绝解压`);
  }
  const isDirectory = entry.endsWith("/");
  const trimmed = entry.replace(/\/+$/, "");
  if (!trimmed) {
    throw new MangaError("PATH_ESCAPE", "模型压缩包含根目录条目，已拒绝解压");
  }
  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      throw new MangaError("PATH_ESCAPE", `模型压缩包含越界路径条目「${entry}」，已拒绝解压`);
    }
    if (seg.endsWith(" ") || seg.endsWith(".")) {
      throw new MangaError("PATH_ESCAPE", `模型压缩包含不安全的 Windows 路径名「${entry}」，已拒绝解压`);
    }
    const stem = seg.split(".")[0]?.toUpperCase() ?? "";
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      throw new MangaError("PATH_ESCAPE", `模型压缩包含 Windows 保留设备名「${entry}」，已拒绝解压`);
    }
  }
  const resolvedRoot = path.resolve(targetRoot);
  const resolvedEntry = path.resolve(resolvedRoot, ...segments);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (!resolvedEntry.startsWith(rootPrefix)) {
    throw new MangaError("PATH_ESCAPE", `模型压缩包条目越出目标目录「${entry}」，已拒绝解压`);
  }
  return { normalized: segments.join("/"), isDirectory };
}

export type InspectTarOptions = {
  tarExe: string;
  maxUncompressedBytes: number;
  maxEntries?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

export type TarInspectionResult = {
  entries: string[];
  totalUncompressedBytes: number;
};

/**
 * Two-step pre-extraction archive audit:
 * 1. `tar.exe -tvf` (decoded as `latin1` to stay immune to locale-encoded month bytes on zh-CN Windows) verifies that
 *    every entry is a regular file (`-`) or directory (`d`), contains no symlink/hardlink markers, and stays within
 *    `maxUncompressedBytes`.
 * 2. `tar.exe -tf` (UTF-8) validates raw entry paths against traversal, drive letters, reserved names, and case collisions.
 */
export async function inspectTarArchive(
  archivePath: string,
  options: InspectTarOptions,
): Promise<TarInspectionResult> {
  const maxEntries = options.maxEntries ?? 2_000;
  const verboseRun = await runTarCommand(options.tarExe, ["-tvf", archivePath], {
    signal: options.signal,
    env: options.env,
  });
  const modeLines = splitTarLines(verboseRun.stdout.toString("latin1"));
  if (modeLines.length === 0) {
    throw new MangaError("UNSUPPORTED_FORMAT", "模型压缩包为空，已拒绝安装");
  }
  if (modeLines.length > maxEntries) {
    throw new MangaError("VALIDATION_ERROR", `模型压缩包包含过多文件条目（${modeLines.length}），已拒绝解压`);
  }

  let totalUncompressedBytes = 0;
  const entryTypes: Array<"f" | "d"> = [];
  for (const line of modeLines) {
    if (!TAR_MODE_RE.test(line)) {
      throw new MangaError("PATH_ESCAPE", "模型压缩包含符号链接、硬链接或特殊设备条目，已拒绝解压");
    }
    if (line.includes(" -> ") || line.includes(" link to ")) {
      throw new MangaError("PATH_ESCAPE", "模型压缩包含链接指向条目，已拒绝解压");
    }
    const cols = line.trim().split(/\s+/);
    const declaredSize = Number(cols[4]);
    if (!Number.isFinite(declaredSize) || declaredSize < 0) {
      throw new MangaError("UNSUPPORTED_FORMAT", "无法解析模型压缩包条目大小");
    }
    totalUncompressedBytes += declaredSize;
    if (totalUncompressedBytes > options.maxUncompressedBytes) {
      throw new MangaError(
        "VALIDATION_ERROR",
        `模型压缩包解压后体积超出安全上限（${totalUncompressedBytes} 字节 > ${options.maxUncompressedBytes} 字节）`,
      );
    }
    entryTypes.push(line[0] === "d" ? "d" : "f");
  }

  const namesRun = await runTarCommand(options.tarExe, ["-tf", archivePath], {
    signal: options.signal,
    env: options.env,
  });
  const rawNames = splitTarLines(namesRun.stdout.toString("utf8"));
  if (rawNames.length !== modeLines.length) {
    throw new MangaError("PATH_ESCAPE", "模型压缩包条目名包含换行或异常编码，已拒绝解压");
  }

  const syntheticTarget = path.resolve(path.dirname(archivePath), "__audit_target__");
  const seenFilesLower = new Set<string>();
  const seenDirsLower = new Set<string>();
  const normalizedEntries: string[] = [];

  for (let i = 0; i < rawNames.length; i += 1) {
    const rawEntry = rawNames[i]!;
    const kind = entryTypes[i]!;
    const { normalized } = validateTarEntryPath(rawEntry, syntheticTarget);
    const lower = normalized.toLowerCase();
    if (kind === "d") {
      if (seenFilesLower.has(lower)) {
        throw new MangaError("PATH_ESCAPE", `模型压缩包存在大小写冲突路径「${normalized}」`);
      }
      seenDirsLower.add(lower);
    } else {
      if (seenFilesLower.has(lower) || seenDirsLower.has(lower)) {
        throw new MangaError("PATH_ESCAPE", `模型压缩包存在重复或大小写冲突文件「${normalized}」`);
      }
      seenFilesLower.add(lower);
    }
    normalizedEntries.push(normalized);
  }

  return { entries: normalizedEntries, totalUncompressedBytes };
}

function walkDirectoryNoSymlinks(rootDir: string): number {
  const rootStat = fs.lstatSync(rootDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new MangaError("PATH_ESCAPE", "模型目录不是有效文件夹或包含符号链接");
  }
  let totalBytes = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new MangaError("PATH_ESCAPE", `模型目录包含不安全的符号链接「${entry.name}」`);
      }
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
      } else {
        throw new MangaError("PATH_ESCAPE", `模型目录包含非常规文件条目「${entry.name}」`);
      }
    }
  }
  return totalBytes;
}

/**
 * Verifies that `modelDir` contains no symlinks/special files and that every required file matches its exact
 * catalog byte size and SHA-256 digest.
 */
export async function verifyRequiredModelFiles(
  modelDir: string,
  requiredFiles: readonly AsrModelRequiredFile[],
  signal?: AbortSignal,
): Promise<{ verifiedFiles: number; installedBytes: number }> {
  if (!fs.existsSync(modelDir)) {
    throw new MangaError("VALIDATION_ERROR", "未找到模型目录");
  }
  const installedBytes = walkDirectoryNoSymlinks(modelDir);
  const resolvedRoot = path.resolve(modelDir);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;

  for (const req of requiredFiles) {
    if (signal?.aborted) {
      throw new MangaError("CANCELLED", "模型校验已取消");
    }
    const segments = req.path.split("/").filter(Boolean);
    const fullPath = path.resolve(resolvedRoot, ...segments);
    if (!fullPath.startsWith(rootPrefix)) {
      throw new MangaError("PATH_ESCAPE", `模型必需文件路径越界：${req.path}`);
    }
    if (!fs.existsSync(fullPath)) {
      throw new MangaError(
        "VALIDATION_ERROR",
        `模型缺少必需文件「${req.path}」，请确认所选模型与目录一致`,
      );
    }
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new MangaError("PATH_ESCAPE", `模型必需文件「${req.path}」不是普通文件`);
    }
    if (stat.size !== req.byteSize) {
      throw new MangaError(
        "VALIDATION_ERROR",
        `模型文件「${req.path}」大小不匹配（预期 ${req.byteSize} 字节，实际 ${stat.size} 字节）`,
      );
    }
    const { sha256 } = await sha256File(fullPath, signal);
    if (sha256.toLowerCase() !== req.sha256.toLowerCase()) {
      throw new MangaError("VALIDATION_ERROR", `模型文件「${req.path}」SHA-256 校验失败，文件可能已损坏`);
    }
  }

  return { verifiedFiles: requiredFiles.length, installedBytes };
}

function locateExtractedModelRoot(extractDir: string, model: AsrCatalogModel): string {
  const namedSubdir = path.join(extractDir, model.topLevelDirectory);
  if (fs.existsSync(namedSubdir) && fs.lstatSync(namedSubdir).isDirectory()) {
    return namedSubdir;
  }
  const firstRequired = model.requiredFiles[0];
  if (firstRequired) {
    const directCandidate = path.join(extractDir, ...firstRequired.path.split("/"));
    if (fs.existsSync(directCandidate)) {
      return extractDir;
    }
  }
  const children = fs.readdirSync(extractDir, { withFileTypes: true });
  if (children.length === 1 && children[0]!.isDirectory()) {
    return path.join(extractDir, children[0]!.name);
  }
  return extractDir;
}

export function atomicReplaceDirectory(stagedSourceDir: string, finalTargetDir: string, stagingParentDir: string): void {
  fs.mkdirSync(path.dirname(finalTargetDir), { recursive: true });
  fs.mkdirSync(stagingParentDir, { recursive: true });
  const backupDir = path.join(
    stagingParentDir,
    `backup-${path.basename(finalTargetDir)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let movedOld = false;
  try {
    if (fs.existsSync(finalTargetDir)) {
      fs.renameSync(finalTargetDir, backupDir);
      movedOld = true;
    }
    fs.renameSync(stagedSourceDir, finalTargetDir);
    if (movedOld) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (movedOld && !fs.existsSync(finalTargetDir) && fs.existsSync(backupDir)) {
      try {
        fs.renameSync(backupDir, finalTargetDir);
      } catch {
        // best-effort rollback
      }
    }
    const errCode = (error as NodeJS.ErrnoException | undefined)?.code;
    if (errCode === "ENOSPC") {
      throw new MangaError("DISK_FULL", "磁盘空间不足，无法安装本地语音模型", { cause: error });
    }
    throw error;
  }
}

export type ExtractModelArchiveOptions = {
  archivePath: string;
  model: AsrCatalogModel;
  stagingDir: string;
  finalModelDir: string;
  maxUncompressedBytes?: number;
  tarExe?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

/**
 * Verifies archive size & SHA-256, audits tar entries before extraction, extracts into `.staging`, verifies all
 * inner `requiredFiles` sizes & SHA-256s, and atomically installs into `finalModelDir`. Always cleans temporary
 * extraction directories on success or failure.
 */
export async function extractAndVerifyModelArchive(
  options: ExtractModelArchiveOptions,
): Promise<{ installedBytes: number }> {
  const tarExe = resolveSystemTarExe({ env: options.env, explicitTarExe: options.tarExe });
  if (!fs.existsSync(options.archivePath)) {
    throw new MangaError("NOT_FOUND", "未找到待校验的模型压缩包");
  }
  const archiveStat = fs.lstatSync(options.archivePath);
  if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) {
    throw new MangaError("PATH_ESCAPE", "模型压缩包路径不是普通文件");
  }
  if (archiveStat.size !== options.model.archiveBytes) {
    throw new MangaError(
      "VALIDATION_ERROR",
      `模型压缩包大小不匹配（预期 ${options.model.archiveBytes} 字节，实际 ${archiveStat.size} 字节）`,
    );
  }
  const { sha256: archiveHash } = await sha256File(options.archivePath, options.signal);
  if (archiveHash.toLowerCase() !== options.model.archiveSha256.toLowerCase()) {
    throw new MangaError("VALIDATION_ERROR", "模型压缩包 SHA-256 校验失败，下载文件可能已损坏");
  }

  const requiredSum = sumRequiredModelBytes(options.model);
  const defaultCap = Math.max(requiredSum * 2 + 32 * 1024 * 1024, options.model.archiveBytes * 4, 64 * 1024 * 1024);
  const maxUncompressedBytes = options.maxUncompressedBytes ?? defaultCap;

  await inspectTarArchive(options.archivePath, {
    tarExe,
    maxUncompressedBytes,
    signal: options.signal,
    env: options.env,
  });

  fs.mkdirSync(options.stagingDir, { recursive: true });
  const extractDir = path.join(
    options.stagingDir,
    `extract-${options.model.modelId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await runTarCommand(tarExe, ["-xjf", options.archivePath, "-C", extractDir], {
      signal: options.signal,
      env: options.env,
    });
    walkDirectoryNoSymlinks(extractDir);
    const extractedRoot = locateExtractedModelRoot(extractDir, options.model);
    const { installedBytes } = await verifyRequiredModelFiles(
      extractedRoot,
      options.model.requiredFiles,
      options.signal,
    );

    if (extractedRoot === extractDir) {
      const innerMoveDir = path.join(
        options.stagingDir,
        `ready-${options.model.modelId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      fs.renameSync(extractDir, innerMoveDir);
      try {
        atomicReplaceDirectory(innerMoveDir, options.finalModelDir, options.stagingDir);
      } finally {
        fs.rmSync(innerMoveDir, { recursive: true, force: true });
      }
    } else {
      atomicReplaceDirectory(extractedRoot, options.finalModelDir, options.stagingDir);
    }
    return { installedBytes };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}
