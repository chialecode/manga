/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import type { NoteBlock } from "@manga/contracts";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { NoteEditor } from "../../apps/desktop/src/renderer/note-editor.tsx";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { installCapture, installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

Element.prototype.scrollIntoView = () => {};

type Call = { commandId: string; input: Record<string, any> };
type Handler = (input: Record<string, any>) => unknown;

const work = (id: string, kind: "video" | "comic", resourceId: string) => ({
  id, title: `作品 ${id}`, author: "合成作者", mediaKind: kind, shelf: "reading", coverId: null,
  lastResource: { id: resourceId, title: `作品 ${id}`, ordinalLabel: null, revisionId: `rev_${resourceId}` },
  progress: 0.25, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null,
});
const workDetail = (id: string, kind: "video" | "comic", title: string, resources: Array<Record<string, unknown>>) => ({
  ...work(id, kind, String(resources[0]!.id)), title, originalTitle: title, fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources,
});

const folder = { id: "wf1", title: "合成动画", relDir: "动漫/合成动画", mediaKind: "video", ownerKind: "work", ownerId: "wv", createdAt: "2026-01-01T00:00:00.000Z" };
const folderFile = { id: "f1", folderId: "wf1", workId: "wv", resourceId: "res_v1", kind: "screenshot", subDir: "截图", fileName: "合成动画 1-05.png", refKind: "screenshot", refId: "shot_1", bytes: 2048, createdAt: "2026-01-02T00:00:00.000Z" };

function installHost(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const revealed: string[] = [];
  const sessions: Array<Record<string, unknown>> = [{ sessionId: "ses_shared", title: "会话 1", kind: "shared", targetId: null, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null }];
  const handlers: Record<string, Handler> = {
    "workspace.get": () => ({ uiFacets: ["agent", "library", "settings", "comic", "video", "notes", "voice", "whiteboard", "projects"], sessions: [], runs: [], notes: [], resources: [] }),
    "workspace.sessions": () => sessions,
    "inventory.overview": () => ({ items: [], totals: {} }),
    "settings.get": () => ({ needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: [{ purpose: "text" }] }),
    "notes.list": () => [{ objectId: "n1", title: "一条笔记", tags: [], preview: "", revision: 3 }],
    "quickTasks.list": () => ({ tasks: [] }),
    "session.open": (input) => {
      const id = `ses_${String(input.kind)}_${String(input.targetId)}`;
      if (!sessions.some((row) => row.sessionId === id)) sessions.push({ sessionId: id, title: String(input.targetId), kind: input.kind, targetId: input.targetId, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null });
      return { id, kind: input.kind, targetId: input.targetId };
    },
    "session.stream": () => ({ items: [], hasMore: false, session: { id: "ses", kind: "work", targetId: null, workId: null, resourceId: null } }),
    "works.list": (input) => {
      const items = input.kind === "video" || !input.kind ? [work("wv", "video", "res_v1")] : input.kind === "comic" ? [work("wc", "comic", "res_c1")] : [];
      return { items, total: items.length, nextCursor: null };
    },
    "works.open": () => ({ workId: "wv", shelf: "reading", promoted: false }),
    "works.get": (input) => input.workId === "wc"
      ? workDetail("wc", "comic", "合成漫画", [{ id: "res_c1", title: "漫画一", kind: "comic", ordinalLabel: "第 1 话", available: true }])
      : workDetail("wv", "video", "合成动画", [{ id: "res_v1", title: "开场", kind: "video", ordinalLabel: "第 1 话", available: true }]),
    "covers.list": () => ({ workId: "wv", state: "auto", coverId: null, covers: [] }),
    "video.probe": (input) => ({ resourceId: input.resourceId, revisionId: `rev_${input.resourceId}`, available: true, probe: { durationMs: 120_000 } }),
    "video.audioTracks": () => ({ audio: [{ index: 1, codec: "aac", language: "ja", title: null, channels: 2, default: true }] }),
    "video.subtitles": () => ({ subtitles: [{ id: "sub_1", format: "srt", language: "zh", title: "简体", default: true }] }),
    "video.subtitleHandle": () => ({ trackId: "sub_1", format: "srt", language: "zh", title: "简体", url: "manga-media://h/sub" }),
    "video.playbackPlan": () => ({ available: true, plan: { decision: "direct", reasons: [], detail: "" }, copy: null }),
    "video.handle": () => ({ url: "manga-media://h/v", mediaType: "video/mp4", bytes: 1, startMs: 0 }),
    "video.frameIndex": () => { throw Object.assign(new Error("none"), { code: "CAPABILITY_UNAVAILABLE" }); },
    "settings.getMedia": () => ({}),
    "progress.get": () => ({ locator: { kind: "temporal", startMs: 65_000 }, completion: "in_progress" }),
    "comic.pages": (input) => ({
      resourceId: input.resourceId, revisionId: "rev_res_c1", title: "合成漫画", direction: null, available: true, warnings: [],
      pages: Array.from({ length: 4 }, (_, index) => ({ id: `p${index}`, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true })),
    }),
    "comic.pageHandles": (input) => ({ pages: (input.pageIds as string[]).map((pageId) => ({ pageId, available: true, kind: "image", url: `manga-media://h/${pageId}`, handle: pageId, mediaType: "image/png", width: 800, height: 1200 })) }),
    "screenshot.save": () => ({ screenshot: { id: "shot_1", title: "开场 · 1:05" } }),
    "screenshot.image": () => ({ url: "manga-media://h/shot", mediaType: "image/png" }),
    "screenshot.list": () => ({ items: [{ id: "shot_1", title: "开场 · 1:05" }], total: 1 }),
    "screenshot.get": () => ({ screenshot: { id: "shot_1", title: "开场 · 1:05", resourceId: "res_v1", resourceRevisionId: "rev_res_v1", mediaKind: "video", positionMs: 65_000, pageId: null, pageLabel: null, subtitleText: "你好", width: 1280, height: 720, available: true } }),
    "workFolders.forWork": () => ({ groups: [{ folder, files: [folderFile] }] }),
    ...overrides,
  };
  (window as unknown as { manga: unknown }).manga = {
    async state() { return { layout: { channel: "test", pointerPath: "pointer.json", partitions: { data: "d" }, writable: true, recovery: "none" }, writable: true, vaultAvailable: true }; },
    async command(payload: { commandId: string; input?: Record<string, any> }) {
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
    async chooseDirectory() { return null; }, async chooseFile() { return null; }, async chooseAudio() { return "h_audio"; }, async stashSecret() { return null; },
    async reveal(id: string) { revealed.push(id); return { status: "ok", value: {} }; },
  };
  return { calls, revealed, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

let media: ReturnType<typeof installMediaElement>;
let capture: ReturnType<typeof installCapture>;
const element = () => screen.getByTestId("video-element") as HTMLVideoElement;
const stay = () => new Promise<void>((resolve) => { setTimeout(resolve, 140); });

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
  capture = installCapture();
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetVideoSupport();
  resetCovers();
  shelfMemory.reset();
  quoteTags.reset();
  readerContext.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); capture.restore(); media.restore(); vi.restoreAllMocks(); removeMatchMedia(); quoteTags.reset(); readerContext.reset(); });

describe("a screenshot of a video (AT-91)", () => {
  it("takes the frame on screen at the size of the file with S, saves it with where it is from, and tells the person with its picture", async () => {
    const host = installHost();
    await openVideo();
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(host.of("screenshot.save")).toHaveLength(1));
    const saved = host.of("screenshot.save")[0]!.input;
    expect(saved).toMatchObject({ resourceId: "res_v1", resourceRevisionId: "rev_res_v1", data: "iVBORw==" });
    expect(saved.video).toMatchObject({ positionMs: 65_000, playbackRate: 1, composited: "none" });
    // The canvas is the size of the decoded frame, not of the window: nothing is scaled to what the screen shows.
    expect(capture.canvases.at(-1)).toMatchObject({ width: 1280, height: 720 });
    // The track being shown is named so the app can read the line on screen from it; the page never sends its own text.
    expect(saved.video.subtitleTrackId).toBe("sub_1");
    expect(saved.video.subtitleText).toBeUndefined();
    const notice = await screen.findByTestId("toast-notice");
    expect(notice.textContent).toContain("已保存截图：开场 · 1:05");
    expect((within(notice).getByTestId("toast-thumb") as HTMLImageElement).getAttribute("src")).toBe("manga-media://h/shot");
    for (const action of ["folder", "note", "board"]) expect(within(notice).getByTestId(`toast-action-${action}`)).toBeTruthy();
  });

  it("takes it from the button on the bar as well, and opens the folder of the picture from the notice", async () => {
    const host = installHost();
    await openVideo();
    fireEvent.click(screen.getByTestId("video-screenshot"));
    await waitFor(() => expect(host.of("screenshot.save")).toHaveLength(1));
    fireEvent.click(await screen.findByTestId("toast-action-folder"));
    await waitFor(() => expect(host.revealed).toEqual(["screenshot:shot_1"]));
    expect(screen.queryByTestId("toast-notice")).toBeNull();
  });

  it("says so when there is no frame to take, and saves nothing", async () => {
    capture.restore();
    capture = installCapture({ video: null });
    const host = installHost();
    await openVideo();
    fireEvent.keyDown(window, { key: "s" });
    const error = await screen.findByTestId("toast-error");
    expect(error.textContent).toContain("现在没有画面可以截取");
    expect(host.of("screenshot.save")).toHaveLength(0);
  });

  it("does not take a picture while a name is being typed", async () => {
    const host = installHost();
    await openVideo();
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    fireEvent.keyDown(field, { key: "s" });
    expect(host.of("screenshot.save")).toHaveLength(0);
    field.remove();
  });

  it("puts the picture into a note chosen from the notice, as a screenshot block after what the note holds", async () => {
    const host = installHost({
      "notes.get": () => ({ revision: 3, title: "一条笔记", document: { blocks: [{ id: "b1", type: "paragraph", text: "正文" }] } }),
      "notes.replace": () => ({ revision: 4 }),
    });
    await openVideo();
    fireEvent.keyDown(window, { key: "s" });
    fireEvent.click(await screen.findByTestId("toast-action-note"));
    fireEvent.click(await screen.findByTestId("screenshot-target-n1"));
    await waitFor(() => expect(host.of("notes.replace")).toHaveLength(1));
    const replaced = host.of("notes.replace")[0]!.input;
    expect(replaced).toMatchObject({ objectId: "n1", expectedRevision: 3 });
    expect(replaced.blocks).toHaveLength(2);
    expect(replaced.blocks[0]).toEqual({ id: "b1", type: "paragraph", text: "正文" });
    expect(replaced.blocks[1]).toMatchObject({ type: "screenshot", text: "", attrs: { screenshotId: "shot_1" } });
    expect((await screen.findByTestId("toast-notice")).textContent).toContain("已把截图放进笔记「一条笔记」");
  });

  it("puts the picture on a whiteboard chosen from the notice, as a reference card to the right of what is there", async () => {
    const host = installHost({
      "whiteboard.list": () => ({ boards: [{ id: "wb1", title: "角色关系" }] }),
      "whiteboard.get": () => ({ nodes: [{ x: 10, y: 20, w: 200 }, { x: 300, y: 5, w: 100 }] }),
      "whiteboard.edit": () => ({}),
    });
    await openVideo();
    fireEvent.keyDown(window, { key: "s" });
    fireEvent.click(await screen.findByTestId("toast-action-board"));
    fireEvent.click(await screen.findByTestId("screenshot-target-wb1"));
    await waitFor(() => expect(host.of("whiteboard.edit")).toHaveLength(1));
    const edit = host.of("whiteboard.edit")[0]!.input;
    expect(edit.boardId).toBe("wb1");
    expect(edit.actions).toEqual([{ type: "addNode", kind: "ref", x: 440, y: 5, data: { refKind: "screenshot", targetId: "shot_1", label: "开场 · 1:05" } }]);
  });
});

describe("a screenshot of a comic page (AT-91)", () => {
  async function openComic() {
    await openWork("nav-comic", "open-res_c1");
    fireEvent.click(screen.getByTestId("work-read"));
    await waitFor(() => expect(screen.getByTestId("comic-reader")).toBeTruthy());
    await waitFor(() => expect(document.querySelectorAll("img.comic-image").length).toBeGreaterThan(0));
  }

  it("saves the page on screen at its original size, with the page it is and the way it is read", async () => {
    const host = installHost({ "progress.get": () => ({ locator: null, completion: "new" }) });
    await openComic();
    fireEvent.click(screen.getByTestId("comic-screenshot"));
    await waitFor(() => expect(host.of("screenshot.save")).toHaveLength(1));
    const saved = host.of("screenshot.save")[0]!.input;
    expect(saved).toMatchObject({ resourceId: "res_c1", resourceRevisionId: "rev_res_c1", data: "iVBORw==" });
    expect(saved.comic).toMatchObject({ pageId: "p0", pageIndex: 0, pageLabel: "1" });
    expect(saved.comic.region).toBeUndefined();
    expect(saved.video).toBeUndefined();
    // The page's own pixels: the canvas is as large as the original, however small the window shows it.
    expect(capture.canvases.at(-1)).toMatchObject({ width: 800, height: 1200 });
    expect((await screen.findByTestId("toast-notice")).textContent).toContain("已保存截图");
  });

  it("takes the same picture from the S key", async () => {
    const host = installHost({ "progress.get": () => ({ locator: null, completion: "new" }) });
    await openComic();
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(host.of("screenshot.save")).toHaveLength(1));
  });

  it("says so when the page has not been decoded yet, and saves nothing", async () => {
    capture.restore();
    capture = installCapture({ image: null });
    const host = installHost({ "progress.get": () => ({ locator: null, completion: "new" }) });
    await openComic();
    fireEvent.click(screen.getByTestId("comic-screenshot"));
    expect((await screen.findByTestId("toast-error")).textContent).toContain("现在没有画面可以截取");
    expect(host.of("screenshot.save")).toHaveLength(0);
  });
});

describe("the folder of a work on its page (AT-92)", () => {
  async function openRecords() {
    await openWork("nav-video", "open-res_v1");
    fireEvent.click(screen.getByTestId("detail-tab-records"));
    await waitFor(() => expect(screen.getByTestId("work-folder")).toBeTruthy());
  }

  it("shows where the folder is and what is in it, with the screenshot's picture", async () => {
    installHost();
    await openRecords();
    await waitFor(() => expect(screen.getByTestId("work-folder-path").textContent).toContain("动漫/合成动画"));
    expect(screen.getByTestId("work-folder-path").textContent).toContain("1 个文件");
    const row = screen.getByTestId("work-file-f1");
    expect(row.getAttribute("data-kind")).toBe("screenshot");
    expect(row.textContent).toContain("合成动画 1-05.png");
    await waitFor(() => expect(within(row).getByAltText("截图预览").getAttribute("src")).toBe("manga-media://h/shot"));
  });

  it("opens the folder, renames it to the current title, and says what it is now called", async () => {
    const host = installHost({ "workFolders.rename": () => ({ folder: { ...folder, relDir: "动漫/新的标题" } }) });
    await openRecords();
    await waitFor(() => expect(screen.getByTestId("work-folder-open")).toBeTruthy());
    fireEvent.click(screen.getByTestId("work-folder-open"));
    await waitFor(() => expect(host.revealed).toEqual(["workfolder:wf1"]));
    fireEvent.click(screen.getByTestId("work-folder-rename"));
    await waitFor(() => expect(host.of("workFolders.rename")).toHaveLength(1));
    expect(host.of("workFolders.rename")[0]!.input).toEqual({ folderId: "wf1" });
    expect((await screen.findByTestId("toast-notice")).textContent).toContain("文件夹已重命名为「新的标题」");
  });

  it("says there is no folder yet when nothing was written, and offers no rename", async () => {
    installHost({ "workFolders.forWork": () => ({ groups: [] }) });
    await openRecords();
    await waitFor(() => expect(screen.getByTestId("work-folder-none")).toBeTruthy());
    expect(screen.queryByTestId("work-folder-rename")).toBeNull();
    expect(screen.queryByTestId("work-folder-open")).toBeNull();
  });

  it("brings an audio file in for this work: the work is named, so the copy and the transcript land in its folder", async () => {
    const host = installHost({ "library.transcribeAudio": () => ({ text: "转写" }) });
    await openRecords();
    fireEvent.click(screen.getByTestId("work-folder-import-audio"));
    await waitFor(() => expect(host.of("library.transcribeAudio")).toHaveLength(1));
    expect(host.of("library.transcribeAudio")[0]!.input).toEqual({ pathHandle: "h_audio", workId: "wv" });
    expect((await screen.findByTestId("toast-notice")).textContent).toContain("已导入");
  });
});

describe("screenshots inside a note (AT-91)", () => {
  const labels = {
    blockInsert: "插入块", blockRemove: "删除块", blockMoveUp: "上移", blockMoveDown: "下移", blockCopy: "复制块", blockMerge: "与下一块合并", blockType: "块类型",
    typeParagraph: "正文", typeHeading: "标题", typeList: "列表", typeQuote: "引用", typeCode: "代码", typePlain: "纯文本", draftRestored: "已恢复未保存的草稿",
    draftDiscard: "丢弃草稿", conflict: "冲突", sourceStale: "来源已失效", repairSource: "重新指定来源文件", undo: "撤销", redo: "重做", undoHint: "撤销", sourceEdit: "编辑此块源码",
  };
  const t = createTranslator("zh-CN").t;
  const setup = (blocks: NoteBlock[], onOpen = vi.fn()) => {
    const onSave = vi.fn(async () => 2);
    render(
      <NoteEditor
        objectId="obj-1" document={{ schemaVersion: 2, blocks }} revision={1} title="笔记" tags={[]}
        saveLabel="尚未保存" savingLabel="正在保存" savedLabel="已保存" failedLabel="没有保存成功" splitLabel="拆分段落" sourceLabel="源编辑"
        labels={labels} drafts={{ read: () => null, write: () => undefined, clear: () => undefined }}
        screenshots={{ t, onOpen }} onSave={onSave}
      />,
    );
    return { onOpen, onSave };
  };

  it("shows a screenshot block as its picture, its title and where it is from, and goes back to the source", async () => {
    installHost();
    const view = setup([{ id: "p1", type: "paragraph", text: "正文" }, { id: "s1", type: "screenshot", text: "", attrs: { screenshotId: "shot_1" } }]);
    const card = await screen.findByTestId("screenshot-s1");
    await waitFor(() => expect(within(card).getByTestId("screenshot-title-s1").textContent).toBe("开场 · 1:05"));
    expect(card.textContent).toContain("1:05");
    expect(card.textContent).toContain("你好");
    await waitFor(() => expect(within(card).getByAltText("截图预览").getAttribute("src")).toBe("manga-media://h/shot"));
    fireEvent.click(within(card).getByTestId("screenshot-open-s1"));
    expect(view.onOpen).toHaveBeenCalledWith("shot_1");
  });

  it("says a screenshot is gone when it was deleted, and keeps the block until the person takes it out", async () => {
    installHost({ "screenshot.get": () => { throw Object.assign(new Error("none"), { code: "NOT_FOUND" }); } });
    const view = setup([{ id: "s1", type: "screenshot", text: "", attrs: { screenshotId: "shot_x" } }, { id: "p1", type: "paragraph", text: "正文" }]);
    const card = await screen.findByTestId("screenshot-s1");
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("gone"));
    expect(card.textContent).toContain("这张截图已被删除");
    expect(within(card).queryByTestId("screenshot-open-s1")).toBeNull();
    fireEvent.click(within(card).getByTestId("screenshot-remove-s1"));
    await waitFor(() => expect(view.onSave).toHaveBeenCalled());
    const saved = view.onSave.mock.calls.at(-1)![0] as NoteBlock[];
    expect(saved.map((block) => block.id)).toEqual(["p1"]);
  });

  it("inserts a screenshot chosen from the list after the block the caret is in, and saves it as a block with the id only", async () => {
    installHost();
    const view = setup([{ id: "p1", type: "paragraph", text: "正文" }]);
    fireEvent.click(screen.getByTestId("note-insert-screenshot"));
    fireEvent.click(await screen.findByTestId("screenshot-pick-shot_1"));
    await waitFor(() => expect(view.onSave).toHaveBeenCalled(), { timeout: 3000 });
    const saved = view.onSave.mock.calls.at(-1)![0] as NoteBlock[];
    expect(saved.map((block) => block.type)).toEqual(["paragraph", "screenshot"]);
    expect(saved[1]).toMatchObject({ text: "", attrs: { screenshotId: "shot_1" } });
    expect(Object.keys(saved[1]!.attrs ?? {})).toEqual(["screenshotId"]);
  });
});
