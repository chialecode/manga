import { describe, expect, it } from "vitest";
import { DEFAULT_SHELL_PREFERENCE } from "@manga/contracts/reading";
import { WORKSPACE_CLOSED_LIMIT, WORKSPACE_HISTORY_LIMIT, type WorkspaceTab } from "@manga/contracts";
import { MAIN_FLOOR, RAIL_WIDTH, SIDE_WIDTH, clampSide, deriveShell, dragLimit } from "../../packages/app-core/src/domain/shell-layout.ts";
import {
  canStep, distribute, findByKey, gridOrder, groupPanels, makeTab, navigateTab, pushClosed, retargetTab, retitleTab, stepTab, tabKey,
} from "../../apps/desktop/src/renderer/workspace/model.ts";
import { MAX_COLUMNS, MIN_COLUMN_WIDTH, dropMakesColumn, presetOfCount } from "../../apps/desktop/src/renderer/workspace/layout.ts";

/**
 * The tabs of a context as plain data (A-94, A-95, AT-110, AT-112, AT-113): what makes two tabs the same, a tab's own history, the closed tabs that
 * "reopen" takes from, how the tabs are dealt over the columns of a layout, and how the side columns fold when the columns of the split need the room.
 */
const tab = (kind: string, target: Record<string, unknown>, title = "标签", id = "t1"): WorkspaceTab => makeTab({ kind, target, title }, id);

describe("what makes two tabs the same tab (AT-112)", () => {
  it("keys a reader by its resource, a note by its object, a project's pages by the project and the object, a conversation by its session", () => {
    expect(tabKey("reader", { resourceId: "res_1" })).toBe("reader:res_1");
    expect(tabKey("note", { objectId: "obj_1" })).toBe("note:obj_1");
    expect(tabKey("project", { projectId: "prj_1" })).toBe("project:prj_1");
    for (const kind of ["whiteboard", "mindmap", "draft", "roughcut"]) expect(tabKey(kind, { projectId: "prj_1", objectId: "o1" })).toBe(`${kind}:prj_1:o1`);
    expect(tabKey("conversation", { sessionId: "ses_1" })).toBe("conversation:ses_1");
    // The management tabs are one of each kind of thing (A-101): the conversations, the notes, the whiteboards …, and the downloads.
    expect(tabKey("records", { type: "conversation" })).toBe("records:conversation");
    expect(tabKey("records", { type: "note" })).toBe("records:note");
    for (const kind of ["whiteboard", "mindmap", "draft", "roughcut"]) expect(tabKey("objects", { kind })).toBe(`objects:${kind}`);
    expect(tabKey("downloads", {})).toBe("downloads");
    // The search, the settings, the plug-ins and the keys are not tabs any more (A-100, A-101): a saved tab of those kinds has no key.
    for (const kind of ["search", "settings", "plugins", "keys"]) expect(tabKey(kind, { page: "x" }), kind).toBeNull();
  });

  it("gives a library tab and a kind this version does not know no key, so there can be several", () => {
    expect(tabKey("library", { page: "overview" })).toBeNull();
    expect(tabKey("from-the-future", { anything: 1 })).toBeNull();
    const tabs = [tab("library", { page: "overview" }, "资源库", "a"), tab("library", { page: "overview" }, "资源库", "b")];
    expect(findByKey(tabs, "library", { page: "overview" })).toBeUndefined();
  });

  it("finds the tab that already shows the same thing, and no other", () => {
    const tabs = [tab("reader", { resourceId: "res_1" }, "甲", "a"), tab("reader", { resourceId: "res_2" }, "乙", "b"), tab("records", { type: "note" }, "笔记管理", "c")];
    expect(findByKey(tabs, "reader", { resourceId: "res_2" })?.id).toBe("b");
    expect(findByKey(tabs, "reader", { resourceId: "res_3" })).toBeUndefined();
    expect(findByKey(tabs, "records", { type: "note" })?.id).toBe("c");
    expect(findByKey(tabs, "records", { type: "conversation" })).toBeUndefined();
    expect(findByKey(tabs, "settings", { page: "models" })).toBeUndefined();
    // The same resource opened with other facts about it is still the same tab.
    expect(findByKey(tabs, "reader", { resourceId: "res_1", mediaKind: "comic" })?.id).toBe("a");
  });

  it("makes a tab with a short name and a history of one place", () => {
    const made = makeTab({ kind: "note", target: { objectId: "n" }, title: "长".repeat(300) }, "fixed");
    expect(made.id).toBe("fixed");
    expect(made.title).toHaveLength(200);
    expect(made.history).toEqual({ entries: [{ target: { objectId: "n" }, title: made.title }], index: 0 });
    expect(makeTab({ kind: "library" }).target).toEqual({});
    expect(makeTab({ kind: "library" }).id).not.toBe(makeTab({ kind: "library" }).id);
  });
});

describe("a tab's own back and forward (AT-110)", () => {
  it("goes to a place, drops the places ahead of the one it was on, and steps back and forward over what is kept", () => {
    let current = tab("library", { page: "overview" }, "资源库");
    expect(canStep(current, -1)).toBe(false);
    expect(canStep(current, 1)).toBe(false);
    current = navigateTab(current, { page: "shelf", kind: "comic" }, "漫画");
    current = navigateTab(current, { page: "work", workId: "wc" }, "合成漫画");
    expect(current.title).toBe("合成漫画");
    expect(current.history).toMatchObject({ index: 2 });
    expect(current.history!.entries.map((entry) => entry.title)).toEqual(["资源库", "漫画", "合成漫画"]);
    expect(canStep(current, -1)).toBe(true);
    expect(canStep(current, 1)).toBe(false);

    const back = stepTab(current, -1)!;
    expect(back.title).toBe("漫画");
    expect(back.target).toEqual({ page: "shelf", kind: "comic" });
    expect(back.view).toEqual({});
    expect(canStep(back, 1)).toBe(true);
    expect(stepTab(back, 1)!.title).toBe("合成漫画");
    expect(stepTab(current, 1)).toBeNull();

    // Going somewhere else from the middle drops what was ahead.
    const branched = navigateTab(back, { page: "shelf", kind: "video" }, "动漫");
    expect(branched.history!.entries.map((entry) => entry.title)).toEqual(["资源库", "漫画", "动漫"]);
    expect(canStep(branched, 1)).toBe(false);
    expect(stepTab(tab("library", {}), -1)).toBeNull();
  });

  it(`keeps no more than ${WORKSPACE_HISTORY_LIMIT} places, the oldest going first`, () => {
    let current = tab("library", { n: 0 }, "0");
    for (let n = 1; n <= WORKSPACE_HISTORY_LIMIT + 9; n++) current = navigateTab(current, { n }, String(n));
    expect(current.history!.entries).toHaveLength(WORKSPACE_HISTORY_LIMIT);
    expect(current.history!.index).toBe(WORKSPACE_HISTORY_LIMIT - 1);
    expect(current.history!.entries[0]!.title).toBe("10");
    expect(current.history!.entries.at(-1)!.title).toBe(String(WORKSPACE_HISTORY_LIMIT + 9));
  });

  it("renames and re-targets the place it is on without making a new one", () => {
    let current = navigateTab(tab("reader", { resourceId: "res_1" }, "加载中"), { resourceId: "res_1", chapter: 2 }, "加载中 2");
    const renamed = retitleTab(current, "合成小说 第 2 章");
    expect(renamed.title).toBe("合成小说 第 2 章");
    expect(renamed.history!.entries.map((entry) => entry.title)).toEqual(["加载中", "合成小说 第 2 章"]);
    expect(retitleTab(renamed, "合成小说 第 2 章")).toBe(renamed);
    current = retargetTab(renamed, { workId: "w1" });
    expect(current.target).toEqual({ resourceId: "res_1", chapter: 2, workId: "w1" });
    expect(current.history!.entries.map((entry) => entry.target)).toEqual([{ resourceId: "res_1" }, { resourceId: "res_1", chapter: 2, workId: "w1" }]);
    expect(current.history!.entries).toHaveLength(2);
  });
});

describe("the tabs that were closed (AT-110)", () => {
  it("puts the last closed first, never twice, and keeps the last ten", () => {
    let closed: WorkspaceTab[] = [];
    for (let n = 0; n < WORKSPACE_CLOSED_LIMIT + 3; n++) closed = pushClosed(closed, tab("note", { objectId: `n${n}` }, `笔记 ${n}`, `id${n}`));
    expect(closed).toHaveLength(WORKSPACE_CLOSED_LIMIT);
    expect(closed[0]!.id).toBe(`id${WORKSPACE_CLOSED_LIMIT + 2}`);
    expect(closed.at(-1)!.id).toBe("id3");
    const again = pushClosed(closed, tab("note", { objectId: "n5" }, "笔记 5", "id5"));
    expect(again[0]!.id).toBe("id5");
    expect(again.filter((item) => item.id === "id5")).toHaveLength(1);
    expect(again).toHaveLength(WORKSPACE_CLOSED_LIMIT);
  });
});

describe("how tabs are dealt over the columns (AT-113)", () => {
  it("fills the first columns with the remainder and leaves the last empty when there are fewer tabs than columns", () => {
    expect(distribute([1, 2, 3, 4], 3)).toEqual([[1, 2], [3], [4]]);
    expect(distribute([1, 2, 3, 4, 5, 6, 7], 4)).toEqual([[1, 2], [3, 4], [5, 6], [7]]);
    expect(distribute([1, 2], 4)).toEqual([[1], [2], [], []]);
    expect(distribute([], 2)).toEqual([[], []]);
    expect(distribute([1, 2, 3], 1)).toEqual([[1, 2, 3]]);
    expect(distribute([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });

  const layout = {
    grid: {
      root: {
        type: "branch",
        data: [
          { type: "branch", data: [{ type: "leaf", data: { id: "g1", views: ["a", "b"] } }, { type: "leaf", data: { id: "g3", views: ["e"] } }] },
          { type: "branch", data: [{ type: "leaf", data: { id: "g2", views: ["c"] } }, { type: "leaf", data: { id: "g4", views: [] } }] },
        ],
      },
    },
  };

  it("reads the columns of a layout in reading order, and each column's tabs", () => {
    expect(gridOrder(layout)).toEqual(["g1", "g3", "g2", "g4"]);
    expect(groupPanels(layout)).toEqual([{ id: "g1", panels: ["a", "b"] }, { id: "g3", panels: ["e"] }, { id: "g2", panels: ["c"] }, { id: "g4", panels: [] }]);
    for (const empty of [null, undefined, {}, { grid: {} }, { grid: { root: null } }, "layout"]) {
      expect(gridOrder(empty)).toEqual([]);
      expect(groupPanels(empty)).toEqual([]);
    }
  });

  it("calls a number of columns by the preset it is, and makes a column only of a drop on an edge or on the side of one", () => {
    expect([1, 2, 3, 4, 5].map(presetOfCount)).toEqual(["single", "two", "three", "quad", "quad"]);
    expect(MAX_COLUMNS).toBe(4);
    expect(dropMakesColumn("edge", undefined)).toBe(true);
    expect(dropMakesColumn("content", "right")).toBe(true);
    expect(dropMakesColumn("content", "bottom")).toBe(true);
    expect(dropMakesColumn("content", "center")).toBe(false);
    expect(dropMakesColumn("content", undefined)).toBe(false);
    expect(dropMakesColumn("tab", "center")).toBe(false);
  });
});

describe("the side columns fold before the columns of the split have to (AT-111)", () => {
  const wide = (width: number) => ({ width, height: 900 });
  const preference = DEFAULT_SHELL_PREFERENCE;

  it("docks both columns when the main area keeps the default floor, and the dock folds first when it does not", () => {
    const roomy = deriveShell({ viewport: wide(1600), preference, hasDock: true, overlay: null });
    expect([roomy.sidebar, roomy.dock]).toEqual(["dock", "dock"]);
    // 1100 - 48 - 260 - 360 = 432 < 560: the dock gives way, the sidebar stays.
    const tight = deriveShell({ viewport: wide(1100), preference, hasDock: true, overlay: null });
    expect([tight.sidebar, tight.dock]).toEqual(["dock", "hidden"]);
    // 800 - 48 - 260 = 492 < 560: neither is docked (each can still be opened over the page).
    const narrow = deriveShell({ viewport: wide(800), preference, hasDock: true, overlay: null });
    expect([narrow.sidebar, narrow.dock]).toEqual(["hidden", "hidden"]);
  });

  it("asks the main area for the room of the columns of a layout, so the side columns fold earlier for several columns", () => {
    const floor = 2 * MIN_COLUMN_WIDTH;
    expect(floor).toBe(640);
    // Both docked at 1500 for one column; for a split the floor is 640 and 1500 - 48 - 260 - 360 = 832 still fits ...
    expect(deriveShell({ viewport: wide(1500), preference, hasDock: true, overlay: null, mainFloor: floor }).dock).toBe("dock");
    // ... but at 1250 it is 582: below 640, so the dock folds although one column would have fitted (582 >= 560).
    expect(deriveShell({ viewport: wide(1250), preference, hasDock: true, overlay: null }).dock).toBe("dock");
    expect(deriveShell({ viewport: wide(1250), preference, hasDock: true, overlay: null, mainFloor: floor }).dock).toBe("hidden");
    expect(deriveShell({ viewport: wide(1250), preference, hasDock: true, overlay: "dock", mainFloor: floor }).dock).toBe("overlay");
    // A floor below the default does not lower it.
    expect(deriveShell({ viewport: wide(1100), preference, hasDock: true, overlay: null, mainFloor: 100 }).dock).toBe("hidden");
  });

  it("limits a drag so the main area keeps its floor, and never below the column's own minimum", () => {
    expect(dragLimit("sidebar", 1600, 360)).toBe(SIDE_WIDTH.sidebar.max);
    expect(dragLimit("sidebar", 1200, 360)).toBe(1200 - RAIL_WIDTH - 360 - MAIN_FLOOR);
    // A split asks for more room, so the sidebar can be dragged less far, but never narrower than its own minimum.
    expect(dragLimit("sidebar", 1300, 360, 640)).toBe(1300 - RAIL_WIDTH - 360 - 640);
    expect(dragLimit("sidebar", 1000, 360, 640)).toBe(SIDE_WIDTH.sidebar.min);
    expect(dragLimit("dock", 700, 260)).toBe(SIDE_WIDTH.dock.min);
    expect(clampSide("sidebar", 50)).toBe(SIDE_WIDTH.sidebar.min);
    expect(clampSide("dock", 9999)).toBe(SIDE_WIDTH.dock.max);
    expect(clampSide("dock", 400.4)).toBe(400);
  });
});
