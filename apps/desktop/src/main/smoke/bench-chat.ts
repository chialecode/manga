import { app, type BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, DRAWN, openFromShelf, showTab, sleep, waitUntil } from "./driver.ts";
import { caller, ensureDock, js, toRail } from "./common.ts";
import { seedLongSession } from "./loop-walk.ts";

/**
 * The right pane with a conversation of 5000 messages in the real window (LOOP-07, 计划第 7 节), on a Profile of its own, synthetic:
 * - open: the work's tab pressed (from the other book's tab, whose conversation is in the dock), to the newest rows of its 5000 painted: the dock
 *   changes session, reads the stream and draws the list;
 * - input: a key into the composer, to the forced layout after React's commit;
 * - late frames: the list scrolled upwards a step each frame for 3 s (loading older pages on the way), frames later than 1.5 × the usual interval;
 * - older page: the list put at its top, to the next page's rows painted with the viewport held.
 * Memory with 1000 and with 5000 messages open is recorded, not gated.
 */
const DOCK = `document.querySelector('[data-testid="shell-dock"]')`;
const SCROLLER = `${DOCK}?.querySelector('[data-testid="chat-log"]')?.firstElementChild`;
const COUNT = `Number(${DOCK}?.querySelector('[data-testid="chat-rows"]')?.getAttribute("data-count") ?? 0)`;

function rendererMemoryMiB(): number {
  const metrics = app.getAppMetrics();
  return Math.round(metrics.reduce((sum, row) => sum + (row.memory?.workingSetSize ?? 0), 0) / 1024);
}

export async function measureChatBench(appService: MangaProductApp, grant: string, view: BrowserWindow): Promise<Record<string, unknown>> {
  const call = caller(appService, grant);
  view.showInactive();
  await call("settings.skipAi", {});
  const failures: string[] = [];
  const small = await seedLongSession(appService, call, 1000);
  const large = await seedLongSession(appService, call, 5000);
  await view.webContents.reload();
  await toRail(view);
  const memory: Record<string, number> = {};
  for (const [label, seeded] of [["1000", small], ["5000", large]] as const) {
    const opened = await openFromShelf(view, "novel", seeded.resourceId, 12_000, ["library"]);
    // The dock shows the conversation in its ask mode (its note mode lists only the book's notes), as the person has it when asking.
    const docked = opened && await ensureDock(view) && (await clickTestId(view, "chat-mode-ask", 4000), true);
    const last = seeded.runIds.at(-1);
    const drawn = docked && await waitUntil(view, `${DRAWN}(${DOCK}?.querySelector('[data-testid="bubble-user-${last}:user"]'))`, 15_000);
    if (!drawn) {
      const lists = `[...document.querySelectorAll('[data-testid="chat-log"]')].map((log) => { const s = log.firstElementChild; return { inDock: Boolean(log.closest('[data-testid="shell-dock"]')), top: Math.round(s.scrollTop), height: s.scrollHeight, client: s.clientHeight, count: log.querySelector('[data-testid="chat-rows"]')?.getAttribute("data-count"), button: Boolean(log.querySelector('[data-testid="chat-scroll-bottom"]')) }; })`;
      const listsNow = await js<unknown>(view, lists);
      await sleep(3000);
      const listsLater = await js<unknown>(view, lists);
      failures.push(`lists ${JSON.stringify({ listsNow, listsLater })}`);
      const seen = await js<unknown>(view, `({ page: [...document.querySelectorAll('[data-testid^="page-"]')].map((el) => el.getAttribute("data-testid")).slice(0, 6), dock: Boolean(${DOCK}), rows: Number(${DOCK}?.querySelector('[data-testid="chat-rows"]')?.getAttribute("data-count") ?? -1), bubbles: [...(${DOCK}?.querySelectorAll('[data-testid^="bubble-user-"]') ?? [])].slice(-2).map((el) => el.getAttribute("data-testid")) })`);
      failures.push(`the conversation of ${label} did not open (${opened ? (docked ? "the newest row not drawn" : "no dock") : "the reader did not open from the shelf"}: ${JSON.stringify(seen)})`);
    }
    await sleep(1500);
    memory[label] = rendererMemoryMiB();
  }

  // Open: from the other book's tab to the 5000's, pressed with the mouse; timed in the page from the press to the newest row painted.
  const openMs: number[] = [];
  const openRaw: number[] = [];
  const geometry = `[...document.querySelectorAll('[data-testid="chat-log"]')].map((log) => { const s = log.firstElementChild; return { inDock: Boolean(log.closest('[data-testid="shell-dock"]')), top: Math.round(s.scrollTop), height: s.scrollHeight, client: s.clientHeight, count: log.querySelector('[data-testid="chat-rows"]')?.getAttribute("data-count"), shown: [...log.querySelectorAll('[data-testid^="bubble-"]')].slice(0, 3).map((el) => el.getAttribute("data-testid")), older: log.querySelector('[data-testid="chat-older"]') ? (log.querySelector('[data-testid="chat-older"]').disabled ? "loading" : "ready") : "none", header: (log.closest('[data-testid="shell-dock"]')?.querySelector("header, [data-testid=dock-title], h2")?.textContent ?? "").slice(0, 60), last: [...log.querySelectorAll('[data-testid^="bubble-user-"]')].at(-1)?.getAttribute("data-testid") }; })`;
  const newest = `bubble-user-${large.runIds.at(-1)}:user`;
  for (let index = 0; index < 12; index += 1) {
    if (!(await showTab(view, { kind: "reader", title: "长对话的书（1000）" })) || !(await waitUntil(view, `${DRAWN}(${DOCK}?.querySelector('[data-testid="bubble-user-${small.runIds.at(-1)}:user"]'))`, 8000))) { failures.push("the other book's conversation did not come back"); break; }
    await sleep(400);
    await js(view, `(() => { window.__chatOpen = null; document.addEventListener("mousedown", () => { window.__chatOpen = performance.now(); }, { capture: true, once: true }); return true; })()`);
    const pending = js<number>(view, `new Promise((resolve) => {
      const begun = performance.now();
      const tick = () => {
        const row = ${DOCK}?.querySelector('[data-testid="${newest}"]');
        if (window.__chatOpen !== null && row && row.getBoundingClientRect().height > 0) requestAnimationFrame(() => resolve(performance.now() - window.__chatOpen));
        else if (performance.now() - begun > 10000) resolve(-1);
        else requestAnimationFrame(tick);
      };
      tick();
    })`);
    const tabs = await view.webContents.executeJavaScript(`(() => { const host = document.querySelector('[data-testid="context-host"][data-active="true"]'); const chip = host && [...host.querySelectorAll('[data-testid="tab"][data-kind="reader"]')].find((item) => (item.querySelector(".tab-title")?.textContent ?? "").startsWith("长对话的书") && !(item.querySelector(".tab-title")?.textContent ?? "").startsWith("长对话的书（")); if (!chip) return null; const box = chip.getBoundingClientRect(); return { x: Math.round(box.left + Math.min(box.width / 2, 40)), y: Math.round(box.top + box.height / 2) }; })()`) as { x: number; y: number } | null;
    if (!tabs) { failures.push("the 5000's tab is missing"); break; }
    view.webContents.sendInputEvent({ type: "mouseMove", x: tabs.x, y: tabs.y });
    view.webContents.sendInputEvent({ type: "mouseDown", x: tabs.x, y: tabs.y, button: "left", clickCount: 1 });
    view.webContents.sendInputEvent({ type: "mouseUp", x: tabs.x, y: tabs.y, button: "left", clickCount: 1 });
    const ms = await pending;
    openRaw.push(ms < 0 ? ms : Math.round(ms * 10) / 10);
    if (ms >= 0) openMs.push(Math.round(ms * 10) / 10);
    await sleep(300);
  }
  await waitUntil(view, `${DRAWN}(${DOCK}?.querySelector('[data-testid="${newest}"]'))`, 5000);

  // Input: the composer under a list of 5000.
  const inputMs = await js<number[]>(view, `new Promise((resolve) => {
    const area = ${DOCK}.querySelector('[data-testid="agent-composer"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    const out = [];
    let step = 0;
    const next = () => {
      if (step >= 60) { set.call(area, ""); area.dispatchEvent(new Event("input", { bubbles: true })); resolve(out); return; }
      const started = performance.now();
      set.call(area, "长对话下的输入延迟样本 " + step);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      void area.offsetHeight;
      out.push(Math.round((performance.now() - started) * 10) / 10);
      step += 1;
      setTimeout(next, 20);
    };
    next();
  })`);

  // Older page: at the top, the next page comes and is painted.
  const olderMs: number[] = [];
  const olderRaw: number[] = [];
  if (openMs.length < 10) failures.push(`open samples ${JSON.stringify(openRaw)}; lists ${JSON.stringify(await js<unknown>(view, geometry))}`);
  for (let index = 0; index < 12; index += 1) {
    const ms = await js<number>(view, `new Promise((resolve) => {
      const scroller = ${SCROLLER};
      const before = ${COUNT};
      if (before >= 5000) { resolve(-2); return; }
      const started = performance.now();
      // Up with the wheel, as a person scrolls: that is what lets go of the bottom (use-stick-to-bottom), then to the top.
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
      const tick = () => {
        if (${COUNT} > before) requestAnimationFrame(() => resolve(performance.now() - started));
        else if (performance.now() - started > 8000) { window.__olderMiss = { before, after: ${COUNT}, top: Math.round(scroller.scrollTop), isScroller: scroller === ${SCROLLER} }; resolve(-1); }
        else requestAnimationFrame(tick);
      };
      tick();
    })`);
    if (ms === -1 && index === 0) failures.push(`first older miss ${JSON.stringify(await js<unknown>(view, "window.__olderMiss"))}`);
    olderRaw.push(ms < 0 ? ms : Math.round(ms * 10) / 10);
    if (ms === -2) break;
    if (ms >= 0) olderMs.push(Math.round(ms * 10) / 10);
    await sleep(500);
  }

  // Late frames: back at the bottom, then scrolled upwards a step each frame; five runs.
  const late: number[] = [];
  let usualIntervalMs = 0;
  for (let run = 0; run < 5; run += 1) {
    await clickTestId(view, "chat-scroll-bottom", 2000);
    await sleep(600);
    const result = await js<{ usual: number; pct: number; frames: number }>(view, `new Promise((resolve) => {
      const scroller = ${SCROLLER};
      const idle = [];
      let last = performance.now();
      const baseline = (now) => {
        idle.push(now - last); last = now;
        if (idle.length < 40) { requestAnimationFrame(baseline); return; }
        const sorted = idle.slice(5).sort((a, b) => a - b);
        const usual = sorted[Math.floor(sorted.length / 2)];
        const intervals = [];
        const started = performance.now();
        last = started;
        const frame = (now) => {
          intervals.push(now - last); last = now;
          scroller.scrollTop = Math.max(0, scroller.scrollTop - 60);
          if (now - started < 3000) requestAnimationFrame(frame);
          else resolve({ usual, pct: Math.round(intervals.filter((value) => value > usual * 1.5).length / intervals.length * 1000) / 10, frames: intervals.length });
        };
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(baseline);
    })`);
    usualIntervalMs = result.usual;
    late.push(result.pct);
  }
  if (olderMs.length < 8) failures.push(`older samples ${JSON.stringify(olderRaw)}; lists ${JSON.stringify(await js<unknown>(view, geometry))}`);
  const ok = failures.length === 0 && openMs.length >= 10 && inputMs.length >= 60 && olderMs.length >= 8 && late.length === 5;
  return {
    ok, failures, messages: 5000, openMs, inputMs, olderMs, latePct: late, usualIntervalMs: Math.round(usualIntervalMs * 100) / 100, memoryMiB: memory,
    waits: {
      open: "press on the dock's switch → the list mounted, its newest page read and its rows painted (next frame)",
      input: "set the composer's value and dispatch input → React commit → forced layout read",
      late: "rAF intervals while the list scrolls up 60 px a frame for 3 s, over 1.5 × the median idle interval",
      older: "wheel up and list put at its top → the next older page's rows in the list and painted (next frame)",
      memory: "working set of all the application's processes with the conversation open (MiB)",
    },
  };
}
