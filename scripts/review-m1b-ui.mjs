import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { repoRoot, desktopOutput, desktopPackageDir } from "./desktop-paths.ts";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";

// Synthetic review only: no real profile, file import, credentials or model calls.
const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/a-review");
const runs = path.join(desktopOutput, "review-runs");
fs.mkdirSync(runs, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(runs, "ui-"));
const env = { ...process.env, MANGA_CHANNEL: "test", MANGA_PROFILE_ROOT: path.join(profile, "profile"), MANGA_POINTER_FILE: path.join(profile, "pointer.json"), MANGA_DOCUMENTS_DIR: path.join(profile, "documents") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(desktopPackageDir, "MANGA-win32-x64/MANGA.exe"), env, timeout: 30_000 });
const observations = [];
try {
  const page = await app.firstWindow();
  await page.getByTestId("nav-reading").waitFor();
  const call = (commandId, input) => page.evaluate(async ({ commandId, input }) => {
    const result = await window.manga.command({ commandId, input, idempotencyKey: crypto.randomUUID() });
    if (result.status !== "ok") throw new Error(JSON.stringify(result.error));
    return result.value;
  }, { commandId, input });
  await call("settings.skipAi", {});
  const book = await call("library.importText", { title: "合成阅读样本", bytes: [...Buffer.from("第一段：中文与日本語。\n第二段：用于光标换段和重复创建笔记。\n第三段：人工检查只使用此合成样本。")] });
  const other = await call("notes.create", { title: "另一份合成笔记", text: "另一份内容" });
  await page.reload();
  await page.getByTestId("nav-reading").click();
  await page.getByTestId(`open-${book.resourceId}`).click();
  await page.getByTestId("reading-body").waitFor();
  assert.match(await page.getByTestId("reading-body").innerText(), /第二段/);
  await page.getByTestId("reading-body").evaluate((body) => {
    const range = document.createRange();
    range.setStart(body.firstChild, 4);
    range.setEnd(body.firstChild, 6);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByTestId("reading-note").click();
  await page.getByTestId("note-surface").waitFor();
  await page.getByTestId("note-surface").press("End");
  await page.getByTestId("note-surface").pressSequentially(" saved-a");
  await page.waitForFunction(() => document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state") === "saved");
  const ws = await call("workspace.get", {});
  const created = ws.notes.find((note) => note.id !== other.objectId);
  const saved = await call("notes.get", { objectId: created.id });
  assert.match(saved.document.blocks[0].text, /saved-a/);
  const actualRange = JSON.parse(saved.sources[0].locator).range;
  assert.deepEqual(actualRange, { start: 4, end: 6 });
  observations.push({ finding: "F-02", check: "selected range only", expected: { start: 4, end: 6 }, actual: actualRange, status: "passed" });
  await page.getByTestId(`note-${other.objectId}`).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="note-surface"]')?.textContent === "另一份内容");
  assert.equal(await page.getByTestId("note-surface").innerText(), "另一份内容");
  await page.getByTestId("note-surface").press("End");
  await page.getByTestId("note-surface").pressSequentially(" saved-b");
  await page.waitForFunction(() => document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state") === "saved");
  const previous = await call("notes.get", { objectId: created.id });
  assert.equal(previous.document.blocks[0].text, saved.document.blocks[0].text);
  assert.match((await call("notes.get", { objectId: other.objectId })).document.blocks[0].text, /saved-b/);
  await page.getByTestId("nav-reading").click();
  await page.getByTestId("reading-body").evaluate((body) => {
    const range = document.createRange();
    range.setStart(body.firstChild, 0);
    range.setEnd(body.firstChild, 12);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByTestId("reading-note").click();
  await page.getByTestId("note-surface").waitFor();
  await page.getByTestId("note-surface").press("End");
  await page.getByTestId("note-surface").press("ArrowLeft");
  await page.getByTestId("note-split").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="note-surface"] > [data-block-id]').length === 3);
  await page.waitForFunction(() => document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state") === "saved");
  const viewports = [];
  for (const size of [[1280, 840], [360, 780]]) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), size);
    await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, size);
    await page.waitForFunction(() => document.querySelector('[data-testid="shell-left"]')?.getAttribute("data-shell-state") === "dock" || innerWidth < 960);
    const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, overflow: document.documentElement.scrollWidth > innerWidth, mainWidth: document.querySelector('[data-testid="shell-main"]').getBoundingClientRect().width }));
    assert.equal(geometry.overflow, false);
    viewports.push(geometry);
    await page.screenshot({ path: path.join(evidence, `a-notes-${size[0]}.png`) });
  }
  await page.getByTestId("shell-left-toggle").click();
  await page.getByTestId("mode-menu").click();
  assert.ok(await page.getByTestId("shell-left").getByTestId("mode-menu-list").isVisible());
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("shell-left").count(), 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 840));
  await page.getByTestId("nav-reading").waitFor();
  await page.getByTestId("shell-left-toggle").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="shell-left"]'));
  await page.getByTestId("shell-left-toggle").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="shell-left"]')?.getAttribute("data-shell-state") === "dock");
  fs.writeFileSync(path.join(evidence, "a-ui-review.json"), JSON.stringify({ localFixesStatus: "passed", reviewDisposition: "rework-required", productAcceptance: "not-run", humanChecks: "not-run", ...m1bFingerprints(repoRoot), scriptFingerprint: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"), at: new Date().toISOString(), checks: ["note identity and save target", "reading to notes repeated twice", "split at cursor after navigation", "wide dock restore", "360px narrow main panel", "sidebar mode menu and Escape"], viewports, observations }, null, 2) + "\n");
  console.log(JSON.stringify({ localFixesStatus: "passed", reviewDisposition: "rework-required", observations }));
} finally {
  await app.close();
}
