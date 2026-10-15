/** @vitest-environment jsdom */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import type { WorkSummary } from "@manga/contracts/media";
import { Shelf } from "../../apps/desktop/src/renderer/pages/shelf.tsx";
import { WorkHome } from "../../apps/desktop/src/renderer/pages/work-home.tsx";
import { DownloadsPage } from "../../apps/desktop/src/renderer/pages/downloads/downloads-page.tsx";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { boot, type Rig } from "../helpers/acquisition-app.ts";
import { bridgeToApp } from "../helpers/ui-host.ts";
import { installMatchMedia, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

Element.prototype.scrollIntoView = () => {};

/**
 * What the library page and the work's page show about the new rules: what the user made outlives the file (AT-77), titles with several
 * releases are one entry with versions (AT-78), and the library is what the library paths hold (AT-79).
 */
const i18n = createTranslator("zh-CN");
const t = i18n.t;

type Handler = (input: Record<string, unknown>) => unknown;
type Call = { commandId: string; input: Record<string, unknown> };

function installHost(handlers: Record<string, Handler> = {}, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "notes.list": () => [],
    "covers.list": () => ({ workId: "w1", state: "auto", coverId: null, covers: [] }),
    "capture.list": () => ({ sessions: [] }),
    "works.list": () => ({ items: [], total: 0, nextCursor: null }),
    ...handlers,
  };
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = base[payload.commandId];
      const value = handler ? handler(input) : {};
      // A handler answers with `{ __error }` to make the command fail the way the application does.
      if (value && typeof value === "object" && "__error" in value) return { status: "error", error: (value as { __error: unknown }).__error };
      return { status: "ok", value };
    },
    onNotice: () => () => undefined,
    async chooseDirectory() { return null; },
    ...extra,
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

beforeEach(() => { window.innerWidth = 1600; installMatchMedia({ reducedMotion: true }); installPointerEvent(); resetCovers(); shelfMemory.reset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); removeMatchMedia(); });

const summary = (extra: Partial<WorkSummary> = {}): WorkSummary => ({
  id: "w1", title: "合成作品", author: "合成作者", mediaKind: "video", shelf: "reading", coverId: null,
  lastResource: { id: "r1", title: "第一话", ordinalLabel: "第 1 话", revisionId: "rev1" },
  progress: 0, finishedCount: 0, resourceCount: 1, versionCount: 1, outsideCount: 0, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null, ...extra,
});

const resource = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `第 ${id} 话`, kind: "video", ordinalLabel: `第 ${id} 话`, revisionId: `rev_${id}`, available: true, outside: false, total: 1,
  progress: { percent: 0, completion: "new", locator: null, lastInteractionAt: null }, ...extra,
});

const detail = (extra: Record<string, unknown> = {}) => ({
  ...summary(), originalTitle: "合成作品", fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0,
  resources: [resource("r1")], ...extra,
});

function mountHome(opened: { work: string[]; resource: string[]; add: number[]; conversation: string[] } = { work: [], resource: [], add: [], conversation: [] }, facets = ["library", "video", "voice"]) {
  const props = { onError: vi.fn(), onNotice: vi.fn() };
  render(
    <WorkHome
      t={t} workId="w1" facets={new Set(facets)} formatDate={i18n.formatDate} onBack={() => undefined}
      onOpenResource={(id) => opened.resource.push(id)} onOpenNote={() => undefined} onOpenWork={(id) => opened.work.push(id)}
      onOpenConversation={(id) => opened.conversation.push(id)} onOpenRecording={() => undefined} onAddPath={() => opened.add.push(1)}
      onChanged={() => undefined} onError={props.onError} onNotice={props.onNotice}
    />,
  );
  return { opened, ...props };
}

const tab = async (id: string) => { await waitFor(() => expect(screen.getByTestId(`detail-tab-${id}`)).toBeTruthy()); fireEvent.click(screen.getByTestId(`detail-tab-${id}`)); };

describe("what the user made outlives the file (AT-77)", () => {
  const content = (over: Record<string, unknown> = {}) => ({
    ...over,
    resource: { id: "r2", title: "第二话", kind: "video", ordinalLabel: "第 2 话", workId: "w1", workTitle: "合成作品", available: false, outside: false, path: "media/第二话.mkv", ...((over.resource as object) ?? {}) },
    progress: { percent: 0.4, completion: "inProgress", locator: null },
    notes: [{ objectId: "n1", title: "关于第二话的笔记", preview: "", updatedAt: "2026-02-01T00:00:00.000Z" }],
    bookmarks: [{ id: "b1", label: "开场", createdAt: "2026-02-01T00:00:00.000Z" }],
    recordings: [{ id: "cap1", stage: "done", audioState: "kept", playable: true, durationMs: 12000, createdAt: "2026-02-02T00:00:00.000Z", resourceId: "r2", segments: { total: 1, done: 1, failed: 0, pending: 0, noSpeech: 0 } }],
    conversation: { sessionId: "ses_r2", runs: 3, updatedAt: "2026-02-03T00:00:00.000Z" },
  });

  it("opens an unavailable resource as a view of what was made on it, instead of a dead button", async () => {
    installHost({
      "works.get": () => detail({ resources: [resource("r1"), resource("r2", { available: false, progress: { percent: 0.4, completion: "inProgress", locator: null, lastInteractionAt: null } })] }),
      "library.resourceContent": () => content(),
    });
    const home = mountHome();
    await tab("resources");
    // An available resource opens its reader; an unavailable one says what it offers instead.
    expect(screen.getByTestId("detail-open-r1").textContent).toContain("观看");
    expect(screen.getByTestId("detail-open-r2").textContent).toBe("查看记录");
    expect((screen.getByTestId("detail-open-r2") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("detail-open-r1"));
    expect(home.opened.resource).toEqual(["r1"]);
    fireEvent.click(screen.getByTestId("detail-open-r2"));
    await screen.findByTestId("resource-content");
    expect(screen.getByTestId("resource-content-title").textContent).toContain("第二话");
    expect(screen.getByTestId("resource-content-hint").textContent).toContain("你在它上面留下的内容都还在");
    expect(screen.getByTestId("resource-content-path").textContent).toContain("第二话.mkv");
    expect(screen.getByTestId("resource-content-progress").textContent).toContain("40%");
    expect(screen.getByTestId("resource-note-n1").textContent).toContain("关于第二话的笔记");
    expect(screen.getByTestId("resource-bookmark-b1").textContent).toContain("开场");
    expect(screen.getByTestId("resource-recording-cap1")).toBeTruthy();
    expect(screen.getByTestId("resource-content-conversation").textContent).toContain("3 次对话");
    fireEvent.click(screen.getByTestId("resource-conversation-open"));
    expect(home.opened.conversation).toEqual(["ses_r2"]);
    // Nothing was opened as a file.
    expect(home.opened.resource).toEqual(["r1"]);
    fireEvent.click(screen.getByTestId("resource-content-back"));
    await tab("resources");
    expect(screen.getByTestId("detail-resources")).toBeTruthy();
  });

  it("points a resource at a file the person picks, and keeps everything bound to it", async () => {
    let available = false;
    const host = installHost({
      "works.get": () => detail({ resources: [resource("r2", { available })] }),
      "library.resourceContent": () => content({ resource: { available } }),
      "library.repairSource": () => { available = true; return { pointersKept: 2 }; },
    }, { choosePath: async () => "handle-1" });
    const home = mountHome();
    await tab("resources");
    fireEvent.click(screen.getByTestId("detail-open-r2"));
    await screen.findByTestId("resource-content-relocate");
    fireEvent.click(screen.getByTestId("resource-content-relocate"));
    await waitFor(() => expect(host.of("library.repairSource")).toHaveLength(1));
    expect(host.of("library.repairSource")[0]!.input).toEqual({ resourceId: "r2", pathHandle: "handle-1" });
    await waitFor(() => expect(screen.getByTestId("resource-content-ready")).toBeTruthy());
    expect(screen.queryByTestId("resource-content-relocate")).toBeNull();
    fireEvent.click(screen.getByTestId("resource-content-open"));
    expect(home.opened.resource).toEqual(["r2"]);
    expect(home.onError).not.toHaveBeenCalled();
  });

  it("keeps a work whose files are all gone, and says what is still there", async () => {
    installHost({ "works.get": () => detail({ resourceCount: 0, lastResource: null, resources: [] }) });
    mountHome();
    await waitFor(() => expect(screen.getByTestId("work-no-resource")).toBeTruthy());
    expect(screen.getByTestId("work-no-resource").textContent).toContain("你留下的笔记、词典和对话还在这里");
    expect((screen.getByTestId("work-read") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a resource's progress as a percent of one, not as a fraction", async () => {
    installHost({ "works.get": () => detail({ resources: [resource("r1", { progress: { percent: 0.4, completion: "inProgress", locator: null, lastInteractionAt: null } })] }) });
    mountHome();
    await tab("resources");
    expect(within(screen.getByTestId("detail-resource-r1")).getByText("40%")).toBeTruthy();
    expect((within(screen.getByTestId("detail-resource-r1")).getByRole("progressbar") as HTMLProgressElement).value).toBe(40);
  });
});

describe("two releases of one title are one entry with versions (AT-78)", () => {
  const versions = [
    { workId: "w1", label: "合成作品 [字幕组甲]", resourceCount: 12, lastOpenedAt: "2026-03-01T00:00:00.000Z", current: true },
    { workId: "w2", label: "合成作品 [BD]", resourceCount: 12, lastOpenedAt: null, current: false },
  ];

  it("offers the other versions on the work's page and goes to the one picked", async () => {
    installHost({ "works.get": () => detail({ versionCount: 2, versions }) });
    const home = mountHome();
    await waitFor(() => expect(screen.getByTestId("work-versions")).toBeTruthy());
    const select = screen.getByTestId("work-version") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["合成作品 [字幕组甲]（12 项）", "合成作品 [BD]（12 项）"]);
    expect(select.value).toBe("w1");
    fireEvent.change(select, { target: { value: "w2" } });
    expect(home.opened.work).toEqual(["w2"]);
  });

  it("shows no version choice for a title that has one", async () => {
    installHost({ "works.get": () => detail({ versions: [versions[0]] }) });
    mountHome();
    await waitFor(() => expect(screen.getByTestId("detail-title")).toBeTruthy());
    expect(screen.queryByTestId("work-versions")).toBeNull();
  });

  it("lists a title once on the shelf and says how many versions it has", async () => {
    const calls = installHost({ "works.list": () => ({ items: [summary({ versionCount: 3 }), summary({ id: "w9", title: "单一版本", lastResource: { id: "r9", title: "单一版本", ordinalLabel: null, revisionId: "rev9" } })], total: 2, nextCursor: null }) });
    render(<Shelf t={t} kind="video" refreshKey={0} facets={new Set(["library", "video"])} onOpen={() => {}} onContinue={() => {}} onDetail={() => {}} onAddPath={() => {}} onViewAll={() => {}} onSetShelf={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("work-w1")).toBeTruthy());
    expect(screen.getByTestId("work-flags-w1").textContent).toContain("3 个版本");
    expect(screen.queryByTestId("work-flags-w9")).toBeNull();
    // A shelf asks for one entry per title; nothing else does.
    expect(calls.of("works.list").every((call) => call.input.group === true)).toBe(true);
  });

  it("lists every work, not every title, when a resource is being moved", async () => {
    const host = installHost({
      "works.get": () => detail(),
      "works.list": () => ({ items: [summary({ id: "w2", title: "另一部" })], total: 1, nextCursor: null }),
    });
    mountHome();
    await tab("resources");
    fireEvent.click(screen.getByTestId("detail-move-r1"));
    await screen.findByTestId("work-move-to-w2");
    expect(host.of("works.list").every((call) => call.input.group === false)).toBe(true);
  });
});

describe("the library is what the library paths hold (AT-79)", () => {
  it("marks a resource whose file is under no library path, and points to adding its folder", async () => {
    installHost({ "works.get": () => detail({ outsideCount: 1, resources: [resource("r1", { outside: true }), resource("r2")] }) });
    const home = mountHome();
    await waitFor(() => expect(screen.getByTestId("work-outside")).toBeTruthy());
    expect(screen.getByTestId("work-outside").textContent).toContain("有 1 个资源的文件不在任何资源库位置里");
    fireEvent.click(screen.getByTestId("work-outside-add"));
    expect(home.opened.add).toEqual([1]);
    await tab("resources");
    expect(screen.getByTestId("detail-outside-r1")).toBeTruthy();
    expect(screen.queryByTestId("detail-outside-r2")).toBeNull();
  });

  it("shows no such mark when every resource is inside a library path", async () => {
    installHost({ "works.get": () => detail() });
    mountHome();
    await waitFor(() => expect(screen.getByTestId("detail-title")).toBeTruthy());
    expect(screen.queryByTestId("work-outside")).toBeNull();
  });

  it("flags an entry on the shelf that holds a resource outside the paths, and one whose files are gone", async () => {
    installHost({
      "works.list": () => ({
        items: [summary({ outsideCount: 1 }), summary({ id: "w3", title: "没有文件的作品", resourceCount: 0, lastResource: null })],
        total: 2, nextCursor: null,
      }),
    });
    render(<Shelf t={t} kind="video" refreshKey={0} facets={new Set(["library", "video"])} onOpen={() => {}} onContinue={() => {}} onDetail={() => {}} onAddPath={() => {}} onViewAll={() => {}} onSetShelf={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("work-flags-w1")).toBeTruthy());
    expect(screen.getByTestId("work-flags-w1").textContent).toContain("库外");
    expect(screen.getByTestId("work-flags-w3").textContent).toContain("没有资源");
  });

  it("has no import entry on the library settings page", async () => {
    const { LibraryPage } = await import("../../apps/desktop/src/renderer/pages/settings/library-page.tsx");
    installHost();
    const scan = {
      paths: [], pathsLoaded: true, running: null, queued: [], recent: [], error: null, schedule: { onStartup: false, intervalMinutes: 0 },
      reload: async () => undefined, start: async () => undefined, cancel: async () => undefined, setSchedule: async () => undefined,
    } as never;
    render(<LibraryPage t={t} scan={scan} formatDate={i18n.formatDate} onChanged={() => undefined} onError={() => undefined} onNotice={() => undefined} />);
    expect(screen.getByTestId("library-path-add")).toBeTruthy();
    expect(screen.queryByTestId("settings-import")).toBeNull();
    expect(screen.queryByTestId("library-once")).toBeNull();
  });
});

describe("a resource's file is a library path and a path inside it (AT-93)", () => {
  const outsideContent = (over: Record<string, unknown> = {}) => ({
    resource: { id: "r2", title: "第二话", kind: "video", ordinalLabel: "第 2 话", workId: "w1", workTitle: "合成作品", available: false, outside: true, path: "media/第二话.mkv", libraryRoot: null, folderToAdd: "media", ...over },
    progress: { percent: 0.4, completion: "inProgress", locator: null },
    notes: [{ objectId: "n1", title: "关于第二话的笔记", preview: "", updatedAt: "2026-02-01T00:00:00.000Z" }],
    bookmarks: [], recordings: [], conversation: null,
  });
  const openContent = async () => {
    mountHome();
    await tab("resources");
    fireEvent.click(screen.getByTestId("detail-open-r2"));
    await screen.findByTestId("resource-content");
  };

  it("says why the file cannot be opened, keeps what was made on it, and adds the folder it was in as a library path", async () => {
    const picks: Array<Record<string, unknown>> = [];
    const host = installHost({
      "works.get": () => detail({ resources: [resource("r2", { available: false, outside: true })] }),
      "library.resourceContent": () => outsideContent(),
    }, { pick: async (request: Record<string, unknown>) => { picks.push(request); return { pathHandle: "handle-dir", name: "media", mode: request.mode }; } });
    await openContent();
    expect(screen.getByTestId("resource-content-hint").textContent).toContain("不在任何资源库位置里");
    expect(screen.getByTestId("resource-note-n1").textContent).toContain("关于第二话的笔记");
    fireEvent.click(screen.getByTestId("resource-content-add-folder"));
    await waitFor(() => expect(host.of("library.paths.add")).toHaveLength(1));
    // The folder dialog opens at the folder the file was in, and the path added is of the resource's medium.
    expect(picks).toEqual([{ mode: "directory", defaultPath: "media" }]);
    expect(host.of("library.paths.add")[0]!.input).toEqual({ pathHandle: "handle-dir", mediaKind: "video" });
  });

  it("opens the file picker at the resource's library path, and offers the folder when the file picked lies outside every path", async () => {
    const picks: Array<Record<string, unknown>> = [];
    const host = installHost({
      "works.get": () => detail({ resources: [resource("r2", { available: false })] }),
      "library.resourceContent": () => outsideContent({ outside: false, libraryRoot: "library-root", folderToAdd: null }),
      // The command layer answers the picked file as the application does: refused, naming the folder.
      "library.repairSource": () => ({ __error: { code: "VALIDATION_ERROR", message: "outside", retryable: false, details: { reason: "outside-library", folder: "other/folder" } } }),
    }, { pick: async (request: Record<string, unknown>) => { picks.push(request); return { pathHandle: `handle-${picks.length}`, name: "x", mode: request.mode }; } });
    await openContent();
    fireEvent.click(screen.getByTestId("resource-content-relocate"));
    await screen.findByTestId("resource-content-outside-picked");
    expect(picks[0]).toEqual({ mode: "file", filter: "video", defaultPath: "library-root" });
    expect(screen.getByTestId("resource-content-outside-picked").textContent).toContain("other/folder");
    expect(host.of("library.paths.add")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("resource-content-add-picked-folder"));
    await waitFor(() => expect(picks[1]).toEqual({ mode: "directory", defaultPath: "other/folder" }));
  });

  it("changes a library path to another folder, and says when the new folder does not hold the same files", async () => {
    const { LibraryPage } = await import("../../apps/desktop/src/renderer/pages/settings/library-page.tsx");
    let reply: unknown = { __error: { code: "VALIDATION_ERROR", message: "no", retryable: false, details: { reason: "fingerprint-mismatch", checked: 4, matched: 1 } } };
    const errors: string[] = [];
    const notices: string[] = [];
    const picks: Array<Record<string, unknown>> = [];
    const host = installHost({ "library.paths.update": () => reply }, { pick: async (request: Record<string, unknown>) => { picks.push(request); return { pathHandle: "handle-new", name: "new", mode: "directory" }; } });
    const path = { id: "lp1", path: "old/folder", mediaKind: "video", autoScan: false, createdAt: "2026-01-01T00:00:00.000Z", lastScanAt: null, lastScan: null, reachable: true, files: { present: 3, unavailable: 0 } };
    const scan = {
      paths: [path], pathsLoaded: true, running: null, queued: [], recent: [], error: null, schedule: { onStartup: false, intervalMinutes: 0 },
      reload: async () => undefined, start: async () => undefined, cancel: async () => undefined, setSchedule: async () => undefined,
    } as never;
    render(<LibraryPage t={t} scan={scan} formatDate={i18n.formatDate} onChanged={() => undefined} onError={(message) => errors.push(message)} onNotice={(message) => notices.push(message)} />);
    fireEvent.click(screen.getByTestId("library-path-move-lp1"));
    await waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toContain("核对了 4 个");
    expect(picks).toEqual([{ mode: "directory", defaultPath: "old/folder" }]);
    reply = { path: { id: "lp1" }, moved: true, checked: 5 };
    fireEvent.click(screen.getByTestId("library-path-move-lp1"));
    await waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]).toContain("核对了 5 个文件");
    expect(host.of("library.paths.update").map((call) => call.input)).toEqual([{ pathId: "lp1", pathHandle: "handle-new" }, { pathId: "lp1", pathHandle: "handle-new" }]);
  });
});

describe("downloads are published into a library path (AT-79)", () => {
  const rigs: Rig[] = [];
  const disposers: Array<() => void> = [];
  afterEach(() => { while (disposers.length) disposers.pop()!(); while (rigs.length) { try { rigs.pop()!.app.close(); } catch { /* closed */ } } });

  it("offers the default download folder when no library path exists, and downloads go there", async () => {
    const rig = await boot();
    rigs.push(rig);
    const bridge = bridgeToApp(rig, {});
    disposers.push(bridge.dispose);
    render(<DownloadsPage t={t} onOpenSettings={() => undefined} onError={() => undefined} onNotice={() => undefined} />);
    await screen.findByTestId("page-downloads");
    expect(screen.getByTestId("downloads-add-no-path")).toBeTruthy();
    fireEvent.change(screen.getByTestId("downloads-default-kind"), { target: { value: "comic" } });
    fireEvent.click(screen.getByTestId("downloads-default-use"));
    await waitFor(() => expect(screen.queryByTestId("downloads-add-no-path")).toBeNull());
    const select = screen.getByTestId("downloads-add-path") as HTMLSelectElement;
    const paths = rig.app.store.sqlite.prepare("SELECT id, path, media_kind AS kind FROM library_paths").all() as Array<{ id: string; path: string; kind: string }>;
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ kind: "comic" });
    expect(paths[0]!.path.startsWith(rig.app.layout.partitions.downloads)).toBe(true);
    expect(select.value).toBe(paths[0]!.id);
    expect(select.selectedOptions[0]!.textContent).toContain(path.basename(paths[0]!.path));
    expect(select.selectedOptions[0]!.textContent).toContain("漫画");
  }, 30_000);
});
