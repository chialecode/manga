import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { clickTestId, openFromShelf, revealNovelControls, waitForTestId, waitFrames, waitUntil } from "./driver.ts";
import { js, type caller } from "./common.ts";
import type { Observe } from "./reader-controls-walk.ts";
import { longChaptersEpub } from "./fixtures.ts";

/**
 * Reading a book by the page (AT-139) and the panels on the reader's left (AT-140), in the real window: a long TXT, a long EPUB of three chapters made here,
 * and the small MOBI of the fixtures, which is one page long and shows only that it opens by the page.
 */
export const NOVEL_OBSERVATIONS = ["novel-paginate", "novel-side-panel"] as const;

type Call = ReturnType<typeof caller>;
export type NovelEnv = { view: BrowserWindow; call: Call; observe: Observe; shot: (name: string) => Promise<void> };
type Page = { start: number; end: number; page: number; total: number; chapter: string };

const pageOf = (view: BrowserWindow) => js<Page | null>(view, `(() => {
  const body = document.querySelector('[data-testid="reading-body"]');
  const label = document.querySelector('[data-testid="reading-page-position"]')?.textContent ?? "";
  const hit = /第\\s*(\\d+)\\s*\\/\\s*约?\\s*(\\d+)/.exec(label);
  if (!body || !hit || !body.hasAttribute("data-page-start")) return null;
  return { start: Number(body.getAttribute("data-page-start")), end: Number(body.getAttribute("data-page-end")), page: Number(hit[1]), total: Number(hit[2]), chapter: document.querySelector('[data-testid="reading-chapter"]')?.textContent ?? "" };
})()`);

const BOOKMARK_ROW = `[data-testid^="reading-bookmark-"]:not([data-testid="reading-bookmark-add"]):not([data-testid^="reading-bookmark-remove"]):not([data-testid="reading-bookmarks"])`;

export async function walkNovelPages(env: NovelEnv): Promise<void> {
  const { view, call, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const fixture = process.env.MANGA_SMOKE_SAMPLES ? path.resolve(process.env.MANGA_SMOKE_SAMPLES, "../../../tests/fixtures/external-samples/palmdoc-sample.mobi") : "";
  const importBook = async (title: string, format: string, bytes: Buffer, key: string) => {
    const made = await call("library.importDocument", { title, format, bytes: [...bytes] }, `novel-walk-${key}`);
    if (made.status !== "ok") { problems.push(`${format}: the import failed (${JSON.stringify(made.error)})`); return null; }
    return String((made.value as { resourceId: string }).resourceId);
  };
  const txt = await importBook("分页走查 TXT", "txt", Buffer.from("第一段合成正文，用来把这本书排成好几页。\n".repeat(600)), "txt");
  const epub = await importBook("分页走查 EPUB", "epub", longChaptersEpub(3, 3000), "epub");
  const mobi = fs.existsSync(fixture) ? await importBook("分页走查 MOBI", "mobi", fs.readFileSync(fixture), "mobi") : null;
  if (!mobi) problems.push("mobi: the fixture is not there or did not import");
  // The books came in through the service; the page reads its lists again.
  await view.webContents.reload();
  await waitUntil(view, `document.querySelector('[data-testid="nav-home"]')`, 15_000);

  const open = async (name: string, id: string | null) => {
    if (!id) return false;
    const opened = await openFromShelf(view, "novel", id, 8000) && await waitForTestId(view, "reading-body", "data-present", null, 10_000);
    if (!opened) { problems.push(`${name}: the book did not open`); return false; }
    await waitUntil(view, `document.querySelector('[data-testid="reading-page-position"]') && document.querySelector('[data-testid="reading-body"]')?.hasAttribute("data-page-start")`, 4000);
    const shape = await js<{ flow: string | null; more: boolean; diagnosis: boolean; position: boolean }>(view, `(() => {
      const text = document.querySelector('[data-testid="reading-scroll"]')?.textContent ?? "";
      return { flow: document.querySelector('[data-testid="reading-scroll"]')?.getAttribute("data-flow") ?? null, more: Boolean(document.querySelector('[data-testid="reading-more"]')), diagnosis: /author page styles|reading defaults|text layer/.test(text), position: Boolean(document.querySelector('[data-testid="reading-page-position"]')) };
    })()`);
    if (shape.flow !== "paged" || !shape.position) problems.push(`${name}: it did not open by the page (${shape.flow})`);
    if (shape.more) problems.push(`${name}: there is a "continue reading" button`);
    if (shape.diagnosis) problems.push(`${name}: the parser's diagnosis is in the text`);
    return true;
  };
  const turned = async (name: string, act: () => Promise<unknown>) => {
    const before = await pageOf(view);
    await act();
    const moved = await waitUntil(view, `(() => { const label = document.querySelector('[data-testid="reading-page-position"]')?.textContent ?? ""; const hit = /第\\s*(\\d+)/.exec(label); return hit && Number(hit[1]) === ${(before?.page ?? -9) + 1}; })()`, 2500);
    if (!moved) problems.push(`${name} did not turn one page (${JSON.stringify(before)} → ${JSON.stringify(await pageOf(view))})`);
    await waitFrames(view, 2);
  };
  const stage = () => js<{ x: number; y: number; w: number; h: number }>(view, `(() => { const b = document.querySelector('[data-testid="reading-scroll"]').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const settings = async (...ids: string[]) => {
    await revealNovelControls(view);
    await clickTestId(view, "reading-settings", 3000);
    await waitUntil(view, `document.querySelector('[data-testid="reading-settings-panel"]')`, 3000);
    for (const id of ids) { await clickTestId(view, id, 3000); await waitFrames(view, 1); }
    await revealNovelControls(view);
    await clickTestId(view, "reading-settings", 3000);
    await waitUntil(view, `!document.querySelector('[data-testid="reading-settings-panel"]')`, 2000);
    await waitFrames(view, 2);
  };

  // ---- the three ways of turning a page, and the bar's ----
  if (await open("txt", txt)) {
    if (!view.isVisible()) view.showInactive();
    view.webContents.focus();
    const first = await pageOf(view);
    detail.txt = first;
    if (!first || first.total < 3) problems.push(`txt: the book is not several pages (${JSON.stringify(first)})`);
    await shot("novel-paginate-single");
    await turned("the bar's button", async () => { await revealNovelControls(view); await clickTestId(view, "reading-page-next", 2000); });
    await turned("the → key", async () => { view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" }); view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" }); });
    const box = await stage();
    await waitFrames(view, 2);
    await turned("the wheel", async () => { view.webContents.sendInputEvent({ type: "mouseWheel", x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2), deltaX: 0, deltaY: -120 }); });
    await waitFrames(view, 2);
    await turned("a click on the right third", async () => {
      const at = { x: Math.round(box.x + box.w * 0.86), y: Math.round(box.y + box.h / 2) };
      view.webContents.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
      view.webContents.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
    });

    // ---- a larger letter: more pages, and the first character of the page is still on the page ----
    const before = await pageOf(view);
    await settings("reading-font-larger", "reading-font-larger", "reading-font-larger", "reading-font-larger");
    const after = await pageOf(view);
    detail.fontChange = { before, after };
    if (!before || !after || after.total <= before.total) problems.push(`a larger letter did not make more pages (${before?.total} → ${after?.total})`);
    if (!before || !after || after.start > before.start || before.start >= after.end) problems.push(`a larger letter lost the place: the character at ${before?.start} is not in ${after?.start}—${after?.end}`);
    await settings("reading-font-smaller", "reading-font-smaller", "reading-font-smaller", "reading-font-smaller");
  }

  // ---- the end of a chapter goes on to the next, and back; a bookmark opens at its page; two pages side by side; scrolling ----
  if (await open("epub", epub)) {
    let at = await pageOf(view);
    detail.epub = at;
    const chapterOne = at?.chapter ?? "";
    if (!at || at.total < 2) problems.push(`epub: a chapter is not several pages (${JSON.stringify(at)})`);
    if (at && at.total >= 3) {
      await revealNovelControls(view);
      await clickTestId(view, "reading-page-next", 2000);
      await waitUntil(view, `(() => { const hit = /第\\s*(\\d+)/.exec(document.querySelector('[data-testid="reading-page-position"]')?.textContent ?? ""); return hit && Number(hit[1]) === 2; })()`, 2500);
      const marked = await pageOf(view);
      await clickTestId(view, "reading-bookmark-add", 2000);
      await waitFrames(view, 2);
      await clickTestId(view, "reading-page-prev", 2000);
      await waitUntil(view, `(() => { const hit = /第\\s*(\\d+)/.exec(document.querySelector('[data-testid="reading-page-position"]')?.textContent ?? ""); return hit && Number(hit[1]) === 1; })()`, 2500);
      await clickTestId(view, "reading-panel-bookmarks", 2000);
      const row = await waitUntil(view, `document.querySelector('${BOOKMARK_ROW}')`, 3000);
      await js(view, `(() => { document.querySelector('${BOOKMARK_ROW}')?.click(); return true; })()`);
      const hit = row && await waitForTestId(view, "reading-quote-hit", "data-present", null, 5000);
      await waitUntil(view, `(() => { const m = /第\\s*(\\d+)/.exec(document.querySelector('[data-testid="reading-page-position"]')?.textContent ?? ""); return m && Number(m[1]) === ${marked?.page ?? 2}; })()`, 2500);
      const back = await pageOf(view);
      detail.bookmark = { marked, back, hit };
      if (!hit || !marked || !back || back.page !== marked.page) problems.push(`a bookmark did not open at its page (${marked?.page} → ${back?.page})`);
      await clickTestId(view, "reading-panel-bookmarks", 2000);
      await waitUntil(view, `!document.querySelector('[data-testid="reading-panel"]')`, 2000);
    }
    for (let i = 0; i < 80 && at && at.chapter === chapterOne; i += 1) {
      const prevStart = at.start;
      const prevCh = at.chapter;
      await revealNovelControls(view);
      await clickTestId(view, "reading-page-next", 2000);
      await waitUntil(view, `(() => { const b = document.querySelector('[data-testid="reading-body"]'); const ch = document.querySelector('[data-testid="reading-chapter"]')?.textContent ?? ""; return Number(b?.getAttribute("data-page-start")) !== ${prevStart} || ch !== ${JSON.stringify(prevCh)}; })()`, 2000);
      at = await pageOf(view);
    }
    detail.nextChapter = at;
    if (!at || at.chapter === chapterOne || at.page !== 1) problems.push(`the last page of a chapter did not go on to the first of the next (${JSON.stringify(at)})`);
    await revealNovelControls(view);
    await clickTestId(view, "reading-page-prev", 2000);
    await waitUntil(view, `document.querySelector('[data-testid="reading-chapter"]')?.textContent === ${JSON.stringify(chapterOne)}`, 4000);
    await waitUntil(view, `(() => { const hit = /第\\s*(\\d+)\\s*\\/\\s*约?\\s*(\\d+)/.exec(document.querySelector('[data-testid="reading-page-position"]')?.textContent ?? ""); return hit && Number(hit[1]) === Number(hit[2]); })()`, 2500);
    const previous = await pageOf(view);
    detail.previousChapter = previous;
    if (!previous || previous.chapter !== chapterOne || previous.page !== previous.total) problems.push(`the first page of a chapter did not go back to the last of the one before (${JSON.stringify(previous)})`);

    await settings("reading-mode-double");
    const twoFrom = await pageOf(view);
    await revealNovelControls(view);
    await clickTestId(view, "reading-page-prev", 2000);
    await waitUntil(view, `Number(document.querySelector('[data-testid="reading-body"]')?.getAttribute("data-page-start")) < ${twoFrom?.start ?? 0}`, 2500);
    const twoTo = await pageOf(view);
    await shot("novel-paginate-double");
    detail.double = { twoFrom, twoTo };
    if (!twoFrom || !twoTo || twoTo.start >= twoFrom.start) problems.push(`two pages side by side did not turn (${JSON.stringify({ twoFrom, twoTo })})`);
    await settings("reading-mode-single");

    await settings("reading-flow-scroll");
    const scrolled = await js<{ flow: string | null; more: boolean }>(view, `({ flow: document.querySelector('[data-testid="reading-scroll"]')?.getAttribute("data-flow") ?? null, more: Boolean(document.querySelector('[data-testid="reading-more"]')) })`);
    if (scrolled.flow !== "scroll" || scrolled.more) problems.push(`scrolling is not what the setting asked for (${JSON.stringify(scrolled)})`);
    const chapterThen = await js<string>(view, `document.querySelector('[data-testid="reading-chapter"]')?.textContent ?? ""`);
    const box = await stage();
    let onward = false;
    for (let i = 0; i < 60 && !onward; i += 1) {
      await js(view, `(() => { const s = document.querySelector('[data-testid="reading-scroll"]'); s.scrollTop = s.scrollHeight; return true; })()`);
      view.webContents.sendInputEvent({ type: "mouseWheel", x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2), deltaX: 0, deltaY: -240 });
      onward = await waitUntil(view, `(document.querySelector('[data-testid="reading-chapter"]')?.textContent ?? "") !== ${JSON.stringify(chapterThen)}`, 260);
    }
    detail.scrollOnward = onward;
    if (!onward) problems.push("scrolling to the end of a chapter did not go on to the next");
    await settings("reading-flow-paged");
  }
  if (mobi) await open("mobi", mobi);
  observe("novel-paginate", problems.length === 0, { ...detail, problems });

  await walkSidePanel(env, epub);
}

async function walkSidePanel(env: NovelEnv, book: string | null): Promise<void> {
  const { view, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const [startWidth, startHeight] = view.getContentSize();
  view.setContentSize(1700, Math.max(startHeight!, 900));
  await waitUntil(view, `Math.abs(window.innerWidth - 1700) <= 4`, 2000);
  if (!book || !(await openFromShelf(view, "novel", book, 8000)) || !(await waitForTestId(view, "reading-body", "data-present", null, 10_000))) { observe("novel-side-panel", false, { problems: ["the book did not open"] }); return; }
  await waitUntil(view, `document.querySelector('[data-testid="reading-page-position"]') && document.querySelector('[data-testid="reading-body"]')?.hasAttribute("data-page-start")`, 4000);
  const place = () => js<{ placement: string | null; panelRight: number; bodyLeft: number; opened: boolean; pageWidth: number }>(view, `(() => {
    const panel = document.querySelector('[data-testid="reading-panel"]');
    const body = document.querySelector('[data-testid="reading-scroll"]');
    return { placement: panel?.getAttribute("data-placement") ?? null, panelRight: panel?.getBoundingClientRect().right ?? 0, bodyLeft: body?.getBoundingClientRect().left ?? 0, opened: Boolean(panel), pageWidth: document.querySelector('[data-testid="reading-page"]')?.getBoundingClientRect().width ?? 0 };
  })()`);
  for (const [button, name] of [["reading-panel-toc", "toc"], ["reading-panel-search", "search"], ["reading-panel-bookmarks", "bookmarks"]] as const) {
    const before = await pageOf(view);
    await revealNovelControls(view);
    await clickTestId(view, button, 3000);
    await waitUntil(view, `document.querySelector('[data-testid="reading-panel"]')?.getAttribute("data-panel") === ${JSON.stringify(name)}`, 3000);
    await waitFrames(view, 2);
    const box = await place();
    const after = await pageOf(view);
    detail[name] = { box, before, after };
    if (!box.opened || box.placement !== "left" || box.panelRight > box.bodyLeft + 1) problems.push(`${name}: the panel is not on the reader's left (${JSON.stringify(box)})`);
    if (!before || !after || after.start > before.start || before.start >= after.end) problems.push(`${name}: opening the panel lost the place (${before?.start} is not in ${after?.start}—${after?.end})`);
    if (name === "toc") { detail.readerWidth = box.pageWidth; await shot("novel-side-panel"); }
    view.webContents.focus();
    await js(view, `document.querySelector('[data-testid="${button}"]')?.focus(); true`);
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    const closed = await waitUntil(view, `!document.querySelector('[data-testid="reading-panel"]')`, 2000);
    const focus = await js<string | null>(view, `document.activeElement?.getAttribute("data-testid") ?? null`);
    if (!closed) problems.push(`${name}: Esc did not close the panel`);
    if (focus !== button) problems.push(`${name}: Esc left the focus on ${focus}`);
    await waitFrames(view, 1);
  }

  // A reader narrower than 640: the panel floats over the text, and a click on the text closes it.
  const [, height] = view.getContentSize();
  view.setContentSize(620, height!);
  await waitUntil(view, `(document.querySelector('[data-testid="reading-page"]')?.getBoundingClientRect().width ?? 999) < 640`, 3000);
  await revealNovelControls(view);
  await clickTestId(view, "reading-panel-toc", 3000);
  await waitUntil(view, `document.querySelector('[data-testid="reading-panel"]')`, 3000);
  await waitFrames(view, 2);
  const narrow = await place();
  detail.narrow = narrow;
  if (narrow.pageWidth >= 640) problems.push(`the reader is ${Math.round(narrow.pageWidth)} wide in the narrow window`);
  if (narrow.placement !== "float") problems.push(`in a narrow reader the panel is ${narrow.placement}, not floating`);
  await js(view, `(() => { document.querySelector('[data-testid="reading-body"]')?.click(); return true; })()`);
  if (!(await waitUntil(view, `!document.querySelector('[data-testid="reading-panel"]')`, 2000))) problems.push("a click on the text did not close the floating panel");
  view.setContentSize(startWidth!, startHeight!);
  await waitUntil(view, `Math.abs(window.innerWidth - ${startWidth!}) <= 4`, 2000);
  observe("novel-side-panel", problems.length === 0, { ...detail, problems });
}
