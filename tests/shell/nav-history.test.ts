import { describe, expect, it } from "vitest";
import { NAV_LIMIT, canBack, canForward, emptyHistory, locationKey, step, visit, type NavLocation } from "../../apps/desktop/src/renderer/lib/nav-history.ts";

const page = (name: string): NavLocation => ({ kind: "page", page: name });
const work = (workId: string): NavLocation => ({ kind: "work", workId });
const resource = (resourceId: string, workId: string | null = null): NavLocation => ({ kind: "resource", resourceId, mediaKind: "comic", workId });

describe("AT-81 page history: what the title bar's back and forward walk through", () => {
  it("starts empty, and has nowhere to go until a second place is visited", () => {
    let history = emptyHistory();
    expect(canBack(history)).toBe(false);
    expect(canForward(history)).toBe(false);
    expect(step(history, -1)).toBeNull();
    history = visit(history, page("library"));
    expect(history.entries).toHaveLength(1);
    expect(canBack(history)).toBe(false);
    history = visit(history, work("w1"));
    expect(canBack(history)).toBe(true);
    expect(canForward(history)).toBe(false);
  });

  it("goes back and forward along the places visited, and a new place drops what was ahead", () => {
    let history = emptyHistory();
    for (const place of [page("library"), work("w1"), resource("r1", "w1")]) history = visit(history, place);
    const back = step(history, -1)!;
    expect(back.to).toEqual(work("w1"));
    expect(canForward(back.history)).toBe(true);
    const again = step(back.history, -1)!;
    expect(again.to).toEqual(page("library"));
    expect(step(again.history, -1)).toBeNull();
    // Forward returns to where it came from.
    const forward = step(again.history, 1)!;
    expect(forward.to).toEqual(work("w1"));
    // Visiting somewhere new from the middle drops the places that were ahead.
    const branched = visit(back.history, page("notes"));
    expect(branched.entries.map(locationKey)).toEqual(["page:library", "work:w1", "page:notes"]);
    expect(canForward(branched)).toBe(false);
  });

  it("does not repeat the same place, and takes the fresher description of it", () => {
    let history = visit(emptyHistory(), page("library"));
    history = visit(history, resource("r1", null));
    // The resource's work became known: same place, newer facts, no new entry.
    history = visit(history, resource("r1", "w1"));
    expect(history.entries).toHaveLength(2);
    expect(history.entries[1]).toEqual(resource("r1", "w1"));
    // A settings page and a project tab are one place each.
    history = visit(history, { kind: "project", projectId: "p1", tab: "materials" });
    history = visit(history, { kind: "project", projectId: "p1", tab: "draft" });
    expect(history.entries).toHaveLength(3);
    expect(history.entries[2]).toEqual({ kind: "project", projectId: "p1", tab: "draft" });
    history = visit(history, { kind: "settings", page: "library" });
    history = visit(history, { kind: "settings", page: "models" });
    expect(history.entries).toHaveLength(5);
  });

  it("keeps the latest places when it grows past its limit", () => {
    let history = emptyHistory();
    for (let n = 0; n < NAV_LIMIT + 25; n += 1) history = visit(history, work(`w${n}`));
    expect(history.entries).toHaveLength(NAV_LIMIT);
    expect(history.index).toBe(NAV_LIMIT - 1);
    expect(history.entries[NAV_LIMIT - 1]).toEqual(work(`w${NAV_LIMIT + 24}`));
    expect(history.entries[0]).toEqual(work("w25"));
  });
});
