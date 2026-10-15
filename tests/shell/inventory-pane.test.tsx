/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { InventoryPane } from "../../apps/desktop/src/renderer/pages/inventory-pane.tsx";

const i18n = createTranslator("zh-CN");
afterEach(cleanup);

const category = (id: string, patch: Record<string, unknown> = {}) => ({
  id: `category:${id}`, kind: "media-category", category: id, title: id, count: 2, bytes: 2048, location: "x", hosted: true, indexed: false,
  available: true, moduleEnabled: true, status: "ready", revealable: true, missing: 0, ...patch,
});
const inventory = () => ({
  totals: { resource: { count: 3, bytes: 100 }, comic: { count: 2, bytes: 2048, hosted: 1, missing: 0 }, video: { count: 1, bytes: 0, hosted: 0 } },
  items: [
    category("comic", { indexed: true }),
    category("video", { moduleEnabled: false, status: "disabled", revealable: false }),
    category("recording", { count: 1, bytes: 700 }),
    category("cover"),
    category("playCopy", { count: 0, bytes: 0 }),
    { id: "res_1", kind: "resource", mediaKind: "novel", title: "小说一", bytes: 10, hosted: true, indexed: true, available: true, revealable: true },
    { id: "res_2", kind: "resource", mediaKind: "comic", title: "漫画一", bytes: 20, available: true, revealable: true },
    { id: "res_3", kind: "resource", mediaKind: "video", title: "动漫一", bytes: 30, available: false, revealable: true },
    { id: "capture:c1", kind: "recording", title: "合成动画 · 2026-10-02 09:00", bytes: 700, durationMs: 65_000, hosted: true, available: true, status: "ready", moduleEnabled: true, revealable: true },
    { id: "capture:c2", kind: "recording", title: "合成动画 · 2026-10-01 09:00", bytes: 0, durationMs: 4_000, hosted: true, available: true, status: "cleaned", moduleEnabled: true, revealable: false },
    { id: "n1", kind: "note", title: "笔记一", bytes: 5, hosted: true, available: true, revealable: true },
    { id: "backups", kind: "partition", title: "backups", bytes: 0, hosted: true, available: true, revealable: true },
  ],
});

function pane(overrides: Partial<Parameters<typeof InventoryPane>[0]> = {}) {
  const calls = { reveal: [] as string[], open: [] as string[] };
  render(
    <InventoryPane
      i18n={i18n}
      inventory={inventory() as unknown as Record<string, unknown>}
      onImport={vi.fn()} onScan={vi.fn()} onCancel={vi.fn()}
      onReveal={(id) => calls.reveal.push(id)}
      onRepair={vi.fn()}
      onOpenCategory={(name) => calls.open.push(name)}
      packagePreview={null} packageStrategy="skip" packageDecisions={{}}
      onPackageDecision={vi.fn()} onPackageStrategy={vi.fn()} onPackagePreview={vi.fn()} onPackageExport={vi.fn()} onPackageApply={vi.fn()} onPackageCancel={vi.fn()}
      {...overrides}
    />,
  );
  return calls;
}
const listed = () => [...screen.getByTestId("inventory-list").querySelectorAll("li")].map((item) => item.textContent ?? "");

describe("the resource overview says what a row is in words (AT-100)", () => {
  it("names a row by its kind and a resource by its medium, never by the identifier the program keeps", () => {
    pane();
    const text = screen.getByTestId("inventory-list").textContent ?? "";
    for (const raw of ["resource", "partition", "media-category", "backups", "work-folder", "indexed-root", "attachment"]) expect(text).not.toContain(raw);
    const rows = listed();
    expect(rows.find((row) => row.includes("小说一"))).toContain("小说 ·");
    expect(rows.find((row) => row.includes("漫画一"))).toContain("漫画 ·");
    expect(rows.find((row) => row.includes("动漫一"))).toContain("动漫 ·");
    expect(rows.find((row) => row.includes("笔记一"))).toContain("笔记 ·");
    expect(rows.find((row) => row.includes("备份"))).toContain("存储分区 ·");
  });

  it("filters the resources by their medium, so a card's button for comics shows the comics", () => {
    pane();
    fireEvent.click(screen.getByTestId("inv-filter-chip-novel"));
    expect(listed()).toHaveLength(1);
    expect(listed()[0]).toContain("小说一");
    fireEvent.click(screen.getByTestId("inv-filter-comic"));
    expect(screen.getByTestId("inv-filter-chip-comic").getAttribute("aria-pressed")).toBe("true");
    expect(listed()).toHaveLength(1);
    expect(listed()[0]).toContain("漫画一");
    fireEvent.click(screen.getByTestId("inv-filter-chip-video"));
    expect(listed()[0]).toContain("动漫一");
    expect(listed()[0]).toContain("不可用");
  });
});

describe("the resource overview's media categories", () => {
  it("shows a card per category with its count and size, and the list below holds the other rows", () => {
    pane();
    expect(screen.getByTestId("inv-cat-comic-summary").textContent).toContain("2 项");
    expect(screen.getByTestId("inv-cat-comic-summary").textContent).toContain("2.0 KB");
    expect(screen.getByTestId("inv-cat-recording-summary").textContent).toContain("700 B");
    for (const id of ["comic", "video", "recording", "cover", "playCopy"]) expect(screen.getByTestId(`inv-cat-${id}`)).toBeTruthy();
    // A category is a card, not also a list row.
    expect(listed().some((text) => text.includes("media-category"))).toBe(false);
    expect(listed()).toHaveLength(7);
  });

  it("says when a module is off but its data stays, and nothing about where a file is kept", () => {
    pane();
    // Every file sits in a library location (A-80): no row or card speaks of managed or indexed-only files.
    expect(screen.getByTestId("inv-cat-comic").textContent).not.toContain("托管");
    expect(screen.getByTestId("inventory-list").textContent).not.toMatch(/托管|仅索引/);
    expect(screen.getByTestId("inv-cat-video-disabled").textContent).toContain("数据保留");
    expect(screen.getByTestId("inv-cat-video").getAttribute("data-status")).toBe("disabled");
    // A category of a switched-off module cannot be opened as a page, but it can still be filtered to.
    expect(screen.queryByTestId("inv-open-video")).toBeNull();
    expect(screen.getByTestId("inv-open-comic")).toBeTruthy();
  });

  it("filters the list by category, keeps the active filter visible, and returns to all", () => {
    pane();
    fireEvent.click(screen.getByTestId("inv-filter-chip-recording"));
    expect(screen.getByTestId("inv-filter-chip-recording").getAttribute("aria-pressed")).toBe("true");
    expect(listed()).toHaveLength(2);
    expect(listed().every((text) => text.includes("录音"))).toBe(true);
    // A recording whose audio the user chose not to keep says so; it is not shown as a fault.
    expect(listed().some((text) => text.includes("音频已按选择清理"))).toBe(true);
    fireEvent.click(screen.getByTestId("inv-filter-chip-note"));
    expect(listed()).toHaveLength(1);
    expect(listed()[0]).toContain("笔记一");
    fireEvent.click(screen.getByTestId("inv-filter-chip-storage"));
    expect(listed()[0]).toContain("备份");
    fireEvent.click(screen.getByTestId("inv-filter-chip-all"));
    expect(listed()).toHaveLength(7);
  });

  it("a card's own button filters to that category, and the playback copies belong with video", () => {
    pane();
    fireEvent.click(screen.getByTestId("inv-filter-recording"));
    expect(listed()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("inv-filter-playCopy"));
    expect(screen.getByTestId("inv-filter-chip-video").getAttribute("aria-pressed")).toBe("true");
    expect(listed()).toHaveLength(1);
    expect(listed()[0]).toContain("动漫一");
  });

  it("opens the shelf of a category, and reveals a category's location or a recording's file", () => {
    const calls = pane();
    fireEvent.click(screen.getByTestId("inv-open-comic"));
    expect(calls.open).toEqual(["comic"]);
    fireEvent.click(screen.getByTestId("inv-reveal-cover"));
    expect(calls.reveal).toEqual(["category:cover"]);
    fireEvent.click(screen.getByTestId("inv-filter-chip-recording"));
    const first = screen.getByTestId("inventory-list").querySelector("li button") as HTMLButtonElement;
    fireEvent.click(first);
    expect(calls.reveal.at(-1)).toBe("capture:c1");
  });

  it("shows a count of missing files on the category that has them", () => {
    const view = inventory();
    view.items[0] = category("comic", { status: "missing", available: false, missing: 2 });
    pane({ inventory: view as unknown as Record<string, unknown> });
    expect(screen.getByTestId("inv-cat-comic-missing").textContent).toContain("2 项文件缺失");
    expect(screen.getByTestId("inv-cat-comic").getAttribute("data-status")).toBe("missing");
  });

  it("still renders an older overview that has no categories", () => {
    pane({ inventory: { totals: { resource: { count: 1, bytes: 1 } }, items: [{ id: "r", kind: "resource", title: "旧资源", bytes: 1, hosted: true, available: true }] } });
    expect(screen.queryByTestId("inventory-categories")).toBeNull();
    expect(listed()).toHaveLength(1);
  });
});
