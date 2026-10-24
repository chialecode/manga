/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { installHost } from "../helpers/app-host.ts";
import { installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";
import { focusedTitle, tabTitles } from "../helpers/workspace-ui.ts";

Element.prototype.scrollIntoView = () => {};

let media: ReturnType<typeof installMediaElement>;
beforeEach(() => {
  window.innerWidth = 1600;
  media = installMediaElement();
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetCovers();
  shelfMemory.reset();
  readerContext.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); media.restore(); vi.restoreAllMocks(); removeMatchMedia(); readerContext.reset(); });

const FACETS = ["agent", "library", "settings", "comic", "video", "notes", "projects"];
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key, ...init });
const pageOf = () => screen.getByTestId("settings-area").getAttribute("data-page");
const pagesListed = () => [...screen.getByTestId("settings-nav").querySelectorAll("[data-testid^='settings-nav-']")].map((node) => node.getAttribute("data-testid")!.replace("settings-nav-", ""));

async function inSettings(options: Parameters<typeof installHost>[0] = {}) {
  const host = installHost({ facets: FACETS, ...options });
  render(<App />);
  fireEvent.click(await screen.findByTestId("nav-settings"));
  await screen.findByTestId("settings-nav");
  return host;
}

describe("AT-122 the settings view over the workspace", () => {
  it("comes up from the rail's button and from its key, over the main area and in the sidebar's place, with the directory in groups", async () => {
    const host = installHost({ facets: FACETS });
    render(<App />);
    await screen.findByTestId("sidebar");
    await waitFor(() => expect(tabTitles().length).toBeGreaterThan(0));
    // The key brings it up the same as the button.
    press(",", { ctrlKey: true });
    await screen.findByTestId("settings-nav");
    expect(screen.getByTestId("shell-root").getAttribute("data-settings")).toBe("true");
    expect(screen.getByTestId("settings-title").textContent).toBe("设置");
    expect(screen.getByTestId("nav-settings").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("shell-sidebar").getAttribute("data-shell-state")).toBe("dock");
    expect(screen.getByTestId("settings-area")).toBeTruthy();
    expect(screen.queryByTestId("sidebar")).toBeNull();
    // No rail view is current while the settings are on; the sidebar's view is kept for the way back.
    for (const view of ["home", "conversation", "comic"]) expect(screen.getByTestId(`nav-${view}`).getAttribute("aria-current")).toBeNull();
    // The pages are in groups, each with its name, the current one marked; the pages of modules that are off are not listed.
    const groups = [...screen.getByTestId("settings-nav").querySelectorAll("[data-testid^='settings-group-']")].map((node) => node.getAttribute("data-testid"));
    expect(groups.length).toBeGreaterThanOrEqual(3);
    const listed = pagesListed();
    expect(listed).toContain("general");
    expect(listed).toContain("modules");
    expect(listed).toContain("models");
    expect(listed).not.toContain("recording");
    expect(listed).not.toContain("danmaku");
    expect(listed).not.toContain("records");
    expect(within(screen.getByTestId("settings-nav")).getAllByRole("button", { current: "page" }).length).toBe(1);
    // The page that is shown is the page that is marked, and it is saved with the shell's preference.
    expect(screen.getByTestId(`settings-nav-${pageOf()}`).getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(host.state.rail.settingsPage).toBe(pageOf()));
  });

  it("leaves the workspace mounted behind it, adds no tab, and keeps the dock out of the way without taking its content down", async () => {
    const host = installHost({ facets: FACETS });
    render(<App />);
    await screen.findByTestId("sidebar");
    await waitFor(() => expect(tabTitles().length).toBeGreaterThan(0));
    const tabs = tabTitles();
    const area = screen.getByTestId("workspace-area");
    const loaded = host.of("workspace.loadContext").length;
    fireEvent.click(screen.getByTestId("nav-settings"));
    await screen.findByTestId("settings-nav");
    // The same element, told it is out of sight, and made inert so the keyboard cannot reach into it.
    expect(screen.getByTestId("workspace-area")).toBe(area);
    expect(area.getAttribute("data-suspended")).toBe("true");
    expect(area.hasAttribute("inert")).toBe(true);
    expect(tabTitles()).toEqual(tabs);
    expect(screen.getByTestId("shell-dock")).toBeTruthy();
    expect(screen.queryByTestId("shell-dock-toggle")).toBeNull();
    fireEvent.click(screen.getByTestId("nav-home"));
    await waitFor(() => expect(screen.queryByTestId("settings-area")).toBeNull());
    expect(screen.getByTestId("workspace-area")).toBe(area);
    expect(area.getAttribute("data-suspended")).toBe("false");
    expect(area.hasAttribute("inert")).toBe(false);
    expect(host.of("workspace.loadContext")).toHaveLength(loaded);
    expect(screen.getByTestId("shell-dock-toggle")).toBeTruthy();
  });

  it("goes from page to page, and back and forward walk the pages that were visited, then back from the first page leaves", async () => {
    await inSettings();
    const first = pageOf()!;
    expect(first).toBe("general");
    expect((screen.getByTestId("nav-back") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("nav-forward") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("settings-nav-models"));
    fireEvent.click(screen.getByTestId("settings-nav-logs"));
    await waitFor(() => expect(pageOf()).toBe("logs"));
    expect(screen.getByTestId("settings-nav-logs").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("settings-nav-models").getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByTestId("nav-back"));
    await waitFor(() => expect(pageOf()).toBe("models"));
    expect((screen.getByTestId("nav-forward") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("nav-forward"));
    await waitFor(() => expect(pageOf()).toBe("logs"));
    // The keyboard and the mouse's side buttons walk them too.
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    await waitFor(() => expect(pageOf()).toBe("models"));
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    await waitFor(() => expect(pageOf()).toBe(first));
    expect(screen.getByTestId("settings-area")).toBeTruthy();
    fireEvent.click(screen.getByTestId("nav-back"));
    await waitFor(() => expect(screen.queryByTestId("settings-area")).toBeNull());
    expect(screen.getByTestId("shell-root").getAttribute("data-settings")).toBe("false");
    // The page that was last on is the one the settings come back to.
    fireEvent.click(screen.getByTestId("nav-settings"));
    await screen.findByTestId("settings-nav");
    expect(pageOf()).toBe(first);
  });

  it("narrows the pages by name and by keyword, says when none match, and clears with its button or Escape", async () => {
    await inSettings();
    const all = pagesListed();
    const filter = screen.getByTestId("settings-filter") as HTMLInputElement;
    // By the page's name.
    fireEvent.change(filter, { target: { value: "外观" } });
    expect(pagesListed()).toEqual(["appearance"]);
    // By a keyword it does not carry in its name: 主题 is a word of the appearance page.
    fireEvent.change(filter, { target: { value: "主题" } });
    expect(pagesListed()).toEqual(["appearance"]);
    // Several words must all be there, in any order.
    fireEvent.change(filter, { target: { value: "快捷键 键盘" } });
    expect(pagesListed()).toEqual(["shortcuts"]);
    // Whole groups with no match are not drawn.
    expect(screen.getByTestId("settings-nav").querySelectorAll("[data-testid^='settings-group-']").length).toBe(1);
    fireEvent.change(filter, { target: { value: "没有这样的页面" } });
    expect(pagesListed()).toEqual([]);
    expect(screen.getByTestId("settings-filter-none").textContent).toContain("没有匹配");
    fireEvent.click(screen.getByTestId("settings-filter-clear"));
    expect(pagesListed()).toEqual(all);
    expect(screen.queryByTestId("settings-filter-clear")).toBeNull();
    fireEvent.change(filter, { target: { value: "外观" } });
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(filter.value).toBe("");
    expect(pagesListed()).toEqual(all);
    // The filter finds pages and does not change the one on screen.
    expect(pageOf()).toBe("general");
  });

  it("shows no page of a module that is off, opens on the page used last, and falls back to the first when that page has gone", async () => {
    const host = installHost({ facets: FACETS });
    host.state.rail.settingsPage = "models";
    render(<App />);
    fireEvent.click(await screen.findByTestId("nav-settings"));
    await screen.findByTestId("settings-nav");
    expect(pageOf()).toBe("models");
    cleanup();
    // The page was saved when the module that has it was on; with it off the settings open on the first page.
    const gone = installHost({ facets: ["library", "settings", "comic"] });
    gone.state.rail.settingsPage = "models";
    render(<App />);
    fireEvent.click(await screen.findByTestId("nav-settings"));
    await screen.findByTestId("settings-nav");
    expect(pageOf()).toBe("general");
    expect(pagesListed()).not.toContain("models");
  });

  it("leaves the settings from an icon of the rail and shows that view, and from anything that opens in the workspace", async () => {
    const host = await inSettings();
    fireEvent.click(screen.getByTestId("nav-comic"));
    await waitFor(() => expect(screen.queryByTestId("settings-area")).toBeNull());
    expect(screen.getByTestId("sidebar").getAttribute("data-view")).toBe("comic");
    expect(screen.getByTestId("nav-comic").getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(host.state.rail.view).toBe("comic"));
    // The same icon again from the settings leaves them without changing the view.
    fireEvent.click(screen.getByTestId("nav-settings"));
    await screen.findByTestId("settings-nav");
    fireEvent.click(screen.getByTestId("nav-comic"));
    await waitFor(() => expect(screen.queryByTestId("settings-area")).toBeNull());
    expect(screen.getByTestId("sidebar").getAttribute("data-view")).toBe("comic");
  });

  it("ignores what acts on the tabs while it is on: closing the tab in front, the next tab, and a split", async () => {
    installHost({ facets: FACETS });
    render(<App />);
    await screen.findByTestId("sidebar");
    await waitFor(() => expect(tabTitles().length).toBeGreaterThan(0));
    const tabs = tabTitles();
    const front = focusedTitle();
    fireEvent.click(screen.getByTestId("nav-settings"));
    await screen.findByTestId("settings-nav");
    for (const init of [{ ctrlKey: true, key: "w" }, { ctrlKey: true, key: "Tab" }, { ctrlKey: true, key: "1" }]) fireEvent.keyDown(window, init);
    expect(tabTitles()).toEqual(tabs);
    expect(focusedTitle()).toBe(front);
    // The command that closes a tab is off in the menu too.
    fireEvent.click(screen.getByTestId("menu-file"));
    expect((screen.getByRole("menuitem", { name: /关闭标签/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the directory as the card of the sidebar's switch in a window too narrow for the sidebar, and a choice closes it", async () => {
    window.innerWidth = 800;
    installHost({ facets: FACETS });
    render(<App />);
    fireEvent.click(await screen.findByTestId("nav-settings"));
    await screen.findByTestId("settings-area");
    expect(screen.getByTestId("shell-root").getAttribute("data-settings")).toBe("true");
    // The window has no room for the directory beside the page: it is what the sidebar's switch brings out, as a card.
    expect(screen.queryByTestId("settings-nav")).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("shell-sidebar-toggle"));
    await waitFor(() => expect(screen.getByTestId("settings-nav").getAttribute("data-variant")).toBe("card"));
    fireEvent.click(screen.getByTestId("settings-nav-models"));
    await waitFor(() => expect(pageOf()).toBe("models"));
    await waitFor(() => expect(screen.queryByTestId("settings-nav")).toBeNull());
  });
});
