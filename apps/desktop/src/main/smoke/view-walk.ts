import { ipcMain, type BrowserWindow } from "electron";
import { createId } from "@manga/contracts";
import { DRAWN, clickTestId, closeTabs, ensureSidebar, openLibrary, pressChord, pressKey, railTo, sleep, waitDrawn, waitFrames, waitUntil, type RailName } from "./driver.ts";
import { js, leaveSettings, toRail, type caller } from "./common.ts";
import { mouse, pixelsOf, near3, hex, parseRgb, type Box } from "./input.ts";
import type { Observe } from "./reader-controls-walk.ts";
import { chooseMenu } from "./workspace-walk.ts";

/**
 * The main area that follows the view (A-107, AT-128, AT-130, AT-131), in the real window: each view of a context has its own layout and the dock follows the
 * tab in front of it; a whiteboard's cards stay out of sight under the settings, behind another tab and in a view that is not on screen; a closed tab comes
 * back where it was; Delete and Backspace on a tab do not close it; and a change of the layout made just before the window closes is saved before it goes.
 */
export const VIEW_OBSERVATIONS = ["view-main-linkage", "hidden-layers", "tab-reopen-place", "quit-saves-layout"] as const;

type Call = ReturnType<typeof caller>;
export type ViewEnv = {
  view: BrowserWindow;
  call: Call;
  observe: Observe;
  shot: (name: string) => Promise<void>;
  resize: (size: "wide" | "narrow" | "short") => Promise<void>;
  projectId: string;
  boardId: string;
  videoId: string | null;
  titles: { video: string };
};

const HOST = `document.querySelector('[data-testid="context-host"][data-active="true"]')`;
const mainView = (view: BrowserWindow) => js<string | null>(view, `(() => { const host = ${HOST}; return (host?.querySelector('[data-testid="view-dock"]') ?? host?.querySelector('[data-testid="view-empty"]'))?.getAttribute("data-view") ?? null; })()`);
const focusedKind = (view: BrowserWindow) => js<string | null>(view, `${HOST}?.querySelector('[data-testid="view-dock"] [data-testid="tab"][data-focused="true"]')?.getAttribute("data-kind") ?? null`);
const dockTitle = (view: BrowserWindow) => js<string>(view, `document.querySelector('[data-testid="shell-dock"] [data-testid="conversation-title"]')?.textContent ?? ""`);
const waitContextKey = (view: BrowserWindow, key: string) => waitUntil(view, `${HOST}?.getAttribute("data-context") === ${JSON.stringify(key)}`, 8000);
/** The chips of the layout on screen, column by column (a strip is a column). */
const columnsOf = (view: BrowserWindow) => js<string[][]>(view, `(() => {
  const dock = ${HOST}?.querySelector('[data-testid="view-dock"]');
  if (!dock) return [];
  const groups = [...dock.querySelectorAll(".dv-groupview")].filter((g) => g.getClientRects().length > 0);
  groups.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left || a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return groups.map((g) => [...g.querySelectorAll('[data-testid="tab"]')].map((c) => c.getAttribute("data-tab") ?? ""));
})()`);

export async function runViewWalk(env: ViewEnv): Promise<void> {
  const { view } = env;
  await env.resize("wide");
  await leaveSettings(view);
  await toRail(view);
  const steps: Array<[string, (env: ViewEnv) => Promise<void>]> = [["view-main-linkage", walkLinkage], ["hidden-layers", walkHiddenLayers], ["tab-reopen-place", walkReopen], ["quit-saves-layout", walkQuitSave]];
  for (const [name, step] of steps) {
    try { await step(env); } catch (error) { env.observe(name, false, { problems: [`the walk stopped: ${error instanceof Error ? error.message : String(error)}`] }); }
    await pressKey(view, "Escape");
    await leaveSettings(view);
  }
  await railTo(view, "home");
}

/** The sidebar of a view, shown and filled in. */
async function showView(view: BrowserWindow, name: RailName): Promise<boolean> {
  if (!(await railTo(view, name))) return false;
  await ensureSidebar(view);
  return waitUntil(view, `document.querySelector('[data-testid="sidebar"][data-view="${name}"]') && !document.querySelector('[data-testid="sidebar-loading"]')`, 6000);
}

async function openGroup(view: BrowserWindow, key: string): Promise<void> {
  const expanded = await js<string | null>(view, `document.querySelector('[data-testid="context-toggle-${key}"]')?.getAttribute("aria-expanded") ?? null`);
  const disabled = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="context-toggle-${key}"]')?.disabled)`);
  if (expanded !== "true" && !disabled) await clickTestId(view, `context-toggle-${key}`);
  await waitUntil(view, `document.querySelector('[data-testid="context-toggle-${key}"]')?.getAttribute("aria-expanded") === "true" && !document.querySelector('[data-testid="sidebar-loading"]')`, 3000);
}

// ------------------------------------------------------------------------------------------------------------------------ view-main-linkage

/**
 * 计划 4.1, AT-130: a whiteboard open in the whiteboard view and an episode playing in the video view of a project. Back in the whiteboard view the main area is
 * the board, the video is paused and the dock is the project's conversation; the comic view has opened nothing and shows its empty page; back in the video view
 * it is the same element at the same time (no new load) and the dock is the episode's; the home holds both and takes them side by side; the sidebar marks what
 * is in front; a reference card on the board opens the episode in the video view.
 */
async function walkLinkage(env: ViewEnv): Promise<void> {
  const { view, call, observe, shot, projectId, boardId, videoId } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  if (!videoId || !boardId) { observe("view-main-linkage", false, { problems: ["the walk has no video or no whiteboard"] }); return; }
  await call("project.addMaterial", { projectId, kind: "resource", targetId: videoId }).catch(() => null);
  // In the project, with nothing open.
  await showView(view, "home");
  await clickTestId(view, `context-open-${projectId}`);
  await waitContextKey(view, projectId);
  await closeTabs(view, "all");
  // The board in the whiteboard view.
  await showView(view, "whiteboard");
  await openGroup(view, projectId);
  await clickTestId(view, `sidebar-item-whiteboard-${boardId}`, 4000);
  const boardOpen = await waitUntil(view, `${HOST}?.querySelector('[data-testid="view-dock"][data-view="whiteboard"] [data-testid="tab"][data-focused="true"][data-kind="whiteboard"]')`, 8000);
  await waitUntil(view, `(document.querySelector('[data-testid="shell-dock"] [data-testid="conversation-title"]')?.textContent ?? "") !== ""`, 4000);
  const projectDock = await dockTitle(view);
  // The episode in the video view, playing, marked so the same element is known again.
  await showView(view, "video");
  await openGroup(view, projectId);
  await clickTestId(view, `sidebar-item-resource-${videoId}`, 4000);
  const videoReady = await waitUntil(view, `(() => { const v = ${HOST}?.querySelector('[data-testid="view-dock"][data-view="video"] video'); return v && v.readyState >= 2; })()`, 30_000);
  await js(view, `(() => { const v = ${HOST}.querySelector('[data-testid="view-dock"][data-view="video"] video'); v.__viewMark = "linkage"; v.__loads = 0; v.__emptied = 0; v.addEventListener("loadstart", () => { v.__loads += 1; }); v.addEventListener("emptied", () => { v.__emptied += 1; }); v.muted = true; return v.play().then(() => true, () => false); })()`);
  await waitUntil(view, `(() => { const v = ${HOST}?.querySelector('[data-testid="view-dock"][data-view="video"] video'); return Boolean(v) && !v.paused && v.currentTime > 0.25 && document.querySelector('[data-testid="sidebar"] [data-opens][aria-current="true"]'); })()`, 5000);
  const marked = await sidebarMarked(view);
  detail.open = { boardOpen, videoReady, marked };
  if (!boardOpen) problems.push("the whiteboard did not open in the whiteboard view");
  if (!videoReady) problems.push("the episode did not open in the video view");
  if (!marked.some((id) => id.endsWith(videoId))) problems.push(`the sidebar of the video view marks ${JSON.stringify(marked)}, not the episode in front`);
  const episodeDock = await dockTitle(view);
  const video = () => js<{ same: boolean; time: number; paused: boolean; loads: number; emptied: number } | null>(view, `(() => {
    const v = [...document.querySelectorAll("video")].find((el) => el.__viewMark === "linkage");
    return v ? { same: v.isConnected, time: v.currentTime, paused: v.paused, loads: v.__loads, emptied: v.__emptied } : null;
  })()`);
  // Back to the whiteboard view.
  await showView(view, "whiteboard");
  await waitUntil(view, `(() => { const v = [...document.querySelectorAll("video")].find((el) => el.__viewMark === "linkage"); return Boolean(v?.paused) && ${HOST}?.querySelector('[data-testid="view-dock"]')?.getAttribute("data-view") === "whiteboard" && (document.querySelector('[data-testid="shell-dock"] [data-testid="conversation-title"]')?.textContent ?? "") === ${JSON.stringify(projectDock)}; })()`, 3000);
  const atBoard = { main: await mainView(view), focused: await focusedKind(view), video: await video(), dock: await dockTitle(view) };
  detail.atBoard = { ...atBoard, projectDock };
  if (atBoard.main !== "whiteboard" || atBoard.focused !== "whiteboard") problems.push(`back in the whiteboard view the main area is ${atBoard.main} with ${atBoard.focused} in front`);
  if (!atBoard.video || !atBoard.video.paused) problems.push("the episode plays on in the view that is not on screen");
  if (!projectDock || atBoard.dock !== projectDock) problems.push(`with the board in front the dock says "${atBoard.dock}", not the project's "${projectDock}"`);
  await shot("view-main-whiteboard");
  // The comic view: nothing opened there.
  await showView(view, "comic");
  await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="view-empty"][data-view="comic"]'))`, 3000);
  const comic = { main: await mainView(view), empty: await js<boolean>(view, `${DRAWN}(document.querySelector('[data-testid="view-empty"][data-view="comic"]'))`), manage: await js<boolean>(view, `${DRAWN}(document.querySelector('[data-testid="view-empty-manage"]'))`) };
  detail.comic = comic;
  if (comic.main !== "comic" || !comic.empty || !comic.manage) problems.push(`the comic view with nothing opened shows ${JSON.stringify(comic)}, not its empty page with the way to the comics`);
  await shot("view-main-empty");
  // Back to the video view: the same element, where it was, and not loaded again.
  const left = atBoard.video?.time ?? 0;
  await showView(view, "video");
  await waitUntil(view, `${HOST}?.querySelector('[data-testid="view-dock"]')?.getAttribute("data-view") === "video" && (document.querySelector('[data-testid="shell-dock"] [data-testid="conversation-title"]')?.textContent ?? "") === ${JSON.stringify(episodeDock)}`, 3000);
  const back = { main: await mainView(view), video: await video(), dock: await dockTitle(view) };
  detail.back = { ...back, left, episodeDock };
  if (back.main !== "video") problems.push(`back in the video view the main area is ${back.main}`);
  if (!back.video?.same) problems.push("back in the video view the episode is another element");
  else {
    if (back.video.loads > 0 || back.video.emptied > 0) problems.push(`the episode was loaded again (${back.video.loads} loads, ${back.video.emptied} emptied)`);
    if (Math.abs(back.video.time - left) > 0.6) problems.push(`the episode is at ${back.video.time.toFixed(2)} s, it was left at ${left.toFixed(2)} s`);
  }
  if (back.dock !== episodeDock || back.dock === projectDock) problems.push(`with the episode in front the dock says "${back.dock}", not the episode's "${episodeDock}"`);
  // The home: both, and side by side.
  await showView(view, "home");
  await waitUntil(view, `${HOST}?.querySelector('[data-testid="view-dock"]')?.getAttribute("data-view") === "home"`, 3000);
  const homeKinds = await js<string[]>(view, `[...(${HOST}?.querySelectorAll('[data-testid="view-dock"][data-view="home"] [data-testid="tab"]') ?? [])].map((c) => c.getAttribute("data-kind") ?? "")`);
  await chooseMenu(view, "layout-menu", "layout-two");
  await waitUntil(view, `[...(${HOST}?.querySelectorAll('[data-testid="view-dock"] .dv-groupview') ?? [])].filter((g) => g.getClientRects().length > 0).length === 2`, 3000);
  const columns = await columnsOf(view);
  detail.home = { kinds: homeKinds, columns: columns.map((column) => column.length) };
  if (!homeKinds.includes("whiteboard") || !homeKinds.includes("reader")) problems.push(`the home holds ${JSON.stringify(homeKinds)}, not the board and the episode`);
  if (columns.length !== 2 || columns.some((column) => column.length === 0)) problems.push(`the home's two columns are ${JSON.stringify(columns.map((column) => column.length))}`);
  await chooseMenu(view, "layout-menu", "layout-single");
  await waitUntil(view, `[...(${HOST}?.querySelectorAll('[data-testid="view-dock"] .dv-groupview') ?? [])].filter((g) => g.getClientRects().length > 0).length === 1`, 3000);
  // A reference card on the board opens the episode in the video view.
  await showView(view, "whiteboard");
  await waitUntil(view, `${HOST}?.querySelector('[data-testid="view-dock"][data-view="whiteboard"] [data-testid^="wb-open-"]')`, 3000);
  const card = await js<string | null>(view, `(() => {
    const opens = [...(${HOST}?.querySelectorAll('[data-testid="view-dock"][data-view="whiteboard"] [data-testid^="wb-open-"]') ?? [])];
    const pick = opens.find((el) => (el.closest('[data-testid^="wb-node-"]')?.textContent ?? "").includes(${JSON.stringify(env.titles.video)})) ?? null;
    return pick ? pick.getAttribute("data-testid") : null;
  })()`);
  if (!card) problems.push("the board has no reference card of the episode to open");
  else {
    await clickTestId(view, card, 3000);
    const switched = await waitUntil(view, `document.querySelector('[data-testid="nav-video"]')?.getAttribute("aria-current") === "page"`, 6000);
    const there = await mainView(view);
    detail.fromCard = { card, switched, there };
    if (!switched || there !== "video") problems.push(`the episode's card on the board opened in ${there} (the video view is ${switched ? "" : "not "}chosen)`);
  }
  await js(view, `document.querySelectorAll("video").forEach((v) => v.pause()); true`);
  observe("view-main-linkage", problems.length === 0, { ...detail, problems });
}

/** The things the sidebar marks as in front (aria-current on a row or a cover). */
const sidebarMarked = (view: BrowserWindow) => js<string[]>(view, `[...document.querySelectorAll('[data-testid="sidebar"] [data-opens][aria-current="true"]')].map((el) => el.getAttribute("data-testid") ?? "")`);

// ---------------------------------------------------------------------------------------------------------------------------- hidden-layers

type NodeFacts = { id: string; box: Box; hitInside: boolean; visible: boolean };

/** The board's cards: where each is, whether a pointer at its middle reaches it, and whether the page says it can be seen. */
const nodesOf = (view: BrowserWindow, selector: string) => js<NodeFacts[]>(view, `(() => [...document.querySelectorAll(${JSON.stringify(selector)})].slice(0, 4).map((el) => {
  const b = el.getBoundingClientRect();
  const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
  let visible = true;
  try { visible = el.checkVisibility({ visibilityProperty: true }); } catch { visible = getComputedStyle(el).visibility !== "hidden"; }
  return { id: el.getAttribute("data-testid") ?? "", box: { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }, hitInside: Boolean(hit && el.contains(hit)), visible };
}))()`);

/**
 * 计划 4.8, AT-131: with cards on the board and nodes on a mind map, the settings, another tab of the same column and another view each hide them: a pointer at
 * a card's middle reaches what is on screen, the page says the card cannot be seen, and the screen there is not the card. Back, the cards are where they were.
 */
async function walkHiddenLayers(env: ViewEnv): Promise<void> {
  const { view, call, observe, shot, projectId, boardId } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await showView(view, "home");
  await clickTestId(view, `context-open-${projectId}`);
  await waitContextKey(view, projectId);
  await closeTabs(view, "all");
  // A mind map with a node of its own.
  const made = (await call("mindmap.create", { projectId, title: "隐藏层导图" }).catch(() => null))?.value as { map?: { id?: string }; mindmap?: { id?: string }; id?: string } | undefined;
  const mapId = made?.map?.id ?? made?.mindmap?.id ?? made?.id ?? null;
  const cases: Array<{ name: string; view: RailName; open: string; selector: string }> = [
    { name: "whiteboard", view: "whiteboard", open: `sidebar-item-whiteboard-${boardId}`, selector: '[data-testid="view-dock"][data-view="whiteboard"] [data-testid^="wb-node-"]' },
    ...(mapId ? [{ name: "mindmap", view: "mindmap" as RailName, open: `sidebar-item-mindmap-${mapId}`, selector: '[data-testid="view-dock"][data-view="mindmap"] [data-testid^="mm-node-"]' }] : []),
  ];
  if (!mapId) problems.push("a mind map could not be made for the walk");
  for (const item of cases) {
    await showView(view, item.view);
    await openGroup(view, projectId);
    await clickTestId(view, item.open, 4000);
    await waitUntil(view, `document.querySelector(${JSON.stringify(item.selector)})`, 8000);
    if (item.name === "whiteboard") { await clickTestId(view, "whiteboard-add-card", 3000); await waitFrames(view, 2); }
    if (item.name === "mindmap") { await clickTestId(view, "mindmap-add-child", 3000); await pressKey(view, "Escape"); await waitFrames(view, 2); }
    await waitFrames(view, 2);
    const shown = await nodesOf(view, item.selector);
    if (!shown.length || shown.some((node) => !node.visible)) { problems.push(`${item.name}: no card is on screen to hide`); continue; }
    const colours = await Promise.all(shown.map(async (node) => (await pixelsOf(view, { x: node.box.x + node.box.w / 2, y: node.box.y + node.box.h / 2, w: 1, h: 1 })).rgb[0]));
    const rows: Record<string, unknown> = {};
    const hiddenBy = async (label: string, hide: () => Promise<boolean>, show: () => Promise<void>) => {
      const ok = await hide();
      await waitFrames(view, 2);
      const now = await js<Array<{ hitInside: boolean; visible: boolean }>>(view, `(() => {
        const points = ${JSON.stringify(shown.map((node) => ({ id: node.id, x: node.box.x + node.box.w / 2, y: node.box.y + node.box.h / 2 })))};
        return points.map((p) => {
          const el = [...document.querySelectorAll('[data-testid="' + p.id + '"]')][0];
          const hit = document.elementFromPoint(p.x, p.y);
          let visible = false;
          try { visible = el ? el.checkVisibility({ visibilityProperty: true }) : false; } catch { visible = el ? getComputedStyle(el).visibility !== "hidden" : false; }
          return { hitInside: Boolean(el && hit && el.contains(hit)), visible };
        });
      })()`);
      const screen = await Promise.all(shown.map(async (node) => (await pixelsOf(view, { x: node.box.x + node.box.w / 2, y: node.box.y + node.box.h / 2, w: 1, h: 1 })).rgb[0]));
      const hitBackground = await js<Array<string | null>>(view, `(() => ${JSON.stringify(shown.map((node) => ({ x: node.box.x + node.box.w / 2, y: node.box.y + node.box.h / 2 })))}.map((p) => {
        let el = document.elementFromPoint(p.x, p.y);
        while (el) { const c = getComputedStyle(el).backgroundColor; if (c && !/rgba\\([^)]*,\\s*0\\)/.test(c) && c !== "transparent") return c; el = el.parentElement; }
        return null;
      }))()`);
      const leaks = now.map((node, index) => ({ node, index })).filter(({ node, index }) => node.hitInside || node.visible || (near3(screen[index], colours[index], 3) && !near3(screen[index], parseRgb(hitBackground[index]), 6)));
      rows[label] = { hidden: ok, leaks: leaks.map(({ index }) => shown[index]!.id), screen: screen.map(hex), was: colours.map(hex) };
      if (!ok) problems.push(`${item.name}: ${label} could not be reached`);
      if (leaks.length) problems.push(`${item.name}: under ${label} ${leaks.length} card(s) still show through`);
      if (label === "the settings") await shot(`hidden-layers-${item.name}-settings`);
      await show();
      await waitUntil(view, `document.querySelector(${JSON.stringify(item.selector)})`, 3000);
      await waitFrames(view, 2);
      const after = await nodesOf(view, item.selector);
      const moved = shown.filter((node) => { const back = after.find((other) => other.id === node.id); return !back || Math.abs(back.box.x - node.box.x) > 1 || Math.abs(back.box.y - node.box.y) > 1 || !back.visible; });
      if (moved.length) problems.push(`${item.name}: after ${label} ${moved.length} card(s) are not where they were (${JSON.stringify(moved.slice(0, 1).map((node) => ({ was: node.box, now: after.find((other) => other.id === node.id) ?? null })))})`);
    };
    await hiddenBy("the settings", async () => (await clickTestId(view, "nav-settings", 3000)) && await waitUntil(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-settings") === "true"`, 4000), async () => { await leaveSettings(view); });
    // Another tab in the same column: the view's management page opens in front of the board.
    await hiddenBy("another tab", async () => (await clickTestId(view, "sidebar-manage", 3000)) && await waitUntil(view, `${HOST}?.querySelector('[data-testid="view-dock"] [data-testid="tab"][data-focused="true"][data-kind="objects"]')`, 4000), async () => {
      const chip = await js<{ x: number; y: number } | null>(view, `(() => { const box = ${HOST}?.querySelector('[data-testid="view-dock"] [data-testid="tab"][data-kind="${item.name}"]')?.getBoundingClientRect(); return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null; })()`);
      if (chip) { await mouse(view, "mouseMove", chip); await mouse(view, "mouseDown", chip); await mouse(view, "mouseUp", chip); }
      await waitUntil(view, `${HOST}?.querySelector('[data-testid="view-dock"] [data-testid="tab"][data-focused="true"][data-kind="${item.name}"]')`, 4000);
    });
    // Another view.
    await hiddenBy("another view", async () => showView(view, "comic"), async () => { await showView(view, item.view); });
    detail[item.name] = rows;
  }
  observe("hidden-layers", problems.length === 0, { ...detail, problems });
}

// ---------------------------------------------------------------------------------------------------------------------------- tab-reopen-place

/** A row of the home's sidebar in 最近, opened as a tab of the home's layout. */
async function openRecentRows(view: BrowserWindow, count: number): Promise<number> {
  await showView(view, "home");
  await openGroup(view, "recent");
  const ids = await js<string[]>(view, `[...document.querySelectorAll('[data-testid="sidebar"][data-view="home"] [data-testid="context-recent"] [data-testid^="sidebar-item-note-"]')].map((el) => el.getAttribute("data-testid"))`);
  let opened = 0;
  for (const id of ids.slice(0, count)) {
    const before = await js<number>(view, `${HOST}?.querySelectorAll('[data-testid="view-dock"] [data-testid="tab"]').length ?? 0`);
    await clickTestId(view, id, 3000);
    if (await waitUntil(view, `(${HOST}?.querySelectorAll('[data-testid="view-dock"] [data-testid="tab"]').length ?? 0) > ${before}`, 4000)) opened += 1;
  }
  return opened;
}

/**
 * LOOP-24 2 and 3, AT-128: in two columns, the middle tab of the right one is closed and comes back with Ctrl+Shift+T in the right column at its place; with the
 * focus on a tab, Delete and Backspace close nothing.
 */
async function walkReopen(env: ViewEnv): Promise<void> {
  const { view, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await showView(view, "home");
  await clickTestId(view, "context-open-recent");
  await waitContextKey(view, "");
  await closeTabs(view, "all");
  await openLibrary(view);
  await chooseMenu(view, "layout-menu", "layout-two");
  await waitUntil(view, `[...(${HOST}?.querySelectorAll('[data-testid="view-dock"] .dv-groupview') ?? [])].filter((g) => g.getClientRects().length > 0).length === 2`, 3000);
  // The right column in front, and three more tabs in it.
  await pressChord(view, "2", ["control"]);
  await waitFrames(view, 2);
  const right = (await js<number>(view, `[...(${HOST}?.querySelectorAll('[data-testid="view-dock"] .dv-groupview') ?? [])].filter((g) => g.getClientRects().length > 0).length`)) === 2;
  const opened = await openRecentRows(view, 3);
  await waitFrames(view, 2);
  const columns = await columnsOf(view);
  detail.setup = { right, opened, columns: columns.map((column) => column.length) };
  const column = columns.length - 1;
  const strip = columns[column] ?? [];
  if (columns.length < 2 || strip.length < 3) { observe("tab-reopen-place", false, { ...detail, problems: [`the right column holds ${strip.length} tabs, not three to close the middle one of`] }); return; }
  const middle = Math.floor(strip.length / 2);
  const target = strip[middle]!;
  await js(view, `${HOST}?.querySelector('[data-testid="tab"][data-tab="${target}"] [data-testid="tab-close"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); true`);
  const gone = await waitUntil(view, `!${HOST}?.querySelector('[data-testid="view-dock"] [data-testid="tab"][data-tab="${target}"]')`, 3000);
  await pressChord(view, "T", ["control", "shift"]);
  await waitUntil(view, `(${HOST}?.querySelectorAll('[data-testid="view-dock"] [data-testid="tab"]').length ?? 0) >= ${columns.flat().length}`, 3000);
  const after = await columnsOf(view);
  const back = after.findIndex((items) => items.length > 0 && items.some((id) => !strip.includes(id) || id === target));
  const place = after.map((items, index) => ({ index, at: items.indexOf(target) })).find((row) => row.at >= 0);
  // The reopened tab is a new tab of the same page: found by the page it shows when its id is new.
  const reopenedAt = place ?? (() => {
    const fresh = after.flatMap((items, index) => items.map((id, at) => ({ id, index, at }))).find((row) => !strip.includes(row.id) && !columns.flat().includes(row.id));
    return fresh ? { index: fresh.index, at: fresh.at } : null;
  })();
  detail.reopen = { gone, closed: { column, index: middle }, back: reopenedAt, columns: after.map((items) => items.length), scanned: back };
  if (!gone) problems.push("the close button left the tab");
  if (!reopenedAt) problems.push("Ctrl+Shift+T brought no tab back");
  else if (reopenedAt.index !== column || reopenedAt.at !== middle) problems.push(`the tab came back in column ${reopenedAt.index + 1} at ${reopenedAt.at + 1}, it was closed in column ${column + 1} at ${middle + 1}`);
  await shot("tab-reopen-place");
  // Delete and Backspace with the focus on a tab.
  const count = async () => js<number>(view, `${HOST}?.querySelectorAll('[data-testid="view-dock"] [data-testid="tab"]').length ?? 0`);
  const before = await count();
  const focused = await js<boolean>(view, `(() => { const chip = ${HOST}?.querySelector('[data-testid="view-dock"] [data-testid="tab"][data-focused="true"]'); const tab = chip?.closest(".dv-tab") ?? chip; if (!tab) return false; tab.setAttribute("tabindex", tab.getAttribute("tabindex") ?? "0"); tab.focus(); return document.activeElement === tab || tab.contains(document.activeElement); })()`);
  await pressKey(view, "Delete");
  await waitFrames(view, 2);
  await pressKey(view, "Backspace");
  await waitFrames(view, 2);
  const kept = await count();
  detail.keys = { focused, before, kept };
  if (!focused) problems.push("the focus could not be put on a tab");
  if (kept !== before) problems.push(`Delete and Backspace on a tab closed ${before - kept} tab(s)`);
  await chooseMenu(view, "layout-menu", "layout-single");
  await waitUntil(view, `[...(${HOST}?.querySelectorAll('[data-testid="view-dock"] .dv-groupview') ?? [])].filter((g) => g.getClientRects().length > 0).length === 1`, 3000);
  observe("tab-reopen-place", problems.length === 0, { ...detail, problems });
}

// ---------------------------------------------------------------------------------------------------------------------------- quit-saves-layout

/**
 * LOOP-23, 计划 4.8: a change of the layout made 60 ms before the window is asked to close is in the stored state when the page answers that it saved, and
 * the answer comes within the 1.5 s the close waits for. The request is the one the window's close sends (`manga:save-now`), without closing the walk's window.
 */
async function walkQuitSave(env: ViewEnv): Promise<void> {
  const { view, call, observe } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  type State = { preset?: string; state?: { preset?: string } };
  const preset = async () => { const value = (await call("workspace.loadContext", { contextId: null })).value as State | undefined; return value?.state?.preset ?? value?.preset ?? null; };
  await showView(view, "home");
  await clickTestId(view, "context-open-recent");
  await waitContextKey(view, "");
  await chooseMenu(view, "layout-menu", "layout-two");
  // The two columns are saved by the usual pause.
  let stored: string | null = null;
  for (let waited = 0; waited < 4000 && stored !== "two"; waited += 50) {
    await sleep(50); // real time: poll until debounced two-column layout save reaches store
    stored = await preset();
  }
  await chooseMenu(view, "layout-menu", "layout-single");
  await sleep(60); // real time: 60 ms window between layout change and quit-save request (within debounce window)
  const token = createId("save");
  const started = Date.now();
  const answered = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { ipcMain.removeListener("manga:saved", onSaved); resolve(false); }, 1500);
    function onSaved(event: Electron.IpcMainEvent, value: unknown) { if (event.sender === view.webContents && value === token) { clearTimeout(timer); ipcMain.removeListener("manga:saved", onSaved); resolve(true); } }
    ipcMain.on("manga:saved", onSaved);
    view.webContents.send("manga:save-now", token);
  });
  const ms = Date.now() - started;
  const after = await preset();
  detail.save = { before: stored, answered, ms, after };
  if (stored !== "two") problems.push(`the two columns were not saved first (${stored})`);
  if (!answered) problems.push("the page did not answer the request to save within 1.5 s");
  if (after !== "single") problems.push(`the layout changed 60 ms before the close is stored as ${after}, not single`);
  observe("quit-saves-layout", problems.length === 0, { ...detail, problems });
}
