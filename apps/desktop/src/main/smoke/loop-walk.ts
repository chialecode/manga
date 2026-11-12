import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, closeTabs, DRAWN, ensureSidebar, openFromShelf, pressChord, railTo, setField, sleep, tabsOf, viaSidebar, waitFrames, waitUntil } from "./driver.ts";
import { seedLongSession, value, type Call } from "./fixtures.ts";
import { caller, capturePage, ensureDock, js, openSettingsPage, leaveSettings, toRail, type FlowResult } from "./common.ts";

/**
 * The window observations of the dependency and Agent loop stage (计划第 7 节), on a Profile of their own, all synthetic:
 * - `workspace-last-tab-empty`: the last tab of "最近" closed, the page reloaded, a project entered and left: the main area stays empty (LOOP-24 1).
 * - `library-tab-single`: readers opened from the shelf, the library reached from the management entry and the search box: one library tab in a
 *   view, and it is brought in front from another column (LOOP-24 4).
 * - `chat-long-session`: a conversation of 5000 messages in the right pane (LOOP-07).
 * - `agent-media-native`, `agent-media-retain`: whole PDFs and clips for models that take them, and the retention of frozen pictures (LOOP-17, LOOP-05),
 *   run by the packaged application against stand-in models on the loopback address, with the record shown in the window.
 * The screenshots are the ones the plan names: the long list in its middle, the model dialog's limits, an expired picture, the settings' locations.
 */

export type LoopObservation = { name: string; status: "passed" | "failed"; detail: unknown };
const HOST = `document.querySelector('[data-testid="context-host"][data-active="true"]')`;
const DOCK = `document.querySelector('[data-testid="shell-dock"]')`;
/** The scroll element of the right pane's message list (use-stick-to-bottom's own wrapper, the log's first child). */
const SCROLLER = `${DOCK}?.querySelector('[data-testid="chat-log"]')?.firstElementChild`;


/** A stand-in Chat Completions service that writes its answer a piece at a time for `ms`, so a reply grows in the window while it streams. */
async function streamingModel(ms: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const started = Date.now();
      let n = 0;
      const tick = () => {
        if (Date.now() - started >= ms) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: n } })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        n += 1;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `第${n}句回答，内容在一点一点变长。\n\n` } }] })}\n\n`);
        setTimeout(tick, 120);
      };
      tick();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** The message at the top of the right pane's viewport and how far its top is from the viewport's top, by the page's layout. */
const topRow = (view: BrowserWindow) => js<{ id: string; offset: number } | null>(view, `(() => {
  const scroller = ${SCROLLER};
  if (!scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  const rows = [...scroller.querySelectorAll(".chat-row")].map((row) => ({ row, box: row.getBoundingClientRect() })).filter((item) => item.box.bottom > top + 1).sort((a, b) => a.box.top - b.box.top);
  const first = rows[0];
  if (!first) return null;
  return { id: first.row.firstElementChild?.getAttribute("data-testid") ?? "", offset: Math.round(first.box.top - top) };
})()`);
/**
 * The first message whose top is inside the viewport, and where it is. Whether the viewport moved is judged by that same message afterwards
 * (`offsetOf`): the row that is first visible changes by itself when the top one is all but scrolled out and moves a pixel.
 */
const anchorRow = (view: BrowserWindow) => js<{ id: string; offset: number } | null>(view, `(() => {
  const scroller = ${SCROLLER};
  if (!scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  const rows = [...scroller.querySelectorAll(".chat-row")].map((row) => ({ row, box: row.getBoundingClientRect() })).filter((item) => item.box.top >= top - 0.5).sort((a, b) => a.box.top - b.box.top);
  const first = rows[0];
  if (!first) return null;
  return { id: first.row.firstElementChild?.getAttribute("data-testid") ?? "", offset: Math.round(first.box.top - top) };
})()`);
/** Where the message with this test id is now, from the viewport's top; null when it is not in the page. */
const offsetOf = (view: BrowserWindow, id: string) => js<number | null>(view, `(() => {
  const scroller = ${SCROLLER};
  const row = scroller?.querySelector(${JSON.stringify(`[data-testid="${id}"]`)})?.closest(".chat-row");
  return row ? Math.round(row.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : null;
})()`);
const moved = (anchor: { id: string; offset: number } | null, now: number | null) => !anchor || now === null || Math.abs(anchor.offset - now) > 2;
const loadedCount = (view: BrowserWindow) => js<number>(view, `Number(${DOCK}?.querySelector('[data-testid="chat-rows"]')?.getAttribute("data-count") ?? 0)`);
const bottomGap = (view: BrowserWindow) => js<number>(view, `(() => { const s = ${SCROLLER}; return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1; })()`);
const atBottom = (view: BrowserWindow) => js<boolean>(view, `(() => { const s = ${SCROLLER}; return Boolean(s) && s.scrollHeight - s.scrollTop - s.clientHeight <= 8; })()`);

async function longSession(appService: MangaProductApp, call: Call, view: BrowserWindow, evidenceDir: string | undefined, observe: (name: string, ok: boolean, detail: unknown) => boolean): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const model = await streamingModel(5000);
  try {
    const seeded = await seedLongSession(appService, call, 5000);
    await value(call, "connections.upsert", { label: "长对话", protocol: "openai-chat-completions", baseUrl: model.url, modelId: "stream", purpose: "text", credentialHandle: appService.stashSecret("smoke-stream-key"), profile: { contextWindow: 32_768, maxOutput: 2_048 } });
    await view.webContents.reload();
    await toRail(view);
    const started = Date.now();
    const opened = await openFromShelf(view, "novel", seeded.resourceId, 12_000) && await ensureDock(view);
    const drawn = opened && await waitUntil(view, `${DRAWN}(${DOCK}?.querySelector('[data-testid="chat-rows"] .chat-row')) && ${loadedCountExpr()} >= 200`, 15_000);
    detail.firstScreenMs = Date.now() - started;
    await waitUntil(view, `(() => { const s = ${SCROLLER}; return Boolean(s) && s.scrollHeight - s.scrollTop - s.clientHeight <= 8; })()`, 4000);
    await waitFrames(view, 2);
    const nodes = await js<number>(view, `${DOCK}?.querySelectorAll('[data-testid="chat-rows"] .chat-row').length ?? 0`);
    detail.firstScreen = { drawn, nodes, loaded: await loadedCount(view), gap: await bottomGap(view) };
    if (!drawn) problems.push("the newest screen of the long conversation was not drawn");
    if (nodes > 60) problems.push(`${nodes} message rows are in the page, more than 60`);
    if (!(await atBottom(view))) problems.push("the long conversation did not open at its newest message");

    // Up to the top: the next older page comes on its own, and the message at the top of the viewport stays where it was.
    await js(view, `(() => { const s = ${SCROLLER}; s.scrollTop = 600; s.dispatchEvent(new Event("scroll")); return true; })()`);
    await waitFrames(view, 2);
    const before = await topRow(view);
    await js(view, `(() => { const s = ${SCROLLER}; s.scrollTop = 100; return true; })()`);
    const grew = await waitUntil(view, `${loadedCountExpr()} >= 400`, 8000);
    await waitFrames(view, 2);
    const afterOlder = await topRow(view);
    detail.older = { grew, loaded: await loadedCount(view), before, after: afterOlder };
    if (!grew) problems.push("scrolling to the top did not load the older page");

    // A notice from the host refreshes the list: the pages loaded stay, and the viewport does not move.
    const anchor = await anchorRow(view);
    const loadedBefore = await loadedCount(view);
    appService.notify("work.updated", { resourceId: seeded.resourceId });
    await sleep(600); // real time: host notification refresh window to verify viewport stays still
    const afterNotice = anchor ? await offsetOf(view, anchor.id) : null;
    const loadedAfterNotice = await loadedCount(view);
    detail.notice = { anchor, afterOffset: afterNotice, loadedBefore, loadedAfterNotice };
    if (loadedAfterNotice < loadedBefore) problems.push(`a refresh folded the loaded pages back (${loadedBefore} → ${loadedAfterNotice})`);
    if (moved(anchor, afterNotice)) problems.push("a refresh moved the message at the top of the viewport");

    // An old message outside the viewport is deleted and the list refreshed: it is gone and the viewport stays.
    const loadedIds = await js<string[]>(view, `[...${DOCK}.querySelectorAll('[data-testid="chat-rows"] .chat-row > [data-testid^="bubble-"]')].map((el) => el.getAttribute("data-testid"))`);
    const victim = seeded.noteIds.find((id) => !loadedIds.includes(`bubble-note-${id}`) && appService.store.sqlite.prepare("SELECT created_at FROM content_objects WHERE id = ?").pluck().get(id) as string >= new Date(Date.UTC(2026, 0, 1) + (seeded.runIds.length + seeded.noteIds.length - 150) * 1000).toISOString());
    if (victim) {
      await value(call, "notes.delete", { objectId: victim });
      const beforeDelete = await anchorRow(view);
      const count = await loadedCount(view);
      appService.notify("work.updated", { resourceId: seeded.resourceId });
      const dropped = await waitUntil(view, `${loadedCountExpr()} === ${count - 1}`, 5000);
      await waitUntil(view, `Boolean(${SCROLLER}?.querySelector(".chat-row"))`, 2000);
      await waitFrames(view, 2);
      const afterDelete = beforeDelete ? await offsetOf(view, beforeDelete.id) : null;
      detail.deleted = { dropped, before: beforeDelete, afterOffset: afterDelete };
      if (!dropped) problems.push("the deleted message is still in the list after the refresh");
      if (moved(beforeDelete, afterDelete)) problems.push("deleting a message outside the viewport moved the viewport");
    } else problems.push("no loaded note outside the viewport to delete");
    await capturePage(view, evidenceDir, "ui-chat-long-session.png");

    // Back at the bottom, a reply streams: the list stays at the bottom; scrolled up in the middle of it, the list is not pulled back.
    await clickTestId(view, "chat-scroll-bottom", 3000);
    await waitUntil(view, `(() => { const s = ${SCROLLER}; return s.scrollHeight - s.scrollTop - s.clientHeight <= 1; })()`, 5000);
    await waitFrames(view, 2);
    await clickTestId(view, "chat-mode-ask", 3000);
    await setField(view, "agent-composer", "流式回答的时候贴着底部吗？");
    const sent = await clickTestId(view, "agent-send", 3000);
    const live = sent && await waitUntil(view, `${DOCK}?.querySelector('[data-testid^="bubble-agent-"][data-status="running"]')`, 10_000);
    // The new reply's bubble appears below the fold and the list follows it with a smooth scroll;
    // sample stickiness once it has caught up, so a sample taken mid-animation does not count as leaving the bottom.
    const followStart = Date.now();
    const followed = live && await waitUntil(view, `(() => { const s = ${SCROLLER}; const gap = s.scrollHeight - s.scrollTop - s.clientHeight; return gap >= 0 && gap <= 8; })()`, 2000);
    const followMs = Date.now() - followStart;
    const stuck: boolean[] = [];
    const gaps: number[] = [];
    for (let i = 0; i < 12; i += 1) { const gap = await bottomGap(view); gaps.push(gap); stuck.push(gap >= 0 && gap <= 8); await sleep(150); } // real time: streaming chunk interval while checking bottom stickiness
    await js(view, `(() => { const s = ${SCROLLER}; s.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true })); s.scrollTop = s.scrollTop - 400; return true; })()`);
    await waitFrames(view, 2);
    const upAt = await js<number>(view, `${SCROLLER}.scrollTop`);
    const held: number[] = [];
    for (let i = 0; i < 8; i += 1) { await sleep(150); held.push(await js<number>(view, `${SCROLLER}.scrollTop`)); } // real time: streaming chunk interval while checking scrolled-up position holds
    const stillRunning = await js<boolean>(view, `Boolean(${DOCK}?.querySelector('[data-testid^="bubble-agent-"][data-status="running"]'))`);
    detail.stream = { live, followed, followMs, stuck, gaps, upAt, held, stillRunning };
    if (!live) problems.push("the reply did not start streaming");
    if (live && !followed) problems.push("the list did not follow the new reply to the bottom within 2 s");
    if (stuck.some((value) => !value)) problems.push(`the list left the bottom while the reply streamed (${stuck.filter((v) => !v).length} of ${stuck.length} samples)`);
    if (held.some((value) => Math.abs(value - upAt) > 4)) problems.push("scrolled up while the reply streamed, the list was pulled back");
    await waitUntil(view, `!${DOCK}?.querySelector('[data-testid^="bubble-agent-"][data-status="running"]')`, 15_000);

    // Jumping to a message that is not loaded: the list can do it (unit cases), but no entry of the product asks for it yet; not run here.
    detail.jump = { status: "not-run", reason: "no entry of the product asks the list to show a message yet" };
  } catch (error) {
    problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await model.close();
  }
  observe("chat-long-session", problems.length === 0, { ...detail, problems });
}
const loadedCountExpr = () => `Number(${DOCK}?.querySelector('[data-testid="chat-rows"]')?.getAttribute("data-count") ?? 0)`;

async function lastTabEmpty(call: Call, view: BrowserWindow, observe: (name: string, ok: boolean, detail: unknown) => boolean): Promise<void> {
  const problems: string[] = [];
  const tabCount = () => js<number>(view, `${HOST}?.querySelectorAll('[data-testid="tab"]').length ?? -1`);
  try {
    const project = (await value<{ id: string }>(call, "project.create", { name: "空主区项目" })).id;
    await toRail(view);
    await railTo(view, "home");
    await clickTestId(view, "context-open-recent", 6000);
    await waitUntil(view, `${HOST}?.getAttribute("data-context") === ""`, 6000);
    await closeTabs(view, "all");
    const closed = await tabCount();
    for (let i = 0; i < 40; i += 1) {
      const got = (await call("workspace.loadContext", { contextId: null })).value as { state?: { tabs?: unknown[] } } | undefined;
      if ((got?.state?.tabs ?? []).length === 0) break;
      await sleep(50); // real time: poll workspace layout debounce save before reload
    }
    await view.webContents.reload();
    await toRail(view);
    await waitUntil(view, `${HOST}`, 8000);
    await waitFrames(view, 2);
    const afterReload = await tabCount();
    await railTo(view, "home");
    const intoProject = await clickTestId(view, `context-open-${project}`, 6000) && await waitUntil(view, `${HOST}?.getAttribute("data-context") === ${JSON.stringify(project)}`, 6000);
    const back = await clickTestId(view, "context-open-recent", 6000) && await waitUntil(view, `${HOST}?.getAttribute("data-context") === ""`, 6000);
    await waitFrames(view, 2);
    const afterSwitch = await tabCount();
    if (closed !== 0) problems.push(`${closed} tabs left after closing all of them`);
    if (afterReload !== 0) problems.push(`the page came back with ${afterReload} tabs after a reload`);
    if (!intoProject || !back) problems.push("could not go into the project and back");
    if (afterSwitch !== 0) problems.push(`"最近" has ${afterSwitch} tabs after going to the project and back`);
    observe("workspace-last-tab-empty", problems.length === 0, { closed, afterReload, intoProject, back, afterSwitch, problems });
  } catch (error) {
    observe("workspace-last-tab-empty", false, { problems: [`the walk stopped: ${error instanceof Error ? error.message : String(error)}`] });
  }
}

async function chooseMenu(view: BrowserWindow, trigger: string, item: string): Promise<boolean> {
  if (!(await clickTestId(view, trigger, 3000))) return false;
  if (!(await waitUntil(view, `document.querySelector('[data-testid="${item}"]')`, 2500))) return false;
  const clicked = await clickTestId(view, item, 2000);
  await waitUntil(view, `!document.querySelector('[role="menu"]')`, 1500);
  return clicked;
}

async function libraryTabSingle(call: Call, view: BrowserWindow, observe: (name: string, ok: boolean, detail: unknown) => boolean): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const libraryTabs = () => js<number>(view, `${HOST}?.querySelectorAll('[data-testid="view-dock"] [data-testid="tab"][data-kind="library"]').length ?? -1`);
  try {
    const books: string[] = [];
    for (const title of ["单个资源库标签甲", "单个资源库标签乙", "单个资源库标签丙"]) books.push((await value<{ resourceId: string }>(call, "library.importDocument", { title, format: "txt", bytes: [...new TextEncoder().encode(`${title}的合成正文。`.repeat(50))] })).resourceId);
    await view.webContents.reload();
    await toRail(view);
    await railTo(view, "home");
    await closeTabs(view, "all");
    // Three readers from the shelf, each time from the same library tab.
    const counts: number[] = [];
    for (const book of books) {
      if (!(await openFromShelf(view, "novel", book, 12_000, []))) problems.push("a reader did not open from the shelf");
      await railTo(view, "novel");
      await waitFrames(view, 2);
      counts.push(await libraryTabs());
    }
    // The management entry of the view, then the search box choosing a work.
    const manage = await viaSidebar(view, "novel", "sidebar-manage", 6000) && await waitUntil(view, `${HOST}?.querySelector('[data-testid="view-dock"] [data-testid="tab"][data-kind="library"][data-focused="true"]')`, 6000);
    counts.push(await libraryTabs());
    await pressChord(view, "K", ["control"]);
    const box = await waitUntil(view, `document.querySelector('[data-testid="search-box"]')`, 4000);
    if (box) await setField(view, "search-input", "单个资源库标签乙");
    const row = box && await waitUntil(view, `[...document.querySelectorAll('[data-testid="search-results"] [data-testid^="search-result-"]')].find((el) => el.textContent.includes("单个资源库标签乙"))`, 6000);
    if (row) await js(view, `[...document.querySelectorAll('[data-testid="search-results"] [data-testid^="search-result-"]')].find((el) => el.textContent.includes("单个资源库标签乙")).click()`);
    await waitUntil(view, `!document.querySelector('[data-testid="search-box"]')`, 4000);
    await waitFrames(view, 2);
    counts.push(await libraryTabs());
    // In another column: the library tab and a reader side by side, the reader in front; the management entry brings the library tab in front there.
    const split = await chooseMenu(view, "layout-menu", "layout-two") && await waitUntil(view, `${HOST}?.getAttribute("data-columns") === "2"`, 4000);
    const tabs = await tabsOf(view);
    const reader = tabs.find((tab) => tab.kind === "reader");
    if (reader) await js(view, `document.querySelector('[data-testid="tab"][data-tab="${reader.id}"]')?.click()`);
    await waitFrames(view, 2);
    const switched = await viaSidebar(view, "novel", "sidebar-manage", 6000) && await waitUntil(view, `${HOST}?.querySelector('[data-testid="view-dock"] [data-testid="tab"][data-kind="library"][data-focused="true"]')`, 6000);
    counts.push(await libraryTabs());
    await chooseMenu(view, "layout-menu", "layout-single");
    // The home holds every tab of the context: there too, one library tab.
    await railTo(view, "home");
    await waitFrames(view, 2);
    const home = await libraryTabs();
    Object.assign(detail, { counts, manage, box, row, split, switched, home });
    if (counts.some((count) => count !== 1)) problems.push(`the novel view had ${JSON.stringify(counts)} library tabs over the steps, not one`);
    if (!manage) problems.push("the management entry did not bring the library tab in front");
    if (!box || !row) problems.push("the search box did not offer the work");
    if (!split || !switched) problems.push("the library tab in the other column was not brought in front");
    if (home !== 1) problems.push(`the home has ${home} library tabs`);
  } catch (error) {
    problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
  observe("library-tab-single", problems.length === 0, { ...detail, problems });
}

/** The model dialog with PDF and video ticked shows their limits (screenshot), and the settings' locations page shows its three groups. */
async function screens(view: BrowserWindow, evidenceDir: string | undefined, problems: string[]): Promise<void> {
  if (await openSettingsPage(view, "models")) {
    const opened = await clickTestId(view, "models-add", 4000) || await js<boolean>(view, `(() => { const b = document.querySelector('[data-testid^="model-edit-"]'); if (!b) return false; b.click(); return true; })()`);
    if (opened) {
      for (const id of ["profile-input-pdf", "profile-input-video"]) await js(view, `(() => { const box = document.querySelector('[data-testid="${id}"]'); if (box && !box.checked) box.click(); return true; })()`);
      const limits = await waitUntil(view, `document.querySelector('[data-testid="profile-file-limit"]') && document.querySelector('[data-testid="profile-video-limit"]') && document.querySelector('[data-testid="profile-video-seconds"]')`, 4000);
      await js(view, `(() => {
        const group = document.querySelector('[data-testid="profile-fields"]');
        group?.scrollIntoView({ block: "start" });
        document.querySelector('[data-testid="profile-video-seconds"]')?.scrollIntoView({ block: "nearest" });
        return true;
      })()`);
      const limitsInView = await waitUntil(view, `(() => {
        const body = document.querySelector('[data-testid="connection-dialog"] .modal-body');
        if (!body) return false;
        const b = body.getBoundingClientRect();
        return ["profile-file-limit", "profile-video-limit", "profile-video-seconds"].every((id) => {
          const el = document.querySelector('[data-testid="' + id + '"]');
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
        });
      })()`, 2000);
      await waitFrames(view, 2);
      if (!limits || !limitsInView) problems.push("the model dialog did not show the PDF and video limits");
      await capturePage(view, evidenceDir, "ui-model-limits.png");
      await pressChord(view, "Escape", []);
    } else problems.push("the model dialog did not open");
  } else problems.push("the models page did not open");
  if (await openSettingsPage(view, "general")) {
    const groups = await waitUntil(view, `["app", "files", "downloads"].every((g) => document.querySelector('[data-testid="location-group-' + g + '"]'))`, 4000);
    if (!groups) problems.push("the locations are not shown in three groups");
    // The screenshot of this page is taken by the locations phase, on a root whose path names no account (here the Profile is in the temporary folder).
  } else problems.push("the general settings page did not open");
  await leaveSettings(view);
}

/**
 * `recent-remove` (计划 4.10, 第 7 节, AT-173): right-click "从最近移除" in "最近"'s comic list hides the item with an undoable toast,
 * undo restores it, removing again and opening from the library brings it back at "最近"'s own position, the shelf card shows the
 * furthest progress across contexts (and "已读" when completed in a project only), and the work homepage lists per-context positions.
 */
async function recentRemove(
  appService: MangaProductApp,
  call: Call,
  view: BrowserWindow,
  evidenceDir: string | undefined,
  observe: (name: string, ok: boolean, detail: unknown) => boolean,
): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const pixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  try {
    const root = fs.mkdtempSync(path.join(appService.layout.partitions.logs, "manga-package-recent-remove-"));
    const makeComicDir = (folder: string, pages: number) => {
      const dir = path.join(root, folder);
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 1; i <= pages; i += 1) fs.writeFileSync(path.join(dir, `p${String(i).padStart(2, "0")}.png`), pixelPng);
      return dir;
    };
    const dirA = makeComicDir("合成远进度漫画", 10);
    const dirDone = makeComicDir("合成项目已读漫画", 4);
    await value(call, "library.paths.add", { pathHandle: appService.registerPath("directory", root), mediaKind: "comic", autoScan: false });
    const comicA = await value<{ workId: string; resourceId: string; revisionId: string }>(call, "library.importDocument", {
      title: "合成远进度漫画",
      kind: "comic",
      pathHandle: appService.registerPath("directory", dirA),
    });
    const comicDone = await value<{ workId: string; resourceId: string; revisionId: string }>(call, "library.importDocument", {
      title: "合成项目已读漫画",
      kind: "comic",
      pathHandle: appService.registerPath("directory", dirDone),
    });
    const projectA = (await value<{ id: string }>(call, "project.create", { name: "项目 A" })).id;
    const pagesA = (await value<{ pages: Array<{ id: string }> }>(call, "comic.pages", { resourceId: comicA.resourceId, revisionId: comicA.revisionId })).pages;
    const pagesDone = (await value<{ pages: Array<{ id: string }> }>(call, "comic.pages", { resourceId: comicDone.resourceId, revisionId: comicDone.revisionId })).pages;

    // comicA: 80% (page 8/10) in "最近", then 10% (page 1/10, newer timestamp) in "项目 A".
    await value(call, "progress.setPage", { contextId: null, resourceId: comicA.resourceId, resourceRevisionId: comicA.revisionId, pageId: pagesA[7]!.id, consumed: true });
    await value(call, "progress.setPage", { contextId: projectA, resourceId: comicA.resourceId, resourceRevisionId: comicA.revisionId, pageId: pagesA[0]!.id, consumed: true });
    appService.store.sqlite.prepare("UPDATE progress SET last_interaction_at = ? WHERE context_id = '' AND resource_id = ?").run("2026-10-01T00:00:00.000Z", comicA.resourceId);
    appService.store.sqlite.prepare("UPDATE progress SET last_interaction_at = ? WHERE context_id = ? AND resource_id = ?").run("2026-10-02T00:00:00.000Z", projectA, comicA.resourceId);

    // comicDone: completed ONLY in "项目 A".
    await value(call, "progress.setPage", { contextId: projectA, resourceId: comicDone.resourceId, resourceRevisionId: comicDone.revisionId, pageId: pagesDone[3]!.id, consumed: true });

    await leaveSettings(view);
    await view.webContents.reload();
    await toRail(view);
    await ensureSidebar(view);
    await railTo(view, "comic");
    // Ensure we are in "最近" and its group is visible.
    await clickTestId(view, "context-open-recent", 4000);
    await waitUntil(view, `document.querySelector('[data-testid="context-recent"][data-current="true"]')`, 4000);
    await closeTabs(view, "all");

    const recentItemSel = `[data-testid="context-recent"] [data-testid="sidebar-item-resource-${comicA.resourceId}"]`;
    const initiallyShown = await waitUntil(view, `${DRAWN}(document.querySelector(${JSON.stringify(recentItemSel)}))`, 6000);
    if (!initiallyShown) problems.push("comicA did not appear in 最近 comic sidebar before removal");

    const openContextMenuOnItem = () => js<boolean>(view, `(() => {
      const el = document.querySelector(${JSON.stringify(recentItemSel)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 10) }));
      return true;
    })()`);

    // 1. Right-click -> "从最近移除": disappears + undoable toast.
    const menuOpened1 = await openContextMenuOnItem() && await waitUntil(view, `document.querySelector('[data-testid="sidebar-menu-remove-recent"]')`, 4000);
    const clickedRemove1 = menuOpened1 && await clickTestId(view, "sidebar-menu-remove-recent", 4000);
    const goneAfterRemove1 = clickedRemove1 && await waitUntil(view, `!document.querySelector(${JSON.stringify(recentItemSel)})`, 6000);
    const toastShown = await waitUntil(view, `(document.querySelector('[data-testid="toast-notice"]')?.textContent ?? "").includes("已从最近移除《合成远进度漫画》") && Boolean(document.querySelector('[data-testid="toast-notice-action"]'))`, 4000);
    const toastText = await js<string>(view, `document.querySelector('[data-testid="toast-notice"]')?.textContent ?? ""`);
    if (!goneAfterRemove1) problems.push("comicA did not disappear from 最近 after right-click remove");
    if (!toastShown) problems.push(`undoable removal toast did not appear (${toastText})`);

    // 2. Click "撤销": item reappears in "最近".
    const clickedUndo = toastShown && await clickTestId(view, "toast-notice-action", 4000);
    const restoredAfterUndo = clickedUndo && await waitUntil(view, `${DRAWN}(document.querySelector(${JSON.stringify(recentItemSel)}))`, 6000);
    if (!restoredAfterUndo) problems.push("comicA did not return to 最近 after clicking 撤销");

    // 3. Remove again -> disappears.
    const menuOpened2 = restoredAfterUndo && await openContextMenuOnItem() && await waitUntil(view, `document.querySelector('[data-testid="sidebar-menu-remove-recent"]')`, 4000);
    const clickedRemove2 = menuOpened2 && await clickTestId(view, "sidebar-menu-remove-recent", 4000);
    const goneAfterRemove2 = clickedRemove2 && await waitUntil(view, `!document.querySelector(${JSON.stringify(recentItemSel)})`, 6000);
    if (!goneAfterRemove2) problems.push("comicA did not disappear on second removal");
    if (await clickTestId(view, "toast-notice-close", 1500)) {
      await waitUntil(view, `!document.querySelector('[data-testid="toast-notice"]')`, 2000);
    }

    // 4. Open comic shelf: card shows furthest progress (80%), and project-completed comic shows "已读" + "来自“项目 A”".
    const shelfOpened = await viaSidebar(view, "comic", "sidebar-manage", 6000)
      && await waitUntil(view, `${HOST}?.querySelector('[data-testid="shelf-comic"]')`, 6000)
      && await waitUntil(view, `${HOST}?.querySelector('[data-testid="work-progress-${comicA.workId}"]')`, 6000);
    const cardAText = await js<string>(view, `${HOST}?.querySelector('[data-testid="work-progress-${comicA.workId}"]')?.textContent ?? ""`);
    const cardDoneText = await js<string>(view, `${HOST}?.querySelector('[data-testid="work-progress-${comicDone.workId}"]')?.textContent ?? ""`);
    if (!shelfOpened || !cardAText.includes("已读 80%")) problems.push(`library card for comicA did not show furthest progress 80% (${cardAText})`);
    if (!cardDoneText.includes("已读") || cardDoneText.includes("%") || !cardDoneText.includes("项目 A")) {
      problems.push(`library card for project-completed comicDone did not show 已读 from 项目 A (${cardDoneText})`);
    }

    // 5. Open comicA's Work Homepage: shows 80% from "最近" + per-context positions, and capture screenshot without local paths.
    const workOpened = await clickTestId(view, `open-${comicA.resourceId}`, 6000)
      && await waitUntil(view, `${HOST}?.querySelector('[data-testid="work-context-positions"]')`, 6000);
    await waitFrames(view, 2);
    const workSummaryText = await js<string>(view, `${HOST}?.querySelector('[data-testid="work-progress-summary"]')?.textContent ?? ""`);
    const contextPositionsText = await js<string>(view, `${HOST}?.querySelector('[data-testid="work-context-positions"]')?.textContent ?? ""`);
    if (!workOpened || !workSummaryText.includes("已读 80%") || !workSummaryText.includes("来自“最近”")) {
      problems.push(`work homepage summary did not show 80% from 最近 (${workSummaryText})`);
    }
    if (!contextPositionsText.includes("最近：第 8 页") || !contextPositionsText.includes("项目 A：第 1 页")) {
      problems.push(`work homepage did not list per-context positions (${contextPositionsText})`);
    }
    await capturePage(view, evidenceDir, "ui-work-context-positions.png", "work-context-positions");

    // 6. Click "继续阅读" on Work Homepage while in "最近": opens at "最近"'s own page 8 AND reappears in "最近" comic list.
    const readerOpened = await clickTestId(view, "work-read", 6000)
      && await waitUntil(view, `${HOST}?.querySelector('.comic-page[data-state="ready"]')`, 15_000);
    await waitFrames(view, 2);
    const readerPage = await js<number>(view, String.raw`Number((${HOST}?.querySelector('[data-testid="comic-position"]')?.textContent ?? "").match(/\d+/)?.[0] ?? 0)`);
    await ensureSidebar(view);
    await railTo(view, "comic");
    const reappearedInRecent = await waitUntil(view, `${DRAWN}(document.querySelector(${JSON.stringify(recentItemSel)}))`, 6000);
    if (!readerOpened || readerPage !== 8) problems.push(`reopening in 最近 did not resume at page 8 (got ${readerPage})`);
    if (!reappearedInRecent) problems.push("comicA did not reappear in 最近 after reopening from the library");

    Object.assign(detail, {
      initiallyShown,
      goneAfterRemove1,
      toastText,
      restoredAfterUndo,
      goneAfterRemove2,
      cardAText,
      cardDoneText,
      workSummaryText,
      contextPositionsText,
      readerPage,
      reappearedInRecent,
      screenshot: "ui-work-context-positions.png",
    });
  } catch (error) {
    problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
  observe("recent-remove", problems.length === 0, { ...detail, problems });
}

export async function runLoopSmoke(input: { appService: MangaProductApp; grant: string; view: BrowserWindow; evidenceDir: string | undefined; logsDir: string; samples: string | undefined }): Promise<FlowResult & { observations: LoopObservation[] }> {
  const { appService, grant, view, evidenceDir } = input;
  const call = caller(appService, grant);
  const observations: LoopObservation[] = [];
  const observe = (name: string, ok: boolean, detail: unknown) => {
    observations.push({ name, status: ok ? "passed" : "failed", detail });
    console.error(`loop ${name}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 4000)}`);
    return ok;
  };
  view.showInactive();
  await call("settings.skipAi", {});
  await toRail(view);
  await ensureSidebar(view);
  await lastTabEmpty(call, view, observe);
  await libraryTabSingle(call, view, observe);
  await longSession(appService, call, view, evidenceDir, observe);
  const { runMediaObservations } = await import("./loop-media.ts");
  try {
    await runMediaObservations({ appService, call, view, evidenceDir, samples: input.samples, observe });
  } catch (error) {
    observe("loop-media", false, { problems: [`the media walk stopped: ${error instanceof Error ? error.message : String(error)}`] });
  }
  const { runProposalObservations } = await import("./proposals-walk.ts");
  try {
    await runProposalObservations({ appService, call, view, evidenceDir, logsDir: input.logsDir, samples: input.samples, observe });
  } catch (error) {
    observe("loop-proposals", false, { problems: [`the proposals walk stopped: ${error instanceof Error ? error.message : String(error)}`] });
  }
  const screenProblems: string[] = [];
  await screens(view, evidenceDir, screenProblems);
  if (screenProblems.length) observe("loop-screens", false, { problems: screenProblems });
  await recentRemove(appService, call, view, evidenceDir, observe);
  const failed = observations.filter((row) => row.status !== "passed").map((row) => row.name);
  if (input.logsDir) fs.writeFileSync(path.join(input.logsDir, "loop-observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
  return { ok: failed.length === 0, failed, observations };
}


