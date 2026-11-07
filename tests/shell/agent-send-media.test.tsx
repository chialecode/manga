/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BUILTIN_QUICK_TASKS } from "@manga/contracts";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

Element.prototype.scrollIntoView = () => {};

type Call = { commandId: string; input: Record<string, any> };
type Handler = (input: Record<string, any>) => unknown;

const work = (id: string, kind: "video" | "comic", resourceId: string) => ({
  id, title: `作品 ${id}`, author: "合成作者", mediaKind: kind, shelf: "reading", coverId: null,
  lastResource: { id: resourceId, title: `作品 ${id}`, ordinalLabel: null, revisionId: `rev_${resourceId}` },
  progress: 0.25, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null,
});
const workDetail = (id: string, kind: "video" | "comic", title: string, resourceId: string) => ({
  ...work(id, kind, resourceId), title, originalTitle: title, fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0,
  resources: [{ id: resourceId, title: "第一话", kind, ordinalLabel: "第 1 话", available: true }],
});

/** The quick tasks of a page, as the host's own list gives them: the built-in ones, in their order. */
const quickFor = (page: string) => BUILTIN_QUICK_TASKS.filter((task) => (task.pages as readonly string[]).includes(page))
  .map((task, order) => ({ id: `qt_${task.builtinKey}`, builtin: true, enabled: true, order, ...task }));

function installHost(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const sessions: Array<Record<string, unknown>> = [{ sessionId: "ses_shared", title: "会话 1", kind: "shared", targetId: null, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null }];
  const handlers: Record<string, Handler> = {
    "workspace.get": () => ({ uiFacets: ["agent", "library", "settings", "comic", "video", "notes", "metadata"], sessions: [], runs: [], notes: [], resources: [] }),
    "workspace.sessions": () => sessions,
    "inventory.overview": () => ({ items: [], totals: {} }),
    "settings.get": () => ({ needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: [{ purpose: "text" }] }),
    "notes.list": () => [],
    "quickTasks.list": (input) => ({ tasks: quickFor(String(input.page)) }),
    "session.stream": () => ({ items: [], hasMore: false, session: { id: "ses", kind: "resource", targetId: null, workId: null, resourceId: null } }),
    "works.list": (input) => {
      const items = input.kind === "video" ? [work("wv", "video", "res_v1")] : input.kind === "comic" || !input.kind ? [work("wc", "comic", "res_c1")] : [];
      return { items, total: items.length, nextCursor: null };
    },
    "works.open": (input) => ({ workId: input.workId ?? "wc", shelf: "reading", promoted: false }),
    "works.get": (input) => input.workId === "wv" ? workDetail("wv", "video", "合成动画", "res_v1") : workDetail("wc", "comic", "合成漫画", "res_c1"),
    "covers.list": () => ({ workId: "wc", state: "auto", coverId: null, covers: [] }),
    "video.probe": (input) => ({ resourceId: input.resourceId, revisionId: `rev_${input.resourceId}`, available: true, probe: { durationMs: 120_000 } }),
    "video.audioTracks": () => ({ audio: [] }),
    "video.subtitles": () => ({ subtitles: [] }),
    "video.playbackPlan": () => ({ available: true, plan: { decision: "direct", reasons: [], detail: "" }, copy: null }),
    "video.handle": () => ({ url: "manga-media://h/v", mediaType: "video/mp4", bytes: 1, startMs: 0 }),
    "video.frameIndex": () => { throw Object.assign(new Error("none"), { code: "CAPABILITY_UNAVAILABLE" }); },
    "settings.getMedia": () => ({}),
    "progress.get": () => ({ locator: { kind: "temporal", startMs: 65_000 }, completion: "in_progress" }),
    "session.open": (input) => {
      const id = `ses_${String(input.kind)}_${String(input.targetId)}`;
      if (!sessions.some((row) => row.sessionId === id)) sessions.push({ sessionId: id, title: String(input.targetId), kind: input.kind, targetId: input.targetId, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null });
      return { id };
    },
    "agent.send": () => ({ runId: "run_1", status: "running" }),
    "metadata.related": () => ({ source: null, relations: [], similar: [] }),
    "material.region": () => ({ materialId: "mat_page", mediaType: "image/webp", base64: "AAAA", width: 800, height: 1200, bytes: 3, extraction: "页面图像" }),
    "material.frame": () => ({ materialId: "mat_frame", mediaType: "image/webp", base64: "BBBB", width: 1280, height: 720, bytes: 3, extraction: "视频画面" }),
    "comic.pages": (input) => ({
      resourceId: input.resourceId, revisionId: "rev_res_c1", title: "合成漫画", direction: null, available: true, warnings: [],
      pages: Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true })),
    }),
    "comic.pageHandles": (input) => ({ pages: (input.pageIds as string[]).map((pageId) => ({ pageId, available: true, kind: "image", url: `manga-media://h/${pageId}`, handle: pageId, mediaType: "image/png", width: 800, height: 1200 })) }),
    ...overrides,
  };
  (window as unknown as { manga: unknown }).manga = {
    async state() { return { layout: { channel: "test", pointerPath: "pointer.json", partitions: { data: "d" }, writable: true, recovery: "none" }, writable: true, vaultAvailable: true }; },
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = handlers[payload.commandId];
      if (!handler) return { status: "ok", value: {} };
      try { return { status: "ok", value: handler(input) }; } catch (error) {
        const failure = error as { code?: string; message?: string };
        return { status: "error", error: { code: failure.code ?? "INTERNAL", message: failure.message ?? "failed" } };
      }
    },
    onNotice: () => () => undefined,
    async chooseDirectory() { return null; }, async chooseFile() { return null; }, async chooseAudio() { return null; }, async stashSecret() { return null; },
    async reveal() { return { status: "ok", value: {} }; },
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

let media: ReturnType<typeof installMediaElement>;
const element = () => screen.getByTestId("video-element") as HTMLVideoElement;
const pane = () => within(screen.getByTestId("shell-right"));

async function openFromShelf(nav: string, card: string) {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId(nav)).toBeTruthy());
  fireEvent.click(screen.getByTestId(nav));
  await waitFor(() => expect(screen.getByTestId(card)).toBeTruthy());
  fireEvent.click(screen.getByTestId(card));
  await waitFor(() => expect((screen.getByTestId("work-read") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("work-read"));
}

async function openComic() {
  await openFromShelf("nav-comic", "open-res_c1");
  await waitFor(() => expect(screen.getByTestId("comic-reader")).toBeTruthy());
  await waitFor(() => expect(readerContext.get()).toMatchObject({ kind: "comic", pageNumber: 1, pageCount: 6 }));
  await waitFor(() => expect(pane().getByTestId("chat-pane")).toBeTruthy());
  // Asking the Agent is a choice of the pane; a note is what it starts as.
  fireEvent.click(pane().getByTestId("chat-mode-ask"));
}

async function openVideo() {
  await openFromShelf("nav-video", "open-res_v1");
  await waitFor(() => expect(screen.getByTestId("video-reader")).toBeTruthy());
  await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
  act(() => media.loaded(element(), 120));
  await waitFor(() => expect(readerContext.get()).toMatchObject({ kind: "video", positionMs: 65_000 }));
  await waitFor(() => expect(pane().getByTestId("chat-pane")).toBeTruthy());
  fireEvent.click(pane().getByTestId("chat-mode-ask"));
}

const plusItem = (id: string) => {
  fireEvent.click(pane().getByTestId("chat-plus"));
  return screen.getByTestId(`chat-plus-${id}`);
};

beforeEach(() => {
  window.innerWidth = 1600;
  readerContext.reset();
  quoteTags.reset();
  shelfMemory.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
  media = installMediaElement();
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetVideoSupport();
  resetCovers();
});
afterEach(() => { cleanup(); media.restore(); readerContext.reset(); quoteTags.reset(); vi.restoreAllMocks(); removeMatchMedia(); });

describe("tasks sent from the comic and video pages", () => {
  it("sends the page the user is on, with a picture of it from the \"+\" menu, and spends the picture once sent", async () => {
    const host = installHost();
    await openComic();
    fireEvent.click(plusItem("attach"));
    await waitFor(() => expect(pane().getByTestId("agent-image-mat_page")).toBeTruthy());
    expect(host.of("material.region")[0]!.input).toMatchObject({ resourceId: "res_c1", pageId: "p0" });
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "这一页写了什么？" } });
    fireEvent.click(pane().getByTestId("agent-send"));
    await waitFor(() => expect(host.of("agent.send")).toHaveLength(1));
    const sent = host.of("agent.send")[0]!.input;
    expect(sent).toMatchObject({
      sessionId: "ses_resource_res_c1", text: "这一页写了什么？",
      mediaContext: { comic: { resourceId: "res_c1", resourceRevisionId: "rev_res_c1", pageId: "p0" } },
      imageMaterialIds: ["mat_page"],
    });
    expect(sent.allowCommands).toBeUndefined();
    await waitFor(() => expect(pane().queryByTestId("agent-image-mat_page")).toBeNull());
  });

  it("lets a picture be attached while a task runs, keeps it out of that task, and sends it with the next one", async () => {
    let status = "running";
    const run = () => ({ runId: "run_1", id: "run_1", status, sessionId: "ses_resource_res_c1", inputText: "第一问", messages: [] });
    let sent = false;
    const host = installHost({
      "workspace.get": () => ({ uiFacets: ["agent", "library", "settings", "comic", "video", "notes", "metadata"], sessions: [], runs: sent ? [{ id: "run_1", sessionId: "ses_resource_res_c1", status }] : [], notes: [], resources: [] }),
      "agent.send": () => { sent = true; return run(); },
      "agent.getRun": () => run(),
    });
    await openComic();
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "第一问" } });
    fireEvent.click(pane().getByTestId("agent-send"));
    await waitFor(() => expect(pane().getByTestId("agent-stop")).toBeTruthy());
    // The running task's materials are fixed; a picture taken now waits for the next send.
    const attach = plusItem("attach") as HTMLButtonElement;
    expect(attach.disabled).toBe(false);
    fireEvent.click(attach);
    await waitFor(() => expect(pane().getByTestId("agent-image-mat_page")).toBeTruthy());
    expect(host.of("agent.send")).toHaveLength(1);
    expect(host.of("agent.send")[0]!.input.imageMaterialIds).toBeUndefined();
    status = "completed";
    await waitFor(() => expect(pane().getByTestId("agent-send")).toBeTruthy());
    expect(pane().getByTestId("agent-image-mat_page")).toBeTruthy();
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "这张图呢？" } });
    fireEvent.click(pane().getByTestId("agent-send"));
    await waitFor(() => expect(host.of("agent.send")).toHaveLength(2));
    expect(host.of("agent.send")[1]!.input).toMatchObject({ text: "这张图呢？", imageMaterialIds: ["mat_page"] });
  });

  it("sends a framed region as a picture of that region, and removes the tag with the send", async () => {
    const host = installHost();
    await openComic();
    act(() => quoteTags.put({ kind: "region", resourceId: "res_c1", revisionId: "rev_res_c1", pageId: "p0", pageNumber: 1, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, label: "第 1 页 · 区域" }));
    await waitFor(() => expect(pane().getByTestId("chat-tag-region")).toBeTruthy());
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "这个格子里是谁？" } });
    fireEvent.click(pane().getByTestId("agent-send"));
    await waitFor(() => expect(host.of("agent.send")).toHaveLength(1));
    expect(host.of("material.region")[0]!.input).toMatchObject({ resourceId: "res_c1", pageId: "p0", region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });
    expect(host.of("agent.send")[0]!.input).toMatchObject({ imageMaterialIds: ["mat_page"], mediaContext: { comic: { pageId: "p0", region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } } } });
    await waitFor(() => expect(pane().queryByTestId("chat-tag-region")).toBeNull());
  });

  it("a quick task on a comic page is one visible send that prepares its own picture", async () => {
    const host = installHost();
    await openComic();
    await waitFor(() => expect(pane().getByTestId("quick-read-text")).toBeTruthy());
    fireEvent.click(pane().getByTestId("quick-read-text"));
    await waitFor(() => expect(host.of("agent.send")).toHaveLength(1));
    expect(host.of("material.region")).toHaveLength(1);
    expect(host.of("agent.send")[0]!.input).toMatchObject({ imageMaterialIds: ["mat_page"], mediaContext: { comic: { pageId: "p0" } }, quickTask: { name: "识别这一页的文字" } });
    expect(String(host.of("agent.send")[0]!.input.text)).toContain("文字");
  });

  it("sends the video position, the explicit subtitle widening and the online-search choice for this send only", async () => {
    const host = installHost();
    await openVideo();
    fireEvent.click(plusItem("ahead-3"));
    fireEvent.click(plusItem("online"));
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "刚才这句是什么意思？" } });
    fireEvent.click(pane().getByTestId("agent-send"));
    await waitFor(() => expect(host.of("agent.send")).toHaveLength(1));
    const sent = host.of("agent.send")[0]!.input;
    expect(sent.mediaContext.video).toMatchObject({ resourceId: "res_v1", resourceRevisionId: "rev_res_v1", subtitleAheadMs: 180_000 });
    expect(sent.mediaContext.video.positionMs).toBe(65_000);
    expect(sent.allowCommands).toEqual(["metadata.search"]);
    // What was chosen for one task does not carry to the next.
    await waitFor(() => expect(plusItem("ahead-0").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByTestId("chat-plus-online").getAttribute("aria-checked")).toBe("false");
    fireEvent.keyDown(screen.getByTestId("chat-plus-online"), { key: "Escape" });
    await waitFor(() => expect(pane().getByTestId("agent-send")).toBeTruthy());
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "再问一次" } });
    fireEvent.click(pane().getByTestId("agent-send"));
    await waitFor(() => expect(host.of("agent.send")).toHaveLength(2));
    expect(host.of("agent.send")[1]!.input.mediaContext.video).not.toHaveProperty("subtitleAheadMs");
    expect(host.of("agent.send")[1]!.input.allowCommands).toBeUndefined();
  });

  it("sends a marked interval as the task's interval, and a quick task for it appears with the mark", async () => {
    const host = installHost();
    await openVideo();
    act(() => quoteTags.put({ kind: "interval", resourceId: "res_v1", revisionId: "rev_res_v1", startMs: 30_000, endMs: 40_000, label: "0:30—0:40" }));
    await waitFor(() => expect(pane().getByTestId("chat-tag-interval")).toBeTruthy());
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "这一段在讲什么？" } });
    fireEvent.click(pane().getByTestId("agent-send"));
    await waitFor(() => expect(host.of("agent.send")).toHaveLength(1));
    expect(host.of("agent.send")[0]!.input.mediaContext.video).toMatchObject({ interval: { startMs: 30_000, endMs: 40_000 } });
    await waitFor(() => expect(pane().queryByTestId("chat-tag-interval")).toBeNull());
  });

  it("keeps a failed frame capture visible without losing the draft", async () => {
    const host = installHost({ "material.frame": () => { throw Object.assign(new Error("no frame"), { code: "CAPABILITY_UNAVAILABLE" }); } });
    await openVideo();
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "画面里有什么？" } });
    fireEvent.click(plusItem("attach"));
    await waitFor(() => expect(host.of("material.frame")).toHaveLength(1));
    expect(host.of("material.frame")[0]!.input).toMatchObject({ resourceId: "res_v1", timeMs: 65_000 });
    expect(pane().queryByTestId("agent-image-mat_frame")).toBeNull();
    expect((pane().getByTestId("agent-composer") as HTMLTextAreaElement).value).toBe("画面里有什么？");
    await waitFor(() => expect(screen.getByTestId("toast-error").textContent).toContain("no frame"));
  });
});
