import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { MangaProductApp, ElectronSafeStorageVault, resolveLaunchLayout, persistPointer, buildEpubFixture, buildMobiFixture, buildPdfFixture } from "@manga/app-core";
import { productWindow } from "./window-options.ts";
import { createId, LOCATION_PARTITIONS } from "@manga/contracts";
import { safeStorage } from "electron";

const smoke = process.argv.includes("--m1a-smoke");
function pinPdfjsDir(): void {
  const packaged = path.join(process.resourcesPath, "pdfjs");
  if (fs.existsSync(path.join(packaged, "legacy", "build", "pdf.mjs"))) process.env.MANGA_PDFJS_DIR = packaged;
}
pinPdfjsDir();
if (process.env.MANGA_DOCUMENTS_DIR === undefined) {
  try {
    process.env.MANGA_DOCUMENTS_DIR = app.getPath("documents");
  } catch {
    // keep homedir fallback inside resolveLaunchLayout
  }
}

const layout = resolveLaunchLayout({
  packaged: app.isPackaged,
  profileRoot: process.env.MANGA_PROFILE_ROOT,
  channel: process.env.MANGA_CHANNEL as "release" | "development" | "test" | undefined,
});
app.setPath("userData", layout.partitions.runtime);
app.setPath("sessionData", layout.partitions.runtime);
if (layout.writable) persistPointer(layout);

let appService: MangaProductApp | undefined;
let ownerGrant: string | undefined;
const actor = { kind: "user" as const, id: "desktop-user" };
let window: BrowserWindow | undefined;
const rendererUrl = () => MAIN_WINDOW_VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)).href;

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

function assertCaller(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error("拒绝非应用主界面的调用");
  }
}

async function bootService(): Promise<void> {
  if (!layout.writable) return;
  appService = new MangaProductApp({
    profileRoot: layout.defaultRoot,
    channel: layout.channel,
    pointerPath: layout.pointerPath,
    documentsDir: layout.documentsRoot,
    packaged: app.isPackaged,
    hostId: "desktop",
    vault: new ElectronSafeStorageVault(safeStorage),
    useParseWorker: true,
    nativeBinding: app.isPackaged ? undefined : path.join(__dirname, "../../../../dist/desktop/native/electron-37.4.0-x64/better_sqlite3.node"),
    parseWorkerPath: [
      path.join(process.resourcesPath, "parse-worker.cjs"),
      path.join(__dirname, "parse-worker.cjs").replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`),
      path.join(__dirname, "parse-worker.cjs"),
    ].find((file) => fs.existsSync(file)),
  });
  await appService.start();
  ownerGrant = appService.issueOwnerGrant(actor).handle;
}

app.whenReady().then(async () => {
  try {
    await bootService();
  } catch (error) {
    if (smoke) {
      fs.mkdirSync(layout.partitions.logs, { recursive: true });
      fs.writeFileSync(path.join(layout.partitions.logs, `smoke-${process.env.M1A_SMOKE_PHASE ?? "initial"}.json`), `${JSON.stringify({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        writable: layout.writable,
        channel: layout.channel,
      }, null, 2)}\n`);
      app.exit(1);
      return;
    }
    throw error;
  }
  window = new BrowserWindow({
    width: productWindow.width,
    height: productWindow.height,
    minWidth: productWindow.minWidth,
    minHeight: productWindow.minHeight,
    show: !smoke,
    backgroundColor: productWindow.backgroundColor,
    titleBarStyle: productWindow.titleBarStyle,
    ...(process.platform === "win32" ? { titleBarOverlay: productWindow.titleBarOverlay } : {}),
    webPreferences: {
      preload: fs.existsSync(path.join(__dirname, "preload.cjs"))
        ? path.join(__dirname, "preload.cjs")
        : path.join(__dirname, "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A hidden smoke window is throttled to about one frame per second; timing phases must see real frames.
      ...(smoke && process.env.M1A_SMOKE_PHASE?.startsWith("bench") ? { backgroundThrottling: false } : {}),
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const url = rendererUrl();
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  ipcMain.handle("manga:command", async (event, payload) => {
    assertCaller(event);
    if (!appService || !ownerGrant) return { status: "error", error: { code: "LOCATION_UNAVAILABLE", message: "目录不可写或尚未完成配置", retryable: false, details: { recovery: layout.recovery } } };
    if (!payload || typeof payload.commandId !== "string") throw new Error("invalid command");
    return appService.call(actor, payload, ownerGrant, createId("ui"));
  });
  ipcMain.handle("manga:state", (event) => {
    assertCaller(event);
    return {
      layout,
      writable: layout.writable,
      vaultAvailable: safeStorage.isEncryptionAvailable(),
      packaged: app.isPackaged,
    };
  });
  ipcMain.handle("manga:choose-directory", async (event) => {
    assertCaller(event);
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const chosen = result.filePaths[0];
    if (!appService) {
      persistPointer({
        ...layout,
        defaultRoot: chosen,
        partitions: Object.fromEntries(LOCATION_PARTITIONS.map((name) => [name, path.join(chosen, name)])) as typeof layout.partitions,
      });
      if (!smoke) {
        app.relaunch();
        app.exit(0);
      }
      return chosen;
    }
    return appService.registerPath("directory", chosen);
  });
  ipcMain.handle("manga:choose-file", async (event) => {
    assertCaller(event);
    if (!window || !appService || !ownerGrant) return null;
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Text", extensions: ["txt"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const bytes = [...fs.readFileSync(file)];
    return appService.call(actor, {
      commandId: "library.importText",
      idempotencyKey: createId("import"),
      input: { title: path.basename(file), bytes },
    }, ownerGrant);
  });
  ipcMain.handle("manga:choose-book", async (event) => {
    assertCaller(event);
    if (!window || !appService || !ownerGrant) return null;
    // Formats smoke supplies a synthetic file so the failure and success paths use the same import button.
    const smoked = process.env.M1A_SMOKE_PHASE === "formats" ? process.env.M1B_SMOKE_BOOK : undefined;
    let file = smoked;
    if (!file) {
      const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Book", extensions: ["txt", "epub", "mobi", "pdf"] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      file = result.filePaths[0];
    }
    const handle = appService.registerPath("file", file);
    return appService.call(actor, {
      commandId: "library.importDocument",
      idempotencyKey: createId("book"),
      input: { title: path.basename(file), pathHandle: handle, format: "auto" },
    }, ownerGrant);
  });
  ipcMain.handle("manga:choose-audio", async (event) => {
    assertCaller(event);
    if (!window || !appService) return null;
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "ogg", "webm"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return appService.registerPath("file", result.filePaths[0]);
  });
  /** A chosen file the renderer passes back as a path handle, without importing it. */
  ipcMain.handle("manga:choose-path", async (event) => {
    assertCaller(event);
    if (!window || !appService) return null;
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Book", extensions: ["txt", "epub", "mobi", "pdf"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return appService.registerPath("file", result.filePaths[0]);
  });
  ipcMain.handle("manga:reveal", async (event, itemId: string) => {
    assertCaller(event);
    if (!appService || !ownerGrant) return { status: "error", error: { code: "LOCATION_UNAVAILABLE", message: "目录不可写或尚未完成配置", retryable: false, details: {} } };
    const result = await appService.call(actor, { commandId: "inventory.reveal", idempotencyKey: createId("reveal"), input: { id: itemId } }, ownerGrant);
    const revealed = result.value as { path?: string } | undefined;
    if (result.status === "ok" && typeof revealed?.path === "string") {
      await shell.openPath(revealed.path);
    }
    return result;
  });
  ipcMain.handle("manga:secret", async (event, value: string) => {
    assertCaller(event);
    if (!appService) return null;
    if (typeof value !== "string" || value.length < 1 || value.length > 4096) throw new Error("invalid secret");
    return appService.stashSecret(value);
  });
  if (smoke) {
    try {
      await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const text = document.body ? document.body.innerText : "";
          if (text && !text.includes("正在加载") && text.length > 8) resolve(true);
          else if (Date.now() - started > 8000) resolve(false);
          else setTimeout(tick, 50);
        };
        tick();
      })`);
    } catch {
      // screenshot may still be taken
    }
    const phaseName = process.env.M1A_SMOKE_PHASE ?? "initial";
    let markerRestored: boolean | undefined;
    const reportExtras: Record<string, unknown> = {};
    if (appService && ownerGrant) {
      if (phaseName === "initial") {
        await appService.call(actor, { commandId: "notes.create", idempotencyKey: "m1a-smoke-marker", input: { title: "m1a-smoke-marker", text: "written before restart" } }, ownerGrant);
      } else if (phaseName === "restart") {
        const ws = await appService.call(actor, { commandId: "workspace.get", idempotencyKey: createId("smoke"), input: {} }, ownerGrant);
        const notes = (ws.status === "ok" ? (ws.value as { notes?: Array<{ title: string }> }).notes : undefined) ?? [];
        markerRestored = notes.some((note) => note.title === "m1a-smoke-marker");
      } else if (phaseName === "agent" || phaseName === "agent-restart") {
        const flow = await runAgentSmoke(appService, ownerGrant, window, phaseName);
        markerRestored = flow.ok;
        Object.assign(reportExtras, flow);
      } else if (phaseName === "reading") {
        const opened = await clickTestId(window, "nav-reading");
        await window.setContentSize(productWindow.width, productWindow.height);
        const wide = await window.webContents.executeJavaScript(`({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio })`);
        await window.setContentSize(720, 540);
        const narrow = await window.webContents.executeJavaScript(`({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio })`);
        reportExtras.readingNav = opened;
        reportExtras.viewports = { wide, narrow };
        markerRestored = opened;
      } else if (phaseName === "closure" || phaseName === "closure-restart") {
        const flow = await runClosureSmoke(appService, ownerGrant, window, phaseName);
        markerRestored = flow.ok;
        Object.assign(reportExtras, flow);
      } else if (phaseName === "formats") {
        const flow = await runFormatsSmoke(appService, ownerGrant, window);
        markerRestored = flow.ok;
        Object.assign(reportExtras, flow);
      } else if (phaseName === "bench-scale") {
        const spec = JSON.parse(fs.readFileSync(String(process.env.M1B_BENCH_SCALE_SPEC), "utf8")) as ScaleSpec;
        const measured = await measureScaleWindowBench(appService, ownerGrant, window, spec);
        reportExtras.scaleOk = measured.ok;
        markerRestored = measured.ok === true;
        fs.mkdirSync(layout.partitions.logs, { recursive: true });
        fs.writeFileSync(path.join(layout.partitions.logs, "bench-scale-window.json"), `${JSON.stringify(measured, null, 2)}\n`);
      } else if (phaseName === "bench") {
        const launchedAt = Number(process.env.M1A_LAUNCHED_AT ?? Date.now());
        reportExtras.readyMs = Date.now() - launchedAt;
        const measured = await measureWindowBench(window);
        Object.assign(reportExtras, measured);
        markerRestored = measured.ok === true;
        fs.mkdirSync(layout.partitions.logs, { recursive: true });
        fs.writeFileSync(path.join(layout.partitions.logs, "bench-window.json"), `${JSON.stringify({
          readyMs: reportExtras.readyMs,
          interactionMs: measured.interactionMs,
          contentAvailableMs: measured.contentAvailableMs,
          saveReceiptMs: measured.saveReceiptMs,
          importToReadableMs: measured.importToReadableMs,
          waitedForContent: measured.waitedForContent === true,
          process: "electron",
          ok: measured.ok === true,
        }, null, 2)}\n`);
      }
    }
    const facets = appService ? [...appService.uiFacets] : [];
    const report = {
      writable: layout.writable,
      channel: layout.channel,
      uiFacets: facets,
      markerRestored,
      ...reportExtras,
      status: layout.writable && facets.length > 0 && markerRestored !== false && reportExtras.ok !== false ? "passed" : "failed",
    };
    fs.mkdirSync(layout.partitions.logs, { recursive: true });
    fs.writeFileSync(path.join(layout.partitions.logs, `smoke-${process.env.M1A_SMOKE_PHASE ?? "initial"}.json`), `${JSON.stringify(report, null, 2)}\n`);
    const evidenceDir = process.env.M1A_EVIDENCE_DIR;
    const phase = process.env.M1A_SMOKE_PHASE ?? "initial";
    const view = window;
    if (evidenceDir && view) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      const capture = async (name: string) => {
        const png = await view.capturePage();
        fs.writeFileSync(path.join(evidenceDir, name), png.toPNG());
      };
      await capture(`ui-smoke-${phase}.png`);
      if (phase === "initial") {
        for (const tab of ["library"] as const) {
          await view.webContents.executeJavaScript(`(() => {
            const el = document.querySelector('[data-testid="nav-${tab}"]');
            if (!el) return false;
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
            return true;
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 250));
          await capture(`ui-smoke-${phase}-${tab}.png`);
        }
      }
      if (phase === "agent" || phase === "agent-restart") {
        await view.webContents.executeJavaScript(`(() => {
          const el = document.querySelector('[data-testid="nav-copilot"]');
          if (!el) return false;
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
          return true;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await capture(`ui-smoke-${phase}-copilot.png`);
      }
      if (phase === "closure" || phase === "closure-restart") {
        await clickTestId(view, "nav-notes");
        await new Promise((resolve) => setTimeout(resolve, 250));
        await capture(`ui-smoke-${phase}-notes.png`);
        await clickTestId(view, "nav-reading");
        await new Promise((resolve) => setTimeout(resolve, 250));
        await capture(`ui-smoke-${phase}-reading.png`);
      }
    }
    appService?.close();
    appService = undefined;
    app.exit(report.status === "passed" ? 0 : 1);
  }
});

app.on("window-all-closed", () => {
  appService?.close();
  app.quit();
});

async function clickTestId(view: BrowserWindow, testId: string): Promise<boolean> {
  return view.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    return true;
  })()`) as Promise<boolean>;
}

/** Wait until a test id exists, optionally with an attribute equal to an expected value. */
async function waitForTestId(view: BrowserWindow, testId: string, attribute = "data-present", expected: string | null = null, timeoutMs = 15_000): Promise<boolean> {
  return view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector('[data-testid="${testId}"]');
      const ok = el && (${expected === null ? "true" : `el.getAttribute("${attribute}") === ${JSON.stringify(expected)}`});
      if (ok) resolve(true);
      else if (Date.now() - started > ${timeoutMs}) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as Promise<boolean>;
}

/**
 * End-to-end closure smoke through the real renderer: import a synthetic book, read to the last
 * chapter, select text, record a note, jump to the source and back, then verify restart recovery.
 * Timing is measured around real operations, not around synthetic click dispatch.
 */
async function runClosureSmoke(appService: MangaProductApp, grant: string, view: BrowserWindow, phase: string): Promise<Record<string, unknown> & { ok: boolean }> {
  const call = (commandId: string, input: Record<string, unknown>, key = createId("smoke")) =>
    appService.call(actor, { commandId, idempotencyKey: key, input }, grant);
  if (phase === "closure-restart") {
    const workspace = await call("workspace.get", {});
    const notes = ((workspace.value as { notes?: Array<{ id: string; title: string; resourceId: string | null }> } | undefined)?.notes) ?? [];
    const restoredNote = notes.find((note) => note.title.includes("闭合样本"));
    const resources = ((workspace.value as { resources?: Array<{ id: string; title: string }> } | undefined)?.resources) ?? [];
    const restoredResource = resources.find((resource) => resource.title.includes("闭合样本"));
    let restoredProgress = false;
    if (restoredResource) {
      const read = await call("library.read", { resourceId: restoredResource.id });
      const progress = (read.value as { progress?: { restoredFrom?: string; restoredRange?: { start?: number } } } | undefined)?.progress;
      restoredProgress = progress?.restoredFrom === "progress" && Number(progress.restoredRange?.start ?? 0) > 0;
    }
    // The source link and the frozen task materials have to survive the restart, not just the rows.
    let restoredSource = false;
    if (restoredNote) {
      const opened = await call("notes.openSource", { objectId: restoredNote.id });
      restoredSource = (opened.value as { card?: { status?: string } } | undefined)?.card?.status === "resolved";
    }
    let restoredMaterials = false;
    const runs = ((workspace.value as { runs?: Array<{ id: string; inputText?: string }> } | undefined)?.runs) ?? [];
    const closureRun = runs.find((run) => run.inputText === "用材料回答闭合问题");
    if (closureRun) {
      const detail = await call("agent.getRun", { runId: closureRun.id });
      const contextText = String((detail.value as { contextText?: string } | undefined)?.contextText ?? "");
      restoredMaterials = contextText.includes("chi-close-sel") && contextText.includes("闭合样本正文");
    }
    const openedReading = await clickTestId(view, "nav-reading");
    let uiRestoredTail = false;
    if (restoredResource && openedReading) {
      const openedBook = await clickTestId(view, `open-${restoredResource.id}`);
      if (openedBook) {
        uiRestoredTail = await view.webContents.executeJavaScript(`new Promise((resolve) => {
          const started = Date.now();
          const tick = () => {
            const status = document.querySelector('[data-testid="reading-restore-status"]');
            const text = document.querySelector('[data-testid="reading-body"]')?.textContent ?? "";
            const offset = Number(status?.getAttribute("data-offset") ?? "0");
            if (status?.getAttribute("data-restored") === "progress" && offset > 0 && text.includes("chi-close-tail")) resolve(true);
            else if (Date.now() - started > 8000) resolve(false);
            else setTimeout(tick, 50);
          };
          tick();
        })`) as boolean;
      }
    }
    const bodyText = await view.webContents.executeJavaScript(`document.body ? document.body.innerText : ""`) as string;
    // The restart must restore the note, the resource, the tail position on screen and the frozen materials.
    const ok = Boolean(restoredNote) && Boolean(restoredResource) && restoredProgress && restoredSource && restoredMaterials && uiRestoredTail && bodyText.includes("chi-close-tail");
    return { ok, restoredNote: Boolean(restoredNote), restoredResource: Boolean(restoredResource), restoredProgress, restoredSource, restoredMaterials, uiRestoredTail, readingWithNote: bodyText.includes("闭合样本") };
  }

  await call("settings.skipAi", {});
  // The middle is longer than the first reading window, so the tail is not on screen until the reader moves.
  const body = "闭合样本第一章。chi-close-sel 开头标记。\n" + "中段正文用于闭合检查。\n".repeat(120) + "末章结尾标记 chi-close-tail。";
  const importedAt = Date.now();
  const imported = await call("library.importDocument", { title: "闭合样本书", format: "txt", bytes: [...Buffer.from(body)] }, "closure-import");
  const importMs = Date.now() - importedAt;
  if (imported.status !== "ok") return { ok: false, reason: "import failed", detail: imported.error };
  const resourceId = String((imported.value as { resourceId: string }).resourceId);
  const revisionId = String((imported.value as { revisionId: string }).revisionId);

  // Read to the computed tail, exercising the real content-available path.
  const tailStart = Math.max(0, [...body].length - 40);
  const tailAt = Date.now();
  const tail = await call("library.readSlice", { resourceId, revisionId, partId: "body", start: tailStart, limit: 200 }, "closure-tail");
  const tailMs = Date.now() - tailAt;
  const tailText = String((tail.value as { text?: string } | undefined)?.text ?? "");
  const readLastChapter = tailText.includes("chi-close-tail");

  // Select a real range in the rendered body and record it through the UI button.
  // The renderer is reloaded first because the import happened through the service, so its
  // workspace cache is stale and the new resource would not be listed yet.
  await view.webContents.reload();
  await waitForTestId(view, "nav-reading");
  await clickTestId(view, "nav-reading");
  const openedResource = await view.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-testid="open-${resourceId}"]');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    return true;
  })()`) as boolean;
  await waitForTestId(view, "reading-body");
  // Select first: marking progress re-reads the document and would replace the selected text node.
  // The range sits mid-line, so a reader that hands over the whole window would fail the check below.
  const selection = await view.webContents.executeJavaScript(`(() => {
    const body = document.querySelector('[data-testid="reading-body"]');
    if (!body || !body.firstChild) return { ms: -1, quote: "" };
    const started = performance.now();
    const range = document.createRange();
    range.setStart(body.firstChild, 8);
    range.setEnd(body.firstChild, 21);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return { ms: performance.now() - started, quote: range.toString() };
  })()`) as { ms: number; quote: string };
  const selectMs = selection.ms;
  const selectedQuote = selection.quote;
  // The record button only enables once React has observed the selection.
  await waitForTestId(view, "reading-note");
  const noteEnabled = await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector('[data-testid="reading-note"]');
      if (el && !el.disabled) resolve(true);
      else if (Date.now() - started > 8000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as boolean;
  const noteAt = Date.now();
  await clickTestId(view, "reading-note");
  const noteSurfaceOpened = await waitForTestId(view, "note-surface", "data-present", null, 10_000);
  const noteSaved = noteSurfaceOpened ? await waitForTestId(view, "note-editor", "data-save-state", "saved", 20_000) : false;
  // The receipt is what the user waits for, so the timing ends there and not at the click.
  const noteMs = Date.now() - noteAt;
  await new Promise((resolve) => setTimeout(resolve, 500));
  const workspace = await call("workspace.get", {});
  const notes = ((workspace.value as { notes?: Array<{ id: string; title: string }> } | undefined)?.notes) ?? [];
  const recorded = notes.find((note) => note.title.includes("闭合样本"));

  // The recorded excerpt must be the selected range, not the whole window the reader handed over.
  let quoteRange: { start: number; end: number } | null = null;
  let excerpt = "";
  let selectionAccurate = false;
  if (recorded) {
    // The user's own comment is a second block, written after the excerpt as in the real editor.
    await call("notes.update", { objectId: recorded.id, expectedRevision: 1, blockId: "b1", text: "闭合样本正文" }, "closure-comment");
    const read = await call("notes.get", { objectId: recorded.id });
    const blocks = ((read.value as { document?: { blocks?: Array<{ id: string; text: string; anchorId?: string }> } } | undefined)?.document?.blocks) ?? [];
    excerpt = blocks.find((block) => block.anchorId)?.text ?? "";
    const locator = ((read.value as { sources?: Array<{ blockId: string | null; locator: string }> } | undefined)?.sources ?? [])
      .find((source) => source.blockId === blocks.find((block) => block.anchorId)?.id)?.locator;
    quoteRange = locator ? JSON.parse(locator).range ?? null : null;
    selectionAccurate = excerpt === selectedQuote && selectedQuote === "chi-close-sel" && quoteRange?.start === 8 && quoteRange.end === 21;
  }

  // Move through the reader to the tail and mark that position. The first window must not already contain it.
  await clickTestId(view, "nav-reading");
  await waitForTestId(view, "reading-body");
  const firstWindowHasTail = await view.webContents.executeJavaScript(`(document.querySelector('[data-testid="reading-body"]')?.textContent ?? "").includes("chi-close-tail")`) as boolean;
  const moved = await clickTestId(view, "reading-more");
  const uiTailVisible = !firstWindowHasTail && moved && await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const text = document.querySelector('[data-testid="reading-body"]')?.textContent ?? "";
      if (text.includes("chi-close-tail")) resolve(true);
      else if (Date.now() - started > 8000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as boolean;
  const marked = uiTailVisible && await clickTestId(view, "reading-progress");
  const progressAtTail = marked && await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const status = document.querySelector('[data-testid="reading-restore-status"]');
      const text = document.querySelector('[data-testid="reading-body"]')?.textContent ?? "";
      const offset = Number(status?.getAttribute("data-offset") ?? "0");
      if (status?.getAttribute("data-restored") === "progress" && offset > 0 && text.includes("chi-close-tail")) resolve(true);
      else if (Date.now() - started > 8000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as boolean;

  // Jump from the note back to its source and then return.
  let sourceCardOk = false;
  if (recorded) {
    // Reload so the notes list reflects the note created through the service.
    await view.webContents.reload();
    await waitForTestId(view, "nav-notes");
    await clickTestId(view, "nav-notes");
    const openSource = await waitForTestId(view, `note-source-${recorded.id}`, "data-present", null, 10_000)
      && await clickTestId(view, `note-source-${recorded.id}`);
    if (openSource) sourceCardOk = await waitForTestId(view, "reading-source-card", "data-present", null, 15_000);
    if (sourceCardOk) {
      const returned = await clickTestId(view, "reading-source-back");
      sourceCardOk = returned && await waitForTestId(view, "note-surface", "data-present", null, 10_000);
    }
  }

  // Reader style controls must be reachable and persist, and a bookmark must keep a real range.
  await clickTestId(view, "nav-reading");
  const styleReachable = await waitForTestId(view, "reading-font-size", "data-present", null, 10_000);
  await clickTestId(view, "reading-theme-green");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const shellAfter = await call("settings.getShell", {});
  const theme = (shellAfter.value as { reading?: { theme?: string } } | undefined)?.reading?.theme;

  // A bookmark taken in the reader has to be listed, openable and removable.
  const bookmarkAdded = await clickTestId(view, "reading-bookmark-add");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const bookmarks = await call("reading.bookmarks", { resourceId });
  const bookmarkRows = (bookmarks.value as Array<{ id: string }> | undefined) ?? [];
  let bookmarkHighlighted = false;
  if (bookmarkRows[0]) {
    await clickTestId(view, `reading-bookmark-${bookmarkRows[0].id}`);
    // Opening a bookmark draws the stored range; it must not widen the read range as a side effect.
    bookmarkHighlighted = await waitForTestId(view, "reading-quote-hit", "data-present", null, 5_000);
  }
  const beforeRemove = await call("library.read", { resourceId });
  const readRangesBefore = ((beforeRemove.value as { readRanges?: unknown[] } | undefined)?.readRanges ?? []).length;
  const progressStillAtTail = Number(((beforeRemove.value as { progress?: { restoredRange?: { start?: number } } } | undefined)?.progress?.restoredRange?.start) ?? 0) > 0;
  if (bookmarkRows[0]) await clickTestId(view, `reading-bookmark-remove-${bookmarkRows[0].id}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const afterRemove = await call("reading.bookmarks", { resourceId });
  const bookmarkRemoved = ((afterRemove.value as unknown[] | undefined) ?? []).length === bookmarkRows.length - 1;

  // Send from the composer on the reading surface. The receipt has to match the text the pane shows.
  let materialsFrozen = false;
  let materialsFromUi = false;
  let contextChars = 0;
  const agentReady = await view.webContents.executeJavaScript(`(() => {
    const body = document.querySelector('[data-testid="reading-body"]');
    if (!body) return false;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !(node.textContent || "").trim()) node = walker.nextNode();
    if (!node || !node.textContent) return false;
    const end = Math.min(8, node.textContent.length);
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return true;
  })()`) as boolean;
  const agentEnabled = agentReady && await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector('[data-testid="reading-select-agent"]');
      if (el && !el.disabled) resolve(true);
      else if (Date.now() - started > 8000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as boolean;
  if (agentEnabled) {
    await clickTestId(view, "reading-select-agent");
    await view.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-testid="agent-composer"]');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      set.call(el, "用材料回答闭合问题");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await clickTestId(view, "agent-send");
    const visibleContext = await view.webContents.executeJavaScript(`new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const el = document.querySelector('[data-testid="agent-context-text"]');
        if (el && el.textContent) resolve(el.textContent);
        else if (Date.now() - started > 15000) resolve("");
        else setTimeout(tick, 50);
      };
      tick();
    })`) as string;
    const workspaceAfter = await call("workspace.get", {});
    const sentRun = (((workspaceAfter.value as { runs?: Array<{ id: string; inputText?: string }> } | undefined)?.runs) ?? []).find((run) => run.inputText === "用材料回答闭合问题");
    if (sentRun) {
      const detail = await call("agent.getRun", { runId: sentRun.id });
      const contextText = String((detail.value as { contextText?: string } | undefined)?.contextText ?? "");
      contextChars = [...contextText].length;
      materialsFromUi = contextText.length > 0 && visibleContext === contextText;
      materialsFrozen = materialsFromUi && contextText.includes("闭合样本") && contextText.includes(revisionId) && contextText.includes("闭合样本正文") && contextText.includes("chi-close-sel");
      await call("agent.cancel", { runId: sentRun.id }, "closure-cancel");
    }
  }

  return {
    ok: openedResource && readLastChapter && marked && progressAtTail && progressStillAtTail && uiTailVisible && selectMs >= 0 && Boolean(recorded) && selectionAccurate && materialsFrozen && materialsFromUi
      && sourceCardOk && styleReachable && theme === "green" && bookmarkAdded && bookmarkHighlighted && bookmarkRemoved,
    readLastChapter,
    openedResource,
    recordedNote: Boolean(recorded),
    selectionAccurate,
    materialsFrozen,
    materialsFromUi,
    uiTailVisible,
    progressAtTail,
    progressStillAtTail,
    bookmarkAdded,
    bookmarkHighlighted,
    bookmarkRemoved,
    sourceCardOk,
    styleReachable,
    theme,
    marked,
    diagnostics: {
      noteEnabled,
      noteSurfaceOpened,
      noteSaved,
      noteTitle: recorded?.title ?? null,
      selectionMs: selectMs,
      selectedQuote,
      excerpt,
      quoteRange,
      readRangesBefore,
      contextChars,
    },
    timings: { importMs, tailMs, noteMs, selectionMs: selectMs },
    samples: { bytes: body.length, tailStart },
  };
}

async function runAgentSmoke(appService: MangaProductApp, grant: string, view: BrowserWindow, phase: string): Promise<Record<string, unknown> & { ok: boolean }> {
  if (phase === "agent-restart") {
    const ws = await appService.call(actor, { commandId: "workspace.get", idempotencyKey: createId("smoke-ws"), input: {} }, grant);
    const runs = (ws.status === "ok" ? (ws.value as { runs?: Array<{ id: string; status: string; inputText?: string }> }).runs : undefined) ?? [];
    const restored = runs.find((run) => run.inputText === "slow-smoke-prompt") ?? runs[0];
    const detail = restored
      ? await appService.call(actor, { commandId: "agent.getRun", idempotencyKey: createId("smoke-run"), input: { runId: restored.id } }, grant)
      : { status: "error" as const, value: undefined };
    const detailValue = detail.status === "ok" ? detail.value as { inputText?: string; status?: string } | undefined : undefined;
    const copilot = await clickTestId(view, "nav-copilot");
    const body = await view.webContents.executeJavaScript(`document.body ? document.body.innerText : ""`) as string;
    const inputText = String(detailValue?.inputText ?? restored?.inputText ?? "");
    const ok = Boolean(restored) && inputText.includes("slow-smoke-prompt") && copilot && (body.includes("副驾驶") || body.includes("slow-smoke-prompt"));
    return { ok, restoredStatus: restored?.status ?? detailValue?.status, copilotVisible: copilot, inputText };
  }
  const slow = createServer((request) => { request.resume(); });
  await new Promise<void>((resolve) => { slow.listen(0, "127.0.0.1", () => resolve()); });
  const address = slow.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const secret = appService.stashSecret("smoke-credential");
    await appService.call(actor, {
      commandId: "connections.upsert",
      idempotencyKey: "smoke-conn",
      input: { label: "slow", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "demo", purpose: "text", credentialHandle: secret },
    }, grant);
    const session = await appService.call(actor, { commandId: "agent.createSession", idempotencyKey: "smoke-ses", input: { title: "smoke" } }, grant);
    const sessionId = (session.value as { id?: string } | undefined)?.id;
    const sent = await appService.call(actor, {
      commandId: "agent.send",
      idempotencyKey: "smoke-send",
      input: { sessionId, text: "slow-smoke-prompt" },
    }, grant);
    const runId = (sent.value as { runId?: string } | undefined)?.runId;
    const copilot = await clickTestId(view, "nav-copilot");
    await clickTestId(view, "agent-stop");
    if (sent.status === "ok" && runId) {
      await appService.call(actor, { commandId: "agent.cancel", idempotencyKey: "smoke-cancel", input: { runId } }, grant);
    }
    const latest = sent.status === "ok" && runId
      ? await appService.call(actor, { commandId: "agent.getRun", idempotencyKey: "smoke-get", input: { runId } }, grant)
      : { status: "error" as const, value: undefined };
    const previous = appService.runtime.snapshot().lastValidProfile;
    if (previous) {
      await appService.runtime.applyProfile({
        ...previous,
        enabledFeatures: previous.enabledFeatures.filter((feature) => feature !== "agent"),
        disabledFeatures: [...new Set([...previous.disabledFeatures, "agent"])],
      });
    }
    const revoked = !appService.uiFacets.has("agent") && !appService.runtime.gateway.has("agent.send");
    if (previous) await appService.runtime.applyProfile(previous);
    const latestValue = latest.status === "ok" ? latest.value as { status?: string } | undefined : undefined;
    const status = String(latestValue?.status ?? "");
    const stopped = ["cancelled", "interrupted", "failed"].includes(status);
    return {
      ok: sent.status === "ok" && Boolean(runId) && copilot && stopped && revoked,
      runStatus: status,
      revoked,
      copilotVisible: copilot,
      runId,
    };
  } finally {
    slow.closeAllConnections();
    await new Promise<void>((resolve) => { slow.close(() => resolve()); });
  }
}

/** Click, then wait until the renderer has committed the requested content. The clock does not stop at dispatch. */
async function measureWindowBench(view: BrowserWindow): Promise<Record<string, unknown>> {
  await view.webContents.executeJavaScript(`window.manga.command({ commandId: "settings.skipAi", idempotencyKey: crypto.randomUUID(), input: {} })`);
  const clickStarted = Date.now();
  const clicked = await clickTestId(view, "nav-library");
  const libraryVisible = await waitForTestId(view, "page-library");
  const interactionMs = Date.now() - clickStarted;
  const marker = "窗口末尾标记";
  const text = `${"窗口正文。".repeat(30)}${marker}`;
  const importStarted = Date.now();
  const imported = await view.webContents.executeJavaScript(`window.manga.command({ commandId: "library.importDocument", idempotencyKey: crypto.randomUUID(), input: { title: "窗口书", format: "txt", bytes: [...new TextEncoder().encode(${JSON.stringify(text)})] } })`) as { status?: string; value?: { resourceId?: string } };
  const resourceId = String(imported.value?.resourceId ?? "");
  await view.webContents.reload();
  await waitForTestId(view, "nav-reading");
  await clickTestId(view, "nav-reading");
  const opened = resourceId ? await clickTestId(view, `open-${resourceId}`) : false;
  const readable = await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const body = document.querySelector('[data-testid="reading-body"]');
      if (body && (body.textContent || "").includes(${JSON.stringify(marker)})) resolve(true);
      else if (Date.now() - started > 8000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as boolean;
  const importToReadableMs = Date.now() - importStarted;
  await clickTestId(view, "nav-library");
  await waitForTestId(view, "page-library");
  const contentStarted = Date.now();
  await clickTestId(view, "nav-reading");
  await clickTestId(view, `open-${resourceId}`);
  const contentVisible = await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const body = document.querySelector('[data-testid="reading-body"]');
      if (body && (body.textContent || "").includes(${JSON.stringify(marker)})) resolve(true);
      else if (Date.now() - started > 8000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as boolean;
  const contentAvailableMs = Date.now() - contentStarted;
  const created = await view.webContents.executeJavaScript(`window.manga.command({ commandId: "notes.create", idempotencyKey: crypto.randomUUID(), input: { title: "窗口笔记", text: "初稿" } })`) as { status?: string; value?: { objectId?: string } };
  const objectId = String(created.value?.objectId ?? "");
  await view.webContents.reload();
  await waitForTestId(view, "nav-notes");
  await clickTestId(view, "nav-notes");
  const noteOpened = objectId ? await clickTestId(view, `note-${objectId}`) : false;
  await waitForTestId(view, "note-editor");
  const saveStarted = Date.now();
  const edited = await view.webContents.executeJavaScript(`(() => {
    const prose = document.querySelector('[data-testid="note-editor"] .ProseMirror');
    if (!prose) return false;
    prose.focus();
    return document.execCommand("insertText", false, "窗口回执");
  })()`) as boolean;
  const saved = await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const editor = document.querySelector('[data-testid="note-editor"]');
      if (editor && editor.getAttribute("data-save-state") === "saved") resolve(true);
      else if (Date.now() - started > 8000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as boolean;
  const saveReceiptMs = Date.now() - saveStarted;
  const receipt = objectId ? await view.webContents.executeJavaScript(`window.manga.command({ commandId: "notes.get", idempotencyKey: crypto.randomUUID(), input: { objectId: ${JSON.stringify(objectId)} } })`) as { status?: string; value?: { revision?: number; document?: { blocks?: Array<{ text?: string }> } } } : { status: "error" };
  const receiptText = (receipt.value?.document?.blocks ?? []).map((block) => block.text ?? "").join("\n");
  const receiptOk = receipt.status === "ok" && Number(receipt.value?.revision ?? 0) >= 2 && receiptText.includes("窗口回执");
  const ok = clicked && libraryVisible && imported.status === "ok" && opened && readable && contentVisible && created.status === "ok" && noteOpened && edited && saved && receiptOk;
  return {
    ok,
    interactionMs,
    contentAvailableMs,
    saveReceiptMs,
    importToReadableMs,
    waitedForContent: true,
    process: "electron",
    libraryVisible,
    readable,
    contentVisible,
    saved,
    receiptOk,
  };
}

type ScaleSpec = {
  txt: { resourceId: string; marker: string };
  epub: { resourceId: string; marker: string };
  noteId: string;
  parseFile: string;
  scale: { metadataCount: number; searchBlocks: number };
};

/**
 * Real-window timings on a Profile seeded to the requirement 6.2 baseline (10k metadata, 50k blocks, a
 * 10 MiB TXT and a 30 MiB EPUB). Each duration is taken inside the renderer from the dispatched click
 * to the DOM commit where the awaited content exists (a hidden smoke window produces no regular animation frames, so paint is
 * not part of the figure), and IPC polling from the main process does not inflate or hide it.
 */
async function measureScaleWindowBench(appService: MangaProductApp, grant: string, view: BrowserWindow, spec: ScaleSpec): Promise<Record<string, unknown>> {
  const launchedAt = Number(process.env.M1A_LAUNCHED_AT ?? Date.now());
  // The clock runs inside the page. `until` is a JS predicate over document; the promise resolves on the first 4 ms poll where it holds.
  const timed = (clickTestId: string | null, until: string, timeoutMs = 15_000) => view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = performance.now();
    const target = ${JSON.stringify(clickTestId)};
    if (target) {
      const el = document.querySelector('[data-testid="' + target + '"]');
      if (!el) { resolve({ ok: false, ms: -1, reason: "missing " + target }); return; }
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    }
    const check = () => { try { return Boolean(${until}); } catch { return false; } };
    const frame = () => {
      if (check()) resolve({ ok: true, ms: performance.now() - started });
      else if (performance.now() - started > ${timeoutMs}) resolve({ ok: false, ms: performance.now() - started, reason: "timeout" });
      else setTimeout(frame, 4);
    };
    frame();
  })`) as Promise<{ ok: boolean; ms: number; reason?: string }>;
  const present = (testId: string) => `document.querySelector('[data-testid="${testId}"]')`;
  const bodyHas = (marker: string) => `(document.querySelector('[data-testid="reading-body"]')?.textContent || "").includes(${JSON.stringify(marker)})`;
  const failures: string[] = [];
  const keep = (label: string, sample: { ok: boolean; ms: number; reason?: string }, into: number[]) => {
    if (sample.ok) into.push(sample.ms);
    else failures.push(`${label}: ${sample.reason ?? "failed"}`);
  };

  await appService.call(actor, { commandId: "settings.skipAi", idempotencyKey: createId("bench"), input: {} }, grant);
  // Cold start: process launch until the library page is shown and the resource list can be opened.
  const library = await timed("nav-library", present("page-library"));
  const listed = await timed("nav-reading", present(`open-${spec.txt.resourceId}`));
  const coldStartToLibraryMs = library.ok && listed.ok ? Date.now() - launchedAt : -1;
  if (coldStartToLibraryMs < 0) failures.push(`cold start: ${library.reason ?? listed.reason ?? "library not operable"}`);

  // Local UI feedback: tab switches that must repaint the target page.
  const uiFeedbackMs: number[] = [];
  const tabs: Array<[string, string]> = [["nav-library", present("page-library")], ["nav-notes", present("notes-list")], ["nav-reading", present(`open-${spec.txt.resourceId}`)]];
  for (let round = 0; round < 4; round += 1) {
    for (const [tab, until] of tabs) keep(`ui ${tab}`, await timed(tab, until), uiFeedbackMs);
  }

  // Indexed large books: reopening restores the stored tail position, which must be the visible text.
  const largeTxtTailMs: number[] = [];
  const largeEpubTailMs: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    for (const [book, into] of [[spec.txt, largeTxtTailMs], [spec.epub, largeEpubTailMs]] as const) {
      await timed("nav-library", present("page-library"));
      await timed("nav-reading", present(`open-${book.resourceId}`));
      keep(`tail ${book.resourceId}`, await timed(`open-${book.resourceId}`, bodyHas(book.marker), 20_000), into);
    }
  }

  // Save receipt: typing into the note editor until it reports a committed save again.
  const saveState = `document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state")`;
  const saveOnce = async (text: string) => {
    await view.webContents.executeJavaScript("window.__benchSeenUnsaved = false");
    const typed = await view.webContents.executeJavaScript(`(() => {
      const prose = document.querySelector('[data-testid="note-editor"] .ProseMirror');
      if (!prose) return false;
      prose.focus();
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`) as boolean;
    if (!typed) return { ok: false, ms: -1, reason: "editor missing" };
    // The editor must first leave "saved"; a state that never changed is not a receipt.
    return timed(null, `(window.__benchSeenUnsaved = window.__benchSeenUnsaved || ${saveState} !== "saved") && ${saveState} === "saved"`, 10_000);
  };
  const openNote = async () => {
    await timed("nav-notes", present(`note-${spec.noteId}`));
    await timed(`note-${spec.noteId}`, present("note-editor"));
  };
  await openNote();
  const saveReceiptMs: number[] = [];
  for (let round = 0; round < 5; round += 1) keep(`save ${round}`, await saveOnce(`规模保存${round}`), saveReceiptMs);

  // Background parse: a new 10 MiB book is imported while the window keeps being used. The renderer drives its
  // own sampling loop, because a busy main process would also delay any sampling started from here. A sample
  // counts when it starts while the import is running, so a click or save that stalls until parsing ends is kept.
  await view.webContents.executeJavaScript(`(() => {
    const frameUntil = (check, timeoutMs) => new Promise((resolve) => {
      const started = performance.now();
      const frame = () => {
        let ok = false;
        try { ok = Boolean(check()); } catch { ok = false; }
        if (ok) resolve(true);
        else if (performance.now() - started > timeoutMs) resolve(false);
        else setTimeout(frame, 4);
      };
      frame();
    });
    const click = (testId) => {
      const el = document.querySelector('[data-testid="' + testId + '"]');
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
      return true;
    };
    const present = (testId) => () => document.querySelector('[data-testid="' + testId + '"]');
    const tabs = [["nav-library", present("page-library")], ["nav-notes", present("notes-list")], ["nav-reading", present(${JSON.stringify(`open-${spec.txt.resourceId}`)})]];
    const state = window.__benchParse = { stop: false, ui: [], saves: [] };
    const epoch = () => performance.timeOrigin + performance.now();
    (async () => {
      let round = 0;
      while (!state.stop && round < 200) {
        for (const [tab, until] of tabs) {
          const at = epoch();
          const started = performance.now();
          const ok = click(tab) && await frameUntil(until, 15000);
          state.ui.push({ tab, ok, at, ms: performance.now() - started });
        }
        click("nav-notes");
        await frameUntil(present(${JSON.stringify(`note-${spec.noteId}`)}), 15000);
        click(${JSON.stringify(`note-${spec.noteId}`)});
        await frameUntil(present("note-editor"), 15000);
        const prose = document.querySelector('[data-testid="note-editor"] .ProseMirror');
        const stateOf = () => document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state");
        if (prose) {
          prose.focus();
          const at = epoch();
          const started = performance.now();
          document.execCommand("insertText", false, "解析期间保存" + round);
          let left = false;
          const ok = await frameUntil(() => (left = left || stateOf() !== "saved") && stateOf() === "saved", 30000);
          state.saves.push({ ok, at, ms: performance.now() - started });
        }
        round += 1;
      }
      state.done = true;
    })();
    return true;
  })()`);
  // Main-process event-loop gaps during the import: every IPC reply, including a save receipt, waits behind them.
  const loopGaps: number[] = [];
  let lastTick = Date.now();
  const probe = setInterval(() => { const now = Date.now(); loopGaps.push(now - lastTick); lastTick = now; }, 5);
  const parseStarted = Date.now();
  const parsed = await appService.call(actor, { commandId: "library.importDocument", idempotencyKey: createId("bench-parse"), input: { title: "后台解析", pathHandle: appService.registerPath("file", spec.parseFile), format: "txt" } }, grant);
  const parseEnded = Date.now();
  clearInterval(probe);
  const mainLoopMaxGapMs = Math.max(0, ...loopGaps);
  const backgroundParseMs = parseEnded - parseStarted;
  await view.webContents.executeJavaScript("window.__benchParse.stop = true");
  await waitForTestId(view, "note-editor");
  const sampled = await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const tick = () => (window.__benchParse.done ? resolve({ ui: window.__benchParse.ui, saves: window.__benchParse.saves }) : setTimeout(tick, 50));
    tick();
  })`) as { ui: Array<{ tab: string; ok: boolean; at: number; ms: number }>; saves: Array<{ ok: boolean; at: number; ms: number }> };
  const during = <T extends { at: number }>(rows: T[]) => rows.filter((row) => row.at >= parseStarted && row.at <= parseEnded);
  const duringParseUiMs: number[] = [];
  const duringParseSaveMs: number[] = [];
  for (const row of during(sampled.ui)) keep(`during-parse ${row.tab}`, { ok: row.ok, ms: row.ms, reason: "timeout" }, duringParseUiMs);
  for (const row of during(sampled.saves)) keep("during-parse save", { ok: row.ok, ms: row.ms, reason: "timeout" }, duringParseSaveMs);
  const samplesWhileParsing = during(sampled.ui).length + during(sampled.saves).length;
  if (parsed.status !== "ok") failures.push("background parse failed");
  if (duringParseUiMs.length < 3 || duringParseSaveMs.length < 1) failures.push("background parse finished before enough samples were taken");
  return {
    ok: failures.length === 0,
    failures,
    process: "electron",
    scale: spec.scale,
    coldStartToLibraryMs,
    uiFeedbackMs,
    largeTxtTailMs,
    largeEpubTailMs,
    saveReceiptMs,
    duringParseUiMs,
    duringParseSaveMs,
    samplesWhileParsing,
    backgroundParseMs,
    mainLoopMaxGapMs,
    mainLoopGapsOver50Ms: loopGaps.filter((gap) => gap > 50),
    waits: {
      coldStart: "process launch → page-library shown and the resource list offers the 10 MiB TXT",
      uiFeedback: "dispatched tab click → DOM commit of the target page (4 ms polling, hidden window, no paint)",
      largeTail: "open click → DOM commit whose reading body contains the tail marker restored from stored progress",
      saveReceipt: "insertText in the note editor → data-save-state leaves and returns to saved",
      duringParse: "same UI and save samples, kept only while a 10 MiB import is still parsing",
    },
  };
}

/** Open txt, epub, pdf and mobi in the real window, then a bad file and a mode switch. */
async function runFormatsSmoke(appService: MangaProductApp, grant: string, view: BrowserWindow): Promise<Record<string, unknown> & { ok: boolean }> {
  const call = (commandId: string, input: Record<string, unknown>, key = createId("smoke")) =>
    appService.call(actor, { commandId, idempotencyKey: key, input }, grant);
  await call("settings.skipAi", {});
  const dir = path.join(layout.partitions.logs, "formats");
  fs.mkdirSync(dir, { recursive: true });
  const scanPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const books = [
    { name: "sample.txt", format: "txt", marker: "FORMAT-TXT-MARK", bytes: Buffer.from("FORMAT-TXT-MARK. four format window.") },
    { name: "sample.epub", format: "epub", marker: "FORMAT-EPUB-MARK", bytes: Buffer.from(buildEpubFixture({ title: "format book", chapters: [{ id: "c1", title: "chapter", html: "<p>FORMAT-EPUB-MARK</p>" }] })) },
    { name: "sample.pdf", format: "pdf", marker: "FORMAT-PDF-MARK", bytes: Buffer.from(buildPdfFixture([{ text: "FORMAT-PDF-MARK" }, { scan: true, imageBytes: scanPng }])) },
    { name: "sample.mobi", format: "mobi", marker: "FORMAT-MOBI-MARK", bytes: Buffer.from(buildMobiFixture("FORMAT-MOBI-MARK")) },
  ];
  const opened: Record<string, boolean> = {};
  let pdfDebug: Record<string, boolean> = {};
  let pdfLayer = "";
  let pdfSpans = 0;
  let pdfError = "";
  let pdfReview = false;
  const ids: Record<string, string> = {};
  for (const book of books) {
    const file = path.join(dir, book.name);
    fs.writeFileSync(file, book.bytes);
    const handle = appService.registerPath("file", file);
    const imported = await call("library.importDocument", { title: book.name, pathHandle: handle, format: book.format });
    if (imported.status !== "ok") return { ok: false, reason: `${book.format} import failed`, detail: imported.error };
    ids[book.format] = String((imported.value as { resourceId?: string }).resourceId ?? "");
  }
  await view.webContents.reload();
  await waitForTestId(view, "nav-reading");
  for (const book of books) {
    await clickTestId(view, "nav-reading");
    const resourceId = ids[book.format] ?? "";
    const clicked = await clickTestId(view, `open-${resourceId}`);
    const visible = await view.webContents.executeJavaScript(`new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const text = document.querySelector('[data-testid="reading-body"]')?.textContent ?? "";
        const image = [...document.querySelectorAll('[data-testid="reading-page"] img')].some((item) => item.complete && item.naturalWidth > 0);
        const title = document.querySelector('[data-testid="reading-title"]');
        if (title && (text.includes(${JSON.stringify(book.marker)}) || (${JSON.stringify(book.format)} === "pdf" && image))) resolve(true);
        else if (Date.now() - started > 8000) resolve(false);
        else setTimeout(tick, 50);
      };
      tick();
    })`) as boolean;
    if (book.format === "pdf" && visible) {
      const painted = await view.webContents.executeJavaScript(`new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const canvas = document.querySelector('[data-testid="reading-pdf-canvas"]');
          if (canvas && canvas.width > 0 && canvas.height > 0) resolve(true);
          else if (Date.now() - started > 8000) resolve(false);
          else setTimeout(tick, 50);
        };
        tick();
      })`) as boolean;
      const selected = await view.webContents.executeJavaScript(`new Promise((resolve) => {
        const started = Date.now();
        const fail = () => resolve({
          ok: false,
          layer: document.querySelector('[data-testid="reading-pdf-text"]')?.innerText ?? "",
          spans: document.querySelectorAll('[data-testid="reading-pdf-text"] span').length,
          error: document.querySelector('[data-testid="reading-pdf-error"]')?.textContent ?? "",
          review: Boolean(document.querySelector('[data-testid="reading-pdf-needs-review"]')),
        });
        const tick = () => {
          const node = [...document.querySelectorAll('[data-testid="reading-pdf-text"] span')].find((item) => (item.textContent || "").includes("FORMAT-PDF-MARK"));
          if (!node) {
            if (Date.now() - started > 8000) fail();
            else setTimeout(tick, 50);
            return;
          }
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
          const buttonStarted = Date.now();
          const waitButton = () => {
            const button = document.querySelector('[data-testid="reading-note"]');
            if (button && !button.disabled) resolve({ ok: true, layer: node.textContent ?? "" });
            else if (Date.now() - buttonStarted > 4000) fail();
            else setTimeout(waitButton, 50);
          };
          waitButton();
        };
        tick();
      })`) as { ok: boolean; layer?: string; spans?: number; error?: string; review?: boolean };
      const noted = selected.ok ? await clickTestId(view, "reading-note") : false;
      const excerpt = noted ? await view.webContents.executeJavaScript(`new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const panel = document.querySelector('[data-testid="note-panel"]');
          const text = panel?.textContent ?? "";
          if (panel && text.includes("FORMAT-PDF-MARK")) resolve(true);
          else if (Date.now() - started > 8000) resolve(false);
          else setTimeout(tick, 50);
        };
        tick();
      })`) as boolean : false;
      await clickTestId(view, "nav-reading");
      await clickTestId(view, `open-${resourceId}`);
      await clickTestId(view, "reading-next");
      const image = await view.webContents.executeJavaScript(`new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const canvas = document.querySelector('[data-testid="reading-pdf-canvas"]');
          const position = document.querySelector('[data-testid="reading-part-position"]')?.textContent ?? "";
          const decoded = [...document.querySelectorAll('[data-testid="reading-page"] img')].some((item) => item.complete && item.naturalWidth > 0);
          if (position.includes("第 2 /") && ((canvas && canvas.width > 0) || decoded)) resolve(true);
          else if (Date.now() - started > 8000) resolve(false);
          else setTimeout(tick, 50);
        };
        tick();
      })`) as boolean;
      opened[book.format] = clicked && painted && excerpt && image;
      pdfDebug = { painted, selected: selected.ok, noted, excerpt, image };
      pdfLayer = selected.layer ?? "";
      pdfSpans = selected.spans ?? 0;
      pdfError = selected.error ?? "";
      pdfReview = Boolean(selected.review);
    } else opened[book.format] = clicked && visible;
  }
  const drafted = await view.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-testid="agent-composer"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(el, "formats enthusiast draft");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`) as boolean;
  const enthusiast = await call("workspace.sessions", { mode: "enthusiast" }) as { status?: string; value?: Array<{ sessionId: string }> };
  const enthusiastId = enthusiast.value?.[0]?.sessionId ?? "";
  await clickTestId(view, "mode-menu");
  await waitForTestId(view, "mode-creator");
  await clickTestId(view, "mode-creator");
  const switched = await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const menu = document.querySelector('[data-testid="mode-menu"]')?.textContent ?? "";
      const draft = document.querySelector('[data-testid="agent-composer"]')?.value ?? "";
      const listed = document.querySelector('[data-testid="session-open-${enthusiastId}"]');
      if (menu.includes("造物主") && draft !== "formats enthusiast draft" && !listed) resolve(true);
      else if (Date.now() - started > 8000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as boolean;
  await clickTestId(view, "mode-menu");
  await waitForTestId(view, "mode-enthusiast");
  await clickTestId(view, "mode-enthusiast");
  const returned = await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const menu = document.querySelector('[data-testid="mode-menu"]')?.textContent ?? "";
      const draft = document.querySelector('[data-testid="agent-composer"]')?.value ?? "";
      if (menu.includes("观测者") && draft === "formats enthusiast draft") resolve(true);
      else if (Date.now() - started > 8000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as boolean;
  const bad = path.join(dir, "broken.pdf");
  fs.writeFileSync(bad, Buffer.from("%PDF-1.4\nnot-a-page"));
  process.env.M1B_SMOKE_BOOK = bad;
  await clickTestId(view, "import-book");
  const failureVisible = await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const alert = document.querySelector('[role="alert"]');
      if (alert && (alert.textContent || "").trim()) resolve(true);
      else if (Date.now() - started > 8000) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as boolean;
  delete process.env.M1B_SMOKE_BOOK;
  const pages = books.every((book) => opened[book.format]);
  return { ok: drafted && pages && switched && returned && failureVisible, pages, modes: switched && returned, failureVisible, opened, pdfDebug, pdfLayer, pdfSpans, pdfError, pdfReview };
}
