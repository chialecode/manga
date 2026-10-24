import { describe, expect, it } from "vitest";
import {
  CommandInputs, DEFAULT_RAIL_PREFERENCE, DEFAULT_SHELL_PREFERENCE, HIDEABLE_RAIL_VIEWS, RAIL_VIEWS, RailPatchSchema, RailPreferenceSchema, SIDEBAR_ITEM_TYPES,
  ShellPreferenceSchema, ShellPreferenceV1Schema, itemTypeOfView, shellFromV1, validateCommandInput,
} from "@manga/contracts";
import {
  ContextIdSchema, EMPTY_WORKSPACE_STATE, LEGACY_TAB_KINDS, WORKSPACE_CLOSED_LIMIT, WORKSPACE_STATE_BYTES, WORKSPACE_TAB_KINDS, WORKSPACE_TAB_LIMIT, WorkspaceStateSchema,
  contextFromKey, contextKey, dropLegacyTabs, trimWorkspaceState, type WorkspaceState, type WorkspaceTab,
} from "@manga/contracts/workspace-state";

/**
 * The contracts of the one workspace (A-94, A-96): every command that works in a context names it, the parameters of the two modes are gone, and a
 * saved state of tabs reads back whatever a newer version put in it.
 */
const tab = (id: string, extra: Record<string, unknown> = {}): WorkspaceTab => ({ id, kind: "library", target: { section: "works" }, title: "书库", view: {}, ...extra });
const state = (patch: Partial<WorkspaceState> = {}): WorkspaceState => ({ ...EMPTY_WORKSPACE_STATE, ...patch });

/** One valid input for every command that took a mode before, or takes a context now. */
const VALID: Record<string, Record<string, unknown>> = {
  "workspace.sessions": { contextId: null },
  "workspace.contexts": {},
  "workspace.loadContext": { contextId: "prj_a" },
  "workspace.saveContext": { contextId: null, state: EMPTY_WORKSPACE_STATE },
  "workspace.setLastContext": { contextId: "prj_a" },
  "workspace.sidebar": { view: "home", perGroup: 5, open: ["prj_a", null] },
  "workspace.items": { view: "note", contextId: "prj_a", limit: 20, cursor: "5" },
  "workspace.objects": { kind: "whiteboard", q: "雨", limit: 50, offset: 0 },
  "workspace.find": { q: "雨夜", view: "comic", perType: 4 },
  "conversation.current": { contextId: null },
  "conversation.new": { contextId: "prj_a" },
  "conversation.history": { contextId: null, limit: 20 },
  "conversation.list": { contextId: null, kind: "shared" },
  "conversation.deleteAll": { contextId: "prj_a" },
  "session.open": { kind: "resource", targetId: "r1", contextId: null },
  "progress.setPage": { contextId: null, resourceId: "r1", resourceRevisionId: "v1", pageId: "p1" },
  "progress.setTime": { contextId: "prj_a", resourceId: "r1", resourceRevisionId: "v1", timeMs: 1000 },
  "progress.get": { contextId: null, resourceId: "r1" },
  "library.read": { resourceId: "r1" },
  "agent.createSession": {},
  "project.addMaterial": { projectId: "prj_a", kind: "work", targetId: "w1", origin: "auto" },
};

describe("commands that work in a context", () => {
  it.each(Object.entries(VALID))("accepts a well-formed %s", (commandId, input) => {
    expect(() => validateCommandInput(commandId, input), commandId).not.toThrow();
  });

  it.each(Object.entries(VALID))("rejects an unknown field on %s", (commandId, input) => {
    expect(() => validateCommandInput(commandId, { ...input, surprise: 1 }), commandId).toThrow();
  });

  it.each([
    "workspace.sessions", "workspace.loadContext", "workspace.saveContext", "workspace.setLastContext", "workspace.items",
    "conversation.current", "conversation.new", "conversation.history", "session.open", "progress.setPage", "progress.setTime", "progress.get", "progress.set",
  ])("refuses %s without a context, and with an empty one", (commandId) => {
    const base = commandId === "progress.set"
      ? { resourceId: "r1", resourceRevisionId: "v1", locator: { kind: "temporal", startMs: 0 } }
      : { ...(VALID[commandId] ?? {}) };
    const { contextId: _dropped, ...without } = base as Record<string, unknown>;
    expect(() => validateCommandInput(commandId, without), `${commandId} without`).toThrow();
    expect(() => validateCommandInput(commandId, { ...base, contextId: "" }), `${commandId} empty`).toThrow();
    expect(() => validateCommandInput(commandId, { ...base, contextId: 7 }), `${commandId} number`).toThrow();
    expect(() => validateCommandInput(commandId, { ...base, contextId: "x".repeat(257) }), `${commandId} long`).toThrow();
  });

  it("does not accept the mode any more, on any command", () => {
    for (const commandId of Object.keys(VALID)) {
      expect(() => validateCommandInput(commandId, { ...VALID[commandId], mode: "enthusiast" }), commandId).toThrow();
      expect(() => validateCommandInput(commandId, { ...VALID[commandId], mode: "creator" }), commandId).toThrow();
    }
    expect(() => validateCommandInput("conversation.current", { mode: "creator" })).toThrow();
    expect(() => validateCommandInput("workspace.sessions", { mode: "enthusiast" })).toThrow();
    expect(() => validateCommandInput("session.open", { kind: "project", targetId: "p", mode: "creator" })).toThrow();
  });

  it("has no command to close a session, and no list of the sessions that were closed", () => {
    expect(Object.keys(CommandInputs)).not.toContain("session.close");
    expect(Object.keys(CommandInputs).filter((commandId) => commandId.startsWith("mode.") || commandId.includes("closedSessions"))).toEqual([]);
  });

  it("takes a context of any project id and null for 最近, and refuses what is not an id", () => {
    expect(ContextIdSchema.parse(null)).toBeNull();
    expect(ContextIdSchema.parse("prj_1")).toBe("prj_1");
    for (const bad of ["", undefined, 0, {}, [], "x".repeat(257)]) expect(ContextIdSchema.safeParse(bad).success, String(bad)).toBe(false);
    expect(contextKey(null)).toBe("");
    expect(contextKey(undefined)).toBe("");
    expect(contextKey("prj_1")).toBe("prj_1");
    expect(contextFromKey("")).toBeNull();
    expect(contextFromKey(null)).toBeNull();
    expect(contextFromKey("prj_1")).toBe("prj_1");
  });
});

describe("the saved state of a context", () => {
  it("reads back what a newer version added: another kind of tab, fields it does not know, and the order of the tabs", () => {
    const saved = state({
      preset: "quad",
      layout: { grid: { orientation: "HORIZONTAL" } },
      focusedTab: "b",
      tabs: [tab("a", { kind: "hologram", target: { shape: "cube" }, title: "未来的标签" }), tab("b", { colour: "red" })],
      newField: { answer: 42 },
    } as Partial<WorkspaceState>);
    const read = WorkspaceStateSchema.parse(JSON.parse(JSON.stringify(saved)));
    expect(read).toEqual(saved);
    expect(read.tabs[0]).toMatchObject({ kind: "hologram", target: { shape: "cube" } });
    expect(WORKSPACE_TAB_KINDS).not.toContain("hologram");
    expect((read as unknown as Record<string, unknown>).newField).toEqual({ answer: 42 });
  });

  it("refuses a state of another version, of a preset it does not know, and one that is too large to be one", () => {
    expect(WorkspaceStateSchema.safeParse({ ...EMPTY_WORKSPACE_STATE, version: 2 }).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse({ ...EMPTY_WORKSPACE_STATE, preset: "octo" }).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse({ ...EMPTY_WORKSPACE_STATE, tabs: [{ id: "", kind: "library", target: {}, title: "", view: {} }] }).success).toBe(false);
    const many = (n: number) => Array.from({ length: n }, (_, index) => tab(`t${index}`));
    expect(WorkspaceStateSchema.safeParse(state({ tabs: many(WORKSPACE_TAB_LIMIT) })).success).toBe(true);
    expect(WorkspaceStateSchema.safeParse(state({ tabs: many(WORKSPACE_TAB_LIMIT + 1) })).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse(state({ closed: many(WORKSPACE_CLOSED_LIMIT) })).success).toBe(true);
    expect(WorkspaceStateSchema.safeParse(state({ closed: many(WORKSPACE_CLOSED_LIMIT + 1) })).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse(state({ tabs: [tab("t", { history: { entries: Array.from({ length: 51 }, () => ({ target: {}, title: "" })), index: 0 } })] })).success).toBe(false);
  });

  it("cuts a state that is too large the way the profile keeps it: closed tabs first, then the view of the tabs that are not focused, then the layout", () => {
    const heavy = (id: string, kind = "reader") => tab(id, { kind, view: { blob: "x".repeat(20_000) } });
    const big = state({
      layout: { grid: "y".repeat(4_000) },
      focusedTab: "focus",
      tabs: [heavy("focus"), heavy("other"), heavy("note", "note"), tab("lib")],
      closed: [heavy("c1"), heavy("c2"), heavy("c3")],
    });
    const size = (value: WorkspaceState) => new TextEncoder().encode(JSON.stringify(value)).length;
    expect(size(big)).toBeGreaterThan(80_000);

    // Within the limit nothing is touched.
    expect(trimWorkspaceState(big, size(big))).toMatchObject({ trimmed: false, state: big });
    // A little too large: the oldest closed tab goes, nothing else.
    const first = trimWorkspaceState(big, size(big) - 1);
    expect(first.trimmed).toBe(true);
    expect(first.state.closed.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(first.state.tabs).toEqual(big.tabs);
    // Without closed tabs, the view of the tabs that are not focused goes before the focused one's, and the layout last.
    const noClosed = trimWorkspaceState(state({ ...big, closed: [] }), 26_000);
    expect(noClosed.state.tabs.find((item) => item.id === "focus")!.view).toEqual(big.tabs[0]!.view);
    expect(noClosed.state.tabs.filter((item) => item.id !== "focus").every((item) => Object.keys(item.view).length === 0)).toBe(true);
    expect(noClosed.state.layout).toEqual(big.layout);
    const tiny = trimWorkspaceState(big, 100);
    expect(tiny.state.layout).toBeNull();
    expect(tiny.state.tabs.map((item) => item.id)).toEqual(["focus", "other", "note", "lib"]);
    expect(tiny.state.focusedTab).toBe("focus");
    expect(tiny.bytes).toBe(size(tiny.state));
    expect(WORKSPACE_STATE_BYTES).toBe(256 * 1024);
  });
});

describe("the shell preference", () => {
  it("is version 2: a sidebar and a dock, the context to come back to, and no mode", () => {
    expect(ShellPreferenceSchema.parse(DEFAULT_SHELL_PREFERENCE)).toEqual(DEFAULT_SHELL_PREFERENCE);
    expect(Object.keys(DEFAULT_SHELL_PREFERENCE).sort()).toEqual(["dock", "lastContext", "rail", "reading", "sidebar", "spoilerGuard", "version"]);
    expect(ShellPreferenceSchema.safeParse({ ...DEFAULT_SHELL_PREFERENCE, mode: "creator" }).success).toBe(false);
    expect(ShellPreferenceSchema.safeParse({ ...DEFAULT_SHELL_PREFERENCE, version: 1 }).success).toBe(false);
  });

  it("converts version 1 once: the columns of the entertainment mode, widths held inside the new limits", () => {
    const old = ShellPreferenceV1Schema.parse({
      version: 1, mode: "creator", spoilerGuard: true,
      layouts: {
        enthusiast: { focus: false, left: { visible: true, width: 160 }, right: { visible: false, width: 720 } },
        creator: { focus: true, left: { visible: false, width: 300 }, right: { visible: true, width: 400 } },
      },
      reading: DEFAULT_SHELL_PREFERENCE.reading,
    });
    const next = shellFromV1(old, "prj_a");
    expect(ShellPreferenceSchema.parse(next)).toEqual(next);
    expect(next).toMatchObject({ version: 2, spoilerGuard: true, lastContext: "prj_a", sidebar: { visible: true, width: 200 }, dock: { visible: false, width: 640 } });
    expect(shellFromV1(old, null).lastContext).toBeNull();
  });
});

describe("the commands the sidebar and the search ask", () => {
  const refuses = (commandId: string, input: Record<string, unknown>) => expect(() => validateCommandInput(commandId, input), `${commandId} ${JSON.stringify(input)}`).toThrow();
  const accepts = (commandId: string, input: Record<string, unknown>) => expect(() => validateCommandInput(commandId, input), `${commandId} ${JSON.stringify(input)}`).not.toThrow();

  it("fill in how many to list, and refuse a page that is empty or larger than the limit", () => {
    expect(validateCommandInput("workspace.sidebar", { view: "home" })).toMatchObject({ perGroup: 5 });
    expect(validateCommandInput("workspace.items", { view: "note", contextId: null })).toMatchObject({ limit: 20 });
    expect(validateCommandInput("workspace.objects", { kind: "draft" })).toMatchObject({ limit: 50, offset: 0 });
    expect(validateCommandInput("workspace.find", { q: "雨" })).toMatchObject({ perType: 4 });
    for (const perGroup of [0, 21, 1.5]) refuses("workspace.sidebar", { view: "home", perGroup });
    for (const limit of [0, 101]) refuses("workspace.items", { view: "note", contextId: null, limit });
    for (const limit of [0, 201]) refuses("workspace.objects", { kind: "draft", limit });
    refuses("workspace.objects", { kind: "draft", offset: -1 });
    for (const perType of [0, 11]) refuses("workspace.find", { q: "雨", perType });
    refuses("workspace.sidebar", { view: "settings" });
    refuses("workspace.sidebar", { view: "home", open: Array.from({ length: 601 }, (_, index) => `p${index}`) });
    refuses("workspace.find", { q: "" });
    refuses("workspace.find", { q: "x".repeat(129) });
    accepts("workspace.find", { q: "x".repeat(128) });
  });

  it("ask the home for the kind of the list, give a view of one kind only its own, and the downloads none", () => {
    accepts("workspace.items", { view: "home", contextId: "prj_a", type: "comic" });
    refuses("workspace.items", { view: "home", contextId: "prj_a" });
    accepts("workspace.items", { view: "comic", contextId: "prj_a" });
    accepts("workspace.items", { view: "comic", contextId: "prj_a", type: "comic" });
    refuses("workspace.items", { view: "comic", contextId: "prj_a", type: "note" });
    accepts("workspace.items", { view: "downloads", contextId: null });
    refuses("workspace.items", { view: "downloads", contextId: null, type: "note" });
    refuses("workspace.items", { view: "home", contextId: "prj_a", type: "download" });
    refuses("workspace.objects", { kind: "note" });
  });
});

describe("the rail", () => {
  it("has the home and the ten kinds a person may take out, and every kind a list holds has its own view", () => {
    expect(RAIL_VIEWS[0]).toBe("home");
    expect(RAIL_VIEWS.slice(1)).toEqual([...HIDEABLE_RAIL_VIEWS]);
    expect(HIDEABLE_RAIL_VIEWS).toHaveLength(10);
    expect(HIDEABLE_RAIL_VIEWS).not.toContain("home");
    for (const type of SIDEBAR_ITEM_TYPES) expect(itemTypeOfView(type), type).toBe(type);
    expect(itemTypeOfView("home")).toBeNull();
    expect(itemTypeOfView("downloads")).toBeNull();
    expect(RAIL_VIEWS).not.toContain("settings");
  });

  it("is kept whole with its defaults, and changed by a patch that names only what changes", () => {
    expect(RailPreferenceSchema.parse({})).toEqual(DEFAULT_RAIL_PREFERENCE);
    expect(RailPreferenceSchema.parse({ hidden: ["video"], view: "video", open: { video: ["", "prj_a"] }, settingsPage: "storage" }))
      .toEqual({ hidden: ["video"], view: "video", open: { video: ["", "prj_a"] }, settingsPage: "storage" });
    // A patch has no defaults, or naming one part would reset the others.
    expect(RailPatchSchema.parse({})).toEqual({});
    expect(RailPatchSchema.parse({ view: "note" })).toEqual({ view: "note" });
    expect(RailPatchSchema.parse({ settingsPage: null })).toEqual({ settingsPage: null });
    for (const bad of [{ hidden: ["home"] }, { hidden: ["settings"] }, { view: "settings" }, { open: { settings: [] } }, { settingsPage: "" }, { extra: 1 }]) {
      expect(RailPatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(RailPreferenceSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ShellPreferenceSchema.parse({ ...DEFAULT_SHELL_PREFERENCE, rail: undefined })).toEqual(DEFAULT_SHELL_PREFERENCE);
  });
});

describe("the tabs of the kinds the workspace no longer has", () => {
  const some = (id: string, kind: string) => tab(id, { kind });

  it("keep the kinds that are lists and views of an object, and leave out the search, the settings, the plug-ins and the keys", () => {
    expect([...WORKSPACE_TAB_KINDS]).toEqual(expect.arrayContaining(["library", "reader", "note", "project", "whiteboard", "mindmap", "draft", "roughcut", "conversation", "records", "objects", "downloads"]));
    expect([...LEGACY_TAB_KINDS]).toEqual(["search", "settings", "plugins", "keys"]);
    for (const kind of LEGACY_TAB_KINDS) expect(WORKSPACE_TAB_KINDS, kind).not.toContain(kind);
  });

  it("are dropped from the tabs and from the closed ones, and the focus goes to the first tab that is left", () => {
    const saved = state({
      focusedTab: "s", layout: { grid: 1 }, preset: "two",
      tabs: [some("lib", "library"), some("s", "search"), some("set", "settings"), some("n", "note"), some("p", "plugins"), some("k", "keys"), some("f", "hologram")],
      closed: [some("c1", "settings"), some("c2", "records")],
    });
    const { state: kept, dropped } = dropLegacyTabs(saved);
    expect(dropped).toBe(5);
    expect(kept.tabs.map((item) => item.id)).toEqual(["lib", "n", "f"]);
    expect(kept.closed.map((item) => item.id)).toEqual(["c2"]);
    expect(kept.focusedTab).toBe("lib");
    expect(kept).toMatchObject({ layout: { grid: 1 }, preset: "two" });
    // The focus stays when it is on a tab that is kept; a state with none of them is the same state.
    expect(dropLegacyTabs({ ...saved, focusedTab: "n" }).state.focusedTab).toBe("n");
    const plain = state({ tabs: [some("lib", "library")], focusedTab: "lib" });
    expect(dropLegacyTabs(plain)).toEqual({ state: plain, dropped: 0 });
    expect(dropLegacyTabs(state({ tabs: [some("s", "search")], focusedTab: "s" })).state.focusedTab).toBeNull();
  });
});
