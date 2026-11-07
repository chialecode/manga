import { describe, expect, it } from "vitest";
import {
  CARD_OPEN_MS, CARD_SWAP_MS, RAIL_SLOT, TOP_ROW_HEIGHT, cardOf, initialHover, railLayout, reduceHover, viewOfCard,
} from "../../packages/app-core/src/domain/shell-layout.ts";

const VIEWS = ["home", "conversation", "novel", "comic", "video", "note", "whiteboard", "mindmap", "draft", "roughcut", "downloads"];
/** A window tall enough for `slots` icons, with the settings' slot taken. */
const heightFor = (slots: number) => TOP_ROW_HEIGHT + 12 + RAIL_SLOT + slots * RAIL_SLOT;

describe("AT-120 which icons the rail shows for a window's height", () => {
  it("shows every view in a tall window and has no \"…\" when nothing is out", () => {
    const layout = railLayout({ height: 1200, views: VIEWS, hidden: [], settings: true });
    expect(layout.shown).toEqual(VIEWS);
    expect(layout.more).toEqual([]);
  });

  it("puts the ones the person took out behind \"…\" in the rail's order, and never the home", () => {
    const layout = railLayout({ height: 1200, views: VIEWS, hidden: ["comic", "home", "downloads"], settings: true });
    expect(layout.shown).toEqual(VIEWS.filter((view) => view !== "comic" && view !== "downloads"));
    expect(layout.more).toEqual([{ view: "comic", why: "hidden" }, { view: "downloads", why: "hidden" }]);
    expect(layout.shown[0]).toBe("home");
  });

  it("moves the icons that do not fit behind \"…\", last ones first, and the \"…\" takes the slot of the one it replaces", () => {
    const fits = railLayout({ height: heightFor(VIEWS.length), views: VIEWS, hidden: [], settings: true });
    expect(fits.shown).toEqual(VIEWS);
    expect(fits.more).toEqual([]);
    // One slot short: the last icon goes, and "…" takes the slot of the one before it as well.
    const short = railLayout({ height: heightFor(VIEWS.length - 1), views: VIEWS, hidden: [], settings: true });
    expect(short.shown).toEqual(VIEWS.slice(0, VIEWS.length - 2));
    expect(short.more.map((item) => item.view)).toEqual(VIEWS.slice(-2));
    expect(short.more.every((item) => item.why === "space")).toBe(true);
    // Very short: the home alone keeps its place, the rest are listed.
    const tiny = railLayout({ height: 10, views: VIEWS, hidden: [], settings: true });
    expect(tiny.shown).toEqual(["home"]);
    expect(tiny.more.map((item) => item.view)).toEqual(VIEWS.slice(1));
  });

  it("marks what is behind \"…\" by why it is there, and gives the settings their slot first", () => {
    const withSettings = railLayout({ height: heightFor(5), views: VIEWS, hidden: ["video"], settings: true });
    const without = railLayout({ height: heightFor(5), views: VIEWS, hidden: ["video"], settings: false });
    expect(without.shown.length).toBe(withSettings.shown.length + 1);
    expect(withSettings.more.find((item) => item.view === "video")?.why).toBe("hidden");
    expect(withSettings.more.filter((item) => item.why === "space").length).toBeGreaterThan(0);
    // A taller window gives the icons back at once: the answer is a function of the height alone.
    expect(railLayout({ height: heightFor(5) + RAIL_SLOT, views: VIEWS, hidden: ["video"], settings: true }).shown.length).toBe(withSettings.shown.length + 1);
  });

  it("lays out only the views it is given: a window without a module has no icon for it", () => {
    const layout = railLayout({ height: 1200, views: ["home", "comic", "video"], hidden: ["note"], settings: true });
    expect(layout.shown).toEqual(["home", "comic", "video"]);
    expect(layout.more).toEqual([]);
    // A view kept as hidden while its module is off does not take a slot for "…" either: a window just tall enough shows every icon it has.
    const views = VIEWS.filter((view) => view !== "downloads");
    const exact = railLayout({ height: heightFor(views.length), views, hidden: ["downloads"], settings: true });
    expect(exact.shown).toEqual(views);
    expect(exact.more).toEqual([]);
  });
});

describe("AT-120 the card that comes out of an icon", () => {
  const enter = (view: string, now: number, state = initialHover(), openMs?: number) => reduceHover(state, { type: "enter", view, now }, 180, openMs);

  it("comes out only after the pointer stays, and not for one that passes", () => {
    const entered = enter("comic", 0);
    expect(entered.overlay).toBeNull();
    expect(entered.pending).toBe(cardOf("comic"));
    expect(reduceHover(entered, { type: "tick", now: CARD_OPEN_MS - 1 }, 180).overlay).toBeNull();
    const out = reduceHover(entered, { type: "tick", now: CARD_OPEN_MS }, 180);
    expect(out.overlay).toBe("card:comic");
    expect(viewOfCard(out.overlay)).toBe("comic");
    // A pointer that left before the wait was over shows nothing, and the card never comes.
    const passed = reduceHover(entered, { type: "leave", view: "comic", now: 40 }, 180);
    expect(passed.pending).toBeNull();
    expect(reduceHover(passed, { type: "tick", now: 400 }, 180).overlay).toBeNull();
  });

  it("opens at once for the sidebar's own switch (a wait of 0)", () => {
    expect(enter("home", 0, initialHover(), 0).overlay).toBe("card:home");
  });

  it("goes after a short wait once the pointer has left, and stays when the pointer comes back to the icon or onto the card", () => {
    const out = reduceHover(enter("comic", 0), { type: "tick", now: 200 }, 180);
    const left = reduceHover(out, { type: "leave", view: "comic", now: 300 }, 180);
    expect(left.overlay).toBe("card:comic");
    expect(reduceHover(left, { type: "tick", now: 450 }, 180).overlay).toBe("card:comic");
    expect(reduceHover(left, { type: "tick", now: 480 }, 180).overlay).toBeNull();
    // Onto the card (the same view's enter) before the wait is over cancels it, however long it then rests there.
    const back = reduceHover(left, { type: "enter", view: "comic", now: 400 }, 180);
    expect(back.closeAt).toBeNull();
    expect(reduceHover(back, { type: "tick", now: 5000 }, 180).overlay).toBe("card:comic");
  });

  it("changes to the card of another icon sooner than it came, and never has two", () => {
    const out = reduceHover(enter("comic", 0), { type: "tick", now: 200 }, 180);
    const moving = reduceHover(reduceHover(out, { type: "leave", view: "comic", now: 300 }, 180), { type: "enter", view: "video", now: 310 }, 180);
    expect(moving.overlay).toBe("card:comic");
    expect(moving.pending).toBe("card:video");
    expect(moving.openAt).toBe(310 + CARD_SWAP_MS);
    expect(CARD_SWAP_MS).toBeLessThan(CARD_OPEN_MS);
    const swapped = reduceHover(moving, { type: "tick", now: 310 + CARD_SWAP_MS }, 180);
    expect(swapped.overlay).toBe("card:video");
    expect(swapped.pending).toBeNull();
  });

  it("is held by a pin (the key or the sidebar's switch) against the pointer leaving, and a second pin or Esc lets it go", () => {
    const pinned = reduceHover(initialHover(), { type: "pin", view: "note", now: 0 }, 180);
    expect(pinned.overlay).toBe("card:note");
    expect(pinned.pinned).toBe("card:note");
    const left = reduceHover(pinned, { type: "leave", view: "note", now: 10 }, 180);
    expect(reduceHover(left, { type: "tick", now: 9999 }, 180).overlay).toBe("card:note");
    // The pointer over another icon does not take a pinned card away.
    expect(reduceHover(pinned, { type: "enter", view: "video", now: 20 }, 180).overlay).toBe("card:note");
    expect(reduceHover(pinned, { type: "pin", view: "note", now: 30 }, 180).overlay).toBeNull();
    expect(reduceHover(pinned, { type: "escape", now: 30 }, 180)).toEqual(initialHover());
  });
});
