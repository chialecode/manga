import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { MangaError, type LocalAsrModelSource, type LocalAsrModelState } from "@manga/contracts";
import { ALLOWED_MODEL_DOWNLOAD_HOSTS, type AsrCatalogModel } from "./catalog.ts";
import { extractAndVerifyModelArchive, sha256File } from "./tar-extract.ts";

const MAX_REDIRECT_HOPS = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export type StagingDownloadState = {
  bytes: number;
  etag: string | null;
  sourceUrl: string;
  sourceId?: string;
  partSha256?: string;
};

export type ModelDownloadProgress = {
  modelId: string;
  state: LocalAsrModelState;
  downloadedBytes: number;
  totalBytes: number;
  sourceId?: string;
  errorMessage?: string | null;
};

export type ValidateDownloadUrlOptions = {
  allowedHosts?: readonly string[];
  allowLoopbackHttp?: boolean;
};

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "::1" || lower === "[::1]";
}

function isIpLiteral(hostname: string): boolean {
  const stripped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return net.isIP(stripped) !== 0;
}

export function validateModelDownloadUrl(rawUrl: string, options: ValidateDownloadUrlOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new MangaError("VALIDATION_ERROR", `无效的模型下载地址：${rawUrl}`, { cause: error });
  }

  if (parsed.username || parsed.password) {
    throw new MangaError("FORBIDDEN", "模型下载地址不允许包含凭据信息");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (options.allowLoopbackHttp && isLoopbackHost(hostname)) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new MangaError("FORBIDDEN", `不支持的下载协议：${parsed.protocol}`);
    }
    return parsed;
  }

  if (parsed.protocol !== "https:") {
    throw new MangaError("FORBIDDEN", `模型下载仅允许 HTTPS 协议（拒绝 ${parsed.protocol}）`);
  }

  if (isLoopbackHost(hostname) || isIpLiteral(hostname)) {
    throw new MangaError("FORBIDDEN", `模型下载不允许访问本地或 IP 字面量地址（${hostname}）`);
  }

  const allowedSet = new Set((options.allowedHosts ?? ALLOWED_MODEL_DOWNLOAD_HOSTS).map((h) => h.toLowerCase()));
  if (!allowedSet.has(hostname)) {
    throw new MangaError("FORBIDDEN", `模型下载域名不在允许列表中（${hostname}）`);
  }

  return parsed;
}

export function stagingPartPath(stagingDir: string, modelId: string): string {
  return path.join(stagingDir, `${modelId}.part`);
}

export function stagingStatePath(stagingDir: string, modelId: string): string {
  return path.join(stagingDir, `${modelId}.state.json`);
}

export function readStagingState(stagingDir: string, modelId: string): StagingDownloadState | null {
  const stateFile = stagingStatePath(stagingDir, modelId);
  const partFile = stagingPartPath(stagingDir, modelId);
  if (!fs.existsSync(stateFile) || !fs.existsSync(partFile)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Partial<StagingDownloadState>;
    if (typeof parsed.bytes !== "number" || !Number.isFinite(parsed.bytes) || parsed.bytes < 0) return null;
    if (typeof parsed.sourceUrl !== "string" || !parsed.sourceUrl) return null;
    const partStat = fs.lstatSync(partFile);
    if (!partStat.isFile() || partStat.isSymbolicLink() || partStat.size !== parsed.bytes) return null;
    return {
      bytes: parsed.bytes,
      etag: typeof parsed.etag === "string" ? parsed.etag : null,
      sourceUrl: parsed.sourceUrl,
      ...(typeof parsed.sourceId === "string" ? { sourceId: parsed.sourceId } : {}),
      ...(typeof parsed.partSha256 === "string" ? { partSha256: parsed.partSha256 } : {}),
    };
  } catch {
    return null;
  }
}

function writeStagingState(stagingDir: string, modelId: string, state: StagingDownloadState): void {
  fs.mkdirSync(stagingDir, { recursive: true });
  const target = stagingStatePath(stagingDir, modelId);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") {
      throw new MangaError("DISK_FULL", "磁盘空间不足，无法写入下载断点状态", { cause: error });
    }
    throw error;
  }
}

export function cleanModelStaging(stagingDir: string, modelId: string): number {
  if (!fs.existsSync(stagingDir)) return 0;
  let freed = 0;
  const prefixes = [`${modelId}.part`, `${modelId}.state.json`, `extract-${modelId}-`, `ready-${modelId}-`, `import-${modelId}-`, `backup-${modelId}-`];
  for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
    if (!prefixes.some((prefix) => entry.name === prefix || entry.name.startsWith(prefix))) continue;
    const full = path.join(stagingDir, entry.name);
    try {
      freed += measurePathBytes(full);
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
  return freed;
}

export function measurePathBytes(targetPath: string): number {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let sum = 0;
  for (const child of fs.readdirSync(targetPath, { withFileTypes: true })) {
    sum += measurePathBytes(path.join(targetPath, child.name));
  }
  return sum;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithValidatedRedirects(
  initialUrl: string,
  headers: Record<string, string>,
  options: {
    fetchImpl: typeof fetch;
    allowedHosts?: readonly string[];
    allowLoopbackHttp?: boolean;
    connectTimeoutMs: number;
    signal: AbortSignal;
  },
): Promise<Response> {
  let currentUrl = validateModelDownloadUrl(initialUrl, options).toString();
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const hopAbort = new AbortController();
    const timer = setTimeout(() => hopAbort.abort(), options.connectTimeoutMs);
    timer.unref?.();
    const onParentAbort = () => hopAbort.abort();
    options.signal.addEventListener("abort", onParentAbort, { once: true });

    let response: Response;
    try {
      response = await options.fetchImpl(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: hopAbort.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onParentAbort);
      if (options.signal.aborted) {
        throw new MangaError("CANCELLED", "模型下载已取消");
      }
      throw new MangaError(
        "PROVIDER_UNAVAILABLE",
        `无法连接模型下载源：${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onParentAbort);
    }

    if (isRedirectStatus(response.status)) {
      void response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECT_HOPS) {
        throw new MangaError("FORBIDDEN", `模型下载重定向次数超过上限（${MAX_REDIRECT_HOPS} 次）`);
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new MangaError("PROVIDER_UNAVAILABLE", "模型下载源返回了缺少目标地址的重定向响应", { retryable: true });
      }
      const resolvedNext = new URL(location, currentUrl).toString();
      currentUrl = validateModelDownloadUrl(resolvedNext, options).toString();
      continue;
    }

    return response;
  }

  throw new MangaError("FORBIDDEN", "模型下载重定向次数超过上限");
}

function parseContentRangeStart(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const match = /^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/i.exec(headerValue.trim());
  if (!match) return null;
  const start = Number(match[1]);
  return Number.isFinite(start) && start >= 0 ? start : null;
}

export type ModelDownloaderOptions = {
  stagingDir: string;
  asrModelsDir: string;
  fetchImpl?: typeof fetch;
  allowedHosts?: readonly string[];
  allowLoopbackHttp?: boolean;
  connectTimeoutMs?: number;
  tarExe?: string;
  env?: NodeJS.ProcessEnv;
  maxUncompressedBytes?: number;
  getAvailableDiskBytes?: (dir: string) => number | Promise<number>;
};

export type DownloadModelInput = {
  model: AsrCatalogModel;
  confirmed: boolean;
  sourceId?: string;
  fallbackOnSourceError?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: ModelDownloadProgress) => void;
};

export type DownloadModelResult = {
  installedBytes: number;
  source: LocalAsrModelSource;
};

type ActiveControl = {
  controller: AbortController;
  intent: "none" | "pause" | "cancel";
  promise: Promise<DownloadModelResult>;
};

export class ModelDownloader {
  private readonly stagingDir: string;
  private readonly asrModelsDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly allowedHosts: readonly string[];
  private readonly allowLoopbackHttp: boolean;
  private readonly connectTimeoutMs: number;
  private readonly tarExe: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly maxUncompressedBytes: number | undefined;
  private readonly getAvailableDiskBytes: ((dir: string) => number | Promise<number>) | undefined;
  private readonly active = new Map<string, ActiveControl>();

  constructor(options: ModelDownloaderOptions) {
    this.stagingDir = options.stagingDir;
    this.asrModelsDir = options.asrModelsDir;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.allowedHosts = options.allowedHosts ?? ALLOWED_MODEL_DOWNLOAD_HOSTS;
    this.allowLoopbackHttp = options.allowLoopbackHttp ?? false;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.tarExe = options.tarExe;
    this.env = options.env;
    this.maxUncompressedBytes = options.maxUncompressedBytes;
    this.getAvailableDiskBytes = options.getAvailableDiskBytes;
  }

  isActive(modelId: string): boolean {
    return this.active.has(modelId);
  }

  async pause(modelId: string): Promise<{ paused: boolean; downloadedBytes: number }> {
    const running = this.active.get(modelId);
    if (running) {
      running.intent = "pause";
      running.controller.abort();
      try {
        await running.promise;
      } catch {
        // expected pause cancellation
      }
    }
    const state = readStagingState(this.stagingDir, modelId);
    return { paused: state !== null, downloadedBytes: state?.bytes ?? 0 };
  }

  async cancel(modelId: string): Promise<{ cancelled: boolean }> {
    const running = this.active.get(modelId);
    if (running) {
      running.intent = "cancel";
      running.controller.abort();
      try {
        await running.promise;
      } catch {
        // expected cancel
      }
    }
    cleanModelStaging(this.stagingDir, modelId);
    return { cancelled: true };
  }

  async download(input: DownloadModelInput): Promise<DownloadModelResult> {
    if (input.confirmed !== true) {
      throw new MangaError("FORBIDDEN", "下载本地语音模型前必须先确认体积与来源");
    }

    const existing = this.active.get(input.model.modelId);
    if (existing) {
      return existing.promise;
    }

    const sources = this.selectCandidateSources(input.model, input.sourceId, input.fallbackOnSourceError ?? true);
    const controller = new AbortController();
    const control: ActiveControl = {
      controller,
      intent: "none",
      promise: Promise.resolve({ installedBytes: 0, source: sources[0]! }),
    };

    const onExternalAbort = () => {
      if (control.intent === "none") control.intent = "cancel";
      controller.abort();
    };
    if (input.signal?.aborted) {
      onExternalAbort();
    } else {
      input.signal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    const runPromise = this.executeDownload(input, sources, control).finally(() => {
      input.signal?.removeEventListener("abort", onExternalAbort);
      if (this.active.get(input.model.modelId) === control) {
        this.active.delete(input.model.modelId);
      }
    });

    control.promise = runPromise;
    this.active.set(input.model.modelId, control);
    return runPromise;
  }

  private selectCandidateSources(
    model: AsrCatalogModel,
    sourceId: string | undefined,
    allowFallback: boolean,
  ): LocalAsrModelSource[] {
    if (model.sources.length === 0) {
      throw new MangaError("VALIDATION_ERROR", `模型「${model.modelId}」未配置可用下载源`);
    }
    if (!sourceId) {
      return [...model.sources];
    }
    const chosen = model.sources.find((item) => item.id === sourceId);
    if (!chosen) {
      throw new MangaError("VALIDATION_ERROR", `未知的模型下载源：${sourceId}`);
    }
    if (!allowFallback) {
      return [chosen];
    }
    return [chosen, ...model.sources.filter((item) => item.id !== chosen.id)];
  }

  private async verifyDiskSpace(model: AsrCatalogModel): Promise<void> {
    fs.mkdirSync(this.stagingDir, { recursive: true });
    const requiredBytes = model.archiveBytes * 2 + 64 * 1024 * 1024;
    if (this.getAvailableDiskBytes) {
      const freeBytes = await this.getAvailableDiskBytes(this.stagingDir);
      if (freeBytes < requiredBytes) {
        throw new MangaError(
          "DISK_FULL",
          `磁盘可用空间不足（需要至少 ${Math.ceil(requiredBytes / (1024 * 1024))} MB），请清理空间后重试`,
        );
      }
      return;
    }
    if (typeof fs.statfsSync === "function") {
      try {
        const stats = fs.statfsSync(this.stagingDir);
        const freeBytes = Number(stats.bavail) * Number(stats.bsize);
        if (Number.isFinite(freeBytes) && freeBytes > 0 && freeBytes < requiredBytes) {
          throw new MangaError(
            "DISK_FULL",
            `磁盘可用空间不足（需要至少 ${Math.ceil(requiredBytes / (1024 * 1024))} MB），请清理空间后重试`,
          );
        }
      } catch (error) {
        if (error instanceof MangaError) throw error;
      }
    }
  }

  private async executeDownload(
    input: DownloadModelInput,
    sources: readonly LocalAsrModelSource[],
    control: ActiveControl,
  ): Promise<DownloadModelResult> {
    await this.verifyDiskSpace(input.model);

    let lastError: unknown = null;
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      const hasMoreSources = index + 1 < sources.length;
      try {
        const installedBytes = await this.downloadAndExtractFromSource(input, source, control, hasMoreSources);
        return { installedBytes, source };
      } catch (error) {
        lastError = error;
        if (control.intent === "pause") {
          throw error;
        }
        if (control.intent === "cancel" || (error instanceof MangaError && error.code === "CANCELLED")) {
          cleanModelStaging(this.stagingDir, input.model.modelId);
          throw error;
        }
        if (error instanceof MangaError && (error.code === "DISK_FULL" || error.code === "CAPABILITY_UNAVAILABLE")) {
          cleanModelStaging(this.stagingDir, input.model.modelId);
          throw error;
        }
        if (hasMoreSources) {
          cleanModelStaging(this.stagingDir, input.model.modelId);
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new MangaError("PROVIDER_UNAVAILABLE", "所有模型下载源均不可用", { retryable: true });
  }

  private async prepareResumeState(
    model: AsrCatalogModel,
    source: LocalAsrModelSource,
    signal: AbortSignal,
  ): Promise<{ offset: number; etag: string | null; alreadyComplete: boolean }> {
    const partFile = stagingPartPath(this.stagingDir, model.modelId);
    const saved = readStagingState(this.stagingDir, model.modelId);
    if (!saved || saved.sourceUrl !== source.url || !fs.existsSync(partFile)) {
      if (fs.existsSync(partFile) || fs.existsSync(stagingStatePath(this.stagingDir, model.modelId))) {
        cleanModelStaging(this.stagingDir, model.modelId);
      }
      return { offset: 0, etag: null, alreadyComplete: false };
    }

    const actual = await sha256File(partFile, signal);
    if (
      actual.bytes === model.archiveBytes &&
      actual.sha256.toLowerCase() === model.archiveSha256.toLowerCase()
    ) {
      return { offset: actual.bytes, etag: saved.etag, alreadyComplete: true };
    }

    if (
      actual.bytes > 0 &&
      actual.bytes < model.archiveBytes &&
      actual.bytes === saved.bytes &&
      (!saved.partSha256 || actual.sha256.toLowerCase() === saved.partSha256.toLowerCase())
    ) {
      return { offset: actual.bytes, etag: saved.etag, alreadyComplete: false };
    }

    cleanModelStaging(this.stagingDir, model.modelId);
    return { offset: 0, etag: null, alreadyComplete: false };
  }

  private async downloadAndExtractFromSource(
    input: DownloadModelInput,
    source: LocalAsrModelSource,
    control: ActiveControl,
    hasMoreSources: boolean,
  ): Promise<number> {
    const { model } = input;
    const partFile = stagingPartPath(this.stagingDir, model.modelId);
    fs.mkdirSync(this.stagingDir, { recursive: true });

    let resume = await this.prepareResumeState(model, source, control.controller.signal);

    if (!resume.alreadyComplete) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const headers: Record<string, string> = {};
        if (resume.offset > 0) {
          headers.Range = `bytes=${resume.offset}-`;
        }

        const response = await fetchWithValidatedRedirects(source.url, headers, {
          fetchImpl: this.fetchImpl,
          allowedHosts: this.allowedHosts,
          allowLoopbackHttp: this.allowLoopbackHttp,
          connectTimeoutMs: this.connectTimeoutMs,
          signal: control.controller.signal,
        });

        if (resume.offset > 0 && response.status === 416) {
          void response.body?.cancel().catch(() => {});
          cleanModelStaging(this.stagingDir, model.modelId);
          resume = { offset: 0, etag: null, alreadyComplete: false };
          continue;
        }

        if (resume.offset > 0 && response.status === 206) {
          const responseEtag = response.headers.get("etag");
          const rangeStart = parseContentRangeStart(response.headers.get("content-range"));
          const etagChanged = Boolean(resume.etag && responseEtag && responseEtag !== resume.etag);
          const rangeMismatch = rangeStart !== null && rangeStart !== resume.offset;
          if (etagChanged || rangeMismatch) {
            void response.body?.cancel().catch(() => {});
            cleanModelStaging(this.stagingDir, model.modelId);
            resume = { offset: 0, etag: null, alreadyComplete: false };
            continue;
          }
          await this.streamBodyToPart({
            response,
            partFile,
            appendFromOffset: resume.offset,
            etag: responseEtag ?? resume.etag,
            source,
            model,
            control,
            hasMoreSources,
            onProgress: input.onProgress,
          });
          break;
        }

        if (response.status === 200) {
          const responseEtag = response.headers.get("etag");
          await this.streamBodyToPart({
            response,
            partFile,
            appendFromOffset: 0,
            etag: responseEtag,
            source,
            model,
            control,
            hasMoreSources,
            onProgress: input.onProgress,
          });
          break;
        }

        void response.body?.cancel().catch(() => {});
        throw new MangaError(
          "PROVIDER_UNAVAILABLE",
          `模型下载源「${source.label}」返回异常状态（HTTP ${response.status}）`,
          { retryable: response.status >= 500 || response.status === 429 },
        );
      }
    }

    input.onProgress?.({
      modelId: model.modelId,
      state: "verifying",
      downloadedBytes: model.archiveBytes,
      totalBytes: model.archiveBytes,
      sourceId: source.id,
    });

    const finalModelDir = path.join(this.asrModelsDir, model.modelId);
    try {
      const { installedBytes } = await extractAndVerifyModelArchive({
        archivePath: partFile,
        model,
        stagingDir: this.stagingDir,
        finalModelDir,
        maxUncompressedBytes: this.maxUncompressedBytes,
        tarExe: this.tarExe,
        env: this.env,
        signal: control.controller.signal,
      });
      cleanModelStaging(this.stagingDir, model.modelId);
      return installedBytes;
    } catch (error) {
      cleanModelStaging(this.stagingDir, model.modelId);
      throw error;
    }
  }

  private async streamBodyToPart(params: {
    response: Response;
    partFile: string;
    appendFromOffset: number;
    etag: string | null;
    source: LocalAsrModelSource;
    model: AsrCatalogModel;
    control: ActiveControl;
    hasMoreSources: boolean;
    onProgress?: (progress: ModelDownloadProgress) => void;
  }): Promise<void> {
    const { response, partFile, appendFromOffset, etag, source, model, control, hasMoreSources, onProgress } = params;
    if (!response.body) {
      throw new MangaError("PROVIDER_UNAVAILABLE", "模型下载响应缺少数据流", { retryable: true });
    }

    let downloadedBytes = appendFromOffset;
    onProgress?.({
      modelId: model.modelId,
      state: "downloading",
      downloadedBytes,
      totalBytes: model.archiveBytes,
      sourceId: source.id,
    });

    let fd: number | null = null;
    const reader = response.body.getReader();
    try {
      fd = fs.openSync(partFile, appendFromOffset > 0 ? "a" : "w");
      writeStagingState(this.stagingDir, model.modelId, {
        bytes: downloadedBytes,
        etag,
        sourceUrl: source.url,
        sourceId: source.id,
      });

      while (true) {
        if (control.controller.signal.aborted) {
          throw new MangaError("CANCELLED", control.intent === "pause" ? "模型下载已暂停" : "模型下载已取消");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        downloadedBytes += value.byteLength;
        if (downloadedBytes > model.archiveBytes) {
          throw new MangaError(
            "VALIDATION_ERROR",
            `模型下载体积超出目录声明上限（${downloadedBytes} 字节 > ${model.archiveBytes} 字节）`,
          );
        }

        let offset = 0;
        while (offset < value.byteLength) {
          const written = fs.writeSync(fd, value, offset, value.byteLength - offset);
          offset += written;
        }

        onProgress?.({
          modelId: model.modelId,
          state: "downloading",
          downloadedBytes,
          totalBytes: model.archiveBytes,
          sourceId: source.id,
        });
      }

      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      if (downloadedBytes < model.archiveBytes) {
        throw new MangaError(
          "PROVIDER_UNAVAILABLE",
          `模型下载连接提前中断（已接收 ${downloadedBytes} / ${model.archiveBytes} 字节）`,
          { retryable: true },
        );
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close error
        }
        fd = null;
      }

      const errno = (error as NodeJS.ErrnoException | undefined)?.code;
      if (errno === "ENOSPC") {
        cleanModelStaging(this.stagingDir, model.modelId);
        throw new MangaError("DISK_FULL", "磁盘空间不足，无法完成语音模型下载", { cause: error });
      }

      if (control.intent === "pause") {
        await this.persistPartialCheckpoint(partFile, model.modelId, etag, source);
        const state = readStagingState(this.stagingDir, model.modelId);
        onProgress?.({
          modelId: model.modelId,
          state: "paused",
          downloadedBytes: state?.bytes ?? downloadedBytes,
          totalBytes: model.archiveBytes,
          sourceId: source.id,
        });
        throw new MangaError("CANCELLED", "模型下载已暂停", {
          details: { paused: true, modelId: model.modelId, downloadedBytes: state?.bytes ?? downloadedBytes },
        });
      }

      if (control.intent === "cancel") {
        cleanModelStaging(this.stagingDir, model.modelId);
        throw new MangaError("CANCELLED", "模型下载已取消", {
          details: { cancelled: true, modelId: model.modelId },
        });
      }

      if (error instanceof MangaError && error.code === "VALIDATION_ERROR") {
        cleanModelStaging(this.stagingDir, model.modelId);
        throw error;
      }

      if (!hasMoreSources && fs.existsSync(partFile)) {
        const size = fs.statSync(partFile).size;
        if (size > 0 && size < model.archiveBytes) {
          await this.persistPartialCheckpoint(partFile, model.modelId, etag, source);
        } else {
          cleanModelStaging(this.stagingDir, model.modelId);
        }
      }

      if (error instanceof MangaError) throw error;
      throw new MangaError(
        "PROVIDER_UNAVAILABLE",
        `模型下载中断：${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, cause: error },
      );
    }
  }

  private async persistPartialCheckpoint(
    partFile: string,
    modelId: string,
    etag: string | null,
    source: LocalAsrModelSource,
  ): Promise<void> {
    if (!fs.existsSync(partFile)) return;
    const { bytes, sha256 } = await sha256File(partFile);
    if (bytes <= 0) {
      cleanModelStaging(this.stagingDir, modelId);
      return;
    }
    writeStagingState(this.stagingDir, modelId, {
      bytes,
      etag,
      sourceUrl: source.url,
      sourceId: source.id,
      partSha256: sha256,
    });
  }
}
