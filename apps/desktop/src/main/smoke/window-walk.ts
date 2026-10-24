import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { testHooks } from "../test-hooks.ts";
import { productWindow } from "../window-options.ts";
import { clickTestId, closeTabs, openFromShelf, openShelf, revealNovelControls, setField, setSelect, sleep, waitForTestId, waitUntil } from "./driver.ts";
import { READER_CONTROL_OBSERVATIONS, walkComicControls, walkNovelControls, walkPlayerControls } from "./reader-controls-walk.ts";
import { PLAYER_MENU_OBSERVATIONS, walkPlayerFullscreen, walkPlayerMenus } from "./player-menus-walk.ts";
import { DANMAKU_OBSERVATIONS, walkDanmaku } from "./danmaku-walk.ts";
import { OVERLAY_OBSERVATIONS, walkComicOverlays, walkNovelOverlays, walkPlayerOverlays } from "./overlay-walk.ts";
import { RETENTION_OBSERVATIONS, screenshotWalk, walkSettingsRoundTrip } from "./retention-walk.ts";
import { capturePage, caller, clickFirst, ensureDock, js, openSettingsPage, toRail, type FlowResult } from "./common.ts";
import { FRAME_OBSERVATIONS, runFrameWalk } from "./frame-walk.ts";
import { MANAGEMENT_OBSERVATIONS, runManagementWalk } from "./management-walk.ts";
import { RAIL_OBSERVATIONS, runRailWalk } from "./rail-walk.ts";
import { WORKSPACE_OBSERVATIONS, runWorkspaceWalk } from "./workspace-walk.ts";
import { prepareRestart } from "./workspace-restart.ts";

/**
 * The main flows end to end in the real window, with synthetic folders and samples only: the window starts on the library paths page
 * of an empty library; three library paths (novel, comic, video) are added and scanned in the background; a work opens from its card to
 * its own page; a note goes from the dock; every settings page is reachable; and the comic, player and novel controls are checked
 * at three window sizes (AT-68), and the floating capsule is checked not to cover any of them. The tabs, the split and the contexts are walked after them. Each observation is named; the package stage requires every one of them to pass.
 */

export type Observation = { name: string; status: "passed" | "failed"; detail: unknown };

/** wide: the product window; narrow: the narrowest tall viewport; short: a wide window with little height. */
export const WINDOW_SIZES = { wide: [productWindow.width, productWindow.height], narrow: [360, 780], short: [1100, 460] } as const;
type SizeName = keyof typeof WINDOW_SIZES;
const FITS = ["page", "width", "height"] as const;

/** Every observation the stage requires; the package stage writes them to scenarios.json and the report checks each one. */
export const REQUIRED_OBSERVATIONS = [
  "starts-on-library-paths",
  "library-paths-add-scan",
  "work-home-open",
  "right-pane-note",
  "settings-pages-reachable",
  "capsule-clear-of-controls",
  ...(Object.keys(WINDOW_SIZES) as SizeName[]).flatMap((size) => [...FITS.map((fit) => `comic-layout-${size}-${fit}`), `player-controls-${size}`, `novel-controls-${size}`, `readers-fill-main-${size}`]),
  ...READER_CONTROL_OBSERVATIONS,
  ...DANMAKU_OBSERVATIONS,
  ...OVERLAY_OBSERVATIONS,
  ...RETENTION_OBSERVATIONS,
  ...FRAME_OBSERVATIONS,
  ...WORKSPACE_OBSERVATIONS,
  ...MANAGEMENT_OBSERVATIONS,
  ...RAIL_OBSERVATIONS,
] as const;

type Rect = { x: number; y: number; w: number; h: number; r: number; b: number };
const RECT = `(el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; }`;
const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance;
const inside = (inner: Rect, outer: { w: number; h: number }, slack = 1) => inner.x >= -slack && inner.y >= -slack && inner.r <= outer.w + slack && inner.b <= outer.h + slack;

export async function runWindowWalkSmoke(input: { appService: MangaProductApp; grant: string; view: BrowserWindow; evidenceDir: string | undefined; logsDir: string }): Promise<FlowResult & { observations: Observation[] }> {
  const { appService, grant, view, evidenceDir, logsDir } = input;
  const call = caller(appService, grant);
  const observations: Observation[] = [];
  const observe = (name: string, ok: boolean, detail: unknown) => {
    observations.push({ name, status: ok ? "passed" : "failed", detail });
    console.error(`window-walk ${name}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 700)}`);
    return ok;
  };
  const root = process.env.MANGA_SMOKE_SAMPLES;
  const manifestFile = root ? path.join(root, "manifest.json") : "";
  if (!root || !fs.existsSync(manifestFile)) return { ok: false, notRun: true, reason: "MANGA_SMOKE_SAMPLES does not point at the generated samples", observations };
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { samples: Array<{ id: string; path: string; status: string }> };
  const samplePath = (id: string) => {
    const entry = manifest.samples.find((item) => item.id === id);
    if (!entry || entry.status !== "generated") throw new Error(`sample ${id} is not available`);
    return path.join(root, entry.path);
  };
  // A hidden window presents no frames, so transitions (the reader controls sliding away) never run in it; the person's keyboard is left alone.
  view.showInactive();
  const shot = (name: string, mark?: string) => capturePage(view, evidenceDir, `ui-walk-${name}.png`, mark);
  // A reader fills its tab: its root is the tab panel in front, the room the dock leaves under the strip, to within a pixel on every side (A-63).
  const fillRows: Record<SizeName, Array<{ reader: string; fills: boolean; root: Rect | null; panel: Rect | null }>> = { wide: [], narrow: [], short: [] };
  const checkFill = async (size: SizeName, reader: string, rootTestId: string) => {
    const got = await js<{ root: Rect | null; panel: Rect | null }>(view, `(() => {
      const rect = ${RECT};
      const root = document.querySelector('[data-testid="${rootTestId}"]');
      const panel = document.querySelector('[data-testid="tab-panel"][data-focused="true"]');
      if (!root || !panel) return { root: root ? rect(root) : null, panel: null };
      return { root: rect(root), panel: rect(panel) };
    })()`);
    const fills = Boolean(got.root && got.panel) && near(got.root!.x, got.panel!.x) && near(got.root!.y, got.panel!.y) && near(got.root!.r, got.panel!.r) && near(got.root!.b, got.panel!.b);
    fillRows[size].push({ reader, fills, root: got.root, panel: got.panel });
  };
  const resize = async (size: SizeName) => {
    const [width, height] = WINDOW_SIZES[size];
    view.setContentSize(width, height);
    await sleep(450);
  };
  // The floating capsule (microphone and quick note) shows while the dock is folded. On a page with a bar of controls it must not sit on
  // any of them, with its note box open or closed: the dock is folded for the check when it is open, then put back as it was.
  const capsuleRows: Array<Record<string, unknown>> = [];
  const capsuleCheck = async (label: string, selectors: string[]) => {
    const paneWasOpen = !(await js<boolean>(view, `Boolean(document.querySelector('[data-testid="chat-capsule"]'))`));
    if (paneWasOpen) {
      await clickTestId(view, "shell-dock-toggle", 1500);
      await waitUntil(view, `document.querySelector('[data-testid="chat-capsule"]')`, 2500);
    }
    const shown = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="chat-capsule"]'))`);
    if (!shown) { capsuleRows.push({ label, shown: false }); return; }
    // What the capsule draws (its bar and, when open, the note box) must not overlap a control, and nothing of the capsule may take the
    // pointer at a control's centre (the space between the bar and a box that opens further down included).
    const measure = () => js<{ capsule: Rect[]; covered: string[]; checked: number }>(view, `(() => {
      const rect = ${RECT};
      const root = document.querySelector('[data-testid="chat-capsule"]');
      const capsule = [...root.children].map(rect).filter((r) => r.w > 0 && r.h > 0);
      const covered = []; let checked = 0;
      for (const el of document.querySelectorAll(${JSON.stringify(selectors.join(", "))})) {
        const r = rect(el);
        if (r.w <= 0 || r.h <= 0) continue;
        checked += 1;
        const overlaps = capsule.some((c) => r.x < c.r - 1 && r.r > c.x + 1 && r.y < c.b - 1 && r.b > c.y + 1);
        const hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
        if (overlaps || (hit && root.contains(hit))) covered.push((el.getAttribute("data-testid") || el.tagName.toLowerCase()) + "@" + Math.round(r.x) + "," + Math.round(r.y));
      }
      return { capsule, covered, checked };
    })()`);
    // The controls of the player and of the novel reader fade while idle; the check needs them where they are when shown.
    const wake = async () => {
      await js(view, `document.querySelector('[data-testid="video-reader"]')?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 40, clientY: 40 }))`);
      await revealNovelControls(view);
      await sleep(150);
    };
    await wake();
    const closed = await measure();
    await clickTestId(view, "capsule-note");
    await sleep(200);
    await wake();
    const open = await measure();
    await clickTestId(view, "capsule-note");
    capsuleRows.push({ label, shown: true, checked: closed.checked, covered: [...closed.covered, ...open.covered.map((item) => `note-open:${item}`)] });
    if (paneWasOpen) { await clickTestId(view, "shell-dock-toggle", 1500); await sleep(250); }
  };
  await call("settings.skipAi", {});

  // ---- 1. an empty library starts on the page that adds the first folder -------------------------------------------
  const startedOnPaths = await waitUntil(view, `document.querySelector('[data-testid="settings-page-library"]')`, 12_000);
  const emptyHint = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="library-paths-empty"]'))`);
  observe("starts-on-library-paths", startedOnPaths && emptyHint, { startedOnPaths, emptyHint });
  await shot("library-paths-empty-wide");

  // ---- 2. three library paths, scanned in the background ---------------------------------------------------------------
  const base = path.join(logsDir, "walk-library");
  fs.rmSync(base, { recursive: true, force: true });
  const folders = { novel: path.join(base, "novel"), comic: path.join(base, "comic"), video: path.join(base, "video") };
  for (const folder of Object.values(folders)) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folders.novel, "合成小说甲.txt"), `${"甲卷正文。".repeat(200)}RW-NOVEL-A-TAIL`);
  fs.writeFileSync(path.join(folders.novel, "合成小说乙.txt"), `${"乙卷正文。".repeat(200)}RW-NOVEL-B-TAIL`);
  fs.mkdirSync(path.join(folders.novel, "合成长篇"), { recursive: true });
  fs.writeFileSync(path.join(folders.novel, "合成长篇", "第一章.txt"), `${"长篇第一章。".repeat(100)}RW-SERIES-1`);
  fs.writeFileSync(path.join(folders.novel, "合成长篇", "第二章.txt"), `${"长篇第二章。".repeat(100)}RW-SERIES-2`);
  fs.copyFileSync(samplePath("cbz-basic"), path.join(folders.comic, "合成漫画.cbz"));
  fs.copyFileSync(samplePath("video-mp4-h264-aac"), path.join(folders.video, "合成动画.mp4"));
  // The page notes whether a scan's progress was ever on screen (the title bar's indicator or the library page's own block).
  await js(view, `window.__smokeScanSeen = { indicator: false, block: false }; setInterval(() => {
    if (document.querySelector('[data-testid="scan-indicator"]')) window.__smokeScanSeen.indicator = true;
    if (document.querySelector('[data-testid="scan-progress"]')) window.__smokeScanSeen.block = true;
  }, 25); true`);
  const added: string[] = [];
  const startedAt = Date.now();
  for (const kind of ["novel", "comic", "video"] as const) {
    testHooks.pick = () => folders[kind];
    const chosen = await setSelect(view, "library-path-new-kind", kind);
    const clicked = chosen && await clickTestId(view, "library-path-add");
    const row = clicked && await waitUntil(view, `[...document.querySelectorAll('[data-testid^="library-path-text-"]')].some((el) => (el.textContent || "").endsWith(${JSON.stringify(path.basename(folders[kind]))}))`, 8000);
    if (row) added.push(kind);
    await sleep(300);
  }
  testHooks.pick = undefined;
  // Five works are expected: two single files and one folder of two chapters (novel), one comic archive, one video.
  let total = 0;
  for (let attempt = 0; attempt < 480 && total < 5; attempt += 1) {
    const listed = await call("works.list", { limit: 50 });
    total = Number((listed.value as { total?: number } | undefined)?.total ?? 0);
    if (total < 5) await sleep(250);
  }
  const scanMs = Date.now() - startedAt;
  const settledScan = await waitUntil(view, `!document.querySelector('[data-testid="scan-cancel"]') && document.querySelectorAll('[data-testid^="library-path-text-"]').length === 3`, 60_000);
  const seen = await js<{ indicator: boolean; block: boolean }>(view, `window.__smokeScanSeen`);
  const works = ((await call("works.list", { limit: 50 })).value as { items?: Array<{ id: string; title: string; mediaKind: string; lastResource?: { id: string } | null }> } | undefined)?.items ?? [];
  const byKind = (kind: string) => works.filter((work) => work.mediaKind === kind);
  const grouped = byKind("novel").length === 3 && byKind("comic").length === 1 && byKind("video").length === 1;
  observe("library-paths-add-scan", added.length === 3 && total >= 5 && settledScan && grouped && (seen.indicator || seen.block), { added, total, scanMs, settledScan, grouped, seen, kinds: { novel: byKind("novel").length, comic: byKind("comic").length, video: byKind("video").length } });
  await shot("library-paths-wide");

  // ---- 3. a card opens the work's own page; reading starts from there -----------------------------------------------------
  const rail = await toRail(view);
  const novelHome = rail && await openShelf(view, "novel");
  const cardOpened = novelHome && await clickFirst(view, "open-", 8000);
  const homeShown = cardOpened && await waitForTestId(view, "page-work", "data-present", null, 8000);
  const readEnabled = homeShown && await waitUntil(view, `(() => { const b = document.querySelector('[data-testid="work-read"]'); return b && !b.disabled; })()`, 8000);
  const title = homeShown ? await js<string>(view, `document.querySelector('[data-testid="detail-title"]')?.textContent ?? ""`) : "";
  // Opening a card must not open the file: the reader is not on screen until "read" is pressed.
  const readerClosed = await js<boolean>(view, `!document.querySelector('[data-testid="reading-body"]')`);
  observe("work-home-open", Boolean(homeShown) && Boolean(readEnabled) && readerClosed && title.length > 0, { homeShown, readEnabled, readerClosed, title });
  await shot("work-home-wide", "page-work");

  // ---- 4. a note from the dock, on the work's page ---------------------------------------------------------------------
  const pane = await ensureDock(view);
  await clickTestId(view, "chat-mode-note");
  await setField(view, "agent-composer", "作品页笔记");
  await sleep(100);
  const sent = pane && await clickTestId(view, "agent-send");
  const bubble = sent && await waitUntil(view, `[...document.querySelectorAll('[data-testid^="bubble-note-"]')].some((el) => (el.textContent || "").includes("作品页笔记")) || (document.querySelector('[data-testid="chat-log"]')?.textContent ?? "").includes("作品页笔记")`, 15_000);
  const workspace = await call("workspace.get", {});
  const noteRow = (((workspace.value as { notes?: Array<{ id: string; title: string }> } | undefined)?.notes) ?? []).find((note) => note.title.includes("作品页笔记"));
  observe("right-pane-note", Boolean(bubble) && Boolean(noteRow), { pane, bubble: Boolean(bubble), noteSaved: Boolean(noteRow) });

  // ---- 5. every settings page is reachable ---------------------------------------------------------------------------------------
  await openSettingsPage(view, "general");
  const pages = await js<string[]>(view, `[...document.querySelectorAll('[data-testid^="settings-nav-"]')].map((el) => el.getAttribute("data-testid").slice("settings-nav-".length))`);
  const groups = await js<number>(view, `document.querySelectorAll('[data-testid^="settings-group-"]').length`);
  const reached: string[] = [];
  for (const page of pages) {
    if ((await clickTestId(view, `settings-nav-${page}`, 3000)) && await waitForTestId(view, `settings-page-${page}`, "data-present", null, 6000)) reached.push(page);
  }
  // The directory has three groups now (basic, agent, logs): the records are not a settings page any more (A-101), and each page is a row with its picture.
  const withPicture = await js<number>(view, `[...document.querySelectorAll('[data-testid^="settings-nav-"]')].filter((el) => el.querySelector("svg")).length`);
  observe("settings-pages-reachable", pages.length >= 12 && groups === 3 && reached.length === pages.length && !pages.includes("records") && withPicture === pages.length, { groups, pages: pages.length, reached: reached.length, withPicture, missing: pages.filter((page) => !reached.includes(page)) });
  await shot("settings-wide");

  // ---- 6. comic, player and novel controls at three window sizes (AT-68) ------------------------------------------------------------
  const resourceOf = async (kind: string): Promise<string | null> => {
    const work = byKind(kind)[0];
    if (!work) return null;
    const got = (await call("works.get", { workId: work.id })).value as { resources?: Array<{ id: string }>; lastResource?: { id: string } | null } | undefined;
    return got?.lastResource?.id ?? got?.resources?.[0]?.id ?? null;
  };
  const titleOf = (kind: string) => byKind(kind)[0]?.title ?? "";
  const comicId = await resourceOf("comic");
  const videoId = await resourceOf("video");
  const novelId = await resourceOf("novel");
  // The pictures the readers take go onto a whiteboard of a project made for it (AT-91).
  const project = await call("project.create", { name: "窗口截图项目" });
  const projectId = String((project.value as { id?: string } | undefined)?.id ?? "");
  const board = projectId ? await call("whiteboard.create", { projectId, title: "截图白板" }) : null;
  const boardId = String((board?.value as { board?: { id?: string } } | undefined)?.board?.id ?? "");
  const screenshots = screenshotWalk({ view, appService, call, observe, shot, boardId, comicId });
  await resize("wide");
  await toRail(view);

  // Comic: one reader stays open while the window changes size, so "the page follows the frame, not its own content" is what is tested.
  const comicOpen = comicId ? await openFromShelf(view, "comic", comicId, 8000) : false;
  const comicReady = comicOpen && await waitUntil(view, `document.querySelector('.comic-page[data-state="ready"]')`, 20_000);
  const measureComic = () => js<{ stage: Rect; page: Rect | null; client: { w: number; h: number }; scrollX: number; scrollY: number; percent: string; docOverflow: number; viewport: { w: number; h: number } } | null>(view, `(() => {
    const rect = ${RECT};
    const stage = document.querySelector('[data-testid="comic-stage"]');
    const page = document.querySelector('.comic-page[data-state="ready"]');
    if (!stage) return null;
    return {
      stage: rect(stage),
      page: page ? rect(page) : null,
      client: { w: stage.clientWidth, h: stage.clientHeight },
      scrollX: stage.scrollWidth - stage.clientWidth,
      scrollY: stage.scrollHeight - stage.clientHeight,
      percent: document.querySelector('[data-testid="comic-zoom-value"]')?.textContent ?? "",
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  })()`);
  const zoomTo = async (percent: number) => {
    // From 100%: the value button resets, then in or out by whole steps.
    await clickTestId(view, "comic-zoom-value");
    await sleep(200);
    const steps = Math.round((percent - 100) / 25);
    for (let step = 0; step < Math.abs(steps); step += 1) {
      await clickTestId(view, steps > 0 ? "comic-zoom-in" : "comic-zoom-out");
      await sleep(80);
    }
    await sleep(350);
  };
  for (const size of Object.keys(WINDOW_SIZES) as SizeName[]) {
    await resize(size);
    if (comicReady) await checkFill(size, "comic", "comic-reader");
    for (const fit of FITS) {
      const name = `comic-layout-${size}-${fit}`;
      if (!comicReady) { observe(name, false, { reason: "the comic did not open" }); continue; }
      await setSelect(view, "comic-fit", fit);
      const rows: Array<Record<string, unknown>> = [];
      let base: Rect | null = null;
      let stage0: Rect | null = null;
      let problems: string[] = [];
      for (const percent of [100, 125, 200, 75, 50]) {
        await zoomTo(percent);
        const m = await measureComic();
        if (!m || !m.page) { problems.push(`${percent}%: nothing measured`); continue; }
        if (percent === 100) { base = m.page; stage0 = m.stage; }
        const factor = percent / 100;
        const sizeOk = base ? near(m.page.w, base.w * factor) && near(m.page.h, base.h * factor) : false;
        const stageOk = stage0 ? near(m.stage.w, stage0.w) && near(m.stage.h, stage0.h) : false;
        // Smaller than the stage: centred in the room the scrollbar leaves. Larger: the stage scrolls (it can be reached).
        const centered = percent < 100 ? near((m.page.x + m.page.r) / 2, m.stage.x + m.client.w / 2, 2) || m.page.w >= m.client.w : true;
        // At or below 100% a page fitted to the width or the page never makes the stage scroll sideways (a scrollbar's width is not taken from it).
        const noSideScroll = percent > 100 || fit === "height" || m.scrollX <= 1;
        const noUpScroll = percent > 100 || fit === "width" || m.scrollX > 1 || m.scrollY <= 1;
        const scrolls = percent > 100 && (m.page.w > m.stage.w + 1 || m.page.h > m.stage.h + 1) ? m.scrollX > 0 || m.scrollY > 0 : true;
        const whole = fit === "page" && percent <= 100 ? m.page.x >= m.stage.x - 1 && m.page.r <= m.stage.r + 1 && m.page.y >= m.stage.y - 1 && m.page.b <= m.stage.b + 1 : true;
        const noOverflow = m.docOverflow <= 1;
        if (!sizeOk) problems.push(`${percent}%: page ${Math.round(m.page.w)}x${Math.round(m.page.h)} is not the base ${base ? `${Math.round(base.w)}x${Math.round(base.h)}` : "?"} x ${factor}`);
        if (!stageOk) problems.push(`${percent}%: the stage changed size`);
        if (!centered) problems.push(`${percent}%: the smaller page is not centred`);
        if (!scrolls) problems.push(`${percent}%: the larger page cannot be scrolled to`);
        if (!whole) problems.push(`${percent}%: the whole page is not visible`);
        if (!noSideScroll) problems.push(`${percent}%: the stage scrolls sideways by ${m.scrollX}px`);
        if (!noUpScroll) problems.push(`${percent}%: a page that fits still scrolls by ${m.scrollY}px`);
        if (!noOverflow) problems.push(`${percent}%: the window scrolls sideways by ${m.docOverflow}px`);
        rows.push({ percent, label: m.percent, page: [Math.round(m.page.w), Math.round(m.page.h)], stage: [Math.round(m.stage.w), Math.round(m.stage.h)], scroll: [m.scrollX, m.scrollY] });
      }
      observe(name, problems.length === 0 && rows.length === 5, { fit, rows, problems });
    }
    await clickTestId(view, "comic-zoom-value");
    await setSelect(view, "comic-fit", "page");
    await sleep(300);
    // The region tool's bar sits right under the header, where the capsule floats on this page; it is measured too.
    if (comicReady) {
      await clickTestId(view, "comic-region-tool");
      await capsuleCheck(`comic-${size}`, ['[data-testid="comic-footer"] button', '[data-testid="comic-footer"] select', '[data-testid="comic-footer"] input', '[data-testid="comic-toolbar"] button', '[data-testid="comic-toolbar"] select', '[data-testid="comic-toolbar"] input', '[data-testid="comic-region-bar"] button']);
      await clickTestId(view, "comic-region-cancel");
    }
    await shot(`comic-${size}`);
  }
  // The readers have no bar of their own: the title bar goes back, and the controls AT-83 names are used with the window's own input.
  await resize("wide");
  if (comicReady) await walkComicControls(view, observe, titleOf("comic"));
  else observe("reader-controls-comic", false, { reason: "the comic did not open" });
  if (comicReady) await walkComicOverlays(view, observe, shot);
  else observe("overlays-comic", false, { reason: "the comic did not open" });
  if (comicReady && boardId) await screenshots.comic();
  if (comicOpen) await closeTabs(view, ["reader"]);

  // Player: the controls that stay on screen are inside the window, and the "…" panel is not cut off.
  await resize("wide");
  await toRail(view);
  const videoOpen = videoId ? await openFromShelf(view, "video", videoId, 8000) : false;
  const videoReady = videoOpen && await waitUntil(view, `document.querySelector('[data-testid="video-reader"][data-ready]')`, 40_000);
  for (const size of Object.keys(WINDOW_SIZES) as SizeName[]) {
    await resize(size);
    const name = `player-controls-${size}`;
    if (!videoReady) { observe(name, false, { reason: "the video did not become ready" }); continue; }
    await checkFill(size, "player", "video-reader");
    // The controls fade while idle; a mouse move over the player brings them back.
    await js(view, `document.querySelector('[data-testid="video-reader"]').dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 40, clientY: 40 }))`);
    await sleep(200);
    const controls = await js<{ controls: Rect | null; toggle: Rect | null; more: Rect | null; viewport: { w: number; h: number }; docOverflow: number }>(view, `(() => {
      const rect = ${RECT};
      const get = (id) => { const el = document.querySelector('[data-testid="' + id + '"]'); return el ? rect(el) : null; };
      return { controls: get("video-controls"), toggle: get("video-toggle"), more: get("video-more"), viewport: { w: window.innerWidth, h: window.innerHeight }, docOverflow: document.documentElement.scrollWidth - window.innerWidth };
    })()`);
    await clickTestId(view, "video-more");
    await sleep(200);
    const panel = await js<Rect | null>(view, `(() => { const rect = ${RECT}; const el = document.querySelector('[data-testid="video-more-panel"]'); return el ? rect(el) : null; })()`);
    await clickTestId(view, "video-more");
    const problems: string[] = [];
    if (!controls.controls || !inside(controls.controls, controls.viewport)) problems.push("the control bar is not inside the window");
    if (!controls.toggle || !inside(controls.toggle, controls.viewport)) problems.push("play is not reachable");
    if (!controls.more || !inside(controls.more, controls.viewport)) problems.push('the "…" button is not reachable');
    if (!panel || !inside(panel, controls.viewport)) problems.push('the "…" panel is cut off or missing');
    if (controls.docOverflow > 1) problems.push(`the window scrolls sideways by ${controls.docOverflow}px`);
    observe(name, problems.length === 0, { controls: controls.controls, panel, viewport: controls.viewport, problems });
    await capsuleCheck(`player-${size}`, ['[data-testid="video-controls"] button', '[data-testid="video-controls"] input']);
    await shot(`player-${size}`);
  }
  await resize("wide");
  if (videoReady) {
    await walkPlayerControls(view, observe, titleOf("video"));
    await walkPlayerMenus(view, observe, shot);
    await walkPlayerFullscreen(view, observe, shot);
    await walkPlayerOverlays(view, observe, shot);
    await walkDanmaku(view, observe, shot);
    // The pictures of the two readers go onto the board; then the page is left for settings, and comes back as it was (AT-88).
    if (boardId) await screenshots.video();
    await screenshots.finish();
    await walkSettingsRoundTrip(view, observe, shot);
  } else {
    observe("reader-controls-player", false, { reason: "the video did not become ready" });
    for (const name of [...PLAYER_MENU_OBSERVATIONS, "overlays-player", ...DANMAKU_OBSERVATIONS, ...RETENTION_OBSERVATIONS]) observe(name, false, { reason: "the video did not become ready" });
  }
  if (videoOpen) await closeTabs(view, ["reader"]);

  // Novel: the only bar is at the bottom; its controls come back at the bottom edge, stay in the window, and the settings panel is not cut off.
  await resize("wide");
  await toRail(view);
  const novelOpen = novelId ? await openFromShelf(view, "novel", novelId, 8000) : false;
  const novelReady = novelOpen && await waitForTestId(view, "reading-body", "data-present", null, 10_000);
  for (const size of Object.keys(WINDOW_SIZES) as SizeName[]) {
    await resize(size);
    const name = `novel-controls-${size}`;
    if (!novelReady) { observe(name, false, { reason: "the novel did not open" }); continue; }
    await checkFill(size, "novel", "reading-page");
    await revealNovelControls(view);
    const bar = await js<{ foot: Rect | null; viewport: { w: number; h: number }; docOverflow: number }>(view, `(() => {
      const rect = ${RECT};
      const get = (id) => { const el = document.querySelector('[data-testid="' + id + '"]'); return el ? rect(el) : null; };
      return { foot: get("reading-footer"), viewport: { w: window.innerWidth, h: window.innerHeight }, docOverflow: document.documentElement.scrollWidth - window.innerWidth };
    })()`);
    await clickTestId(view, "reading-settings");
    await sleep(200);
    const panel = await js<Rect | null>(view, `(() => { const rect = ${RECT}; const el = document.querySelector('[data-testid="reading-settings-panel"]'); return el ? rect(el) : null; })()`);
    await clickTestId(view, "reading-settings");
    // The real pointer rests wherever a hand left it, and one on the bar holds the bar on screen; this one is put in the middle of the page.
    view.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(bar.viewport.w / 2), y: Math.round(bar.viewport.h / 2) });
    // Hidden, the controls are out of sight and the text keeps its place: a window with nothing but reading.
    await sleep(2800);
    const hidden = await js<{ state: string | null; gap: number | null; text: boolean }>(view, `(() => {
      const root = document.querySelector('[data-testid="reading-page"]');
      const foot = document.querySelector('[data-testid="reading-footer"]');
      // The bar's upper edge, measured from the bottom of the reading page: slid out of sight it is at or below that edge.
      return { state: root?.getAttribute("data-controls") ?? null, gap: foot && root ? foot.getBoundingClientRect().top - root.getBoundingClientRect().bottom : null, text: Boolean(document.querySelector('[data-testid="reading-body"]')?.textContent) };
    })()`);
    const problems: string[] = [];
    if (!bar.foot || !inside(bar.foot, bar.viewport)) problems.push("the bottom bar is not inside the window");
    if (!panel || !inside(panel, bar.viewport)) problems.push("the settings panel is cut off or missing");
    if (bar.docOverflow > 1) problems.push(`the window scrolls sideways by ${bar.docOverflow}px`);
    if (hidden.state !== "hidden" || hidden.gap === null || hidden.gap < -1 || !hidden.text) problems.push(`the controls did not get out of the way (${JSON.stringify(hidden)})`);
    observe(name, problems.length === 0, { foot: bar.foot, panel, viewport: bar.viewport, hidden, problems });
    await shot(`novel-${size}`);
    await capsuleCheck(`novel-${size}`, ['[data-testid="reading-footer"] button']);
  }
  await resize("wide");
  if (novelReady) { await revealNovelControls(view); await walkNovelControls(view, observe, titleOf("novel")); await walkNovelOverlays(view, observe, shot); }
  else { observe("reader-controls-novel", false, { reason: "the novel did not open" }); observe("overlays-novel", false, { reason: "the novel did not open" }); }

  for (const size of Object.keys(WINDOW_SIZES) as SizeName[]) {
    const rows = fillRows[size];
    const readers = rows.map((row) => row.reader);
    const problems = ["comic", "player", "novel"].filter((reader) => !readers.includes(reader)).map((reader) => `the ${reader} reader was not measured`);
    for (const row of rows) if (!row.fills) problems.push(`the ${row.reader} reader is not the size of the main panel`);
    observe(`readers-fill-main-${size}`, problems.length === 0, { rows, problems });
  }

  const covering = capsuleRows.filter((row) => Array.isArray(row.covered) && row.covered.length > 0);
  const checkedRows = capsuleRows.filter((row) => row.shown === true && Number(row.checked) > 0);
  observe("capsule-clear-of-controls", checkedRows.length >= 4 && covering.length === 0, { rows: capsuleRows, covering });

  // ---- 7. the window frame (AT-81, AT-82, AT-105): the window's buttons, regions, history, dividers, rail, scrollbars, window full screen ------------------------
  await runFrameWalk({ view, call, observe, shot, resize, comicId, projectId });

  // ---- 8. the workspace (AT-110 — AT-118): tabs, the split, the contexts, the same file in three of them, the dock that follows the tab in front ------------------
  await runWorkspaceWalk({
    view, call, observe, shot, resize, comicId, videoId, novelId,
    titles: { comic: titleOf("comic"), video: titleOf("video"), novel: titleOf("novel") },
    projectId, boardId,
  });

  // ---- 9. managing the library: opening what cannot be opened, deleting an entry or a conversation, the model dialog, the new words ----
  await runManagementWalk({ view, appService, call, observe, shot, resize, folders, works, comicId, videoId });

  // ---- 10. the icon rail, the sidebar and its cards, the search box, the settings view, a saved layout with tabs that are gone (AT-119 — AT-122) ----
  await runRailWalk({
    view, appService, call, observe, shot, resize, projectId, boardId, videoId,
    titles: { comic: titleOf("comic"), video: titleOf("video"), novel: titleOf("novel") },
  });

  // ---- 11. the shape the next start of this Profile has to find: two contexts, the book and the library in two columns, the project's page, the window left in the project ----
  await prepareRestart({ view, call, observe, logsDir, novelId, projectId });

  const failed = observations.filter((item) => item.status !== "passed").map((item) => item.name);
  const missing = REQUIRED_OBSERVATIONS.filter((name) => !observations.some((item) => item.name === name));
  return { ok: failed.length === 0 && missing.length === 0, failed, missing, windowSizes: WINDOW_SIZES, observations };
}
