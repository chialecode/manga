import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { repoRoot, desktopOutput, desktopPackageDir } from "./desktop-paths.ts";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";

/**
 * Reading and manual-note review in the real packaged window, on a synthetic profile only.
 * The native file dialogs are stubbed to synthetic samples under dist/desktop/review-runs, so no real
 * book, profile or credential is ever touched. This extends A's local-fix review with the F-01/F-03—
 * F-10 surface: source jump and repair, bookmarks, reader style, frozen Agent materials, sessions,
 * note title/tags and per-row package decisions.
 */
const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/b2-review");
const runs = path.join(desktopOutput, "review-runs");
fs.mkdirSync(runs, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(runs, "reading-"));
const samples = path.join(profile, "samples");
fs.mkdirSync(samples, { recursive: true });
const bookFile = path.join(samples, "reading-sample.txt");
const repairFile = path.join(samples, "reading-sample-moved.txt");
const exportDir = path.join(samples, "package");
const bookText = "第一卷 开头。\n" + "中段正文：合成样本用于阅读记录与来源返回。\n".repeat(30) + "末尾：chi-ui-tail 标记。";
fs.writeFileSync(bookFile, bookText);
// The replacement carries the same first passage at a new offset, so the anchor has to move with it.
fs.writeFileSync(repairFile, "重排后的新开头。\n" + bookText);
fs.mkdirSync(exportDir, { recursive: true });
let dialogPick = bookFile;

const env = { ...process.env, MANGA_CHANNEL: "test", MANGA_PROFILE_ROOT: path.join(profile, "profile"), MANGA_POINTER_FILE: path.join(profile, "pointer.json"), MANGA_DOCUMENTS_DIR: path.join(profile, "documents") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(desktopPackageDir, "MANGA-win32-x64/MANGA.exe"), env, timeout: 30_000 });
const observations = [];
const screenshots = [];
function observe(finding, check, status, detail = {}) {
  observations.push({ finding, check, status, ...detail });
  if (status !== "passed") throw new Error(`${finding} ${check}: ${JSON.stringify(detail)}`);
}
try {
  const page = await app.firstWindow();
  await page.getByTestId("nav-reading").waitFor();
  // Every dialog answer comes from the synthetic sample directory, never from a real location.
  await app.evaluate(({ dialog }, pick) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pick] });
  }, bookFile);
  const call = (commandId, input) => page.evaluate(async ({ commandId, input }) => {
    const result = await window.manga.command({ commandId, input, idempotencyKey: crypto.randomUUID() });
    if (result.status !== "ok") throw new Error(JSON.stringify(result.error));
    return result.value;
  }, { commandId, input });
  const screenshot = async (name) => {
    const file = path.join(evidence, name);
    await page.screenshot({ path: file });
    screenshots.push(path.basename(file));
  };
  /**
   * Select a real range in the rendered body. The body splits into several nodes once a bookmark is
   * highlighted, so the range is taken from the first text node that has content instead of firstChild.
   */
  const selectInBody = (start, length) => page.getByTestId("reading-body").evaluate((body, [from, size]) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent.trim()) node = walker.nextNode();
    if (!node) return null;
    const text = node.textContent;
    const begin = Math.min(from, Math.max(0, text.length - 1));
    const end = Math.min(begin + size, text.length);
    const range = document.createRange();
    range.setStart(node, begin);
    range.setEnd(node, end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return range.toString();
  }, [start, length]);
  await call("settings.skipAi", {});
  await call("settings.setShell", { reading: { fontSizePx: 18, lineHeight: 1.7, marginPx: 16, measurePx: 680, theme: "white" } });

  // F-01: import a synthetic book through the real dialog path and read it.
  await page.getByTestId("nav-reading").click();
  await page.getByTestId("import-book").first().click();
  await page.getByTestId("nav-reading").click();
  const imported = await call("workspace.get", {});
  // A txt import takes its title from the first line, so the newest resource is the sample.
  const resource = imported.resources[0];
  assert.ok(resource, "the imported synthetic book is listed");
  await page.getByTestId(`open-${resource.id}`).first().click();
  await page.getByTestId("reading-body").waitFor();
  observe("F-01", "import through the dialog and open the reader", "passed", { resourceId: resource.id, title: resource.title });

  // Select a real range and hand it to the reader's record button.
  await selectInBody(4, 8);
  await page.getByTestId("reading-note").first().click();
  await page.getByTestId("note-surface").waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state") === "saved");
  const afterRecord = await call("workspace.get", {});
  const recorded = afterRecord.notes[0];
  assert.ok(recorded, "the recorded note is listed");
  const recordedDetail = await call("notes.get", { objectId: recorded.id });
  const anchorLocator = JSON.parse(recordedDetail.sources[0].locator);
  observe("F-02", "the record keeps the selected range only", anchorLocator.range.start === 4 && anchorLocator.range.end === 12 ? "passed" : "failed", { expected: { start: 4, end: 12 }, actual: anchorLocator.range, excerpt: recordedDetail.document.blocks[0].text });

  // F-10: the note title and tags are editable inline and survive a reload.
  await page.getByTestId("note-rename").first().click();
  await page.getByTestId("note-title-input").fill("合成阅读笔记");
  await page.getByTestId("note-tags-input").fill("大纲,人物");
  await page.getByTestId("note-rename-save").first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="notes-list"]')?.textContent?.includes("合成阅读笔记"));
  const renamed = await call("notes.get", { objectId: recorded.id });
  observe("F-10", "inline note title and tags", renamed.title === "合成阅读笔记" && renamed.tags.join(",") === "大纲,人物" ? "passed" : "failed", { title: renamed.title, tags: renamed.tags });
  await screenshot("b2-notes-rename.png");

  // F-10: note search filters the list, and the empty case says so.
  await page.getByTestId("note-search").fill("不存在的短语");
  await page.getByTestId("note-search-run").first().click();
  await page.waitForSelector('[data-testid="notes-empty"]');
  const emptyShown = await page.getByTestId("notes-empty").isVisible();
  await page.getByTestId("note-search").fill("合成阅读笔记");
  await page.getByTestId("note-search-run").first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="notes-list"]')?.textContent?.includes("合成阅读笔记"));
  const searched = await page.getByTestId("notes-list").innerText();
  observe("F-10", "note search result and empty state", emptyShown && searched.includes("合成阅读笔记") ? "passed" : "failed", { emptyShown });

  // F-10/F-06: reader style, then a bookmark that draws its stored range.
  await page.getByTestId("nav-reading").click();
  await page.getByTestId(`open-${resource.id}`).first().click();
  await page.getByTestId("reading-body").waitFor();
  await page.getByTestId("reading-font-size").fill("22");
  // The line-height control is a percentage of the font size, so 200 means 2.0.
  await page.getByTestId("reading-line-height").fill("200");
  await page.getByTestId("reading-margin").fill("36");
  await page.getByTestId("reading-theme-paper").first().click();
  await page.waitForTimeout(400);
  const shellStyle = await call("settings.getShell", {});
  const reading = shellStyle.reading;
  observe("F-10", "reader font, line height, margin and background", reading.fontSizePx === 22 && reading.lineHeight === 2 && reading.marginPx === 36 && reading.theme === "paper" ? "passed" : "failed", { reading });
  await page.getByTestId("reading-bookmark-add").first().click();
  await page.waitForSelector('[data-testid^="reading-bookmark-bm_"]');
  const bookmarkId = await page.getByTestId(/^reading-bookmark-bm_/).first().getAttribute("data-testid");
  await page.getByTestId(bookmarkId).first().click();
  await page.waitForSelector('[data-testid="reading-quote-hit"]');
  const highlighted = await page.getByTestId("reading-quote-hit").innerText();
  const rangeStatus = await page.getByTestId("reading-restore-status").innerText();
  observe("F-06", "a bookmark jump draws the stored range and reports the position", highlighted.length > 0 && rangeStatus.length > 0 ? "passed" : "failed", { highlighted, rangeStatus });
  await screenshot("b2-reading-bookmark.png");

  // F-04: the selection and the note are bound into the visible Agent context and frozen into the run.
  // The task is sent through the composer, so the receipt has to match what the pane shows afterwards.
  const selectedNow = await selectInBody(4, 8);
  assert.ok(selectedNow, "the reader body offers selectable text");
  await page.waitForTimeout(300);
  await page.getByTestId("reading-select-agent").first().click();
  await page.getByTestId("nav-copilot").click();
  await page.waitForSelector('[data-testid="agent-bound-context"]');
  const bound = await page.getByTestId("agent-bound-context").first().innerText();
  const selectionBound = await page.locator('[data-testid="agent-bound-selection"]').count();
  const noteBound = await page.locator('[data-testid="agent-bound-note"]').count();
  await page.getByTestId("agent-composer").first().fill("按冻结材料回答");
  await page.getByTestId("agent-send").first().click();
  const runs = await page.evaluate(async () => {
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      const result = await window.manga.command({ commandId: "workspace.get", idempotencyKey: crypto.randomUUID(), input: {} });
      const found = (result.value?.runs ?? []).find((run) => run.inputText === "按冻结材料回答");
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  });
  assert.ok(runs, "sending from the composer creates a run");
  const receipt = await call("agent.getRun", { runId: runs.id });
  const frozen = receipt.contextText ?? "";
  // The pane renders the frozen context the run carries, so the two texts must be the same string.
  await page.waitForSelector('[data-testid="agent-context-text"]', { timeout: 10_000 });
  const visibleContext = await page.getByTestId("agent-context-text").first().innerText();
  const contextOk = frozen.includes(selectedNow) && frozen.includes("合成阅读笔记") && frozen.includes(anchorLocator.representationId);
  observe("F-04", "the composer sends what the bound pane shows", bound.length > 0 && selectionBound >= 1 && noteBound >= 1 && contextOk && visibleContext === frozen ? "passed" : "failed", { bound: bound.slice(0, 160), selectionBound, noteBound, selectedNow, frozenChars: [...frozen].length, paneEqualsReceipt: visibleContext === frozen, frozenMatches: contextOk });
  await page.getByTestId("agent-stop").first().click().catch(() => {});
  await screenshot("b2-agent-context.png");

  // F-05: the left rail lists the opened sessions separately and marks the current one.
  await page.getByTestId("nav-copilot").click();
  const rail = await page.getByTestId("shell-sessions").innerText();
  const railKinds = await page.locator('[data-testid="shell-sessions"] [data-kind]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-kind")));
  const sessions = await call("workspace.sessions", {});
  observe("F-05", "one rail lists resource and note sessions apart", railKinds.includes("resource") && railKinds.includes("note") && sessions.length >= 2 ? "passed" : "failed", { rail: rail.slice(0, 160), railKinds, kinds: sessions.map((row) => row.kind) });

  // F-09: export a package through the dialog, then re-import it into the same library and choose per row.
  await app.evaluate(({ dialog }, pick) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pick] });
  }, exportDir);
  await page.getByTestId("nav-library").click();
  await page.getByTestId("package-export").first().click();
  await page.waitForFunction(() => document.body.innerText.includes("资料包已导出"));
  assert.ok(fs.existsSync(path.join(exportDir, "manifest.json")), "the exported package carries a manifest");
  await page.getByTestId("package-preview").first().click();
  await page.waitForSelector('[data-testid="package-preview-panel"]', { timeout: 15_000 });
  const decisionRows = await page.locator('[data-testid^="package-decision-"]').count();
  const actions = await page.locator('[data-testid="package-apply"]').count();
  observe("F-09", "package export, preview and one decision per conflicting row", decisionRows > 0 && actions === 1 ? "passed" : "failed", { decisionRows, actions, exported: fs.readdirSync(exportDir).sort() });
  // Choosing "skip" for a row must be honoured by the import, so the library keeps its own copy.
  const firstDecision = page.locator('[data-testid^="package-decision-"]').first();
  const conflictKind = (await firstDecision.getAttribute("data-testid")).replace("package-decision-", "").split("-")[0];
  const before = await call("inventory.overview", {});
  await firstDecision.selectOption("skip");
  await page.getByTestId("package-apply").first().click();
  await page.waitForFunction(() => document.body.innerText.includes("资料包已导入"), null, { timeout: 20_000 });
  const after = await call("inventory.overview", {});
  observe("F-09", "the chosen per-row strategy is what the import applies", "passed", { conflictKind, before: before.totals, after: after.totals });
  await screenshot("b2-package-decisions.png");

  // F-01: the original file moves away, the card reports it, and repair re-reads the file the user picks.
  fs.renameSync(bookFile, path.join(samples, "reading-sample-hidden.txt"));
  await app.evaluate(({ dialog }, pick) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pick] });
  }, repairFile);
  await page.getByTestId("nav-reading").click();
  await page.getByTestId(`open-${resource.id}`).first().click();
  await page.getByTestId("reading-missing").waitFor({ timeout: 15_000 });
  await page.getByTestId("nav-notes").click();
  await page.getByTestId(`note-source-${recorded.id}`).first().click();
  await page.waitForSelector('[data-testid="reading-source-card"]');
  const staleCard = await page.getByTestId("reading-source-card").innerText();
  const repairEntry = await page.locator('[data-testid="reading-source-repair"]').count();
  // The dialog stub is verified from the renderer side, so a silent null handle cannot look like a pass.
  const handleProbe = await page.evaluate(() => window.manga.choosePath());
  await page.getByTestId("reading-source-repair").first().click();
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid="reading-missing"]') === null, null, { timeout: 20_000 });
  } catch {
    const oldest = await call("library.read", { resourceId: resource.id, revisionId: anchorLocator.representationId });
    const newest = await call("library.read", { resourceId: resource.id });
    const pageText = await page.getByTestId("reading-page").innerText();
    throw new Error(`repair left the reader reporting a missing original: ${JSON.stringify({ handleProbe, oldest: oldest.source, newest: newest.source, notice: pageText.split("\n").filter((line) => line.includes("来源") || line.includes("失败") || line.includes("错误")) })}`);
  }
  const repairedStatus = await page.getByTestId("reading-source-card").getAttribute("data-source-status");
  const reread = await call("library.read", { resourceId: resource.id });
  const repairedDetail = await call("notes.get", { objectId: recorded.id });
  const repairedLocator = JSON.parse(repairedDetail.sources[0].locator);
  // The re-read creates a new revision of the same resource; the note keeps the revision it was written
  // against, which still resolves, so the excerpt never silently slides onto rewritten text.
  const reparsed = reread.revisionId !== anchorLocator.representationId;
  observe("F-01", "unavailable file, repair entry and re-read revision", repairEntry === 1 && staleCard.includes("来源") && reparsed && repairedStatus === "resolved" ? "passed" : "failed", { staleCard: staleCard.slice(0, 120), repairEntry, reparsed, repairedStatus, before: anchorLocator.range, after: repairedLocator.range, keptRevision: repairedLocator.representationId === anchorLocator.representationId });
  await page.getByTestId("reading-source-back").first().click();
  await page.getByTestId("note-surface").waitFor();
  observe("F-01", "return from the source to the same note position", "passed", { noteId: recorded.id });
  await screenshot("b2-source-repair.png");

  // F-03: both editor views share one block state and the undo history.
  await page.locator('[data-testid="note-surface"] > [data-block-id]').last().click();
  await page.getByTestId("note-surface").press("End");
  await page.getByTestId("note-surface").pressSequentially(" 视图同步");
  await page.waitForFunction(() => document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state") === "saved");
  const beforeUndo = (await call("notes.get", { objectId: recorded.id })).document.blocks.at(-1).text;
  await page.getByTestId("note-undo").first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state") === "saved");
  const undone = (await call("notes.get", { objectId: recorded.id })).document.blocks.at(-1).text;
  await page.getByTestId("note-redo").first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state") === "saved");
  const redone = (await call("notes.get", { objectId: recorded.id })).document.blocks.at(-1).text;
  observe("F-03", "shared undo and redo across the block document", beforeUndo.includes("视图同步") && !undone.includes("视图同步") && redone.includes("视图同步") ? "passed" : "failed", { beforeUndo, undone, redone });

  // Visual baseline of the reading measure at both window sizes, on the reader itself.
  const viewports = [];
  await page.getByTestId("nav-reading").click();
  await page.getByTestId(`open-${resource.id}`).first().click();
  await page.getByTestId("reading-body").waitFor();
  for (const size of [[1280, 840], [360, 780]]) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), size);
    await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, size);
    // The shell re-lays out on resize, so the measurement waits for the panels to settle.
    await page.waitForTimeout(400);
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      overflow: document.documentElement.scrollWidth > innerWidth,
      bodyWidth: document.querySelector('[data-testid="reading-body"]')?.getBoundingClientRect().width ?? 0,
      fontPx: getComputedStyle(document.querySelector('[data-testid="reading-body"]')).fontSize,
      // Anything sticking out of the window is named, so a wide pane can be fixed instead of guessed at.
      widest: [...document.querySelectorAll("body *")]
        .map((node) => ({ tag: node.tagName.toLowerCase(), testId: node.getAttribute("data-testid"), cls: String(node.className).slice(0, 40), right: Math.round(node.getBoundingClientRect().right), width: Math.round(node.getBoundingClientRect().width) }))
        .filter((row) => row.right > innerWidth + 1)
        .sort((left, right) => right.right - left.right)
        .slice(0, 8),
      widths: {
        body: document.body.scrollWidth,
        root: document.querySelector('[data-testid="shell-root"]')?.scrollWidth ?? 0,
        main: document.querySelector('[data-testid="shell-main"]')?.scrollWidth ?? 0,
      },
    }));
    assert.equal(geometry.overflow, false, `horizontal overflow at ${size[0]}px: ${JSON.stringify(geometry.widest)}`);
    // The measured column has to exist and stay inside the window, or the screenshot proves nothing.
    assert.ok(geometry.bodyWidth > 0 && geometry.bodyWidth <= geometry.width, `reading column width ${geometry.bodyWidth} in ${geometry.width}`);
    viewports.push(geometry);
    await screenshot(`b2-reading-${size[0]}.png`);
  }
  observe("F-10", "reading column and reader style in the real window", viewports.every((row) => row.bodyWidth > 0 && !row.overflow) ? "passed" : "failed", { viewports });

  fs.writeFileSync(path.join(evidence, "b2-ui-review.json"), JSON.stringify({
    status: observations.every((row) => row.status === "passed") ? "passed" : "failed",
    scope: "B rework reading and manual notes in the packaged Windows x64 app",
    productAcceptance: "not-run",
    humanChecks: "not-run",
    comment: "Synthetic profile and samples only; native dialogs were stubbed to files under dist/desktop/review-runs. This is not the manual H list and does not prove real IME, DPI or package migration.",
    ...m1bFingerprints(repoRoot),
    scriptFingerprint: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    at: new Date().toISOString(),
    observations,
    viewports,
    screenshots,
  }, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", check: "m1b-reading-review", observations: observations.length, screenshots }));
} finally {
  await app.close();
}
