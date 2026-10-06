/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { Shelf } from "../../apps/desktop/src/renderer/pages/shelf.tsx";
import { WorksCacheContext, normalizePage, usePagedWorks, type WorksCache } from "../../apps/desktop/src/renderer/lib/use-works.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import type { WorkSummary } from "@manga/contracts/media";

const i18n = createTranslator("zh-CN");

const work = (id: string, kind: WorkSummary["mediaKind"], extra: Partial<WorkSummary> = {}): WorkSummary => ({
  id, title: `作品 ${id}`, author: "合成作者", mediaKind: kind, shelf: "reading", coverId: null,
  lastResource: { id: `res_${id}`, title: `作品 ${id}`, ordinalLabel: null, revisionId: `rev_${id}` },
  progress: 0.25, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null, ...extra,
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

describe("M2 shelf", () => {
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

describe("M2 paged works", () => {
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
