import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, closeTabs, DRAWN, ensureSidebar, openFromShelf, pressChord, railTo, setField, sleep, tabsOf, viaSidebar, waitFrames, waitUntil } from "./driver.ts";
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

type Call = ReturnType<typeof caller>;
const value = async <T>(call: Call, commandId: string, input: Record<string, unknown>): Promise<T> => {
  const result = await call(commandId, input);
  if (result.status !== "ok") throw new Error(`${commandId}: ${JSON.stringify(result.error ?? null).slice(0, 300)}`);
  return result.value as T;
};

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

/** A conversation of `total` messages on a book: notes spread through it and the rest questions and answers of every length (synthetic, LOOP-07). */
export async function seedLongSession(appService: MangaProductApp, call: Call, total: number): Promise<{ resourceId: string; sessionId: string; noteIds: string[]; runIds: string[] }> {
  const imported = await value<{ resourceId: string }>(call, "library.importDocument", { title: total === 5000 ? "长对话的书" : `长对话的书（${total}）`, format: "txt", bytes: [...new TextEncoder().encode("长对话用的合成正文。".repeat(200))] });
  const sessionId = (await value<{ id: string }>(call, "session.open", { kind: "resource", targetId: imported.resourceId, contextId: null })).id;
  const notes = Math.max(1, Math.round(total / 50));
  const noteIds: string[] = [];
  for (let index = 0; index < notes; index += 1) noteIds.push((await value<{ objectId: string }>(call, "notes.create", { title: `第${index}条笔记`, text: `合成笔记 ${index}：${"想法".repeat(5 + (index % 9) * 6)}`, resourceId: imported.resourceId })).objectId);
  const sqlite = appService.store.sqlite;
  const base = Date.UTC(2026, 0, 1);
  const runs = Math.ceil((total - notes) / 2);
  const step = Math.floor(((total - notes) / 2 + notes) / notes);
  const at = (index: number) => new Date(base + index * 1000).toISOString();
  const runIds: string[] = [];
  const insert = sqlite.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, live_text, created_at, updated_at) VALUES (?, ?, 'succeeded', 'smoke', '{}', ?, ?, ?, ?)");
  const move = sqlite.prepare("UPDATE content_objects SET created_at = ? WHERE id = ?");
  sqlite.transaction(() => {
    let slot = 0;
    let noteAt = 0;
    for (let index = 0; index < runs; index += 1) {
      if (noteAt < noteIds.length && index % step === 0) { move.run(at(slot), noteIds[noteAt]!); noteAt += 1; slot += 1; }
      const id = total === 5000 ? `run_long_${String(index).padStart(5, "0")}` : `run_long${total}_${String(index).padStart(5, "0")}`;
      runIds.push(id);
      insert.run(id, sessionId, `第${index}个问题${"？".repeat(index % 4)}`, `第${index}个回答。${"这一段回答有长有短。".repeat(1 + (index % 13) * 3)}`, at(slot), at(slot));
      slot += 1;
    }
    for (; noteAt < noteIds.length; noteAt += 1, slot += 1) move.run(at(slot), noteIds[noteAt]!);
  })();
  return { resourceId: imported.resourceId, sessionId, noteIds, runIds };
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
    const anchor = await topRow(view);
    const loadedBefore = await loadedCount(view);
    appService.notify("work.updated", { resourceId: seeded.resourceId });
    await sleep(600); // real time: host notification refresh window to verify viewport stays still
    const afterNotice = await topRow(view);
    const loadedAfterNotice = await loadedCount(view);
    detail.notice = { anchor, after: afterNotice, loadedBefore, loadedAfterNotice };
    if (loadedAfterNotice < loadedBefore) problems.push(`a refresh folded the loaded pages back (${loadedBefore} → ${loadedAfterNotice})`);
    if (!anchor || !afterNotice || anchor.id !== afterNotice.id || Math.abs(anchor.offset - afterNotice.offset) > 2) problems.push("a refresh moved the message at the top of the viewport");

    // An old message outside the viewport is deleted and the list refreshed: it is gone and the viewport stays.
    const loadedIds = await js<string[]>(view, `[...${DOCK}.querySelectorAll('[data-testid="chat-rows"] .chat-row > [data-testid^="bubble-"]')].map((el) => el.getAttribute("data-testid"))`);
    const victim = seeded.noteIds.find((id) => !loadedIds.includes(`bubble-note-${id}`) && appService.store.sqlite.prepare("SELECT created_at FROM content_objects WHERE id = ?").pluck().get(id) as string >= new Date(Date.UTC(2026, 0, 1) + (seeded.runIds.length + seeded.noteIds.length - 150) * 1000).toISOString());
    if (victim) {
      await value(call, "notes.delete", { objectId: victim });
      const beforeDelete = await topRow(view);
      const count = await loadedCount(view);
      appService.notify("work.updated", { resourceId: seeded.resourceId });
      const dropped = await waitUntil(view, `${loadedCountExpr()} === ${count - 1}`, 5000);
      await waitUntil(view, `Boolean(${SCROLLER}?.querySelector(".chat-row"))`, 2000);
      await waitFrames(view, 2);
      const afterDelete = await topRow(view);
      detail.deleted = { dropped, before: beforeDelete, after: afterDelete };
      if (!dropped) problems.push("the deleted message is still in the list after the refresh");
      if (!beforeDelete || !afterDelete || beforeDelete.id !== afterDelete.id || Math.abs(beforeDelete.offset - afterDelete.offset) > 2) problems.push("deleting a message outside the viewport moved the viewport");
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
    const stuck: boolean[] = [];
    const gaps: number[] = [];
    for (let i = 0; i < 12; i += 1) { const gap = await bottomGap(view); gaps.push(gap); stuck.push(gap >= 0 && gap <= 8); await sleep(150); } // real time: streaming chunk interval while checking bottom stickiness
    await js(view, `(() => { const s = ${SCROLLER}; s.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true })); s.scrollTop = s.scrollTop - 400; return true; })()`);
    await waitFrames(view, 2);
    const upAt = await js<number>(view, `${SCROLLER}.scrollTop`);
    const held: number[] = [];
    for (let i = 0; i < 8; i += 1) { await sleep(150); held.push(await js<number>(view, `${SCROLLER}.scrollTop`)); } // real time: streaming chunk interval while checking scrolled-up position holds
    const stillRunning = await js<boolean>(view, `Boolean(${DOCK}?.querySelector('[data-testid^="bubble-agent-"][data-status="running"]'))`);
    detail.stream = { live, stuck, gaps, upAt, held, stillRunning };
    if (!live) problems.push("the reply did not start streaming");
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
  const failed = observations.filter((row) => row.status !== "passed").map((row) => row.name);
  if (input.logsDir) fs.writeFileSync(path.join(input.logsDir, "loop-observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
  return { ok: failed.length === 0, failed, observations };
}


