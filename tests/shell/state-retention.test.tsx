/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
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
import { installHost, stay } from "../helpers/app-host.ts";

Element.prototype.scrollIntoView = () => {};

let media: ReturnType<typeof installMediaElement>;
const element = () => screen.getByTestId("video-element") as HTMLVideoElement;
/** Whether the browser would draw the node: an `Activity` that is hidden puts `display: none` on its children. */
const shown = (node: Element) => { for (let at: Element | null = node; at; at = at.parentElement) if (getComputedStyle(at).display === "none") return false; return true; };

async function openWork(nav: "nav-video" | "nav-comic", cardId: string) {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId(nav)).toBeTruthy());
  await stay();
  fireEvent.click(screen.getByTestId(nav));
  await waitFor(() => expect(screen.getByTestId(cardId)).toBeTruthy());
  await stay();
  fireEvent.click(screen.getByTestId(cardId));
  await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
  await waitFor(() => expect((screen.getByTestId("work-read") as HTMLButtonElement).disabled).toBe(false));
  await stay();
}

async function openVideo() {
  await openWork("nav-video", "open-res_v1");
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

describe("AT-88 the page left for settings stays in the background", () => {
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

    // Settings is a page of its own: the player and the right pane are out of sight, not gone.
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    expect(shown(screen.getByTestId("video-reader"))).toBe(false);
    expect(shown(screen.getByTestId("chat-log"))).toBe(false);
    expect(media.state(player).paused).toBe(true);

    fireEvent.click(screen.getByTestId("settings-back"));
    await waitFor(() => expect(shown(screen.getByTestId("video-reader"))).toBe(true));

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
    expect(media.state(player).paused).toBe(true);
    await waitFor(() => expect(host.state.times.get("res_v1")).toBe(30_000));

    fireEvent.click(screen.getByTestId("settings-back"));
    await waitFor(() => expect(shown(screen.getByTestId("video-reader"))).toBe(true));
    expect(media.state(player).paused).toBe(true);
    expect(media.state(player).time).toBe(30);
  });

  it("closing the resource and opening it again goes back to where the viewer was (AT-82)", async () => {
    const host = installHost();
    await openVideo();
    act(() => media.advance(element(), 77));
    act(() => { element().dispatchEvent(new Event("pause")); });
    await waitFor(() => expect(host.state.times.get("res_v1")).toBe(77_000));

    // Leaving through the navigation closes the player; the way back reads the saved place.
    fireEvent.click(screen.getByTestId("nav-video"));
    await waitFor(() => expect(screen.queryByTestId("video-reader")).toBeNull());
    await stay();
    fireEvent.click(screen.getByTestId("open-res_v1"));
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

describe("AT-87 the two modes are two workspaces", () => {
  const counts = { materials: 1, terms: 0, sessions: 1, whiteboards: 2, mindmaps: 1, drafts: 3, excerpts: 0, roughCuts: 1 };
  const prj = { id: "prj_1", name: "合集解说", goal: "做一期合集解说", status: "active", modelConnectionId: null, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z", counts };
  const material = { id: "mat_v1", kind: "resource", targetId: "res_v1", label: "开场", state: "ok", addedAt: "2026-10-01T00:00:00.000Z", opens: { resourceId: "res_v1", mediaKind: "video", workId: "wv" } };
  const other = { id: "mat_v2", kind: "resource", targetId: "res_v2", label: "后续", state: "ok", addedAt: "2026-10-01T00:00:00.000Z", opens: { resourceId: "res_v2", mediaKind: "video", workId: "wv" } };
  const creatorHost = () => installHost({
    facets: ["agent", "library", "settings", "comic", "video", "notes", "projects", "acquisition"],
    overrides: {
      "project.overview": () => ({
        recent: [prj],
        objects: [{ kind: "whiteboard", id: "wb_1", title: "分镜白板", projectId: "prj_1", projectName: "合集解说", updatedAt: "2026-10-02T09:00:00.000Z" }],
        suggestions: [{ id: "sug_1", draftId: "dr_1", draftTitle: "解说稿", projectId: "prj_1", projectName: "合集解说", kind: "polish", createdAt: "2026-10-02T08:00:00.000Z" }],
        totals: { active: 1, archived: 0 },
      }),
      "project.list": () => ({ projects: [prj] }),
      "project.get": () => ({ project: prj, materials: [material, other], terms: [], sessions: [] }),
    },
  });

  it("the work mode has its own navigation and a project overview, and the entertainment mode comes back as it was", async () => {
    const host = creatorHost();
    await openVideo();
    const player = element();
    act(() => media.advance(player, 50));
    act(() => { player.dispatchEvent(new Event("pause")); });
    fireEvent.change(screen.getByTestId("agent-composer"), { target: { value: "娱乐模式里的问题" } });
    await waitFor(() => expect(screen.getByTestId("nav-back")).toHaveProperty("disabled", false));
    const rail = screen.getByTestId("shell-sessions").textContent;
    expect(rail).toContain("res_v1");

    // The work mode: no shelves, a project overview in their place, and a rail of its own.
    fireEvent.click(screen.getByTestId("mode-creator"));
    await waitFor(() => expect(screen.getByTestId("page-project-overview")).toBeTruthy());
    for (const gone of ["nav-reading", "nav-comic", "nav-video", "nav-downloads", "nav-agent"]) expect(screen.queryByTestId(gone), gone).toBeNull();
    expect(screen.getByTestId("nav-library").textContent).toContain("项目总览");
    expect(screen.getByTestId("nav-projects")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("overview-open-prj_1")).toBeTruthy());
    expect(screen.getByTestId("overview-object-wb_1").textContent).toContain("分镜白板");
    expect(screen.getByTestId("overview-suggestion-sug_1").textContent).toContain("解说稿");
    expect(screen.queryByTestId("page-library")).toBeNull();
    expect(shown(screen.getByTestId("video-reader"))).toBe(false);
    expect(media.state(player).paused).toBe(true);
    expect(screen.getByTestId("shell-sessions").textContent).not.toContain("res_v1");
    // Its history is its own: nothing was visited here yet, and the other mode's draft is not here.
    expect(screen.getByTestId("nav-back")).toHaveProperty("disabled", true);
    expect((screen.getByTestId("agent-composer") as HTMLTextAreaElement).value).toBe("");

    // A resource opened from a project's materials opens in the work mode, and the conversation beside it is the project's.
    fireEvent.click(screen.getByTestId("overview-open-prj_1"));
    await waitFor(() => expect(screen.getByTestId("material-open-mat_v1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("material-open-mat_v1"));
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(element(), 120));
    await waitFor(() => expect(shown(screen.getByTestId("video-reader"))).toBe(true));
    await waitFor(() => expect(screen.getByTestId("chat-context").textContent).toContain("合集解说"));
    expect(screen.getByTestId("chat-context").textContent).toContain("合成动画");
    const opened = host.of("session.open").filter((call) => call.input.mode === "creator");
    expect(opened.map((call) => call.input.kind)).not.toContain("resource");
    expect(opened.map((call) => call.input.kind)).toContain("project");
    // The progress is the one both modes share: the resource opens where the other mode left it.
    const mine = element();
    await waitFor(() => expect(media.state(mine).seeks).toContain(50));

    // Back in the entertainment mode: its page, its player, its draft and its history.
    fireEvent.click(screen.getByTestId("mode-enthusiast"));
    await waitFor(() => expect(screen.getByTestId("nav-video")).toBeTruthy());
    expect(shown(screen.getByTestId("video-reader"))).toBe(true);
    // The reader holds the resource that page had open, so it is shown as it is, not loaded again.
    expect(element()).toBe(mine);
    expect(media.state(mine).paused).toBe(true);
    expect(media.state(mine).time).toBe(50);
    expect((screen.getByTestId("agent-composer") as HTMLTextAreaElement).value).toBe("娱乐模式里的问题");
    expect(screen.queryByTestId("page-project-overview")).toBeNull();
    expect(screen.getByTestId("chat-context").textContent).not.toContain("合集解说");
    await waitFor(() => expect(screen.getByTestId("nav-back")).toHaveProperty("disabled", false));
  });

  it("a resource the other mode took the reader for is opened again at its saved place", async () => {
    const host = creatorHost();
    await openVideo();
    act(() => media.advance(element(), 64));
    act(() => { element().dispatchEvent(new Event("pause")); });
    await waitFor(() => expect(host.state.times.get("res_v1")).toBe(64_000));

    fireEvent.click(screen.getByTestId("mode-creator"));
    await waitFor(() => expect(screen.getByTestId("overview-open-prj_1")).toBeTruthy());
    // The work mode opens another resource: the reader's place is taken, as opening one resource releases the one before it.
    fireEvent.click(screen.getByTestId("overview-open-prj_1"));
    await waitFor(() => expect(screen.getByTestId("material-open-mat_v2")).toBeTruthy());
    fireEvent.click(screen.getByTestId("material-open-mat_v2"));
    await waitFor(() => expect(host.of("video.probe").map((call) => call.input.resourceId)).toContain("res_v2"));
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(element(), 120));

    const probes = host.of("video.probe").length;
    fireEvent.click(screen.getByTestId("mode-enthusiast"));
    // Its page was the first resource: it is opened again, at the place it was left.
    await waitFor(() => expect(host.of("video.probe").length).toBeGreaterThan(probes));
    expect(host.of("video.probe").at(-1)!.input.resourceId).toBe("res_v1");
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(element(), 120));
    await waitFor(() => expect(media.state(element()).seeks).toContain(64));
    expect(screen.getByTestId("chat-context").textContent).not.toContain("合集解说");
  });

  it("the choice made in settings stays in settings and puts the other mode's page behind it", async () => {
    creatorHost();
    await openVideo();
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mode-creator"));
    // Still in settings; the work mode's overview is what it returns to.
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    fireEvent.click(screen.getByTestId("settings-back"));
    await waitFor(() => expect(screen.getByTestId("page-project-overview")).toBeTruthy());
  });
});
