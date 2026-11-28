/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { findConflicts, resolveKeys } from "@manga/contracts/keys";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { EdgeHandle, EDGE_DWELL_MS, EDGE_GRACE_MS } from "../../apps/desktop/src/renderer/components/capture/edge-handle.tsx";
import { MicButton } from "../../apps/desktop/src/renderer/components/chat/composer.tsx";
import { captureBridge, quickNoteSession } from "../../apps/desktop/src/renderer/lib/capture-bridge.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { captureEditableTarget } from "../../apps/desktop/src/renderer/voice/editable-target.ts";
import { installCapture, installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";
import { installHost, workDetail, type Handler } from "../helpers/app-host.ts";
import { openShelf, openWorkPage } from "../helpers/workspace-ui.ts";

Element.prototype.scrollIntoView = () => {};

const i18n = createTranslator("zh-CN");
const t = i18n.t;

let media: ReturnType<typeof installMediaElement>;
let capture: ReturnType<typeof installCapture>;

function setFullscreenElement(target: Element | null) {
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => target });
  act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
}

function installAppHost(overrides: Record<string, Handler> = {}) {
  const novelWork = {
    id: "wn", title: "合成小说", author: "合成作者", mediaKind: "novel", shelf: "reading", coverId: null,
    lastResource: { id: "res_n1", title: "第一卷", ordinalLabel: "第 1 卷", revisionId: "rev_res_n1" },
    progress: 0.1, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null,
  };
  const comicWork = {
    id: "wc", title: "合成漫画", author: "合成作者", mediaKind: "comic", shelf: "reading", coverId: null,
    lastResource: { id: "res_c1", title: "第一话", ordinalLabel: "第 1 话", revisionId: "rev_res_c1" },
    progress: 0.2, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null,
  };
  const videoWork = {
    id: "wv", title: "合成动画", author: "合成作者", mediaKind: "video", shelf: "reading", coverId: null,
    lastResource: { id: "res_v1", title: "第一集", ordinalLabel: "第 1 集", revisionId: "rev_res_v1" },
    progress: 0.2, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null,
  };
  const allWorks = [novelWork, comicWork, videoWork];
  return installHost({
    facets: ["agent", "library", "settings", "comic", "video", "notes", "voice", "roughcut", "projects"],
    overrides: {
      "works.list": (input) => {
        const items = input.kind ? allWorks.filter((item) => item.mediaKind === input.kind) : allWorks;
        return { items, total: items.length, nextCursor: null };
      },
      "works.get": (input) => {
        if (input.workId === "wn") return { ...novelWork, originalTitle: "合成小说", fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources: [{ id: "res_n1", title: "第一卷", kind: "novel", ordinalLabel: "第 1 卷", available: true }] };
        if (input.workId === "wc") return workDetail("wc", "comic", "合成漫画", [{ id: "res_c1", title: "第一话", kind: "comic", ordinalLabel: "第 1 话", available: true }]);
        return workDetail("wv", "video", "合成动画", [{ id: "res_v1", title: "第一集", kind: "video", ordinalLabel: "第 1 集", available: true }]);
      },
      "library.read": () => ({
        resourceId: "res_n1",
        revisionId: "rev_res_n1",
        title: "合成小说",
        workId: "wn",
        format: "txt",
        warnings: [],
        toc: [{ label: "第一章", partId: "p1" }],
        parts: [{ id: "p1", title: "第一章", kind: "text", length: 80, textLayer: true }],
        slice: { partId: "p1", text: "这是一个用于测试划词气泡和右键菜单的合成小说段落。", start: 0, end: 25, kind: "text", textLayer: true, images: [] },
        source: { available: true },
      }),
      "comic.pages": (input) => ({
        resourceId: input.resourceId,
        revisionId: "rev_res_c1",
        title: "合成漫画",
        workId: "wc",
        direction: null,
        available: true,
        warnings: [],
        pages: Array.from({ length: 3 }, (_, index) => ({ id: `p${index}`, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true })),
      }),
      "progress.get": () => ({ locator: { kind: "temporal", startMs: 12_000 }, completion: "in_progress" }),
      "screenshot.save": () => ({ screenshot: { id: "shot_edge_1", title: "截图" } }),
      "screenshot.image": () => ({ url: "manga-media://h/shot", mediaType: "image/png" }),
      ...overrides,
    },
  });
}

async function openVideo(hostOverrides: Record<string, Handler> = {}) {
  const host = installAppHost(hostOverrides);
  render(<App />);
  await openShelf("video");
  await openWorkPage("open-res_v1");
  fireEvent.click(screen.getByTestId("work-read"));
  const video = () => screen.getByTestId("video-element") as HTMLVideoElement;
  await waitFor(() => expect(video().getAttribute("src")).toBeTruthy());
  act(() => media.loaded(video(), 120));
  await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"));
  return { host, video };
}

async function openNovel(hostOverrides: Record<string, Handler> = {}) {
  const host = installAppHost(hostOverrides);
  render(<App />);
  await openShelf("novel");
  await openWorkPage("open-res_n1");
  fireEvent.click(screen.getByTestId("work-read"));
  await waitFor(() => expect(screen.getByTestId("reading-body")).toBeTruthy());
  return { host };
}

async function openComic(hostOverrides: Record<string, Handler> = {}) {
  const host = installAppHost(hostOverrides);
  render(<App />);
  await openShelf("comic");
  await openWorkPage("open-res_c1");
  fireEvent.click(screen.getByTestId("work-read"));
  await waitFor(() => expect(screen.getByTestId("comic-reader")).toBeTruthy());
  await waitFor(() => expect(document.querySelectorAll("img.comic-image").length).toBeGreaterThan(0));
  return { host };
}

beforeEach(() => {
  window.innerWidth = 1600;
  window.innerHeight = 900;
  media = installMediaElement();
  capture = installCapture();
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetVideoSupport();
  resetCovers();
  shelfMemory.reset();
  quoteTags.reset();
  readerContext.reset();
  captureBridge.reset();
  quickNoteSession.reset();
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

afterEach(() => {
  cleanup();
  capture.restore();
  media.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
  removeMatchMedia();
  quoteTags.reset();
  readerContext.reset();
  captureBridge.reset();
  quickNoteSession.reset();
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
});

describe("shortcuts table: global.quickNote and novel.fullscreen", () => {
  it("registers global.quickNote (N, Alt+N) and novel.fullscreen (F) with zero conflicts", () => {
    const resolved = resolveKeys(null);
    expect(resolved["global.quickNote"]).toEqual(["N", "Alt+N"]);
    expect(resolved["novel.fullscreen"]).toEqual(["F"]);
    expect(findConflicts(resolved)).toEqual([]);
  });
});

describe("EdgeHandle hover dwell, grace delay, recording indicator, and pure-toggle MicButton", () => {
  it("stays invisible while idle, requires 150ms hover dwell to expand, collapses after grace delay, and shows pulsing red pill when recording", () => {
    vi.useFakeTimers();
    const onOpenNote = vi.fn();
    const onShot = vi.fn();
    const onDock = vi.fn();
    const onToggle = vi.fn();
    const onStop = vi.fn();

    const view = render(
      <EdgeHandle
        t={t}
        mic={{ state: { phase: "idle", elapsedMs: 0, level: 0 }, enabled: true, toggleKey: "F8", onToggle, onStop }}
        noteable={true}
        quickNoteKey="N"
        onOpenQuickNote={onOpenNote}
        screenshot={{ label: "截图", disabled: false, key: "S", onTake: onShot }}
        dock={{ key: "Ctrl + Alt + B", onOpen: onDock }}
      />,
    );

    const handle = () => screen.getByTestId("edge-handle");
    const hotzone = screen.getByTestId("edge-handle-hotzone");
    const zone = screen.getByTestId("edge-handle-zone");

    // Idle: collapsed, no recording pill.
    expect(handle().getAttribute("data-expanded")).toBe("false");
    expect(screen.queryByTestId("edge-handle-recording-pill")).toBeNull();

    // Brief pointer sweep (< 150ms) does not expand (dual-monitor anti-accidental-trigger).
    fireEvent.pointerEnter(hotzone);
    act(() => { vi.advanceTimersByTime(EDGE_DWELL_MS - 40); });
    expect(handle().getAttribute("data-expanded")).toBe("false");
    fireEvent.pointerLeave(zone);
    act(() => { vi.advanceTimersByTime(EDGE_DWELL_MS); });
    expect(handle().getAttribute("data-expanded")).toBe("false");

    // Staying >= 150ms expands the capsule; leaving collapses after grace delay.
    fireEvent.pointerEnter(hotzone);
    act(() => { vi.advanceTimersByTime(EDGE_DWELL_MS); });
    expect(handle().getAttribute("data-expanded")).toBe("true");
    expect(screen.getByTestId("edge-note").getAttribute("title")).toContain("N");
    expect(screen.getByTestId("edge-screenshot").getAttribute("title")).toContain("S");
    expect(screen.getByTestId("edge-dock").getAttribute("title")).toContain("Ctrl + Alt + B");
    // Mouse down on capsule controls prevents focus steal so reader keys stay active and pointer-leave still collapses cleanly.
    const micDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    screen.getByTestId("edge-mic").dispatchEvent(micDown);
    expect(micDown.defaultPrevented).toBe(true);

    fireEvent.pointerLeave(zone);
    act(() => { vi.advanceTimersByTime(EDGE_GRACE_MS - 20); });
    expect(handle().getAttribute("data-expanded")).toBe("true");
    act(() => { vi.advanceTimersByTime(30); });
    expect(handle().getAttribute("data-expanded")).toBe("false");

    // Active recording shows the slim vertical red indicator pill when collapsed.
    view.rerender(
      <EdgeHandle
        t={t}
        mic={{ state: { phase: "recording", elapsedMs: 12_000, level: 0.3 }, enabled: true, toggleKey: "F8", onToggle, onStop }}
        noteable={true}
        quickNoteKey="N"
        onOpenQuickNote={onOpenNote}
        screenshot={{ label: "截图", disabled: false, key: "S", onTake: onShot }}
        dock={{ key: "Ctrl + Alt + B", onOpen: onDock }}
      />,
    );
    expect(screen.getByTestId("edge-handle-recording-pill")).toBeTruthy();
    expect(screen.getByTestId("edge-mic-time").textContent).toBe("0:12");

    // Keyboard focus immediately expands and hides the collapsed pill.
    fireEvent.focus(screen.getByTestId("edge-mic"));
    expect(handle().getAttribute("data-expanded")).toBe("true");
    expect(screen.queryByTestId("edge-handle-recording-pill")).toBeNull();
  });

  it("MicButton in Composer is pure ON/OFF toggle with no press-and-hold hijacking", () => {
    vi.useFakeTimers();
    const onToggle = vi.fn();
    const onStop = vi.fn();
    const view = render(
      <MicButton
        t={t}
        state={{ phase: "idle", elapsedMs: 0, level: 0 }}
        enabled={true}
        toggleKey="F8"
        onToggle={onToggle}
        onStop={onStop}
      />,
    );
    const btn = screen.getByTestId("chat-mic");
    // Holding mouse down past 500ms does NOT start recording before click.
    fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.pointerUp(btn, { button: 0, pointerId: 1 });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);

    view.rerender(
      <MicButton
        t={t}
        state={{ phase: "recording", elapsedMs: 5000, level: 0.4 }}
        enabled={true}
        toggleKey="F8"
        onToggle={onToggle}
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-mic"));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe("QuickNoteModal: anchor freeze, pauseOnQuickNote, draft persistence, expand-to-dock, dictation, and Esc safety", () => {
  it("freezes the exact video timestamp on open even as playback advances, preserves draft on Esc, and expands draft+tags to right dock", async () => {
    const { host, video } = await openVideo();
    // Initial startMs is 12s from progress.get; advancing 12.4s lands at 24.4s.
    act(() => media.advance(video(), 12.4));

    // Open QuickNote via N shortcut (default pauseOnQuickNote: false -> does not pause!).
    await act(async () => { await video().play(); });
    expect(video().paused).toBe(false);
    fireEvent.keyDown(window, { key: "n" });
    const modal = await screen.findByTestId("quick-note-modal");
    expect(modal.getAttribute("role")).toBe("dialog");
    expect(modal.getAttribute("aria-modal")).toBe("false");
    expect(video().paused).toBe(false);
    expect(screen.getByTestId("quick-note-tag-position").textContent).toContain("0:24");

    // Textarea is auto-focused and seamlessly accepts RightAlt dictation insertion via captureEditableTarget.
    const input = screen.getByTestId("quick-note-input") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    const dictationTarget = captureEditableTarget();
    expect(dictationTarget?.kind).toBe("native");
    expect(dictationTarget?.element).toBe(input);
    act(() => { dictationTarget?.insert("听写草稿"); });
    expect(input.value).toBe("听写草稿");
    dictationTarget?.dispose();

    // Advance playback 30.4s further (24.4 -> 54.8s) while typing.
    act(() => media.advance(video(), 30.4));
    fireEvent.change(input, { target: { value: "未发送的草稿" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("quick-note-modal")).toBeNull();

    // Reopen restores draft, and saving uses the frozen timestamp from the second open (54.8s -> 0:54), not later time (80.2s).
    fireEvent.keyDown(window, { key: "n", altKey: true });
    const reopenedInput = await screen.findByTestId("quick-note-input") as HTMLTextAreaElement;
    expect(reopenedInput.value).toBe("未发送的草稿");
    expect(screen.getByTestId("quick-note-tag-position").textContent).toContain("0:54");
    act(() => media.advance(video(), 25.4));
    fireEvent.keyDown(reopenedInput, { key: "Enter" });
    await waitFor(() => expect(host.of("notes.create")).toHaveLength(1));
    expect(host.of("notes.create")[0]!.input).toMatchObject({
      text: "未发送的草稿",
      locator: { kind: "temporal", startMs: 54_800 },
    });
    await waitFor(() => expect(screen.queryByTestId("quick-note-modal")).toBeNull());

    // Fold dock, mark A-B interval, open QuickNote, click "在对话栏展开" -> transfers draft + tag into right-dock overlay.
    fireEvent.click(screen.getByTestId("shell-dock-toggle"));
    await screen.findByTestId("edge-handle-zone");
    fireEvent.keyDown(window, { key: "i" });
    act(() => media.advance(video(), 10));
    fireEvent.keyDown(window, { key: "o" });
    fireEvent.keyDown(window, { key: "n" });
    fireEvent.change(await screen.findByTestId("quick-note-input"), { target: { value: "转去对话栏细写" } });
    fireEvent.click(screen.getByTestId("quick-note-expand"));
    await waitFor(() => expect(screen.queryByTestId("quick-note-modal")).toBeNull());
    expect(screen.getByTestId("shell-dock").getAttribute("data-shell-state")).toBe("overlay");
    expect((within(screen.getByTestId("shell-dock")).getByTestId("agent-composer") as HTMLTextAreaElement).value).toBe("转去对话栏细写");
    expect(within(screen.getByTestId("shell-dock")).getByTestId("chat-tag-interval")).toBeTruthy();
  });

  it("pauseOnQuickNote: true pauses playing video on open, resumes on close, and respects manual playback toggle while open", async () => {
    const { video } = await openVideo({
      "settings.getMedia": () => ({ video: { pauseOnQuickNote: true } }),
    });
    await act(async () => { await video().play(); });
    expect(video().paused).toBe(false);

    // Opening QuickNote pauses playback; pressing Esc resumes it.
    fireEvent.keyDown(window, { key: "n" });
    await screen.findByTestId("quick-note-modal");
    await waitFor(() => expect(video().paused).toBe(true));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("quick-note-modal")).toBeNull());
    await waitFor(() => expect(video().paused).toBe(false));

    // If user manually resumes & pauses while modal is open, closing does NOT force resume.
    fireEvent.keyDown(window, { key: "n" });
    await screen.findByTestId("quick-note-modal");
    await waitFor(() => expect(video().paused).toBe(true));
    await act(async () => { await video().play(); });
    act(() => { video().pause(); });
    expect(video().paused).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("quick-note-modal")).toBeNull());
    expect(video().paused).toBe(true);
  });
});

describe("Dual fullscreen consistency (W & F) and temporary right-dock overlay drawer", () => {
  it("opens dock overlay drawer inside window fullscreen via EdgeHandle and Ctrl+Alt+B, and Esc closes layers in order without exiting W prematurely", async () => {
    await openVideo();
    const shellRoot = screen.getByTestId("shell-root");

    // Enter window fullscreen (W).
    fireEvent.keyDown(window, { key: "w" });
    expect(shellRoot.getAttribute("data-immersive")).toBe("true");
    expect(screen.getByTestId("edge-handle-zone")).toBeTruthy();

    // Open QuickNoteModal in window fullscreen; Esc closes modal WITHOUT exiting window fullscreen.
    fireEvent.keyDown(window, { key: "n" });
    expect(await screen.findByTestId("quick-note-modal")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("quick-note-modal")).toBeNull();
    expect(shellRoot.getAttribute("data-immersive")).toBe("true");

    // Open temporary right-dock overlay drawer via EdgeHandle dock button WITHOUT exiting window fullscreen.
    fireEvent.click(screen.getByTestId("edge-handle-hotzone"));
    fireEvent.click(screen.getByTestId("edge-dock"));
    expect(screen.getByTestId("shell-dock").getAttribute("data-shell-state")).toBe("overlay");
    expect(shellRoot.getAttribute("data-immersive")).toBe("true");
    // Esc closes dock overlay drawer first, keeping window fullscreen active!
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("shell-dock").getAttribute("data-shell-state")).toBe("hidden");
    expect(shellRoot.getAttribute("data-immersive")).toBe("true");

    // Ctrl+Alt+B toggles the dock overlay drawer during window fullscreen too!
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    expect(screen.getByTestId("shell-dock").getAttribute("data-shell-state")).toBe("overlay");
    expect(shellRoot.getAttribute("data-immersive")).toBe("true");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    expect(screen.getByTestId("shell-dock").getAttribute("data-shell-state")).toBe("hidden");
    expect(shellRoot.getAttribute("data-immersive")).toBe("true");

    // Final Esc exits window fullscreen cleanly.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shellRoot.getAttribute("data-immersive")).toBe("false");
  });

  it("novel reader supports F shortcut for screen fullscreen and portals EdgeHandle + QuickNoteModal into document.fullscreenElement", async () => {
    await openNovel();
    const page = screen.getByTestId("reading-page");
    const req = vi.fn(async () => { setFullscreenElement(page); });
    Object.defineProperty(page, "requestFullscreen", { configurable: true, value: req });

    // Even when right dock is docked, entering screen fullscreen (F) mounts EdgeHandle inside document.fullscreenElement.
    fireEvent.keyDown(window, { key: "f" });
    expect(req).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(page.contains(screen.getByTestId("edge-handle-zone"))).toBe(true));

    // Opening QuickNoteModal in screen fullscreen portals it inside document.fullscreenElement too.
    fireEvent.keyDown(window, { key: "n" });
    const modal = await screen.findByTestId("quick-note-modal");
    expect(page.contains(modal)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("quick-note-modal")).toBeNull();
  });
});

describe("Plan D context triggers across Novel, Comic, and Video", () => {
  it("Novel: casual text selection shows SelectionBubble without auto-stuffing composer; Note opens QuickNote, Ask attaches tag, Copy writes clipboard, and right-click menu works", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await openNovel();

    const body = screen.getByTestId("reading-body");
    const selectRange = (start: number, end: number) => {
      const textNode = body.firstChild as Text;
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      act(() => { document.dispatchEvent(new Event("selectionchange")); });
    };

    selectRange(2, 10);
    // Even after 500ms, casual selection MUST NOT silently stuff a tag into the right dock!
    act(() => { vi.advanceTimersByTime(500); });
    expect(quoteTags.all()).toEqual([]);
    expect(screen.queryByTestId("chat-tag-selection")).toBeNull();

    // Floating bubble appears with Note / Ask / Copy.
    const bubble = screen.getByTestId("selection-bubble");
    expect(bubble.getAttribute("data-kind")).toBe("novel");
    fireEvent.click(screen.getByTestId("selection-bubble-copy"));
    expect(writeText).toHaveBeenCalledWith("一个用于测试划词");

    // Pressing N while text is selected also freezes the selected text tag in QuickNoteModal.
    selectRange(2, 10);
    fireEvent.keyDown(window, { key: "n" });
    expect(await screen.findByTestId("quick-note-modal")).toBeTruthy();
    expect(screen.getByTestId("quick-note-tag-selection")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    // Note button opens QuickNoteModal with frozen selection tag.
    selectRange(2, 10);
    fireEvent.click(screen.getByTestId("selection-bubble-note"));
    expect(await screen.findByTestId("quick-note-modal")).toBeTruthy();
    expect(screen.getByTestId("quick-note-tag-selection")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    // Ask button attaches tag to right dock and switches to ask mode.
    selectRange(2, 10);
    fireEvent.click(screen.getByTestId("selection-bubble-ask"));
    await waitFor(() => expect(within(screen.getByTestId("shell-dock")).getByTestId("chat-tag-selection")).toBeTruthy());
    expect(within(screen.getByTestId("shell-dock")).getByTestId("chat-mode-ask").getAttribute("aria-pressed")).toBe("true");

    // Right-click menu without selection shows Note & Record; with selection also shows Copy & Ask.
    fireEvent.contextMenu(screen.getByTestId("reading-scroll"), { clientX: 200, clientY: 200 });
    expect(screen.getByTestId("novel-context")).toBeTruthy();
    expect(screen.getByTestId("novel-context-note")).toBeTruthy();
    expect(screen.getByTestId("novel-context-record")).toBeTruthy();
    expect(screen.queryByTestId("novel-context-copy")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("novel-context")).toBeNull();

    selectRange(2, 10);
    fireEvent.contextMenu(screen.getByTestId("reading-scroll"), { clientX: 200, clientY: 200 });
    expect(screen.getByTestId("novel-context-copy")).toBeTruthy();
    expect(screen.getByTestId("novel-context-ask")).toBeTruthy();
  });

  it("Comic: region draw shows SelectionBubble (Note, Ask, Screenshot, Cancel) and right-click context menu works", async () => {
    const { host } = await openComic();

    // Right-click context menu on comic stage has Note, Record, Screenshot.
    fireEvent.contextMenu(screen.getByTestId("comic-stage"), { clientX: 200, clientY: 200 });
    expect(screen.getByTestId("comic-context")).toBeTruthy();
    expect(screen.getByTestId("comic-context-note")).toBeTruthy();
    expect(screen.getByTestId("comic-context-record")).toBeTruthy();
    expect(screen.getByTestId("comic-context-screenshot")).toBeTruthy();
    fireEvent.click(screen.getByTestId("comic-context-screenshot"));
    await waitFor(() => expect(host.of("screenshot.save")).toHaveLength(1));

    // Drawing a region shows the unified floating SelectionBubble.
    fireEvent.click(screen.getByTestId("comic-region-tool"));
    const layer = screen.getByTestId("comic-select-layer-0");
    layer.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 600, right: 500, bottom: 650, x: 100, y: 50, toJSON: () => ({}) });
    fireEvent.pointerDown(layer, { clientX: 140, clientY: 110, button: 0, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 340, clientY: 410, button: 0, pointerId: 1 });

    const bubble = await screen.findByTestId("selection-bubble");
    expect(bubble.getAttribute("data-kind")).toBe("comic");
    expect(screen.getByTestId("selection-bubble-note")).toBeTruthy();
    expect(screen.getByTestId("selection-bubble-ask")).toBeTruthy();
    expect(screen.getByTestId("selection-bubble-screenshot")).toBeTruthy();
    expect(screen.getByTestId("selection-bubble-cancel")).toBeTruthy();

    fireEvent.click(screen.getByTestId("selection-bubble-note"));
    expect(await screen.findByTestId("quick-note-modal")).toBeTruthy();
    expect(screen.getByTestId("quick-note-tag-region")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByTestId("selection-bubble-cancel"));
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
    expect(quoteTags.all()).toEqual([]);
  });

  it("Video: right-click menu offers Note/Record/Screenshot and A-B interval renders floating action pill", async () => {
    const { host, video } = await openVideo();

    fireEvent.contextMenu(screen.getByTestId("video-stage"), { clientX: 200, clientY: 200 });
    expect(screen.getByTestId("video-context-note")).toBeTruthy();
    expect(screen.getByTestId("video-context-record")).toBeTruthy();
    expect(screen.getByTestId("video-context-screenshot")).toBeTruthy();
    fireEvent.click(screen.getByTestId("video-context-screenshot"));
    await waitFor(() => expect(host.of("screenshot.save")).toHaveLength(1));

    // Marking A-B (starting at 12s -> +10s = 22s, +10s = 32s) shows the floating action pill with Note, Ask, Add-to-Roughcut, and Clear.
    act(() => media.advance(video(), 10));
    fireEvent.keyDown(window, { key: "i" });
    act(() => media.advance(video(), 10));
    fireEvent.keyDown(window, { key: "o" });

    const bubble = await screen.findByTestId("selection-bubble");
    expect(bubble.getAttribute("data-kind")).toBe("video");
    expect(screen.getByTestId("selection-bubble-badge").textContent).toContain("0:22—0:32");
    expect(screen.getByTestId("selection-bubble-note")).toBeTruthy();
    expect(screen.getByTestId("selection-bubble-ask")).toBeTruthy();
    expect(within(bubble).getByTestId("add-to-roughcut")).toBeTruthy();
    expect(screen.getByTestId("selection-bubble-clear")).toBeTruthy();

    fireEvent.click(screen.getByTestId("selection-bubble-clear"));
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
  });
});
