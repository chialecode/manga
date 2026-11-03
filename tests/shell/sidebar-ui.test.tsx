/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { attempt } from "../../apps/desktop/src/renderer/lib/api.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { LISTS_CHANGED_WAIT_MS, resetListsChanged } from "../../apps/desktop/src/renderer/lib/lists-changed.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { installHost, stay, type HostItem } from "../helpers/app-host.ts";
import { installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";
import { focusedTitle, showTab, tabTitles } from "../helpers/workspace-ui.ts";

Element.prototype.scrollIntoView = () => {};

const row = (sessionId: string, title: string, kind: string, contextId: string | null, extra: Record<string, unknown> = {}) => ({
  sessionId, title, kind, targetId: kind === "shared" ? null : `target_${sessionId}`, contextId, runCount: 0, activeRunId: null, activeRunStatus: null, updatedAt: "2026-01-02T00:00:00.000Z", ...extra,
});

let media: ReturnType<typeof installMediaElement>;
beforeEach(() => {
  window.innerWidth = 1600;
  media = installMediaElement();
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetCovers();
  resetListsChanged();
  shelfMemory.reset();
  readerContext.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); media.restore(); vi.restoreAllMocks(); removeMatchMedia(); readerContext.reset(); });

const FACETS = ["agent", "library", "settings", "comic", "video", "notes", "projects", "whiteboard"];

function seed(host: ReturnType<typeof installHost>) {
  host.sessions.push(
    row("ses_old", "旧的一般对话", "shared", null, { runCount: 2 }),
    row("ses_book", "合成书", "resource", null, { runCount: 1 }),
    row("ses_quiet", "没人问过的书", "resource", null, { runCount: 0 }),
    row("ses_proj", "合集的一段对话", "project", "prj_a", { runCount: 1, activeRunId: "run_1", activeRunStatus: "running" }),
  );
}

function start(options: Parameters<typeof installHost>[0] = {}) {
  const host = installHost({ facets: FACETS, projects: [{ id: "prj_a", name: "合集解说" }, { id: "prj_b", name: "第二个项目" }], ...options });
  seed(host);
  render(<App />);
  return host;
}

const rowsOf = (sidebar: HTMLElement) => [...sidebar.querySelectorAll("[data-opens]")].map((node) => node.textContent);

describe("AT-111 AT-114 AT-119 the home view of the sidebar", () => {
  it("starts a project from the projects' title, lists the projects before the recent things, and names the one on screen (A-110)", async () => {
    start();
    const sidebar = await screen.findByTestId("sidebar");
    // The home's own content comes after its first render; under a loaded parallel run that can be a moment later (LOOP-27).
    const add = await within(sidebar).findByTestId("sidebar-new-project");
    expect(sidebar.getAttribute("data-view")).toBe("home");
    expect(within(sidebar).getByTestId("sidebar-title").textContent).toBe("主页");
    // The home has no "新对话"; "新建项目" is the "+" at the end of the projects' title.
    expect(within(sidebar).queryByTestId("sidebar-new-conversation")).toBeNull();
    expect(add.getAttribute("aria-label")).toBe("新建项目");
    expect(add.closest(".sidebar-group-head")?.querySelector(".sidebar-group-title")?.textContent).toBe("项目");
    expect(within(sidebar).getByTestId("sidebar-search")).toBeTruthy();
    expect(within(sidebar).getByTestId("sidebar-entry-library").textContent).toContain("资源总览");
    expect(within(sidebar).getByTestId("sidebar-entry-projects").textContent).toContain("项目总览");
    await waitFor(() => expect(screen.getByTestId("context-prj_a")).toBeTruthy());
    // The projects come first and then "最近"; the project list holds the unarchived projects.
    const groups = [...sidebar.querySelectorAll("[data-testid='sidebar-projects'], [data-testid='sidebar-recent']")].map((node) => node.getAttribute("data-testid"));
    expect(groups).toEqual(["sidebar-projects", "sidebar-recent"]);
    expect(within(screen.getByTestId("sidebar-projects")).getByText("合集解说")).toBeTruthy();
    expect(within(screen.getByTestId("sidebar-projects")).getByText("第二个项目")).toBeTruthy();
    // The context on screen ("最近" at the start) is marked and open: its conversations are in view, and only the ones that were asked in or are general.
    expect(screen.getByTestId("context-recent").getAttribute("data-current")).toBe("true");
    expect(screen.getByTestId("context-prj_a").getAttribute("data-current")).toBe("false");
    await waitFor(() => expect(screen.getByTestId("session-open-ses_old")).toBeTruthy());
    expect(screen.getByTestId("session-open-ses_book")).toBeTruthy();
    expect(screen.queryByTestId("session-open-ses_quiet")).toBeNull();
    expect(screen.queryByTestId("session-open-ses_proj")).toBeNull();
    // The home lists every kind in one list (A-103): no kind headings; a pill after each name says the kind, and no row has a leading icon.
    expect(sidebar.querySelector("[data-testid^='sidebar-type-']")).toBeNull();
    const old = screen.getByTestId("session-open-ses_old");
    expect(within(old).getByTestId("sidebar-pill").textContent).toBe("对话");
    expect(old.firstElementChild?.classList.contains("truncate")).toBe(true);
    expect(old.querySelector("svg")).toBeNull();
    expect(screen.getByTestId("sidebar-section-recent-all")).toBeTruthy();
    // "最近" has one title: its own context row, with the clock as its toggle; a project's toggle is a folder, closed while folded.
    expect(within(screen.getByTestId("sidebar-recent")).queryByRole("heading")).toBeNull();
    expect(screen.getByTestId("context-toggle-recent").querySelector("svg")?.getAttribute("class")).toContain("clock");
    expect(screen.getByTestId("context-toggle-prj_a").querySelector("svg")?.getAttribute("class")).toMatch(/lucide-folder(?!-open)/);
    // The open context's list hangs from its guide line.
    expect(screen.getByTestId("guide-recent").contains(old)).toBe(true);
    expect(screen.queryByTestId("guide-prj_a")).toBeNull();
  });

  it("opens and folds a project's things without leaving the context on screen, and keeps what was left open for the next start", async () => {
    const host = start();
    await waitFor(() => expect(screen.getByTestId("context-toggle-prj_a")).toBeTruthy());
    expect(screen.getByTestId("context-toggle-prj_a").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("context-toggle-prj_a"));
    await waitFor(() => expect(screen.getByTestId("session-open-ses_proj")).toBeTruthy());
    expect(screen.getByTestId("context-toggle-prj_a").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("context-toggle-prj_a").querySelector("svg")?.getAttribute("class")).toContain("folder-open");
    // The running conversation carries the mark; the context on screen stays "最近".
    expect(within(screen.getByTestId("session-open-ses_proj")).getByRole("img").getAttribute("data-mark")).toBe("running");
    expect(screen.getByTestId("context-recent").getAttribute("data-current")).toBe("true");
    // The choice is saved with the rail's own preference, in the order it was made, and outlives the window being drawn again.
    await waitFor(() => expect(host.state.rail.open.home).toContain("prj_a"));
    expect(host.of("settings.setShell").at(-1)?.input.rail.open.home).toContain("prj_a");
    cleanup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("session-open-ses_proj")).toBeTruthy());
    fireEvent.click(screen.getByTestId("context-toggle-prj_a"));
    await waitFor(() => expect(screen.queryByTestId("session-open-ses_proj")).toBeNull());
    // The context on screen cannot be folded away: its own toggle is off.
    expect((screen.getByTestId("context-toggle-recent") as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches the context from a project's name: its own tabs and conversation, and the last context is kept for the next start", async () => {
    const host = start();
    await waitFor(() => expect(screen.getByTestId("context-open-prj_a")).toBeTruthy());
    fireEvent.click(screen.getByTestId("context-open-prj_a"));
    await waitFor(() => expect(screen.getByTestId("context-prj_a").getAttribute("data-current")).toBe("true"));
    expect(screen.getByTestId("context-recent").getAttribute("data-current")).toBe("false");
    // The project's own conversations are in view now (the context on screen is open), and the recent ones are not.
    await waitFor(() => expect(screen.getByTestId("session-open-ses_proj")).toBeTruthy());
    await waitFor(() => expect(host.of("workspace.setLastContext").at(-1)?.input).toEqual({ contextId: "prj_a" }));
    // A project's tabs are loaded from its own saved arrangement, and the sidebar stays on the view it was on.
    expect(host.of("workspace.loadContext").map((call) => call.input.contextId)).toContain("prj_a");
    expect(screen.getByTestId("sidebar").getAttribute("data-view")).toBe("home");
    // Back to "最近".
    fireEvent.click(screen.getByTestId("context-open-recent"));
    await waitFor(() => expect(screen.getByTestId("context-recent").getAttribute("data-current")).toBe("true"));
    await waitFor(() => expect(host.of("workspace.setLastContext").at(-1)?.input).toEqual({ contextId: null }));
  });

  it("hides the project group and the new-project button while the projects module is off, and the new-conversation button while the agent is", async () => {
    installHost({ facets: ["library", "settings", "comic", "video", "notes"] });
    render(<App />);
    await screen.findByTestId("sidebar");
    await stay();
    expect(screen.queryByTestId("sidebar-new-project")).toBeNull();
    expect(screen.queryByTestId("sidebar-projects")).toBeNull();
    expect(screen.queryByTestId("sidebar-new-conversation")).toBeNull();
    expect(screen.queryByTestId("sidebar-entry-projects")).toBeNull();
    // What stays is the recent group and the search; no view of the rail is offered for a module that is off.
    expect(screen.getByTestId("sidebar-recent")).toBeTruthy();
    expect(screen.getByTestId("sidebar-search")).toBeTruthy();
    expect(screen.queryByTestId("nav-conversation")).toBeNull();
    expect(screen.queryByTestId("nav-whiteboard")).toBeNull();
    expect(screen.getByTestId("nav-comic")).toBeTruthy();
    act(() => undefined);
  });
});

describe("AT-111 AT-114 AT-119 a view of one kind", () => {
  it("starts a conversation from the conversations' view, in a tab of the context on screen (AT-75, A-110)", async () => {
    const host = start();
    fireEvent.click(await screen.findByTestId("nav-conversation"));
    const sidebar = screen.getByTestId("sidebar");
    await waitFor(() => expect(sidebar.getAttribute("data-view")).toBe("conversation"));
    const before = tabTitles().length;
    fireEvent.click(within(sidebar).getByTestId("sidebar-new-conversation"));
    await waitFor(() => expect(host.of("conversation.new")).toHaveLength(1));
    expect(host.of("conversation.new")[0]?.input).toMatchObject({ contextId: null });
    await waitFor(() => expect(tabTitles().length).toBe(before + 1));
    expect(focusedTitle()).toContain("对话");
  });

  it("shows five conversations of a context and the rest behind a button that says how many, and takes the rest a page at a time", async () => {
    const host = installHost({ facets: FACETS, projects: [{ id: "prj_a", name: "合集解说" }] });
    for (let n = 1; n <= 8; n += 1) host.sessions.push(row(`ses_n${n}`, `第 ${n} 段`, "shared", null));
    render(<App />);
    fireEvent.click(await screen.findByTestId("nav-conversation"));
    await waitFor(() => expect(screen.getByTestId("sidebar").getAttribute("data-view")).toBe("conversation"));
    await waitFor(() => expect(screen.getByTestId("sidebar-more-recent")).toBeTruthy());
    expect(screen.getAllByTestId(/^session-open-ses_/).length).toBe(5);
    // Nine conversations are listed ("会话 1" and the eight added): four stay behind the button.
    expect(screen.getByTestId("sidebar-more-recent").textContent).toContain("4");
    fireEvent.click(screen.getByTestId("sidebar-more-recent"));
    await waitFor(() => expect(screen.getAllByTestId(/^session-open-ses_/).length).toBe(9));
    expect(screen.queryByTestId("sidebar-more-recent")).toBeNull();
    // The second page was asked with the cursor of the first, and not every conversation again.
    expect(host.of("workspace.items").at(-1)?.input).toMatchObject({ view: "conversation", contextId: null, cursor: "5" });
  });

  it("lists the one kind of the view by project, names the view and its management entry, and keeps the view for the next start", async () => {
    const host = start({ items: [
      { type: "comic", id: "wc", title: "合成漫画", contextId: "prj_a" },
      { type: "comic", id: "wc2", title: "另一本漫画", contextId: null },
      { type: "video", id: "wv", title: "合成动画", contextId: null },
    ] });
    fireEvent.click(await screen.findByTestId("nav-comic"));
    const sidebar = await screen.findByTestId("sidebar");
    await waitFor(() => expect(sidebar.getAttribute("data-view")).toBe("comic"));
    expect(within(sidebar).getByTestId("sidebar-title").textContent).toBe("漫画");
    expect(screen.getByTestId("nav-comic").getAttribute("aria-current")).toBe("page");
    expect(within(sidebar).getByTestId("sidebar-manage").textContent).toContain("漫画管理");
    // A view of one kind has the entries of that kind only: no conversation button; a project is still made from the projects' title.
    expect(within(sidebar).queryByTestId("sidebar-new-conversation")).toBeNull();
    expect(within(sidebar).queryAllByTestId("sidebar-new-project")).toHaveLength(1);
    expect(within(sidebar).getByTestId("sidebar-new-project").closest(".sidebar-group-head")).toBeTruthy();
    // "最近" is open: the comic of no project is in view, the other kind is not, and the project's own comic waits behind its group.
    await waitFor(() => expect(screen.getByTestId("sidebar-item-work-wc2")).toBeTruthy());
    expect(screen.queryByTestId("sidebar-item-work-wv")).toBeNull();
    expect(screen.queryByTestId("sidebar-item-work-wc")).toBeNull();
    expect(screen.queryByTestId("sidebar-type-recent-comic")).toBeNull();
    fireEvent.click(screen.getByTestId("context-toggle-prj_a"));
    await waitFor(() => expect(screen.getByTestId("sidebar-item-work-wc")).toBeTruthy());
    await waitFor(() => expect(host.state.rail.view).toBe("comic"));
    // A project with nothing of the kind says so once it is opened.
    fireEvent.click(screen.getByTestId("context-toggle-prj_b"));
    await waitFor(() => expect(screen.getByTestId("sidebar-empty-prj_b").textContent).toContain("还没有漫画"));
  });

  it("opens a thing of a project in that project's context, and leaves the sidebar on its view", async () => {
    const host = start({ items: [{ type: "comic", id: "wc", title: "合成漫画", contextId: "prj_a" }] });
    fireEvent.click(await screen.findByTestId("nav-comic"));
    await waitFor(() => expect(screen.getByTestId("context-toggle-prj_a")).toBeTruthy());
    fireEvent.click(screen.getByTestId("context-toggle-prj_a"));
    await waitFor(() => expect(screen.getByTestId("sidebar-item-work-wc")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sidebar-item-work-wc"));
    // The context is switched first, so the tab opens in the project's own arrangement, and the view is still the comic's.
    await waitFor(() => expect(screen.getByTestId("context-prj_a").getAttribute("data-current")).toBe("true"));
    await waitFor(() => expect(tabTitles()).toContain("合成漫画"));
    expect(focusedTitle()).toBe("合成漫画");
    expect(host.of("workspace.setLastContext").at(-1)?.input).toEqual({ contextId: "prj_a" });
    expect(screen.getByTestId("sidebar").getAttribute("data-view")).toBe("comic");
  });

  it("opens the management tab of a kind from its entry, in the context on screen", async () => {
    start();
    fireEvent.click(await screen.findByTestId("nav-conversation"));
    fireEvent.click(await screen.findByTestId("sidebar-manage"));
    await waitFor(() => expect(tabTitles()).toContain("对话管理"));
    expect(focusedTitle()).toBe("对话管理");
  });

  it("keeps one library tab in a view: a work and the library pages go to it even with another tab in front (AT-147, LOOP-24 4)", async () => {
    start({ items: [{ type: "comic", id: "wc2", title: "另一本漫画", contextId: null }] });
    const libraryTabs = () => [...(document.querySelector("[data-testid='context-host'][data-active='true']") ?? document).querySelectorAll("[data-testid='tab'][data-kind='library']")];
    await waitFor(() => expect(libraryTabs()).toHaveLength(1));
    // A conversation tab in front of the home's library tab.
    fireEvent.click(await screen.findByTestId("nav-conversation"));
    fireEvent.click(within(screen.getByTestId("sidebar")).getByTestId("sidebar-new-conversation"));
    await waitFor(() => expect(focusedTitle()).toContain("对话"));
    // A work from the home's list: the home's library tab goes to it and comes in front, no second one.
    fireEvent.click(await screen.findByTestId("nav-home"));
    await showTab(/对话/);
    fireEvent.click(await screen.findByTestId("sidebar-item-work-wc2"));
    await waitFor(() => expect(focusedTitle()).toBe("另一本漫画"));
    expect(libraryTabs()).toHaveLength(1);
    // Another tab in front again, then the comic view's management entry: in that view a library tab of its own, one.
    fireEvent.click(await screen.findByTestId("nav-comic"));
    fireEvent.click(await screen.findByTestId("sidebar-manage"));
    await waitFor(() => expect(focusedTitle()).not.toBe("另一本漫画"));
    expect(libraryTabs()).toHaveLength(1);
    expect(libraryTabs()[0]!.getAttribute("data-focused")).toBe("true");
  });

  it("shows the downloads as one list that is not kept in a project", async () => {
    start({ facets: [...FACETS, "acquisition"] });
    fireEvent.click(await screen.findByTestId("nav-downloads"));
    await waitFor(() => expect(screen.getByTestId("sidebar").getAttribute("data-view")).toBe("downloads"));
    expect(await screen.findByTestId("sidebar-downloads")).toBeTruthy();
    expect(screen.getByTestId("sidebar-empty-downloads").textContent).toContain("没有下载任务");
    expect(screen.queryByTestId("sidebar-projects")).toBeNull();
    expect(screen.getByTestId("sidebar-manage").textContent).toContain("下载管理");
  });

  it("reads its list again, once for a burst, when a change is made outside it, and not for a position saved inside a project", async () => {
    const items: HostItem[] = [{ type: "comic", id: "wc2", title: "另一本漫画", contextId: null }];
    const host = start({ items });
    fireEvent.click(await screen.findByTestId("nav-comic"));
    await waitFor(() => expect(screen.getByTestId("sidebar-item-work-wc2")).toBeTruthy());
    const pause = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, LISTS_CHANGED_WAIT_MS + 100)); });
    await pause();
    const asked = host.of("workspace.sidebar").length;
    // A reader adds what it opened to the materials and a note is written at once: the new row comes without a click, from one question.
    items.push({ type: "comic", id: "wc3", title: "刚加入的漫画", contextId: null });
    await act(async () => {
      await attempt("project.addMaterial", { projectId: "prj_a", kind: "resource", targetId: "res_new", origin: "auto" });
      await attempt("notes.create", { title: "笔记" });
    });
    await waitFor(() => expect(screen.getByTestId("sidebar-item-work-wc3")).toBeTruthy());
    await pause();
    expect(host.of("workspace.sidebar").length).toBe(asked + 1);
    // A position saved in a project is not a change of "最近"; one saved in "最近" is, once for the same resource.
    await act(async () => { await attempt("progress.setPage", { contextId: "prj_a", resourceId: "res_c1", pageId: "p1" }); });
    await pause();
    expect(host.of("workspace.sidebar").length).toBe(asked + 1);
    await act(async () => {
      await attempt("progress.setPage", { contextId: null, resourceId: "res_c1", pageId: "p1" });
      await attempt("progress.setPage", { contextId: null, resourceId: "res_c1", pageId: "p2" });
    });
    await waitFor(() => expect(host.of("workspace.sidebar").length).toBe(asked + 2));
    await act(async () => { await attempt("progress.setPage", { contextId: null, resourceId: "res_c1", pageId: "p3" }); });
    await pause();
    expect(host.of("workspace.sidebar").length).toBe(asked + 2);
  });

  it("asks again when the host answers wrongly, instead of drawing nothing", async () => {
    let calls = 0;
    start({ overrides: { "workspace.sidebar": () => { calls += 1; return calls === 1 ? { nonsense: true } : { view: "home", groups: [], downloads: null }; } } });
    const retry = await screen.findByTestId("sidebar-retry");
    expect(retry.textContent).toContain("读取失败");
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByTestId("sidebar-retry")).toBeNull());
    expect(calls).toBe(2);
  });
});

describe("AT-111 AT-114 the sidebar's own menus", () => {
  it("opens a general conversation as the context's current one, and renames, moves and deletes from the right-click menu", async () => {
    const host = start({ overrides: {
      "conversation.rename": () => ({}),
      "conversation.move": () => ({}),
      "conversation.delete": () => ({ removed: ["ses_old"], skipped: [] }),
    } });
    await waitFor(() => expect(screen.getByTestId("session-open-ses_old")).toBeTruthy());
    fireEvent.contextMenu(screen.getByTestId("session-open-ses_old"), { clientX: 40, clientY: 200 });
    const menu = screen.getByTestId("sidebar-menu");
    expect(within(menu).getAllByRole("menuitem").map((node) => (node.textContent ?? "").trim())).toEqual(["打开对话", "重命名", "移到“合集解说”", "移到“第二个项目”", "删除对话…"]);
    // Rename: the row turns into a field that Escape leaves as it was and Enter commits.
    fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名" }));
    const field = screen.getByTestId("sidebar-rename") as HTMLInputElement;
    expect(field.value).toBe("旧的一般对话");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByTestId("sidebar-rename")).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("session-open-ses_old"), { clientX: 40, clientY: 200 });
    fireEvent.click(within(screen.getByTestId("sidebar-menu")).getByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByTestId("sidebar-rename"), { target: { value: "新名字" } });
    fireEvent.submit(screen.getByTestId("sidebar-rename").closest("form")!);
    await waitFor(() => expect(host.of("conversation.rename").at(-1)?.input).toEqual({ sessionId: "ses_old", title: "新名字" }));
    // Move into a project.
    fireEvent.contextMenu(screen.getByTestId("session-open-ses_old"), { clientX: 40, clientY: 200 });
    fireEvent.click(within(screen.getByTestId("sidebar-menu")).getByRole("menuitem", { name: "移到“合集解说”" }));
    await waitFor(() => expect(host.of("conversation.move").at(-1)?.input).toEqual({ sessionId: "ses_old", contextId: "prj_a" }));
    // Delete asks first and then goes through the one deletion of conversations.
    fireEvent.contextMenu(screen.getByTestId("session-open-ses_old"), { clientX: 40, clientY: 200 });
    fireEvent.click(within(screen.getByTestId("sidebar-menu")).getByRole("menuitem", { name: "删除对话…" }));
    expect(host.of("conversation.delete").length).toBe(0);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button").find((node) => /删除/.test(node.textContent ?? ""))!);
    await waitFor(() => expect(host.of("conversation.delete").at(-1)?.input).toEqual({ sessionIds: ["ses_old"] }));
  });

  it("offers a project's home, a new name and archiving from its right-click menu, and no move or delete there", async () => {
    const host = start({ overrides: { "project.update": () => ({}) } });
    await waitFor(() => expect(screen.getByTestId("context-open-prj_a")).toBeTruthy());
    fireEvent.contextMenu(screen.getByTestId("context-open-prj_a"), { clientX: 40, clientY: 100 });
    const menu = screen.getByTestId("sidebar-menu");
    expect(within(menu).getAllByRole("menuitem").map((node) => (node.textContent ?? "").trim())).toEqual(["打开项目主页", "重命名", "归档项目"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "归档项目" }));
    await waitFor(() => expect(host.of("project.update").at(-1)?.input).toEqual({ projectId: "prj_a", status: "archived" }));
    // Escape and a click elsewhere dismiss a menu.
    fireEvent.contextMenu(screen.getByTestId("context-open-prj_b"), { clientX: 40, clientY: 100 });
    expect(screen.getByTestId("sidebar-menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("sidebar-menu"), { key: "Escape" });
    expect(screen.queryByTestId("sidebar-menu")).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("context-open-prj_b"), { clientX: 40, clientY: 100 });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("sidebar-menu")).toBeNull();
  });

  it("offers to open a thing behind the page and to take a material out of its project, and keeps the rows' text as they were named", async () => {
    const host = start({ items: [{ type: "comic", id: "wc", title: "合成漫画", contextId: "prj_a" }], overrides: { "project.removeMaterial": () => ({}) } });
    fireEvent.click(await screen.findByTestId("nav-comic"));
    await waitFor(() => expect(screen.getByTestId("context-toggle-prj_a")).toBeTruthy());
    fireEvent.click(screen.getByTestId("context-toggle-prj_a"));
    await waitFor(() => expect(screen.getByTestId("sidebar-item-work-wc")).toBeTruthy());
    // A medium lists covers by default (A-105): the name, then how far the person got.
    expect([...screen.getByTestId("sidebar").querySelectorAll("[data-opens] .sidebar-cover-title")].map((node) => node.textContent)).toEqual(["合成漫画"]);
    expect(screen.getByTestId("sidebar-covers-prj_a")).toBeTruthy();
    expect(screen.getByTestId("sidebar-item-work-wc").getAttribute("aria-label")).toBe("合成漫画，没看过");
    fireEvent.contextMenu(screen.getByTestId("sidebar-item-work-wc"), { clientX: 40, clientY: 200 });
    expect(within(screen.getByTestId("sidebar-menu")).getAllByRole("menuitem").map((node) => (node.textContent ?? "").trim())).toEqual(["打开", "在后台打开", "从这个项目移除"]);
    fireEvent.click(within(screen.getByTestId("sidebar-menu")).getByRole("menuitem", { name: "从这个项目移除" }));
    await waitFor(() => expect(host.of("project.removeMaterial").at(-1)?.input).toEqual({ projectId: "prj_a", materialId: "mat_wc" }));
  });
});

describe("AT-123 AT-124 AT-126 the lists after A-103 and A-105", () => {
  it("lists eight things of the home's one list, the rest behind 更多 with its number, and folds them back with 收起", async () => {
    const items: HostItem[] = Array.from({ length: 9 }, (_, index) => ({ type: "note", id: `n${index}`, title: `笔记 ${index}`, contextId: null, updatedAt: `2026-01-0${index + 1}T00:00:00.000Z` }));
    const host = start({ items });
    await waitFor(() => expect(screen.getByTestId("sidebar-more-recent")).toBeTruthy());
    // Three conversations and nine notes: twelve in one list, eight shown.
    expect(screen.getByTestId("guide-recent").querySelectorAll("[data-opens]")).toHaveLength(8);
    expect(screen.getByTestId("sidebar-more-recent").textContent).toBe("更多（4）");
    fireEvent.click(screen.getByTestId("sidebar-more-recent"));
    await waitFor(() => expect(screen.getByTestId("guide-recent").querySelectorAll("[data-opens]")).toHaveLength(12));
    // The page was asked for the whole list, without a kind.
    expect(host.of("workspace.items").at(-1)?.input).not.toHaveProperty("type");
    expect(screen.queryByTestId("sidebar-more-recent")).toBeNull();
    fireEvent.click(screen.getByTestId("sidebar-less-recent"));
    await waitFor(() => expect(screen.getByTestId("guide-recent").querySelectorAll("[data-opens]")).toHaveLength(8));
    expect(screen.getByTestId("sidebar-more-recent")).toBeTruthy();
  });

  it("lists a medium as covers with how far the person got, switches to rows and keeps the choice for the next start", async () => {
    const host = start({ items: [
      { type: "video", id: "wv", title: "合成动画", contextId: null, coverId: null, progress: { percent: 30, episode: "第 3 集" } },
      { type: "video", id: "wv2", title: "另一部动画", contextId: null, progress: { percent: 42, episode: null } },
    ] });
    fireEvent.click(await screen.findByTestId("nav-video"));
    await waitFor(() => expect(screen.getByTestId("sidebar-covers-recent")).toBeTruthy());
    expect(screen.getByTestId("sidebar-item-work-wv").getAttribute("aria-label")).toBe("合成动画，看到第 3 集");
    expect(screen.getByTestId("sidebar-item-work-wv2").getAttribute("aria-label")).toBe("另一部动画，看到 42%");
    expect(screen.getByTestId("sidebar-display").getAttribute("aria-label")).toBe("以列表列出");
    fireEvent.click(screen.getByTestId("sidebar-display"));
    await waitFor(() => expect(screen.queryByTestId("sidebar-covers-recent")).toBeNull());
    expect(screen.getByTestId("sidebar-item-work-wv").textContent).toBe("合成动画看到第 3 集");
    await waitFor(() => expect(host.state.rail.display.video).toBe("list"));
    cleanup();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("sidebar-item-work-wv")).toBeTruthy());
    expect(screen.queryByTestId("sidebar-covers-recent")).toBeNull();
    expect(screen.getByTestId("sidebar-display").getAttribute("data-display")).toBe("list");
  });

  it("marks the row of the tab in front of the main area (A-107)", async () => {
    start();
    await waitFor(() => expect(screen.getByTestId("session-open-ses_old")).toBeTruthy());
    expect(screen.getByTestId("session-open-ses_old").getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByTestId("session-open-ses_book"));
    await waitFor(() => expect(screen.getByTestId("session-open-ses_book").getAttribute("aria-current")).toBe("true"));
    expect(screen.getByTestId("session-open-ses_old").getAttribute("aria-current")).toBeNull();
  });
});

describe("AT-128 the keys on a tab (LOOP-24 3)", () => {
  it("does not close a tab on Delete or Backspace, and leaves the other keys and the text boxes alone", async () => {
    start();
    await waitFor(() => expect(screen.getByTestId("session-open-ses_book")).toBeTruthy());
    fireEvent.click(screen.getByTestId("session-open-ses_book"));
    await waitFor(() => expect(tabTitles().length).toBeGreaterThan(0));
    const before = tabTitles();
    const strip = document.querySelector<HTMLElement>("[data-testid='context-host'][data-active='true'] .dv-tab")!;
    expect(strip).toBeTruthy();
    for (const key of ["Delete", "Backspace"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      strip.dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(true);
      expect(tabTitles()).toEqual(before);
    }
    // The other keys still reach the tab strip: Enter is dockview's to handle.
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    strip.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    // A text box in a tab keeps its Backspace.
    const box = document.createElement("textarea");
    document.querySelector("[data-testid='context-host'][data-active='true'] [data-testid='tab-panel']")!.appendChild(box);
    const typed = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    box.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
    box.remove();
  });
});
