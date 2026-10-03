import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { repoRoot, desktopOutput, desktopPackageDir } from "./desktop-paths.ts";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/a-b6-review");
fs.mkdirSync(evidence, { recursive: true });
const runs = path.join(desktopOutput, "review-runs");
fs.mkdirSync(runs, { recursive: true });
const root = fs.mkdtempSync(path.join(runs, "a-b6-ui-"));
const env = { ...process.env, MANGA_CHANNEL: "test", MANGA_PROFILE_ROOT: path.join(root, "profile"), MANGA_DOCUMENTS_DIR: path.join(root, "documents"), MANGA_POINTER_FILE: path.join(root, "pointer.json") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(desktopPackageDir, "MANGA-win32-x64/MANGA.exe"), env });
const observations = [];
const screenshots = [];
let page;
const call = (commandId, input) => page.evaluate(async ({ commandId, input }) => {
  const result = await window.manga.command({ commandId, input, idempotencyKey: crypto.randomUUID() });
  if (result.status !== "ok") throw new Error(result.error?.code ?? "command failed");
  return result.value;
}, { commandId, input });
const capture = async (name) => {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(path.join(evidence, name), Buffer.from(png, "base64"));
  screenshots.push(name);
};
async function check(name, run) {
  const detail = {};
  try { await run(detail); observations.push({ name, status: "passed", detail }); }
  catch (error) { observations.push({ name, status: "failed", actual: error.message, detail }); }
}
async function size(width, height) {
  await app.evaluate(({ BrowserWindow }, [width, height]) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(width, height); win.webContents.setZoomFactor(1); }, [width, height]);
  await page.waitForFunction((width) => Math.abs(innerWidth - width) <= 2, width);
}
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.getByTestId("nav-animation").waitFor();
  await call("settings.skipAi", {});
  await page.reload();
  await page.getByTestId("nav-animation").waitFor();
  await size(1672, 941);
  await page.getByTestId("nav-animation").click();
  const baseline = await call("workspace.get", {});

  await check("static scene is bundled and the page explicitly describes its simulation", async (detail) => {
    await page.waitForFunction(() => document.querySelector(".demo-scene")?.naturalWidth > 0);
    assert.match(await page.getByTestId("page-animation").innerText(), /静帧.*模拟时间轴/s);
    assert.match(await page.getByTestId("demo-agent").innerText(), /预设示例文字，不是模型分析结果/);
    detail.labels = await page.locator(".mode-switch").innerText();
    assert.match(detail.labels, /观测者/); assert.match(detail.labels, /造物主/);
    await capture("animation-wide.png");
  });
  await check("simulated time, captions and episode controls change the visible state", async (detail) => {
    await page.getByTestId("demo-play").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="demo-time"]').textContent.includes("18:42"));
    await page.getByTestId("demo-play").click();
    await page.getByTestId("demo-captions").click();
    await page.getByTestId("demo-subtitle").waitFor();
    await page.getByTestId("demo-bookmark").click();
    assert.equal(await page.getByTestId("demo-bookmark").getAttribute("aria-pressed"), "true");
    await page.getByTestId("demo-episode-4").click();
    assert.match(await page.getByTestId("demo-time").innerText(), /00:00/);
    await page.getByTestId("demo-episode-7").click();
    assert.match(await page.getByTestId("demo-time").innerText(), /18:42/);
    detail.current = await page.getByTestId("demo-time").innerText();
  });
  await check("demo note saves locally, jumps to its timestamp and survives page and mode switches", async (detail) => {
    await page.getByTestId("demo-note").click();
    await page.getByTestId("demo-note-input").fill("发现神秘信号，可能与失联科研团队有关。");
    await page.getByTestId("demo-note-save").click();
    await page.getByTestId("demo-source-card").waitFor();
    await page.getByTestId("demo-seek").focus();
    await page.keyboard.press("Home");
    assert.match(await page.getByTestId("demo-time").innerText(), /00:00/);
    await page.getByTestId("demo-source-card").click();
    assert.match(await page.getByTestId("demo-time").innerText(), /18:42/);
    await page.getByTestId("mode-quick-creator").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-mode") === "creator");
    await page.getByTestId("nav-reading").click();
    await page.getByTestId("nav-animation").click();
    assert.match(await page.getByTestId("demo-source-card").innerText(), /发现神秘信号/);
    await page.getByTestId("mode-quick-enthusiast").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-mode") === "enthusiast");
    const now = await call("workspace.get", {});
    detail.counts = { resources: now.resources.length, notes: now.notes.length, runs: now.runs.length };
    assert.deepEqual(detail.counts, { resources: baseline.resources.length, notes: baseline.notes.length, runs: baseline.runs.length }, "demo must not create real resources, notes or model runs");
    await capture("animation-note.png");
  });
  await check("wide, medium and phone windows keep navigation, actions and assistant reachable", async (detail) => {
    detail.viewports = [];
    for (const [width, height] of [[1280, 840], [960, 640], [360, 780]]) {
      await size(width, height);
      assert.equal(await page.getByTestId("demo-note").isVisible(), true);
      await page.getByTestId("demo-note").scrollIntoViewIfNeeded();
      const measured = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth, main: document.querySelector('[data-testid="shell-main"]').getBoundingClientRect().width }));
      assert.ok(measured.scroll <= width + 1, JSON.stringify(measured));
      detail.viewports.push(measured);
      if (width < 960) {
        await page.getByTestId("shell-left-toggle").click();
        await page.getByTestId("mode-menu").focus();
        await page.keyboard.press("ArrowDown");
        await page.getByTestId("mode-menu-list").waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await page.getByTestId("mode-menu").evaluate((node) => node === document.activeElement), true);
        await page.keyboard.press("Escape");
        assert.equal(await page.getByTestId("shell-left-toggle").evaluate((node) => node === document.activeElement), true);
        await page.getByTestId("shell-right-toggle").click();
        await page.getByTestId("demo-agent-input").fill("窄窗临时笔记");
        await page.getByTestId("demo-agent-save").click();
        await page.getByTestId("demo-agent-input").scrollIntoViewIfNeeded();
        await capture("animation-phone-assistant.png");
        await page.keyboard.press("Escape");
      }
      await page.getByTestId("shell-main").evaluate((node) => node.scrollTo(0, 0));
      await capture(`animation-${width}.png`);
    }
  });
  await check("reading, notes and Agent remain reachable with the new shell and names", async (detail) => {
    await size(1672, 941);
    const book = await call("library.importDocument", { title: "星海手记 · 合成阅读样本", format: "txt", bytes: [...new TextEncoder().encode("第一章 远方的信号\n\n暮色落在河面上，远处的灯光一盏接一盏地亮起。\n\n" + "中文日本語😀é。我们把沿途的故事记下来，留给下一次启程。\n\n".repeat(15))] });
    await page.reload(); await page.getByTestId("nav-reading").click();
    await page.getByTestId(`open-${book.resourceId}`).click();
    await page.getByTestId("reading-body").waitFor();
    await page.getByTestId("shell-right").getByTestId("agent-composer").fill("同一资源跨页面草稿");
    await capture("reading-wide.png");
    await page.getByTestId("nav-agent").click();
    assert.equal(await page.getByTestId("shell-right").getByTestId("agent-composer").inputValue(), "同一资源跨页面草稿");
    await capture("agent-wide.png");
    const note = await call("notes.create", { title: "星海手记", text: "保留沿途的想法，下一次启程时再回来看。", resourceId: book.resourceId });
    await page.reload();
    await page.getByTestId("nav-notes").waitFor();
    await page.getByTestId("nav-notes").click();
    await page.getByTestId(`note-${note.objectId}`).click();
    await page.getByTestId("note-surface").waitFor();
    await capture("notes-wide.png");
    detail.resourceTitle = book.title;
    detail.crossPageDraft = "preserved";
  });
} finally {
  await app.close();
  const report = { at: new Date().toISOString(), ...m1bFingerprints(repoRoot), scriptFingerprint: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"), status: observations.length === 5 && observations.every((item) => item.status === "passed") ? "passed" : "failed", humanChecks: "not-run", productAcceptance: "not-run", screenshots, observations };
  fs.writeFileSync(path.join(evidence, "a-b6-ui-review.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}
