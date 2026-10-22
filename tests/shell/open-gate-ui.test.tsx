/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTranslator } from "@manga/i18n";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { OpenBlockedDialog, type OpenBlock } from "../../apps/desktop/src/renderer/pages/open-blocked-dialog.tsx";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { installMatchMedia, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";
import { contextHandlers, type SessionRow } from "../helpers/app-host.ts";
import { focusedTitle, tabTitles } from "../helpers/workspace-ui.ts";

Element.prototype.scrollIntoView = () => {};

/**
 * What a person sees when the file of a resource cannot be opened (A-86, AT-99): a question before anything opens, the page staying where it is, and
 * the way forward that fits the reason. The main process says which of the two it is; this checks that the interface asks, does not open, and does
 * not lose what was made on the resource.
 */
const i18n = createTranslator("zh-CN");
const t = i18n.t;

const BOOK = (input: Record<string, unknown>) => ({
  resourceId: input.resourceId, revisionId: "rev_ok", title: "合成小说", format: "txt", warnings: [], toc: [],
  parts: [{ id: "body", kind: "body", length: 4, textLayer: true }],
  slice: { partId: "body", text: "合成正文", start: 0, end: 4, kind: "text", textLayer: true },
  source: { available: true },
});
const WORK = { id: "w1", title: "合成作品", author: "合成作者", mediaKind: "comic", shelf: "reading", coverId: null, lastResource: null, progress: 0, finishedCount: 0, resourceCount: 0, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null };

type Handler = (input: Record<string, unknown>) => unknown;
type Call = { commandId: string; input: Record<string, unknown> };
type Notice = { topic: string; payload: Record<string, unknown> };

function installHost(handlers: Record<string, Handler> = {}, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  /** The conversations the synthetic sidebar lists; a test pushes its own. */
  const sessions: SessionRow[] = [{ sessionId: "ses_shared", title: "会话 1", kind: "shared", targetId: null, contextId: null, runCount: 0, activeRunId: null, activeRunStatus: null }];
  const listeners = new Set<(notice: Notice) => void>();
  const base: Record<string, Handler> = {
    "notes.list": () => [],
    "works.list": (input) => { const items = input.kind && input.kind !== "comic" ? [] : [WORK]; return { items, total: items.length, nextCursor: null }; },
    ...contextHandlers({ facets: ["agent", "library", "comic", "video", "settings"], sessions }).handlers,
    "settings.get": () => ({ needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: [{ purpose: "text" }] }),
    "inventory.overview": () => ({ items: [], totals: {} }),
    "quickTasks.list": () => ({ tasks: [] }),
    "capture.list": () => ({ sessions: [] }),
    "library.read": BOOK,
    ...handlers,
  };
  (window as unknown as { manga: unknown }).manga = {
    async state() { return { layout: { channel: "test", pointerPath: "pointer.json", partitions: { data: "profile-data" }, writable: true, recovery: "none" }, writable: true, vaultAvailable: true }; },
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = base[payload.commandId];
      const value = handler ? handler(input) : {};
      if (value && typeof value === "object" && "__error" in value) return { status: "error", error: (value as { __error: unknown }).__error };
      return { status: "ok", value };
    },
    onNotice(listener: (notice: Notice) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async chooseDirectory() { return null; },
    async chooseFile() { return null; },
    async chooseAudio() { return null; },
    async stashSecret() { return null; },
    async reveal() { return { status: "ok", value: {} }; },
    ...extra,
  };
  return {
    calls,
    sessions,
    of: (id: string) => calls.filter((call) => call.commandId === id),
    notify: (notice: Notice) => act(() => { for (const listener of listeners) listener(notice); }),
  };
}

beforeEach(() => {
  window.innerWidth = 1600;
  installMatchMedia({ reducedMotion: true });
  installPointerEvent();
  quoteTags.reset(); readerContext.reset(); resetCovers(); shelfMemory.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); removeMatchMedia(); quoteTags.reset(); readerContext.reset(); });

const block = (extra: Partial<OpenBlock> = {}): OpenBlock => ({ resourceId: "res_1", mediaKind: "video", title: "第 1 话", workId: "work_1", state: "outside", folder: "synthetic-folder", ...extra });
const dialog = (props: Partial<Parameters<typeof OpenBlockedDialog>[0]> & { block?: OpenBlock } = {}) => {
  const handlers = { onClose: vi.fn(), onReady: vi.fn(), onOpenNote: vi.fn(), onError: vi.fn(), onNotice: vi.fn() };
  render(<OpenBlockedDialog t={t} block={props.block ?? block()} formatDate={(value) => String(value)} {...handlers} {...props} />);
  return handlers;
};

describe("the question for a file outside every library path", () => {
  it("offers the folder as a library path, says nothing was changed, and adds it only on that choice", async () => {
    const host = installHost({ "library.paths.add": () => ({ path: { id: "lp1" } }) }, { pick: vi.fn(async () => ({ pathHandle: "handle-dir" })) });
    const handlers = dialog();
    expect(screen.getByTestId("open-blocked-reason").textContent).toBe(t("open.outside.body"));
    expect(screen.getByTestId("open-blocked-folder").textContent).toContain("synthetic-folder");
    expect(screen.queryByTestId("open-blocked-relocate")).toBeNull();
    expect(host.calls).toEqual([]);

    await userEvent.click(screen.getByTestId("open-blocked-add"));
    await waitFor(() => expect(host.of("library.paths.add")).toHaveLength(1));
    const pick = (window.manga as unknown as { pick: ReturnType<typeof vi.fn> }).pick;
    expect(pick).toHaveBeenCalledWith({ mode: "directory", defaultPath: "synthetic-folder" });
    expect(host.of("library.paths.add")[0]!.input).toEqual({ pathHandle: "handle-dir", mediaKind: "video" });
    expect(handlers.onNotice).toHaveBeenCalledWith(t("open.folderAdded"));
    expect(handlers.onClose).toHaveBeenCalled();
    expect(handlers.onReady).not.toHaveBeenCalled();
  });

  it("offers to locate the file when the folder it was in is not known", async () => {
    installHost({}, { pick: vi.fn(async () => null) });
    dialog({ block: block({ folder: null }) });
    expect(screen.queryByTestId("open-blocked-add")).toBeNull();
    expect(screen.getByTestId("open-blocked-relocate")).toBeTruthy();
    expect(screen.queryByTestId("open-blocked-folder")).toBeNull();
  });
});

describe("the question for a file that is not where its library path says", () => {
  const missing = (extra: Partial<OpenBlock> = {}) => block({ state: "missing", folder: undefined, libraryPath: "library-folder", relativePath: "甲/第1话.mp4", rootReachable: true, ...extra });

  it("says where the file was, and locating it opens it once the file is accepted", async () => {
    const host = installHost({
      "library.resourceContent": () => ({ resource: { kind: "video", libraryRoot: "library-folder", folderToAdd: null } }),
      "library.repairSource": () => ({ pointersKept: 0 }),
    }, { pick: vi.fn(async () => ({ pathHandle: "handle-file" })) });
    const handlers = dialog({ block: missing() });
    expect(screen.getByTestId("open-blocked-reason").textContent).toBe(t("open.missing.body"));
    expect(screen.getByTestId("open-blocked-place").textContent).toContain("甲/第1话.mp4");
    expect(screen.queryByTestId("open-blocked-add")).toBeNull();

    await userEvent.click(screen.getByTestId("open-blocked-relocate"));
    await waitFor(() => expect(handlers.onReady).toHaveBeenCalled());
    expect(host.of("library.repairSource")[0]!.input).toEqual({ resourceId: "res_1", pathHandle: "handle-file" });
    expect(handlers.onNotice).toHaveBeenCalledWith(t("reading.sourceRepairDone"));
  });

  it("says the whole library folder is gone when that is the case", () => {
    installHost();
    dialog({ block: missing({ rootReachable: false }) });
    expect(screen.getByTestId("open-blocked-reason").textContent).toBe(t("open.missing.rootGone"));
  });

  it("keeps the dialog and offers the folder when the located file lies outside every library path", async () => {
    const host = installHost({
      "library.resourceContent": () => ({ resource: { kind: "video", libraryRoot: "library-folder", folderToAdd: null } }),
      "library.repairSource": () => ({ __error: { code: "VALIDATION_ERROR", message: "outside", details: { reason: "outside-library", folder: "picked-folder" } } }),
      "library.paths.add": () => ({ path: { id: "lp2" } }),
    }, { pick: vi.fn(async () => ({ pathHandle: "handle-x" })) });
    const handlers = dialog({ block: missing() });
    await userEvent.click(screen.getByTestId("open-blocked-relocate"));
    const pending = await screen.findByTestId("open-blocked-pending");
    expect(pending.textContent).toContain("picked-folder");
    expect(handlers.onReady).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("open-blocked-add-picked"));
    await waitFor(() => expect(host.of("library.paths.add")).toHaveLength(1));
    expect(handlers.onNotice).toHaveBeenCalledWith(t("open.folderAdded"));
  });
});

describe("what was made on the resource can be looked at without its file", () => {
  it("opens the notes and records in a drawer, and a note opens from it", async () => {
    installHost({
      "library.resourceContent": () => ({
        resource: { id: "res_1", title: "第 1 话", kind: "video", ordinalLabel: null, workId: "work_1", workTitle: "合成作品", available: false, outside: true, path: null, libraryRoot: null, folderToAdd: "synthetic-folder" },
        progress: { percent: 0.4, completion: "inProgress" },
        notes: [{ objectId: "obj_1", title: "留下的笔记", preview: "评论", updatedAt: "2026-01-01T00:00:00.000Z" }],
        bookmarks: [], recordings: [], conversation: null,
      }),
    });
    const handlers = dialog();
    await userEvent.click(screen.getByTestId("open-blocked-content-view"));
    const drawer = await screen.findByTestId("open-blocked-content");
    expect(within(drawer).getByTestId("resource-content-title").textContent).toContain("第 1 话");
    expect(within(drawer).getByText("留下的笔记")).toBeTruthy();
    await userEvent.click(within(drawer).getByText("留下的笔记"));
    expect(handlers.onOpenNote).toHaveBeenCalledWith("obj_1");
    expect(handlers.onClose).toHaveBeenCalled();
  });
});

describe("the application asks before it opens (AT-99)", () => {
  const loose = (id: string, kind: string, title: string) => ({ resourceId: id, kind, title, ordinalLabel: null, leftWorkAt: null, lastOpenedAt: null, outside: false });
  const openable = (state: "open" | "outside" | "missing", extra: Record<string, unknown> = {}) => (input: Record<string, unknown>) => ({ resourceId: input.resourceId, mediaKind: "video", title: "合成视频", workId: null, state, ...(state === "outside" ? { folder: "synthetic-folder" } : state === "missing" ? { libraryPathId: "lp1", libraryPath: "library-folder", relativePath: "合成视频.mp4", rootReachable: true } : { path: "x" }), ...extra });
  /** Where the person is: the tabs there are and the one in front. */
  const place = () => ({ tabs: tabTitles(), front: focusedTitle() });

  it("shows the question for a file outside, does not leave the page, and does not ask the main process to open anything", async () => {
    const host = installHost({
      "works.unassigned": () => ({ items: [loose("res_out", "video", "合成视频")], total: 1 }),
      "library.openable": openable("outside"),
    });
    render(<App />);
    const open = await screen.findByTestId("unassigned-open-res_out");
    const before = place();
    await userEvent.click(open);
    const asked = await screen.findByTestId("open-blocked");
    expect(within(asked).getByTestId("open-blocked-reason").textContent).toBe(t("open.outside.body"));
    expect(place()).toEqual(before);
    expect(host.of("library.openable")[0]!.input).toEqual({ resourceId: "res_out" });
    expect(host.calls.filter((call) => /^(video|comic)\./.test(call.commandId) || call.commandId === "library.read")).toEqual([]);
    // Closing it leaves everything as it was.
    await userEvent.click(within(asked).getAllByTestId("open-blocked-close")[0]!);
    expect(screen.queryByTestId("open-blocked")).toBeNull();
    expect(place()).toEqual(before);
  });

  it("shows the other question for a file that is not there", async () => {
    installHost({
      "works.unassigned": () => ({ items: [loose("res_gone", "video", "合成视频")], total: 1 }),
      "library.openable": openable("missing"),
    });
    render(<App />);
    await userEvent.click(await screen.findByTestId("unassigned-open-res_gone"));
    const asked = await screen.findByTestId("open-blocked");
    expect(within(asked).getByTestId("open-blocked-place").textContent).toContain("合成视频.mp4");
    expect(within(asked).getByTestId("open-blocked-relocate")).toBeTruthy();
  });

  it("opens a resource whose file is there, on the page of its medium", async () => {
    const host = installHost({
      "works.unassigned": () => ({ items: [loose("res_ok", "novel", "合成小说")], total: 1 }),
      "library.openable": openable("open", { mediaKind: "novel" }),
    });
    render(<App />);
    await userEvent.click(await screen.findByTestId("unassigned-open-res_ok"));
    await waitFor(() => expect(focusedTitle()).toBe("合成小说"));
    expect(screen.queryByTestId("open-blocked")).toBeNull();
    expect(host.of("library.openable")).toHaveLength(1);
    await waitFor(() => expect(host.of("library.read")).toHaveLength(1));
  });

  it("opens when the question itself cannot be answered, because the main process refuses what it must in any case", async () => {
    installHost({
      "works.unassigned": () => ({ items: [loose("res_x", "novel", "合成小说")], total: 1 }),
      "library.openable": () => ({ __error: { code: "INTERNAL", message: "no answer" } }),
    });
    render(<App />);
    await userEvent.click(await screen.findByTestId("unassigned-open-res_x"));
    await waitFor(() => expect(focusedTitle()).toBe("合成小说"));
    expect(screen.queryByTestId("open-blocked")).toBeNull();
  });

  it("lists a session of a resource that cannot be opened nowhere in the sidebar, and the others as before", async () => {
    const host = installHost();
    host.sessions.push(
      { sessionId: "s_out", title: "外面的", kind: "resource", targetId: "res_out", contextId: null, mediaKind: "video", openState: "outside", runCount: 1 },
      { sessionId: "s_in", title: "里面的", kind: "resource", targetId: "res_in", contextId: null, mediaKind: "video", openState: "open", runCount: 1 },
    );
    render(<App />);
    await waitFor(() => expect(screen.getAllByText("里面的").length).toBeGreaterThan(0));
    expect(screen.queryByText("外面的")).toBeNull();
  });

  it("closes the reader of a resource whose library path is removed, says so, and leaves the other readers alone", async () => {
    const host = installHost({
      "works.unassigned": () => ({ items: [loose("res_ok", "novel", "合成小说")], total: 1 }),
      "library.openable": openable("open", { mediaKind: "novel" }),
    });
    render(<App />);
    await userEvent.click(await screen.findByTestId("unassigned-open-res_ok"));
    await waitFor(() => expect(focusedTitle()).toBe("合成小说"));
    await waitFor(() => expect(host.of("library.read")).toHaveLength(1));
    expect(tabTitles()).toContain("合成小说");

    // A path that held some other resource changes nothing here.
    host.notify({ topic: "library.pathRemoved", payload: { pathId: "lp0", resourceIds: ["res_other"] } });
    expect(tabTitles()).toContain("合成小说");

    host.notify({ topic: "library.pathRemoved", payload: { pathId: "lp1", resourceIds: ["res_ok"] } });
    // The reader's tab is closed, and the library tab under it is what is in front.
    await waitFor(() => expect(tabTitles()).not.toContain("合成小说"));
    expect(focusedTitle()).toBe("资源库");
    expect(await screen.findByText(t("open.removedNotice", { title: "合成小说" }))).toBeTruthy();
  });

  it("refreshes the sidebar and the shelf when a library path is removed", async () => {
    const host = installHost({ "works.unassigned": () => ({ items: [], total: 0 }) });
    render(<App />);
    await screen.findByTestId("shell-root");
    await waitFor(() => expect(host.of("workspace.sidebar").length).toBeGreaterThan(0));
    const before = host.of("workspace.sidebar").length;
    host.notify({ topic: "library.pathRemoved", payload: { pathId: "lp1", resourceIds: ["res_a"] } });
    await waitFor(() => expect(host.of("workspace.sidebar").length).toBeGreaterThan(before));
  });
});

// `fireEvent` is kept for the dialogs that close with the keyboard.
void fireEvent;
