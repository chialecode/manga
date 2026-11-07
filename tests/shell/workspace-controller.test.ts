// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { WORKSPACE_TAB_KINDS, WORKSPACE_TAB_LIMIT, type WorkspaceState } from "@manga/contracts";
import { HIDDEN_READERS, MOUNTED_CONTEXTS, WorkspaceController, type WorkspaceEnv } from "../../apps/desktop/src/renderer/workspace/controller.ts";
import { TabIcon } from "../../apps/desktop/src/renderer/workspace/tab-icon.tsx";
import { behindIntent, installIntent, resetIntent } from "../../apps/desktop/src/renderer/workspace/intent.ts";
import { tabMarks } from "../../apps/desktop/src/renderer/workspace/marks.ts";

/**
 * The tabs of every context as the controller keeps them (A-94, A-95, AT-110–AT-113), without a dock: opening, the same thing opening once, closing and
 * reopening, a tab's own history, what is saved and when, what a context that has nothing yet opens with, the readers kept loaded out of sight, and the
 * picture of each kind of tab.
 * The dock itself (the panels, the columns) is covered in the walks of the window and in the UI tests that mount the workspace.
 */
type Saved = { contextId: string | null; state: WorkspaceState };

const setup = (stored: Record<string, WorkspaceState> = {}, seed?: WorkspaceEnv["seed"]) => {
  const saved: Saved[] = [];
  const loads: Array<string | null> = [];
  const limits = vi.fn();
  const errors = vi.fn();
  const env: WorkspaceEnv = {
    call: async (commandId, input) => {
      const { contextId } = input as { contextId: string | null; state?: WorkspaceState };
      if (commandId === "workspace.loadContext") {
        loads.push(contextId);
        if (contextId === "prj_gone") return { ok: false, error: { message: "project does not exist" } };
        const state = stored[contextId ?? ""];
        return { ok: true, value: state ? { state } : {} };
      }
      saved.push({ contextId, state: (input as { state: WorkspaceState }).state });
      return { ok: true, value: {} };
    },
    titleFor: ({ kind, target }) => `${kind}:${String(target?.resourceId ?? target?.page ?? "")}`,
    seed,
    onLimit: limits,
    onError: errors,
  };
  return { controller: new WorkspaceController(env), saved, loads, limits, errors, env };
};

describe("opening and closing tabs (AT-110, AT-112)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); tabMarks.reset(); });

  it("opens a tab in the context on screen, and switches to the tab that already shows the same thing instead of opening another", async () => {
    const { controller } = setup();
    await controller.activate(null);
    const first = controller.open({ kind: "reader", target: { resourceId: "res_1" } })!;
    const second = controller.open({ kind: "reader", target: { resourceId: "res_2" } })!;
    expect(controller.focusedTabId()).toBe(second);
    expect(controller.open({ kind: "reader", target: { resourceId: "res_1" } })).toBe(first);
    expect(controller.focusedTabId()).toBe(first);
    expect(controller.tabsOf()).toHaveLength(2);
    // "Open in a new tab" is the one way to have the same thing twice, and a library page is never the same as another.
    const again = controller.open({ kind: "reader", target: { resourceId: "res_1" }, mode: "new" })!;
    expect(again).not.toBe(first);
    expect(controller.tabsOf()).toHaveLength(3);
    controller.open({ kind: "library", target: { page: "overview" } });
    controller.open({ kind: "library", target: { page: "overview" } });
    expect(controller.tabsOf().filter((tab) => tab.kind === "library")).toHaveLength(2);
  });

  it("opens a tab behind the one in front without taking the focus, unless there was no focus", async () => {
    const { controller } = setup();
    await controller.activate(null);
    const first = controller.open({ kind: "reader", target: { resourceId: "res_1" }, background: true })!;
    expect(controller.focusedTabId()).toBe(first);
    controller.open({ kind: "reader", target: { resourceId: "res_2" }, background: true });
    expect(controller.focusedTabId()).toBe(first);
    expect(controller.tabsOf()).toHaveLength(2);
    // Opening what is already open behind the front tab does not bring it forward either.
    controller.open({ kind: "reader", target: { resourceId: "res_2" }, background: true });
    expect(controller.focusedTabId()).toBe(first);
  });

  it("asks the tab's content to do something once more when the same thing is opened with a launch, and hands the request over only once", async () => {
    const { controller } = setup();
    await controller.activate(null);
    const id = controller.open({ kind: "reader", target: { resourceId: "res_1" } })!;
    controller.open({ kind: "reader", target: { resourceId: "res_1" }, launch: { jump: 12 } });
    const key = controller.activeKey;
    expect(controller.launchOf(key, id)).toMatchObject({ jump: 12 });
    expect(controller.takeLaunch(key, id)).toMatchObject({ jump: 12 });
    expect(controller.takeLaunch(key, id)).toBeUndefined();
  });

  it(`keeps no more than ${WORKSPACE_TAB_LIMIT} tabs of a context and says so`, async () => {
    const { controller, limits } = setup();
    await controller.activate(null);
    for (let n = 0; n < WORKSPACE_TAB_LIMIT; n += 1) expect(controller.open({ kind: "reader", target: { resourceId: `res_${n}` } })).not.toBeNull();
    expect(controller.open({ kind: "reader", target: { resourceId: "one-too-many" } })).toBeNull();
    expect(limits).toHaveBeenCalledTimes(1);
    expect(controller.tabsOf()).toHaveLength(WORKSPACE_TAB_LIMIT);
    // Opening what is already open is not another tab.
    expect(controller.open({ kind: "reader", target: { resourceId: "res_3" } })).not.toBeNull();
  });

  it("closes a tab, focuses the last that is left, and brings the closed ones back last-closed first", async () => {
    const { controller } = setup();
    await controller.activate(null);
    const a = controller.open({ kind: "reader", target: { resourceId: "a" } })!;
    const b = controller.open({ kind: "reader", target: { resourceId: "b" } })!;
    const c = controller.open({ kind: "reader", target: { resourceId: "c" } })!;
    controller.closeTab(c);
    expect(controller.focusedTabId()).toBe(b);
    controller.closeFocused();
    expect(controller.focusedTabId()).toBe(a);
    expect(controller.closedCount()).toBe(2);
    expect(controller.reopen()).toBe(b);
    expect(controller.focusedTabId()).toBe(b);
    expect(controller.reopen()).toBe(c);
    expect(controller.reopen()).toBeNull();
    expect(controller.tabsOf().map((tab) => tab.id)).toEqual([a, b, c]);
  });

  it("closes the last tab and leaves a context with none", async () => {
    const { controller } = setup();
    await controller.activate(null);
    const only = controller.open({ kind: "reader", target: { resourceId: "a" } })!;
    controller.closeTab(only);
    expect(controller.tabsOf()).toEqual([]);
    expect(controller.focusedTabId()).toBeNull();
    expect(controller.focusedTab()).toBeUndefined();
    expect(controller.reopen()).toBe(only);
  });

  it("closes the tabs of something that is gone, without keeping them for 'reopen'", async () => {
    const { controller } = setup();
    await controller.activate(null);
    controller.open({ kind: "reader", target: { resourceId: "a" } });
    controller.open({ kind: "conversation", target: { sessionId: "ses_1" } });
    const done = controller.closeMatching((tab) => tab.kind === "conversation" && tab.target.sessionId === "ses_1");
    expect(done.map((tab) => tab.kind)).toEqual(["conversation"]);
    expect(controller.tabsOf().map((tab) => tab.kind)).toEqual(["reader"]);
    expect(controller.closedCount()).toBe(0);
  });

  it("walks back and forward inside one tab without touching the others, and says whether it can", async () => {
    const { controller } = setup();
    await controller.activate(null);
    const id = controller.open({ kind: "library", target: { page: "overview" }, title: "资源库" })!;
    const other = controller.open({ kind: "reader", target: { resourceId: "a" }, title: "甲" })!;
    controller.focusTab(id);
    expect(controller.canBack()).toBe(false);
    controller.navigate(id, { page: "shelf", kind: "comic" }, "漫画");
    controller.navigate(id, { page: "work", workId: "wc" }, "合成漫画");
    expect(controller.canBack()).toBe(true);
    expect(controller.canForward()).toBe(false);
    expect(controller.back()).toBe(true);
    expect(controller.focusedTab()!.title).toBe("漫画");
    expect(controller.canForward()).toBe(true);
    expect(controller.forward()).toBe(true);
    expect(controller.focusedTab()!.title).toBe("合成漫画");
    expect(controller.forward()).toBe(false);
    expect(controller.tab(controller.activeKey, other)!.title).toBe("甲");
    expect(controller.tab(controller.activeKey, other)!.history).toMatchObject({ index: 0 });
  });

  it("names a tab by what it shows once the content knows, and records facts that were not known when it opened without a new place", async () => {
    const { controller } = setup();
    await controller.activate(null);
    const id = controller.open({ kind: "reader", target: { resourceId: "a" } })!;
    controller.retitle(id, "合成小说");
    controller.retarget(id, { workId: "w1", mediaKind: "novel" });
    const tab = controller.tab(controller.activeKey, id)!;
    expect(tab.title).toBe("合成小说");
    expect(tab.target).toMatchObject({ resourceId: "a", workId: "w1", mediaKind: "novel" });
    expect(tab.history!.entries).toHaveLength(1);
    const version = controller.version();
    controller.retarget(id, { workId: "w1" });
    expect(controller.version()).toBe(version);
  });

  it("tells the listeners of every change, and nobody after they unsubscribe", async () => {
    const { controller } = setup();
    const listener = vi.fn();
    const off = controller.subscribe(listener);
    await controller.activate(null);
    const before = listener.mock.calls.length;
    controller.open({ kind: "reader", target: { resourceId: "a" } });
    expect(listener.mock.calls.length).toBeGreaterThan(before);
    off();
    const after = listener.mock.calls.length;
    controller.open({ kind: "reader", target: { resourceId: "b" } });
    expect(listener.mock.calls.length).toBe(after);
  });

  it("gives every kind of tab this version opens a picture of its own, and the question mark only to a kind it does not open", () => {
    const picture = (kind: string, mediaKind?: string) => {
      const { container, unmount } = render(createElement(TabIcon, { kind, mediaKind }));
      const markup = container.innerHTML;
      unmount();
      return markup;
    };
    const unknown = picture("kind-of-a-newer-version");
    const pictures = WORKSPACE_TAB_KINDS.map((kind) => picture(kind));
    for (const markup of pictures) expect(markup).not.toBe(unknown);
    expect(new Set(pictures).size).toBe(WORKSPACE_TAB_KINDS.length);
    // A reader's picture is its medium's.
    expect(new Set([picture("reader", "novel"), picture("reader", "comic"), picture("reader", "video")]).size).toBe(3);
  });
});

describe("what is saved, and when (AT-111, AT-113)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("saves the arrangement a moment after the last change, as one save for a run of changes", async () => {
    const { controller, saved } = setup();
    await controller.activate("prj_1");
    controller.open({ kind: "reader", target: { resourceId: "a" } });
    controller.open({ kind: "reader", target: { resourceId: "b" } });
    expect(saved).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.contextId).toBe("prj_1");
    expect(saved[0]!.state.tabs.map((tab) => tab.target.resourceId)).toEqual(["a", "b"]);
    expect(saved[0]!.state.focusedTab).toBe(saved[0]!.state.tabs[1]!.id);
    expect(saved[0]!.state.version).toBe(1);
  });

  it("saves a tab's position in what it shows with the layout, and not when nothing changed", async () => {
    const { controller, saved } = setup();
    await controller.activate(null);
    const id = controller.open({ kind: "reader", target: { resourceId: "a" } })!;
    await vi.advanceTimersByTimeAsync(600);
    const count = saved.length;
    controller.setView(id, { zoom: 1.5 });
    controller.setView(id, { zoom: 1.5 });
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveLength(count + 1);
    expect(saved.at(-1)!.state.tabs[0]!.view).toEqual({ zoom: 1.5 });
  });

  it("saves at once on flush, and saves of one context go one after the other", async () => {
    const { controller, saved } = setup();
    await controller.activate(null);
    controller.open({ kind: "reader", target: { resourceId: "a" } });
    const first = controller.flush(controller["current"]());
    controller.open({ kind: "reader", target: { resourceId: "b" } });
    const second = controller.flush(controller["current"]());
    await Promise.all([first, second]);
    expect(saved.map((item) => item.state.tabs.length)).toEqual([1, 2]);
    // A flush with nothing waiting writes the state as it is; the timer of a change already flushed does not write it again later.
    const count = saved.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(saved).toHaveLength(count);
  });

  it("reports a save the host refused, and goes on", async () => {
    const { controller, env, errors } = setup();
    const call = env.call;
    env.call = async (commandId, input) => (commandId === "workspace.saveContext" ? { ok: false, error: { message: "disk full" } } : call(commandId, input));
    await controller.activate(null);
    controller.open({ kind: "reader", target: { resourceId: "a" } });
    await controller.flushAll();
    expect(errors).toHaveBeenCalledWith("disk full");
    expect(controller.open({ kind: "reader", target: { resourceId: "b" } })).not.toBeNull();
  });

  it("puts back what was saved, the focus included, and writes back the fields of a newer version unchanged", async () => {
    const stored: WorkspaceState = {
      version: 1, preset: "single", layout: null, focusedTab: "t2", closed: [],
      tabs: [
        { id: "t1", kind: "reader", target: { resourceId: "a" }, title: "甲", view: {}, history: { entries: [{ target: { resourceId: "a" }, title: "甲" }], index: 0 } },
        { id: "t2", kind: "note", target: { objectId: "n" }, title: "笔记", view: { scroll: 3 }, history: { entries: [{ target: { objectId: "n" }, title: "笔记" }], index: 0 } },
      ],
      ...({ fromTheFuture: { keep: true } } as object),
    };
    const { controller, saved } = setup({ prj_1: stored });
    await controller.activate("prj_1");
    expect(controller.tabsOf().map((tab) => tab.id)).toEqual(["t1", "t2"]);
    expect(controller.focusedTabId()).toBe("t2");
    expect(controller.tab(controller.activeKey, "t2")!.view).toEqual({ scroll: 3 });
    await controller.flushAll();
    expect(saved.at(-1)!.state).toMatchObject({ fromTheFuture: { keep: true }, focusedTab: "t2" });
  });

  it("focuses the first tab when the saved focus names a tab that is not there", async () => {
    const stored = {
      version: 1, preset: "single", layout: null, focusedTab: "missing", closed: [],
      tabs: [{ id: "t1", kind: "reader", target: { resourceId: "a" }, title: "甲", view: {}, history: { entries: [{ target: { resourceId: "a" }, title: "甲" }], index: 0 } }],
    } as WorkspaceState;
    const { controller } = setup({ "": stored });
    await controller.activate(null);
    expect(controller.focusedTabId()).toBe("t1");
  });
});

describe("a context that has nothing yet, and one that is gone (AT-111)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("opens a context with no saved tabs with the tabs the application seeds, and only once", async () => {
    const seed = vi.fn(() => [{ kind: "library", target: { page: "overview" }, title: "资源库" }]);
    const { controller, loads } = setup({}, seed);
    await controller.activate(null);
    expect(controller.tabsOf().map((tab) => tab.title)).toEqual(["资源库"]);
    expect(controller.focusedTab()!.kind).toBe("library");
    await controller.activate("prj_1");
    await controller.activate(null);
    expect(seed).toHaveBeenCalledTimes(2);
    expect(loads).toEqual([null, "prj_1"]);
  });

  it("does not seed a context that was saved with its tabs", async () => {
    const seed = vi.fn(() => [{ kind: "library", target: {}, title: "资源库" }]);
    const stored = {
      version: 1, preset: "single", layout: null, focusedTab: "t1", closed: [],
      tabs: [{ id: "t1", kind: "settings", target: {}, title: "设置", view: {}, history: { entries: [{ target: {}, title: "设置" }], index: 0 } }],
    } as WorkspaceState;
    const { controller } = setup({ prj_1: stored }, seed);
    await controller.activate("prj_1");
    expect(controller.tabsOf().map((tab) => tab.kind)).toEqual(["settings"]);
    expect(seed).not.toHaveBeenCalled();
  });

  it("does not make a project that does not exist the context, and changes nothing", async () => {
    const { controller } = setup();
    await controller.activate(null);
    controller.open({ kind: "reader", target: { resourceId: "a" } });
    expect(await controller.activate("prj_gone")).toBe(false);
    expect(controller.activeContextId).toBeNull();
    expect(controller.tabsOf()).toHaveLength(1);
    expect(controller.mountedContexts.map((item) => item.contextId)).toEqual([null]);
  });

  it("forgets the arrangement of a project that was deleted", async () => {
    const { controller } = setup();
    await controller.activate("prj_1");
    controller.open({ kind: "reader", target: { resourceId: "a" } });
    await controller.activate(null);
    controller.forget("prj_1");
    expect(controller.mountedContexts.map((item) => item.contextId)).toEqual([null]);
    expect(controller.tabsOf("prj_1")).toEqual([]);
  });

  it("keeps what was asked to open before any context was on screen, and opens it once there is one", async () => {
    const { controller } = setup();
    expect(controller.open({ kind: "reader", target: { resourceId: "early" } })).toBeNull();
    expect(controller.tabsOf()).toEqual([]);
    await controller.activate(null);
    expect(controller.tabsOf().map((tab) => tab.target.resourceId)).toEqual(["early"]);
  });

  it(`keeps the last ${MOUNTED_CONTEXTS} contexts on screen, saving and letting go of the readers of the one pushed out`, async () => {
    const { controller, saved } = setup();
    await controller.activate(null);
    const first = controller.open({ kind: "reader", target: { resourceId: "a" } })!;
    controller.setVisible(controller.activeKey, first, true);
    for (const id of ["prj_1", "prj_2", "prj_3"]) await controller.activate(id);
    expect(controller.mountedContexts.map((item) => item.contextId)).toEqual(["prj_3", "prj_2", "prj_1"]);
    expect(controller.isMounted("", first)).toBe(false);
    expect(saved.some((item) => item.contextId === null && item.state.tabs.length === 1)).toBe(true);
    // Coming back to it brings its tabs back from the model, not from the host.
    await controller.activate(null);
    expect(controller.tabsOf().map((tab) => tab.id)).toEqual([first]);
  });
});

describe("the readers kept loaded out of sight (A-95, AT-113)", () => {
  afterEach(() => { tabMarks.reset(); });

  it(`lets a reader out of sight stay loaded only among the last ${HIDDEN_READERS} used, and never lets go of the one in front`, async () => {
    const { controller } = setup();
    await controller.activate(null);
    const key = controller.activeKey;
    const ids = ["a", "b", "c", "d"].map((resourceId) => controller.open({ kind: "reader", target: { resourceId } })!);
    for (const id of ids) controller.setVisible(key, id, true);
    expect(controller.loadedReaders()).toBe(4);
    // Each goes out of sight in turn: a, then b, then c.
    controller.setVisible(key, ids[0]!, false);
    controller.setVisible(key, ids[1]!, false);
    expect(controller.loadedReaders()).toBe(4);
    controller.setVisible(key, ids[2]!, false);
    expect(controller.loadedReaders()).toBe(3);
    expect(controller.isMounted(key, ids[0]!)).toBe(false);
    expect(controller.isMounted(key, ids[1]!)).toBe(true);
    expect(controller.isMounted(key, ids[3]!)).toBe(true);
    // Coming back to the one let go loads it again.
    controller.setVisible(key, ids[0]!, true);
    expect(controller.isMounted(key, ids[0]!)).toBe(true);
  });

  it("does not let go of a tab that is not a reader", async () => {
    const { controller } = setup();
    await controller.activate(null);
    const key = controller.activeKey;
    const page = controller.open({ kind: "settings" })!;
    controller.setVisible(key, page, true);
    controller.setVisible(key, page, false);
    expect(controller.isMounted(key, page)).toBe(true);
    expect(controller.loadedReaders()).toBe(0);
  });
});

describe("what a tab shows besides its name (A-95)", () => {
  afterEach(() => { tabMarks.reset(); });

  it("holds a mark per kind, tells the listeners only when it changes, and drops the marks of a tab that is closed", async () => {
    const listener = vi.fn();
    tabMarks.subscribe(listener);
    tabMarks.set("t1", "playing", true);
    tabMarks.set("t1", "playing", true);
    tabMarks.set("t1", "running", true);
    expect(tabMarks.get("t1")).toEqual(["playing", "running"]);
    expect(listener).toHaveBeenCalledTimes(2);
    tabMarks.set("t1", "playing", false);
    expect(tabMarks.get("t1")).toEqual(["running"]);
    tabMarks.set("t1", "recording", false);
    expect(listener).toHaveBeenCalledTimes(3);
    tabMarks.clear("t1");
    expect(tabMarks.get("t1")).toEqual([]);
    tabMarks.clear("t1");
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("forgets the marks of a tab closed through the controller", async () => {
    const { controller } = setup();
    await controller.activate(null);
    const id = controller.open({ kind: "reader", target: { resourceId: "a" } })!;
    tabMarks.set(id, "playing", true);
    controller.closeTab(id);
    expect(controller.tabsOf()).toEqual([]);
    expect(tabMarks.get(id)).toEqual([]);
  });
});

describe("how a thing was asked for (A-95)", () => {
  let off: () => void;
  beforeEach(() => { resetIntent(); off = installIntent(window); });
  afterEach(() => { off(); resetIntent(); document.body.innerHTML = ""; });

  it("reads a Ctrl click or a ⌘ click as 'behind', and a plain click as not", () => {
    const button = document.createElement("button");
    document.body.append(button);
    expect(behindIntent()).toBe(false);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(behindIntent()).toBe(true);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(behindIntent()).toBe(false);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    expect(behindIntent()).toBe(true);
  });

  it("lets the ask go stale after a moment", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(behindIntent(Date.now() + 5000)).toBe(false);
  });

  it("turns the middle button on anything that opens something into a Ctrl click on it, and ignores everything else", () => {
    const card = document.createElement("div");
    card.dataset.opens = "reader";
    const inner = document.createElement("span");
    card.append(inner);
    const plain = document.createElement("div");
    document.body.append(card, plain);
    const clicks: boolean[] = [];
    card.addEventListener("click", (event) => clicks.push((event as MouseEvent).ctrlKey));
    inner.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(clicks).toEqual([true]);
    expect(behindIntent()).toBe(true);
    resetIntent();
    plain.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    inner.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
    expect(clicks).toEqual([true]);
    expect(behindIntent()).toBe(false);
  });

  it("keeps the browser from scrolling by drag on a middle press over something that opens", () => {
    const card = document.createElement("div");
    card.dataset.opens = "reader";
    document.body.append(card);
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
    card.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    const left = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    card.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
  });
});
