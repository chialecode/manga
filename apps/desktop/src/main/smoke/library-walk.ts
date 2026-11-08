import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { createTranslator } from "@manga/i18n";
import { DRAWN, clickTestId, closeTabs, openLibrary, openShelf, setField, sleep, waitFrames, waitUntil } from "./driver.ts";
import { js, openSettingsPage, toRail, type caller } from "./common.ts";
import type { Observe } from "./reader-controls-walk.ts";

/**
 * The library in the packaged window (A-113, A-114, AT-137, AT-138), with synthetic files only: a scan of twenty works shows the first one done
 * on its shelf while the rest are still read, and the lists of the library show only what is in a library path, the files that are gone marked as
 * such, with the settings' outside section counting the rest and the resources of a deleted entry opened, put in a work and identified again.
 */
export const LIBRARY_OBSERVATIONS = ["scan-incremental", "library-in-locations"] as const;

type Call = ReturnType<typeof caller>;
/** The part of the scan's link to the application that the walk slows down and listens to. */
type ScanHost = {
  importUnit(request: unknown, signal: AbortSignal): Promise<unknown>;
  afterImport(resourceIds: string[]): void;
  notify(topic: string, payload: Record<string, unknown>): void;
};

export type LibraryEnv = {
  view: BrowserWindow;
  appService: MangaProductApp;
  call: Call;
  observe: Observe;
  shot: (name: string) => Promise<void>;
  resize: (size: "wide") => Promise<void>;
  folders: { novel: string; comic: string; video: string };
};

const t = createTranslator("zh-CN").t;
const SERIES = 20;
const PER_SERIES = 5;
/** How long each file of the scan takes to import: slow enough that the scan is still running when the first works are shown. */
const IMPORT_DELAY_MS = 60;
const seriesName = (index: number) => `批量系列${String(index).padStart(2, "0")}`;
const chapter = (title: string) => `${title}\n\n${"这是用于扫描与资源库位置走查的一段合成文字。".repeat(30)}\n`;

export async function runLibraryWalk(env: LibraryEnv): Promise<{ manyPathId: string | null }> {
  const { view, appService, call, observe, shot, resize, folders } = env;
  const waitFor = (expression: string, ms = 6000) => waitUntil(view, expression, ms);
  const gone = (id: string, ms = 6000) => waitFor(`!document.querySelector('[data-testid="${id}"]')`, ms);
  const exists = (id: string) => js<boolean>(view, `Boolean(document.querySelector('[data-testid="${id}"]'))`);
  const noticeText = () => js<string>(view, `[...document.querySelectorAll('[data-testid="toast-notice"]')].map((el) => el.textContent ?? "").join(" | ")`);
  const value = async <T>(commandId: string, input: Record<string, unknown>): Promise<T> => {
    const result = await call(commandId, input);
    if (result.status !== "ok") throw new Error(`${commandId}: ${JSON.stringify(result)}`);
    return result.value as T;
  };
  type Summary = { id: string; title: string; missingCount: number; outsideCount: number; lastResource: { id: string } | null };
  const works = async (query?: string) => (await value<{ items: Summary[] }>("works.list", { limit: 200, ...(query ? { query } : {}) })).items;
  const readerShown = (ms: number) => waitFor(`${DRAWN}(document.querySelector('[data-testid="reading-page"]'))`, ms);
  const clickCard = (selector: string) => js<boolean>(view, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    return true;
  })()`);
  const base = path.dirname(folders.novel);
  const many = path.join(base, "scan-many");
  let manyPathId: string | null = null;

  await resize("wide");
  await toRail(view);

  // ---- 1. a scan shows each work as soon as its files are in (A-114, AT-138) ------------------------------------------------------------------
  {
    const problems: string[] = [];
    const detail: Record<string, unknown> = {};
    const host = (appService.scan as unknown as { host: ScanHost }).host;
    const original = { importUnit: host.importUnit, afterImport: host.afterImport, notify: host.notify };
    const started = Date.now();
    const seen: { progressAt: number | null; workIds: string[]; afterImport: number[]; finishedAt: number | null } = { progressAt: null, workIds: [], afterImport: [], finishedAt: null };
    try {
      for (let index = 1; index <= SERIES; index += 1) {
        const folder = path.join(many, seriesName(index));
        fs.mkdirSync(folder, { recursive: true });
        for (let part = 1; part <= PER_SERIES; part += 1) fs.writeFileSync(path.join(folder, `第${part}章.txt`), chapter(`${seriesName(index)} 第${part}章`));
      }
      let slowScan = true;
      host.importUnit = async (request, signal) => {
        if (slowScan) await sleep(IMPORT_DELAY_MS); // real time: throttle importUnit so scan is still running when first works appear
        return original.importUnit.call(host, request, signal);
      };
      host.afterImport = (resourceIds) => { seen.afterImport.push(Date.now() - started); original.afterImport.call(host, resourceIds); };
      host.notify = (topic, payload) => {
        if (topic === "work.updated" && payload.reason === "scan-progress" && seen.progressAt === null) {
          seen.progressAt = Date.now() - started;
          seen.workIds = Array.isArray(payload.workIds) ? payload.workIds.map(String) : [];
        }
        if (topic === "scan.finished" && seen.finishedAt === null && seen.progressAt !== null) seen.finishedAt = Date.now() - started;
        original.notify.call(host, topic, payload);
      };

      // The novel shelf is in front, narrowed to the new series, before the folder is added.
      const shelf = await openShelf(view, "novel", 8000) && await setField(view, "shelf-search", "批量系列");
      if (!shelf) problems.push("the novel shelf did not open with its search");
      const added = await value<{ path: { id: string } }>("library.paths.add", { pathHandle: appService.registerPath("directory", many), mediaKind: "novel" });
      manyPathId = added.path.id;

      // The first card of the new works, and whether the scan is still running then.
      let cardAt: number | null = null;
      let cardWork: string | null = null;
      let runningAtCard = false;
      while (Date.now() - started < 30_000 && cardAt === null) {
        if (seen.progressAt !== null) {
          const ids = seen.workIds;
          cardWork = await js<string | null>(view, `(${JSON.stringify(ids)}).find((id) => document.querySelector('[data-testid="work-' + id + '"]')) ?? null`);
          if (cardWork) {
            cardAt = Date.now() - started;
            runningAtCard = Boolean((await value<{ running: unknown }>("library.scan.status", {})).running);
          }
        }
        if (cardAt === null) await sleep(50); // real time: poll shelf DOM while incremental scan is in progress
      }
      detail.progressAt = seen.progressAt;
      detail.cardAt = cardAt;
      detail.cardAfterProgressMs = cardAt !== null && seen.progressAt !== null ? cardAt - seen.progressAt : null;
      detail.runningAtCard = runningAtCard;
      if (seen.progressAt === null) problems.push("the scan never said a work was done while it ran");
      else if (cardAt === null) problems.push("no work done by the scan appeared on the novel shelf");
      else if (cardAt - seen.progressAt > 1500) problems.push(`the first work done appeared ${cardAt - seen.progressAt} ms after the scan said so, more than 1500 ms`);
      if (cardAt !== null && !runningAtCard) problems.push("the scan was over before the first work appeared, so nothing showed it early");
      await shot("scan-incremental-first");

      // It opens while the scan goes on: its card opens the work's own page (as every card does), and reading starts there.
      if (cardWork) {
        const opened = await clickCard(`[data-work-open="${cardWork}"]`)
          && await waitFor(`document.querySelector('[data-testid="page-work"]')`, 8000)
          && await clickTestId(view, "work-read", 8000);
        const read = opened && await readerShown(15_000);
        const runningAtOpen = Boolean((await value<{ running: unknown }>("library.scan.status", {})).running);
        detail.opened = { read, runningAtOpen };
        if (!read) problems.push("the first work shown did not open");
        if (read && !runningAtOpen) problems.push("the scan was over before the first work opened");
        await closeTabs(view, ["reader"]);
      }

      slowScan = false;
      await appService.scan.whenIdle();
      await waitFrames(view, 2);
      const listed = (await works("批量系列")).filter((item) => item.title.startsWith("批量系列"));
      detail.works = listed.length;
      detail.afterImport = { calls: seen.afterImport.length, first: seen.afterImport[0] ?? null, finishedAt: seen.finishedAt };
      if (listed.length !== SERIES) problems.push(`the scan made ${listed.length} works, not ${SERIES}`);
      if (!seen.afterImport.length) problems.push("the covers and file facts were never started for the new resources");
      else if (seen.finishedAt !== null && seen.afterImport[0]! >= seen.finishedAt) problems.push("the covers and file facts started only when the scan was over, not as each work was done");
      // The shelf is still narrowed to the new series: its cards are the works the scan made.
      await openShelf(view, "novel", 8000);
      await setField(view, "shelf-search", "批量系列");
      await waitFor(`document.querySelectorAll('[data-work-open]').length > 0`, 4000);
      const cards = await js<number>(view, `document.querySelectorAll('[data-work-open]').length`);
      detail.cardsShown = cards;
      if (cards === 0) problems.push("the shelf shows no card of the new works once the scan is over");
    } catch (error) {
      problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      Object.assign(host, original);
      await setField(view, "shelf-search", "").catch(() => false);
    }
    observe("scan-incremental", problems.length === 0, { ...detail, problems });
  }

  // ---- 2. the lists of the library show only what is in a library path (A-113, AT-137) -----------------------------------------------------
  {
    const problems: string[] = [];
    const detail: Record<string, unknown> = {};
    try {
      if (!manyPathId) throw new Error("the scanned path of the first part is not there");
      // A resource outside every library path: its folder was a library path, something was written on it, and the path was removed.
      const outsideRoot = path.join(base, "outside-tmp");
      fs.mkdirSync(path.join(outsideRoot, "库外系列"), { recursive: true });
      fs.writeFileSync(path.join(outsideRoot, "库外系列", "库外的书.txt"), chapter("库外的书"));
      const outsidePath = await value<{ path: { id: string } }>("library.paths.add", { pathHandle: appService.registerPath("directory", outsideRoot), mediaKind: "novel" });
      await appService.scan.whenIdle();
      const outsideWork = (await works("库外系列")).find((item) => item.title === "库外系列");
      const outsideResource = outsideWork?.lastResource?.id ?? (outsideWork ? (await value<{ resources: Array<{ id: string }> }>("works.get", { workId: outsideWork.id })).resources[0]?.id : undefined);
      if (!outsideWork || !outsideResource) throw new Error("the outside folder made no work");
      await value("notes.create", { title: "库外资源的笔记", text: "写在库外的书上", resourceId: outsideResource });
      await value("library.paths.remove", { pathId: outsidePath.path.id });

      // A resource whose file is gone from its place in a library path.
      const missingWork = (await works(seriesName(SERIES))).find((item) => item.title === seriesName(SERIES));
      fs.rmSync(path.join(many, seriesName(SERIES), `第${PER_SERIES}章.txt`), { force: true });
      await value("library.scan.start", { pathId: manyPathId });
      await appService.scan.whenIdle();
      if (!missingWork) throw new Error("the series whose file goes missing is not there");

      // Every list: the works, the library's resources, the sidebar of the novels and the search box.
      const listedWorks = await works();
      const library = await value<{ items: Array<{ id: string }> }>("library.list", {});
      const sidebar = JSON.stringify(await value("workspace.sidebar", { view: "novel" }));
      const home = JSON.stringify(await value("workspace.sidebar", { view: "home" }));
      const found = JSON.stringify(await value("workspace.find", { q: "库外" }));
      const missingCard = listedWorks.find((item) => item.id === missingWork.id);
      detail.lists = {
        works: listedWorks.some((item) => item.id === outsideWork.id),
        library: library.items.some((item) => item.id === outsideResource),
        sidebar: sidebar.includes(outsideWork.id) || sidebar.includes(outsideResource),
        home: home.includes(outsideWork.id) || home.includes(outsideResource),
        find: found.includes(outsideResource) || found.includes(outsideWork.id),
        missing: missingCard ? { listed: true, missingCount: missingCard.missingCount } : { listed: false },
      };
      for (const [name, listed] of Object.entries(detail.lists as Record<string, unknown>)) if (name !== "missing" && listed === true) problems.push(`the ${name} list still has the resource outside the library paths`);
      if (!missingCard) problems.push("the work with a missing file is no longer listed");
      else if (missingCard.missingCount !== 1) problems.push(`the work with a missing file says ${missingCard.missingCount} files are gone, not 1`);

      // The overview and the shelves, as drawn.
      await toRail(view);
      await openLibrary(view);
      await waitFor(`document.querySelector('[data-testid="page-library"] [data-testid^="work-"]')`, 8000);
      const onOverview = await exists(`work-${outsideWork.id}`) || await exists(`work-menu-${outsideWork.id}`);
      const novel = await openShelf(view, "novel", 8000) && await setField(view, "shelf-search", "系列");
      await waitFor(`document.querySelector('[data-testid="work-${missingWork.id}"]')`, 4000);
      const shelfFacts = await js<{ outside: boolean; missing: boolean; flags: string }>(view, `({
        outside: Boolean(document.querySelector('[data-testid="work-${outsideWork.id}"]')),
        missing: Boolean(document.querySelector('[data-testid="work-${missingWork.id}"]')),
        flags: document.querySelector('[data-testid="work-flags-${missingWork.id}"]')?.textContent ?? "",
      })`);
      detail.drawn = { onOverview, novel, ...shelfFacts };
      if (onOverview) problems.push("the overview shows the work outside the library paths");
      if (shelfFacts.outside) problems.push("the novel shelf shows the work outside the library paths");
      if (!shelfFacts.missing) problems.push("the novel shelf does not show the work with a missing file");
      else if (!shelfFacts.flags.includes(t("card.missing"))) problems.push(`the card of the work with a missing file is not marked (${shelfFacts.flags})`);
      await shot("library-missing-mark");
      await setField(view, "shelf-search", "");

      // The settings' outside section counts it; removing its records changes no list and keeps the note.
      const outside = await value<{ total: number }>("library.outside", {});
      await openSettingsPage(view, "library");
      const section = await waitFor(`document.querySelector('[data-testid="library-outside-${outsideResource}"]')`, 8000);
      const sectionFacts = await js<{ title: string; items: number }>(view, `({
        title: document.querySelector('[data-testid="library-outside"]')?.textContent ?? "",
        items: document.querySelectorAll('[data-testid="library-outside"] .outside-item').length,
      })`);
      detail.section = { shown: section, total: outside.total, items: sectionFacts.items, titled: sectionFacts.title.includes(t("outside.title", { count: outside.total })) };
      if (!section) problems.push("the outside section does not list the resource");
      if (sectionFacts.items !== outside.total) problems.push(`the outside section lists ${sectionFacts.items} resources, the library counts ${outside.total}`);
      if (!sectionFacts.title.includes(t("outside.title", { count: outside.total }))) problems.push("the outside section's title does not carry the count");
      const countsBefore = { works: (await works()).length, library: (await value<{ items: unknown[] }>("library.list", {})).items.length };
      const removed = await clickTestId(view, "library-outside-remove") && await waitFor(`document.querySelector('[data-testid="library-outside-confirm"]')`, 4000)
        && await clickTestId(view, "library-outside-confirm-remove") && await gone("library-outside", 8000);
      await waitFrames(view, 2);
      const countsAfter = { works: (await works()).length, library: (await value<{ items: unknown[] }>("library.list", {})).items.length };
      const notes = JSON.stringify(await value("notes.list", {}));
      detail.removal = { removed, countsBefore, countsAfter, noteKept: notes.includes("库外资源的笔记"), outsideAfter: (await value<{ total: number }>("library.outside", {})).total };
      if (!removed) problems.push("removing the outside records from the section did not empty it");
      if (countsBefore.works !== countsAfter.works || countsBefore.library !== countsAfter.library) problems.push(`removing the outside records changed the lists (${JSON.stringify(countsBefore)} → ${JSON.stringify(countsAfter)})`);
      if (!notes.includes("库外资源的笔记")) problems.push("the note written on the outside resource is gone after its records were removed");

      // An entry is deleted: its resources open, go into a work and are identified again from the shelf's group of resources not in a work.
      const deleted = (await works(seriesName(SERIES - 1))).find((item) => item.title === seriesName(SERIES - 1));
      const target = (await works(seriesName(SERIES - 2))).find((item) => item.title === seriesName(SERIES - 2));
      if (!deleted || !target) throw new Error("the series used for the deleted entry are not there");
      await value("works.delete", { workId: deleted.id });
      // The walk leaves no other novel out of a work, so the ones not in a work are the deleted entry's.
      const loose = (await value<{ items: Array<{ resourceId: string }> }>("works.unassigned", { kind: "novel" })).items.map((item) => item.resourceId);
      detail.loose = loose.length;
      if (loose.length !== PER_SERIES) problems.push(`deleting the entry left ${loose.length} novels not in a work, not ${PER_SERIES}`);
      const [toOpen, toAssign, toIdentify] = loose;
      if (!toOpen || !toAssign || !toIdentify) throw new Error("the deleted entry left fewer than three resources not in a work");
      await toRail(view);
      await openShelf(view, "novel", 8000);
      const group = await waitFor(`document.querySelector('[data-testid="unassigned-open-${toOpen}"]')`, 8000);
      const opened = group && await clickTestId(view, `unassigned-open-${toOpen}`) && await readerShown(15_000);
      await closeTabs(view, ["reader"]);
      await openShelf(view, "novel", 8000);
      await waitFor(`document.querySelector('[data-testid="unassigned-menu-${toAssign}"]')`, 8000);
      const assigned = await clickTestId(view, `unassigned-menu-${toAssign}`) && await clickTestId(view, `unassigned-menu-${toAssign}-assign`)
        && await waitFor(`document.querySelector('[data-testid="work-move"]')`, 4000)
        && await setField(view, "work-move-query", seriesName(SERIES - 2))
        && await clickTestId(view, `work-move-to-${target.id}`, 8000) && await gone("work-move", 8000);
      await waitFrames(view, 2);
      const inTarget = ((await value<{ resources: Array<{ id: string }> }>("works.get", { workId: target.id })).resources ?? []).some((item) => item.id === toAssign);
      await waitFor(`document.querySelector('[data-testid="unassigned-menu-${toIdentify}"]')`, 8000);
      const identified = await clickTestId(view, `unassigned-menu-${toIdentify}`) && await clickTestId(view, `unassigned-menu-${toIdentify}-reidentify`)
        && await gone(`unassigned-${toIdentify}`, 8000);
      await waitFor(`document.querySelector('[data-testid="toast-notice"]')`, 3000);
      const stillLoose = (await value<{ items: Array<{ resourceId: string }> }>("works.unassigned", { kind: "novel" })).items.some((item) => item.resourceId === toIdentify);
      const notice = await noticeText();
      detail.unassigned = { opened, assigned, inTarget, identified, stillLoose, said: notice.includes(t("unassigned.reidentified", { count: 1 })) };
      if (!opened) problems.push("a resource not in a work did not open from the shelf");
      if (!assigned || !inTarget) problems.push("putting a resource not in a work into a work did not take");
      if (!identified || stillLoose) problems.push("identifying a resource not in a work again left it not in a work");
      await shot("library-unassigned");
    } catch (error) {
      problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    observe("library-in-locations", problems.length === 0, { ...detail, problems });
  }

  await toRail(view);
  return { manyPathId };
}
