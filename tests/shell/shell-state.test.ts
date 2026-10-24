import { describe, expect, it, vi } from "vitest";
import { ShellState } from "../../apps/desktop/src/renderer/shell-state.ts";
import type { SettingsPageId } from "../../apps/desktop/src/renderer/lib/shell-model.ts";

function make(options: { last?: SettingsPageId | null; view?: string | null } = {}) {
  const calls = { settings: [] as boolean[], pages: [] as SettingsPageId[] };
  const store = new ShellState({
    lastPage: () => options.last ?? null,
    onSettings: (on) => { calls.settings.push(on); },
    railView: () => options.view ?? null,
    onPage: (page) => { calls.pages.push(page); },
  });
  return { store, calls, snap: () => store.getSnapshot() };
}

describe("AT-122 the settings view is a state of the window", () => {
  it("comes up on the page named, else the one used last, else the first, and tells the workspace it is out of sight once", () => {
    const named = make({ last: "storage" });
    named.store.enterSettings("models");
    expect(named.snap().settings).toMatchObject({ on: true, page: "models", trail: ["models"], index: 0 });
    expect(named.calls).toEqual({ settings: [true], pages: ["models"] });
    // Already up: another way in goes to that page rather than starting over.
    named.store.enterSettings("logs");
    expect(named.snap().settings).toMatchObject({ page: "logs", trail: ["models", "logs"], index: 1 });
    expect(named.calls.settings).toEqual([true]);

    const last = make({ last: "storage" });
    last.store.enterSettings();
    expect(last.snap().settings.page).toBe("storage");
    const first = make();
    first.store.enterSettings();
    expect(first.snap().settings.page).toBe("general");
  });

  it("walks the pages that were visited with back and forward, drops what was ahead when a new page is chosen, and does not repeat a page", () => {
    const { store, snap, calls } = make();
    store.enterSettings("general");
    store.goTo("models");
    store.goTo("models");
    store.goTo("logs");
    expect(snap().settings.trail).toEqual(["general", "models", "logs"]);
    store.back();
    expect(snap().settings).toMatchObject({ page: "models", index: 1 });
    expect(store.canForward()).toBe(true);
    store.back();
    store.forward();
    expect(snap().settings.page).toBe("models");
    store.goTo("storage");
    expect(snap().settings.trail).toEqual(["general", "models", "storage"]);
    expect(store.canForward()).toBe(false);
    store.forward();
    expect(snap().settings.page).toBe("storage");
    expect(calls.pages.at(-1)).toBe("storage");
  });

  it("leaves to the workspace from the first page with back, keeps the page it was on for the next time, and does nothing when it is not up", () => {
    const { store, snap, calls } = make();
    store.back();
    store.forward();
    store.leaveSettings();
    expect(calls.settings).toEqual([]);
    store.enterSettings("general");
    store.goTo("agent");
    store.back();
    expect(snap().settings.on).toBe(true);
    expect(snap().settings.page).toBe("general");
    store.back();
    expect(snap().settings.on).toBe(false);
    expect(snap().settings.page).toBe("general");
    expect(calls.settings).toEqual([true, false]);
    // Leaving from a later page by another way keeps that page.
    store.enterSettings("storage");
    expect(snap().settings.trail).toEqual(["storage"]);
    store.goTo("agent");
    store.leaveSettings();
    expect(snap().settings).toMatchObject({ on: false, page: "agent" });
    expect(calls.pages.at(-1)).toBe("agent");
  });

  it("keeps the trail from growing without bound", () => {
    const { store, snap } = make();
    store.enterSettings("general");
    const pages: SettingsPageId[] = ["models", "agent", "logs", "storage", "appearance", "reading"];
    for (let n = 0; n < 40; n += 1) for (const page of pages) store.goTo(page);
    expect(snap().settings.trail.length).toBeLessThanOrEqual(50);
    expect(snap().settings.index).toBe(snap().settings.trail.length - 1);
  });

  it("tells whoever listens, and gives a new snapshot for each change", () => {
    const { store, snap } = make();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    const before = snap();
    store.enterSettings("general");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(snap()).not.toBe(before);
    off();
    store.goTo("logs");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("AT-121 the search box is a state of the window", () => {
  it("opens with the scope of the view on screen, and none from the home or from the settings", () => {
    const comic = make({ view: "comic" });
    comic.store.openSearch();
    expect(comic.snap().search).toMatchObject({ open: true, query: "", scope: "comic" });
    const home = make({ view: "home" });
    home.store.openSearch();
    expect(home.snap().search.scope).toBeNull();
    comic.store.closeSearch();
    comic.store.enterSettings("general");
    comic.store.openSearch();
    expect(comic.snap().search.scope).toBeNull();
    // A scope or a text that is given wins over the view.
    const scoped = make({ view: "comic" });
    scoped.store.openSearch({ query: "合成", scope: "note" });
    expect(scoped.snap().search).toMatchObject({ open: true, query: "合成", scope: "note" });
    scoped.store.closeSearch();
    scoped.store.openSearch({ scope: null });
    expect(scoped.snap().search.scope).toBeNull();
  });

  it("is a new box each time it is opened, and closing it keeps the settings as they are", () => {
    const { store, snap } = make({ view: "video" });
    store.openSearch();
    const first = snap().search.n;
    store.closeSearch();
    expect(snap().search.open).toBe(false);
    store.openSearch();
    expect(snap().search.n).toBeGreaterThan(first);
    store.enterSettings("general");
    expect(snap().search.open).toBe(false);
    expect(snap().settings.on).toBe(true);
    store.closeSearch();
    expect(snap().settings.on).toBe(true);
  });
});
