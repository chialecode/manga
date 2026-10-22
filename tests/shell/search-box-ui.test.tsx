/** @vitest-environment jsdom */
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const FACETS = ["agent", "library", "settings", "comic", "video", "notes", "projects", "whiteboard"];
const ITEMS = [
  { type: "comic" as const, id: "wc", title: "合成漫画", contextId: "prj_a", updatedAt: "2026-02-02T00:00:00.000Z" },
  { type: "comic" as const, id: "wc2", title: "合成的另一本", contextId: null, updatedAt: "2026-02-01T00:00:00.000Z" },
  { type: "note" as const, id: "n1", title: "合成笔记", contextId: null },
  { type: "video" as const, id: "wv", title: "合成动画", contextId: null },
];

/** What a note's tab asks for when it opens. */
const NOTE = { "notes.get": () => ({ objectId: "n1", revision: 1, title: "合成笔记", tags: [], blocks: [] }) };

function start(options: Parameters<typeof installHost>[0] = {}) {
  const host = installHost({ facets: FACETS, projects: [{ id: "prj_a", name: "合集解说" }], items: ITEMS, ...options, overrides: { ...NOTE, ...options.overrides } });
  host.sessions.push({ sessionId: "ses_old", title: "合成的对话", kind: "shared", targetId: null, contextId: null, runCount: 1, activeRunId: null, activeRunStatus: null, updatedAt: "2026-01-02T00:00:00.000Z" });
  render(<App />);
  return host;
}

const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key, ...init });
const input = () => screen.getByTestId("search-input") as HTMLInputElement;
async function openBox(host: ReturnType<typeof installHost>) {
  await screen.findByTestId("sidebar");
  press("k", { ctrlKey: true });
  await screen.findByTestId("search-box");
  return host;
}
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const LATE = { timeout: 2000 };

describe("AT-121 the search box is a floating box over the window", () => {
  it("has a class of its own: the shelf's search field keeps its rules and the box takes none of them, and no class has its base rule in two stylesheets", () => {
    const dir = "apps/desktop/src/renderer";
    const bases = new Map<string, string[]>();
    for (const name of readdirSync(dir, { recursive: true }).map(String).filter((file) => file.endsWith(".css"))) {
      for (const match of readFileSync(`${dir}/${name}`, "utf8").matchAll(/^\.([a-zA-Z][\w-]*)\s*\{/gm)) bases.set(match[1]!, [...(bases.get(match[1]!) ?? []), name]);
    }
    // The one that was there before the box (a color layer over the button's own rule) is left as it is.
    const twice = [...bases].filter(([, files]) => new Set(files).size > 1).map(([name]) => name).filter((name) => name !== "danger-button");
    expect(twice).toEqual([]);
    expect(bases.get("search-popup")).toEqual(["styles-frame.css"]);
    expect(bases.get("search-box")).toEqual(["styles-shelf.css"]);
    expect(readFileSync(`${dir}/search-box.tsx`, "utf8")).toMatch(/className="search-popup"/);
  });

  it("opens from the key over the workspace without making a tab, holds the typing focus, and closes with Escape to where the focus was", async () => {
    const host = start();
    await screen.findByTestId("sidebar");
    await waitFor(() => expect(tabTitles().length).toBeGreaterThan(0));
    const tabs = tabTitles();
    const button = screen.getByTestId("sidebar-search");
    button.focus();
    press("k", { ctrlKey: true });
    const box = await screen.findByTestId("search-box");
    expect(box.getAttribute("role")).toBe("dialog");
    expect(within(box).getByRole("combobox", { name: "搜索" })).toBe(input());
    expect(document.activeElement).toBe(input());
    expect(screen.getByTestId("search-hint").textContent).toContain("输入名字");
    // Not a tab, and the workspace under it is where it was.
    expect(tabTitles()).toEqual(tabs);
    expect(screen.queryByTestId("search-scope")).toBeNull();
    expect(host.of("workspace.find")).toHaveLength(0);
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("search-box")).toBeNull());
    expect(tabTitles()).toEqual(tabs);
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("closes with the key that opened it, with its close button, and by pressing outside it", async () => {
    await openBox(start());
    press("k", { ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId("search-box")).toBeNull());
    press("k", { ctrlKey: true });
    await screen.findByTestId("search-box");
    fireEvent.click(screen.getByTestId("search-box-close"));
    await waitFor(() => expect(screen.queryByTestId("search-box")).toBeNull());
    press("k", { ctrlKey: true });
    await screen.findByTestId("search-box");
    // The box listens for a press outside it a moment after it is up.
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    // A press is the whole sequence of events a pointer makes; the box is dismissed by it.
    const overlay = screen.getByTestId("search-overlay");
    fireEvent.pointerDown(overlay, { pointerType: "mouse", button: 0 });
    fireEvent.mouseDown(overlay);
    fireEvent.pointerUp(overlay, { pointerType: "mouse", button: 0 });
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay);
    await waitFor(() => expect(screen.queryByTestId("search-box")).toBeNull());
  });

  it("lists, as the text is typed, the projects, conversations, works, notes and objects whose name has it, by kind, and says so when none does", async () => {
    const host = await openBox(start());
    type("合成");
    await waitFor(() => expect(screen.getByTestId("search-group-comic")).toBeTruthy(), LATE);
    expect(host.of("workspace.find").at(-1)?.input).toEqual({ q: "合成", perType: 4 });
    const groups = [...screen.getByTestId("search-results").querySelectorAll("[data-testid^='search-group-']")].map((node) => node.getAttribute("data-testid"));
    expect(groups).toEqual(["search-group-conversation", "search-group-comic", "search-group-video", "search-group-note", "search-group-texts"]);
    expect(within(screen.getByTestId("search-group-comic")).getAllByRole("option").map((node) => node.querySelector(".search-row-title")?.textContent)).toEqual(["合成漫画", "合成的另一本"]);
    // A thing of a project names the project, a conversation of no project says "最近", and a thing that opens where the person is names no place.
    const place = (group: string) => within(screen.getByTestId(group)).getAllByRole("option")[0]!.querySelector(".search-row-place")?.textContent;
    expect(place("search-group-comic")).toBe("合集解说");
    expect(place("search-group-conversation")).toBe("最近");
    expect(place("search-group-note")).toBe("");
    // A project is found by its name too.
    type("合集");
    await waitFor(() => expect(screen.getByTestId("search-group-project")).toBeTruthy(), LATE);
    expect(screen.queryByTestId("search-group-comic")).toBeNull();
    type("没有这个名字");
    await waitFor(() => expect(screen.getByTestId("search-names-none")).toBeTruthy(), LATE);
    expect(screen.queryByTestId("search-group-project")).toBeNull();
    // The line that searches the texts is always there once something is typed.
    expect(screen.getByTestId("search-run-body").textContent).toContain("没有这个名字");
  });

  it("drops an answer that arrives after a newer question", async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    const host = start({
      overrides: {
        "workspace.find": (request) => {
          calls += 1;
          if (request.q === "合成" && calls === 1) return new Promise<unknown>((resolve) => { release = () => resolve({ groups: [{ type: "note", items: [{ key: "note:old", type: "note", title: "迟到的笔记", detail: null, open: { kind: "note", id: "old" }, contextName: null, updatedAt: null, running: false, materialId: null }] }] }); });
          return { groups: [] };
        },
      },
    });
    await openBox(host);
    type("合成");
    await waitFor(() => expect(calls).toBe(1), LATE);
    type("别的");
    await waitFor(() => expect(calls).toBe(2), LATE);
    await waitFor(() => expect(screen.getByTestId("search-names-none")).toBeTruthy(), LATE);
    await act(async () => { release?.(); await Promise.resolve(); });
    expect(screen.queryByText("迟到的笔记")).toBeNull();
  });

  it("opens from a view of the rail with that view as its scope, which Backspace on an empty box or its button takes off", async () => {
    const host = start();
    fireEvent.click(await screen.findByTestId("nav-comic"));
    await waitFor(() => expect(screen.getByTestId("sidebar").getAttribute("data-view")).toBe("comic"));
    fireEvent.click(screen.getByTestId("sidebar-search"));
    await screen.findByTestId("search-box");
    expect(screen.getByTestId("search-scope").textContent).toContain("漫画");
    expect(input().placeholder).toBe("在“漫画”里搜索名字");
    type("合成");
    await waitFor(() => expect(screen.getByTestId("search-group-comic")).toBeTruthy(), LATE);
    expect(host.of("workspace.find").at(-1)?.input).toEqual({ q: "合成", view: "comic", perType: 4 });
    expect(screen.queryByTestId("search-group-note")).toBeNull();
    expect(screen.queryByTestId("search-group-video")).toBeNull();
    // Backspace in a box with text edits the text; in an empty one it takes the scope off, and the next question has none.
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.getByTestId("search-scope")).toBeTruthy();
    type("");
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.queryByTestId("search-scope")).toBeNull();
    type("合成");
    await waitFor(() => expect(screen.getByTestId("search-group-note")).toBeTruthy(), LATE);
    expect(host.of("workspace.find").at(-1)?.input).toEqual({ q: "合成", perType: 4 });
  });

  it("opens from the home and from the downloads with no scope, and from the settings with none either", async () => {
    start({ facets: [...FACETS, "acquisition"] });
    fireEvent.click(await screen.findByTestId("sidebar-search"));
    await screen.findByTestId("search-box");
    expect(screen.queryByTestId("search-scope")).toBeNull();
    fireEvent.click(screen.getByTestId("search-box-close"));
    await waitFor(() => expect(screen.queryByTestId("search-box")).toBeNull());
    fireEvent.click(screen.getByTestId("nav-downloads"));
    await waitFor(() => expect(screen.getByTestId("sidebar").getAttribute("data-view")).toBe("downloads"));
    fireEvent.click(screen.getByTestId("sidebar-search"));
    await screen.findByTestId("search-box");
    expect(screen.queryByTestId("search-scope")).toBeNull();
    fireEvent.click(screen.getByTestId("search-box-close"));
    await waitFor(() => expect(screen.queryByTestId("search-box")).toBeNull());
    fireEvent.click(screen.getByTestId("nav-comic"));
    fireEvent.click(screen.getByTestId("nav-settings"));
    await screen.findByTestId("settings-nav");
    press("k", { ctrlKey: true });
    await screen.findByTestId("search-box");
    expect(screen.queryByTestId("search-scope")).toBeNull();
  });
});

describe("AT-121 choosing in the search box", () => {
  it("moves over the rows with the arrow keys, opens the chosen one in the context it belongs to, and closes", async () => {
    const host = await openBox(start());
    type("合成漫画");
    await waitFor(() => expect(screen.getByTestId("search-group-comic")).toBeTruthy(), LATE);
    // Nothing is chosen at first: the arrows choose, and the combobox says which.
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    const first = within(screen.getByTestId("search-group-comic")).getAllByRole("option")[0]!;
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe(first.id);
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("search-box")).toBeNull());
    // The comic of the project opened in the project: its context was switched to first.
    await waitFor(() => expect(host.of("workspace.setLastContext").at(-1)?.input).toEqual({ contextId: "prj_a" }));
    await waitFor(() => expect(tabTitles()).toContain("合成漫画"));
    expect(focusedTitle()).toBe("合成漫画");
    expect(screen.getByTestId("context-prj_a").getAttribute("data-current")).toBe("true");
  });

  it("wraps from the last row to the first and back, and opens a row with a click", async () => {
    await openBox(start());
    type("合成");
    await waitFor(() => expect(screen.getByTestId("search-group-note")).toBeTruthy(), LATE);
    const options = () => within(screen.getByTestId("search-results")).getAllByRole("option");
    const count = options().length;
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(options().at(-1)!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(count).toBeGreaterThan(4);
    fireEvent.click(within(screen.getByTestId("search-group-note")).getAllByRole("option")[0]!);
    await waitFor(() => expect(screen.queryByTestId("search-box")).toBeNull());
    await waitFor(() => expect(tabTitles()).toContain("合成笔记"));
  });

  it("opens behind the tab in front with Ctrl and Enter, and leaves the box closed and the tab in front as it was", async () => {
    await openBox(start());
    const front = focusedTitle();
    const tabs = tabTitles();
    type("合成的另一本");
    await waitFor(() => expect(screen.getByTestId("search-group-comic")).toBeTruthy(), LATE);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId("search-box")).toBeNull());
    await waitFor(() => expect(tabTitles().length).toBe(tabs.length + 1));
    expect(tabTitles()).toContain("合成的另一本");
    expect(focusedTitle()).toBe(front);
  });

  it("searches the texts with Enter when no row is chosen, lists what is found, and asks nothing of the texts until then", async () => {
    const host = await openBox(start({
      overrides: {
        "library.find": () => [
          { fragmentId: "f1", kind: "text", resourceId: "res_c1", revisionId: "rev_res_c1", text: "合成正文里的一句", locator: { kind: "image" } },
          { fragmentId: "f2", kind: "note", objectId: "n1", text: "合成笔记里的一句" },
        ],
      },
    }));
    type("合成");
    await waitFor(() => expect(screen.getByTestId("search-group-comic")).toBeTruthy(), LATE);
    expect(host.of("library.find")).toHaveLength(0);
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("search-count").textContent).toContain("2"));
    expect(host.of("library.find").at(-1)?.input).toEqual({ text: "合成" });
    expect(screen.getByTestId("search-hit-body-0").textContent).toContain("合成正文里的一句");
    expect(screen.getByTestId("search-hit-note-1").textContent).toContain("合成笔记里的一句");
    // A different text does not keep the old hits.
    type("别的字");
    await waitFor(() => expect(screen.queryByTestId("search-count")).toBeNull());
  });

  it("asks only for what the scope has: the notes' scope shows the hits in notes, and a scope without texts has no line for them", async () => {
    start({
      overrides: {
        "library.find": () => [
          { fragmentId: "f1", kind: "text", resourceId: "res_c1", revisionId: "rev_res_c1", text: "正文里的一句", locator: { kind: "image" } },
          { fragmentId: "f2", kind: "note", objectId: "n1", text: "笔记里的一句" },
        ],
      },
      facets: [...FACETS, "mindmap"],
    });
    fireEvent.click(await screen.findByTestId("nav-note"));
    fireEvent.click(await screen.findByTestId("sidebar-search"));
    await screen.findByTestId("search-box");
    type("一句");
    await waitFor(() => expect(screen.getByTestId("search-run-body")).toBeTruthy(), LATE);
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("search-count").textContent).toContain("1"));
    expect(screen.queryByText("正文里的一句")).toBeNull();
    expect(screen.getByText("笔记里的一句")).toBeTruthy();
    fireEvent.click(screen.getByTestId("search-box-close"));
    await waitFor(() => expect(screen.queryByTestId("search-box")).toBeNull());
    fireEvent.click(screen.getByTestId("nav-whiteboard"));
    fireEvent.click(await screen.findByTestId("sidebar-search"));
    await screen.findByTestId("search-box");
    type("一句");
    await waitFor(() => expect(screen.getByTestId("search-names-none")).toBeTruthy(), LATE);
    expect(screen.queryByTestId("search-run-body")).toBeNull();
    expect(screen.queryByTestId("search-group-texts")).toBeNull();
  });

  it("leaves the settings when something found is opened: the box is over the settings, and what opens is in the workspace", async () => {
    start();
    fireEvent.click(await screen.findByTestId("nav-settings"));
    await screen.findByTestId("settings-nav");
    press("k", { ctrlKey: true });
    await screen.findByTestId("search-box");
    type("合成笔记");
    await waitFor(() => expect(screen.getByTestId("search-group-note")).toBeTruthy(), LATE);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("settings-area")).toBeNull());
    await waitFor(() => expect(tabTitles()).toContain("合成笔记"));
    expect(screen.getByTestId("workspace-area").getAttribute("data-suspended")).toBe("false");
  });

  it("does not act on a key while an input method is composing", async () => {
    const host = await openBox(start());
    type("合成");
    await waitFor(() => expect(screen.getByTestId("search-group-comic")).toBeTruthy(), LATE);
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(input(), { key: "ArrowDown", keyCode: 229 });
    expect(screen.getByTestId("search-box")).toBeTruthy();
    expect(host.of("library.find")).toHaveLength(0);
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
  });
});
