/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { Shelf } from "../../apps/desktop/src/renderer/pages/shelf.tsx";
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
type Reply = { status: "ok"; value: unknown } | { status: "error"; error: { code: string; message: string } };

function installHost(handler: (call: Call) => Reply) {
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

const preview = {
  workId: "c1", workIds: ["c1", "c2"], title: "作品 c1", mediaKind: "comic",
  removes: { works: 2, onlineLinks: 1, snapshots: 1, candidates: 3, overrides: 0, covers: 2, characters: 4, persons: 5, derivedDanmaku: 0 },
  keeps: { resources: 3, progress: 2, bookmarks: 0, notes: 4, recordings: 1, screenshots: 6, conversations: 2, confirmedDanmaku: 0, terms: 5, files: 7 },
};

const loose = [
  { resourceId: "r-left", kind: "comic", title: "游离的一卷", ordinalLabel: "第 2 卷", leftWorkAt: "2026-10-05T00:00:00.000Z", lastOpenedAt: null, outside: false },
  { resourceId: "r-new", kind: "video", title: "没有归过作品", ordinalLabel: null, leftWorkAt: null, lastOpenedAt: null, outside: true },
];

function host(overrides: Partial<Record<string, (call: Call) => Reply>> = {}) {
  let remaining = loose.slice();
  let deleted = false;
  return installHost((call) => {
    const custom = overrides[call.commandId];
    if (custom) return custom(call);
    switch (call.commandId) {
      case "works.list": {
        const kind = call.input.kind as string | undefined;
        const items = deleted ? [] : [work("c1", "comic"), work("n1", "novel")].filter((item) => !kind || item.mediaKind === kind);
        return { status: "ok", value: { items, total: items.length, nextCursor: null } };
      }
      case "works.deletePreview": return { status: "ok", value: preview };
      case "works.delete": deleted = true; return { status: "ok", value: { deleted: 2, workIds: ["c1", "c2"], resourceIds: ["r1", "r2", "r3"], title: "作品 c1" } };
      case "works.unassigned": {
        const kind = call.input.kind as string | undefined;
        const items = remaining.filter((item) => !kind || item.kind === kind);
        return { status: "ok", value: { items, total: items.length } };
      }
      case "works.moveResource":
        remaining = remaining.filter((item) => item.resourceId !== call.input.resourceId);
        return { status: "ok", value: { resourceId: call.input.resourceId, workId: "work-new", moved: true } };
      default: return { status: "ok", value: { covers: [] } };
    }
  });
}

const props = (overrides: Partial<Parameters<typeof Shelf>[0]> = {}): Parameters<typeof Shelf>[0] => ({
  t: i18n.t, kind: null, refreshKey: 0, facets: new Set(["library", "comic", "video", "metadata"]),
  onOpen: () => {}, onContinue: () => {}, onDetail: () => {}, onAddPath: () => {}, onViewAll: () => {}, onSetShelf: () => {},
  ...overrides,
});

beforeEach(() => { resetCovers(); shelfMemory.reset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("deleting an entry from its card (AT-101)", () => {
  it("lists what goes and what stays with numbers, says it cannot be undone, and does nothing until it is confirmed", async () => {
    const calls = host();
    const changed = vi.fn();
    const notice = vi.fn();
    render(<Shelf {...props({ onChanged: changed, onNotice: notice })} />);
    await waitFor(() => expect(screen.getByTestId("work-c1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("work-menu-c1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除条目…" }));
    const dialog = await screen.findByTestId("delete-entry");
    await waitFor(() => expect(screen.getByTestId("delete-entry-body")).toBeTruthy());
    // The preview is asked for, and nothing is deleted by asking.
    expect(calls.filter((call) => call.commandId === "works.deletePreview")).toEqual([{ commandId: "works.deletePreview", input: { workId: "c1" } }]);
    expect(calls.some((call) => call.commandId === "works.delete")).toBe(false);
    const removes = within(screen.getByTestId("delete-entry-removes"));
    expect(removes.getByTestId("delete-removes-works").textContent).toBe("作品记录 2 个（包括各个版本）");
    expect(removes.getByTestId("delete-removes-characters").textContent).toContain("4");
    expect(removes.queryByTestId("delete-removes-overrides")).toBeNull();
    expect(removes.getByTestId("delete-removes-shelf")).toBeTruthy();
    const keeps = within(screen.getByTestId("delete-entry-keeps"));
    for (const [key, count] of [["resources", 3], ["notes", 4], ["screenshots", 6], ["conversations", 2], ["terms", 5], ["files", 7]] as const) expect(keeps.getByTestId(`delete-keeps-${key}`).textContent, key).toContain(String(count));
    expect(keeps.queryByTestId("delete-keeps-bookmarks")).toBeNull();
    expect(screen.getByTestId("delete-entry-warning").textContent).toBe("不能撤销；文件不会删除，仍在资源库里。");
    // Cancel closes it without deleting.
    fireEvent.click(screen.getByTestId("delete-entry-cancel"));
    await waitFor(() => expect(screen.queryByTestId("delete-entry")).toBeNull());
    expect(calls.some((call) => call.commandId === "works.delete")).toBe(false);
    expect(dialog.isConnected).toBe(false);
    // Confirming deletes once, tells the person where the resources are now, and asks the page to refresh.
    fireEvent.click(screen.getByTestId("work-menu-c1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除条目…" }));
    await waitFor(() => expect(screen.getByTestId("delete-entry-confirm")).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByTestId("delete-entry-confirm"));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(calls.filter((call) => call.commandId === "works.delete")).toEqual([{ commandId: "works.delete", input: { workId: "c1" } }]);
    expect(notice).toHaveBeenCalledWith("已删除条目「作品 c1」，3 个资源现在在“未归入作品”里");
    await waitFor(() => expect(screen.queryByTestId("delete-entry")).toBeNull());
  });

  it("keeps the confirm button off until the preview has arrived, and shows a failure of the preview instead of a button that deletes blind", async () => {
    host({ "works.deletePreview": () => ({ status: "error", error: { code: "NOT_FOUND", message: "作品已经不存在" } }) });
    render(<Shelf {...props()} />);
    await waitFor(() => expect(screen.getByTestId("work-c1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("work-menu-c1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除条目…" }));
    await waitFor(() => expect(screen.getByTestId("delete-entry-error").textContent).toContain("作品已经不存在"));
    expect(screen.getByTestId("delete-entry-confirm")).toHaveProperty("disabled", true);
  });
});

describe("the resources that are in no work (AT-101)", () => {
  it("lists them in a group at the end of the overview and of a medium's page, and opens one without a work", async () => {
    host();
    const open = vi.fn();
    render(<Shelf {...props({ onOpenResource: open })} />);
    const group = await screen.findByTestId("unassigned-group");
    expect(within(group).getByRole("heading").textContent).toContain("未归入作品");
    expect(screen.getByTestId("unassigned-count").textContent).toBe("2 个");
    // The group is after the last medium's row.
    const sections = [...document.querySelectorAll("[data-testid^='section-'], [data-testid='unassigned-group']")].map((node) => node.getAttribute("data-testid"));
    expect(sections.at(-1)).toBe("unassigned-group");
    expect(within(screen.getByTestId("unassigned-r-left")).getByText("第 2 卷 游离的一卷")).toBeTruthy();
    expect(screen.getByTestId("unassigned-r-left").textContent).toContain("2026-10-05 离开作品");
    expect(screen.getByTestId("unassigned-r-new").textContent).toContain("从没有归入过作品");
    fireEvent.click(screen.getByTestId("unassigned-open-r-left"));
    expect(open).toHaveBeenCalledWith("r-left", "comic");
    cleanup();
    // A medium's own page lists only that medium's.
    host();
    render(<Shelf {...props({ kind: "video" })} />);
    await screen.findByTestId("unassigned-group");
    expect(screen.queryByTestId("unassigned-r-left")).toBeNull();
    expect(screen.getByTestId("unassigned-r-new")).toBeTruthy();
  });

  it("does not show the group when the shelf is filtered by a state, and shows nothing when there are none", async () => {
    host();
    render(<Shelf {...props({ kind: "comic" })} />);
    await screen.findByTestId("unassigned-group");
    fireEvent.click(screen.getByTestId("shelf-tab-finished"));
    await waitFor(() => expect(screen.queryByTestId("unassigned-group")).toBeNull());
    cleanup();
    installHost((call) => call.commandId === "works.unassigned" ? { status: "ok", value: { items: [], total: 0 } } : { status: "ok", value: { items: [], total: 0, nextCursor: null } });
    render(<Shelf {...props()} />);
    await waitFor(() => expect(screen.getByTestId("shelf-empty")).toBeTruthy());
    expect(screen.queryByTestId("unassigned-group")).toBeNull();
  });

  it("puts a resource into a work from its menu, and matching makes a work for it first and opens that work on the match", async () => {
    const calls = host();
    const changed = vi.fn();
    const matched = vi.fn();
    render(<Shelf {...props({ onChanged: changed, onMatchWork: matched, onNotice: () => {} })} />);
    await screen.findByTestId("unassigned-group");
    fireEvent.click(screen.getByTestId("unassigned-menu-r-left"));
    fireEvent.click(screen.getByRole("menuitem", { name: "归入作品…" }));
    const dialog = await screen.findByTestId("work-move");
    await waitFor(() => expect(calls.some((call) => call.commandId === "works.list" && call.input.group === false)).toBe(true));
    // A new work can be named there; the resource is moved by the one command that moves resources.
    fireEvent.change(within(dialog).getByTestId("work-move-new"), { target: { value: "新作品" } });
    fireEvent.click(within(dialog).getByTestId("work-move-new-go"));
    await waitFor(() => expect(calls.some((call) => call.commandId === "works.moveResource" && call.input.resourceId === "r-left" && call.input.newWorkTitle === "新作品")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("unassigned-r-left")).toBeNull());
    expect(changed).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("unassigned-menu-r-new"));
    fireEvent.click(screen.getByRole("menuitem", { name: "匹配条目…" }));
    await waitFor(() => expect(matched).toHaveBeenCalledWith("work-new", "video"));
    expect(calls.filter((call) => call.commandId === "works.moveResource" && call.input.resourceId === "r-new")).toEqual([{ commandId: "works.moveResource", input: { resourceId: "r-new", newWorkTitle: "没有归过作品" } }]);
  });
});
