/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { useVideo } from "../../apps/desktop/src/renderer/hooks/use-video.ts";
import { useComic } from "../../apps/desktop/src/renderer/hooks/use-comic.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { createTranslator } from "@manga/i18n";
import { installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";
import { installHost } from "../helpers/app-host.ts";
import { activeHost, closeFocusedTab, focusedTitle, openShelf, openWorkPage, showTab, tabNamed, tabTitles } from "../helpers/workspace-ui.ts";

Element.prototype.scrollIntoView = () => {};

let media: ReturnType<typeof installMediaElement>;
const READER = "合成动画 第 1 话 开场";
const here = () => within(activeHost()!);
const element = () => here().getByTestId("video-element") as HTMLVideoElement;
/**
 * Whether the browser would draw the node: a tab that is out of sight is hidden by the dock (`visibility`), a context that is out of sight by `hidden`, and
 * the whole workspace behind the settings by `.workspace-area[data-suspended="true"]` (the rule is in `styles-frame.css`; jsdom loads no stylesheet, so the
 * attribute stands for it, and the last test of this file reads the rule).
 */
const shown = (node: Element) => { for (let at: Element | null = node; at; at = at.parentElement) { const style = getComputedStyle(at); if (style.display === "none" || style.visibility === "hidden" || at.getAttribute("data-suspended") === "true") return false; } return true; };
/** The icons of the rail, in order, whatever context is on screen. */
const railViews = () => [...document.querySelectorAll("[data-rail-view]")].map((node) => node.getAttribute("data-rail-view"));

async function openVideo() {
  render(<App />);
  await openShelf("video");
  await openWorkPage("open-res_v1");
  fireEvent.click(screen.getByTestId("work-read"));
  await waitFor(() => expect(screen.getByTestId("video-reader")).toBeTruthy());
  await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
  act(() => media.loaded(element(), 120));
  await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"));
}

beforeEach(() => {
  window.innerWidth = 1600;
  media = installMediaElement();
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetVideoSupport();
  resetCovers();
  shelfMemory.reset();
  quoteTags.reset();
  readerContext.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); media.restore(); vi.restoreAllMocks(); removeMatchMedia(); quoteTags.reset(); readerContext.reset(); });

describe("AT-88 AT-122 the workspace under the settings stays where it is", () => {
  it("returns to the same player, paused at the same place, without loading it again", async () => {
    const host = installHost();
    await openVideo();
    const player = element();
    // The viewer has watched to 42 s, paused, and typed a question that was not sent.
    act(() => media.advance(player, 42));
    act(() => { player.dispatchEvent(new Event("pause")); });
    fireEvent.change(screen.getByTestId("agent-composer"), { target: { value: "这一幕的背景是什么" } });
    const log = screen.getByTestId("chat-log");
    log.setAttribute("data-marker", "kept");
    const loads = { handle: host.of("video.handle").length, plan: host.of("video.playbackPlan").length, probe: host.of("video.probe").length };
    expect(loads).toEqual({ handle: 1, plan: 1, probe: 1 });

    // The settings are a view over the workspace, not a tab: the player is out of sight, not gone, and no tab was added for them.
    const tabsBefore = tabTitles();
    const loadedBefore = host.of("workspace.loadContext").length;
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    await waitFor(() => expect(shown(screen.getByTestId("video-reader"))).toBe(false));
    expect(media.state(player).paused).toBe(true);
    expect(screen.getByTestId("workspace-area").getAttribute("data-suspended")).toBe("true");
    expect(screen.getByTestId("shell-root").getAttribute("data-settings")).toBe("true");
    expect(tabTitles()).toEqual(tabsBefore);
    expect(tabTitles()).not.toContain("设置");

    // Leaving them (an icon of the rail) shows the workspace as it was.
    fireEvent.click(screen.getByTestId("nav-home"));
    await waitFor(() => expect(screen.queryByTestId("settings-area")).toBeNull());
    await waitFor(() => expect(shown(screen.getByTestId("video-reader"))).toBe(true));
    expect(screen.getByTestId("workspace-area").getAttribute("data-suspended")).toBe("false");
    expect(host.of("workspace.loadContext")).toHaveLength(loadedBefore);

    // The same element is playing the same source at the same place, paused, and nothing was asked for again.
    expect(element()).toBe(player);
    expect(media.state(player).paused).toBe(true);
    expect(media.state(player).time).toBe(42);
    expect(host.of("video.handle")).toHaveLength(loads.handle);
    expect(host.of("video.playbackPlan")).toHaveLength(loads.plan);
    expect(host.of("video.probe")).toHaveLength(loads.probe);
    expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true");
    expect(screen.getByTestId("chat-log").getAttribute("data-marker")).toBe("kept");
    expect(shown(screen.getByTestId("chat-log"))).toBe(true);
    expect((screen.getByTestId("agent-composer") as HTMLTextAreaElement).value).toBe("这一幕的背景是什么");
    // The player is paused when it comes back (it is not started by the return).
    expect(media.state(player).played).toBe(0);
  });

  it("a video that was playing when settings opened is paused and its place is saved", async () => {
    const host = installHost();
    await openVideo();
    const player = element();
    act(() => { void player.play(); });
    act(() => media.advance(player, 30));
    expect(media.state(player).paused).toBe(false);

    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    await waitFor(() => expect(media.state(player).paused).toBe(true));
    await waitFor(() => expect(host.state.times.get("res_v1")).toBe(30_000));

    fireEvent.click(screen.getByTestId("nav-home"));
    await waitFor(() => expect(shown(screen.getByTestId("video-reader"))).toBe(true));
    expect(media.state(player).paused).toBe(true);
    expect(media.state(player).time).toBe(30);
  });

  it("hands the keyboard to the tab's content once its title has been pressed, so the player hears the space bar (A-94)", async () => {
    installHost();
    await openVideo();
    const player = element();
    // The title holds the focus the way it does after a press; the strip itself answers Space and Enter.
    const strip = tabNamed(READER)!.closest<HTMLElement>(".dv-tab")!;
    act(() => strip.focus());
    expect(document.activeElement).toBe(strip);
    await showTab(READER);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-testid")).toBe("tab-panel"));
    expect(document.activeElement?.getAttribute("data-focused")).toBe("true");
    // A key that is pressed there reaches the player.
    act(() => { void player.play(); });
    expect(media.state(player).paused).toBe(false);
    fireEvent.keyDown(document.activeElement!, { key: " " });
    await waitFor(() => expect(media.state(player).paused).toBe(true));
  });

  it("closing the resource and opening it again goes back to where the viewer was (AT-82)", async () => {
    const host = installHost();
    await openVideo();
    act(() => media.advance(element(), 77));
    act(() => { element().dispatchEvent(new Event("pause")); });
    await waitFor(() => expect(host.state.times.get("res_v1")).toBe(77_000));

    // Leaving is closing the player's tab; the way back reads the saved place.
    closeFocusedTab();
    await waitFor(() => expect(screen.queryByTestId("video-reader")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
    await waitFor(() => expect((screen.getByTestId("work-read") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("work-read"));
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(element(), 120));
    await waitFor(() => expect(media.state(element()).seeks).toContain(77));
  });
});

describe("a reader mounted again starts where the viewer is, not where the resource was opened", () => {
  const deps = () => ({
    i18n: createTranslator("zh-CN"), setError: vi.fn(), setNotice: vi.fn(), setPage: vi.fn(),
    ensureBoundSession: vi.fn(async () => undefined), openNote: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined),
  });

  it("video: the place the player reported is the place the next player starts at", async () => {
    installHost();
    const { result, rerender } = renderHook(() => { const viewRequest = useRef(0); return useVideo({ ...deps(), viewRequest }); });
    await act(async () => { await result.current.open("res_v1"); });
    expect(result.current.startMs).toBe(0);
    // The page is drawn again when it is shown again, so the value is read then.
    act(() => result.current.recordProgress({ resourceId: "res_v1", revisionId: "rev_res_v1", timeMs: 42_000, ranges: [], ended: false }));
    rerender();
    expect(result.current.startMs).toBe(42_000);
    // A finished video starts again from its beginning.
    act(() => result.current.recordProgress({ resourceId: "res_v1", revisionId: "rev_res_v1", timeMs: 119_000, ranges: [], ended: true }));
    rerender();
    expect(result.current.startMs).toBe(0);
    // Another resource does not inherit it.
    act(() => result.current.recordProgress({ resourceId: "res_v1", revisionId: "rev_res_v1", timeMs: 5_000, ranges: [], ended: false }));
    await act(async () => { await result.current.open("res_v2"); });
    expect(result.current.startMs).toBe(0);
  });

  it("video: a note's stretch is gone to once; the player mounted again does not go there a second time", async () => {
    installHost();
    const { result } = renderHook(() => { const viewRequest = useRef(0); return useVideo({ ...deps(), viewRequest }); });
    await act(async () => { await result.current.open("res_v1", { focus: { startMs: 10_000 } }); });
    expect(result.current.focus?.applied).toBeUndefined();
    act(() => result.current.focusApplied(result.current.focus!.nonce));
    expect(result.current.focus?.applied).toBe(true);
    // The marker stays on the timeline.
    expect(result.current.focus?.startMs).toBe(10_000);
  });

  it("comic: the last page the reader recorded is the page the next reader starts at", async () => {
    installHost();
    const { result, rerender } = renderHook(() => { const viewRequest = useRef(0); return useComic({ ...deps(), viewRequest }); });
    await act(async () => { await result.current.open("res_c1"); });
    expect(result.current.startPageId).toBeNull();
    act(() => result.current.recordPages(["p3", "p4"]));
    rerender();
    expect(result.current.startPageId).toBe("p4");
    act(() => result.current.close());
    await act(async () => { await result.current.settled(); await result.current.open("res_c1"); });
    // The host answered with the page that was written.
    expect(result.current.startPageId).toBe("p4");
  });
});

describe("AT-87 AT-112 two contexts are two workspaces", () => {
  const counts = { materials: 1, terms: 0, sessions: 1, whiteboards: 2, mindmaps: 1, drafts: 3, excerpts: 0, roughCuts: 1 };
  const prj = { id: "prj_1", name: "合集解说", goal: "做一期合集解说", status: "active", modelConnectionId: null, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z", counts };
  const material = { id: "mat_v1", kind: "resource", targetId: "res_v1", label: "开场", state: "ok", addedAt: "2026-10-01T00:00:00.000Z", opens: { resourceId: "res_v1", mediaKind: "video", workId: "wv" } };
  const other = { id: "mat_v2", kind: "resource", targetId: "res_v2", label: "后续", state: "ok", addedAt: "2026-10-01T00:00:00.000Z", opens: { resourceId: "res_v2", mediaKind: "video", workId: "wv" } };
  const creatorHost = () => installHost({
    facets: ["agent", "library", "settings", "comic", "video", "notes", "projects", "acquisition"],
    projects: [{ id: "prj_1", name: "合集解说" }],
    overrides: {
      "project.overview": () => ({ recent: [prj], objects: [], suggestions: [], totals: { active: 1, archived: 0 } }),
      "project.list": () => ({ projects: [prj] }),
      "project.get": () => ({ project: prj, materials: [material, other], terms: [], sessions: [] }),
    },
  });
  const goTo = async (id: string) => {
    fireEvent.click(screen.getByTestId(`context-open-${id}`));
    await waitFor(() => expect(screen.getByTestId(`context-${id}`).getAttribute("data-current")).toBe("true"));
  };

  it("a project has its own tabs and conversation, and 最近 comes back as it was: the same player at the same place, the same draft", async () => {
    const host = creatorHost();
    await openVideo();
    const player = element();
    act(() => media.advance(player, 50));
    act(() => { player.dispatchEvent(new Event("pause")); });
    fireEvent.change(screen.getByTestId("agent-composer"), { target: { value: "最近里的问题" } });
    await waitFor(() => expect(tabTitles()).toEqual(["合成动画", READER]));
    const railBefore = railViews();
    expect(railBefore.length).toBeGreaterThan(3);

    // The project: the tabs of its own (its home), no library page of 最近 among them, and the player of 最近 is out of sight.
    await goTo("prj_1");
    await waitFor(() => expect(here().getByTestId("page-project")).toBeTruthy());
    expect(here().queryByTestId("page-library")).toBeNull();
    expect(here().queryByTestId("video-reader")).toBeNull();
    expect(shown(player)).toBe(false);
    expect(media.state(player).paused).toBe(true);
    expect((screen.getByTestId("agent-composer") as HTMLTextAreaElement).value).toBe("");
    // The rail is the application's, not a context's: the same icons in both, and the sidebar stays on its view.
    expect(railViews()).toEqual(railBefore);
    expect(screen.getByTestId("nav-home")).toBeTruthy();
    expect(screen.getByTestId("sidebar").getAttribute("data-view")).toBe("home");

    // A resource opened from a project's materials opens in the project, and the conversation beside it is that resource's in the project.
    await waitFor(() => expect(here().getByTestId("material-open-mat_v1")).toBeTruthy());
    fireEvent.click(here().getByTestId("material-open-mat_v1"));
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(element(), 120));
    await waitFor(() => expect(shown(element())).toBe(true));
    await waitFor(() => expect(screen.getByTestId("conversation-title").textContent).toContain("合成动画"));
    const opened = host.of("session.open").filter((call) => call.input.contextId === "prj_1");
    expect(opened.map((call) => call.input.kind)).toContain("resource");
    // The project's own page has the project's conversation beside it.
    await showTab("合集解说");
    await waitFor(() => expect(screen.getByTestId("conversation-title").textContent).toContain("合集解说"));
    expect(host.of("session.open").filter((call) => call.input.contextId === "prj_1").map((call) => call.input.kind)).toContain("project");
    // The progress is the one the resource has: it opens where 最近 left it.
    const mine = element();
    expect(mine).not.toBe(player);
    await waitFor(() => expect(media.state(mine).seeks).toContain(50));

    // Back in 最近: its tabs, its player, its draft.
    await goTo("recent");
    await waitFor(() => expect(shown(player)).toBe(true));
    expect(element()).toBe(player);
    expect(shown(mine)).toBe(false);
    expect(media.state(mine).paused).toBe(true);
    expect(media.state(player).paused).toBe(true);
    expect(media.state(player).time).toBe(50);
    expect((screen.getByTestId("agent-composer") as HTMLTextAreaElement).value).toBe("最近里的问题");
    expect(here().queryByTestId("page-project")).toBeNull();
    expect(screen.getByTestId("conversation-title").textContent).not.toContain("合集解说");
    expect(tabTitles()).toEqual(["合成动画", READER]);
  });

  it("the same resource open in a project and in 最近 is two players, each at its own place, and the saved place is the latest of either", async () => {
    const host = creatorHost();
    await openVideo();
    const first = element();
    act(() => media.advance(first, 64));
    act(() => { first.dispatchEvent(new Event("pause")); });
    await waitFor(() => expect(host.state.times.get("res_v1")).toBe(64_000));

    await goTo("prj_1");
    await waitFor(() => expect(here().getByTestId("material-open-mat_v1")).toBeTruthy());
    fireEvent.click(here().getByTestId("material-open-mat_v1"));
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    const second = element();
    act(() => media.loaded(second, 120));
    await waitFor(() => expect(media.state(second).seeks).toContain(64));
    act(() => media.advance(second, 26));
    act(() => { second.dispatchEvent(new Event("pause")); });
    await waitFor(() => expect(host.state.times.get("res_v1")).toBe(90_000));

    // 最近 is not moved by what happened in the project: its player stands where it was left.
    await goTo("recent");
    await waitFor(() => expect(shown(first)).toBe(true));
    expect(media.state(first).time).toBe(64);
    expect(media.state(first).paused).toBe(true);
    expect(screen.getByTestId("conversation-title").textContent).not.toContain("合集解说");
  });

  it("the settings belong to no context: opened from either, they add no tab to it, and leaving them finds each context as it was", async () => {
    const host = creatorHost();
    await openVideo();
    const before = tabTitles();
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    expect(tabTitles()).toEqual(before);
    expect(focusedTitle()).toBe(READER);
    // The settings directory stands where the sidebar was: there is no way to another context from it, and the page is kept for the next time.
    expect(screen.queryByTestId("context-open-prj_1")).toBeNull();
    await waitFor(() => expect(host.state.rail.settingsPage).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-home"));
    await waitFor(() => expect(screen.queryByTestId("settings-nav")).toBeNull());
    await goTo("prj_1");
    await waitFor(() => expect(here().getByTestId("page-project")).toBeTruthy());
    expect(tabTitles()).not.toContain("设置");
    // From the project too, the settings are over the workspace and add nothing to it.
    await waitFor(() => expect(tabTitles()).toContain("合集解说"));
    const projectTabs = tabTitles();
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    expect(tabTitles()).toEqual(projectTabs);
    fireEvent.click(screen.getByTestId("nav-home"));
    await waitFor(() => expect(screen.queryByTestId("settings-nav")).toBeNull());
    await goTo("recent");
    expect(focusedTitle()).toBe(READER);
    await waitFor(() => expect(shown(element())).toBe(true));
    expect(tabTitles()).toEqual(before);
  });

  it("hides the whole workspace behind the settings with a rule of the stylesheet, and keeps it in the page", () => {
    const css = readFileSync("apps/desktop/src/renderer/styles-frame.css", "utf8");
    expect(css).toMatch(/\.workspace-area\[data-suspended="true"\] \{[^}]*visibility: hidden/);
    expect(css).toMatch(/\.workspace-area\[data-suspended="true"\] \{[^}]*pointer-events: none/);
    expect(css).not.toMatch(/\.workspace-area\[data-suspended="true"\] \{[^}]*display: none/);
  });
});
