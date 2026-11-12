import fs from "node:fs";
import path from "node:path";
import { MangaError, type LocalAsrModelItem, type LocalAsrModelState } from "@manga/contracts";
import type { JobQueue } from "../../media/job-queue.ts";
import {
  ASR_MODEL_CATALOG,
  getCatalogModel,
  resolveModelRuntimeFiles,
  type AsrCatalogModel,
  type AsrCatalogModelKind,
} from "./catalog.ts";
import {
  ModelDownloader,
  cleanModelStaging,
  measurePathBytes,
  readStagingState,
  type ModelDownloadProgress,
} from "./downloader.ts";
import {
  atomicReplaceDirectory,
  extractAndVerifyModelArchive,
  verifyRequiredModelFiles,
} from "./tar-extract.ts";

export type InstalledAsrModelRecord = {
  modelId: string;
  kind: AsrCatalogModelKind;
  archiveSha256: string;
  installedBytes: number;
  installedAt: string;
  source: string;
};

type InstalledManifestFile = {
  version: 1;
  models: Record<string, InstalledAsrModelRecord>;
};

export type RuntimeModelStatusView = {
  status: "unloaded" | "loading" | "loaded" | "load_failed";
  reason?: string;
};

export type AsrModelServiceOptions = {
  /** Application data root (`<appRoot>/models/...`); ignored when `modelsDir` is given directly. */
  appRoot?: string;
  /** Explicit `<appRoot>/models` directory override. */
  modelsDir?: string;
  catalog?: readonly AsrCatalogModel[];
  jobs?: JobQueue;
  fetchImpl?: typeof fetch;
  allowedHosts?: readonly string[];
  allowLoopbackHttp?: boolean;
  connectTimeoutMs?: number;
  tarExe?: string;
  env?: NodeJS.ProcessEnv;
  maxUncompressedBytes?: number;
  getAvailableDiskBytes?: (dir: string) => number | Promise<number>;
  /** Optional hook to unload a model from the `AsrService` utilityProcess before deleting or replacing its files. */
  unloadModel?: (modelId: string) => Promise<void> | void;
  /** Optional hook to clear a cached `load_failed` state in `AsrService` after reinstalling or deleting a model. */
  resetRuntimeModelStatus?: (modelId: string) => void;
  /** Optional hook to surface live `loading` / `ready` / `load_failed` runtime status in `list()`. */
  getRuntimeStatus?: (modelId: string) => RuntimeModelStatusView | undefined;
  onProgress?: (progress: ModelDownloadProgress) => void;
  now?: () => Date;
};

function copyDirectoryRegularFiles(srcDir: string, dstDir: string): void {
  const srcStat = fs.lstatSync(srcDir);
  if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
    throw new MangaError("PATH_ESCAPE", "导入源路径不是普通文件夹或包含符号链接");
  }
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcChild = path.join(srcDir, entry.name);
    const dstChild = path.join(dstDir, entry.name);
    const stat = fs.lstatSync(srcChild);
    if (stat.isSymbolicLink()) {
      throw new MangaError("PATH_ESCAPE", `导入文件夹包含符号链接「${entry.name}」，已拒绝导入`);
    }
    if (stat.isDirectory()) {
      copyDirectoryRegularFiles(srcChild, dstChild);
    } else if (stat.isFile()) {
      try {
        fs.copyFileSync(srcChild, dstChild);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") {
          throw new MangaError("DISK_FULL", "磁盘空间不足，无法导入本地语音模型", { cause: error });
        }
        throw error;
      }
    } else {
      throw new MangaError("PATH_ESCAPE", `导入文件夹包含非常规文件「${entry.name}」`);
    }
  }
}

export class AsrModelService {
  readonly modelsDir: string;
  readonly stagingDir: string;
  readonly asrModelsDir: string;
  readonly manifestPath: string;
  private catalog: readonly AsrCatalogModel[];
  private readonly allowLoopbackHttp: boolean;
  private readonly downloader: ModelDownloader;
  private readonly jobs: JobQueue | undefined;
  private readonly tarExe: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly maxUncompressedBytes: number | undefined;
  private readonly unloadModelHook: ((modelId: string) => Promise<void> | void) | undefined;
  private readonly resetRuntimeStatusHook: ((modelId: string) => void) | undefined;
  private readonly getRuntimeStatusHook: ((modelId: string) => RuntimeModelStatusView | undefined) | undefined;
  private readonly onProgressHook: ((progress: ModelDownloadProgress) => void) | undefined;
  private readonly now: () => Date;
  private readonly transientStates = new Map<
    string,
    { state: LocalAsrModelState; downloadedBytes?: number; totalBytes?: number; errorMessage?: string | null }
  >();

  constructor(options: AsrModelServiceOptions) {
    const resolvedModelsDir = options.modelsDir
      ? path.resolve(options.modelsDir)
      : options.appRoot
        ? path.join(path.resolve(options.appRoot), "models")
        : null;
    if (!resolvedModelsDir) {
      throw new Error("AsrModelService requires either appRoot or modelsDir");
    }
    this.modelsDir = resolvedModelsDir;
    this.stagingDir = path.join(this.modelsDir, ".staging");
    this.asrModelsDir = path.join(this.modelsDir, "asr");
    this.manifestPath = path.join(this.modelsDir, "installed.json");
    this.catalog = options.catalog ?? ASR_MODEL_CATALOG;
    this.allowLoopbackHttp = Boolean(options.allowLoopbackHttp);
    this.jobs = options.jobs;
    this.tarExe = options.tarExe;
    this.env = options.env;
    this.maxUncompressedBytes = options.maxUncompressedBytes;
    this.unloadModelHook = options.unloadModel;
    this.resetRuntimeStatusHook = options.resetRuntimeModelStatus;
    this.getRuntimeStatusHook = options.getRuntimeStatus;
    this.onProgressHook = options.onProgress;
    this.now = options.now ?? (() => new Date());

    this.downloader = new ModelDownloader({
      stagingDir: this.stagingDir,
      asrModelsDir: this.asrModelsDir,
      fetchImpl: options.fetchImpl,
      allowedHosts: options.allowedHosts,
      allowLoopbackHttp: options.allowLoopbackHttp,
      connectTimeoutMs: options.connectTimeoutMs,
      tarExe: options.tarExe,
      env: options.env,
      maxUncompressedBytes: options.maxUncompressedBytes,
      getAvailableDiskBytes: options.getAvailableDiskBytes,
    });
  }

  getCatalog(): readonly AsrCatalogModel[] {
    return this.catalog;
  }

  /** Loopback smoke override only: requires `allowLoopbackHttp: true` at service construction. */
  setLoopbackCatalog(catalog: readonly AsrCatalogModel[]): void {
    if (!this.allowLoopbackHttp) {
      throw new MangaError("FORBIDDEN", "仅回环冒烟环境允许覆盖本地模型目录");
    }
    this.catalog = catalog;
    this.transientStates.clear();
  }

  getCatalogEntry(modelId: string): AsrCatalogModel {
    const found = getCatalogModel(modelId, this.catalog);
    if (!found) {
      throw new MangaError("NOT_FOUND", `未知的本地语音识别模型：${modelId}`);
    }
    return found;
  }

  getInstallDir(modelId: string): string {
    const entry = this.getCatalogEntry(modelId);
    return path.join(this.asrModelsDir, entry.modelId);
  }

  isInstalled(modelId: string): boolean {
    return this.getInstalledRecord(modelId) !== null;
  }

  getInstalledRecord(modelId: string): InstalledAsrModelRecord | null {
    const manifest = this.readManifest();
    const record = manifest.models[modelId];
    if (!record) return null;
    const dir = path.join(this.asrModelsDir, modelId);
    if (!fs.existsSync(dir)) return null;
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    } catch {
      return null;
    }
    return record;
  }

  /**
   * Resolves verified local model runtime paths for `AsrService.load`.
   * Throws `CAPABILITY_UNAVAILABLE` if the model has not been downloaded/imported yet.
   */
  getRuntimeFiles(modelId: string): {
    model: AsrCatalogModel;
    installDir: string;
    files: Record<string, string>;
  } {
    const model = this.getCatalogEntry(modelId);
    const record = this.getInstalledRecord(model.modelId);
    const installDir = path.join(this.asrModelsDir, model.modelId);
    if (!record) {
      throw new MangaError(
        "CAPABILITY_UNAVAILABLE",
        `本地语音模型「${model.name}」尚未安装，请前往「设置 › 语音转录」下载或导入模型`,
        { details: { modelId: model.modelId, reason: "model_not_installed" } },
      );
    }
    const files = resolveModelRuntimeFiles(model, installDir);
    for (const req of model.requiredFiles) {
      const fullPath = path.join(installDir, ...req.path.split("/"));
      if (!fs.existsSync(fullPath)) {
        throw new MangaError(
          "CAPABILITY_UNAVAILABLE",
          `本地语音模型「${model.name}」缺少文件「${req.path}」，请在「设置 › 语音转录」重新安装`,
          { details: { modelId: model.modelId, missingFile: req.path } },
        );
      }
    }
    return { model, installDir, files };
  }

  list(): LocalAsrModelItem[] {
    const manifest = this.readManifest();
    return this.catalog.map((entry) => this.buildModelItem(entry, manifest));
  }

  getItem(modelId: string): LocalAsrModelItem {
    const entry = this.getCatalogEntry(modelId);
    return this.buildModelItem(entry, this.readManifest());
  }

  async download(input: {
    modelId: string;
    confirmed: boolean;
    sourceId?: string;
    fallbackOnSourceError?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: ModelDownloadProgress) => void;
  }): Promise<LocalAsrModelItem> {
    if (input.confirmed !== true) {
      throw new MangaError("FORBIDDEN", "下载本地语音模型前必须先确认体积与来源");
    }
    const model = this.getCatalogEntry(input.modelId);

    const execute = async (jobSignal?: AbortSignal, reportJobProgress?: (fraction: number) => void) => {
      const mergedController = new AbortController();
      const abortMerged = () => mergedController.abort();
      if (input.signal?.aborted || jobSignal?.aborted) {
        mergedController.abort();
      } else {
        input.signal?.addEventListener("abort", abortMerged, { once: true });
        jobSignal?.addEventListener("abort", abortMerged, { once: true });
      }

      const handleProgress = (progress: ModelDownloadProgress) => {
        this.transientStates.set(model.modelId, {
          state: progress.state,
          downloadedBytes: progress.downloadedBytes,
          totalBytes: progress.totalBytes,
          errorMessage: progress.errorMessage ?? null,
        });
        if (progress.totalBytes > 0) {
          reportJobProgress?.(progress.downloadedBytes / progress.totalBytes);
        }
        this.onProgressHook?.(progress);
        input.onProgress?.(progress);
      };

      try {
        if (this.isInstalled(model.modelId)) {
          await this.unloadModelHook?.(model.modelId);
        }
        const result = await this.downloader.download({
          model,
          confirmed: input.confirmed,
          sourceId: input.sourceId,
          fallbackOnSourceError: input.fallbackOnSourceError,
          signal: mergedController.signal,
          onProgress: handleProgress,
        });

        this.recordInstalled({
          modelId: model.modelId,
          kind: model.kind,
          archiveSha256: model.archiveSha256,
          installedBytes: result.installedBytes,
          installedAt: this.now().toISOString(),
          source: result.source.id,
        });
        this.transientStates.delete(model.modelId);
        this.resetRuntimeStatusHook?.(model.modelId);
        reportJobProgress?.(1);
        return this.getItem(model.modelId);
      } catch (error) {
        const paused =
          error instanceof MangaError &&
          error.code === "CANCELLED" &&
          Boolean(error.details?.paused);
        const cancelled =
          error instanceof MangaError &&
          error.code === "CANCELLED" &&
          !paused;
        if (paused) {
          const staging = readStagingState(this.stagingDir, model.modelId);
          this.transientStates.set(model.modelId, {
            state: "paused",
            downloadedBytes: staging?.bytes ?? 0,
            totalBytes: model.archiveBytes,
            errorMessage: null,
          });
        } else if (cancelled) {
          this.transientStates.delete(model.modelId);
        } else {
          const staging = readStagingState(this.stagingDir, model.modelId);
          const msg = error instanceof Error ? error.message : String(error);
          this.transientStates.set(model.modelId, {
            state: "failed",
            ...(staging ? { downloadedBytes: staging.bytes, totalBytes: model.archiveBytes } : {}),
            errorMessage: msg,
          });
        }
        throw error;
      } finally {
        input.signal?.removeEventListener("abort", abortMerged);
        jobSignal?.removeEventListener("abort", abortMerged);
      }
    };

    if (this.jobs) {
      const submitted = this.jobs.submit({
        lane: "model-download",
        kind: "model-download",
        key: `model-download:${model.modelId}`,
        owner: model.modelId,
        run: (ctx) => execute(ctx.signal, ctx.progress),
      });
      return submitted.promise;
    }

    return execute();
  }

  async pause(modelId: string): Promise<LocalAsrModelItem> {
    const model = this.getCatalogEntry(modelId);
    const { downloadedBytes, paused } = await this.downloader.pause(model.modelId);
    if (paused) {
      this.transientStates.set(model.modelId, {
        state: "paused",
        downloadedBytes,
        totalBytes: model.archiveBytes,
        errorMessage: null,
      });
    }
    return this.getItem(model.modelId);
  }

  async cancel(modelId: string): Promise<LocalAsrModelItem> {
    const model = this.getCatalogEntry(modelId);
    this.jobs?.cancelWhere((job) => job.kind === "model-download" && job.owner === model.modelId);
    await this.downloader.cancel(model.modelId);
    this.transientStates.delete(model.modelId);
    return this.getItem(model.modelId);
  }

  async importModel(input: {
    modelId: string;
    sourcePath: string;
    kind: "archive" | "directory";
    signal?: AbortSignal;
  }): Promise<LocalAsrModelItem> {
    const model = this.getCatalogEntry(input.modelId);
    const resolvedSource = path.resolve(input.sourcePath);
    if (!fs.existsSync(resolvedSource)) {
      throw new MangaError("NOT_FOUND", "未找到所选的模型路径");
    }

    await this.downloader.cancel(model.modelId);
    if (this.isInstalled(model.modelId)) {
      await this.unloadModelHook?.(model.modelId);
    }

    this.transientStates.set(model.modelId, {
      state: "verifying",
      totalBytes: model.archiveBytes,
      errorMessage: null,
    });

    const finalModelDir = path.join(this.asrModelsDir, model.modelId);
    try {
      let installedBytes = 0;
      if (input.kind === "archive") {
        const res = await extractAndVerifyModelArchive({
          archivePath: resolvedSource,
          model,
          stagingDir: this.stagingDir,
          finalModelDir,
          maxUncompressedBytes: this.maxUncompressedBytes,
          tarExe: this.tarExe,
          env: this.env,
          signal: input.signal,
        });
        installedBytes = res.installedBytes;
      } else {
        const srcStat = fs.lstatSync(resolvedSource);
        if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
          throw new MangaError("PATH_ESCAPE", "所选路径不是有效的模型文件夹");
        }
        const nestedDir = path.join(resolvedSource, model.topLevelDirectory);
        const effectiveSourceDir =
          fs.existsSync(nestedDir) && fs.lstatSync(nestedDir).isDirectory() ? nestedDir : resolvedSource;

        await verifyRequiredModelFiles(effectiveSourceDir, model.requiredFiles, input.signal);

        fs.mkdirSync(this.stagingDir, { recursive: true });
        const stagedImportDir = path.join(
          this.stagingDir,
          `import-${model.modelId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        try {
          copyDirectoryRegularFiles(effectiveSourceDir, stagedImportDir);
          const verified = await verifyRequiredModelFiles(stagedImportDir, model.requiredFiles, input.signal);
          installedBytes = verified.installedBytes;
          atomicReplaceDirectory(stagedImportDir, finalModelDir, this.stagingDir);
        } finally {
          fs.rmSync(stagedImportDir, { recursive: true, force: true });
        }
      }

      cleanModelStaging(this.stagingDir, model.modelId);
      this.recordInstalled({
        modelId: model.modelId,
        kind: model.kind,
        archiveSha256: model.archiveSha256,
        installedBytes,
        installedAt: this.now().toISOString(),
        source: input.kind === "archive" ? "local-archive" : "local-directory",
      });
      this.transientStates.delete(model.modelId);
      this.resetRuntimeStatusHook?.(model.modelId);
      return this.getItem(model.modelId);
    } catch (error) {
      cleanModelStaging(this.stagingDir, model.modelId);
      const msg = error instanceof Error ? error.message : String(error);
      this.transientStates.set(model.modelId, {
        state: "failed",
        errorMessage: msg,
      });
      throw error;
    }
  }

  async delete(modelId: string): Promise<{ modelId: string; deleted: boolean; freedBytes: number }> {
    const model = this.getCatalogEntry(modelId);
    this.jobs?.cancelWhere((job) => job.kind === "model-download" && job.owner === model.modelId);
    await this.downloader.cancel(model.modelId);

    // Always unload from the isolated speech utilityProcess before unlinking `.onnx` files on Windows.
    await this.unloadModelHook?.(model.modelId);
    this.resetRuntimeStatusHook?.(model.modelId);

    const installDir = path.join(this.asrModelsDir, model.modelId);
    let freedBytes = cleanModelStaging(this.stagingDir, model.modelId);
    let existed = false;
    if (fs.existsSync(installDir)) {
      existed = true;
      freedBytes += measurePathBytes(installDir);
      fs.rmSync(installDir, { recursive: true, force: true });
    }

    const manifest = this.readManifest();
    if (manifest.models[model.modelId]) {
      existed = true;
      delete manifest.models[model.modelId];
      this.writeManifest(manifest);
    }
    this.transientStates.delete(model.modelId);

    return {
      modelId: model.modelId,
      deleted: existed,
      freedBytes,
    };
  }

  private buildModelItem(entry: AsrCatalogModel, manifest: InstalledManifestFile): LocalAsrModelItem {
    const base: Omit<LocalAsrModelItem, "state"> = {
      modelId: entry.modelId,
      name: entry.name,
      kind: entry.kind,
      languages: [...entry.languages],
      hotwords: entry.hotwords,
      ...(entry.recommended ? { recommended: true } : {}),
      license: entry.license,
      licenseUrl: entry.licenseUrl,
      archiveName: entry.archiveName,
      archiveBytes: entry.archiveBytes,
      archiveSha256: entry.archiveSha256,
      sources: entry.sources.map((s) => ({ ...s })),
    };

    const transient = this.transientStates.get(entry.modelId);
    if (transient && (transient.state === "downloading" || transient.state === "verifying" || transient.state === "paused")) {
      return {
        ...base,
        state: transient.state,
        ...(transient.downloadedBytes !== undefined ? { downloadedBytes: transient.downloadedBytes } : {}),
        ...(transient.totalBytes !== undefined ? { totalBytes: transient.totalBytes } : {}),
        ...(transient.errorMessage ? { errorMessage: transient.errorMessage } : {}),
      };
    }

    const installed = manifest.models[entry.modelId];
    const installDir = path.join(this.asrModelsDir, entry.modelId);
    if (installed && fs.existsSync(installDir)) {
      const runtime = this.getRuntimeStatusHook?.(entry.modelId);
      if (runtime?.status === "load_failed") {
        return {
          ...base,
          state: "load_failed",
          installedBytes: installed.installedBytes,
          errorMessage: runtime.reason ?? "本地语音模型载入失败",
        };
      }
      if (runtime?.status === "loading") {
        return {
          ...base,
          state: "loading",
          installedBytes: installed.installedBytes,
        };
      }
      if (runtime?.status === "loaded") {
        return {
          ...base,
          state: "ready",
          installedBytes: installed.installedBytes,
        };
      }
      return {
        ...base,
        state: "installed",
        installedBytes: installed.installedBytes,
        ...(transient?.state === "failed" && transient.errorMessage ? { errorMessage: transient.errorMessage } : {}),
      };
    }

    if (transient?.state === "failed") {
      return {
        ...base,
        state: "failed",
        ...(transient.downloadedBytes !== undefined ? { downloadedBytes: transient.downloadedBytes } : {}),
        ...(transient.totalBytes !== undefined ? { totalBytes: transient.totalBytes } : {}),
        errorMessage: transient.errorMessage ?? "模型安装失败",
      };
    }

    const diskStaging = readStagingState(this.stagingDir, entry.modelId);
    if (diskStaging && diskStaging.bytes > 0) {
      return {
        ...base,
        state: "paused",
        downloadedBytes: diskStaging.bytes,
        totalBytes: entry.archiveBytes,
      };
    }

    return {
      ...base,
      state: "not_installed",
    };
  }

  private readManifest(): InstalledManifestFile {
    if (!fs.existsSync(this.manifestPath)) {
      return { version: 1, models: {} };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.manifestPath, "utf8")) as Partial<InstalledManifestFile>;
      if (raw && raw.version === 1 && raw.models && typeof raw.models === "object") {
        return { version: 1, models: { ...raw.models } };
      }
    } catch {
      // ignore corrupt manifest and rebuild on next install
    }
    return { version: 1, models: {} };
  }

  private writeManifest(manifest: InstalledManifestFile): void {
    fs.mkdirSync(this.stagingDir, { recursive: true });
    fs.mkdirSync(this.modelsDir, { recursive: true });
    const tmp = path.join(
      this.stagingDir,
      `installed.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.json.tmp`,
    );
    try {
      fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
      fs.renameSync(tmp, this.manifestPath);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") {
        throw new MangaError("DISK_FULL", "磁盘空间不足，无法更新已安装模型清单", { cause: error });
      }
      throw error;
    }
  }

  private recordInstalled(record: InstalledAsrModelRecord): void {
    const manifest = this.readManifest();
    manifest.models[record.modelId] = record;
    this.writeManifest(manifest);
  }
}
