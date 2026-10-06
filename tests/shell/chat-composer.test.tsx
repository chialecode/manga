/** @vitest-environment jsdom */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { BUILTIN_QUICK_TASKS, type QuickTask } from "@manga/contracts";
import { Composer, QuickChips, QuoteTags, type ComposerProps } from "../../apps/desktop/src/renderer/components/chat/composer.tsx";
import { MaterialsDialog, MAX_TASK_RECORDINGS } from "../../apps/desktop/src/renderer/components/chat/materials-dialog.tsx";
import { anchorFromContext, anchorFromTag, quickPageFor, quickValues, renderQuick } from "../../apps/desktop/src/renderer/lib/chat-model.ts";
import { quoteTags, type QuoteTag } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { mediaContextFor, readerContext, useReaderContext, type ReaderContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { emptyComposer, type AttachedImage, type ComposerState } from "../../apps/desktop/src/renderer/lib/types.ts";
import { formatClock } from "../../apps/desktop/src/renderer/readers/video-model.ts";
import { WorkHome } from "../../apps/desktop/src/renderer/pages/work-home.tsx";

/**
 * The right pane's input (A-47, A-48). The old pane had a media section (what the reader is at, attach, recordings, subtitle range,
 * online search, related works, quick tasks); those choices now live in the input's "+" menu, the tag row and the quick-task chips,
 * and related works moved to the work's page. The same behaviours are checked here against those places.
 */
const i18n = createTranslator("zh-CN");
const t = i18n.t;

type Handler = (input: Record<string, unknown>) => unknown;
function installHost(handlers: Record<string, Handler> = {}) {
  const calls: Array<{ commandId: string; input: Record<string, unknown> }> = [];
  (window as unknown as { manga: unknown }).manga = {
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
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

const comicPlace = (patch: Partial<Extract<ReaderContext, { kind: "comic" }>> = {}): ReaderContext => ({
  kind: "comic", resourceId: "res_c1", revisionId: "rev_c1", title: "合成漫画", workId: "wc", pageId: "p2", pageNumber: 3, pageCount: 6, ...patch,
});
const videoPlace = (patch: Partial<Extract<ReaderContext, { kind: "video" }>> = {}): ReaderContext => ({
  kind: "video", resourceId: "res_v1", revisionId: "rev_v1", title: "合成动画", workId: "wv", positionMs: 65_400, durationMs: 120_000, ...patch,
});
const image = (id: string, patch: Partial<AttachedImage> = {}): AttachedImage => ({
  materialId: id, mediaType: "image/png", width: 800, height: 1200, bytes: 4096, extraction: "页面图像", preview: "data:image/png;base64,AAAA", ...patch,
});

/** The tasks a page shows, as the host's list gives them: the built-in ones, in their order. */
const tasksFor = (page: string): QuickTask[] => BUILTIN_QUICK_TASKS.filter((task) => (task.pages as readonly string[]).includes(page))
  .map((task, order) => ({ ...task, id: `qt_${task.builtinKey}`, builtin: true, enabled: true, order }) as QuickTask);

type Probe = { composer: ComposerState; quick: QuickTask[]; attached: Array<"page" | "frame">; sent: number; online: number; ahead: number[]; materials: number; removedTags: string[]; mode: "note" | "ask" };
const newProbe = (): Probe => ({ composer: emptyComposer(), quick: [], attached: [], sent: 0, online: 0, ahead: [], materials: 0, removedTags: [], mode: "ask" });

/** The input as the pane builds it: the page, the open reader's place, the tags and the choices for the next send. */
function Harness(props: {
  page?: string;
  context?: ReaderContext | null;
  online?: boolean;
  initial?: Partial<ComposerState>;
  probe: Probe;
  running?: boolean;
  tags?: readonly QuoteTag[];
  tasks?: QuickTask[];
}) {
  const [composer, setComposer] = useState<ComposerState>({ ...emptyComposer(), ...props.initial });
  props.probe.composer = composer;
  const context = props.context ?? null;
  const attach = context?.kind === "comic" ? "page" : context?.kind === "video" ? "frame" : null;
  const composerProps: ComposerProps = {
    t,
    value: composer.draft,
    onChange: (draft) => setComposer((current) => ({ ...current, draft })),
    mode: props.probe.mode,
    onMode: (mode) => { props.probe.mode = mode; },
    tags: props.tags ?? [],
    images: composer.images,
    onRemoveTag: (id) => props.probe.removedTags.push(id),
    onRemoveImage: (id) => setComposer((current) => ({ ...current, images: current.images.filter((item) => item.materialId !== id) })),
    quick: (props.tasks ?? tasksFor(props.page ?? "comic")).map((task) => ({ task, label: task.name })),
    onQuick: (task) => props.probe.quick.push(task),
    noModel: false,
    onSettings: () => undefined,
    running: props.running ?? false,
    onStop: () => undefined,
    onSend: () => { props.probe.sent += 1; },
    sending: false,
    plus: { attach, online: props.online ?? false, subtitle: context?.kind === "video", allowOnline: composer.allowOnline, subtitleAheadMin: composer.subtitleAheadMin, materials: composer.materials.length + composer.noteMaterials.length + composer.recordings.length },
    onAttach: (what) => props.probe.attached.push(what),
    onToggleOnline: () => setComposer((current) => ({ ...current, allowOnline: !current.allowOnline })),
    onSubtitleAhead: (minutes) => { props.probe.ahead.push(minutes); setComposer((current) => ({ ...current, subtitleAheadMin: minutes })); },
    onMaterials: () => { props.probe.materials += 1; },
    mic: null,
  };
  return <Composer {...composerProps} />;
}

const openPlus = () => fireEvent.click(screen.getByTestId("chat-plus"));
const plusIds = () => [...screen.getByRole("menu").querySelectorAll("[role^='menuitem']")].map((node) => node.getAttribute("data-testid")!.replace("chat-plus-", ""));

beforeEach(() => { readerContext.reset(); quoteTags.reset(); installHost(); });
afterEach(() => { cleanup(); readerContext.reset(); quoteTags.reset(); vi.restoreAllMocks(); });

describe("the right pane's input: what goes with the next task", () => {
  it("offers no picture or subtitle choice when no reader is open, but the one task that reads the shelf, and the materials", () => {
    render(<Harness page="library" context={null} probe={newProbe()} />);
    openPlus();
    expect(plusIds()).toEqual(["materials"]);
    cleanup();
    render(<Harness page="library" context={null} probe={newProbe()} />);
    expect(screen.getByTestId("quick-library")).toBeTruthy();
    expect(screen.queryByTestId("chat-tags")).toBeNull();
  });

  it("offers the comic page's quick tasks and attach-page, and sends the chosen task through the pane", () => {
    const probe = newProbe();
    render(<Harness context={comicPlace()} probe={probe} />);
    expect(screen.getByTestId("quick-summarize-page")).toBeTruthy();
    expect(screen.getByTestId("quick-read-text")).toBeTruthy();
    expect(screen.queryByTestId("quick-interval")).toBeNull();
    openPlus();
    expect(plusIds()).toEqual(["attach", "materials"]);
    fireEvent.click(screen.getByTestId("chat-plus-attach"));
    expect(probe.attached).toEqual(["page"]);
    fireEvent.click(screen.getByTestId("quick-read-text"));
    expect(probe.quick[0]).toMatchObject({ builtinKey: "read-text", includeFrame: true });
  });

  it("follows the video moment: its tasks are listed, a marked interval is a tag, and the attach is the frame", () => {
    const probe = newProbe();
    const interval: QuoteTag = { id: "interval:res_v1", kind: "interval", resourceId: "res_v1", revisionId: "rev_v1", startMs: 30_000, endMs: 40_000, label: "0:30—0:40" };
    render(<Harness page="video" context={videoPlace()} tags={[interval]} probe={probe} />);
    expect(screen.getByTestId("quick-describe-frame")).toBeTruthy();
    expect(screen.getByTestId("quick-interval")).toBeTruthy();
    expect(screen.getByTestId("chat-tag-interval").textContent).toContain("0:30—0:40");
    openPlus();
    expect(plusIds()).toContain("attach");
    fireEvent.click(screen.getByTestId("chat-plus-attach"));
    expect(probe.attached).toEqual(["frame"]);
    expect(screen.queryByTestId("agent-attach-page")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-tag-remove-interval"));
    expect(probe.removedTags).toEqual(["interval:res_v1"]);
  });

  it("does not redraw for every tick of the clock, only for a new second", () => {
    let draws = 0;
    function Line() {
      draws += 1;
      const place = useReaderContext();
      return <p data-testid="line">{place?.kind === "video" ? formatClock(place.positionMs) : ""}</p>;
    }
    render(<Line />);
    act(() => readerContext.set(videoPlace({ positionMs: 65_100 })));
    const drawn = draws;
    act(() => readerContext.set(videoPlace({ positionMs: 65_600 })));
    expect(draws).toBe(drawn);
    // The exact position is still kept for a send.
    expect(readerContext.get()).toMatchObject({ positionMs: 65_600 });
    act(() => readerContext.set(videoPlace({ positionMs: 66_100 })));
    expect(screen.getByTestId("line").textContent).toBe("1:06");
  });

  it("widens the subtitle window only by an explicit choice, and the choice is a number of minutes", () => {
    const probe = newProbe();
    render(<Harness page="video" context={videoPlace()} probe={probe} />);
    openPlus();
    expect(screen.getByTestId("chat-plus-ahead-0").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("chat-plus-ahead-3"));
    expect(probe.ahead).toEqual([3]);
    expect(probe.composer.subtitleAheadMin).toBe(3);
    // The send reads the widening from the composer and counts it from the position, in milliseconds.
    expect(mediaContextFor(videoPlace(), { subtitleAheadMs: probe.composer.subtitleAheadMin * 60_000 })).toEqual({
      video: { resourceId: "res_v1", resourceRevisionId: "rev_v1", positionMs: 65_400, subtitleAheadMs: 180_000 },
    });
    expect(mediaContextFor(videoPlace(), { subtitleAheadMs: 0 })!.video).not.toHaveProperty("subtitleAheadMs");
  });

  it("lists attached pictures as tags, removes one, and stops offering to attach at the limit", () => {
    const probe = newProbe();
    const many = Array.from({ length: 4 }, (_, index) => image(`img_${index}`));
    render(<Harness context={comicPlace()} probe={probe} initial={{ images: many }} />);
    expect(screen.getByTestId("agent-image-img_0")).toBeTruthy();
    openPlus();
    expect((screen.getByTestId("chat-plus-attach") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId("chat-plus-attach"), { key: "Escape" });
    fireEvent.click(screen.getByTestId("agent-image-remove-img_0"));
    expect(screen.queryByTestId("agent-image-img_0")).toBeNull();
    expect(probe.composer.images.map((item) => item.materialId)).toEqual(["img_1", "img_2", "img_3"]);
    openPlus();
    expect((screen.getByTestId("chat-plus-attach") as HTMLButtonElement).disabled).toBe(false);
  });

  it("holds the quick tasks that send while a task runs, and lets the ones that only fill the input through", () => {
    const fill: QuickTask = { ...tasksFor("comic")[0]!, id: "qt_fill", builtinKey: null, name: "只填入", sendMode: "fill" };
    render(<Harness context={comicPlace()} probe={newProbe()} running tasks={[...tasksFor("comic"), fill]} />);
    expect((screen.getByTestId("quick-summarize-page") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("quick-qt_fill") as HTMLButtonElement).disabled).toBe(false);
    // While a task runs the send button is the stop button.
    expect(screen.getByTestId("agent-stop")).toBeTruthy();
    expect(screen.queryByTestId("agent-send")).toBeNull();
  });

  it("offers online search only with the metadata module, as a choice for the next task", () => {
    const probe = newProbe();
    const view = render(<Harness context={comicPlace()} probe={probe} online={false} />);
    openPlus();
    expect(plusIds()).not.toContain("online");
    view.unmount();
    render(<Harness context={comicPlace()} probe={probe} online />);
    openPlus();
    const item = screen.getByTestId("chat-plus-online");
    expect(item.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(item);
    expect(probe.composer.allowOnline).toBe(true);
    openPlus();
    expect(screen.getByTestId("chat-plus-online").getAttribute("aria-checked")).toBe("true");
  });

  it("says how many materials are chosen in the menu, and opens the chooser", () => {
    const probe = newProbe();
    render(<Harness context={comicPlace()} probe={probe} initial={{ materials: ["a", "b"], noteMaterials: ["n"], recordings: ["c"] }} />);
    openPlus();
    expect(screen.getByTestId("chat-plus-materials").textContent).toContain("4");
    fireEvent.click(screen.getByTestId("chat-plus-materials"));
    expect(probe.materials).toBe(1);
  });

  it("sends with Enter, not while an input method is composing, and a tag alone is enough for a note", () => {
    const probe = newProbe();
    probe.mode = "ask";
    render(<Harness context={comicPlace()} probe={probe} initial={{ draft: "你好" }} />);
    const input = screen.getByTestId("agent-composer");
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(probe.sent).toBe(0);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(probe.sent).toBe(0);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(probe.sent).toBe(1);
  });
});

describe("the materials chooser: recordings of the open resource", () => {
  const row = (n: number, patch: Record<string, unknown> = {}) => ({ id: `cap_${n}`, createdAt: "2026-10-01T08:00:00.000Z", durationMs: 10_000, stage: "done", segments: { done: 1 }, ...patch });

  function Chooser(props: { recordingsOf: string | null; probe: { recordings: string[] } }) {
    const [recordings, setRecordings] = useState<string[]>([]);
    props.probe.recordings = recordings;
    return <MaterialsDialog t={t} resources={[]} materials={[]} noteMaterials={[]} onMaterials={() => undefined} onNoteMaterials={() => undefined} recordingsOf={props.recordingsOf} recordings={recordings} onRecordings={setRecordings} formatDate={i18n.formatDate} onClose={() => undefined} />;
  }

  it("lists finished recordings of the open video and keeps at most three for a task", async () => {
    installHost({ "capture.list": () => ({ sessions: [1, 2, 3, 4, 5].map((n) => row(n)).concat([row(9, { id: "cap_pending", stage: "recognizing", segments: { done: 0 } })]) }) });
    const probe = { recordings: [] as string[] };
    render(<Chooser recordingsOf="res_v1" probe={probe} />);
    await waitFor(() => expect(screen.getByTestId("agent-recording-cap_1")).toBeTruthy());
    // A recording still being recognized has no transcript to send.
    expect(screen.queryByTestId("agent-recording-cap_pending")).toBeNull();
    expect(MAX_TASK_RECORDINGS).toBe(3);
    for (const n of [1, 2, 3, 4]) fireEvent.click(screen.getByTestId(`agent-recording-cap_${n}`));
    expect(probe.recordings).toEqual(["cap_1", "cap_2", "cap_3"]);
    fireEvent.click(screen.getByTestId("agent-recording-cap_2"));
    expect(probe.recordings).toEqual(["cap_1", "cap_3"]);
  });

  it("asks for no recordings when the voice module is off or no reader is open", async () => {
    const host = installHost();
    render(<Chooser recordingsOf={null} probe={{ recordings: [] }} />);
    await Promise.resolve();
    expect(host.of("capture.list")).toHaveLength(0);
    expect(screen.queryByTestId("material-recordings")).toBeNull();
  });
});

describe("related works: on the work's own page now", () => {
  const workHomeBase: Record<string, Handler> = {
    "covers.list": () => ({ workId: "wc", state: "auto", coverId: null, covers: [] }),
    "notes.list": () => [],
  };
  const detail = (extra: Record<string, unknown> = {}) => ({
    id: "wc", title: "合成漫画", author: "合成作者", mediaKind: "comic", shelf: "reading", coverId: null, lastResource: null, progress: 0, finishedCount: 0, resourceCount: 0, linked: false,
    createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null, originalTitle: "合成漫画", fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources: [], ...extra,
  });
  const renderHome = (facets: string[], opened: string[] = []) => render(
    <WorkHome t={t} workId="wc" facets={new Set(facets)} formatDate={i18n.formatDate} onBack={() => undefined} onOpenResource={() => undefined} onOpenNote={() => undefined} onOpenWork={(id) => opened.push(id)} onChanged={() => undefined} onError={() => undefined} onNotice={() => undefined} />,
  );

  it("shows related works with their source, opens one in the library, and says plainly when the work is not linked", async () => {
    const host = installHost({
      ...workHomeBase,
      "works.get": () => detail(),
      "metadata.related": () => ({
        workId: "wc", source: { providerId: "bangumi", fetchedAt: "2026-10-01T00:00:00.000Z", detached: false },
        relations: [
          { relation: "续集", externalId: "99", title: "合成续作", subjectType: 1, providerId: "bangumi", inLibraryWorkId: "w_next", sourceUrl: null },
          { relation: "前传", externalId: "98", title: "合成前传", subjectType: 1, providerId: "bangumi", inLibraryWorkId: null, sourceUrl: null },
        ],
        similar: [{ workId: "w_sim", title: "相似合成作品", mediaKind: "comic", sharedTags: ["冒险", "校园"], score: 2 }],
      }),
    });
    const opened: string[] = [];
    const view = renderHome(["library", "comic", "metadata"], opened);
    await waitFor(() => expect(screen.getByTestId("detail-tab-related")).toBeTruthy());
    fireEvent.click(screen.getByTestId("detail-tab-related"));
    await waitFor(() => expect(screen.getByTestId("related-relations")).toBeTruthy());
    expect(host.of("metadata.related")[0]!.input).toEqual({ workId: "wc" });
    expect(screen.getByTestId("detail-related").textContent).toContain("Bangumi");
    expect(screen.getByTestId("related-similar").textContent).toContain("冒险");
    fireEvent.click(screen.getByTestId("related-open-w_next"));
    expect(opened).toEqual(["w_next"]);
    expect(screen.queryByTestId("related-open-null")).toBeNull();
    view.unmount();

    installHost({ ...workHomeBase, "works.get": () => detail(), "metadata.related": () => ({ workId: "wc", source: null, relations: [], similar: [] }) });
    renderHome(["library", "comic", "metadata"]);
    await waitFor(() => expect(screen.getByTestId("detail-tab-related")).toBeTruthy());
    fireEvent.click(screen.getByTestId("detail-tab-related"));
    await waitFor(() => expect(screen.getByTestId("related-none")).toBeTruthy());
  });

  it("says the related works could not be read instead of showing a stale list", async () => {
    installHost({ ...workHomeBase, "works.get": () => detail(), "metadata.related": () => { throw Object.assign(new Error("offline"), { code: "NETWORK_UNAVAILABLE" }); } });
    renderHome(["library", "comic", "metadata"]);
    await waitFor(() => expect(screen.getByTestId("detail-tab-related")).toBeTruthy());
    fireEvent.click(screen.getByTestId("detail-tab-related"));
    await waitFor(() => expect(screen.getByTestId("detail-related").textContent).toContain("暂时无法读取相关作品"));
  });

  it("offers no related works without the metadata module", async () => {
    const host = installHost({ "works.get": () => detail(), ...workHomeBase });
    renderHome(["library", "comic"]);
    await waitFor(() => expect(screen.getByTestId("detail-title")).toBeTruthy());
    expect(screen.queryByTestId("detail-tab-related")).toBeNull();
    expect(host.of("metadata.related")).toHaveLength(0);
  });
});

describe("quick tasks, notes and the reader context", () => {
  it("offers tasks by what is open: the page names which list the pane asks for", () => {
    expect(quickPageFor("reading")).toBe("novel");
    expect(quickPageFor("comic")).toBe("comic");
    expect(quickPageFor("video")).toBe("video");
    expect(quickPageFor("work")).toBe("work");
    expect(quickPageFor("library")).toBe("library");
    expect(quickPageFor("agent")).toBe("chat");
    expect(quickPageFor("notes")).toBe("chat");
    expect(tasksFor("novel").map((task) => task.builtinKey)).toEqual(["read-so-far"]);
    expect(tasksFor("comic").map((task) => task.builtinKey)).toEqual(["summarize-page", "read-text"]);
    expect(tasksFor("video").map((task) => task.builtinKey)).toEqual(["recap", "explain-line", "describe-frame", "interval"]);
    expect(tasksFor("library")[0]).toMatchObject({ builtinKey: "library", includeLibrary: true });
  });

  it("fills a task's placeholders from what is on screen, and says what was missing", () => {
    const values = quickValues({ workTitle: "合成漫画", author: null, context: comicPlace(), tags: [], t });
    expect(values).toMatchObject({ 作品: "合成漫画", 作者: "", 当前位置: "第 3/6 页", 选区: "" });
    const rendered = renderQuick({ template: "请解释《{作品}》{当前位置}的{选区}" }, values, t);
    expect(rendered.text).toContain("《合成漫画》第 3/6 页的");
    expect(rendered.empty).toEqual(["选区"]);
    expect(rendered.text).toContain("选区");
    const selection: QuoteTag = { id: "s", kind: "selection", resourceId: "res_c1", revisionId: "rev_c1", label: "选区 2 字", start: 0, end: 2, quote: "这句" };
    expect(quickValues({ context: null, tags: [selection], t })).toMatchObject({ 选区: "这句" });
    const interval: QuoteTag = { id: "i", kind: "interval", resourceId: "res_v1", revisionId: "rev_v1", label: "x", startMs: 30_000, endMs: 40_000 };
    expect(quickValues({ context: videoPlace(), tags: [interval], t })).toMatchObject({ 当前位置: "1:05", 选区: "0:30—0:40" });
  });

  it("anchors a note at the tag, and without a tag at the place the reader is", () => {
    const region: QuoteTag = { id: "r", kind: "region", resourceId: "res_c1", revisionId: "rev_c1", label: "x", pageId: "p2", pageNumber: 3, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
    expect(anchorFromTag(region, t)).toMatchObject({ resourceId: "res_c1", resourceRevisionId: "rev_c1", locator: { kind: "image", pageId: "p2", region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } } });
    const interval: QuoteTag = { id: "i", kind: "interval", resourceId: "res_v1", revisionId: "rev_v1", label: "x", startMs: 30_000, endMs: 40_000 };
    expect(anchorFromTag(interval, t).locator).toEqual({ kind: "temporal", startMs: 30_000, endMs: 40_000 });
    const selection: QuoteTag = { id: "s", kind: "selection", resourceId: "res_n", revisionId: "rev_n", label: "x", partId: "part1", start: 10, end: 14, quote: "甲乙丙丁" };
    expect(anchorFromTag(selection, t)).toMatchObject({ locator: { kind: "text", partId: "part1", range: { start: 10, end: 14 }, quote: { exact: "甲乙丙丁" } }, quoteText: "甲乙丙丁" });
    expect(anchorFromContext(comicPlace(), t).locator).toEqual({ kind: "image", pageId: "p2" });
    expect(anchorFromContext(videoPlace({ positionMs: 12_345.6 }), t).locator).toEqual({ kind: "temporal", startMs: 12_346 });
  });

  it("builds the comic context with the framed region, and nothing without a reader", () => {
    expect(mediaContextFor(null)).toBeUndefined();
    expect(mediaContextFor(comicPlace(), { region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } })).toEqual({
      comic: { resourceId: "res_c1", resourceRevisionId: "rev_c1", pageId: "p2", region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
    });
    expect(mediaContextFor(comicPlace())).toEqual({ comic: { resourceId: "res_c1", resourceRevisionId: "rev_c1", pageId: "p2" } });
  });

  it("builds the video context from the exact position and the marked interval", () => {
    expect(mediaContextFor(videoPlace({ positionMs: 12_345.6, frame: 297, interval: { startMs: 1000.4, endMs: 2000.6 } }))).toEqual({
      video: { resourceId: "res_v1", resourceRevisionId: "rev_v1", positionMs: 12_346, frame: 297, interval: { startMs: 1000, endMs: 2001 } },
    });
  });

  it("clears only for the reader that set it, so an older reader leaving does not wipe a newer one's place", () => {
    readerContext.set(comicPlace({ resourceId: "old" }));
    readerContext.set(comicPlace({ resourceId: "new" }));
    readerContext.clear("old");
    expect(readerContext.get()?.resourceId).toBe("new");
    readerContext.clear("new");
    expect(readerContext.get()).toBeNull();
  });
});

describe("quote tags", () => {
  const sel = (resourceId: string, quote = "引文"): QuoteTag => ({ id: `selection:${resourceId}`, kind: "selection", resourceId, revisionId: "rev", label: "选区", start: 0, end: quote.length, quote });

  it("keeps one tag of each kind, drops a kind, and clears what belonged to a closed page", () => {
    quoteTags.put({ kind: "selection", resourceId: "r1", revisionId: "v", label: "a", start: 0, end: 2, quote: "ab" });
    quoteTags.put({ kind: "selection", resourceId: "r1", revisionId: "v", label: "b", start: 3, end: 5, quote: "cd" });
    expect(quoteTags.all().map((tag) => tag.label)).toEqual(["b"]);
    quoteTags.put({ kind: "interval", resourceId: "r1", revisionId: "v", label: "i", startMs: 1, endMs: 2 });
    quoteTags.put({ kind: "interval", resourceId: "r2", revisionId: "v", label: "other", startMs: 1, endMs: 2 });
    expect(quoteTags.all().map((tag) => tag.kind)).toEqual(["selection", "interval"]);
    quoteTags.removeKind("selection", "r1");
    expect(quoteTags.all().map((tag) => tag.kind)).toEqual(["interval"]);
    quoteTags.clearFor("r2");
    expect(quoteTags.all()).toEqual([]);
  });

  it("shows a tag with its label, and nothing when there are none", () => {
    render(<QuoteTags t={t} tags={[sel("r1", "甲乙丙")]} images={[]} onRemoveTag={() => undefined} onRemoveImage={() => undefined} />);
    expect(screen.getByTestId("chat-tag-selection").textContent).toContain("选区");
    cleanup();
    render(<QuoteTags t={t} tags={[]} images={[]} onRemoveTag={() => undefined} onRemoveImage={() => undefined} />);
    expect(screen.queryByTestId("chat-tags")).toBeNull();
  });

  it("builds quick chips only when there are tasks", () => {
    const view = render(<QuickChips t={t} tasks={[]} busy={false} onRun={() => undefined} />);
    expect(view.container.firstChild).toBeNull();
  });
});
