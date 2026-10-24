/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { Shelf } from "../../apps/desktop/src/renderer/pages/shelf.tsx";
import { WorksCacheContext, normalizePage, usePagedWorks, type WorksCache } from "../../apps/desktop/src/renderer/lib/use-works.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import type { WorkSummary } from "@manga/contracts/media";
import { libraryTitle } from "../../apps/desktop/src/renderer/workspace/openers.ts";

const i18n = createTranslator("zh-CN");

const work = (id: string, kind: WorkSummary["mediaKind"], extra: Partial<WorkSummary> = {}): WorkSummary => ({
  id, title: `作品 ${id}`, author: "合成作者", mediaKind: kind, shelf: "reading", coverId: null,
  lastResource: { id: `res_${id}`, title: `作品 ${id}`, ordinalLabel: null, revisionId: `rev_${id}` },
  progress: 0.25, progressContext: null, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null, ...extra,
});

type Call = { commandId: string; input: Record<string, unknown> };

function installHost(handler: (call: Call) => { status: "ok"; value: unknown } | { status: "error"; error: { code: string; message: string } }) {
  const calls: Call[] = [];
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input: Record<string, unknown> }) {
      const call = { commandId: payload.commandId, input: payload.input ?? {} };
      calls.push(call);
      return handler(call);
    },
  };
  return calls;
}

const shelfProps = (overrides: Partial<Parameters<typeof Shelf>[0]> = {}): Parameters<typeof Shelf>[0] => ({
  t: i18n.t, kind: null, refreshKey: 0, facets: new Set(["library", "comic", "video", "metadata"]),
  onOpen: () => {}, onContinue: () => {}, onDetail: () => {}, onAddPath: () => {}, onViewAll: () => {}, onSetShelf: () => {},
  ...overrides,
});

beforeEach(() => { resetCovers(); shelfMemory.reset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the anime shelf says watched, not read (Q-18)", () => {
  const list = (items: WorkSummary[]) => installHost(({ input }) => {
    const shown = items.filter((item) => !input.kind || item.mediaKind === input.kind);
    return { status: "ok", value: { items: shown, total: shown.length, nextCursor: null } };
  });
  const tabs = () => ["all", "reading", "wishlist", "finished", "on_hold"].map((id) => screen.getByTestId(`shelf-tab-${id}`).textContent);

  it("names the tabs of the anime shelf 在看, 想看 and 看过, and leaves the other shelves reading", async () => {
    list([work("v1", "video")]);
    render(<Shelf {...shelfProps({ kind: "video" })} />);
    await waitFor(() => expect(screen.getByTestId("work-v1")).toBeTruthy());
    expect(tabs()).toEqual(["全部", "在看", "想看", "看过", "搁置"]);
    cleanup();
    for (const kind of ["novel", "comic", null] as const) {
      list([]);
      render(<Shelf {...shelfProps({ kind })} />);
      expect(tabs(), String(kind)).toEqual(["全部", "在读", "想读", "已读", "搁置"]);
      cleanup();
    }
  });

  it("shows 已看 and the percent on an anime card, and 已读 on a book or a comic", async () => {
    list([work("v1", "video", { progress: 0.4 }), work("c1", "comic", { progress: 0.25 })]);
    render(<Shelf {...shelfProps({ kind: null })} />);
    await waitFor(() => expect(screen.getByTestId("work-progress-v1")).toBeTruthy());
    expect(screen.getByTestId("work-progress-v1").textContent).toContain("已看 40%");
    expect(screen.getByTestId("work-progress-c1").textContent).toContain("已读 25%");
    expect(screen.getByTestId("work-progress-v1").textContent).not.toContain("已读");
  });

  it("notes which context a position comes from, and says nothing about the current context's own (A-96)", async () => {
    list([
      work("a", "comic", { progress: 0.4, progressContext: { contextId: "proj-a", name: "项目甲" } }),
      work("b", "comic", { progress: 0.5, progressContext: { contextId: null, name: "最近" } }),
      work("c", "comic", { progress: 0.6, progressContext: { contextId: "proj-a", name: "项目甲" } }),
      work("d", "comic", { progress: 0, progressContext: null }),
    ]);
    // The shelf is in 最近: a position from the project is noted, the shelf's own is not.
    const { rerender } = render(<Shelf {...shelfProps({ kind: null })} context={null} />);
    await waitFor(() => expect(screen.getByTestId("work-progress-a")).toBeTruthy());
    expect(screen.getByTestId("work-origin-a").textContent).toBe("来自“项目甲”");
    expect(screen.queryByTestId("work-origin-b")).toBeNull();
    expect(screen.getByTestId("work-origin-c").textContent).toBe("来自“项目甲”");
    expect(screen.queryByTestId("work-origin-d")).toBeNull();
    // In the project the same cards swap: its own position is silent, the one from 最近 is noted.
    rerender(<Shelf {...shelfProps({ kind: null })} context="proj-a" />);
    await waitFor(() => expect(screen.queryByTestId("work-origin-a")).toBeNull());
    expect(screen.getByTestId("work-origin-b").textContent).toBe("来自“最近”");
    // A shelf that is told no context notes nothing.
    rerender(<Shelf {...shelfProps({ kind: null })} />);
    await waitFor(() => expect(screen.queryByTestId("work-origin-b")).toBeNull());
  });

  it("labels the shelf state on an anime card and in its menu with the same words", async () => {
    // The state is the card's tag while nothing has been watched or read yet.
    list([work("v1", "video", { shelf: "finished", progress: 0 }), work("c1", "comic", { shelf: "finished", progress: 0 })]);
    render(<Shelf {...shelfProps({ kind: null })} />);
    await waitFor(() => expect(screen.getByTestId("work-v1")).toBeTruthy());
    expect(within(screen.getByTestId("work-v1")).getByText("看过")).toBeTruthy();
    expect(within(screen.getByTestId("work-c1")).getByText("已读")).toBeTruthy();
    fireEvent.click(screen.getByTestId("work-menu-v1"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("设置状态：看过")).toBeTruthy();
    expect(within(menu).getByText("设置状态：在看")).toBeTruthy();
    expect(within(menu).getByText("设置状态：想看")).toBeTruthy();
    expect(within(menu).queryByText(/已读/)).toBeNull();
  });
});

describe("shelf", () => {
  it("shows one row per media kind with counts, progress text and the open and view-all entries", async () => {
    installHost(({ commandId, input }) => {
      if (commandId === "works.list") {
        const kind = input.kind as WorkSummary["mediaKind"];
        const items = kind === "novel" ? [work("n1", "novel")] : kind === "comic" ? [work("c1", "comic"), work("c2", "comic")] : [];
        return { status: "ok", value: { items, total: items.length, nextCursor: null } };
      }
      return { status: "ok", value: { covers: [] } };
    });
    const opened = vi.fn();
    const viewAll = vi.fn();
    render(<Shelf {...shelfProps({ onOpen: opened, onViewAll: viewAll })} />);
    await waitFor(() => expect(screen.getByTestId("section-count-comic").textContent).toContain("2"));
    expect(screen.getByTestId("section-count-novel").textContent).toContain("1");
    expect(screen.getByTestId("section-empty-video")).toBeTruthy();
    expect(screen.getByTestId("work-progress-c1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("open-res_c1"));
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    fireEvent.click(screen.getByTestId("section-all-comic"));
    expect(viewAll).toHaveBeenCalledWith("comic");
  });

  it("sends the shelf tab, the search text and the filters to the library query", async () => {
    const calls = installHost(() => ({ status: "ok", value: { items: [], total: 0, nextCursor: null } }));
    render(<Shelf {...shelfProps({ kind: "comic" })} />);
    await waitFor(() => expect(calls.some((call) => call.commandId === "works.list")).toBe(true));
    fireEvent.click(screen.getByTestId("shelf-tab-finished"));
    await waitFor(() => expect(calls.some((call) => call.input.shelf === "finished" && call.input.kind === "comic")).toBe(true));
    fireEvent.change(screen.getByTestId("shelf-search"), { target: { value: "合成" } });
    await waitFor(() => expect(calls.some((call) => call.input.query === "合成")).toBe(true), { timeout: 2000 });
    fireEvent.click(screen.getByTestId("shelf-filter"));
    fireEvent.change(screen.getByTestId("shelf-filter-linked"), { target: { value: "yes" } });
    fireEvent.change(screen.getByTestId("shelf-filter-format"), { target: { value: "cbz" } });
    await waitFor(() => expect(calls.some((call) => call.input.linked === true && call.input.format === "cbz" && call.input.query === "合成")).toBe(true));
    // A filter that matches nothing says so, and does not look like an empty library.
    await waitFor(() => expect(screen.getByTestId("shelf-empty-filtered")).toBeTruthy());
  });

  it("does not search while an input method is still composing", async () => {
    const calls = installHost(() => ({ status: "ok", value: { items: [], total: 0, nextCursor: null } }));
    render(<Shelf {...shelfProps({ kind: "novel" })} />);
    const box = screen.getByTestId("shelf-search");
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "ni" } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls.some((call) => call.input.query === "ni")).toBe(false);
    fireEvent.compositionEnd(box, { target: { value: "你" } });
    await waitFor(() => expect(calls.some((call) => call.input.query === "你")).toBe(true), { timeout: 2000 });
  });

  it("separates an empty library, a failed read and a turned-off module", async () => {
    let fail = true;
    installHost(({ commandId }) => {
      if (commandId !== "works.list") return { status: "ok", value: {} };
      return fail ? { status: "error", error: { code: "INTERNAL", message: "合成故障" } } : { status: "ok", value: { items: [], total: 0, nextCursor: null } };
    });
    const { rerender } = render(<Shelf {...shelfProps({ kind: "comic", facets: new Set(["library"]) })} />);
    expect(screen.getByTestId("shelf-module-off").textContent).toContain("漫画");
    await waitFor(() => expect(screen.getByTestId("shelf-error").textContent).toContain("合成故障"));
    fail = false;
    fireEvent.click(within(screen.getByTestId("shelf-error")).getByRole("button"));
    await waitFor(() => expect(screen.getByTestId("shelf-empty")).toBeTruthy());
    rerender(<Shelf {...shelfProps({ kind: "comic", facets: new Set(["library", "comic"]) })} />);
    expect(screen.queryByTestId("shelf-module-off")).toBeNull();
  });

  it("shows the empty library once, with a way to add a library path and no import button, when no kind has works", async () => {
    installHost(() => ({ status: "ok", value: { items: [], total: 0, nextCursor: null } }));
    const addPath = vi.fn();
    render(<Shelf {...shelfProps({ onAddPath: addPath })} />);
    await waitFor(() => expect(screen.getByTestId("shelf-empty")).toBeTruthy());
    expect(screen.queryByTestId("section-novel")).toBeNull();
    // Works come from library paths (A-49): the empty shelf points there, and the shelf has no import entry of its own.
    expect(screen.queryByTestId("shelf-import")).toBeNull();
    expect(within(screen.getByTestId("shelf-empty")).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("shelf-add-path"));
    expect(addPath).toHaveBeenCalled();
  });

  it("says an empty kind is empty and offers the same way to add a path, but not when a search or a filter made it empty", async () => {
    installHost(() => ({ status: "ok", value: { items: [], total: 0, nextCursor: null } }));
    const addPath = vi.fn();
    render(<Shelf {...shelfProps({ kind: "video", onAddPath: addPath })} />);
    await waitFor(() => expect(screen.getByTestId("shelf-empty")).toBeTruthy());
    fireEvent.click(screen.getByTestId("shelf-add-path"));
    expect(addPath).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("shelf-tab-finished"));
    await waitFor(() => expect(screen.getByTestId("shelf-empty-filtered")).toBeTruthy());
    expect(screen.queryByTestId("shelf-add-path")).toBeNull();
  });

  it("opens the work's page from the card, and keeps reading from the card's menu", async () => {
    installHost(({ commandId, input }) => commandId === "works.list"
      ? { status: "ok", value: input.kind === "comic" ? { items: [work("c1", "comic")], total: 1, nextCursor: null } : { items: [], total: 0, nextCursor: null } }
      : { status: "ok", value: { covers: [] } });
    const opened = vi.fn();
    const continued = vi.fn();
    render(<Shelf {...shelfProps({ onOpen: opened, onContinue: continued })} />);
    await waitFor(() => expect(screen.getByTestId("open-res_c1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("open-res_c1"));
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    expect(continued).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("work-menu-c1"));
    expect(screen.getByTestId("work-menu-c1-open").textContent).toContain("继续阅读");
    fireEvent.click(screen.getByTestId("work-menu-c1-open"));
    expect(continued).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("shows the shelf as it was left, with the tab, the search, the filters and the sort, when it is shown again", async () => {
    const calls = installHost(() => ({ status: "ok", value: { items: [], total: 0, nextCursor: null } }));
    const first = render(<Shelf {...shelfProps({ kind: "comic" })} />);
    fireEvent.click(screen.getByTestId("shelf-tab-finished"));
    fireEvent.change(screen.getByTestId("shelf-search"), { target: { value: "合成" } });
    fireEvent.click(screen.getByTestId("shelf-filter"));
    fireEvent.change(screen.getByTestId("shelf-filter-linked"), { target: { value: "yes" } });
    fireEvent.click(screen.getByTestId("shelf-sort"));
    fireEvent.click(screen.getByTestId("shelf-sort-title"));
    await waitFor(() => expect(calls.some((call) => call.input.query === "合成" && call.input.sort === "title" && call.input.linked === true)).toBe(true), { timeout: 2000 });
    first.unmount();
    // A work's page came and went; the shelf is mounted again.
    calls.length = 0;
    render(<Shelf {...shelfProps({ kind: "comic" })} />);
    expect((screen.getByTestId("shelf-search") as HTMLInputElement).value).toBe("合成");
    expect(screen.getByTestId("shelf-tab-finished").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(calls.some((call) => call.input.shelf === "finished" && call.input.query === "合成" && call.input.sort === "title" && call.input.linked === true)).toBe(true));
    // Another shelf did not inherit it.
    cleanup();
    render(<Shelf {...shelfProps({ kind: "novel" })} />);
    expect((screen.getByTestId("shelf-search") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("shelf-tab-all").getAttribute("aria-selected")).toBe("true");
  });
});

describe("each page speaks of its own medium and is titled as the left column names it (AT-100)", () => {
  const empty = () => installHost(() => ({ status: "ok", value: { items: [], total: 0, nextCursor: null } }));
  const cases = [
    { kind: null, title: "总览", search: "搜索作品名、作者或标签", tabs: "阅读与观看状态", about: "作品", every: "小说、漫画、动漫" },
    { kind: "novel", title: "小说", search: "搜索书名、作者或标签", tabs: "阅读状态", about: "小说", every: "小说" },
    { kind: "comic", title: "漫画", search: "搜索漫画名、作者或标签", tabs: "阅读状态", about: "漫画", every: "漫画" },
    { kind: "video", title: "动漫", search: "搜索动漫名、制作方或标签", tabs: "观看状态", about: "动漫", every: "动漫" },
  ] as const;

  it("titles the overview and the three pages as the navigation does, with a search box and tabs that name what they hold", async () => {
    for (const item of cases) {
      empty();
      render(<Shelf {...shelfProps({ kind: item.kind })} />);
      expect(screen.getByTestId("shelf-title").textContent, String(item.kind)).toBe(item.title);
      expect(screen.getByTestId("shelf-search").getAttribute("placeholder"), String(item.kind)).toBe(item.search);
      expect(screen.getByRole("tablist").getAttribute("aria-label"), String(item.kind)).toBe(item.tabs);
      await waitFor(() => expect(screen.getByTestId("shelf-empty")).toBeTruthy());
      cleanup();
    }
    // The library tab names the three pages with the same words when it shows them; the overview is the library itself.
    expect(["novel", "comic", "video"].map((page) => libraryTitle(i18n.t, page))).toEqual(cases.slice(1).map((item) => item.title));
    expect(libraryTitle(i18n.t, "overview")).toBe(i18n.t("tab.library"));
  });

  it("says what is being read, what failed and what to add in the words of the page, and never calls a comic or an anime a book", async () => {
    for (const item of cases) {
      let fail = true;
      installHost(() => (fail ? { status: "error", error: { code: "INTERNAL", message: "合成故障" } } : { status: "ok", value: { items: [], total: 0, nextCursor: null } }));
      render(<Shelf {...shelfProps({ kind: item.kind })} />);
      // The overview reads its three sections one by one, each in the words of its medium.
      const named = item.kind ? [item.about] : ["小说", "漫画", "动漫"];
      expect(screen.getAllByTestId("shelf-loading").map((node) => node.textContent), String(item.kind)).toEqual(named.map((name) => `正在读取${name}…`));
      await waitFor(() => expect(screen.getAllByTestId("shelf-error")).toHaveLength(named.length));
      screen.getAllByTestId("shelf-error").forEach((node, index) => expect(node.textContent, String(item.kind)).toContain(`${named[index]}暂时无法读取`));
      fail = false;
      for (const button of screen.getAllByTestId("shelf-error").map((node) => within(node).getByRole("button"))) fireEvent.click(button);
      await waitFor(() => expect(screen.getByTestId("shelf-empty")).toBeTruthy());
      expect(screen.getByTestId("shelf-empty").textContent, String(item.kind)).toContain(`添加放着${item.every}的资源库路径`);
      const page = screen.getByTestId(item.kind ? `shelf-${item.kind}` : "shelf-all").textContent ?? "";
      expect(page).not.toMatch(/书架|导入/);
      if (item.kind && item.kind !== "novel") expect(page).not.toMatch(/书名|书籍/);
      cleanup();
    }
  });
});

describe("paged works", () => {
  it("appends the next page without duplicates and keeps the total", async () => {
    const first = Array.from({ length: 60 }, (_, index) => work(`w${index}`, "novel"));
    const second = [work("w59", "novel"), ...Array.from({ length: 41 }, (_, index) => work(`w${60 + index}`, "novel"))];
    installHost(({ input }) => ({ status: "ok", value: input.cursor ? { items: second, total: 101, nextCursor: null } : { items: first, total: 101, nextCursor: "next" } }));
    const { result } = renderHook(() => usePagedWorks({ kind: "novel" }, 0));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.items).toHaveLength(60);
    expect(result.current.total).toBe(101);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(101));
    expect(new Set(result.current.items.map((item) => item.id)).size).toBe(101);
    expect(result.current.nextCursor).toBeNull();
  });

  it("drops the answer of a query that is no longer the current one", async () => {
    const waiting = new Map<string, (value: unknown) => void>();
    (window as unknown as { manga: unknown }).manga = {
      command: (payload: { input: { query?: string } }) => new Promise((resolve) => { waiting.set(payload.input.query ?? "", resolve); }),
    };
    const { result, rerender } = renderHook(({ query }: { query: string }) => usePagedWorks({ kind: "novel", query }, 0), { initialProps: { query: "旧" } });
    rerender({ query: "新" });
    await waitFor(() => expect(waiting.has("新")).toBe(true));
    await act(async () => { waiting.get("新")!({ status: "ok", value: { items: [work("new", "novel")], total: 1, nextCursor: null } }); });
    await act(async () => { waiting.get("旧")!({ status: "ok", value: { items: [work("old", "novel")], total: 1, nextCursor: null } }); });
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(["new"]));
  });

  it("shows the kept first page at once when a shelf is shown again, and replaces it with the fresh answer", async () => {
    const cache: WorksCache = new Map();
    const wrapper = ({ children }: { children: React.ReactNode }) => <WorksCacheContext.Provider value={cache}>{children}</WorksCacheContext.Provider>;
    let answer = [work("a", "novel")];
    installHost(() => ({ status: "ok", value: { items: answer, total: answer.length, nextCursor: null } }));
    const first = renderHook(() => usePagedWorks({ kind: "novel" }, 0), { wrapper });
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    first.unmount();

    // The second answer is held back, so what is on screen at first is what was kept.
    let release: (value: unknown) => void = () => undefined;
    (window as unknown as { manga: unknown }).manga = { command: () => new Promise((resolve) => { release = resolve; }) };
    const again = renderHook(() => usePagedWorks({ kind: "novel" }, 0), { wrapper });
    expect(again.result.current.status).toBe("ready");
    expect(again.result.current.items.map((item) => item.id)).toEqual(["a"]);
    answer = [work("b", "novel"), work("a", "novel")];
    await act(async () => { release({ status: "ok", value: { items: answer, total: 2, nextCursor: null } }); });
    await waitFor(() => expect(again.result.current.items.map((item) => item.id)).toEqual(["b", "a"]));
  });

  it("keeps nothing without a provider, and does not keep an empty answer", async () => {
    installHost(() => ({ status: "ok", value: { items: [], total: 0, nextCursor: null } }));
    const alone = renderHook(() => usePagedWorks({ kind: "comic" }, 0));
    await waitFor(() => expect(alone.result.current.status).toBe("ready"));
    alone.unmount();
    (window as unknown as { manga: unknown }).manga = { command: () => new Promise(() => undefined) };
    const cache: WorksCache = new Map([["{\"kind\":\"comic\"}|60", { items: [], total: 0, nextCursor: null }]]);
    const wrapper = ({ children }: { children: React.ReactNode }) => <WorksCacheContext.Provider value={cache}>{children}</WorksCacheContext.Provider>;
    const again = renderHook(() => usePagedWorks({ kind: "comic" }, 0), { wrapper });
    expect(again.result.current.status).toBe("loading");
  });

  it("treats a malformed page as an empty one", () => {
    expect(normalizePage(undefined)).toEqual({ items: [], total: 0, nextCursor: null });
    expect(normalizePage({ items: "x" as never, total: "y" as never, nextCursor: 3 as never })).toEqual({ items: [], total: 0, nextCursor: null });
  });
});
