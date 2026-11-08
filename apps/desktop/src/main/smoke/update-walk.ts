import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import {
  BUILD_SCHEMA_VERSION,
  type MangaProductApp,
  buildBlockMap,
  checkAppUpdateConfig,
  computeDevVersion,
  computeNextReleaseVersion,
  formatLatestYaml,
  rawPublicKey,
  serializeBlockMapGzip,
  sha512BytesBase64,
  signReleaseInstaller,
  writeBuildInfo,
} from "@manga/app-core";
import { createConfiguredNsisUpdater, invokeNsisVerifySignature } from "../updater.ts";
import { DRAWN, clickTestId, ensureSidebar, pressChord, waitFrames, waitUntil } from "./driver.ts";
import { caller, capturePage, js, leaveSettings, openSettingsPage, toRail, type FlowResult } from "./common.ts";

export type UpdateObservation = { name: string; status: "passed" | "failed"; detail: unknown };

type LoopbackReleaseServer = {
  baseUrl: string;
  files: Map<string, Buffer | string>;
  requests: Array<{ method: string; url: string; range?: string; userAgent?: string }>;
  close: () => Promise<void>;
};

async function startLoopbackReleaseServer(): Promise<LoopbackReleaseServer> {
  const files = new Map<string, Buffer | string>();
  const requests: Array<{ method: string; url: string; range?: string; userAgent?: string }> = [];

  const server = http.createServer((req, res) => {
    const reqUrl = req.url ?? "/";
    requests.push({
      method: req.method ?? "GET",
      url: reqUrl,
      range: typeof req.headers.range === "string" ? req.headers.range : undefined,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    });
    const cleanPath = decodeURIComponent(reqUrl.split("?")[0] ?? "/").replace(/^\/+/, "");
    const item = files.get(cleanPath);
    if (item === undefined) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const buf = typeof item === "string" ? Buffer.from(item, "utf8") : item;
    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      if (m) {
        const start = Number.parseInt(m[1]!, 10);
        const end = m[2] ? Number.parseInt(m[2], 10) : buf.length - 1;
        if (start >= 0 && start < buf.length && end >= start && end < buf.length) {
          const slice = buf.subarray(start, end + 1);
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${buf.length}`);
          res.setHeader("Content-Length", String(slice.length));
          res.end(slice);
          return;
        }
      }
    }
    res.statusCode = 200;
    res.setHeader("Content-Length", String(buf.length));
    res.end(buf);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind loopback release server");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    files,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeAppUpdateYaml(publisherName: string[] = ["chialecode"]): string {
  const lines = ["provider: github", "owner: chialecode", "repo: manga", "updaterCacheDirName: updater"];
  if (publisherName.length > 0) {
    lines.push("publisherName:");
    for (const name of publisherName) lines.push(`  - ${name}`);
  }
  return `${lines.join("\n")}\n`;
}

async function captureUpdateShot(
  view: BrowserWindow,
  evidenceDir: string | undefined,
  name: string,
  mark?: string,
): Promise<void> {
  if (!evidenceDir) return;
  await capturePage(view, evidenceDir, name, mark);
  const src = path.join(evidenceDir, name);
  if (fs.existsSync(src)) {
    const shotsDir = path.join(evidenceDir, "screenshots");
    fs.mkdirSync(shotsDir, { recursive: true });
    fs.copyFileSync(src, path.join(shotsDir, name));
  }
}

async function switchBuildState(
  appService: MangaProductApp,
  view: BrowserWindow,
  nextBuild: {
    version: string;
    channel: "release" | "development";
    commit: string;
    builtAt: string;
    schemaVersion: number;
  },
  options: { resetUpdateState?: boolean; detectFirstLaunch?: boolean; reloadWindow?: boolean } = {},
): Promise<void> {
  appService.buildInfo = nextBuild;
  appService.appVersion = nextBuild.version;
  (appService.layout as { channel: "release" | "development" }).channel = nextBuild.channel;
  appService.update.configure({
    buildInfo: nextBuild,
    resetState: options.resetUpdateState ?? true,
    detectFirstLaunch: options.detectFirstLaunch ?? false,
  });
  if (options.reloadWindow !== false) {
    await view.webContents.reload();
    await toRail(view);
    await waitFrames(view, 2);
  }
}

/**
 * Packaged-window observations for Stage M10 (`MANGA_SMOKE_PHASE=update`, 计划第 7 节, AT-157—AT-160):
 * - `version-about`
 * - `update-flow`
 * - `update-on-quit`
 * - `update-rejected`
 * - `update-offline`
 * Also captures the 4 required sanitized screenshots (`ui-update-banner-light.png`, `ui-update-banner-dark.png`,
 * `ui-settings-update.png`, `ui-about-dialog.png`).
 */
export async function runUpdateSmoke(input: {
  appService: MangaProductApp;
  grant: string;
  view: BrowserWindow;
  evidenceDir: string | undefined;
  logsDir: string;
}): Promise<FlowResult & { observations: UpdateObservation[] }> {
  const { appService, grant, view, evidenceDir, logsDir } = input;
  const call = caller(appService, grant);
  const observations: UpdateObservation[] = [];
  const observe = (name: string, ok: boolean, detail: unknown) => {
    observations.push({ name, status: ok ? "passed" : "failed", detail });
    console.error(`update ${name}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 2000)}`);
    return ok;
  };

  view.showInactive();
  await call("settings.skipAi", {});
  await toRail(view);
  await ensureSidebar(view);
  // Leave settings if the empty library started on the library paths page.
  await leaveSettings(view);

  const commit = appService.buildInfo.commit && appService.buildInfo.commit !== "unknown"
    ? appService.buildInfo.commit
    : "c79f49a";
  const builtAt = "2026-11-08T10:00:00.000Z";

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manga-package-update-"));
  const tempResourcesDir = path.join(tempRoot, "resources");
  const tempInstallDir = path.join(tempRoot, "Programs", "manga-test");
  const appUpdatePath = path.join(tempResourcesDir, "app-update.yml");
  fs.mkdirSync(tempResourcesDir, { recursive: true });
  fs.mkdirSync(tempInstallDir, { recursive: true });
  fs.writeFileSync(appUpdatePath, makeAppUpdateYaml(["chialecode"]), "utf8");

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyBase64 = rawPublicKey(publicKey).toString("base64");
  const testPublicKeys = [{ publicKey: publicKeyBase64, label: "MANGA Smoke Update Key" }];

  const server = await startLoopbackReleaseServer();

  try {
    // =========================================================================
    // 1. Observation: `version-about` (AT-157, 计划 4.1, 6, 7)
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        // Verify version computation rules (no tags -> 0.1.1, non-contiguous tags -> highest + 1, dev version format).
        const computedFirst = computeNextReleaseVersion([]);
        const computedNext = computeNextReleaseVersion(["v0.1.1", "v0.1.3"]);
        const computedDev = computeDevVersion(["v0.1.3"], new Date("2026-11-08T15:30:00Z"));
        detail.computed = { computedFirst, computedNext, computedDev };
        if (computedFirst !== "0.1.1") problems.push(`expected 0.1.1 with no tags, got ${computedFirst}`);
        if (computedNext !== "0.1.4") problems.push(`expected 0.1.4 after v0.1.3, got ${computedNext}`);
        if (computedDev !== "0.1.4-dev.202611081530") problems.push(`unexpected dev version: ${computedDev}`);

        // 1A. Release mode (`0.1.1`, `channel: "release"`)
        await switchBuildState(appService, view, {
          version: "0.1.1",
          channel: "release",
          commit,
          builtAt,
          schemaVersion: BUILD_SCHEMA_VERSION,
        });
        await leaveSettings(view);

        const helpOpenedRel = await clickTestId(view, "menu-help", 3000);
        const hasMenuCheckRel = helpOpenedRel && await waitUntil(view, `Boolean(document.querySelector('[data-testid="menu-help-check-update"]'))`, 3000);
        const aboutOpenedRel = helpOpenedRel && await clickTestId(view, "menu-help-about", 3000)
          && await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="about-dialog"]'))`, 4000);

        const relFacts = await js<{
          name: string;
          version: string;
          channel: string;
          commit: string;
          builtAt: string;
          license: string;
          devHint: boolean;
          checkBtn: boolean;
        }>(view, `({
          name: document.querySelector('[data-testid="about-name"]')?.textContent ?? "",
          version: document.querySelector('[data-testid="about-version"]')?.textContent ?? "",
          channel: document.querySelector('[data-testid="about-channel"]')?.textContent ?? "",
          commit: document.querySelector('[data-testid="about-commit"]')?.textContent ?? "",
          builtAt: document.querySelector('[data-testid="about-built-at"]')?.textContent ?? "",
          license: document.querySelector('[data-testid="about-license"]')?.textContent ?? "",
          devHint: Boolean(document.querySelector('[data-testid="about-dev-hint"]')),
          checkBtn: Boolean(document.querySelector('[data-testid="about-check-update"]')),
        })`);

        // Capture required screenshot `ui-about-dialog.png`
        await captureUpdateShot(view, evidenceDir, "ui-about-dialog.png", "about-dialog");

        // Spy on navigator.clipboard.writeText and click "复制版本信息"
        await js(view, `(() => {
          window.__copiedAboutText = "";
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: async (text) => { window.__copiedAboutText = String(text); } },
          });
          return true;
        })()`);
        await clickTestId(view, "about-copy", 3000);
        await waitUntil(view, `typeof window.__copiedAboutText === "string" && window.__copiedAboutText.length > 0`, 3000);
        const relCopied = await js<string>(view, `window.__copiedAboutText ?? ""`);
        const relHasLocalPath = /(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(relCopied);

        detail.release = { helpOpenedRel, hasMenuCheckRel, aboutOpenedRel, ...relFacts, copiedLength: relCopied.length, hasLocalPath: relHasLocalPath };
        if (!aboutOpenedRel) problems.push("release About dialog did not open");
        if (!hasMenuCheckRel) problems.push("release Help menu missing check-update item");
        if (relFacts.name !== "MANGA" || relFacts.version !== "0.1.1" || relFacts.channel !== "正式版" || relFacts.license !== "Apache-2.0") {
          problems.push(`release About facts mismatch: ${JSON.stringify(relFacts)}`);
        }
        if (relFacts.devHint || !relFacts.checkBtn) {
          problems.push("release About dialog should show check-update button and no dev hint");
        }
        if (!relCopied.includes("MANGA 0.1.1") || !relCopied.includes("正式版") || !relCopied.includes(commit) || relHasLocalPath) {
          problems.push("release copied version text invalid or contained local path");
        }

        await pressChord(view, "Escape", []);
        await waitUntil(view, `!document.querySelector('[data-testid="about-dialog"]')`, 3000);

        // 1B. Development mode (`0.1.2-dev.202611081530`, `channel: "development"`)
        const devVersionStr = "0.1.2-dev.202611081530";
        await switchBuildState(appService, view, {
          version: devVersionStr,
          channel: "development",
          commit,
          builtAt,
          schemaVersion: BUILD_SCHEMA_VERSION,
        });
        await leaveSettings(view);

        const helpOpenedDev = await clickTestId(view, "menu-help", 3000);
        await waitUntil(view, `Boolean(document.querySelector('[data-testid="menu-help-about"]'))`, 3000);
        const hasMenuCheckDev = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="menu-help-check-update"]'))`);
        const aboutOpenedDev = helpOpenedDev && await clickTestId(view, "menu-help-about", 3000)
          && await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="about-dialog"]'))`, 4000);

        const devFacts = await js<{
          version: string;
          channel: string;
          devHint: string;
          checkBtn: boolean;
        }>(view, `({
          version: document.querySelector('[data-testid="about-version"]')?.textContent ?? "",
          channel: document.querySelector('[data-testid="about-channel"]')?.textContent ?? "",
          devHint: document.querySelector('[data-testid="about-dev-hint"]')?.textContent ?? "",
          checkBtn: Boolean(document.querySelector('[data-testid="about-check-update"]')),
        })`);

        await js(view, `(() => {
          window.__copiedAboutText = "";
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: async (text) => { window.__copiedAboutText = String(text); } },
          });
          return true;
        })()`);
        await clickTestId(view, "about-copy", 3000);
        await waitUntil(view, `typeof window.__copiedAboutText === "string" && window.__copiedAboutText.length > 0`, 3000);
        const devCopied = await js<string>(view, `window.__copiedAboutText ?? ""`);
        const devHasLocalPath = /(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(devCopied);

        await pressChord(view, "Escape", []);
        await waitUntil(view, `!document.querySelector('[data-testid="about-dialog"]')`, 3000);

        // Also check "设置 › 更新" in development mode
        const openedDevUpdatePage = await openSettingsPage(view, "update");
        const devUpdatePageFacts = await js<{ devModeText: string; hasCheckBtn: boolean }>(view, `({
          devModeText: document.querySelector('[data-testid="update-dev-mode"]')?.textContent ?? "",
          hasCheckBtn: Boolean(document.querySelector('[data-testid="update-check-now"]')),
        })`);
        await leaveSettings(view);

        detail.development = {
          hasMenuCheckDev,
          aboutOpenedDev,
          ...devFacts,
          copiedLength: devCopied.length,
          hasLocalPath: devHasLocalPath,
          updatePage: { openedDevUpdatePage, ...devUpdatePageFacts },
        };
        if (hasMenuCheckDev) problems.push("development Help menu should not show check-update item");
        if (!aboutOpenedDev || devFacts.version !== devVersionStr || devFacts.channel !== "开发版") {
          problems.push(`development About facts mismatch: ${JSON.stringify(devFacts)}`);
        }
        if (devFacts.devHint !== "开发版：由本机构建自动更新" || devFacts.checkBtn) {
          problems.push("development About dialog missing devHint or showed check-update button");
        }
        if (!devCopied.includes(devVersionStr) || !devCopied.includes("开发版") || devHasLocalPath) {
          problems.push("development copied version text invalid or contained local path");
        }
        if (!openedDevUpdatePage || devUpdatePageFacts.devModeText !== "开发版：由本机构建自动更新" || devUpdatePageFacts.hasCheckBtn) {
          problems.push("development Settings › Update page did not show dev-mode notice or showed check button");
        }
      } catch (error) {
        problems.push(`version-about stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("version-about", problems.length === 0, { ...detail, problems });
    }

    // Prepare synthetic 0.1.1 & 0.1.2 installers (8 blocks of 4096B = 32768B; 6 shared + 2 changed blocks) for `update-flow`, `update-on-quit`, and `update-rejected`.
    const blockSize = 4096;
    const sharedBlocks = Array.from({ length: 6 }, (_, i) => Buffer.alloc(blockSize, i + 1));
    const v1Bytes = Buffer.concat([...sharedBlocks, randomBytes(blockSize), randomBytes(blockSize)]);
    const v2Bytes = Buffer.concat([...sharedBlocks, randomBytes(blockSize), randomBytes(blockSize)]);
    const v1BlockMapGzip = serializeBlockMapGzip(buildBlockMap(v1Bytes, blockSize));
    const v2BlockMapGzip = serializeBlockMapGzip(buildBlockMap(v2Bytes, blockSize));

    const v2FileName = "manga-setup-0.1.2.exe";
    const v2TempFile = path.join(tempRoot, v2FileName);
    fs.writeFileSync(v2TempFile, v2Bytes);
    const v2Signed = signReleaseInstaller({
      installerPath: v2TempFile,
      version: "0.1.2",
      fileName: v2FileName,
      privateKeyPem,
      outputSigPath: null,
    });

    // =========================================================================
    // 2. Observation: `update-flow` (AT-159, 计划 4.3, 4.4, 6, 7)
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        const installerRuns: Array<{ installerPath: string; args: string[]; mode: string }> = [];
        let simulatedBusy: Array<"recording"> = [];

        await switchBuildState(appService, view, {
          version: "0.1.1",
          channel: "release",
          commit,
          builtAt,
          schemaVersion: BUILD_SCHEMA_VERSION,
        });
        await leaveSettings(view);

        appService.update.configure({
          feedUrl: server.baseUrl,
          allowLoopbackHttp: true,
          requireHttps: false,
          publicKeys: testPublicKeys,
          appUpdateConfigPath: appUpdatePath,
          requireAppUpdateConfig: true,
          installDirectory: tempInstallDir,
          isBusy: () => simulatedBusy,
          runInstaller: (installerPath, args, mode) => {
            installerRuns.push({ installerPath, args, mode });
            writeBuildInfo(tempResourcesDir, {
              version: "0.1.2",
              channel: "release",
              commit: "b012b01",
              builtAt: "2026-11-08T12:00:00.000Z",
              schemaVersion: BUILD_SCHEMA_VERSION,
            });
            return true;
          },
        });

        // Create sample user data before update
        const createdNote = await call("notes.create", { title: "更新演练保留笔记", text: "从 0.1.1 升级到 0.1.2 的数据" });
        if (createdNote.status !== "ok") problems.push("failed to seed sample note in 0.1.1");

        // Seed 0.1.1 installer & blockmap in updater cache for differential download
        appService.update.seedCurrentInstallerCache(v1Bytes, v1BlockMapGzip);

        const releaseNotesText = "1. 新增每周自动发布与 Ed25519 签名校验\n2. 升级资料库前自动创建备份";
        server.requests.length = 0;
        server.files.clear();
        server.files.set(
          "latest.yml",
          formatLatestYaml({
            version: "0.1.2",
            fileName: v2FileName,
            sha512: sha512BytesBase64(v2Bytes),
            size: v2Bytes.length,
            schemaVersion: BUILD_SCHEMA_VERSION + 1,
            releaseNotes: releaseNotesText,
          }),
        );
        server.files.set(v2FileName, v2Bytes);
        server.files.set(`${v2FileName}.blockmap`, v2BlockMapGzip);
        server.files.set(`${v2FileName}.sig`, v2Signed.sigText);

        // Automatic startup check + differential download + Ed25519 verification
        const statusAfterCheck = await appService.update.check({ manual: false });
        detail.check = {
          state: statusAfterCheck.state,
          availableVersion: statusAfterCheck.availableVersion,
          usedDifferential: statusAfterCheck.usedDifferential,
          downloadedBytes: statusAfterCheck.downloadedBytes,
          totalBytes: statusAfterCheck.totalBytes,
          willUpgradeSchema: statusAfterCheck.willUpgradeSchema,
        };
        if (statusAfterCheck.state !== "ready" || statusAfterCheck.availableVersion !== "0.1.2") {
          problems.push(`update did not reach ready state: ${JSON.stringify(detail.check)}`);
        }
        if (!statusAfterCheck.usedDifferential || statusAfterCheck.downloadedBytes !== 2 * blockSize || statusAfterCheck.totalBytes !== 8 * blockSize) {
          problems.push(`differential download did not fetch only changed blocks (${statusAfterCheck.downloadedBytes}/${statusAfterCheck.totalBytes})`);
        }
        if (!statusAfterCheck.willUpgradeSchema) {
          problems.push("willUpgradeSchema was not true when targetSchemaVersion > schemaVersion");
        }

        // Wait for top-bar update ready prompt (`update-banner`) in the window
        const bannerShown = await waitUntil(
          view,
          `${DRAWN}(document.querySelector('[data-testid="update-banner"]')) && (document.querySelector('[data-testid="update-banner"]')?.textContent ?? "").includes("新版本 0.1.2 已就绪")`,
          6000,
        );
        // Open release notes popover and verify schema upgrade notice
        const notesOpened = bannerShown
          && await clickTestId(view, "update-notes-button", 3000)
          && await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="update-notes-popover"]'))`, 4000);
        const schemaNoticeText = await js<string>(view, `document.querySelector('[data-testid="update-schema-notice"]')?.textContent ?? ""`);
        detail.banner = { bannerShown, notesOpened, schemaNoticeText };
        if (!bannerShown || !notesOpened || schemaNoticeText !== "这次更新会升级资料库，升级前会自动备份") {
          problems.push(`top-bar banner or schema notice failed: ${JSON.stringify(detail.banner)}`);
        }

        // Capture light-theme screenshot `ui-update-banner-light.png`
        await js(view, `document.documentElement.removeAttribute("data-theme"); true`);
        await waitFrames(view, 2);
        const lightBannerBg = await js<string>(view, `(() => { const el = document.querySelector('[data-testid="update-banner"]'); return el ? getComputedStyle(el).backgroundColor : ""; })()`);
        await captureUpdateShot(view, evidenceDir, "ui-update-banner-light.png", "update-banner");

        // Capture dark-theme screenshot `ui-update-banner-dark.png`
        await js(view, `document.documentElement.setAttribute("data-theme", "dark"); true`);
        await waitFrames(view, 2);
        const darkBannerBg = await js<string>(view, `(() => { const el = document.querySelector('[data-testid="update-banner"]'); return el ? getComputedStyle(el).backgroundColor : ""; })()`);
        if (lightBannerBg === darkBannerBg) {
          problems.push(`update-banner background did not change between light and dark themes (${lightBannerBg})`);
        }
        await captureUpdateShot(view, evidenceDir, "ui-update-banner-dark.png", "update-banner");

        // Restore light theme
        await js(view, `document.documentElement.removeAttribute("data-theme"); true`);
        await waitFrames(view, 2);

        // Close popover and capture `ui-settings-update.png`
        await clickTestId(view, "update-notes-button", 3000);
        const updatePageOpened = await openSettingsPage(view, "update");
        const updatePageReady = updatePageOpened && await waitUntil(
          view,
          `(document.querySelector('[data-testid="update-state-label"]')?.textContent ?? "").includes("0.1.2") && Boolean(document.querySelector('[data-testid="update-page-notes"]'))`,
          4000,
        );
        await captureUpdateShot(view, evidenceDir, "ui-settings-update.png", "settings-page-update");
        await leaveSettings(view);
        if (!updatePageReady) problems.push("Settings › Update page did not display ready state and release notes");

        // Busy confirmation when recording is active
        simulatedBusy = ["recording"];
        await clickTestId(view, "update-restart-button", 3000);
        const busyDialogShown = await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="update-busy-dialog"]'))`, 4000);
        const busyBodyText = await js<string>(view, `document.querySelector('[data-testid="update-busy-body"]')?.textContent ?? ""`);
        detail.busy = { busyDialogShown, busyBodyText, installerRunsBeforeConfirm: installerRuns.length };
        if (!busyDialogShown || !busyBodyText.includes("正在录音，现在重启会中断录音") || installerRuns.length !== 0) {
          problems.push(`busy dialog check failed: ${JSON.stringify(detail.busy)}`);
        }

        // Cancel busy dialog first, then stop recording and click "重启以更新"
        await clickTestId(view, "update-busy-cancel", 3000);
        await waitUntil(view, `!document.querySelector('[data-testid="update-busy-dialog"]')`, 3000);
        simulatedBusy = [];
        await clickTestId(view, "update-restart-button", 3000);
        for (let i = 0; i < 40 && installerRuns.length === 0; i += 1) {
          await waitFrames(view, 1);
        }

        const preupdateBackup = path.join(appService.layout.partitions.backups, "manga.sqlite.preupdate-v0.1.1.sqlite");
        const backupExists = fs.existsSync(preupdateBackup) && fs.statSync(preupdateBackup).size > 0;
        const sanitizedRestartArgs = (installerRuns[0]?.args ?? []).map((arg) => (arg.startsWith("/D=") ? "/D=<installDir>" : arg));
        detail.restart = {
          installerRuns: installerRuns.length,
          mode: installerRuns[0]?.mode ?? null,
          args: sanitizedRestartArgs,
          backupExists,
        };
        if (installerRuns.length !== 1 || installerRuns[0]?.mode !== "restart" || !backupExists) {
          problems.push(`restartToUpdate or pre-update backup failed: ${JSON.stringify(detail.restart)}`);
        }

        // Transition into first launch of version B (`0.1.2`)
        await switchBuildState(
          appService,
          view,
          {
            version: "0.1.2",
            channel: "release",
            commit: "b012b01",
            builtAt: "2026-11-08T12:00:00.000Z",
            schemaVersion: BUILD_SCHEMA_VERSION,
          },
          { resetUpdateState: true, detectFirstLaunch: true, reloadWindow: true },
        );
        await leaveSettings(view);

        const justUpdatedShown = await waitUntil(
          view,
          `${DRAWN}(document.querySelector('[data-testid="update-just-updated"]')) && (document.querySelector('[data-testid="update-just-updated"]')?.textContent ?? "").includes("已更新到 0.1.2")`,
          6000,
        );
        const justUpdatedNotesOpened = justUpdatedShown
          && await clickTestId(view, "update-just-updated-notes", 3000)
          && await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="update-notes-popover"]'))`, 4000);
        await clickTestId(view, "update-just-updated-dismiss", 3000);
        const justUpdatedDismissed = await waitUntil(view, `!document.querySelector('[data-testid="update-just-updated"]')`, 4000);

        const wsAfter = await call("workspace.get", {});
        const notesAfter = ((wsAfter.value as { notes?: Array<{ title: string }> } | undefined)?.notes) ?? [];
        const dataIntact = notesAfter.some((n) => n.title === "更新演练保留笔记");

        detail.firstLaunchB = {
          version: appService.buildInfo.version,
          justUpdatedShown,
          justUpdatedNotesOpened,
          justUpdatedDismissed,
          dataIntact,
        };
        if (!justUpdatedShown || !justUpdatedNotesOpened || !justUpdatedDismissed || !dataIntact) {
          problems.push(`first launch of 0.1.2 failed: ${JSON.stringify(detail.firstLaunchB)}`);
        }
      } catch (error) {
        problems.push(`update-flow stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("update-flow", problems.length === 0, { ...detail, problems });
    }

    // =========================================================================
    // 3. Observation: `update-on-quit` (AT-159, 计划 4.3, 7)
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        const quitInstallerRuns: Array<{ installerPath: string; args: string[]; mode: string }> = [];

        await switchBuildState(appService, view, {
          version: "0.1.1",
          channel: "release",
          commit,
          builtAt,
          schemaVersion: BUILD_SCHEMA_VERSION,
        });
        await leaveSettings(view);

        appService.update.configure({
          feedUrl: server.baseUrl,
          allowLoopbackHttp: true,
          requireHttps: false,
          publicKeys: testPublicKeys,
          appUpdateConfigPath: appUpdatePath,
          requireAppUpdateConfig: true,
          installDirectory: tempInstallDir,
          runInstaller: (installerPath, args, mode) => {
            quitInstallerRuns.push({ installerPath, args, mode });
            writeBuildInfo(tempResourcesDir, {
              version: "0.1.2",
              channel: "release",
              commit: "b012b01",
              builtAt: "2026-11-08T12:00:00.000Z",
              schemaVersion: BUILD_SCHEMA_VERSION,
            });
            return true;
          },
        });

        const checkRes = await appService.update.check({ manual: false });
        const bannerReady = checkRes.state === "ready"
          && await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="update-banner"]'))`, 6000);

        // User exits application without clicking "重启以更新" -> `installOnQuit()` runs
        const installedOnQuit = await appService.update.installOnQuit();

        // Next launch starts as version B (`0.1.2`)
        await switchBuildState(
          appService,
          view,
          {
            version: "0.1.2",
            channel: "release",
            commit: "b012b01",
            builtAt: "2026-11-08T12:00:00.000Z",
            schemaVersion: BUILD_SCHEMA_VERSION,
          },
          { resetUpdateState: true, detectFirstLaunch: true, reloadWindow: true },
        );
        await leaveSettings(view);

        const statusB = appService.update.status();
        const justUpdatedOnNextStart = statusB.version === "0.1.2" && statusB.justUpdated?.version === "0.1.2";
        appService.update.status({ dismissJustUpdated: true });
        const sanitizedQuitArgs = (quitInstallerRuns[0]?.args ?? []).map((arg) => (arg.startsWith("/D=") ? "/D=<installDir>" : arg));

        Object.assign(detail, {
          bannerReady,
          installedOnQuit,
          quitRuns: quitInstallerRuns.length,
          mode: quitInstallerRuns[0]?.mode ?? null,
          args: sanitizedQuitArgs,
          versionOnNextStart: statusB.version,
          justUpdatedOnNextStart,
        });
        if (!bannerReady || !installedOnQuit || quitInstallerRuns.length !== 1 || quitInstallerRuns[0]?.mode !== "quit" || !justUpdatedOnNextStart) {
          problems.push(`update-on-quit failed: ${JSON.stringify(detail)}`);
        }
      } catch (error) {
        problems.push(`update-on-quit stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("update-on-quit", problems.length === 0, { ...detail, problems });
    }

    // =========================================================================
    // 4. Observation: `update-rejected` (AT-160, 计划 3.1, 4.4, 7)
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        await switchBuildState(appService, view, {
          version: "0.1.1",
          channel: "release",
          commit,
          builtAt,
          schemaVersion: BUILD_SCHEMA_VERSION,
        });
        appService.update.configure({
          feedUrl: server.baseUrl,
          allowLoopbackHttp: true,
          requireHttps: false,
          publicKeys: testPublicKeys,
          appUpdateConfigPath: appUpdatePath,
          requireAppUpdateConfig: true,
          installDirectory: tempInstallDir,
        });

        await openSettingsPage(view, "update");
        const pendingExe = path.join(appService.layout.partitions.cache, "updater", "pending", v2FileName);

        // (1) 1-byte tampered installer
        const tamperedBytes = Buffer.from(v2Bytes);
        tamperedBytes[128] = tamperedBytes[128]! ^ 0xff;
        server.files.clear();
        server.files.set(
          "latest.yml",
          formatLatestYaml({
            version: "0.1.2",
            fileName: v2FileName,
            sha512: sha512BytesBase64(tamperedBytes),
            size: tamperedBytes.length,
          }),
        );
        server.files.set(v2FileName, tamperedBytes);
        server.files.set(`${v2FileName}.sig`, v2Signed.sigText);

        const resTampered = await appService.update.check({ manual: true });
        await waitUntil(view, `(document.querySelector('[data-testid="update-state-label"]')?.textContent ?? "").includes("更新包校验失败")`, 4000);
        const uiTampered = await js<string>(view, `document.querySelector('[data-testid="update-state-label"]')?.textContent ?? ""`);
        detail.tampered = {
          state: resTampered.state,
          errorCode: resTampered.errorCode,
          fileDeleted: !fs.existsSync(pendingExe),
          uiText: uiTampered,
        };
        if (resTampered.state !== "error" || resTampered.errorCode !== "UPDATE_VERIFY_FAILED" || fs.existsSync(pendingExe) || !uiTampered.includes("更新包校验失败")) {
          problems.push(`1-byte tampered installer was not properly rejected: ${JSON.stringify(detail.tampered)}`);
        }

        // (2) Valid signature from another version (`0.1.1` signature for `0.1.2` installer)
        const wrongVerSig = signReleaseInstaller({
          installerPath: v2TempFile,
          version: "0.1.1",
          fileName: "manga-setup-0.1.1.exe",
          privateKeyPem,
          outputSigPath: null,
        });
        server.files.set(
          "latest.yml",
          formatLatestYaml({
            version: "0.1.2",
            fileName: v2FileName,
            sha512: sha512BytesBase64(v2Bytes),
            size: v2Bytes.length,
          }),
        );
        server.files.set(v2FileName, v2Bytes);
        server.files.set(`${v2FileName}.sig`, wrongVerSig.sigText);

        const resWrongVer = await appService.update.check({ manual: true });
        detail.wrongVersionSig = {
          state: resWrongVer.state,
          errorCode: resWrongVer.errorCode,
          fileDeleted: !fs.existsSync(pendingExe),
        };
        if (resWrongVer.state !== "error" || resWrongVer.errorCode !== "UPDATE_VERIFY_FAILED" || fs.existsSync(pendingExe)) {
          problems.push(`wrong-version signature was not rejected: ${JSON.stringify(detail.wrongVersionSig)}`);
        }

        // (3) Missing `.sig` file (404)
        server.files.delete(`${v2FileName}.sig`);
        const resNoSig = await appService.update.check({ manual: true });
        detail.missingSig = {
          state: resNoSig.state,
          errorCode: resNoSig.errorCode,
          fileDeleted: !fs.existsSync(pendingExe),
        };
        if (resNoSig.state !== "error" || resNoSig.errorCode !== "UPDATE_VERIFY_FAILED" || fs.existsSync(pendingExe)) {
          problems.push(`missing .sig was not rejected: ${JSON.stringify(detail.missingSig)}`);
        }

        // (4) Older version (`0.1.0` when on `0.1.1`)
        server.files.set(
          "latest.yml",
          formatLatestYaml({
            version: "0.1.0",
            fileName: "manga-setup-0.1.0.exe",
            sha512: sha512BytesBase64(v2Bytes),
            size: v2Bytes.length,
          }),
        );
        const resDowngrade = await appService.update.check({ manual: true });
        await waitUntil(view, `(document.querySelector('[data-testid="update-state-label"]')?.textContent ?? "").includes("拒绝安装旧版本更新包")`, 4000);
        const uiDowngrade = await js<string>(view, `document.querySelector('[data-testid="update-state-label"]')?.textContent ?? ""`);
        detail.downgrade = {
          state: resDowngrade.state,
          errorCode: resDowngrade.errorCode,
          uiText: uiDowngrade,
        };
        if (resDowngrade.state !== "error" || resDowngrade.errorCode !== "UPDATE_VERIFY_FAILED" || !uiDowngrade.includes("拒绝安装旧版本更新包")) {
          problems.push(`downgrade was not rejected: ${JSON.stringify(detail.downgrade)}`);
        }

        // (5) Non-HTTPS URL (`http://` rejected when `requireHttps: true`)
        appService.update.configure({ requireHttps: true });
        const resHttp = await appService.update.check({ manual: true });
        await waitUntil(view, `(document.querySelector('[data-testid="update-state-label"]')?.textContent ?? "").includes("HTTPS")`, 4000);
        const uiHttp = await js<string>(view, `document.querySelector('[data-testid="update-state-label"]')?.textContent ?? ""`);
        appService.update.configure({ requireHttps: false });
        detail.nonHttps = {
          state: resHttp.state,
          errorCode: resHttp.errorCode,
          uiText: uiHttp,
        };
        if (resHttp.state !== "error" || resHttp.errorCode !== "UPDATE_VERIFY_FAILED" || !uiHttp.includes("HTTPS")) {
          problems.push(`non-HTTPS feed URL was not rejected: ${JSON.stringify(detail.nonHttps)}`);
        }

        // (6) `app-update.yml` with `publisherName` stripped (计划 3.1, AT-160)
        const yamlWithoutPublisher = makeAppUpdateYaml([]);
        const configProblems = checkAppUpdateConfig(yamlWithoutPublisher);
        fs.writeFileSync(appUpdatePath, yamlWithoutPublisher, "utf8");

        const scratchTampered = path.join(tempRoot, "nsis-tampered.exe");
        fs.writeFileSync(scratchTampered, tamperedBytes);
        const nsisUpdaterNoPub = createConfiguredNsisUpdater({
          updateService: appService.update,
          version: "0.1.1",
          appUpdateConfigPath: appUpdatePath,
          userDataPath: appService.layout.partitions.runtime,
          baseCachePath: appService.layout.partitions.cache,
          expectedVersion: () => "0.1.2",
          expectedFileName: () => v2FileName,
          sigText: () => v2Signed.sigText,
        });
        const nsisSkippedResult = await invokeNsisVerifySignature(nsisUpdaterNoPub, scratchTampered);

        server.files.set(
          "latest.yml",
          formatLatestYaml({
            version: "0.1.2",
            fileName: v2FileName,
            sha512: sha512BytesBase64(v2Bytes),
            size: v2Bytes.length,
          }),
        );
        server.files.set(v2FileName, v2Bytes);
        server.files.set(`${v2FileName}.sig`, v2Signed.sigText);

        const resNoPub = await appService.update.check({ manual: true });
        fs.writeFileSync(appUpdatePath, makeAppUpdateYaml(["chialecode"]), "utf8");
        detail.withoutPublisherName = {
          configProblems,
          nsisSkippedVerificationWhenMissing: nsisSkippedResult === null,
          serviceRejected: resNoPub.state === "error" && resNoPub.errorCode === "UPDATE_VERIFY_FAILED",
          fileDeleted: !fs.existsSync(pendingExe),
        };
        if (
          !configProblems.includes("missing publisherName chialecode")
          || nsisSkippedResult !== null
          || resNoPub.state !== "error"
          || resNoPub.errorCode !== "UPDATE_VERIFY_FAILED"
          || fs.existsSync(pendingExe)
        ) {
          problems.push(`missing publisherName check failed: ${JSON.stringify(detail.withoutPublisherName)}`);
        }

        const rejectedLogs = appService.log.query({ category: "settings" }).entries.filter((e) => e.action === "update.rejected");
        detail.rejectedLogsCount = rejectedLogs.length;
        detail.versionRemained = appService.buildInfo.version;
        if (rejectedLogs.length < 6 || appService.buildInfo.version !== "0.1.1") {
          problems.push(`expected >= 6 update.rejected operation log entries and version 0.1.1, got ${rejectedLogs.length} / ${appService.buildInfo.version}`);
        }
        await leaveSettings(view);
      } catch (error) {
        problems.push(`update-rejected stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("update-rejected", problems.length === 0, { ...detail, problems });
    }

    // =========================================================================
    // 5. Observation: `update-offline` (AT-160, 计划 4.3, 4.4, 7)
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        await switchBuildState(appService, view, {
          version: "0.1.1",
          channel: "release",
          commit,
          builtAt,
          schemaVersion: BUILD_SCHEMA_VERSION,
        });
        appService.update.configure({
          feedUrl: "http://127.0.0.1:9",
          allowLoopbackHttp: true,
          requireHttps: false,
          publicKeys: testPublicKeys,
          appUpdateConfigPath: appUpdatePath,
          requireAppUpdateConfig: true,
        });
        await leaveSettings(view);

        // Automatic check when offline: stays silent (`idle`, no error banner or toast)
        await js(view, `document.querySelector('[data-testid="toast-error-close"]')?.click()`);
        const autoRes = await appService.update.check({ manual: false });
        await waitFrames(view, 2);
        const silentInUi = await js<boolean>(
          view,
          `!document.querySelector('[data-testid="update-banner"]') && !document.querySelector('[data-testid="toast-error"]')`,
        );
        detail.autoOffline = {
          state: autoRes.state,
          error: autoRes.error,
          silentInUi,
        };
        if (autoRes.state !== "idle" || autoRes.error !== null || !silentInUi) {
          problems.push(`automatic offline check was not silent: ${JSON.stringify(detail.autoOffline)}`);
        }

        // Manual check in "设置 › 更新" displays connection error
        const pageOpened = await openSettingsPage(view, "update");
        const clickedCheck = pageOpened && await clickTestId(view, "update-check-now", 3000);
        const errorShown = clickedCheck && await waitUntil(
          view,
          `(document.querySelector('[data-testid="update-state-label"]')?.textContent ?? "").includes("无法连接更新源")`,
          6000,
        );
        const uiErrorText = await js<string>(view, `document.querySelector('[data-testid="update-state-label"]')?.textContent ?? ""`);

        // Toggle "自动检查更新" off and verify it persists, then restore
        await clickTestId(view, "update-auto-check", 3000);
        await waitUntil(view, `document.querySelector('[data-testid="update-auto-check"]')?.checked === false`, 3000);
        const autoCheckOff = appService.update.getSettings().autoCheck === false;
        await clickTestId(view, "update-auto-check", 3000);
        await waitUntil(view, `document.querySelector('[data-testid="update-auto-check"]')?.checked === true`, 3000);

        await leaveSettings(view);
        detail.manualOffline = {
          pageOpened,
          clickedCheck,
          errorShown,
          uiErrorText,
          autoCheckOff,
        };
        if (!errorShown || !uiErrorText.includes("无法连接更新源") || !autoCheckOff) {
          problems.push(`manual offline check or autoCheck toggle failed: ${JSON.stringify(detail.manualOffline)}`);
        }
      } catch (error) {
        problems.push(`update-offline stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("update-offline", problems.length === 0, { ...detail, problems });
    }
  } finally {
    await server.close();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  const failed = observations.filter((row) => row.status !== "passed").map((row) => row.name);
  if (logsDir) {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "update-observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
  }
  return { ok: failed.length === 0, failed, observations };
}
