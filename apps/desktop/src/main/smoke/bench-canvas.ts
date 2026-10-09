import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, sleep, waitUntil } from "./driver.ts";
import { caller, js, toRail } from "./common.ts";

/**
 * Real-window timings of the whiteboard and the mind map at the sizes of the stage gate: a board of 500 cards (and edges between many of them)
 * and a map of 1000 topics, seeded through the commands and then used the way a person uses them (a project's tab, a wheel over the canvas,
 * a card dragged, a fold clicked). Each figure runs inside the page from the dispatched input to the DOM commit where the awaited
 * state exists, plus a forced layout read: a hidden smoke window produces no animation frames, so paint is not part of the figure.
 */

export type CanvasSpec = { cards: number; nodes: number; openRuns: number; zoomSamples: number; dragSamples: number; foldRounds: number };

/** The page's own clock. `timed(act, check)` runs `act`, then resolves with the time until `check()` holds, looked at on every DOM mutation and every 8 ms. */
const PRELUDE = `(() => {
  if (window.__bc) return true;
  const q = (id) => document.querySelector('[data-testid="' + id + '"]');
  const press = (el) => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const timed = (act, check, timeoutMs = 15000) => new Promise((resolve) => {
    let done = false;
    let observer = null;
    let timer = 0;
    const started = performance.now();
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      observer && observer.disconnect();
      clearInterval(timer);
      if (ok) void document.body.offsetHeight;
      resolve({ ok, ms: performance.now() - started, reason });
    };
    const test = () => {
      if (done) return;
      let held = false;
      try { held = Boolean(check()); } catch { held = false; }
      if (held) finish(true);
      else if (performance.now() - started > timeoutMs) finish(false, "timeout");
    };
    observer = new MutationObserver(test);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    timer = setInterval(test, 8);
    try { act(); } catch (error) { finish(false, String(error)); return; }
    test();
  });
  window.__bc = { q, press, sleep, timed };
  return true;
})()`;

type Sample = { ok: boolean; ms: number; reason?: string };
const keep = (label: string, sample: Sample, into: number[], failures: string[]): void => {
  if (sample.ok) into.push(sample.ms);
  else failures.push(`${label}: ${sample.reason ?? "failed"}`);
};

const cardAt = (n: number, columns: number) => ({ x: (n % columns) * 280, y: Math.floor(n / columns) * 160 });

export async function measureCanvasBench(appService: MangaProductApp, grant: string, view: BrowserWindow, spec: CanvasSpec): Promise<Record<string, unknown>> {
  const call = caller(appService, grant);
  const failures: string[] = [];
  const ok = async <T>(commandId: string, input: Record<string, unknown>): Promise<T> => {
    const result = await call(commandId, input);
    if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
    return result.value as T;
  };

  // ---- seed: one project with a board of cards and edges, and a map with a tree of topics ----
  const seedStarted = Date.now();
  await ok("settings.skipAi", {});
  const { id: projectId } = await ok<{ id: string }>("project.create", { name: "画布规模" });
  const { board } = await ok<{ board: { id: string } }>("whiteboard.create", { projectId, title: "五百张卡片" });
  const columns = 25;
  const steps: Array<Record<string, unknown>> = [];
  for (let n = 0; n < spec.cards; n += 1) steps.push({ type: "addNode", id: `card${n}`, kind: "card", ...cardAt(n, columns), data: { title: `卡片 ${n}`, text: `第 ${n} 张卡片的正文，写几句话让它有些分量。` } });
  // A third of the cards are joined to the next one in their row.
  for (let n = 0; n + 1 < spec.cards; n += 1) if (n % columns !== columns - 1 && n % 3 === 0) steps.push({ type: "addEdge", id: `edge${n}`, sourceId: `card${n}`, targetId: `card${n + 1}` });
  for (let at = 0; at < steps.length; at += 200) await ok("whiteboard.edit", { boardId: board.id, actions: steps.slice(at, at + 200) });
  // The board is opened zoomed out, with a good part of the cards in view: the heavier case.
  await ok("whiteboard.setViewport", { boardId: board.id, viewport: { x: 20, y: 20, zoom: 0.3 } });
  const { map } = await ok<{ map: { id: string } }>("mindmap.create", { projectId, title: "一千个节点", rootText: "根" });
  const rootId = (await ok<{ nodes: Array<{ id: string; parentId: string | null }> }>("mindmap.get", { mapId: map.id })).nodes.find((node) => node.parentId === null)?.id ?? "";
  // 1 root, 9 branches of 10 topics, each with 10 below: 1 + 9 + 90 + 900 = 1000.
  const tree: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 9; i += 1) {
    tree.push({ type: "addChild", parentId: rootId, id: `b${i}`, text: `分支 ${i}` });
    for (let j = 0; j < 10; j += 1) {
      tree.push({ type: "addChild", parentId: `b${i}`, id: `c${i}_${j}`, text: `主题 ${i}.${j}` });
      for (let k = 0; k < 10; k += 1) tree.push({ type: "addChild", parentId: `c${i}_${j}`, id: `d${i}_${j}_${k}`, text: `要点 ${i}.${j}.${k}` });
    }
  }
  for (let at = 0; at < tree.length; at += 200) await ok("mindmap.edit", { mapId: map.id, actions: tree.slice(at, at + 200) });
  const seedMs = Date.now() - seedStarted;
  const nodeCount = 1 + tree.length;

  // ---- the window: creator mode shows the projects page in the rail ----
  await toRail(view);
  await js(view, PRELUDE);
  // The creator mode is chosen where a person chooses it, on the shell's mode switch; the rail then offers the projects page.
  const switched = await clickTestId(view, "mode-creator") && await waitUntil(view, `document.querySelector('[data-testid="nav-projects"]')`, 8000);
  if (!switched) failures.push("the creator mode was not reachable");
  const reachedProjects = switched && await clickTestId(view, "nav-projects") && await waitUntil(view, `document.querySelector('[data-testid="project-open-${projectId}"]')`, 10_000);
  if (!reachedProjects) failures.push("the projects page was not reachable");

  const openProject = async (tab: string): Promise<boolean> => {
    if (!await clickTestId(view, `project-open-${projectId}`, 8000)) return false;
    return waitUntil(view, `document.querySelector('[data-testid="project-tab-${tab}"]')`, 8000);
  };
  const back = async (): Promise<void> => {
    await clickTestId(view, "project-back");
    await waitUntil(view, `document.querySelector('[data-testid="project-open-${projectId}"]')`, 8000);
  };
  const timedClick = (testId: string, until: string, timeoutMs = 20_000) => js<Sample>(view, `window.__bc.timed(() => window.__bc.press(window.__bc.q(${JSON.stringify(testId)})), () => ${until}, ${timeoutMs})`);

  // ---- the whiteboard: open, then zoom and drag ----
  // How many cards the board shows once it has settled (the cards in view, laid out) is learned from one open that is not timed; the timed opens
  // are over only when that many are on screen, so "open" is the board with its cards, not the first card.
  const shownCards = `[...document.querySelectorAll('[data-testid="whiteboard-board"] .react-flow__node')].filter((node) => node.style.visibility !== "hidden").length`;
  const boardHas = (count: number) => `(() => { const board = document.querySelector('[data-testid="whiteboard-board"]'); return Boolean(board) && board.getAttribute("data-nodes") === "${spec.cards}" && ${shownCards} >= ${count}; })()`;
  let settledCards = 0;
  if (await openProject("whiteboard") && await clickTestId(view, "project-tab-whiteboard")) {
    settledCards = await js<number>(view, `new Promise((resolve) => {
      let last = -1;
      let since = performance.now();
      const tick = () => {
        const now = ${shownCards};
        if (now !== last) { last = now; since = performance.now(); }
        if (last > 0 && performance.now() - since > 600) resolve(last);
        else if (performance.now() - since > 10000) resolve(0);
        else setTimeout(tick, 50);
      };
      tick();
    })`);
    await back();
  }
  if (settledCards < 10) failures.push("whiteboard: no cards were shown by the warm-up open");
  const openMs: number[] = [];
  const shownByRun: number[] = [];
  for (let run = 0; run < spec.openRuns; run += 1) {
    if (!await openProject("whiteboard")) { failures.push("whiteboard: the project did not open"); break; }
    keep(`whiteboard open ${run}`, await timedClick("project-tab-whiteboard", boardHas(settledCards)), openMs, failures);
    await sleep(700);
    shownByRun.push(await js<number>(view, shownCards));
    if (run < spec.openRuns - 1) await back();
  }
  // The last open stays on screen for the interaction samples, once the board has stopped changing (the pane's size is read after the first draw,
  // and the cards outside it are then left out of the page).
  const stableCards = (quietMs: number) => js<number>(view, `new Promise((resolve) => {
    let last = -1;
    let since = performance.now();
    const tick = () => {
      const now = ${shownCards};
      if (now !== last) { last = now; since = performance.now(); }
      if (performance.now() - since > ${quietMs}) resolve(last);
      else setTimeout(tick, 50);
    };
    tick();
  })`);
  const frameOf = () => js<{ transform: string; width: number; height: number }>(view, `(() => {
    const pane = document.querySelector('[data-testid="whiteboard-canvas"] .react-flow__pane');
    const box = pane ? pane.getBoundingClientRect() : { width: 0, height: 0 };
    return { transform: document.querySelector('[data-testid="whiteboard-canvas"] .react-flow__viewport')?.style.transform ?? "", width: Math.round(box.width), height: Math.round(box.height) };
  })()`);

  /** A wheel over the middle of the canvas, `count` times, each timed to the DOM commit of the new viewport. `overview` first zooms out to the smallest scale, so the most cards are in view. */
  const zoomSeries = (overview: boolean) => js<{ samples: Sample[]; missing?: string }>(view, `(async () => {
    const { timed, sleep } = window.__bc;
    const pane = document.querySelector('[data-testid="whiteboard-canvas"] .react-flow__pane');
    const viewport = () => document.querySelector('[data-testid="whiteboard-canvas"] .react-flow__viewport');
    if (!pane || !viewport()) return { samples: [], missing: "canvas" };
    const rect = pane.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const wheel = (deltaY) => pane.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }));
    const scale = () => Number((viewport().style.transform.match(/scale\\(([0-9.]+)\\)/) || [])[1] || 1);
    if (${overview}) {
      for (let guard = 0; guard < 30 && scale() > 0.105; guard += 1) { wheel(100); await sleep(60); }
      await sleep(400);
    }
    const samples = [];
    for (let i = 0; i < ${spec.zoomSamples}; i += 1) {
      const before = viewport().style.transform;
      // Two steps in, two steps out, so the scale stays where the series began.
      const deltaY = Math.floor(i / 2) % 2 === 0 ? -100 : 100;
      samples.push(await timed(() => wheel(deltaY), () => viewport().style.transform !== before, 3000));
      await sleep(30);
    }
    return { samples };
  })()`);

  /** A card in view is taken with the mouse and moved a step at a time; a move is over when the card has been put at its new place on screen. */
  const dragSeries = () => js<{ samples: Sample[]; id?: string; missing?: string }>(view, `(async () => {
    const { timed, sleep } = window.__bc;
    const canvas = document.querySelector('[data-testid="whiteboard-canvas"]');
    const pane = canvas && canvas.querySelector(".react-flow__pane");
    if (!pane) return { samples: [], missing: "canvas" };
    const box = pane.getBoundingClientRect();
    const target = [...canvas.querySelectorAll(".react-flow__node")].find((node) => {
      const r = node.getBoundingClientRect();
      return node.style.visibility !== "hidden" && r.width > 0 && r.left > box.left + 20 && r.right < box.right - 20 && r.top > box.top + 20 && r.bottom < box.bottom - 100;
    });
    if (!target) return { samples: [], missing: "a card in view" };
    const id = target.getAttribute("data-id");
    const node = () => canvas.querySelector('.react-flow__node[data-id="' + id + '"]');
    const r = target.getBoundingClientRect();
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    const mouse = (type, to, at) => to.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "mouseup" ? 0 : 1, clientX: at.x, clientY: at.y, view: window }));
    mouse("mousedown", target, { x, y });
    // The first move only picks the card up (the drag starts once the pointer is past a small distance); it is not a sample.
    x += 12;
    y += 8;
    mouse("mousemove", window, { x, y });
    await sleep(60);
    const samples = [];
    for (let i = 0; i < ${spec.dragSamples}; i += 1) {
      const before = node().style.transform;
      // A few steps to the right and down, then back, so the card stays in view.
      const sign = Math.floor(i / 6) % 2 === 0 ? 1 : -1;
      x += 7 * sign;
      y += 4 * sign;
      samples.push(await timed(() => mouse("mousemove", window, { x, y }), () => node() && node().style.transform !== before, 3000));
      await sleep(16);
    }
    // The card is put down a good way from where it was taken.
    x += 48;
    y += 30;
    mouse("mousemove", window, { x, y });
    await sleep(60);
    mouse("mouseup", window, { x, y });
    return { samples, id };
  })()`);

  const zoomMs: number[] = [];
  const dragMs: number[] = [];
  const series: Array<{ name: string; shownCards: number; zoomMs: number[]; dragMs: number[] }> = [];
  const droppedIds: string[] = [];
  let frame = { transform: "", width: 0, height: 0 };
  for (const overview of [false, true]) {
    const name = overview ? "overview" : "normal";
    const zoomRun = await zoomSeries(overview);
    if (zoomRun.missing) failures.push(`zoom (${name}): ${zoomRun.missing} missing`);
    const zooms: number[] = [];
    zoomRun.samples.forEach((sample, index) => keep(`zoom ${name} ${index}`, sample, zooms, failures));
    const shown = await stableCards(900);
    if (!overview) frame = await frameOf();
    const dragRun = await dragSeries();
    if (dragRun.missing) failures.push(`drag (${name}): ${dragRun.missing} missing`);
    if (dragRun.id) droppedIds.push(dragRun.id);
    const drags: number[] = [];
    dragRun.samples.forEach((sample, index) => keep(`drag ${name} ${index}`, sample, drags, failures));
    zoomMs.push(...zooms);
    dragMs.push(...drags);
    series.push({ name, shownCards: shown, zoomMs: zooms, dragMs: drags });
    await sleep(300);
  }
  // Every drop is saved: each card is somewhere else than where it was taken.
  await sleep(700);
  let dropSaved = droppedIds.length === 2;
  const doc = await ok<{ nodes: Array<{ id: string; x: number; y: number }> }>("whiteboard.get", { boardId: board.id });
  for (const id of droppedIds) {
    const moved = doc.nodes.find((node) => node.id === id);
    const origin = cardAt(Number(id.replace("card", "")), columns);
    if (!moved || (Math.abs(moved.x - origin.x) <= 1 && Math.abs(moved.y - origin.y) <= 1)) dropSaved = false;
  }
  if (!dropSaved) failures.push("drag: a dropped card was not saved at a new place");
  await back();

  // ---- the mind map: open, then fold and unfold ----
  const mapReady = `(() => {
    const board = document.querySelector('[data-testid="mindmap-board"]');
    return Boolean(board) && board.getAttribute("data-nodes") === "${nodeCount}" && Boolean(document.querySelector('[data-testid="mm-node-b0"]'));
  })()`;
  let mapOpenMs = -1;
  if (await openProject("mindmap")) {
    const opened = await timedClick("project-tab-mindmap", mapReady);
    if (opened.ok) mapOpenMs = opened.ms;
    else failures.push(`mind map open: ${opened.reason ?? "failed"}`);
  } else failures.push("mind map: the project did not open");
  await sleep(800);
  const renderedTopics = await js<number>(view, `document.querySelectorAll('[data-testid="mindmap-board"] .react-flow__node').length`);

  const foldMs: number[] = [];
  const unfoldMs: number[] = [];
  const foldRun = await js<{ rows: Array<{ kind: string; level: string; sample: Sample }>; missing?: string }>(view, `(async () => {
    const { q, press, timed, sleep } = window.__bc;
    const gone = (id) => !q("mm-node-" + id);
    const here = (id) => Boolean(q("mm-node-" + id));
    const collapsed = (id) => (q("mm-node-" + id)?.getAttribute("data-collapsed") === "true");
    const rows = [];
    // [id, the first topic below, the last topic below, level]
    const targets = [];
    for (let i = 0; i < 9; i += 1) targets.push(["b" + i, "c" + i + "_0", "d" + i + "_9_9", "branch"]);
    for (let i = 0; i < 4; i += 1) targets.push(["c" + i + "_" + (i + 1), "d" + i + "_" + (i + 1) + "_0", "d" + i + "_" + (i + 1) + "_9", "topic"]);
    targets.push([${JSON.stringify(rootId)}, "b0", "d8_9_9", "root"]);
    if (!q("mm-fold-b0")) return { rows, missing: "fold button" };
    const toggle = async (id, first, last, level) => {
      const down = !collapsed(id);
      const sample = await timed(
        () => press(q("mm-fold-" + id)),
        down ? () => gone(first) && collapsed(id) : () => here(first) && here(last) && !collapsed(id),
        8000,
      );
      rows.push({ kind: down ? "fold" : "unfold", level, sample });
      await sleep(150);
    };
    for (let round = 0; round < ${spec.foldRounds}; round += 1) {
      for (const [id, first, last, level] of targets) {
        await toggle(id, first, last, level);
        await toggle(id, first, last, level);
      }
    }
    return { rows };
  })()`);
  if (foldRun.missing) failures.push(`fold: ${foldRun.missing} missing`);
  for (const row of foldRun.rows) keep(`${row.kind} ${row.level}`, row.sample, row.kind === "fold" ? foldMs : unfoldMs, failures);
  const byLevel: Record<string, number[]> = {};
  for (const row of foldRun.rows) if (row.sample.ok) (byLevel[row.level] ??= []).push(row.sample.ms);

  const complete = reachedProjects && openMs.length === spec.openRuns && zoomMs.length >= spec.zoomSamples * 2 && dragMs.length >= spec.dragSamples * 2 && dropSaved && mapOpenMs >= 0 && foldMs.length + unfoldMs.length >= 60;
  return {
    ok: failures.length === 0 && complete,
    failures,
    process: "electron",
    seedMs,
    scale: { cards: spec.cards, edges: steps.length - spec.cards, nodes: nodeCount },
    whiteboardOpenCards: settledCards,
    whiteboardShownAfterOpen: shownByRun,
    whiteboardViewportZoom: 0.3,
    whiteboardFrame: frame,
    whiteboardSeries: series,
    mindmapRenderedTopics: renderedTopics,
    whiteboardOpenMs: openMs,
    whiteboardZoomMs: zoomMs,
    whiteboardDragMs: dragMs,
    dropSaved,
    mindmapOpenMs: mapOpenMs,
    mindmapFoldMs: [...foldMs, ...unfoldMs],
    mindmapFoldOnlyMs: foldMs,
    mindmapUnfoldOnlyMs: unfoldMs,
    mindmapFoldByLevelMs: byLevel,
    waits: {
      whiteboardOpen: "click on the project's whiteboard tab → DOM commit where the board lists every card and all the cards the first draw shows are laid out (hidden window: no paint)",
      whiteboardZoom: "a wheel event over the canvas → DOM commit of the new viewport transform → forced layout read; one series at the board's own zoom with the cards in view drawn, one zoomed out to the smallest scale with as many cards in view as the pane takes",
      whiteboardDrag: "one mouse move of a held card → DOM commit of the card's new position → forced layout read, in the same two views; each drop is checked as saved afterwards",
      mindmapFold: "click on a topic's fold button → DOM commit where the topics below are gone (or back, all of them) and the topic's state has changed → forced layout read; branches (110 below), topics (10 below) and the root (999 below) are folded and unfolded",
    },
  };
}
