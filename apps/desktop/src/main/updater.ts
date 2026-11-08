import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { NsisUpdater } from "electron-updater";
import { GenericDifferentialDownloader } from "electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js";
import type { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { parseBlockMapBytes, type UpdateService, type UpdateInstallerDownloader, type LatestManifest } from "@manga/app-core";
import { MangaError } from "@manga/contracts";

export type NsisUpdaterAdapterOptions = {
  updateService: UpdateService;
  version: string;
  appUpdateConfigPath: string;
  userDataPath: string;
  baseCachePath: string;
  installDirectory?: string;
  isPackaged?: boolean;
  expectedVersion?: () => string;
  expectedFileName?: () => string;
  sigText?: () => Promise<string | null> | string | null;
  /** Use Electron's real app and network adapters in the desktop process. */
  runtime?: boolean;
};

/**
 * Configure `electron-updater`'s `NsisUpdater` with MANGA's Ed25519 signature verifier and security settings (计划 3.1, 4.3, 4.4).
 *
 * In `electron-updater` 6.8.11, `NsisUpdater.verifySignature` only invokes `verifyUpdateCodeSignature` when `publisherName`
 * is present in `resources/app-update.yml`; without `publisherName`, `verifySignature` returns `null` without calling the verifier.
 */
export function createConfiguredNsisUpdater(options: NsisUpdaterAdapterOptions): NsisUpdater {
  const appAdapter = {
    version: options.version,
    name: "MANGA",
    isPackaged: options.isPackaged ?? true,
    appUpdateConfigPath: options.appUpdateConfigPath,
    userDataPath: options.userDataPath,
    baseCachePath: options.baseCachePath,
    whenReady: () => Promise.resolve(),
    relaunch: () => undefined,
    quit: () => undefined,
    onQuit: () => undefined,
  };

  const updater = options.runtime ? new NsisUpdater() : new NsisUpdater(null, appAdapter);
  if (options.runtime) {
    Object.defineProperty((updater as unknown as { app: object }).app, "baseCachePath", { value: options.baseCachePath });
  }
  updater.logger = null;
  updater.autoDownload = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableWebInstaller = true;
  // MANGA waits for saves and takes a backup before its quit handler runs the verified installer.
  // The upstream automatic quit handler must not bypass that barrier.
  updater.autoInstallOnAppQuit = false;
  (updater as unknown as { updateConfigPath: string }).updateConfigPath = options.appUpdateConfigPath;
  if (options.installDirectory) {
    updater.installDirectory = options.installDirectory;
  }

  updater.verifyUpdateCodeSignature = options.updateService.createNsisCodeSignatureVerifier({
    expectedVersion: options.expectedVersion ?? (() => options.updateService.status().availableVersion ?? ""),
    expectedFileName: options.expectedFileName ?? (() => {
      const ver = options.updateService.status().availableVersion ?? "";
      return ver ? `manga-setup-${ver}.exe` : "";
    }),
    sigText: options.sigText,
  });

  return updater;
}

/** Connect the actual upstream download/differential engine and publisher hook to the service. */
export function attachNsisUpdater(options: NsisUpdaterAdapterOptions & {
  updater?: NsisUpdater;
  allowLoopbackHttp?: boolean;
}): NsisUpdater {
  const updater = options.updater ?? createConfiguredNsisUpdater(options);
  type RequestOptions = { protocol?: string; hostname?: string; host?: string; headers?: Record<string, unknown> };
  type Request = EventEmitter & { abort(): void; end(): void; setTimeout(ms: number, callback: () => void): void; followRedirect?: () => void };
  type Response = EventEmitter & { statusCode: number };
  const executor = (updater as unknown as { httpExecutor: {
    createRequest: (request: RequestOptions, callback: (response: Response) => void) => Request;
    download: (url: URL, destination: string, downloadOptions: unknown) => Promise<string>;
    addRedirectHandlers: (request: Request, requestOptions: RequestOptions, reject: (error: Error) => void, count: number, handler: (requestOptions: RequestOptions) => void) => void;
  } }).httpExecutor;
  if (!executor) throw new Error("electron-updater has no HTTP executor");
  const securityError = () => new MangaError("UPDATE_VERIFY_FAILED", "更新源必须使用 HTTPS，已保留当前版本");
  const allowed = (protocol: string | undefined, host: string) => protocol === "https:"
    || Boolean(options.allowLoopbackHttp && protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host));
  const allowedRedirect = (raw: string) => {
    try { const url = new URL(raw); return allowed(url.protocol, url.hostname); } catch { return false; }
  };
  let transfer: { bytes: number } | undefined;
  let fullDownload = false;
  let differential = false;
  let activeManifest: LatestManifest | undefined;
  const resumeDir = path.join(options.baseCachePath, "updater", "resume");
  type DownloadOptions = Parameters<ElectronHttpExecutor["download"]>[2];
  const download = executor.download;
  executor.download = async function (url, destination, downloadOptions) {
    fullDownload = true;
    const manifest = activeManifest;
    const partial = manifest ? path.join(resumeDir, `${manifest.fileName}.part`) : null;
    const metadata = partial ? `${partial}.json` : null;
    const expected = manifest ? { version: manifest.version, fileName: manifest.fileName, sha512: manifest.sha512, size: manifest.size } : null;
    let fullStartBytes: number | undefined;
    const forgetPartial = () => {
      for (const file of [partial, metadata]) if (file) { try { fs.rmSync(file, { force: true }); } catch { /* a subsequent check replaces it */ } }
    };
    try {
      // The upstream full downloader discards its temporary file after an interruption. Retain
      // it separately and resume at complete block boundaries through its own differential engine.
      // Final SHA-512 and the publisher hook verify all copied and downloaded bytes together.
      if (manifest && partial && metadata && fs.existsSync(partial) && fs.existsSync(metadata)) {
        try {
          if (JSON.stringify(JSON.parse(fs.readFileSync(metadata, "utf8"))) !== JSON.stringify(expected)) throw new Error("partial update belongs to another manifest");
          const blockMap = parseBlockMapBytes(fs.readFileSync(path.join(path.dirname(destination), "current.blockmap")));
          const file = blockMap.files[0];
          const partialBytes = fs.statSync(partial).size;
          if (blockMap.files.length !== 1 || file.offset !== 0 || file.sizes.reduce((sum, size) => sum + size, 0) !== manifest.size) throw new Error("incompatible partial blockmap");
          let end = 0; let count = 0;
          while (count < file.sizes.length && end + file.sizes[count] <= partialBytes) { end += file.sizes[count]; count += 1; }
          if (!count || partialBytes >= manifest.size) throw new Error("partial update has no complete prefix blocks");
          const oldMap = { ...blockMap, files: [{ ...file, sizes: file.sizes.slice(0, count), checksums: file.checksums.slice(0, count) }] };
          const actualOptions = downloadOptions as DownloadOptions;
          await new GenericDifferentialDownloader(manifest, this as unknown as ConstructorParameters<typeof GenericDifferentialDownloader>[1], {
            oldFile: partial, newFile: destination, newUrl: url, logger: updater.logger!, isUseMultipleRangeRequest: false,
            requestHeaders: actualOptions.headers ?? null, cancellationToken: actualOptions.cancellationToken, onProgress: actualOptions.onProgress,
          }).download(oldMap, blockMap);
          forgetPartial();
          return destination;
        } catch (error) {
          forgetPartial();
          differential = false;
          if ((downloadOptions as DownloadOptions).cancellationToken.cancelled) throw error;
        }
      }
      fullStartBytes = transfer?.bytes ?? 0;
      const result = await download.call(this, url, destination, downloadOptions);
      forgetPartial();
      return result;
    } catch (error) {
      if (manifest && partial && metadata && fullStartBytes !== undefined) {
        try {
          // Upstream rejects a digest/transport error before its output stream closes.
          // Wait for the bytes we actually received to reach that file before copying it.
          const received = (transfer?.bytes ?? fullStartBytes) - fullStartBytes;
          const deadline = Date.now() + 2_000;
          while (received > 0 && (!fs.existsSync(destination) || fs.statSync(destination).size < received) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const bytes = fs.statSync(destination).size;
          if (bytes > 0 && bytes < manifest.size) {
            fs.mkdirSync(resumeDir, { recursive: true });
            fs.copyFileSync(destination, partial);
            fs.writeFileSync(metadata, JSON.stringify(expected));
          } else forgetPartial();
        } catch { forgetPartial(); }
      }
      throw error;
    }
    finally { fullDownload = false; }
  };
  const createRequest = executor.createRequest;
  executor.createRequest = function (request, callback) {
    if (request.headers) {
      request.headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "x-user-staging-id"));
    }
    const host = request.hostname ?? request.host ?? "";
    if (!allowed(request.protocol, host)) {
      // Redirect callbacks may request the next hop outside a promise executor. Report through
      // the normal request error event instead of throwing from that callback and crashing Electron.
      const rejected = new EventEmitter() as Request;
      rejected.abort = () => undefined;
      rejected.end = () => undefined;
      rejected.setTimeout = () => undefined;
      queueMicrotask(() => rejected.emit("error", securityError()));
      return rejected;
    }
    const countBytes = fullDownload || Object.keys(request.headers ?? {}).some((name) => name.toLowerCase() === "range");
    const handle = createRequest.call(this, request, (response) => {
      if (countBytes && transfer && [200, 206].includes(response.statusCode)) {
        const current = transfer;
        response.on("data", (chunk: Uint8Array) => { current.bytes += chunk.byteLength; });
      }
      callback(response);
    });
    // DifferentialDownloader follows redirects on the same Electron request. Its followRedirect
    // must be guarded as well as HttpExecutor's redirects that create a new request.
    let forbiddenRedirect = false;
    const follow = handle.followRedirect;
    if (follow) handle.followRedirect = () => { if (!forbiddenRedirect) follow.call(handle); };
    handle.prependListener("redirect", (_status: number, _method: string, raw: string) => {
      if (allowedRedirect(raw)) return;
      forbiddenRedirect = true;
      handle.abort();
      handle.emit("error", securityError());
    });
    return handle;
  };
  const addRedirectHandlers = executor.addRedirectHandlers;
  executor.addRedirectHandlers = function (request, requestOptions, reject, count, handler) {
    return addRedirectHandlers.call(this, request, requestOptions, reject, count, (redirectOptions) => {
      if (!allowed(redirectOptions.protocol, redirectOptions.hostname ?? redirectOptions.host ?? "")) { reject(securityError()); return; }
      handler(redirectOptions);
    });
  };

  const downloadInstaller: UpdateInstallerDownloader = async ({ manifest, baseUrl, signal, onProgress }) => {
    // Keep only the current manifest's interruption. These files belong to this adapter;
    // other cache contents are left alone.
    if (fs.existsSync(resumeDir)) {
      const currentFiles = new Set([`${manifest.fileName}.part`, `${manifest.fileName}.part.json`]);
      for (const entry of fs.readdirSync(resumeDir, { withFileTypes: true })) {
        if (entry.isFile() && /^manga-setup-0\.1\.\d+\.exe\.part(?:\.json)?$/.test(entry.name) && !currentFiles.has(entry.name)) {
          try { fs.rmSync(path.join(resumeDir, entry.name), { force: true }); } catch { /* retry pruning on the next check */ }
        }
      }
    }
    const measurement = { bytes: 0 };
    transfer = measurement;
    activeManifest = manifest;
    differential = false;
    updater.logger = {
      info(message: string) { if (message.startsWith("Full:")) differential = true; },
      warn() {},
      error(message: string) { if (message.startsWith("Cannot download differentially")) differential = false; },
    };
    const progress = (info: { transferred: number; total: number }) => {
      onProgress(info.transferred, manifest.size, differential);
    };
    updater.on("download-progress", progress);
    updater.requestHeaders = { "User-Agent": `MANGA/${options.version} (${process.platform}; ${process.arch})`, "Cache-Control": "no-cache" };
    updater.setFeedURL({ provider: "generic", url: baseUrl, useMultipleRangeRequest: false });
    updater.previousBlockmapBaseUrlOverride = baseUrl.startsWith("https://github.com/chialecode/manga/")
      ? `https://github.com/chialecode/manga/releases/download/v${options.version}/`
      : baseUrl;
    let cancellation: { cancel(): void } | undefined;
    const aborted = () => cancellation?.cancel();
    signal.addEventListener("abort", aborted, { once: true });
    try {
      signal.throwIfAborted();
      const result = await updater.checkForUpdates();
      cancellation = result?.cancellationToken;
      if (signal.aborted) cancellation?.cancel();
      signal.throwIfAborted();
      const info = result?.updateInfo;
      const file = info?.files.find((candidate) => candidate.url === manifest.fileName);
      if (!info || info.version !== manifest.version || !file || file.sha512 !== manifest.sha512 || file.size !== manifest.size) {
        throw new MangaError("UPDATE_VERIFY_FAILED", "更新清单在下载前发生变化，已保留当前版本");
      }
      const [installerPath] = await updater.downloadUpdate(result!.cancellationToken);
      signal.throwIfAborted();
      if (!installerPath || !fs.existsSync(installerPath)) throw new Error("electron-updater returned no installer");
      return { installerPath, downloadedBytes: measurement.bytes, usedDifferential: differential };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (["ERR_UPDATER_INVALID_SIGNATURE", "ERR_CHECKSUM_MISMATCH"].includes(code ?? "")) {
        throw new MangaError("UPDATE_VERIFY_FAILED", "更新包校验失败，已保留当前版本");
      }
      throw error;
    } finally {
      updater.removeListener("download-progress", progress);
      signal.removeEventListener("abort", aborted);
      transfer = undefined;
      activeManifest = undefined;
    }
  };
  options.updateService.configure({
    downloadInstaller,
    verifyPublisherSignature: (file) => invokeNsisVerifySignature(updater, file),
  });
  return updater;
}

/**
 * Invoke `NsisUpdater`'s internal `verifySignature(tempUpdateFile)` method against `appUpdateConfigPath` (计划 3.1, AT-160).
 */
export async function invokeNsisVerifySignature(
  updater: NsisUpdater,
  tempUpdateFile: string,
): Promise<string | null> {
  const fn = (updater as unknown as { verifySignature: (file: string) => Promise<string | null> }).verifySignature;
  return fn.call(updater, path.resolve(tempUpdateFile));
}
