/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import type { WorkSummary } from "@manga/contracts/media";
import { Shelf } from "../../apps/desktop/src/renderer/pages/shelf.tsx";
import { WorkHome } from "../../apps/desktop/src/renderer/pages/work-home.tsx";
import { WorksCacheContext, type WorksCache } from "../../apps/desktop/src/renderer/lib/use-works.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";

const i18n = createTranslator("zh-CN");

const makeWork = (id: string, kind: WorkSummary["mediaKind"], extra: Partial<WorkSummary> = {}): WorkSummary => ({
  id,
  title: `作品 ${id}`,
  author: "合成作者",
  mediaKind: kind,
  shelf: "reading",
  coverId: null,
  lastResource: { id: `res_${id}`, title: `作品 ${id}`, ordinalLabel: null, revisionId: `rev_${id}` },
  progress: 0.4,
  progressContext: null,
  finishedCount: 0,
  resourceCount: 1,
  linked: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: null,
  ...extra,
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
  t: i18n.t,
  kind: null,
  refreshKey: 0,
  facets: new Set(["library", "comic", "video", "metadata"]),
  onOpen: () => {},
  onContinue: () => {},
  onDetail: () => {},
  onAddPath: () => {},
  onViewAll: () => {},
  onSetShelf: () => {},
  ...overrides,
});

beforeEach(() => {
  resetCovers();
  shelfMemory.reset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Total Resource Overview clears deleted-resource content on manual rescan", () => {
  it("clears purged works, unassigned items, and zero-available AT-77 shells from 总览 when refreshKey increments", async () => {
    let rescanned = false;
    installHost(({ commandId, input }) => {
      if (commandId === "works.unassigned") {
        if (rescanned) return { status: "ok", value: { items: [], total: 0 } };
        return {
          status: "ok",
          value: {
            items: [{ resourceId: "res_loose", kind: "novel", title: "已删散章.txt", ordinalLabel: null, leftWorkAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null, outside: false }],
            total: 1,
          },
        };
      }
      if (commandId === "works.list") {
        const all = rescanned
          ? [
              makeWork("n_alive", "novel", { title: "仍在作品" }),
              // Kept in DB only because of AT-77 user notes/overrides, with all files missing on disk:
              makeWork("n_shell", "novel", { title: "仅留笔记外壳", resourceCount: 1, missingCount: 1, lastResource: null }),
            ]
          : [
              makeWork("n_alive", "novel", { title: "仍在作品" }),
              makeWork("n_deleted", "novel", { title: "已删作品" }),
              makeWork("n_shell", "novel", { title: "仅留笔记外壳", resourceCount: 1, missingCount: 0 }),
            ];
        const items = all.filter((w) => !input.kind || w.mediaKind === input.kind);
        return { status: "ok", value: { items, total: items.length, nextCursor: null } };
      }
      return { status: "ok", value: {} };
    });

    const worksCache: WorksCache = new Map();
    const { rerender } = render(
      <WorksCacheContext.Provider value={worksCache}>
        <Shelf {...shelfProps({ kind: null, refreshKey: 1 })} />
      </WorksCacheContext.Provider>,
    );

    await waitFor(() => expect(screen.getByTestId("work-n_deleted")).toBeTruthy());
    expect(screen.getByTestId("work-n_alive")).toBeTruthy();
    expect(screen.getByTestId("work-n_shell")).toBeTruthy();
    expect(screen.getByTestId("unassigned-res_loose")).toBeTruthy();

    // Simulate manual rescan finishing: backend purged deleted items & marked AT-77 shell missing, UI bumps refreshKey.
    rescanned = true;
    rerender(
      <WorksCacheContext.Provider value={worksCache}>
        <Shelf {...shelfProps({ kind: null, refreshKey: 2 })} />
      </WorksCacheContext.Provider>,
    );

    await waitFor(() => expect(screen.queryByTestId("work-n_deleted")).toBeNull());
    expect(screen.queryByTestId("work-n_shell")).toBeNull();
    expect(screen.queryByTestId("unassigned-res_loose")).toBeNull();
    expect(screen.getByTestId("work-n_alive")).toBeTruthy();
    expect(screen.getByTestId("section-count-novel").textContent).toBe("共 1 本");

    // Individual medium shelf still keeps AT-77 shell reachable with missing badge.
    rerender(
      <WorksCacheContext.Provider value={worksCache}>
        <Shelf {...shelfProps({ kind: "novel", refreshKey: 2 })} />
      </WorksCacheContext.Provider>,
    );
    await waitFor(() => expect(screen.getByTestId("work-n_shell")).toBeTruthy());
    expect(screen.getByTestId("work-flags-n_shell").textContent).toContain("文件不可用");
  });

  it("auto-fetches subsequent pages in ShelfSection when the first 14 items are AT-77 shells and caps visible row at 14", async () => {
    const shells = Array.from({ length: 14 }, (_, i) => makeWork(`shell_${i}`, "novel", {
      title: `保留壳 ${i}`,
      resourceCount: 1,
      missingCount: 1,
      lastResource: null,
    }));
    const availableWorks = Array.from({ length: 15 }, (_, i) => makeWork(`avail_${i}`, "novel", {
      title: `可用作品 ${i}`,
      resourceCount: 1,
      missingCount: 0,
    }));

    const calls = installHost(({ commandId, input }) => {
      if (commandId === "works.unassigned") return { status: "ok", value: { items: [], total: 0 } };
      if (commandId === "works.list") {
        if (input.kind !== "novel") return { status: "ok", value: { items: [], total: 0, nextCursor: null } };
        if (!input.cursor) {
          return { status: "ok", value: { items: shells, total: 29, nextCursor: "cursor_page_2" } };
        }
        if (input.cursor === "cursor_page_2") {
          return { status: "ok", value: { items: availableWorks, total: 29, nextCursor: null } };
        }
      }
      return { status: "ok", value: {} };
    });

    render(<Shelf {...shelfProps({ kind: null })} />);

    await waitFor(() => expect(screen.getByTestId("work-avail_0")).toBeTruthy());
    expect(calls.some((c) => c.commandId === "works.list" && c.input.cursor === "cursor_page_2")).toBe(true);
    expect(screen.queryByTestId("section-empty-novel")).toBeNull();
    expect(screen.getByTestId("work-avail_13")).toBeTruthy();
    expect(screen.queryByTestId("work-avail_14")).toBeNull();
    expect(screen.getByTestId("section-novel").querySelector(".section-more")).toBeTruthy();
    expect(screen.getByTestId("section-count-novel").textContent).toBe("共 15 本");
  });
});

describe("Bangumi synced portrait thumbnails on Overview, Anime shelf, and WorkHome", () => {
  it("renders anime cards in portrait size with synced Bangumi aspect ratio on both 总览 and 动漫 shelves (never landscape 16:10)", async () => {
    installHost(({ commandId, input }) => {
      if (commandId === "works.list") {
        const anime = makeWork("v_bgm", "video", {
          title: "葬送的芙莉莲",
          coverId: "cov_bgm_v",
          linked: true,
          progress: 0.4,
        });
        const items = !input.kind || input.kind === "video" ? [anime] : [];
        return { status: "ok", value: { items, total: items.length, nextCursor: null } };
      }
      if (commandId === "covers.handles") {
        return {
          status: "ok",
          value: {
            covers: [{ coverId: "cov_bgm_v", available: true, url: "manga-media://test/cov_bgm_v.webp", width: 250, height: 350 }],
          },
        };
      }
      if (commandId === "works.unassigned") return { status: "ok", value: { items: [], total: 0 } };
      return { status: "ok", value: {} };
    });

    const { rerender } = render(<Shelf {...shelfProps({ kind: null })} />);
    await waitFor(() => expect(screen.getByTestId("work-v_bgm").querySelector("img.cover-img")).toBeTruthy());

    const overviewCard = screen.getByTestId("work-v_bgm");
    const overviewCover = overviewCard.querySelector<HTMLElement>(".work-cover")!;
    expect(overviewCover.classList.contains("is-landscape")).toBe(false);
    expect(overviewCover.style.aspectRatio).toBe("1 / 1.4");
    expect(overviewCard.querySelector(".cover-play")).toBeTruthy();
    expect(screen.getByTestId("work-progress-v_bgm").textContent).toContain("已看 40%");

    // Switch to Anime shelf (动漫): uses portrait grid (4 columns at 800px instead of 3 landscape columns) and synced portrait cover ratio.
    rerender(<Shelf {...shelfProps({ kind: "video" })} />);
    await waitFor(() => expect(screen.getByTestId("shelf-grid")).toBeTruthy());

    const grid = screen.getByTestId("shelf-grid");
    expect(Number(grid.getAttribute("data-columns"))).toBe(4);
    const animeCover = screen.getByTestId("work-v_bgm").querySelector<HTMLElement>(".work-cover")!;
    expect(animeCover.classList.contains("is-landscape")).toBe(false);
    expect(animeCover.style.aspectRatio).toBe("1 / 1.4");
  });

  it("renders WorkHome hero cover in portrait aspect ratio after matching Bangumi", async () => {
    installHost(({ commandId }) => {
      if (commandId === "works.get") {
        return {
          status: "ok",
          value: {
            id: "v_bgm",
            title: "葬送的芙莉莲",
            originalTitle: null,
            author: null,
            mediaKind: "video",
            shelf: "reading",
            coverId: "cov_detail_v",
            coverState: "auto",
            coverCount: 2,
            lastResource: { id: "res_1", title: "01", ordinalLabel: "第 1 话", revisionId: "rev_1" },
            progress: 0.5,
            progressCompleted: false,
            progressContext: null,
            contextPositions: [],
            finishedCount: 0,
            resourceCount: 1,
            linked: true,
            versionCount: 1,
            outsideCount: 0,
            missingCount: 0,
            versions: [],
            fields: {},
            override: { fields: {}, locked: [], cleared: [] },
            links: [{ providerId: "bangumi", externalId: "400602", linkState: "linked" }],
            snapshots: [],
            linkedSource: { providerId: "bangumi", externalId: "400602", rating: { score: 8.8 }, episodeCount: 28, relatedCount: 2, detached: false, sourceUrl: "https://bgm.tv/subject/400602", fetchedAt: "2026-01-01T00:00:00.000Z" },
            resources: [{ id: "res_1", title: "01", kind: "video", ordinalLabel: "第 1 话", ordinalNumber: 1, ordinalType: "episode", available: true, outside: false, progress: 0.5, completionState: "in_progress" }],
          },
        };
      }
      if (commandId === "covers.list") {
        return { status: "ok", value: { workId: "v_bgm", state: "auto", coverId: "cov_detail_v", covers: [{ id: "cov_detail_v", workId: "v_bgm", source: "bangumi", width: 300, height: 420, selected: true }] } };
      }
      if (commandId === "covers.handles") {
        return { status: "ok", value: { covers: [{ coverId: "cov_detail_v", available: true, url: "manga-media://test/cov_detail_v.webp", width: 300, height: 420 }] } };
      }
      return { status: "ok", value: { candidates: [], groups: [], sessions: [], items: [] } };
    });

    render(
      <WorkHome
        t={i18n.t}
        workId="v_bgm"
        facets={new Set(["library", "video", "metadata"])}
        formatDate={() => "2026-01-01"}
        onBack={() => {}}
        onOpenResource={() => {}}
        onOpenNote={() => {}}
        onOpenWork={() => {}}
        onChanged={() => {}}
        onError={() => {}}
        onNotice={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("page-work").querySelector("img.cover-img")).toBeTruthy());
    const detailCover = screen.getByTestId("page-work").querySelector<HTMLElement>(".detail-cover")!;
    expect(detailCover.classList.contains("is-landscape")).toBe(false);
    expect(detailCover.style.aspectRatio).toBe("300 / 420");
  });
});
