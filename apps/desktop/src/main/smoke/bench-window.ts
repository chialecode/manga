import type { BrowserWindow } from "electron";
import { createId } from "@manga/contracts";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, closeTabs, DRAWN, ensureSidebar, openFromShelf, PICK, pressKey, railTo, sleep, viaSidebar, waitDrawn, waitForTestId, waitUntil, type RailName } from "./driver.ts";
import { actor, caller, ensureDock, js, toRail } from "./common.ts";

/**
 * Real-window timings. Each duration is taken until the renderer has committed the awaited content, not until a click was dispatched.
 * The notes are found the way a person finds them now: in the notes' records tab, which the notes view of the sidebar manages.
 * A context keeps the pages of its tabs mounted, so "the target page is there" always means the one the window draws (`PICK` and `DRAWN`), never a hidden one.
 */

/** Click, then wait until the renderer has committed the requested content. The clock does not stop at dispatch. */
export async function measureWindowBench(view: BrowserWindow): Promise<Record<string, unknown>> {
  // A tab is in front a frame after it is opened, and a hidden window runs no frames: the window is shown, without taking the keyboard from the person.
  view.showInactive();
  await view.webContents.executeJavaScript(`window.manga.command({ commandId: "settings.skipAi", idempotencyKey: crypto.randomUUID(), input: {} })`);
  // An empty library starts on the library paths page; the rail is behind its "back".
  await toRail(view);
  const clickStarted = Date.now();
  const clicked = await viaSidebar(view, "home", "sidebar-entry-library");
  const libraryVisible = await waitForTestId(view, "page-library");
  const interactionMs = Date.now() - clickStarted;
  const marker = "窗口末尾标记";
  const text = `${"窗口正文。".repeat(30)}${marker}`;
  const importStarted = Date.now();
  const imported = await view.webContents.executeJavaScript(`window.manga.command({ commandId: "library.importDocument", idempotencyKey: crypto.randomUUID(), input: { title: "窗口书", format: "txt", bytes: [...new TextEncoder().encode(${JSON.stringify(text)})] } })`) as { status?: string; value?: { resourceId?: string } };
  const resourceId = String(imported.value?.resourceId ?? "");
  await view.webContents.reload();
  await toRail(view);
  const opened = resourceId ? await openFromShelf(view, "novel", resourceId) : false;
  const bodyHasMarker = `(${PICK}("reading-body")?.textContent || "").includes(${JSON.stringify(marker)})`;
  const readable = await waitUntil(view, bodyHasMarker, 8000);
  const importToReadableMs = Date.now() - importStarted;
  await viaSidebar(view, "home", "sidebar-entry-library");
  await waitForTestId(view, "page-library");
  // Content available: from the rail's click on the shelf to the book's text, through the card and the work's page, as a person opens it.
  const contentStarted = Date.now();
  const reopened = await openFromShelf(view, "novel", resourceId);
  const contentVisible = reopened && await waitUntil(view, bodyHasMarker, 8000);
  const contentAvailableMs = Date.now() - contentStarted;
  const created = await view.webContents.executeJavaScript(`window.manga.command({ commandId: "notes.create", idempotencyKey: crypto.randomUUID(), input: { title: "窗口笔记", text: "初稿" } })`) as { status?: string; value?: { objectId?: string } };
  const objectId = String(created.value?.objectId ?? "");
  const listed = objectId ? await viaSidebar(view, "note", "sidebar-manage") && await waitDrawn(view, "records-tab", 8000) : false;
  const noteOpened = listed && await clickTestId(view, `record-open-${objectId}`, 8000);
  // The note's tab comes to the front a moment after the editor is there, and an editor out of sight cannot be typed into.
  await waitDrawn(view, "note-editor", 15_000);
  const saveStarted = Date.now();
  const saveState = `${PICK}("note-editor")?.getAttribute("data-save-state")`;
  const edited = await view.webContents.executeJavaScript(`(() => {
    const prose = ${PICK}("note-editor")?.querySelector(".ProseMirror");
    if (!prose) return false;
    window.__benchSeenUnsaved = false;
    prose.focus();
    return document.execCommand("insertText", false, "窗口回执");
  })()`) as boolean;
  // The editor leaves "saved" when it is typed into and returns to it with the receipt; a state that never changed is not a receipt.
  const saved = await waitUntil(view, `(window.__benchSeenUnsaved = window.__benchSeenUnsaved || ${saveState} !== "saved") && ${saveState} === "saved"`, 8000);
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
  // A tab is in front a frame after it is opened, and a hidden window runs no frames: the window is shown, without taking the keyboard from the person.
  view.showInactive();
  // The clock runs inside the page. `until` is a JS predicate over document; the promise resolves on the first 4 ms poll where it holds.
  const timed = (clickTestId: string | null, until: string, timeoutMs = 15_000, detail = 0) => view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = performance.now();
    const target = ${JSON.stringify(clickTestId)};
    if (target) {
      const el = ${PICK}(target);
      if (!el) { resolve({ ok: false, ms: -1, reason: "missing " + target }); return; }
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true, detail: ${detail} }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true, detail: ${detail} }));
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
      const el = ${PICK}(id);
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
  const present = (testId: string) => `${DRAWN}(${PICK}(${JSON.stringify(testId)}))`;
  /** A click on an entry of one view's sidebar: the view's icon is pressed and the sidebar shown first (the rail's own figure is measured elsewhere), and the clock covers the entry's click. */
  const entry = async (name: RailName, testId: string, until: string, timeoutMs = 15_000) => {
    if (!(await railTo(view, name)) || !(await ensureSidebar(view))) return { ok: false, ms: -1, reason: `the sidebar of ${name} was not reachable` };
    await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="sidebar"][data-view="${name}"]'))`, 3000);
    return timed(testId, until, timeoutMs);
  };
  /** The search box over the window, opened from the home's sidebar, closed again with Esc so the next sample starts from the window. */
  const searchBox = async () => {
    const sample = await entry("home", "sidebar-search", present("search-input"));
    await pressKey(view, "Escape");
    await waitUntil(view, `!document.querySelector('[data-testid="search-box"]')`, 3000);
    return sample;
  };
  const bodyHas = (marker: string) => `(${PICK}("reading-body")?.textContent || "").includes(${JSON.stringify(marker)})`;
  /** The shelf of novels, reached from the rail the way a person reaches it; readers and library tabs of an earlier sample are closed first. */
  const shelf = async (resourceId: string) => {
    await closeTabs(view, ["library", "reader"]);
    await entry("home", "sidebar-entry-library", present("page-library"));
    return timed("section-all-novel", present(`open-${resourceId}`));
  };
  const failures: string[] = [];
  const keep = (label: string, sample: { ok: boolean; ms: number; reason?: string }, into: number[]) => {
    if (sample.ok) into.push(sample.ms);
    else failures.push(`${label}: ${sample.reason ?? "failed"}`);
  };

  await call("settings.skipAi", {});
  await toRail(view);
  // Cold start: process launch until the library page is shown and the resource list can be opened.
  const library = await entry("home", "sidebar-entry-library", present("page-library"));
  const listed = await timed("section-all-novel", present(`open-${spec.txt.resourceId}`));
  const coldStartToLibraryMs = library.ok && listed.ok ? Date.now() - launchedAt : -1;
  if (coldStartToLibraryMs < 0) failures.push(`cold start: ${library.reason ?? listed.reason ?? "library not operable"}`);

  // Local UI feedback: the sidebar's entries that must repaint the target (the library's tab, the search box, the notes' records tab), the first time they open it too.
  const uiFeedbackMs: number[] = [];
  const tabs: Array<[string, () => Promise<{ ok: boolean; ms: number; reason?: string }>]> = [
    ["sidebar-entry-library", () => entry("home", "sidebar-entry-library", present("page-library"))],
    ["sidebar-search", searchBox],
    ["sidebar-manage", () => entry("note", "sidebar-manage", present("records-tab"))],
  ];
  for (let round = 0; round < 4; round += 1) {
    for (const [tab, run] of tabs) keep(`ui ${tab}`, await run(), uiFeedbackMs);
  }

  // The rail: the icon of each view pressed in turn (the pointer's click) until the docked sidebar lists what the view holds.
  const railSwitchMs: number[] = [];
  const sidebarListed = (name: string) => `(() => {
    const side = ${PICK}("sidebar");
    if (!side || side.getAttribute("data-view") !== ${JSON.stringify(name)} || !${DRAWN}(side)) return false;
    if (side.querySelector('[data-testid="sidebar-loading"], p.sidebar-empty:not([data-testid])')) return false;
    // What the view holds is drawn: a place with its name, the downloads, or the sentence that says there is nothing (no project to hold whiteboards, a list with no rows).
    return Boolean(side.querySelector('[data-testid^="context-open-"], [data-testid="sidebar-downloads"], [data-testid="sidebar-no-projects"], [data-testid^="sidebar-empty-"]'));
  })()`;
  await railTo(view, "home");
  await ensureSidebar(view);
  const railViews = await js<string[]>(view, `[...document.querySelectorAll('[data-testid="rail-views"] [data-rail-view]')].map((el) => el.getAttribute("data-rail-view"))`);
  if (railViews.length < 5) failures.push(`rail: only ${railViews.length} views in the rail`);
  for (let round = 0; round < 4; round += 1) {
    for (const name of railViews) {
      if (await js<boolean>(view, `${PICK}("sidebar")?.getAttribute("data-view") === ${JSON.stringify(name)}`)) continue;
      keep(`rail ${name}`, await timed(`nav-${name}`, sidebarListed(name), 15_000, 1), railSwitchMs);
    }
  }
  await railTo(view, "home");

  // The search box: names typed into it until the first names are listed (the box is opened from the home's sidebar and closed with Esc each time).
  const searchNamesMs: number[] = [];
  for (let round = 0; round < 4; round += 1) {
    for (const query of ["规模笔记", "规模十兆", "规模三十", "规模"]) {
      const opened = await entry("home", "sidebar-search", present("search-input"));
      if (!opened.ok) { failures.push(`search ${query}: ${opened.reason ?? "the box did not open"}`); continue; }
      const sample = await view.webContents.executeJavaScript(`new Promise((resolve) => {
        const input = ${PICK}("search-input");
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        const started = performance.now();
        set.call(input, ${JSON.stringify(query)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const check = () => {
          const list = ${PICK}("search-results");
          return Boolean(list) && list.getAttribute("aria-busy") !== "true" && list.querySelector('[role="option"]') !== null;
        };
        const frame = () => {
          if (check()) resolve({ ok: true, ms: performance.now() - started });
          else if (performance.now() - started > 15000) resolve({ ok: false, ms: performance.now() - started, reason: "timeout" });
          else setTimeout(frame, 4);
        };
        frame();
      })`) as { ok: boolean; ms: number; reason?: string };
      keep(`search ${query}`, sample, searchNamesMs);
      await pressKey(view, "Escape");
      await waitUntil(view, `!document.querySelector('[data-testid="search-box"]')`, 3000);
    }
  }

  // The settings view: in from the rail's gear until its directory and page are drawn, and out with the back arrow until the workspace under it is drawn again.
  const settingsMs: number[] = [];
  const settingsUp = `${present("settings-nav")} && ${present("page-settings")}`;
  const workspaceBack = `!document.querySelector('[data-testid="settings-area"]') && document.querySelector('[data-testid="workspace-area"]')?.getAttribute("data-suspended") === "false" && ${DRAWN}(document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab-panel"][data-focused="true"]'))`;
  for (let round = 0; round < 6; round += 1) {
    keep(`settings in ${round}`, await timed("nav-settings", settingsUp, 15_000, 1), settingsMs);
    await sleep(300);
    keep(`settings out ${round}`, await timed("nav-back", workspaceBack, 15_000, 1), settingsMs);
    await sleep(300);
  }

  // Indexed large books: reopening restores the stored tail position, which must be the visible text. The home's library entry lands on a library tab, whose shelf is the way in.
  const largeTxtTailMs: number[] = [];
  const largeEpubTailMs: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    for (const [book, into] of [[spec.txt, largeTxtTailMs], [spec.epub, largeEpubTailMs]] as const) {
      await shelf(book.resourceId);
      keep(`tail ${book.resourceId}`, await openTimed(`open-${book.resourceId}`, bodyHas(book.marker), 20_000), into);
    }
  }

  // Save receipt: typing into the note editor until it reports a committed save again.
  const saveState = `${PICK}("note-editor")?.getAttribute("data-save-state")`;
  const saveOnce = async (text: string) => {
    await view.webContents.executeJavaScript("window.__benchSeenUnsaved = false");
    const typed = await view.webContents.executeJavaScript(`(() => {
      const prose = ${PICK}("note-editor")?.querySelector(".ProseMirror");
      if (!prose) return false;
      prose.focus();
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`) as boolean;
    if (!typed) return { ok: false, ms: -1, reason: "editor missing" };
    // The editor must first leave "saved"; a state that never changed is not a receipt.
    return timed(null, `(window.__benchSeenUnsaved = window.__benchSeenUnsaved || ${saveState} !== "saved") && ${saveState} === "saved"`, 10_000);
  };
  // The note is opened from the notes' records tab.
  const openNote = async () => {
    await viaSidebar(view, "note", "sidebar-manage");
    await waitDrawn(view, "records-tab", 8000);
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
    const pick = ${PICK};
    const drawn = ${DRAWN};
    const click = (testId) => {
      const el = pick(testId);
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
      return true;
    };
    const present = (testId) => () => drawn(pick(testId));
    // The sidebar lists the view of the icon last pressed; the press that brings it is not part of what is timed.
    const sidebarOf = async (name) => {
      const has = () => drawn(pick("sidebar")) && pick("sidebar").getAttribute("data-view") === name;
      if (has()) return true;
      if (!drawn(pick("sidebar"))) click("shell-sidebar-toggle");
      if (!click("nav-" + name)) return false;
      return frameUntil(has, 15000);
    };
    const tabs = [["sidebar-entry-library", "home", present("page-library")], ["sidebar-search", "home", present("search-input")], ["sidebar-manage", "note", present("records-tab")]];
    const state = window.__benchParse = { stop: false, ui: [], saves: [] };
    const epoch = () => performance.timeOrigin + performance.now();
    (async () => {
      let round = 0;
      while (!state.stop && round < 200) {
        for (const [tab, view, until] of tabs) {
          const ready = await sidebarOf(view);
          const at = epoch();
          const started = performance.now();
          const ok = ready && click(tab) && await frameUntil(until, 15000);
          state.ui.push({ tab, ok, at, ms: performance.now() - started });
          if (tab === "sidebar-search") {
            pick("search-input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
            await frameUntil(() => !pick("search-box"), 5000);
          }
        }
        await sidebarOf("note");
        click("sidebar-manage");
        await frameUntil(present("records-tab"), 15000);
        await frameUntil(present(${JSON.stringify(`record-open-${spec.noteId}`)}), 15000);
        click(${JSON.stringify(`record-open-${spec.noteId}`)});
        await frameUntil(present("note-editor"), 15000);
        const prose = pick("note-editor")?.querySelector(".ProseMirror");
        const stateOf = () => pick("note-editor")?.getAttribute("data-save-state");
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
    railSwitchMs,
    searchNamesMs,
    settingsMs,
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
      coldStart: "process launch → page-library drawn and the novel shelf offers the 10 MiB TXT",
      uiFeedback: "dispatched sidebar click (the library entry, the search button, the notes' records) → DOM commit of the target: the library tab, the search box' input, the records tab (4 ms polling, window shown)",
      railSwitch: "dispatched click on the icon of a view in the rail → DOM commit of the docked sidebar listing the view (its rows or its empty sentence drawn, no loading line left), every view of the rail in turn, 4 rounds",
      searchNames: "names typed into the search box's input (native setter and input event) → the first name results drawn and the box not busy; the box opened from the home's sidebar and closed with Esc for each sample",
      settingsEnterLeave: "dispatched click on the rail's settings → the settings directory and page drawn; dispatched click on the back arrow → the settings view gone and the focused tab's panel of the workspace drawn again (both directions are samples)",
      largeTail: "card click → the work's page → read click → DOM commit whose reading body contains the tail marker restored from stored progress",
      saveReceipt: "insertText in the note editor (opened from the notes' records tab) → data-save-state leaves and returns to saved",
      duringParse: "same UI and save samples, kept only while a 10 MiB import is still parsing",
    },
  };
}

/**
 * The right pane with a long conversation: 1000 notes in one work's stream, scrolled and typed into. Each figure is the time the page
 * takes to do the work and lay it out (a forced layout read), not paint:
 *  - scroll: set the list's position and read its layout
 *  - input: type into the box (React's commit of the controlled value) and read the layout
 * The list pages in 200 messages at a time; "older" is pressed until all are on screen. These are measurements, not limits.
 */
export async function measurePaneBench(view: BrowserWindow, resourceId: string, notes: number): Promise<Record<string, unknown>> {
  view.showInactive();
  const opened = await openFromShelf(view, "novel", resourceId);
  const bodyShown = opened && await waitForTestId(view, "reading-body", "data-present", null, 10_000);
  // The dock (the conversation bar) follows the focused tab: the work's own conversation.
  const dockShown = opened && await ensureDock(view);
  const paneShown = dockShown && await waitUntil(view, `${DRAWN}(${PICK}("chat-composer")) && ${DRAWN}(${PICK}("chat-log"))`, 15_000);
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
      scroll: "set the message list's scroll position → forced layout read (no paint)",
      input: "set the input's value and dispatch input → React commit → forced layout read",
    },
  };
}
