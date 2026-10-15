import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { createTranslator } from "@manga/i18n";
import { testHooks } from "../test-hooks.ts";
import { clickTestId, setField, setSelect, sleep, waitForTestId, waitUntil } from "./driver.ts";
import { js, openSettingsPage, toRail, type caller } from "./common.ts";
import type { Observe } from "./reader-controls-walk.ts";

/**
 * The management flows of the third round in the packaged window (AT-99…AT-109), with synthetic data only: a resource whose library path was removed or
 * whose file is gone asks before it opens, from the overview and from its page, and the rail stops offering it; an entry is deleted from its menu with a
 * dialog that lists what goes and what stays, and its resources are listed as not in a work with their files moved; a conversation is deleted from
 * settings › records; a model connection is added, checked, tested (it fails: nothing listens), edited and deleted in its dialog; and the pages the third
 * round gave new words are looked at for their titles, for identifiers drawn as they are, and for words about features that were taken away.
 * Each observation is named; the package stage requires every one of them to pass.
 */

export const MANAGEMENT_OBSERVATIONS = [
  "manage-open-blocked",
  "manage-entry-delete",
  "manage-conversation-delete",
  "manage-model-dialog",
  "manage-copy-titles",
] as const;

type Call = ReturnType<typeof caller>;
type Shot = (name: string) => Promise<void>;

export type ManagementEnv = {
  view: BrowserWindow;
  appService: MangaProductApp;
  call: Call;
  observe: Observe;
  shot: Shot;
  resize: (size: "wide") => Promise<void>;
  /** The folders of the walk's three library paths. */
  folders: { novel: string; comic: string; video: string };
  works: Array<{ id: string; title: string; mediaKind: string }>;
  comicId: string | null;
  videoId: string | null;
};

const t = createTranslator("zh-CN").t;

/** Whether the browser would draw a node: an `Activity` that is hidden puts `display: none` on its children. */
const SHOWN = `(el) => { for (let at = el; at; at = at.parentElement) if (getComputedStyle(at).display === "none") return false; return true; }`;

export async function runManagementWalk(env: ManagementEnv): Promise<void> {
  const { view, appService, call, observe, shot, resize, folders } = env;
  const exists = (id: string) => js<boolean>(view, `Boolean(document.querySelector('[data-testid="${id}"]'))`);
  const textOf = (id: string) => js<string>(view, `document.querySelector('[data-testid="${id}"]')?.textContent ?? ""`);
  const waitFor = (expression: string, ms = 6000) => waitUntil(view, expression, ms);
  const gone = (id: string, ms = 6000) => waitFor(`!document.querySelector('[data-testid="${id}"]')`, ms);
  const noticeText = () => js<string>(view, `[...document.querySelectorAll('[data-testid="toast-notice"]')].map((el) => el.textContent ?? "").join(" | ")`);
  const resourceOf = async (workId: string): Promise<string | null> => {
    const got = (await call("works.get", { workId })).value as { resources?: Array<{ id: string }>; lastResource?: { id: string } | null } | undefined;
    return got?.lastResource?.id ?? got?.resources?.[0]?.id ?? null;
  };
  const openableOf = async (resourceId: string): Promise<string> => String(((await call("library.openable", { resourceId })).value as { state?: string } | undefined)?.state ?? "?");
  const railState = async (resourceId: string): Promise<string> => {
    type Row = { targetId?: string | null; openState?: string; kind?: string };
    const got = (await call("workspace.sessions", { mode: "enthusiast" })).value as Row[] | { items?: Row[] } | undefined;
    const listed = Array.isArray(got) ? got : got?.items ?? [];
    return listed.find((item) => item.kind === "resource" && item.targetId === resourceId)?.openState ?? "none";
  };
  /** What the question asked before opening looks like, and whether anything opened behind it. */
  const blocked = () => js<{ shown: boolean; state: string | null; reason: string; place: string; folder: string; buttons: string[]; readers: string[]; page: string | null }>(view, `(() => {
    const shown = ${SHOWN};
    const text = (id) => document.querySelector('[data-testid="' + id + '"]')?.textContent ?? "";
    return {
      shown: Boolean(document.querySelector('[data-testid="open-blocked"]')),
      state: document.querySelector(".open-blocked")?.getAttribute("data-state") ?? null,
      reason: text("open-blocked-reason"), place: text("open-blocked-place"), folder: text("open-blocked-folder"),
      buttons: ["open-blocked-add", "open-blocked-relocate", "open-blocked-content-view", "open-blocked-close"].filter((id) => document.querySelector('[data-testid="' + id + '"]')),
      readers: ["video-reader", "comic-reader", "reading-page"].filter((id) => { const el = document.querySelector('[data-testid="' + id + '"]'); return el && shown(el); }),
      page: document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-page") ?? null,
    };
  })()`);

  /** A work's own page, opened from its card on the shelf of its medium. A work that was never opened has no file it was last at, so its card is found by the work's id as well as by the file's. */
  const openWorkPage = async (nav: string, workId: string, resourceId: string): Promise<boolean> => {
    if (!(await clickTestId(view, nav, 6000))) return false;
    const card = `[data-testid="open-${resourceId}"], [data-testid="open-work-${workId}"]`;
    const found = await waitUntil(view, `(() => {
      if (document.querySelector(${JSON.stringify(card)})) return true;
      const grid = document.querySelector('[data-testid="shelf-grid"]');
      if (grid && grid.scrollTop + grid.clientHeight < grid.scrollHeight - 1) grid.scrollTop += Math.max(100, grid.clientHeight / 2);
      return false;
    })()`, 8000);
    if (!found) return false;
    await js(view, `(() => { const el = document.querySelector(${JSON.stringify(card)}); el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true })); el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true })); return true; })()`);
    return waitForTestId(view, "page-work", "data-present", null, 8000);
  };
  /** The overview's card menu "keep reading/watching" for a work, and what the question that comes back looks like (it is left open for the caller). */
  const askFromOverview = async (workId: string) => {
    await toRail(view);
    await clickTestId(view, "nav-library");
    const overview = await waitFor(`document.querySelector('[data-testid="page-library"]') && document.querySelector('[data-testid="work-menu-${workId}"]')`, 8000);
    const before = await blocked();
    const asked = overview && await clickTestId(view, `work-menu-${workId}`) && await clickTestId(view, `work-menu-${workId}-open`) && await waitFor(`document.querySelector('[data-testid="open-blocked"]')`, 6000);
    const after = await blocked();
    return { asked: Boolean(asked), state: after.state, reason: after.reason, place: after.place, folder: after.folder, buttons: after.buttons, readers: after.readers, pageBefore: before.page, pageAfter: after.page };
  };

  await resize("wide");
  await toRail(view);

  // ---- 1. a file that cannot be opened is asked about first (A-86, AT-99) ----------------------------------------------------------------------------
  {
    const problems: string[] = [];
    const detail: Record<string, unknown> = {};
    try {
      const videoWork = env.works.find((work) => work.mediaKind === "video");
      const videoId = env.videoId;
      if (!videoWork || !videoId) problems.push("the walk's library has no video");
      else {
        const session = String(((await call("session.open", { kind: "resource", targetId: videoId })).value as { id?: string } | undefined)?.id ?? "");
        detail.railBefore = await railState(videoId);
        if (detail.railBefore !== "open") problems.push(`the rail does not offer the video before its library path is removed (${String(detail.railBefore)})`);

        // The library path of the video is removed in settings, the way a person does.
        await openSettingsPage(view, "library");
        const pathId = await js<string | null>(view, `[...document.querySelectorAll('[data-testid^="library-path-kind-"]')].find((el) => el.value === "video")?.getAttribute("data-testid")?.slice("library-path-kind-".length) ?? null`);
        const removed = pathId !== null && await clickTestId(view, `library-path-remove-${pathId}`) && await clickTestId(view, `library-path-remove-confirm-${pathId}`) && await gone(`library-path-${pathId}`, 8000);
        if (!removed) problems.push("the library path of the video could not be removed in settings");
        detail.stateAfterRemoval = await openableOf(videoId);
        if (detail.stateAfterRemoval !== "outside") problems.push(`the removed path leaves the video "${String(detail.stateAfterRemoval)}", not "outside"`);
        await sleep(400);
        detail.railAfter = await railState(videoId);
        detail.railRowShown = session ? await exists(`session-open-${session}`) : false;
        if (detail.railAfter === "open" || detail.railRowShown) problems.push("the rail still offers the video whose file is outside the library");

        // From the overview: the card's menu "keep watching" asks, and nothing opens behind the question.
        const fromOverview = await askFromOverview(videoWork.id);
        // What the question said is recorded as facts, not as text: the folder it names is a path on the machine the walk ran on.
        detail.fromOverview = { ...fromOverview, folder: fromOverview.folder !== "", place: fromOverview.place !== "" };
        if (!fromOverview.asked) problems.push("opening from the overview did not ask");
        if (fromOverview.state !== "outside" || !fromOverview.reason || !fromOverview.folder) problems.push("the question from the overview does not say the file is outside the library, or which folder");
        if (!fromOverview.buttons.includes("open-blocked-add")) problems.push("the question offers no way to add the folder");
        if (fromOverview.readers.length) problems.push(`opening from the overview opened ${fromOverview.readers.join(", ")} behind the question`);
        if (fromOverview.pageAfter !== fromOverview.pageBefore) problems.push("the page changed while the question was asked");
        await shot("open-blocked-outside");
        await clickTestId(view, "open-blocked-close");
        await gone("open-blocked");

        // From the work's own page: the file is marked as outside, "watch" is not offered, and the resource's button shows what was made on it instead.
        await toRail(view);
        const onPage = await openWorkPage("nav-video", videoWork.id, videoId) && await clickTestId(view, "detail-tab-resources", 4000) && await waitFor(`document.querySelector('[data-testid="detail-resource-${videoId}"]')`, 6000);
        const page = await js<{ read: string; readDisabled: boolean; chip: string; button: string; readers: string[] }>(view, `(() => {
          const shown = ${SHOWN};
          const read = document.querySelector('[data-testid="work-read"]');
          return {
            read: read?.textContent ?? "", readDisabled: Boolean(read?.disabled),
            chip: document.querySelector('[data-testid="detail-outside-${videoId}"]')?.textContent ?? "",
            button: document.querySelector('[data-testid="detail-open-${videoId}"]')?.textContent ?? "",
            readers: ["video-reader", "comic-reader", "reading-page"].filter((id) => { const el = document.querySelector('[data-testid="' + id + '"]'); return el && shown(el); }),
          };
        })()`);
        detail.fromWorkPage = { onPage, readDisabled: page.readDisabled, chip: page.chip, button: page.button, readers: page.readers };
        if (!onPage) problems.push("the work's page did not open");
        if (!page.readDisabled) problems.push("the work's page offers to watch a file that is outside the library");
        if (page.chip !== t("work.outside")) problems.push(`the resource on the work's page is marked "${page.chip}", not "${t("work.outside")}"`);
        if (page.button !== t("work.viewContent")) problems.push(`the resource's button on the work's page says "${page.button}", not "${t("work.viewContent")}"`);
        if (page.readers.length) problems.push(`the work's page opened ${page.readers.join(", ")}`);
        await shot("open-blocked-work-page");

        // The way forward: the folder is added again from the question, and the file opens from the work's page.
        await askFromOverview(videoWork.id);
        testHooks.pick = () => folders.video;
        const added = await clickTestId(view, "open-blocked-add") && await gone("open-blocked", 8000);
        testHooks.pick = undefined;
        await sleep(500);
        detail.folderAdded = added;
        detail.noticeAfterAdd = (await noticeText()).includes(t("open.folderAdded"));
        detail.stateAfterAdd = await openableOf(videoId);
        detail.railBack = await railState(videoId);
        if (!added) problems.push("adding the folder from the question did not close it");
        if (!detail.noticeAfterAdd) problems.push("adding the folder did not say so");
        if (detail.stateAfterAdd !== "open") problems.push(`after the folder is added the video is "${String(detail.stateAfterAdd)}"`);
        if (detail.railBack !== "open") problems.push("the rail does not offer the video again once its folder is added");
        await toRail(view);
        const reopened = await openWorkPage("nav-video", videoWork.id, videoId) && await clickTestId(view, "work-read", 8000);
        const opened = reopened && await waitFor(`(() => { const shown = ${SHOWN}; const el = document.querySelector('[data-testid="video-reader"]'); return Boolean(el) && shown(el); })()`, 20_000);
        detail.opensAgain = opened;
        if (!opened) problems.push("the video does not open after its folder was added");
        await clickTestId(view, "nav-back");
        await sleep(300);

        // A file that is not where its library path says: the question is the other one, and locating the file again opens it. The novel's text file is
        // used (an archive or a film is held open by the application, and Windows keeps such a file's name after it is deleted).
        const novelWork = env.works.find((work) => work.mediaKind === "novel" && work.title.includes("乙")) ?? env.works.find((work) => work.mediaKind === "novel");
        const novelId = novelWork ? await resourceOf(novelWork.id) : null;
        const file = path.join(folders.novel, "合成小说乙.txt");
        const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
        if (!novelWork || !novelId || !bytes) problems.push("the walk's library has no single-file novel to make go missing");
        else {
          // It is read once first, so the card knows the file it was last at.
          await toRail(view);
          const read = await openWorkPage("nav-reading", novelWork.id, novelId) && await clickTestId(view, "work-read", 8000) && await waitFor(`document.querySelector('[data-testid="reading-page"]')`, 10_000);
          if (!read) problems.push("the novel did not open before its file was removed");
          await clickTestId(view, "nav-back");
          await sleep(300);
          fs.rmSync(file, { force: true });
          detail.stateMissing = await openableOf(novelId);
          const missing = await askFromOverview(novelWork.id);
          detail.missing = { asked: missing.asked, state: missing.state, place: missing.place.includes("合成小说乙.txt"), buttons: missing.buttons, readers: missing.readers };
          if (!missing.asked || missing.state !== "missing") problems.push("a file that is gone did not get the question for a missing file");
          if (!missing.place.includes("合成小说乙.txt")) problems.push("the question does not say where the file was");
          if (!missing.buttons.includes("open-blocked-relocate")) problems.push("the question offers no way to locate the file");
          if (missing.readers.length) problems.push(`opening a missing file opened ${missing.readers.join(", ")}`);
          await shot("open-blocked-missing");
          let restored = false;
          for (let attempt = 0; attempt < 20 && !restored; attempt += 1) {
            try { fs.writeFileSync(file, bytes); restored = true; } catch { await sleep(250); }
          }
          if (!restored) problems.push("the file could not be put back");
          testHooks.pick = () => file;
          const located = restored && await clickTestId(view, "open-blocked-relocate") && await waitFor(`(() => { const shown = ${SHOWN}; const el = document.querySelector('[data-testid="reading-page"]'); return Boolean(el) && shown(el); })()`, 15_000);
          testHooks.pick = undefined;
          detail.located = located;
          if (!located) problems.push("locating the file again did not open it");
          await clickTestId(view, "nav-back");
          await sleep(300);
        }
      }
    } catch (error) {
      testHooks.pick = undefined;
      problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    observe("manage-open-blocked", problems.length === 0, { ...detail, problems });
  }

  // ---- 2. deleting an entry (A-87, AT-101): the dialog, the resources listed apart, the files where the rule puts them ---------------------------
  {
    const problems: string[] = [];
    const detail: Record<string, unknown> = {};
    try {
      const comicWork = env.works.find((work) => work.mediaKind === "comic");
      const comicId = env.comicId;
      if (!comicWork || !comicId) problems.push("the walk's library has no comic");
      else {
        await call("notes.create", { title: "删除条目前的笔记", text: "这条笔记写在漫画上，删除条目后仍在", resourceId: comicId });
        await call("session.open", { kind: "resource", targetId: comicId });
        await resize("wide");
        await toRail(view);
        await clickTestId(view, "nav-comic");
        const menu = await waitFor(`document.querySelector('[data-testid="work-menu-${comicWork.id}"]')`, 8000);
        const asked = menu && await clickTestId(view, `work-menu-${comicWork.id}`) && await clickTestId(view, `work-menu-${comicWork.id}-delete`) && await waitFor(`document.querySelector('[data-testid="delete-entry-body"]')`, 8000);
        if (!asked) problems.push("the card's menu did not open the dialog that lists what goes and what stays");
        const dialog = await js<{ removes: string; keeps: string; warning: string; keepIds: string[]; confirmEnabled: boolean }>(view, `(() => ({
          removes: document.querySelector('[data-testid="delete-entry-removes"]')?.textContent ?? "",
          keeps: document.querySelector('[data-testid="delete-entry-keeps"]')?.textContent ?? "",
          warning: document.querySelector('[data-testid="delete-entry-warning"]')?.textContent ?? "",
          keepIds: [...document.querySelectorAll('[data-testid^="delete-keeps-"]')].map((el) => el.getAttribute("data-testid").slice("delete-keeps-".length)),
          confirmEnabled: Boolean(document.querySelector('[data-testid="delete-entry-confirm"]') && !document.querySelector('[data-testid="delete-entry-confirm"]').disabled),
        }))()`);
        detail.dialog = { keepIds: dialog.keepIds, warning: dialog.warning };
        for (const needed of ["resources", "notes", "screenshots"]) if (!dialog.keepIds.includes(needed)) problems.push(`the dialog does not say the ${needed} stay`);
        if (!dialog.removes || !dialog.keeps) problems.push("the dialog lacks the list of what goes or the list of what stays");
        if (!dialog.warning.includes(t("entry.delete.irreversible"))) problems.push("the dialog does not say the deletion cannot be undone");
        if (!dialog.confirmEnabled) problems.push("the delete button is not enabled once the lists are shown");
        await shot("entry-delete-dialog");
        await clickTestId(view, "delete-entry-confirm");
        const closed = await gone("delete-entry", 8000);
        await sleep(500);
        const notice = await noticeText();
        detail.notice = notice;
        if (!closed) problems.push("the dialog stayed after the entry was deleted");
        if (!notice.includes(t("unassigned.title"))) problems.push("the notice after deleting does not say where the resources are now");
        const listed = (await call("works.list", { limit: 50 })).value as { items?: Array<{ id: string }> } | undefined;
        if ((listed?.items ?? []).some((item) => item.id === comicWork.id)) problems.push("the entry is still in the list of works");
        const loose = (await call("works.unassigned", { kind: "comic" })).value as { items?: Array<{ resourceId: string }> } | undefined;
        detail.loose = (loose?.items ?? []).length;
        if (!(loose?.items ?? []).some((item) => item.resourceId === comicId)) problems.push("the comic is not listed as not in a work");
        const row = await waitFor(`document.querySelector('[data-testid="unassigned-open-${comicId}"]')`, 8000);
        if (!row) problems.push("the comic shelf shows no group of resources not in a work");
        if (await exists(`work-${comicWork.id}`)) problems.push("the entry's card is still on the shelf");
        await shot("entry-delete-unassigned");
        // The files go to where the rule puts them, in the background; the screenshot and the note are among them.
        let located: { relDir: string; files: number; onDisk: number } | null = null;
        for (let attempt = 0; attempt < 60 && !located; attempt += 1) {
          const holders = appService.workFolders.foldersOfResource(comicId);
          const unsorted = holders.find((holder) => holder.folder.relDir.startsWith("未分类"));
          if (unsorted && unsorted.files.length > 0) {
            const onDisk = unsorted.files.filter((file) => { const where = appService.workFolders.pathOf(file.id); return Boolean(where) && fs.existsSync(where!); }).length;
            located = { relDir: unsorted.folder.relDir, files: unsorted.files.length, onDisk };
          } else await sleep(250);
        }
        detail.files = located ? { under: "未分类", files: located.files, onDisk: located.onDisk } : null;
        if (!located) problems.push("the files of the comic did not move under 未分类");
        else if (located.onDisk !== located.files) problems.push(`${located.files - located.onDisk} of the comic's files are not on disk after the move`);
        const notes = (await call("notes.list", {})).value as unknown;
        detail.noteKept = JSON.stringify(notes ?? {}).includes("删除条目前的笔记");
        if (!detail.noteKept) problems.push("the note made on the comic is gone after the entry was deleted");
      }
    } catch (error) {
      problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    observe("manage-entry-delete", problems.length === 0, { ...detail, problems });
  }

  // ---- 3. deleting a conversation in settings › records (A-89, AT-103) -------------------------------------------------------------------------------
  {
    const problems: string[] = [];
    const detail: Record<string, unknown> = {};
    try {
      const before = (await call("conversation.list", { limit: 1 })).value as { total?: number } | undefined;
      const notesBefore = JSON.stringify(((await call("notes.list", {})).value as unknown) ?? {}).length;
      const opened = await openSettingsPage(view, "records");
      await setSelect(view, "records-type", "conversation");
      const rows = opened && await waitFor(`document.querySelector('li.record-row[data-testid^="conv-"]')`, 8000);
      if (!rows) problems.push("settings › records lists no conversation");
      const pick = rows ? await js<string | null>(view, `(() => {
        const row = [...document.querySelectorAll('li.record-row[data-testid^="conv-"]')].find((el) => el.getAttribute("data-running") === "false" && !el.querySelector('[data-testid^="conv-current-"]'));
        return row ? row.getAttribute("data-testid").slice("conv-".length) : null;
      })()`) : null;
      detail.total = before?.total ?? null;
      if (rows && !pick) problems.push("every conversation listed is the current one or is running");
      if (pick) {
        // The four pieces of a row (the tick, the icon, the text, the button) stand side by side on one line, in that order.
        const layout = await js<{ order: boolean; oneLine: boolean } | null>(view, `(() => {
          const row = document.querySelector('[data-testid="conv-${pick}"]');
          const box = (selector) => row?.querySelector(selector)?.getBoundingClientRect();
          const check = box(".record-check"), icon = box(".record-icon"), main = box(".record-main"), actions = box(".record-actions");
          if (!check || !icon || !main || !actions) return null;
          return {
            order: check.right <= icon.left + 1 && icon.right <= main.left + 1 && main.right <= actions.left + 1,
            oneLine: Math.abs(check.top - icon.top) < 12 && Math.abs(icon.top - main.top) < 12 && actions.top < main.top + 40,
          };
        })()`);
        detail.rowLayout = layout;
        if (!layout || !layout.order || !layout.oneLine) problems.push("the pieces of a conversation's row are not side by side on one line");
        const asked = await clickTestId(view, `conv-delete-${pick}`) && await waitFor(`document.querySelector('[data-testid="conv-confirm"]')`, 4000);
        if (!asked) problems.push("the delete button did not ask first");
        const confirm = await js<{ removes: string; keeps: string; warning: string }>(view, `(() => ({
          removes: document.querySelector('[data-testid="conv-confirm-removes"]')?.textContent ?? "",
          keeps: document.querySelector('[data-testid="conv-confirm-keeps"]')?.textContent ?? "",
          warning: document.querySelector('[data-testid="conv-confirm-warning"]')?.textContent ?? "",
        }))()`);
        if (!confirm.removes || !confirm.keeps || !confirm.warning) problems.push("the question lacks what goes, what stays or the warning");
        await sleep(400); // the dialog fades in; a picture taken at once shows the page without it
        await shot("conversation-delete-confirm");
        await clickTestId(view, "conv-confirm-ok");
        const closed = await gone("conv-confirm", 8000);
        const rowGone = await gone(`conv-${pick}`, 8000);
        await sleep(400);
        const notice = await noticeText();
        const after = (await call("conversation.list", { limit: 1 })).value as { total?: number } | undefined;
        detail.after = after?.total ?? null;
        if (!closed || !rowGone) problems.push("the conversation is still listed after it was deleted");
        if (Number(after?.total ?? -1) !== Number(before?.total ?? 0) - 1) problems.push(`the number of conversations went from ${String(before?.total)} to ${String(after?.total)}, not down by one`);
        if (!notice.includes(t("records.conv.done", { count: 1 }))) problems.push("the notice after deleting does not say how many were deleted");
        const notesAfter = JSON.stringify(((await call("notes.list", {})).value as unknown) ?? {}).length;
        if (notesAfter < notesBefore) problems.push("notes were removed with the conversation");
        await shot("conversation-delete-after");
      }
    } catch (error) {
      problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    observe("manage-conversation-delete", problems.length === 0, { ...detail, problems });
  }

  // ---- 4. the dialog that adds and changes a model connection (MODEL-01, A-90, AT-104) ------------------------------------------------------------
  {
    const problems: string[] = [];
    const detail: Record<string, unknown> = {};
    const SECRET = "synthetic-secret-0001";
    try {
      const opened = await openSettingsPage(view, "models");
      if (!opened) problems.push("the models page did not open");
      const dialogOpen = opened && await clickTestId(view, "models-add") && await waitFor(`document.querySelector('[data-testid="connection-dialog"]')`, 4000);
      if (!dialogOpen) problems.push("the add button did not open the dialog");
      else {
        // Nothing filled in: every field that is wrong says so beside itself, the dialog stays, and the first of them has the focus.
        await clickTestId(view, "connection-dialog-save");
        await sleep(400);
        const errors = await js<{ fields: string[]; focus: string | null; open: boolean }>(view, `(() => ({
          fields: [...document.querySelectorAll('[data-testid^="field-error-"]')].map((el) => el.getAttribute("data-testid").slice("field-error-".length)),
          focus: document.activeElement?.getAttribute("data-field") ?? null,
          open: Boolean(document.querySelector('[data-testid="connection-dialog"]')),
        }))()`);
        detail.errors = errors;
        for (const field of ["baseUrl", "modelId", "secret"]) if (!errors.fields.includes(field)) problems.push(`an empty ${field} is not reported beside the field`);
        if (errors.focus !== "baseUrl") problems.push(`the focus went to ${String(errors.focus)}, not to the first field with a problem`);
        if (!errors.open) problems.push("the dialog closed with the fields empty");
        await shot("model-dialog-errors");

        // Filled in and saved: the connection is listed, without the key, and the dialog stays for the test.
        const label = "合成模型连接";
        await setField(view, "connection-label", label);
        await setField(view, "connection-base-url", "http://127.0.0.1:9/v1");
        await setField(view, "connection-model-id", "synthetic-chat");
        await setField(view, "connection-secret", SECRET);
        await setField(view, "connection-timeout", "5");
        await sleep(150);
        await clickTestId(view, "connection-dialog-save");
        const listed = await waitFor(`[...document.querySelectorAll('li.connection')].some((el) => (el.textContent || "").includes(${JSON.stringify(label)}))`, 8000);
        if (!listed) problems.push("the saved connection is not in the list");
        const row = await js<{ id: string | null; text: string }>(view, `(() => {
          const el = [...document.querySelectorAll('li.connection')].find((item) => (item.textContent || "").includes(${JSON.stringify(label)}));
          return { id: el ? el.getAttribute("data-testid").slice("connection-".length) : null, text: el?.textContent ?? "" };
        })()`);
        detail.row = { listed, raw: /openai-chat-completions|openai-responses/.test(row.text) };
        if (row.text.includes(SECRET)) problems.push("the list shows the key");
        if (/openai-chat-completions|openai-responses/.test(row.text)) problems.push("the list shows the protocol as its stored name");
        const dirtyAfterSave = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="connection-dialog-test-button"]')?.disabled)`);
        if (dirtyAfterSave) problems.push("the test button stays disabled after the connection was saved");

        // Tested in the dialog: nothing listens at that address, so the answer is a failure that is explained, and the key is not in it.
        const tested = await clickTestId(view, "connection-dialog-test-button") && await waitFor(`document.querySelector('[data-testid="connection-dialog-test"][data-state]')`, 30_000);
        const result = await js<{ state: string | null; text: string; category: string | null; dialog: string }>(view, `(() => {
          const el = document.querySelector('[data-testid="connection-dialog-test"]');
          return { state: el?.getAttribute("data-state") ?? null, text: el?.textContent ?? "", category: el?.getAttribute("data-category"), dialog: document.querySelector('[data-testid="connection-dialog"]')?.textContent ?? "" };
        })()`);
        detail.test = { tested, state: result.state, category: result.category };
        if (!tested) problems.push("the test in the dialog gave no answer");
        if (result.state !== "fail" || !result.text) problems.push("the test of an address nobody listens at did not report a failure with its reason");
        if (result.dialog.includes(SECRET)) problems.push("the dialog shows the key in the test's answer");
        await shot("model-dialog-test-failed");

        // A change, then cancel: the question about the unsaved change; keeping goes on editing, discarding closes and leaves the saved label.
        await setField(view, "connection-label", `${label}（改）`);
        await sleep(150);
        await clickTestId(view, "connection-dialog-cancel");
        const asked = await waitFor(`document.querySelector('[data-testid="connection-discard"]')`, 3000);
        if (!asked) problems.push("cancelling with an unsaved change did not ask");
        await shot("model-dialog-discard");
        await clickTestId(view, "connection-discard-keep");
        const kept = await gone("connection-discard", 3000) && await js<boolean>(view, `document.querySelector('[data-testid="connection-label"]')?.value === ${JSON.stringify(`${label}（改）`)}`);
        if (!kept) problems.push("keeping the edit lost the dialog or the typed words");
        await clickTestId(view, "connection-dialog-cancel");
        const askedAgain = await waitFor(`document.querySelector('[data-testid="connection-discard"]')`, 3000);
        const discarded = askedAgain && await clickTestId(view, "connection-discard-confirm") && await gone("connection-dialog", 4000);
        if (!discarded) problems.push("discarding the edit did not close the dialog");
        const stillSaved = await js<boolean>(view, `[...document.querySelectorAll('li.connection')].some((el) => (el.textContent || "").includes(${JSON.stringify(label)}) && !(el.textContent || "").includes("（改）"))`);
        if (!stillSaved) problems.push("the discarded edit changed the saved connection");

        // Opened again from the list: the key is not shown, and a blank key keeps the one that was stored.
        const editing = row.id !== null && await clickTestId(view, `connection-edit-${row.id}`) && await waitFor(`document.querySelector('[data-testid="connection-dialog"]')`, 4000);
        const secret = await js<{ value: string | null; hint: string; placeholder: string }>(view, `(() => {
          const el = document.querySelector('[data-testid="connection-secret"]');
          return { value: el ? el.value : null, hint: document.querySelector('[data-testid="connection-secret-hint"]')?.textContent ?? "", placeholder: el?.getAttribute("placeholder") ?? "" };
        })()`);
        detail.edit = { editing, hint: secret.hint.length > 0, placeholder: secret.placeholder.length > 0 };
        if (!editing) problems.push("the list's edit button did not open the dialog");
        if (secret.value !== "") problems.push("the edit dialog shows a stored key");
        if (!secret.hint || !secret.placeholder) problems.push("the edit dialog does not say a key is kept");
        await shot("model-dialog-edit");
        await clickTestId(view, "connection-dialog-cancel");
        await gone("connection-dialog", 4000);

        // Deleted: asked first, then gone from the list and from the settings.
        const deleting = row.id !== null && await clickTestId(view, `connection-delete-${row.id}`) && await waitFor(`document.querySelector('[data-testid="connection-delete-dialog"]')`, 3000);
        if (!deleting) problems.push("the delete button did not ask first");
        await clickTestId(view, "connection-delete-confirm");
        const removed = row.id !== null && await gone(`connection-${row.id}`, 6000);
        if (!removed) problems.push("the connection is still listed after it was deleted");
        const left = (await call("connections.list", {})).value as unknown;
        if (JSON.stringify(left ?? {}).includes(label)) problems.push("the connection is still stored after it was deleted");
      }
    } catch (error) {
      problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    observe("manage-model-dialog", problems.length === 0, { ...detail, problems });
  }

  // ---- 5. titles and words of the pages the third round changed (A-93, AT-100) -----------------------------------------------------------------------
  {
    const problems: string[] = [];
    const rows: Array<Record<string, unknown>> = [];
    const GONE_WORDS = [/导入(?:本地)?文件(?!夹)/, /导入(?:小说|漫画|动漫|书籍|整个文件夹)/, /导入 TXT/, /尚未导入资源/, /标题栏/, /托管/];
    try {
      /** What the main area shows: a stored name drawn as it is, an internal id, a word about a feature that was taken away, a value that was never filled in. */
      const leaks = () => js<string[]>(view, `(() => {
        const root = document.querySelector('[data-testid="shell-main"]');
        const text = root ? root.innerText : "";
        const found = [];
        for (const line of text.split("\\n").map((item) => item.trim()).filter(Boolean)) {
          if (/^(novel|comic|video|text|vision|embedding|transcription|native|pi|openai-chat-completions|openai-responses|undefined|null|NaN|\\[object Object\\])$/.test(line)) found.push("raw:" + line);
        }
        if (/\\b[a-z]{2,12}_[0-9a-f]{8}-[0-9a-f]{4}-/.test(text)) found.push("id");
        for (const pattern of ${JSON.stringify(GONE_WORDS.map((item) => item.source))}) if (new RegExp(pattern).test(text)) found.push("gone:" + pattern);
        return found;
      })()`);
      const look = async (name: string, how: () => Promise<boolean>, titleSelector: string, expected: string, extra: Array<[string, string]> = []) => {
        const arrived = await how();
        await sleep(500);
        const title = (await js<string>(view, `document.querySelector(${JSON.stringify(titleSelector)})?.textContent ?? ""`)).trim();
        const found = await leaks();
        const missingExtra = [];
        for (const [id, want] of extra) if (!(await textOf(id)).includes(want)) missingExtra.push(id);
        await shot(`copy-${name}`);
        rows.push({ page: name, arrived, title, expected, leaks: found, missingExtra });
        if (!arrived) problems.push(`${name}: the page did not open`);
        if (title !== expected) problems.push(`${name}: the title is "${title}", not "${expected}"`);
        if (found.length) problems.push(`${name}: ${found.join(", ")}`);
        if (missingExtra.length) problems.push(`${name}: ${missingExtra.join(", ")} lack their words`);
      };
      await toRail(view);
      await look("overview", async () => (await clickTestId(view, "nav-library")) && await waitFor(`document.querySelector('[data-testid="shelf-all"]')`, 6000), '[data-testid="shelf-title"]', t("shelf.title.all"));
      await look("novel", async () => (await clickTestId(view, "nav-reading")) && await waitFor(`document.querySelector('[data-testid="shelf-novel"]')`, 6000), '[data-testid="shelf-title"]', t("shelf.title.novel"));
      await look("comic", async () => (await clickTestId(view, "nav-comic")) && await waitFor(`document.querySelector('[data-testid="shelf-comic"]')`, 6000), '[data-testid="shelf-title"]', t("shelf.title.comic"), [["unassigned-group", t("unassigned.title")]]);
      await look("video", async () => (await clickTestId(view, "nav-video")) && await waitFor(`document.querySelector('[data-testid="shelf-video"]')`, 6000), '[data-testid="shelf-title"]', t("shelf.title.video"));
      await look("storage", async () => openSettingsPage(view, "storage"), '[data-testid="settings-page-storage"] h2', t("settings.page.storage"), [["storage-overview", t("storage.overview")]]);
      await look("models", async () => openSettingsPage(view, "models"), '[data-testid="settings-page-models"] h2', t("settings.page.models"));
    } catch (error) {
      problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    observe("manage-copy-titles", problems.length === 0 && rows.length === 6, { rows, problems });
  }

  await toRail(view);
}
