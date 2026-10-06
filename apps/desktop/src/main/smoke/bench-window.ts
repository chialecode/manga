import type { BrowserWindow } from "electron";
import { createId } from "@manga/contracts";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, openFromShelf, waitForTestId, waitUntil } from "./driver.ts";
import { actor, caller, js, openSettingsPage, toRail } from "./common.ts";

/**
 * Real-window timings. Each duration is taken until the renderer has committed the awaited content, not until a click was dispatched.
 * The notes are found the way a person finds them now: in the records list under settings, since there is no notes page in the rail.
 */

/** Click, then wait until the renderer has committed the requested content. The clock does not stop at dispatch. */
export async function measureWindowBench(view: BrowserWindow): Promise<Record<string, unknown>> {
  await view.webContents.executeJavaScript(`window.manga.command({ commandId: "settings.skipAi", idempotencyKey: crypto.randomUUID(), input: {} })`);
  // An empty library starts on the library paths page; the rail is behind its "back".
  await toRail(view);
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
  const opened = resourceId ? await openFromShelf(view, "nav-reading", resourceId) : false;
  const bodyHasMarker = `(document.querySelector('[data-testid="reading-body"]')?.textContent || "").includes(${JSON.stringify(marker)})`;
  const readable = await waitUntil(view, bodyHasMarker, 8000);
  const importToReadableMs = Date.now() - importStarted;
  await clickTestId(view, "nav-library");
  await waitForTestId(view, "page-library");
  // Content available: from the rail's click on the shelf to the book's text, through the card and the work's page, as a person opens it.
  const contentStarted = Date.now();
  const reopened = await openFromShelf(view, "nav-reading", resourceId);
  const contentVisible = reopened && await waitUntil(view, bodyHasMarker, 8000);
  const contentAvailableMs = Date.now() - contentStarted;
  const created = await view.webContents.executeJavaScript(`window.manga.command({ commandId: "notes.create", idempotencyKey: crypto.randomUUID(), input: { title: "窗口笔记", text: "初稿" } })`) as { status?: string; value?: { objectId?: string } };
  const objectId = String(created.value?.objectId ?? "");
  const listed = objectId ? await openSettingsPage(view, "records") : false;
  const noteOpened = listed && await clickTestId(view, `record-open-${objectId}`, 8000);
  await waitForTestId(view, "note-editor");
  const saveStarted = Date.now();
  const edited = await view.webContents.executeJavaScript(`(() => {
    const prose = document.querySelector('[data-testid="note-editor"] .ProseMirror');
    if (!prose) return false;
    prose.focus();
    return document.execCommand("insertText", false, "窗口回执");
  })()`) as boolean;
  const saved = await waitUntil(view, `document.querySelector('[data-testid="note-editor"]')?.getAttribute("data-save-state") === "saved"`, 8000);
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

export type ScaleSpec = {
  txt: { resourceId: string; marker: string };
  epub: { resourceId: string; marker: string };
  noteId: string;
  parseFile: string;
  scale: { metadataCount: number; searchBlocks: number };
};

/**
 * Real-window timings on a Profile seeded to the requirement 6.2 baseline (10k metadata, 50k blocks, a 10 MiB TXT and a 30 MiB EPUB).
 * Each duration is taken inside the renderer from the dispatched click to the DOM commit where the awaited content exists (a hidden
 * smoke window produces no regular animation frames, so paint is not part of the figure), and IPC polling from the main process does
 * not inflate or hide it.
 */
export async function measureScaleWindowBench(appService: MangaProductApp, grant: string, view: BrowserWindow, spec: ScaleSpec): Promise<Record<string, unknown>> {
  const call = caller(appService, grant);
  const launchedAt = Number(process.env.MANGA_SMOKE_LAUNCHED_AT ?? Date.now());
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
  /** A book is opened from its card: the card shows the work's page, and "read" there opens the reader. The clock runs over all of it. */
  const openTimed = (cardId: string, until: string, timeoutMs = 20_000) => view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = performance.now();
    const click = (id) => {
      const el = document.querySelector('[data-testid="' + id + '"]');
      if (!el || el.disabled) return false;
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
      return true;
    };
    const check = () => { try { return Boolean(${until}); } catch { return false; } };
    let stage = 0;
    const tick = () => {
      const elapsed = performance.now() - started;
      if (elapsed > ${timeoutMs}) { resolve({ ok: false, ms: elapsed, reason: "timeout at step " + stage }); return; }
      if (stage === 0 && click(${JSON.stringify(cardId)})) stage = 1;
      else if (stage === 1 && click("work-read")) stage = 2;
      else if (stage === 2 && check()) { resolve({ ok: true, ms: performance.now() - started }); return; }
      setTimeout(tick, 4);
    };
    tick();
  })`) as Promise<{ ok: boolean; ms: number; reason?: string }>;
  const present = (testId: string) => `document.querySelector('[data-testid="${testId}"]')`;
  const bodyHas = (marker: string) => `(document.querySelector('[data-testid="reading-body"]')?.textContent || "").includes(${JSON.stringify(marker)})`;
  const failures: string[] = [];
  const keep = (label: string, sample: { ok: boolean; ms: number; reason?: string }, into: number[]) => {
    if (sample.ok) into.push(sample.ms);
    else failures.push(`${label}: ${sample.reason ?? "failed"}`);
  };

  await call("settings.skipAi", {});
  await toRail(view);
  // Cold start: process launch until the library page is shown and the resource list can be opened.
  const library = await timed("nav-library", present("page-library"));
  const listed = await timed("nav-reading", present(`open-${spec.txt.resourceId}`));
  const coldStartToLibraryMs = library.ok && listed.ok ? Date.now() - launchedAt : -1;
  if (coldStartToLibraryMs < 0) failures.push(`cold start: ${library.reason ?? listed.reason ?? "library not operable"}`);

  // Local UI feedback: rail switches that must repaint the target page.
  const uiFeedbackMs: number[] = [];
  const tabs: Array<[string, string]> = [["nav-library", present("page-library")], ["nav-agent", present("page-agent")], ["nav-reading", present(`open-${spec.txt.resourceId}`)]];
  for (let round = 0; round < 4; round += 1) {
    for (const [tab, until] of tabs) keep(`ui ${tab}`, await timed(tab, until), uiFeedbackMs);
  }

  // Indexed large books: reopening restores the stored tail position, which must be the visible text. The rail always lands on a shelf.
  const largeTxtTailMs: number[] = [];
  const largeEpubTailMs: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    for (const [book, into] of [[spec.txt, largeTxtTailMs], [spec.epub, largeEpubTailMs]] as const) {
      await timed("nav-reading", present(`open-${book.resourceId}`));
      keep(`tail ${book.resourceId}`, await openTimed(`open-${book.resourceId}`, bodyHas(book.marker), 20_000), into);
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
  // The note is opened from the records list under settings.
  const openNote = async () => {
    await openSettingsPage(view, "records");
    await timed(`record-open-${spec.noteId}`, present("note-editor"));
  };
  await openNote();
  const saveReceiptMs: number[] = [];
  for (let round = 0; round < 5; round += 1) keep(`save ${round}`, await saveOnce(`规模保存${round}`), saveReceiptMs);

  // Background parse: a new 10 MiB book is imported while the window keeps being used. The renderer drives its own sampling loop,
  // because a busy main process would also delay any sampling started from here. A sample counts when it starts while the import is
  // running, so a click or save that stalls until parsing ends is kept.
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
    const tabs = [["nav-library", present("page-library")], ["nav-agent", present("page-agent")], ["nav-reading", present(${JSON.stringify(`open-${spec.txt.resourceId}`)})]];
    const state = window.__benchParse = { stop: false, ui: [], saves: [] };
    const epoch = () => performance.timeOrigin + performance.now();
    (async () => {
      let round = 0;
      while (!state.stop && round < 200) {
        // The rail is only there outside settings; the note is left through the rail's own "back to the shelf" first.
        if (!document.querySelector('[data-testid="nav-library"]')) click("settings-back");
        for (const [tab, until] of tabs) {
          const at = epoch();
          const started = performance.now();
          const ok = click(tab) && await frameUntil(until, 15000);
          state.ui.push({ tab, ok, at, ms: performance.now() - started });
        }
        click("nav-settings");
        await frameUntil(present("settings-nav-records"), 15000);
        click("settings-nav-records");
        await frameUntil(present(${JSON.stringify(`record-open-${spec.noteId}`)}), 15000);
        click(${JSON.stringify(`record-open-${spec.noteId}`)});
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
      uiFeedback: "dispatched rail click (library, chat, novel shelf) → DOM commit of the target page (4 ms polling, hidden window, no paint)",
      largeTail: "card click → the work's page → read click → DOM commit whose reading body contains the tail marker restored from stored progress",
      saveReceipt: "insertText in the note editor (opened from the records list) → data-save-state leaves and returns to saved",
      duringParse: "same UI and save samples, kept only while a 10 MiB import is still parsing",
    },
  };
}

/**
 * The right pane with a long conversation: 1000 notes in one work's stream, scrolled and typed into. A hidden window produces no
 * animation frames, so each figure is the time the page takes to do the work and lay it out (a forced layout read), not paint:
 *  - scroll: set the list's position and read its layout
 *  - input: type into the box (React's commit of the controlled value) and read the layout
 * The list pages in 200 messages at a time; "older" is pressed until all are on screen. These are measurements, not limits.
 */
export async function measurePaneBench(view: BrowserWindow, resourceId: string, notes: number): Promise<Record<string, unknown>> {
  const opened = await openFromShelf(view, "nav-reading", resourceId);
  const bodyShown = opened && await waitForTestId(view, "reading-body", "data-present", null, 10_000);
  const paneShown = await waitUntil(view, `document.querySelector('[data-testid="chat-composer"]') && document.querySelector('[data-testid="chat-log"]')`, 15_000);
  // Bring every page of the stream in.
  let pages = 0;
  for (let round = 0; round < 12; round += 1) {
    if (!(await waitUntil(view, `document.querySelector('[data-testid="chat-older"]')`, 1500))) break;
    await clickTestId(view, "chat-older");
    pages += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const loaded = await js<number>(view, `document.querySelectorAll('[data-testid^="bubble-note-"]').length`);
  const measured = await js<{ scrollMs: number[]; inputMs: number[]; domNodes: number; height: number; client: number }>(view, `new Promise((resolve) => {
    const log = document.querySelector('[data-testid="chat-log"]');
    const area = document.querySelector('[data-testid="agent-composer"]');
    // The scroll element of the log is a child of the log region (use-stick-to-bottom's own wrapper), not one of its parents.
    const scrolls = (node) => { const style = getComputedStyle(node); return (style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight; };
    const scroller = (() => {
      for (const node of [log, ...Array.from(log.children)]) if (scrolls(node)) return node;
      let node = log.parentElement;
      while (node && node !== document.body) {
        if (scrolls(node)) return node;
        node = node.parentElement;
      }
      return log;
    })();
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    const scrollMs = [];
    const inputMs = [];
    const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    let step = 0;
    const next = () => {
      if (step >= 60) { resolve({ scrollMs, inputMs, domNodes: log.querySelectorAll("*").length, height: scroller.scrollHeight, client: scroller.clientHeight }); return; }
      const a = performance.now();
      scroller.scrollTop = (step % 2 === 0 ? (step / 2 + 1) / 31 : 1 - (step + 1) / 62) * max;
      void scroller.offsetHeight;
      scrollMs.push(performance.now() - a);
      const b = performance.now();
      set.call(area, "输入延迟样本 " + step);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      void area.offsetHeight;
      inputMs.push(performance.now() - b);
      step += 1;
      setTimeout(next, 20);
    };
    next();
  })`);
  await js(view, `(() => { const area = document.querySelector('[data-testid="agent-composer"]'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set; set.call(area, ""); area.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  return {
    ok: Boolean(bodyShown) && paneShown && loaded >= Math.min(notes, 1000) && measured.scrollMs.length >= 30 && measured.height > measured.client,
    notes,
    loaded,
    pages,
    scrollMs: measured.scrollMs,
    inputMs: measured.inputMs,
    domNodes: measured.domNodes,
    scrollHeight: measured.height,
    clientHeight: measured.client,
    waits: {
      scroll: "set the message list's scroll position → forced layout read (hidden window: no paint)",
      input: "set the input's value and dispatch input → React commit → forced layout read",
    },
  };
}
