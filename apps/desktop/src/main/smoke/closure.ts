import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, openFromShelf, selectText, setField, sleep, waitForTestId, waitUntil } from "./driver.ts";
import { caller, ensureRightPane, js, openSettingsPage, type FlowResult } from "./common.ts";

/**
 * End-to-end closure smoke through the real renderer: import a synthetic book, read to the last chapter, select text, record a note
 * from the right pane, jump to the source and back from the records list, take the selection and the note to an Agent task, and then
 * verify restart recovery. Timing is measured around real operations, not around synthetic click dispatch.
 */

const ASK_TEXT = "用材料回答闭合问题";
const NOTE_TEXT = "闭合样本正文";

type Notes = Array<{ id: string; title: string; resourceId: string | null }>;

export async function runClosureSmoke(appService: MangaProductApp, grant: string, view: BrowserWindow, phase: string): Promise<FlowResult> {
  const call = caller(appService, grant);
  if (phase === "closure-restart") {
    const workspace = await call("workspace.get", {});
    const notes = ((workspace.value as { notes?: Notes } | undefined)?.notes) ?? [];
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
    const closureRun = runs.find((run) => run.inputText === ASK_TEXT);
    if (closureRun) {
      const detail = await call("agent.getRun", { runId: closureRun.id });
      const contextText = String((detail.value as { contextText?: string } | undefined)?.contextText ?? "");
      restoredMaterials = contextText.includes("chi-close-sel") && contextText.includes(NOTE_TEXT);
    }
    let uiRestoredTail = false;
    if (restoredResource && await openFromShelf(view, "nav-reading", restoredResource.id)) {
      uiRestoredTail = await waitUntil(view, `(() => {
        const status = document.querySelector('[data-testid="reading-restore-status"]');
        const text = document.querySelector('[data-testid="reading-body"]')?.textContent ?? "";
        const offset = Number(status?.getAttribute("data-offset") ?? "0");
        return status?.getAttribute("data-restored") === "progress" && offset > 0 && text.includes("chi-close-tail");
      })()`, 8000);
    }
    const bodyText = await js<string>(view, `document.body ? document.body.innerText : ""`);
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

  // The renderer is reloaded because the import happened through the service, so its workspace cache is stale.
  await view.webContents.reload();
  await waitForTestId(view, "nav-reading");
  // A work is opened from its card: the work's page first, then reading.
  const openedResource = await openFromShelf(view, "nav-reading", resourceId);
  await waitForTestId(view, "reading-body");
  const rightPane = await ensureRightPane(view);
  // Select a range that sits mid-line, so a reader that hands over the whole window would fail the accuracy check below.
  const selection = await selectText(view, '[data-testid="reading-body"]', 8, 21);
  const selectMs = selection.ms;
  const selectedQuote = selection.quote;
  // A passage that was picked and held becomes a tag in the right pane's input.
  const tagShown = await waitUntil(view, `document.querySelector('[data-testid="chat-tag-selection"]')`, 8000);
  // A note from the right pane: the picked passage is its source, the typed text is the user's own.
  await clickTestId(view, "chat-mode-note");
  await setField(view, "agent-composer", NOTE_TEXT);
  await sleep(100);
  const noteAt = Date.now();
  const noteSent = await clickTestId(view, "agent-send");
  const bubbleShown = noteSent && await waitUntil(view, `document.querySelector('[data-testid^="bubble-note-"]')`, 20_000);
  // The bubble is the receipt the user waits for, so the timing ends there and not at the click.
  const noteMs = Date.now() - noteAt;
  await sleep(300);
  const workspace = await call("workspace.get", {});
  const notes = ((workspace.value as { notes?: Notes } | undefined)?.notes) ?? [];
  const recorded = notes.find((note) => note.title.includes("闭合样本"));

  // The recorded excerpt must be the selected range, not the whole window the reader handed over.
  let quoteRange: { start: number; end: number } | null = null;
  let excerpt = "";
  let selectionAccurate = false;
  let commentKept = false;
  if (recorded) {
    const read = await call("notes.get", { objectId: recorded.id });
    const blocks = ((read.value as { document?: { blocks?: Array<{ id: string; text: string; anchorId?: string }> } } | undefined)?.document?.blocks) ?? [];
    excerpt = blocks.find((block) => block.anchorId)?.text ?? "";
    commentKept = blocks.some((block) => !block.anchorId && block.text.includes(NOTE_TEXT));
    const locator = ((read.value as { sources?: Array<{ blockId: string | null; locator: string }> } | undefined)?.sources ?? [])
      .find((source) => source.blockId === blocks.find((block) => block.anchorId)?.id)?.locator;
    quoteRange = locator ? JSON.parse(locator).range ?? null : null;
    selectionAccurate = excerpt === selectedQuote && selectedQuote === "chi-close-sel" && quoteRange?.start === 8 && quoteRange.end === 21;
  }

  // Move through the reader to the tail and mark that position. The first window must not already contain it.
  const firstWindowHasTail = await js<boolean>(view, `(document.querySelector('[data-testid="reading-body"]')?.textContent ?? "").includes("chi-close-tail")`);
  const moved = await clickTestId(view, "reading-more");
  const uiTailVisible = !firstWindowHasTail && moved && await waitUntil(view, `(document.querySelector('[data-testid="reading-body"]')?.textContent ?? "").includes("chi-close-tail")`, 8000);
  const marked = uiTailVisible && await clickTestId(view, "reading-progress");
  const progressAtTail = marked && await waitUntil(view, `(() => {
    const status = document.querySelector('[data-testid="reading-restore-status"]');
    const text = document.querySelector('[data-testid="reading-body"]')?.textContent ?? "";
    const offset = Number(status?.getAttribute("data-offset") ?? "0");
    return status?.getAttribute("data-restored") === "progress" && offset > 0 && text.includes("chi-close-tail");
  })()`, 8000);

  // Jump from the note to its source and back: the records list is where notes are found now.
  let sourceCardOk = false;
  if (recorded) {
    const listed = await openSettingsPage(view, "records");
    const openSource = listed && await clickTestId(view, `record-source-${recorded.id}`, 10_000);
    if (openSource) sourceCardOk = await waitForTestId(view, "reading-source-card", "data-present", null, 15_000);
    if (sourceCardOk) {
      const returned = await clickTestId(view, "reading-source-back");
      sourceCardOk = returned && await waitForTestId(view, "note-editor", "data-present", null, 10_000);
    }
  }

  // Reader style controls must be reachable and persist, and a bookmark must keep a real range.
  await openFromShelf(view, "nav-reading", resourceId);
  const styleReachable = await waitForTestId(view, "reading-font-size-value", "data-present", null, 10_000);
  await clickTestId(view, "reading-theme-green");
  await sleep(400);
  const shellAfter = await call("settings.getShell", {});
  const theme = (shellAfter.value as { reading?: { theme?: string } } | undefined)?.reading?.theme;

  // A bookmark taken in the reader has to be listed, openable and removable.
  const bookmarkAdded = await clickTestId(view, "reading-bookmark-add");
  await clickTestId(view, "reading-panel-bookmarks");
  await sleep(500);
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
  await sleep(400);
  const afterRemove = await call("reading.bookmarks", { resourceId });
  const bookmarkRemoved = ((afterRemove.value as unknown[] | undefined) ?? []).length === bookmarkRows.length - 1;

  // Ask from the right pane: the picked passage and the note travel with the task, and the debug panel shows exactly what was sent.
  let materialsFrozen = false;
  let materialsFromUi = false;
  let askTagShown = false;
  let contextChars = 0;
  const picked = await js<boolean>(view, `(() => {
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
  })()`);
  askTagShown = picked && await waitUntil(view, `document.querySelector('[data-testid="chat-tag-selection"]')`, 8000);
  if (askTagShown && recorded) {
    await ensureRightPane(view);
    await clickTestId(view, "chat-plus");
    if (await clickTestId(view, "chat-plus-materials")) {
      await clickTestId(view, `note-material-${recorded.id}`, 8000);
      await clickTestId(view, "materials-dialog-close");
    }
    await clickTestId(view, "chat-mode-ask");
    await setField(view, "agent-composer", ASK_TEXT);
    await sleep(150);
    await clickTestId(view, "agent-send");
    let sentRun: { id: string } | undefined;
    for (let attempt = 0; attempt < 60 && !sentRun; attempt += 1) {
      const after = await call("workspace.get", {});
      sentRun = (((after.value as { runs?: Array<{ id: string; inputText?: string }> } | undefined)?.runs) ?? []).find((run) => run.inputText === ASK_TEXT);
      if (!sentRun) await sleep(250);
    }
    if (sentRun) {
      const detail = await call("agent.getRun", { runId: sentRun.id });
      const contextText = String((detail.value as { contextText?: string } | undefined)?.contextText ?? "");
      contextChars = [...contextText].length;
      // The debug panel is the user's view of the same task: what it shows has to be what the run was given.
      await clickTestId(view, "debug-toggle");
      await clickTestId(view, "debug-tab-last");
      await waitUntil(view, `(document.querySelector('[data-testid="debug-last"]')?.textContent ?? "").includes("chi-close-sel")`, 10_000);
      const visible = await js<string>(view, `document.querySelector('[data-testid="debug-last"]')?.textContent ?? ""`);
      const squash = (text: string) => text.replace(/\s+/g, "");
      materialsFromUi = contextText.length > 0 && squash(visible).includes(squash(contextText).slice(0, 400));
      materialsFrozen = materialsFromUi && contextText.includes("闭合样本") && contextText.includes(revisionId) && contextText.includes(NOTE_TEXT) && contextText.includes("chi-close-sel");
      await call("agent.cancel", { runId: sentRun.id }, "closure-cancel");
      await clickTestId(view, "debug-close");
    }
  }

  return {
    ok: openedResource && rightPane && tagShown && bubbleShown && readLastChapter && marked && progressAtTail && progressStillAtTail && uiTailVisible && selectMs >= 0 && Boolean(recorded) && selectionAccurate && commentKept && materialsFrozen && materialsFromUi
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
      rightPane,
      tagShown,
      bubbleShown,
      askTagShown,
      commentKept,
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
