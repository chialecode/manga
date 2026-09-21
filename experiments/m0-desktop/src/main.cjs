"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const profileDir = process.env.MANGA_M0_DIR ?? path.join(app.getPath("userData"), "m0-profile");
app.setPath("userData", path.join(profileDir, "electron"));
const renderer = path.join(__dirname, "renderer", "index.html");
const rendererUrl = pathToFileURL(renderer).href;
const smoke = process.argv.includes("--m0-smoke");
if (smoke && process.env.M0_FORCE_PERMISSION_DENY !== "1") {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}
let child, window;
let seq = 0;
let recordingGrantUntil = 0;
const pending = new Map();
function startService() {
  const node = app.isPackaged ? path.join(process.resourcesPath, "node.exe") : process.env.MANGA_NODE_BIN || "node";
  const proc = spawn(node, [path.join(__dirname, "service.cjs"), "--profile", profileDir], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id);
    if (item) { clearTimeout(item.timer); pending.delete(message.id); item.resolve(message.value ?? message); }
  });
  proc.stderr.on("data", data => process.stderr.write(data));
  const unavailable = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("本地数据服务已停止；未确认保存的内容请保留并重试")); }
    pending.clear();
  };
  proc.on("error", unavailable);
  proc.on("exit", unavailable);
  return proc;
}
function send(payload) {
  return new Promise((resolve, reject) => {
    if (!child || child.exitCode !== null || !child.stdin.writable) return reject(new Error("本地数据服务不可用"));
    const id = `ui-${seq++}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("操作超时，保存状态待核查")); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ type: "command", id, payload }) + "\n", error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
  });
}
function assertCaller(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererUrl) throw new Error("拒绝非应用主界面的调用");
}
const uiCommands = new Set([
  "workspace.get", "notes.create", "notes.update", "notes.split", "notes.merge", "notes.embed",
  "capture.save", "capture.stat", "capture.preparePlayback", "capture.markPlayback",
  "library.importText", "library.importEpub", "library.getResource", "library.contextSnapshot",
  "progress.set", "reader.resolveAnchor", "reader.ui.present",
  "metadata.query", "metadata.override", "metadata.confirm",
]);
app.whenReady().then(async () => {
  child = startService();
  window = new BrowserWindow({ width: 1120, height: 800, minWidth: 720, minHeight: 540, show: !smoke, backgroundColor: "#FBFAFC", webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !smoke } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === window.webContents && permission === "media" && process.env.M0_FORCE_PERMISSION_DENY !== "1" && Date.now() < recordingGrantUntil);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (process.env.M0_FORCE_PERMISSION_DENY === "1") return callback(false);
    callback(contents === window.webContents && permission === "media" && Date.now() < recordingGrantUntil && !details.mediaTypes?.includes("video"));
  });
  ipcMain.handle("m0:command", async (event, payload) => {
    assertCaller(event);
    if (!payload || !uiCommands.has(payload.commandId)) throw new Error("此窗口不提供该操作");
    if (JSON.stringify(payload).length > 64 * 1024 * 1024) throw new Error("请求过大");
    return send(payload);
  });
  ipcMain.handle("m0:arm-recording", event => { assertCaller(event); recordingGrantUntil = Date.now() + 15000; return true; });
  ipcMain.handle("m0:status", event => { assertCaller(event); return { pid: process.pid, packaged: app.isPackaged, profileDir }; });
  ipcMain.handle("m0:open-file", async event => {
    assertCaller(event);
    const result = await dialog.showOpenDialog(window, { title: "选择测试小说", filters: [{ name: "TXT / EPUB", extensions: ["txt", "epub"] }], properties: ["openFile"] });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error("验证窗口单文件上限为 16 MiB");
    return send({ commandId: path.extname(file).toLowerCase() === ".epub" ? "library.importEpub" : "library.importText", idempotencyKey: require("node:crypto").randomUUID(), input: { title: path.basename(file), bytes: [...fs.readFileSync(file)] } });
  });
  ipcMain.handle("m0:read-capture", async (event, payload) => {
    assertCaller(event);
    const attachmentId = typeof payload === "string" ? payload : payload?.attachmentId;
    const purpose = typeof payload === "string" ? "play" : payload?.purpose || "play";
    if (typeof attachmentId !== "string" || !/^capture_[a-zA-Z0-9-]+\.webm$/.test(attachmentId)) throw new Error("invalid attachment handle");
    const stat = await send({ commandId: "capture.stat", idempotencyKey: require("node:crypto").randomUUID(), input: { attachmentId } });
    if (stat?.status !== "ok") throw new Error(stat?.error?.message ?? "录音不属于当前资料库");
    const original = path.join(profileDir, "attachments", attachmentId);
    const file = original;
    if (!fs.existsSync(file)) throw new Error("录音文件不存在");
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error("attachment too large");
    return {
      bytes: [...fs.readFileSync(file)],
      mimeType: "audio/webm",
      attachmentId,
      purpose,
      durationMs: stat.value?.metadata?.playback?.durationMs ?? stat.value?.metadata?.durationMs,
      lastPlaybackMs: stat.value?.metadata?.lastPlaybackMs,
      originalBytes: fs.statSync(original).size,
    };
  });
  ipcMain.handle("m0:export-capture", async (event, attachmentId) => {
    assertCaller(event);
    if (typeof attachmentId !== "string" || !/^capture_[a-zA-Z0-9-]+\.webm$/.test(attachmentId)) throw new Error("invalid attachment handle");
    const stat = await send({ commandId: "capture.stat", idempotencyKey: require("node:crypto").randomUUID(), input: { attachmentId } });
    if (stat?.status !== "ok") return { status: "error", error: { message: stat?.error?.message ?? "录音不属于当前资料库" } };
    const original = path.join(profileDir, "attachments", attachmentId);
    if (!fs.existsSync(original)) return { status: "error", error: { message: "原始录音不存在" } };
    if (process.env.M0_EXPORT_CANCEL === "1") return { status: "cancelled" };
    let dest = process.env.M0_EXPORT_PATH;
    if (!dest) {
      const picked = await dialog.showSaveDialog(window, {
        title: "导出录音",
        defaultPath: attachmentId,
        filters: [{ name: "WebM 音频", extensions: ["webm"] }],
      });
      if (picked.canceled || !picked.filePath) return { status: "cancelled" };
      dest = picked.filePath;
    }
    try {
      if (fs.existsSync(dest)) {
        const st = fs.statSync(dest);
        if (st.isDirectory()) return { status: "error", error: { code: "EISDIR", message: "目标是目录，无法写入" } };
        return { status: "error", error: { code: "EEXIST", message: "目标文件已存在" } };
      }
      fs.copyFileSync(original, dest, fs.constants.COPYFILE_EXCL);
      const copied = fs.readFileSync(dest);
      const source = fs.readFileSync(original);
      if (!copied.equals(source)) return { status: "error", error: { message: "导出字节与原始录音不一致" } };
      return { status: "ok", bytes: copied.length, name: path.basename(dest) };
    } catch (error) {
      return { status: "error", error: { code: error.code, message: error.message || String(error) } };
    }
  });
  ipcMain.handle("m0:export-package", async event => {
    assertCaller(event);
    const picked = process.env.M0_PACKAGE_EXPORT
      ? { canceled: false, filePaths: [process.env.M0_PACKAGE_EXPORT] }
      : await dialog.showOpenDialog(window, { title: "选择空目录导出资料包", properties: ["openDirectory", "createDirectory"] });
    if (picked.canceled || !picked.filePaths?.[0]) return null;
    return send({ commandId: "library.exportPackage", idempotencyKey: require("node:crypto").randomUUID(), input: { targetDir: picked.filePaths[0] } });
  });
  ipcMain.handle("m0:import-package", async event => {
    assertCaller(event);
    const picked = process.env.M0_PACKAGE_IMPORT
      ? { canceled: false, filePaths: [process.env.M0_PACKAGE_IMPORT] }
      : await dialog.showOpenDialog(window, { title: "选择资料包目录", properties: ["openDirectory"] });
    if (picked.canceled || !picked.filePaths?.[0]) return null;
    return send({ commandId: "library.importPackage", idempotencyKey: require("node:crypto").randomUUID(), input: { sourceDir: picked.filePaths[0] } });
  });
  ipcMain.handle("m0:read-media-sample", (event, kind) => {
    assertCaller(event);
    const allowed = {
      video: process.env.M0_MEDIA_VIDEO,
      hevc: process.env.M0_MEDIA_HEVC,
      image: process.env.M0_MEDIA_IMAGE,
      comic: process.env.M0_MEDIA_COMIC,
    };
    const file = allowed[kind];
    if (!file || !fs.existsSync(file)) return null;
    if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error("sample too large");
    const mime = kind === "image" ? "image/png" : kind === "hevc" ? "video/mp4" : "video/mp4";
    return { name: path.basename(file), bytes: [...fs.readFileSync(file)], mime, kind };
  });
  await window.loadFile(renderer);
  if (smoke) {
    try { await require("./smoke.cjs").run({ window, profileDir, packaged: app.isPackaged }); app.exit(0); }
    catch (error) { console.error(error); app.exit(1); }
  }
});
app.on("before-quit", () => child?.kill());
app.on("will-quit", () => child?.kill());
app.on("window-all-closed", () => app.quit());
process.on("exit", () => child?.kill());
