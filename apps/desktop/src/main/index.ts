import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { MangaProductApp, ElectronSafeStorageVault, resolveLaunchLayout, persistPointer } from "@manga/app-core";
import { createId, LOCATION_PARTITIONS } from "@manga/contracts";
import { safeStorage } from "electron";

const smoke = process.argv.includes("--m1a-smoke");
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
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 540,
    show: !smoke,
    backgroundColor: "#FBFAFC",
    webPreferences: {
      preload: fs.existsSync(path.join(__dirname, "preload.cjs"))
        ? path.join(__dirname, "preload.cjs")
        : path.join(__dirname, "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
  ipcMain.handle("manga:choose-audio", async (event) => {
    assertCaller(event);
    if (!window || !appService) return null;
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "ogg", "webm"] }] });
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
      } else if (phaseName === "bench") {
        const launchedAt = Number(process.env.M1A_LAUNCHED_AT ?? Date.now());
        reportExtras.readyMs = Date.now() - launchedAt;
        const clickStarted = Date.now();
        await window.webContents.executeJavaScript(`(() => {
          const el = document.querySelector('[data-testid="nav-library"]');
          if (!el) return false;
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
          return true;
        })()`);
        reportExtras.interactionMs = Date.now() - clickStarted;
        reportExtras.process = "electron";
        markerRestored = true;
        fs.mkdirSync(layout.partitions.logs, { recursive: true });
        fs.writeFileSync(path.join(layout.partitions.logs, "bench-window.json"), `${JSON.stringify({
          readyMs: reportExtras.readyMs,
          interactionMs: reportExtras.interactionMs,
          process: "electron",
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
