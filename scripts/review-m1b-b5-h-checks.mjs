import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { buildEpubFixture } from "../packages/app-core/src/domain/formats.ts";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";
import { repoRoot, desktopOutput, desktopPackageDir } from "./desktop-paths.ts";

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/a-b5-review");
const runs = path.join(desktopOutput, "review-runs");
fs.mkdirSync(runs, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const root = fs.mkdtempSync(path.join(runs, "a-b5-h-"));
const env = { ...process.env, MANGA_CHANNEL: "test", MANGA_PROFILE_ROOT: path.join(root, "profile"), MANGA_POINTER_FILE: path.join(root, "pointer.json"), MANGA_DOCUMENTS_DIR: path.join(root, "documents") };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
async function launch() {
  app = await electron.launch({ executablePath: path.join(desktopPackageDir, "MANGA-win32-x64/MANGA.exe"), env, timeout: 30_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await page.getByTestId("nav-reading").waitFor();
}
const call = (commandId, input) => page.evaluate(async ({ commandId, input }) => {
  const result = await window.manga.command({ commandId, input, idempotencyKey: crypto.randomUUID() });
  if (result.status !== "ok") throw new Error(result.error?.code ?? "command failed");
  return result.value;
}, { commandId, input });
const observations = [];
async function check(finding, name, run) {
  const detail = {};
  try { await run(detail); observations.push({ finding, name, status: "passed", detail }); }
  catch (error) { observations.push({ finding, name, status: "failed", actual: error.message, detail }); }
}
async function read(book) {
  await page.getByTestId("nav-reading").click();
  await page.getByTestId(`open-${book.resourceId}`).click();
  await page.getByTestId("reading-body").waitFor();
}
const screenshot = async (name) => {
  // Electron's native capture keeps the full surface when content zoom differs from the OS scale.
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(path.join(evidence, name), Buffer.from(png, "base64"));
};
const saved = () => page.waitForFunction(() => document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state") === "saved");
try {
  await launch();
  await call("settings.skipAi", {});
  const quote = "中文日本語😀é".normalize("NFC");
  const epub = buildEpubFixture({ title: "H 合成双章书", chapters: [
    { id: "first", title: "第一章", html: "<p>开头正文。</p>" },
    { id: "last", title: "末章", html: `<p>末章前缀。${quote}。末章结尾。</p>` },
  ] });
  const samplePath = path.join(root, "h-reading.epub");
  fs.writeFileSync(samplePath, epub);
  // Exercise the real import button while choosing only this synthetic file.
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, samplePath);
  await page.getByTestId("nav-reading").click();
  await page.getByTestId("import-book").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="open-res_"]').length > 0);
  const workspace = await call("workspace.get", {});
  const book = { resourceId: workspace.resources[0].id };
  let noteId;
  let expectedPart;
  await check("H-01", "EPUB final chapter, Unicode excerpt, comment, source return and process restart", async (detail) => {
    await read(book);
    const document = await call("library.read", book);
    expectedPart = document.parts.at(-1).id;
    await page.getByTestId(`toc-${expectedPart}`).click();
    await page.waitForFunction((text) => document.querySelector('[data-testid="reading-body"]')?.textContent?.includes(text), quote);
    const selected = await page.getByTestId("reading-body").evaluate((body, text) => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const start = node.textContent.indexOf(text);
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, start + text.length);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return range.toString();
      }
      return null;
    }, quote);
    assert.equal(selected, quote);
    await page.getByTestId("reading-note").click();
    await page.getByTestId("note-surface").waitFor();
    await page.getByTestId("note-surface").press("Control+End");
    await page.keyboard.insertText("人工评论 H 自动子集");
    await saved();
    noteId = (await call("workspace.get", {})).notes[0].id;
    const note = await call("notes.get", { objectId: noteId });
    const source = JSON.parse(note.sources[0].locator);
    detail.excerpt = note.document.blocks[0].text;
    detail.locator = source;
    assert.equal(detail.excerpt, quote);
    assert.equal(source.range.end - source.range.start, [...quote].length);
    assert.equal(source.partId, expectedPart);
    assert.ok(note.document.blocks.some((block) => block.text.includes("人工评论 H 自动子集")));
    await page.getByTestId(`note-source-${noteId}`).click();
    await page.getByTestId("reading-source-card").waitFor();
    assert.equal(await page.getByTestId("reading-quote-hit").innerText(), quote);
    await page.getByTestId("reading-source-back").click();
    await page.getByTestId("note-surface").waitFor();
    await screenshot("h01-unicode-note.png");
    await app.close();
    await launch();
    await read(book);
    detail.restoredPart = (await call("library.read", book)).slice.partId;
    assert.equal(detail.restoredPart, expectedPart);
    await page.getByTestId("nav-notes").click();
    await page.getByTestId(`note-${noteId}`).click();
    await page.getByTestId("note-surface").waitFor();
    assert.ok((await page.getByTestId("note-surface").innerText()).includes("人工评论 H 自动子集"));
    assert.equal((await call("notes.get", { objectId: noteId })).document.blocks[0].text, quote);
    detail.realIme = "not-run; Unicode text inserted through the test keyboard API";
  });

  await check("F-05", "one resource session keeps its composer draft across reading and Agent pages", async (detail) => {
    await read(book);
    await page.getByTestId("agent-composer").first().fill("same-resource-draft");
    await page.getByTestId("nav-agent").click();
    detail.agentDraft = await page.getByTestId("agent-composer").first().inputValue();
    await page.getByTestId("nav-reading").click();
    detail.readingDraft = await page.getByTestId("agent-composer").first().inputValue();
    assert.equal(detail.agentDraft, detail.readingDraft, "the same resource session has two independent composer keys");
  });

  await check("H-04", "keyboard mode menu preserves each mode's draft on returning", async (detail) => {
    await read(book);
    await page.getByTestId("agent-composer").first().fill("enthusiast-h-draft");
    await page.getByTestId("mode-menu").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-mode") === "creator");
    assert.equal(await page.getByTestId("agent-composer").first().inputValue(), "");
    await page.getByTestId("agent-composer").first().fill("creator-h-draft");
    await page.getByTestId("mode-menu").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-mode") === "enthusiast");
    assert.equal(await page.getByTestId("agent-composer").first().inputValue(), "enthusiast-h-draft");
    detail.nativeDraggingAndSnapping = "not-run";
  });

  for (const [width, height] of [[1920, 1080], [1280, 840], [960, 640], [720, 540], [800, 1200], [360, 780]]) {
    for (const zoom of [1, 1.25, 1.5]) {
      await check("H-03", `window ${width}x${height}, Electron zoom ${zoom}`, async (detail) => {
        await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.webContents.setZoomFactor(zoom);
          window.setContentSize(width, height);
        }, { width, height, zoom });
        await page.waitForFunction(({ width, zoom }) => Math.abs(innerWidth - width / zoom) <= 1, { width, zoom });
        await page.waitForTimeout(220);
        Object.assign(detail, await page.evaluate(() => {
          const main = document.querySelector('[data-testid="shell-main"]');
          const body = document.querySelector('[data-testid="reading-body"]');
          const bounds = body?.getBoundingClientRect();
          return { cssWidth: innerWidth, cssHeight: innerHeight, dpr: devicePixelRatio, shellOverflow: document.documentElement.scrollWidth > innerWidth, mainWidth: main.clientWidth, mainScrollWidth: main.scrollWidth, bodyWidth: bounds?.width, bodyRight: bounds?.right, bodyClientWidth: body?.clientWidth, bodyScrollWidth: body?.scrollWidth };
        }));
        assert.equal(detail.shellOverflow, false);
        assert.ok(detail.bodyWidth > 0 && detail.bodyRight <= detail.cssWidth + 1);
        assert.ok(detail.bodyScrollWidth <= detail.bodyClientWidth + 1);
        await page.getByTestId("reading-note").evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.getByTestId("reading-note").isVisible(), true);
        detail.recordButtonBounds = await page.getByTestId("reading-note").evaluate((node) => {
          const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
        });
        const bounds = detail.recordButtonBounds;
        detail.recordButtonReachable = bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.viewportWidth && bounds.bottom <= bounds.viewportHeight;
        assert.equal(detail.recordButtonReachable, true);
        if (width === 720 && zoom === 1.5) await screenshot("h03-720-150.png");
      });
    }
  }
  await check("H-03", "narrow sidebars hover transfer, Escape and focus return", async (detail) => {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setContentSize(360, 780);
    });
    await page.waitForFunction(() => innerWidth === 360);
    for (const side of ["left", "right"]) {
      const toggle = page.getByTestId(`shell-${side}-toggle`);
      await toggle.hover();
      const panel = page.getByTestId(`shell-${side}`);
      await panel.waitFor();
      await panel.hover();
      await page.waitForTimeout(260);
      assert.equal(await panel.isVisible(), true);
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
      assert.equal(await toggle.evaluate((node) => node === document.activeElement), true);
    }
    detail.zoomKind = "Electron content zoom; Windows display scaling is not changed";
  });
} finally {
  if (app) await app.close();
  const report = { at: new Date().toISOString(), ...m1bFingerprints(repoRoot), scriptFingerprint: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"), status: observations.length > 0 && observations.every((row) => row.status === "passed") ? "passed" : "rework-required", humanChecks: "not-run", productAcceptance: "not-run", scope: "Automated subsets of H-01/H-03/H-04 in the packaged Windows app. No real IME, OS DPI changes, physical dragging/snapping or visual acceptance.", observations };
  fs.writeFileSync(path.join(evidence, "a-b5-h-checks.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}
