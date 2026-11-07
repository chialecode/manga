import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import {
  DRAWN, PICK, clickTestId, closeTabs, ensureSidebar, openFromShelf, pointerClick, pressChord, pressKey, railTo, setField, sleep, tabsOf, trustedClick, viaSidebar, waitDrawn, waitUntil, type RailName,
} from "./driver.ts";
import { js, leaveSettings, toRail, type caller } from "./common.ts";
import { focusedChip, hostFacts, settledHost, waitContext } from "./workspace-walk.ts";
import type { Observe } from "./reader-controls-walk.ts";

/**
 * The icon rail, the sidebar and its cards, the search box and the settings view in the real window (A-99 — A-102, AT-119 — AT-122): what each view lists and where
 * its entries lead, the icons that are taken out and found again, the card that comes out of the rail while the sidebar is folded (with the real pointer and with
 * the keys), the search box that floats over the window, the settings view that takes the sidebar's and the main area's place while the workspace stays mounted
 * under it, and a saved layout that still holds the tabs which are not tabs any more. Each observation is named; the package stage requires every one of them.
 */

export const RAIL_OBSERVATIONS = ["rail-views", "rail-hide-more", "rail-hover-card", "search-popup", "settings-view", "legacy-tabs-dropped"] as const;

type SizeName = "wide" | "narrow" | "short";
type Rect = { x: number; y: number; w: number; h: number; r: number; b: number };
type Call = ReturnType<typeof caller>;
type Point = { x: number; y: number };

export type RailEnv = {
  view: BrowserWindow;
  appService: MangaProductApp;
  call: Call;
  observe: Observe;
  shot: (name: string) => Promise<void>;
  resize: (size: SizeName) => Promise<void>;
  /** A project made earlier in the walk, with a whiteboard in it. */
  projectId: string;
  boardId: string;
  /** The titles the works carry. */
  titles: { comic: string; video: string; novel: string };
  videoId: string | null;
};

/** The views in the order of the rail. */
const VIEWS: readonly RailName[] = ["home", "conversation", "novel", "comic", "video", "note", "whiteboard", "mindmap", "draft", "roughcut", "downloads"];
const OBJECT_VIEWS = ["whiteboard", "mindmap", "draft", "roughcut"] as const;

/** The entries each view puts above its list (交互设计 2.10), by test id and in order. */
const ENTRIES: Record<RailName, string[]> = {
  home: ["sidebar-new-conversation", "sidebar-new-project", "sidebar-entry-library", "sidebar-entry-projects"],
  conversation: ["sidebar-new-conversation", "sidebar-manage"],
  novel: ["sidebar-manage"],
  comic: ["sidebar-manage"],
  video: ["sidebar-manage"],
  note: ["sidebar-manage"],
  whiteboard: ["sidebar-new-object", "sidebar-manage"],
  mindmap: ["sidebar-new-object", "sidebar-manage"],
  draft: ["sidebar-new-object", "sidebar-manage"],
  roughcut: ["sidebar-new-object", "sidebar-manage"],
  downloads: ["sidebar-manage"],
};

/** What "管理" opens: the page in a tab that is drawn, and the attribute that says which kind of it. */
const MANAGE: Record<string, { page: string; attr?: [string, string] }> = {
  conversation: { page: "records-tab", attr: ["data-type", "conversation"] },
  note: { page: "records-tab", attr: ["data-type", "note"] },
  novel: { page: "shelf-novel" },
  comic: { page: "shelf-comic" },
  video: { page: "shelf-video" },
  whiteboard: { page: "objects-tab", attr: ["data-kind", "whiteboard"] },
  mindmap: { page: "objects-tab", attr: ["data-kind", "mindmap"] },
  draft: { page: "objects-tab", attr: ["data-kind", "draft"] },
  roughcut: { page: "objects-tab", attr: ["data-kind", "roughcut"] },
  downloads: { page: "page-downloads" },
};

const near = (a: number, b: number, tolerance = 2) => Math.abs(a - b) <= tolerance;

// ------------------------------------------------------------------------------------------------------------------------------ what the page shows

type RowFacts = { id: string; title: string; type: string | null };
type GroupFacts = { key: string; current: boolean; opened: boolean; rows: RowFacts[]; more: string[] };
type SidebarFacts = { view: string | null; title: string; entries: string[]; groups: GroupFacts[]; flat: RowFacts[]; hasProjects: boolean; hasRecent: boolean };
type ApiItem = { title: string; type: string };
type ApiSection = { type: string; total: number; loaded: boolean; items: ApiItem[] };
type ApiView = { groups: Array<{ contextId: string | null; kind: string; name: string; sections: ApiSection[] }>; downloads: ApiSection | null };

function makeKit(view: BrowserWindow, call: Call) {
  const at = (id: string) => `${PICK}(${JSON.stringify(id)})`;
  const rect = (id: string) => js<Rect | null>(view, `(() => { const el = ${at(id)}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; })()`);
  const kit = {
    at,
    rect,
    drawn: (id: string) => js<boolean>(view, `${DRAWN}(${at(id)})`),
    attr: (id: string, name: string) => js<string | null>(view, `${at(id)}?.getAttribute(${JSON.stringify(name)}) ?? null`),
    text: (id: string) => js<string>(view, `${at(id)}?.textContent ?? ""`),
    /** The pointer, moved the way the hand moves it (a trusted move: the page sees the hover). */
    move: async (x: number, y: number) => { view.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) }); await sleep(70); },
    centre: async (id: string): Promise<Point | null> => { const r = await rect(id); return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null; },
    hover: async (id: string): Promise<boolean> => { const p = await kit.centre(id); if (!p) return false; await kit.move(p.x, p.y); return true; },
    /** A place on the page where a press does nothing: not a control, not a link, not a card that opens something. */
    quiet: () => js<Point | null>(view, `(() => {
      const main = ${at("shell-main")};
      if (!main) return null;
      const b = main.getBoundingClientRect();
      for (let fy = 0.92; fy > 0.3; fy -= 0.08) for (let fx = 0.9; fx > 0.3; fx -= 0.1) {
        const x = Math.round(b.left + b.width * fx), y = Math.round(b.top + b.height * fy);
        const hit = document.elementFromPoint(x, y);
        if (hit && main.contains(hit) && !hit.closest('button, a, input, select, textarea, label, video, canvas, [role="button"], [role="tab"], [data-opens], [tabindex]:not([tabindex="-1"])')) return { x, y };
      }
      return null;
    })()`),
    hostKey: async () => (await hostFacts(view))?.key ?? null,
    sidebar: () => js<SidebarFacts | null>(view, `(() => {
      const root = ${at("sidebar")};
      if (!root || !${DRAWN}(root)) return null;
      const row = (r) => ({ id: r.getAttribute("data-testid") ?? "", title: r.querySelector(".truncate")?.textContent ?? "", type: r.getAttribute("data-type") });
      return {
        view: root.getAttribute("data-view"),
        title: root.querySelector('[data-testid="sidebar-title"]')?.textContent ?? "",
        entries: [...root.querySelectorAll('[data-testid="sidebar-entries"] > button')].map((b) => b.getAttribute("data-testid") ?? ""),
        groups: [...root.querySelectorAll(".sidebar-context")].map((g) => ({
          key: (g.getAttribute("data-testid") ?? "").slice("context-".length),
          current: g.getAttribute("data-current") === "true",
          opened: g.querySelector(".sidebar-chevron")?.getAttribute("aria-expanded") === "true",
          rows: [...g.querySelectorAll(".sidebar-row")].map(row),
          more: [...g.querySelectorAll(".sidebar-more")].map((b) => b.getAttribute("data-testid") ?? ""),
        })),
        flat: [...root.querySelectorAll('[data-testid="sidebar-downloads"] .sidebar-row')].map(row),
        hasProjects: Boolean(root.querySelector('[data-testid="sidebar-projects"]')),
        hasRecent: Boolean(root.querySelector('[data-testid="sidebar-recent"]')),
      };
    })()`),
    /** The sidebar of a view, reached by its icon, shown, and filled in (nothing says "loading"). */
    showView: async (name: RailName, timeoutMs = 6000): Promise<boolean> => {
      if (!(await railTo(view, name, timeoutMs))) return false;
      if (!(await ensureSidebar(view, timeoutMs))) return false;
      return waitUntil(view, `(() => { const root = ${at("sidebar")}; return Boolean(root) && ${DRAWN}(root) && root.getAttribute("data-view") === ${JSON.stringify(name)} && !document.querySelector('[data-testid="sidebar-loading"]'); })()`, timeoutMs);
    },
    /** What the sidebar of a view should list: asked of the command that fills it, for the groups the window has open. */
    api: async (name: RailName, open: Array<string | null>): Promise<ApiView> => (await call("workspace.sidebar", { view: name, perGroup: 5, open })).value as ApiView,
  };
  return kit;
}
type Kit = ReturnType<typeof makeKit>;

/** The differences between what the sidebar draws and what the command answers for the groups that are open (none when they agree). */
/** The groups whose list the walk has grown with "更多" (`<view>|<group>`): what they draw is the answer's first page and then more. */
const GROWN = new Set<string>();

function compare(name: RailName, facts: SidebarFacts, api: ApiView): string[] {
  const problems: string[] = [];
  const own = name === "home" || name === "downloads" ? null : name;
  for (const group of facts.groups) {
    const place = api.groups.find((item) => (item.contextId ?? "recent") === group.key);
    if (!place) { problems.push(`the group ${group.key} is not in the answer`); continue; }
    if (!group.opened) { if (group.rows.length > 0) problems.push(`the folded group ${group.key} draws rows`); continue; }
    const want = place.sections.flatMap((section) => (section.loaded ? section.items.map((item) => item.title) : []));
    const got = group.rows.map((row) => row.title);
    const grown = GROWN.has(`${name}|${group.key}`);
    if (grown ? JSON.stringify(got.slice(0, want.length)) !== JSON.stringify(want) || got.length < want.length : JSON.stringify(want) !== JSON.stringify(got)) problems.push(`the group ${group.key} draws ${JSON.stringify(got)}, the answer is ${JSON.stringify(want)}`);
    if (own) for (const row of group.rows) if (row.type !== own) problems.push(`a row of type ${row.type} in the list of ${own}`);
  }
  if (name === "downloads") {
    const want = (api.downloads?.items ?? []).map((item) => item.title);
    if (JSON.stringify(want) !== JSON.stringify(facts.flat.map((row) => row.title))) problems.push(`the downloads draw ${JSON.stringify(facts.flat.map((row) => row.title))}, the answer is ${JSON.stringify(want)}`);
  }
  return problems;
}

/** The sidebar of a view once what it draws is what the command answers; the last differences when it never is (a list is filled in from the cache first, and then replaced). */
async function settle(kit: Kit, name: RailName): Promise<{ facts: SidebarFacts | null; problems: string[] }> {
  let last: { facts: SidebarFacts | null; problems: string[] } = { facts: null, problems: ["the sidebar is not drawn"] };
  for (let round = 0; round < 30; round += 1) {
    const facts = await kit.sidebar();
    if (facts && facts.view === name) {
      const open = facts.groups.filter((group) => group.opened).map((group) => (group.key === "recent" ? null : group.key));
      const problems = compare(name, facts, await kit.api(name, open));
      last = { facts, problems };
      if (problems.length === 0) return last;
    }
    await sleep(200);
  }
  return last;
}

// ----------------------------------------------------------------------------------------------------------------------------------- the data

type Seeded = { noteIds: string[]; needle: string; recentConversation: string; projectConversation: string };

/** Notes and conversations the lists have to show: six notes in 最近 (a sixth row is behind "更多"), one conversation in 最近 and one in the project. */
async function seed(env: RailEnv): Promise<Seeded> {
  const { call, projectId } = env;
  const needle = "RAILWALKNEEDLE";
  const noteIds: string[] = [];
  for (let n = 1; n <= 6; n += 1) {
    const made = (await call("notes.create", { title: `轨道笔记${"一二三四五六"[n - 1]}`, text: n === 1 ? `轨道笔记正文，其中有一个只在这里出现的词 ${needle}。` : `轨道笔记正文第${n}条。` })).value as { objectId?: string } | undefined;
    noteIds.push(String(made?.objectId ?? ""));
    await sleep(20);
  }
  const conversation = async (contextId: string | null, title: string) => {
    const id = String(((await call("conversation.new", { contextId })).value as { sessionId?: string } | undefined)?.sessionId ?? "");
    if (id) await call("conversation.rename", { sessionId: id, title });
    return id;
  };
  return { noteIds, needle, recentConversation: await conversation(null, "轨道最近对话"), projectConversation: await conversation(projectId, "轨道项目对话") };
}

// ------------------------------------------------------------------------------------------------------------------------------- rail-views

async function walkViews(env: RailEnv, kit: Kit, seeded: Seeded): Promise<void> {
  const { view, call, observe, shot, projectId, boardId } = env;
  const problems: string[] = [];
  const views: Record<string, unknown> = {};
  await toRail(view);
  await leaveSettings(view);
  await closeTabs(view, "all");
  const goRecent = async () => { if ((await kit.hostKey()) !== "" && await clickTestId(view, "context-open-recent", 4000)) await waitContext(view, ""); };
  const toggle = async (key: string) => clickTestId(view, `context-toggle-${key}`, 3000);
  const expandedOf = async (key: string) => (await kit.attr(`context-toggle-${key}`, "aria-expanded")) === "true";
  /** A group is open or folded by what it says of itself: the sidebar keeps the state of a group from one view to the next, so a click alone may do either. */
  const openGroup = async (key: string) => { if (!(await expandedOf(key))) await toggle(key); return waitUntil(view, `${kit.at(`context-toggle-${key}`)}?.getAttribute("aria-expanded") === "true"`, 3000); };
  const foldGroup = async (key: string) => { if (await expandedOf(key) && (await kit.attr(`context-toggle-${key}`, "disabled")) === null) await toggle(key); await sleep(150); };

  // The home: the projects (folded unless it is where the window is) and 最近 (open); the project opens with its things by kind.
  await kit.showView("home");
  await goRecent();
  await kit.showView("home");
  let home = await settle(kit, "home");
  for (const group of home.facts?.groups ?? []) if (group.key !== "recent" && group.opened && !group.current && await toggle(group.key)) await sleep(150);
  home = await settle(kit, "home");
  const folded = home.facts?.groups.find((group) => group.key === projectId);
  const recent = home.facts?.groups.find((group) => group.key === "recent");
  if (!home.facts?.hasProjects || !home.facts.hasRecent) problems.push("the home does not have its two groups, the projects and 最近");
  if (!folded || folded.opened || folded.current) problems.push("the project's group is not folded while the window is in 最近");
  if (!recent || !recent.opened || !recent.current) problems.push("最近 is not the open group of the window's context");
  await openGroup(projectId);
  home = await settle(kit, "home");
  const opened = home.facts?.groups.find((group) => group.key === projectId);
  if (!opened?.rows.some((row) => row.id === `sidebar-item-whiteboard-${boardId}` && row.type === "whiteboard")) problems.push("the project's group does not list its whiteboard once it is open");
  if (!(await kit.drawn(`sidebar-type-${projectId}-whiteboard`))) problems.push("the home does not name the kind above the project's whiteboards");
  problems.push(...home.problems.map((text) => `home: ${text}`));
  const labelOf = (name: RailName) => kit.attr(`nav-${name}`, "aria-label");
  if (home.facts && home.facts.title !== (await labelOf("home"))) problems.push("the home's sidebar is not headed by the icon's name");
  if (JSON.stringify(home.facts?.entries) !== JSON.stringify(ENTRIES.home)) problems.push(`the home's entries are ${JSON.stringify(home.facts?.entries)}`);
  views.home = { groups: home.facts?.groups.map((group) => `${group.key}:${group.opened ? group.rows.length : "folded"}`), entries: home.facts?.entries };
  await shot("rail-home");
  // Its entries open a tab each: the library and the projects.
  if (!(await viaSidebar(view, "home", "sidebar-entry-library", 5000)) || !(await waitDrawn(view, "page-library", 6000))) problems.push("the home's library entry did not open the library");
  // The library's own search field is a field in the page's flow (the search box over the window has a class of its own and must not touch it).
  const shelfSearch = await js<{ position: string; inside: boolean } | null>(view, `(() => {
    const label = document.querySelector('[data-testid="shelf-search"]')?.closest("label");
    const page = document.querySelector('[data-testid="page-library"]');
    if (!label || !page) return null;
    const l = label.getBoundingClientRect();
    const p = page.getBoundingClientRect();
    return { position: getComputedStyle(label).position, inside: l.left >= p.left - 1 && l.right <= p.right + 1 && l.height > 20 && l.height < 60 };
  })()`);
  if (!shelfSearch || shelfSearch.position === "fixed" || !shelfSearch.inside) problems.push(`the library's search field is ${JSON.stringify(shelfSearch)}, not a field in the page`);
  if (!(await viaSidebar(view, "home", "sidebar-entry-projects", 5000)) || !(await waitDrawn(view, "page-projects", 6000))) problems.push("the home's projects entry did not open the projects page");
  await kit.showView("home");
  await foldGroup(projectId);

  // Each of the other views: its own kind of thing, grouped, with its entries; its manage entry opens the list of that kind in a tab.
  // The downloads' icon is there once the download plugin is installed (交互设计 2.10); this walk's window has none, and the plugin walk looks at the view.
  const present = await orderOf(view);
  for (const name of VIEWS.slice(1)) {
    if (!present.includes(name)) {
      if (name !== "downloads") problems.push(`${name}: the rail has no icon`);
      else if (await kit.drawn("nav-downloads")) problems.push("downloads: the icon is drawn although it is not in the rail");
      else views.downloads = "no icon without the plugin";
      continue;
    }
    const tabsBefore = (await tabsOf(view)).map((tab) => tab.id).join(",");
    if (!(await kit.showView(name))) { problems.push(`${name}: the sidebar did not come`); continue; }
    // The icon itself opens no tab.
    if ((await tabsOf(view)).map((tab) => tab.id).join(",") !== tabsBefore) problems.push(`${name}: a click on the icon changed the tabs`);
    if (name === "conversation") {
      // A conversation of a project that is not where the window is: its group opens, the row is clicked, and the window goes to the project first.
      const settledNow = await settle(kit, name);
      problems.push(...settledNow.problems.map((text) => `${name}: ${text}`));
      await openGroup(projectId);
      await waitUntil(view, `${kit.at(`session-open-${seeded.projectConversation}`)}`, 5000);
      const shown = await kit.drawn(`session-open-${seeded.projectConversation}`);
      if (!shown) problems.push("conversation: the project's conversation is not listed under the project");
      else {
        await clickTestId(view, `session-open-${seeded.projectConversation}`, 3000);
        const there = await waitContext(view, projectId, 6000);
        const chip = await waitUntil(view, `document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab"][data-focused="true"][data-kind="conversation"]')`, 6000);
        if (!there || !chip) problems.push(`conversation: the project's conversation was clicked from 最近 and opened ${there ? "no conversation tab" : "in the wrong context"}`);
        views.conversationOpensInProject = { there, chip };
      }
      if (!(await kit.showView(name))) continue;
      await foldGroup(projectId);
    }
    if (name === "note") {
      // Six notes in 最近: five rows and "更多"; the rest comes with it, and a note of 最近 opens in 最近 whatever context the window is in.
      const here = await settle(kit, name);
      problems.push(...here.problems.map((text) => `${name}: ${text}`));
      const group = here.facts?.groups.find((item) => item.key === "recent");
      const total = (await kit.api(name, [null])).groups.find((item) => item.contextId === null)?.sections[0]?.total ?? 0;
      if (!group || group.rows.length !== 5 || group.more.length !== 1 || total < 6) problems.push(`note: 最近 draws ${group?.rows.length ?? "no"} rows of ${total} with ${group?.more.length ?? 0} "更多"`);
      else {
        await clickTestId(view, group.more[0]!, 3000);
        const grown = await waitUntil(view, `document.querySelectorAll('[data-testid="sidebar"] [data-testid="context-recent"] .sidebar-row').length === ${Math.min(total, 25)}`, 5000);
        if (!grown) problems.push(`note: "更多" did not bring the rows to ${Math.min(total, 25)}`);
        views.noteMore = { total, grown };
        GROWN.add("note|recent");
        const needle = seeded.noteIds[0]!;
        await clickTestId(view, `sidebar-item-note-${needle}`, 3000);
        const there = await waitContext(view, "", 6000);
        const chip = await waitUntil(view, `document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab"][data-focused="true"][data-kind="note"]')`, 6000);
        if (!there || !chip) problems.push(`note: a note of 最近 opened ${there ? "no note tab" : "in another context"}`);
        if (!(await kit.showView(name))) continue;
      }
    }
    if (name === "whiteboard") {
      // In 最近 there is no project to make a whiteboard in: the sidebar asks which; one of a project that is not where the window is opens in that project.
      await goRecent();
      if (!(await kit.showView(name))) continue;
      await clickTestId(view, "sidebar-new-object", 3000);
      const chooser = await waitDrawn(view, "sidebar-choose-project", 3000);
      if (!chooser) problems.push("whiteboard: 新建 in 最近 did not ask which project");
      await pressKey(view, "Escape");
      await waitUntil(view, `!document.querySelector('[data-testid="sidebar-choose-project"]')`, 2000);
      await openGroup(projectId);
      await waitUntil(view, `${kit.at(`sidebar-item-whiteboard-${boardId}`)}`, 5000);
      if (!(await clickTestId(view, `sidebar-item-whiteboard-${boardId}`, 3000))) problems.push("whiteboard: the project's whiteboard is not listed under the project");
      const there = await waitContext(view, projectId, 6000);
      const chip = await waitUntil(view, `document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab"][data-focused="true"][data-kind="whiteboard"]')`, 6000);
      if (!there || !chip) problems.push(`whiteboard: the project's whiteboard opened ${there ? "no whiteboard tab" : "in the wrong context"}`);
      // In the project: 新建 makes one in it and opens it.
      if (!(await kit.showView(name))) continue;
      await foldGroup(projectId);
      const totalOf = async () => (await kit.api(name, [projectId])).groups.find((item) => item.contextId === projectId)?.sections[0]?.total ?? 0;
      const before = await totalOf();
      await clickTestId(view, "sidebar-new-object", 3000);
      const made = await waitUntil(view, `document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab"][data-focused="true"][data-kind="whiteboard"]')`, 6000);
      await sleep(400);
      const after = await totalOf();
      if (!made || after !== before + 1) problems.push(`whiteboard: 新建 in the project made ${after - before} whiteboard(s) and ${made ? "opened it" : "opened none"}`);
      views.newWhiteboard = { before, after, made };
      if (!(await kit.showView(name))) continue;
      await shot("rail-view-whiteboard");
    }
    const settled = await settle(kit, name);
    const f = settled.facts;
    if (!f) { problems.push(`${name}: the sidebar is not drawn`); continue; }
    problems.push(...settled.problems.map((text) => `${name}: ${text}`));
    if (f.title !== (await labelOf(name))) problems.push(`${name}: the sidebar is not headed by the icon's name`);
    if (JSON.stringify(f.entries) !== JSON.stringify(ENTRIES[name])) problems.push(`${name}: the entries are ${JSON.stringify(f.entries)}, not ${JSON.stringify(ENTRIES[name])}`);
    const marked = await js<string[]>(view, `[...document.querySelectorAll('[data-testid="rail-views"] [aria-current="page"]')].map((el) => el.getAttribute("data-rail-view") ?? "")`);
    if (marked.length !== 1 || marked[0] !== name) problems.push(`${name}: the rail marks ${JSON.stringify(marked)} as the view on screen`);
    views[name] = { rows: f.groups.map((group) => `${group.key}:${group.opened ? group.rows.length : "folded"}`), flat: f.flat.length, entries: f.entries };
    // Its manage entry: the list of that kind, in a tab.
    const manage = MANAGE[name]!;
    await clickTestId(view, "sidebar-manage", 3000);
    const page = await waitDrawn(view, manage.page, 6000);
    const kind = manage.attr ? await kit.attr(manage.page, manage.attr[0]) : null;
    if (!page || (manage.attr && kind !== manage.attr[1])) problems.push(`${name}: 管理 opened ${page ? `the wrong list (${kind})` : "nothing"}`);
  }
  await kit.showView("home");
  observe("rail-views", problems.length === 0, { problems, views, seeded: { notes: seeded.noteIds.length } });
}

// ----------------------------------------------------------------------------------------------------------------------------- rail-hide-more

const orderOf = (view: BrowserWindow) => js<string[]>(view, `[...document.querySelectorAll('[data-testid="rail-views"] > button[data-rail-view]')].map((b) => b.getAttribute("data-rail-view")).filter((name) => name !== "more")`);
const hiddenOf = async (call: Call): Promise<string[]> => (((await call("settings.getShell", {})).value as { rail?: { hidden?: string[] } } | undefined)?.rail?.hidden ?? []).slice().sort();
const moreItems = (view: BrowserWindow) => js<string[]>(view, `[...document.querySelectorAll('[data-testid="rail-more-list"] [data-rail-more-item]')].map((b) => (b.getAttribute("data-testid") ?? "").slice("rail-more-".length))`);

/** Right click on an icon (the page's own `contextmenu`), then the one entry of the menu; true once the icon is gone from the rail. */
export async function hideRailIcon(view: BrowserWindow, name: RailName): Promise<boolean> {
  const at = `${PICK}(${JSON.stringify(`nav-${name}`)})`;
  const sent = await js<boolean>(view, `(() => {
    const el = ${at};
    if (!el) return false;
    const b = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }));
    return true;
  })()`);
  if (!sent || !(await waitDrawn(view, "rail-menu", 2000))) return false;
  const onlyOne = await js<string[]>(view, `[...document.querySelectorAll('[data-testid="rail-menu"] [role="menuitem"]')].map((b) => b.getAttribute("data-testid") ?? "")`);
  if (JSON.stringify(onlyOne) !== JSON.stringify(["rail-menu-hide"])) return false;
  await clickTestId(view, "rail-menu-hide", 2000);
  return waitUntil(view, `!${at}`, 3000);
}

/** The icons of the rail in order, by view name ("…" left out), and the ones the shell keeps as taken out. */
export const railOrder = orderOf;
export const railHidden = hiddenOf;

async function walkHideMore(env: RailEnv, kit: Kit): Promise<void> {
  const { view, call, observe, shot, resize } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await resize("wide");
  await leaveSettings(view);
  await kit.showView("home");
  const initial = await orderOf(view);
  detail.initial = initial;
  // Every view but the downloads, whose icon comes with its plugin (this window has none).
  const present = VIEWS.filter((name) => name !== "downloads");
  if (JSON.stringify(initial) !== JSON.stringify(present)) problems.push(`the rail starts with ${JSON.stringify(initial)}`);
  if (await kit.drawn("rail-more")) problems.push('the rail has "…" in a window that has room for every icon');
  if ((await hiddenOf(call)).length > 0) problems.push("an icon was already taken out when the walk began");

  // The home cannot be taken out: no menu on it.
  await js(view, `(() => { const el = ${kit.at("nav-home")}; const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: b.left + 5, clientY: b.top + 5 })); })()`);
  await sleep(250);
  if (await kit.drawn("rail-menu")) { problems.push("the home has a menu that takes it out"); await pressKey(view, "Escape"); }

  // Two icons taken out: gone from the rail, behind "…", saved.
  const first = await hideRailIcon(view, "note");
  const second = await hideRailIcon(view, "whiteboard");
  if (!first || !second) problems.push(`the icons were not taken out by the menu (note ${first}, whiteboard ${second})`);
  const left = await orderOf(view);
  const expectedLeft = initial.filter((name) => name !== "note" && name !== "whiteboard");
  if (JSON.stringify(left) !== JSON.stringify(expectedLeft)) problems.push(`after taking out two icons the rail is ${JSON.stringify(left)}`);
  const saved = await hiddenOf(call);
  if (JSON.stringify(saved) !== JSON.stringify(["note", "whiteboard"])) problems.push(`the shell kept ${JSON.stringify(saved)} as the icons that are out`);
  detail.hidden = saved;

  // "…" lists them with their pins; a click on one goes to its view and "…" is marked as where the window is.
  await pointerClick(view, "rail-more", 2000);
  const listed = await waitDrawn(view, "rail-more-list", 2000) ? await moreItems(view) : [];
  const pins = await js<string[]>(view, `[...document.querySelectorAll('[data-testid^="rail-pin-"]')].map((b) => (b.getAttribute("data-testid") ?? "").slice("rail-pin-".length))`);
  if (JSON.stringify(listed.slice().sort()) !== JSON.stringify(["note", "whiteboard"]) || JSON.stringify(pins.slice().sort()) !== JSON.stringify(["note", "whiteboard"])) problems.push(`"…" lists ${JSON.stringify(listed)} with the pins ${JSON.stringify(pins)}`);
  await shot("rail-more-menu");
  await pointerClick(view, "rail-more-whiteboard", 2000);
  const entered = await waitUntil(view, `${kit.at("sidebar")}?.getAttribute("data-view") === "whiteboard"`, 4000);
  const hereMarked = await kit.attr("rail-more", "aria-current");
  if (!entered || hereMarked !== "page") problems.push(`a click in "…" ${entered ? "went to the view but did not mark …" : "did not go to the view"}`);
  // Esc closes the list and gives the focus back to "…".
  await pointerClick(view, "rail-more", 2000);
  await waitDrawn(view, "rail-more-list", 2000);
  await pressKey(view, "Escape");
  const closed = await waitUntil(view, `!document.querySelector('[data-testid="rail-more-list"]')`, 2000);
  const focusBack = await js<boolean>(view, `document.activeElement === ${kit.at("rail-more")}`);
  if (!closed || !focusBack) problems.push(`Esc ${closed ? "closed the list but did not give the focus back to …" : "did not close the list"}`);

  // The window reloaded: the icons that were taken out are still out.
  await view.webContents.reload();
  await toRail(view);
  await waitUntil(view, `${kit.at("rail-more")}`, 6000);
  const afterReload = await orderOf(view);
  if (JSON.stringify(afterReload) !== JSON.stringify(expectedLeft)) problems.push(`after a reload the rail is ${JSON.stringify(afterReload)}`);
  detail.afterReload = afterReload;

  // The pin of the whiteboard puts its icon back; the note stays out, so "…" is still there.
  const pin = async (name: "note" | "whiteboard") => {
    if (await kit.drawn(`nav-${name}`)) return true;
    await pointerClick(view, "rail-more", 2000);
    await waitDrawn(view, "rail-more-list", 2000);
    await pointerClick(view, `rail-pin-${name}`, 2000);
    const back = await waitDrawn(view, `nav-${name}`, 3000);
    await pressKey(view, "Escape");
    return back;
  };
  if (!(await pin("whiteboard"))) problems.push("the pin of whiteboard did not put the icon back");
  const noteOut = initial.filter((name) => name !== "note");
  const withWhiteboard = await orderOf(view);
  if (JSON.stringify(withWhiteboard) !== JSON.stringify(noteOut)) problems.push(`with only the note out the rail is ${JSON.stringify(withWhiteboard)}`);
  if (JSON.stringify(await hiddenOf(call)) !== JSON.stringify(["note"])) problems.push("the shell does not keep the note alone as the icon that is out after a pin");

  // A window that is short: what does not fit goes behind "…" (the icon taken out stays there with its pin), and the settings button stays in the window.
  await resize("short");
  await sleep(200);
  const short = await orderOf(view);
  await pointerClick(view, "rail-more", 2000);
  const shortList = await waitDrawn(view, "rail-more-list", 2000) ? await moreItems(view) : [];
  const shortPins = await js<number>(view, `document.querySelectorAll('[data-testid^="rail-pin-"]').length`);
  await pressKey(view, "Escape");
  const settingsAt = await kit.rect("nav-settings");
  const innerHeight = await js<number>(view, "window.innerHeight");
  const scrolls = await js<boolean>(view, `(() => { const el = ${kit.at("shell-rail")}; return Boolean(el) && el.scrollHeight > el.clientHeight + 1; })()`);
  if (scrolls) problems.push("the rail scrolls in the short window");
  const everything = [...short, ...shortList];
  // The icon taken out and at least one that does not fit are behind "…": the icons that do not fit are more than the one that was taken out.
  if (short.length >= noteOut.length || shortList.length < 2 || !shortList.includes("note")) problems.push(`the short window kept ${short.length} icons and put ${shortList.length} behind … (${JSON.stringify(shortList)})`);
  if (new Set(everything).size !== initial.length || initial.some((name) => !everything.includes(name))) problems.push(`the short window shows ${JSON.stringify(short)} and lists ${JSON.stringify(shortList)}: not every view is within reach`);
  if (shortPins !== 1) problems.push(`the short window's "…" has ${shortPins} pins, not the one of the icon taken out`);
  if (!settingsAt || settingsAt.b > innerHeight + 1) problems.push("the settings button is not inside the short window");
  detail.short = { shown: short.length, behind: shortList.length, pins: shortPins, innerHeight };
  // An icon that does not fit still leads to its view.
  const behind = shortList.find((name) => name !== "note") ?? shortList[0]!;
  await pointerClick(view, "rail-more", 2000);
  await waitDrawn(view, "rail-more-list", 2000);
  await pointerClick(view, `rail-more-${behind}`, 2000);
  if (!(await waitUntil(view, `${kit.at("sidebar")}?.getAttribute("data-view") === ${JSON.stringify(behind)}`, 4000))) problems.push(`the icon ${behind}, behind "…" in the short window, did not lead to its view`);
  if (short.length === 0) problems.push("the short window shows no icon");
  await shot("rail-short");
  await resize("wide");
  await sleep(200);

  // The last pin puts the rest back where it was, and "…" goes with the last icon that was out.
  if (!(await pin("note"))) problems.push("the pin of note did not put the icon back");
  const restored = await orderOf(view);
  if (JSON.stringify(restored) !== JSON.stringify(initial)) problems.push(`after the pins the rail is ${JSON.stringify(restored)}, not ${JSON.stringify(initial)}`);
  if ((await hiddenOf(call)).length !== 0) problems.push("the shell still keeps icons as out after the pins");
  if (await kit.drawn("rail-more")) problems.push('"…" is still on the rail with nothing in it');
  await kit.showView("home");
  observe("rail-hide-more", problems.length === 0, { problems, ...detail });
}

// ----------------------------------------------------------------------------------------------------------------------------- rail-hover-card

async function walkHoverCard(env: RailEnv, kit: Kit): Promise<void> {
  const { view, call, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await leaveSettings(view);
  await kit.showView("home");
  const sidebarWidth = async () => ((await call("settings.getShell", {})).value as { sidebar?: { visible?: boolean; width?: number } } | undefined)?.sidebar;
  const card = (name: string) => `${kit.at("shell-sidebar")}?.getAttribute("data-shell-state") === "overlay" && ${kit.at("shell-sidebar")}?.getAttribute("data-view") === ${JSON.stringify(name)}`;
  const waitCard = (name: string, ms = 2500) => waitUntil(view, card(name), ms);
  const noCard = (ms = 2500) => waitUntil(view, `!${kit.at("shell-sidebar")}`, ms);
  const away = async () => { const p = await kit.quiet(); if (p) await kit.move(p.x, p.y); };

  // The sidebar folded with its switch.
  const before = await sidebarWidth();
  if (!(await kit.drawn("shell-sidebar"))) problems.push("the sidebar is not docked at the start of the walk");
  await clickTestId(view, "shell-sidebar-toggle", 2000);
  const folded = await waitUntil(view, `!${kit.at("shell-sidebar")}`, 3000);
  if (!folded) problems.push("the sidebar's switch did not fold the sidebar");
  const savedFolded = await sidebarWidth();
  await away();
  await sleep(300);
  const mainBefore = await kit.rect("shell-main");

  // The pointer rests on an icon: its card comes out against the rail, over the page, with the sidebar's color, an edge and a shadow, and the focus is not taken.
  await js(view, `${kit.at("nav-home")}.focus()`);
  if (!(await kit.hover("nav-comic"))) problems.push("there is no comic icon to rest the pointer on");
  const came = await waitCard("comic");
  const focusKept = await js<boolean>(view, `document.activeElement === ${kit.at("nav-home")}`);
  if (!focusKept) problems.push("the card took the focus from where it was");
  const railBox = await kit.rect("shell-rail");
  const cardBox = await kit.rect("shell-sidebar");
  const style = await js<{ border: string; shadow: string; background: string; want: string; title: string; entries: string[]; covers: boolean } | null>(view, `(() => {
    const el = ${kit.at("shell-sidebar")};
    if (!el) return null;
    const css = getComputedStyle(el);
    const probe = document.createElement("div");
    probe.style.background = "var(--color-sidebar)";
    document.body.appendChild(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      border: css.borderTopWidth, shadow: css.boxShadow, background: css.backgroundColor, want,
      title: el.querySelector('[data-testid="sidebar-title"]')?.textContent ?? "",
      entries: [...el.querySelectorAll('[data-testid="sidebar-entries"] > button')].map((b) => b.getAttribute("data-testid") ?? ""),
      covers: Boolean(hit) && el.contains(hit),
    };
  })()`);
  if (!came) problems.push("resting the pointer on the comic icon did not bring its card");
  if (came && railBox && cardBox && style) {
    if (!near(cardBox.x, railBox.r) || !near(cardBox.y, railBox.y)) problems.push(`the card is at ${Math.round(cardBox.x)},${Math.round(cardBox.y)}, not against the rail's edge at ${Math.round(railBox.r)},${Math.round(railBox.y)}`);
    if (!near(cardBox.w, savedFolded?.width ?? before?.width ?? 0, 3)) problems.push(`the card is ${Math.round(cardBox.w)} wide, not the sidebar's ${savedFolded?.width}`);
    if (!(parseFloat(style.border) > 0) || style.shadow === "none") problems.push(`the card has no edge or no shadow (${style.border}, ${style.shadow})`);
    if (style.background !== style.want) problems.push(`the card is ${style.background}, not the sidebar's color ${style.want}`);
    if (style.title !== (await kit.attr("nav-comic", "aria-label")) || !style.entries.includes("sidebar-manage")) problems.push("the card is not the comic view's sidebar");
    if (!style.covers) problems.push("the card is not on top of the page");
  }
  const mainWith = await kit.rect("shell-main");
  if (mainBefore && mainWith && (!near(mainBefore.x, mainWith.x, 1) || !near(mainBefore.w, mainWith.w, 1))) problems.push("the page moved or changed width when the card came out");
  detail.card = { box: cardBox, rail: railBox, style };
  await shot("rail-hover-card");

  // From icon to icon the card is replaced; one card at a time.
  await kit.hover("nav-video");
  const swapped = await waitCard("video");
  const count = await js<number>(view, `document.querySelectorAll('[data-testid="shell-sidebar"]').length`);
  if (!swapped || count !== 1) problems.push(`moving to the video icon left ${count} card(s), ${swapped ? "the right one" : "not the video's"}`);

  // The pointer goes into the card and it stays; a trusted click on its manage entry opens the shelf and the sidebar is still folded.
  await kit.hover("nav-comic");
  await waitCard("comic");
  const into = await kit.centre("sidebar-manage");
  if (into) await kit.move(into.x, into.y);
  await sleep(450);
  const stayed = await waitCard("comic", 500);
  if (!stayed) problems.push("the card closed while the pointer was on it");
  await trustedClick(view, "sidebar-manage", 2000);
  const shelf = await waitDrawn(view, "shelf-comic", 6000);
  const closedAfter = await noCard(2500);
  const afterManage = await sidebarWidth();
  if (!shelf) problems.push("the click on the card's manage entry did not open the comic shelf");
  if (!closedAfter) problems.push("the card was left standing over what the click opened");
  if (afterManage?.visible !== false) problems.push("the sidebar was unfolded by a click in its card");
  await away();

  // A click on an icon with the real pointer changes the view; the sidebar is not unfolded, and the card goes when the pointer does.
  const iconAt = await kit.centre("nav-note");
  if (iconAt) await kit.move(iconAt.x, iconAt.y);
  await trustedClick(view, "nav-note", 2000);
  const noteCard = await waitCard("note", 3000);
  const markedNote = await kit.attr("nav-note", "aria-current");
  const sameMain = await kit.rect("shell-main");
  if (!noteCard || markedNote !== "page") problems.push(`a click on the note icon ${noteCard ? "did not mark it" : "brought no card of the note view"}`);
  if (mainBefore && sameMain && !near(mainBefore.w, sameMain.w, 1)) problems.push("a click on an icon changed the width of the page");
  if ((await sidebarWidth())?.visible !== false) problems.push("a click on an icon unfolded the sidebar");
  await away();
  const gone = await noCard(3000);
  if (!gone) problems.push("the card stayed after the pointer went: a click on an icon pinned it");

  // The keys: Enter on a focused icon opens the card and the focus goes into it; Esc closes it and gives the focus back to the icon.
  const enter = async () => {
    view.webContents.focus();
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    view.webContents.sendInputEvent({ type: "char", keyCode: "Enter" } as never);
    await sleep(40);
    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  };
  await js(view, `${kit.at("nav-comic")}.focus()`);
  await enter();
  const keyCard = await waitCard("comic", 2500);
  const focusIn = await js<boolean>(view, `(() => { const el = ${kit.at("shell-sidebar")}; return Boolean(el) && el.contains(document.activeElement); })()`);
  await sleep(500);
  const stillThere = await waitCard("comic", 300);
  if (!keyCard || !focusIn || !stillThere) problems.push(`Enter on the comic icon: card ${keyCard}, focus inside ${focusIn}, still there after half a second ${stillThere}`);
  await pressKey(view, "Escape");
  const keyClosed = await noCard(2000);
  const focusBack = await js<boolean>(view, `document.activeElement === ${kit.at("nav-comic")}`);
  if (!keyClosed || !focusBack) problems.push(`Esc: card closed ${keyClosed}, focus back on the icon ${focusBack}`);
  // A card opened by the keys goes when the page outside it is pressed.
  await js(view, `${kit.at("nav-comic")}.focus()`);
  await enter();
  const again = await waitCard("comic", 2500);
  const quiet = await kit.quiet();
  if (quiet) { await kit.move(quiet.x, quiet.y); view.webContents.sendInputEvent({ type: "mouseDown", x: quiet.x, y: quiet.y, button: "left", clickCount: 1 }); view.webContents.sendInputEvent({ type: "mouseUp", x: quiet.x, y: quiet.y, button: "left", clickCount: 1 }); }
  const pressedAway = await noCard(2500);
  if (!again || !quiet || !pressedAway) problems.push(`a card opened by Enter: it came ${again}, a press outside was made ${Boolean(quiet)}, it went ${pressedAway}`);
  detail.keys = { keyCard, focusIn, stillThere, keyClosed, focusBack, again, pressedAway };

  // Unfolded again with the switch, as it was.
  await clickTestId(view, "shell-sidebar-toggle", 2000);
  const docked = await waitUntil(view, `${kit.at("shell-sidebar")}?.getAttribute("data-shell-state") === "dock"`, 3000);
  const restored = await sidebarWidth();
  if (!docked || restored?.visible !== true || (before?.width !== undefined && !near(restored.width ?? 0, before.width, 1))) problems.push(`the sidebar was not unfolded as it was (${JSON.stringify(restored)} against ${JSON.stringify(before)})`);
  await away();
  await closeTabs(view, ["library"]);
  await kit.showView("home");
  observe("rail-hover-card", problems.length === 0, { problems, ...detail });
}

// ------------------------------------------------------------------------------------------------------------------------------ search-popup

async function walkSearch(env: RailEnv, kit: Kit, seeded: Seeded): Promise<void> {
  const { view, call, observe, shot, projectId, titles } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await leaveSettings(view);
  await kit.showView("home");
  if ((await kit.hostKey()) !== "" && await clickTestId(view, "context-open-recent", 3000)) await waitContext(view, "");
  await closeTabs(view, "all");
  const kinds = () => tabsOf(view).then((tabs) => tabs.map((tab) => tab.kind));
  const results = () => js<string[]>(view, `[...document.querySelectorAll('[data-testid="search-results"] [data-testid^="search-result-"]')].map((el) => (el.getAttribute("data-testid") ?? "").slice("search-result-".length) + ":" + (el.querySelector(".search-row-title")?.textContent ?? ""))`);
  const settled = (ms = 4000) => waitUntil(view, `(() => { const list = ${kit.at("search-results")}; return Boolean(list) && list.getAttribute("aria-busy") !== "true"; })()`, ms);
  const type = async (text: string) => { await setField(view, "search-input", text); await sleep(120); await settled(); await sleep(150); };
  const gone = () => waitUntil(view, `!document.querySelector('[data-testid="search-box"]')`, 3000);
  const opened = (ms = 3000) => waitDrawn(view, "search-input", ms);
  const frontKind = (kind: string, ms = 6000) => waitUntil(view, `document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab"][data-focused="true"][data-kind="${kind}"]')`, ms);
  const byKey = async () => {
    // A box that is still up from a step that went wrong is closed first, so that one wrong step does not spoil the rest.
    if (await kit.drawn("search-box")) { await pressKey(view, "Escape"); await gone(); }
    await pressChord(view, "K", ["control"]);
    return opened();
  };

  // From a view of the rail: the scope is that view; it floats over the window and takes the focus, and it is not a tab.
  await kit.showView("comic");
  const label = await kit.attr("nav-comic", "aria-label");
  await clickTestId(view, "sidebar-search", 3000);
  const shown = await opened();
  const scope = await kit.text("search-scope");
  const typed = await js<{ focused: boolean; over: boolean; placeholder: string }>(view, `(() => {
    const input = ${kit.at("search-input")};
    const box = ${kit.at("search-box")};
    const b = box?.getBoundingClientRect();
    const hit = b ? document.elementFromPoint(b.left + b.width / 2, b.top + 20) : null;
    return { focused: document.activeElement === input, over: Boolean(hit) && box.contains(hit), placeholder: input?.getAttribute("placeholder") ?? "" };
  })()`);
  if (!shown || !scope.includes(label ?? "?") || !typed.focused || !typed.over || !typed.placeholder.includes(label ?? "?")) problems.push(`from the comic view: box ${shown}, scope "${scope}", ${JSON.stringify(typed)}`);
  if ((await kinds()).includes("search")) problems.push("the search box made a tab");
  // The names that match come as the text is typed, in the scope only; a work opens on its own page.
  await type(titles.comic.slice(0, 2));
  const scoped = await results();
  if (!scoped.some((row) => row.startsWith("comic:") && row.includes(titles.comic)) || scoped.some((row) => !row.startsWith("comic:"))) problems.push(`in the comic scope "${titles.comic.slice(0, 2)}" found ${JSON.stringify(scoped)}`);
  if (!(await kit.drawn("search-run-body"))) problems.push("a scope of texts does not offer the search in the texts");
  detail.scoped = scoped;
  // What the first row opens is told by the command that listed it: a work opens on its own page, a resource that is in no work (the walk's entry was deleted earlier) in its reader.
  type Found = { groups?: Array<{ items?: Array<{ title: string; open: { kind: string } }> }> };
  const opensOf = async (q: string, scopeView: string, title: string) => ((await call("workspace.find", { q, view: scopeView, perType: 4 })).value as Found | undefined)?.groups?.flatMap((group) => group.items ?? []).find((item) => item.title.includes(title))?.open.kind ?? null;
  const comicOpens = await opensOf(titles.comic.slice(0, 2), "comic", titles.comic);
  detail.comicOpens = comicOpens;
  await clickTestId(view, "search-result-comic", 2000);
  const firstOpened = comicOpens === "work" ? await waitDrawn(view, "page-work", 6000) : comicOpens === "resource" ? await frontKind("reader") : false;
  const firstBoxGone = await gone();
  if (!firstOpened || !firstBoxGone) problems.push(`a ${comicOpens ?? "?"} found by name opened ${firstOpened ? "its page or reader" : `nothing (tabs ${JSON.stringify((await tabsOf(view)).map((tab) => `${tab.kind}:${tab.focused}`))})`} and the box ${firstBoxGone ? "closed" : "stayed"}`);
  // A work found by name opens on its own page: the walk's animation work, in its scope.
  await closeTabs(view, "all");
  await kit.showView("video");
  await clickTestId(view, "sidebar-search", 3000);
  await opened();
  await type(titles.video.slice(0, 2));
  const videoOpens = await opensOf(titles.video.slice(0, 2), "video", titles.video);
  detail.videoOpens = videoOpens;
  await clickTestId(view, "search-result-video", 2000);
  const workPage = await waitDrawn(view, "page-work", 6000);
  const workBoxGone = await gone();
  if (videoOpens !== "work" || !workPage || !workBoxGone) problems.push(`a work found by name (${videoOpens ?? "?"}) opened ${workPage ? "its page" : "nothing"} and the box ${workBoxGone ? "closed" : "stayed"}`);
  await closeTabs(view, "all");

  // Without the scope: projects, whiteboards and the notes by name, each kind in its own group.
  await kit.showView("comic");
  const again = await byKey();
  const scopedAgain = await kit.drawn("search-scope");
  await clickTestId(view, "search-scope-remove", 2000);
  await type("截图");
  const unscoped = await results();
  const hasProject = unscoped.some((row) => row.startsWith("project:") && row.includes("窗口截图项目"));
  const hasBoard = unscoped.some((row) => row.startsWith("whiteboard:") && row.includes("截图白板"));
  if (!again || !scopedAgain || !hasProject || !hasBoard || (await kit.drawn("search-scope"))) problems.push(`Ctrl+K from the comic view: ${again}, scope ${scopedAgain}; without the scope "截图" found ${JSON.stringify(unscoped)}`);
  detail.unscoped = unscoped;
  // The rows are seen in the box: it is as tall as what it lists, and nothing but the row is on the row.
  const seen = await js<boolean>(view, `(() => {
    const box = ${kit.at("search-box")};
    const row = document.querySelector('[data-testid="search-results"] [data-testid^="search-result-"]');
    if (!box || !row) return false;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.height > 8 && r.top >= b.top && r.bottom <= b.bottom + 1 && Boolean(hit) && row.contains(hit);
  })()`);
  if (!seen) problems.push("the first name found is not seen in the box: it is cut off, or something is over it");
  await shot("search-box");
  await type("轨道笔记");
  const notes = await results();
  if (notes.filter((row) => row.startsWith("note:")).length < 4) problems.push(`"轨道笔记" found ${JSON.stringify(notes)}`);
  // The texts: Enter on a word that is in no name searches the texts of notes and resources; a hit opens in the context it belongs to (the note is in 最近, where the window is).
  await type(seeded.needle);
  const noNames = await kit.drawn("search-names-none");
  await pressKey(view, "Enter");
  const counted = await waitDrawn(view, "search-count", 6000);
  const hit = await waitDrawn(view, "search-hit-note-0", 3000);
  if (!noNames || !counted || !hit) problems.push(`the texts: no name matched ${noNames}, a count ${counted}, a note's hit ${hit}`);
  await clickTestId(view, "search-hit-note-0", 2000);
  const noteOpen = await frontKind("note");
  const noteHome = (await kit.hostKey()) === "";
  const boxGone = await gone();
  if (!noteOpen || !noteHome || !boxGone) problems.push(`a hit in the texts opened ${noteOpen ? "the note" : "no note"} in ${noteHome ? "最近" : "another context"} and the box ${boxGone ? "closed" : "stayed"}`);

  // A conversation of a project opens in the project, whatever context the window is in; so does the project's whiteboard, from 最近 again.
  // The box is opened from the home, whatever view was last: the home has no scope.
  await kit.showView("home");
  const forConversation = await byKey();
  await type("轨道项目对话");
  const conversationListed = await waitUntil(view, `Boolean(document.querySelector('[data-testid="search-result-conversation"]'))`, 6000);
  if (!conversationListed) detail.conversationResults = await results();
  const conversationRow = conversationListed && await clickTestId(view, "search-result-conversation", 3000);
  const inProject = conversationRow && await waitContext(view, projectId, 6000);
  const conversationTab = await frontKind("conversation");
  if (!forConversation || !conversationRow || !inProject || !conversationTab) problems.push(`the project's conversation from the box: opened ${forConversation}, clicked ${conversationRow}, project ${inProject}, tab ${conversationTab}`);
  await kit.showView("home");
  if (await clickTestId(view, "context-open-recent", 3000)) await waitContext(view, "");
  const forBoard = await byKey();
  await type("截图白板");
  const boardListed = await waitUntil(view, `Boolean(document.querySelector('[data-testid="search-result-whiteboard"]'))`, 6000);
  if (!boardListed) detail.boardResults = await results();
  const boardRow = boardListed && await clickTestId(view, "search-result-whiteboard", 3000);
  const boardIn = boardRow && await waitContext(view, projectId, 6000);
  const boardTab = await frontKind("whiteboard");
  if (!forBoard || !boardRow || !boardIn || !boardTab) problems.push(`the project's whiteboard from the box: opened ${forBoard}, clicked ${boardRow}, project ${boardIn}, tab ${boardTab}`);

  // Ctrl+K from a view carries the view as the scope, from the home none; Esc closes it and the focus goes back to where it was.
  await kit.showView("comic");
  const comicBox = await byKey();
  const comicScope = comicBox && (await kit.drawn("search-scope"));
  await pressKey(view, "Escape");
  await gone();
  await kit.showView("home");
  await js(view, `${kit.at("shell-sidebar-toggle")}.focus()`);
  const homeBox = await byKey();
  const homeScope = await kit.drawn("search-scope");
  await pressKey(view, "Escape");
  const closed = await gone();
  const focusBack = await js<boolean>(view, `document.activeElement === ${kit.at("shell-sidebar-toggle")}`);
  if (!comicScope || !homeBox || homeScope || !closed || !focusBack) problems.push(`Ctrl+K: scope from the comic view ${comicScope}, from the home box ${homeBox} with scope ${homeScope}; Esc closed it ${closed}, focus back ${focusBack}`);
  // Nothing of it is a tab or an icon.
  if ((await kinds()).includes("search") || await kit.drawn("nav-search")) problems.push("a search tab or a search icon is on the window");
  observe("search-popup", problems.length === 0, { problems, ...detail });
  await closeTabs(view, "all");
  if (await clickTestId(view, "context-open-recent", 3000)) await waitContext(view, "");
  await closeTabs(view, "all");
}

// ----------------------------------------------------------------------------------------------------------------------------- settings-view

type Marks = { same: boolean; emptied: number; loads: number; time: number; paused: boolean; ready: number };

async function walkSettings(env: RailEnv, kit: Kit): Promise<void> {
  const { view, call, observe, shot, videoId } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await leaveSettings(view);
  await closeTabs(view, "all");
  await kit.showView("home");
  // A video that is playing, marked, with the events that would tell a new load counted.
  const video = videoId ? await openFromShelf(view, "video", videoId, 8000) : false;
  const ready = video && await waitUntil(view, `document.querySelector('[data-testid="video-reader"][data-ready]')`, 40_000);
  if (!ready) { observe("settings-view", false, { problems: ["the video did not become ready"] }); return; }
  const playing = await js<boolean>(view, `(() => {
    const v = document.querySelector('[data-testid="video-element"]');
    v.__marked = "settings-view"; v.__emptied = 0; v.__loads = 0;
    v.addEventListener("emptied", () => { v.__emptied += 1; });
    v.addEventListener("loadstart", () => { v.__loads += 1; });
    v.muted = true;
    v.currentTime = 0.3;
    return v.play().then(() => true, () => false);
  })()`);
  await sleep(700);
  const marks = () => js<Marks>(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); return { same: Boolean(v) && v.__marked === "settings-view" && v.isConnected, emptied: v?.__emptied ?? -1, loads: v?.__loads ?? -1, time: v?.currentTime ?? -1, paused: v?.paused ?? true, ready: v?.readyState ?? 0 }; })()`);
  const playingNow = await marks();
  if (!playing || playingNow.paused) problems.push("the video could not be made to play");
  const tabsBefore = (await tabsOf(view)).map((tab) => `${tab.id}|${tab.kind}|${tab.title}|${tab.focused}`);
  const hostBefore = await settledHost(view);
  const dockBefore = await kit.drawn("shell-dock");
  const sidebarBefore = await kit.rect("shell-sidebar");
  const timeBefore = (await marks()).time;
  detail.before = { tabs: tabsBefore.length, columns: hostBefore?.columns, dock: dockBefore, time: Number(timeBefore.toFixed(2)) };

  // In: the settings view takes the window. The workspace is still there, out of sight and out of reach, and the player is not loaded again.
  await pointerClick(view, "nav-settings", 3000);
  const inside = await waitDrawn(view, "settings-area", 4000);
  await waitDrawn(view, "settings-nav", 3000);
  const facts = await js<{ suspended: string | null; inert: boolean; hidden: boolean; mounted: boolean; dockShown: boolean; composerShown: boolean; sidebarView: string | null; current: string[]; area: string | null }>(view, `(() => {
    const area = ${kit.at("workspace-area")};
    const dock = ${kit.at("shell-dock")};
    const composer = ${kit.at("agent-composer")};
    return {
      suspended: area?.getAttribute("data-suspended") ?? null,
      inert: Boolean(area) && area.hasAttribute("inert"),
      hidden: Boolean(area) && getComputedStyle(area).visibility === "hidden",
      mounted: Boolean(document.querySelector('[data-testid="video-element"]')?.isConnected),
      dockShown: ${DRAWN}(dock),
      composerShown: ${DRAWN}(composer),
      sidebarView: ${kit.at("shell-sidebar")}?.getAttribute("data-view") ?? null,
      current: [...document.querySelectorAll('[data-testid="shell-rail"] [aria-current="page"]')].map((el) => el.getAttribute("data-testid") ?? ""),
      area: ${kit.at("settings-area")}?.getAttribute("data-page") ?? null,
    };
  })()`);
  const inMarks = await marks();
  if (!inside || facts.suspended !== "true" || !facts.inert || !facts.hidden || !facts.mounted) problems.push(`entering settings: ${JSON.stringify(facts)}`);
  if (facts.dockShown || facts.composerShown) problems.push("the dock is still drawn over the settings");
  if (facts.sidebarView !== "settings" || JSON.stringify(facts.current) !== JSON.stringify(["nav-settings"])) problems.push(`the directory is not where the sidebar was, or the rail marks ${JSON.stringify(facts.current)}`);
  if (!inMarks.same || inMarks.emptied !== 0 || inMarks.loads !== 0) problems.push(`the player was taken out or loaded again while the settings were on (${JSON.stringify(inMarks)})`);
  const firstPage = facts.area;
  const directory = await js<{ pages: number; withPicture: number; withText: number; groups: number }>(view, `(() => {
    const items = [...document.querySelectorAll('[data-testid^="settings-nav-"]')];
    return { pages: items.length, withPicture: items.filter((el) => el.querySelector("svg")).length, withText: items.filter((el) => (el.textContent ?? "").trim().length > 0).length, groups: document.querySelectorAll('[data-testid^="settings-group-"]').length };
  })()`);
  if (directory.pages < 12 || directory.withPicture !== directory.pages || directory.withText !== directory.pages || directory.groups !== 3) problems.push(`the directory is ${JSON.stringify(directory)}`);
  const sidebarIn = await kit.rect("shell-sidebar");
  if (sidebarBefore && sidebarIn && !near(sidebarBefore.w, sidebarIn.w, 2)) problems.push("the directory is not as wide as the sidebar");
  detail.directory = directory;
  detail.inside = { ...facts, marks: inMarks };

  // The filter narrows the pages by name; nothing found says so; clearing brings them back.
  await setField(view, "settings-filter", "快捷键");
  await sleep(250);
  const filtered = await js<string[]>(view, `[...document.querySelectorAll('[data-testid^="settings-nav-"]')].map((el) => (el.getAttribute("data-testid") ?? "").slice("settings-nav-".length))`);
  if (!filtered.includes("shortcuts") || filtered.length >= directory.pages) problems.push(`the filter "快捷键" leaves ${JSON.stringify(filtered)} of ${directory.pages} pages`);
  await setField(view, "settings-filter", "没有这个名字的设置页zz");
  await sleep(250);
  const none = await kit.drawn("settings-filter-none");
  await clickTestId(view, "settings-filter-clear", 2000);
  await sleep(250);
  const restored = await js<number>(view, `document.querySelectorAll('[data-testid^="settings-nav-"]').length`);
  if (!none || restored !== directory.pages) problems.push(`the filter: nothing found says so ${none}, ${restored} pages after clearing`);
  await shot("settings-view");

  // Back has two stages: through the pages that were visited (and forward again), and then out of the settings.
  const pageOf = () => kit.attr("settings-area", "data-page");
  const target = firstPage === "models" ? "reading" : "models";
  await clickTestId(view, `settings-nav-${target}`, 3000);
  await clickTestId(view, "settings-nav-logs", 3000);
  await waitUntil(view, `${kit.at("settings-area")}?.getAttribute("data-page") === "logs"`, 3000);
  const steps: Array<string | null> = [await pageOf()];
  await clickTestId(view, "nav-back", 2000);
  await sleep(150);
  steps.push(await pageOf());
  const forwardOk = await js<boolean>(view, `!${kit.at("nav-forward")}?.disabled`);
  await clickTestId(view, "nav-forward", 2000);
  await sleep(150);
  steps.push(await pageOf());
  for (let n = 0; n < 2; n += 1) { await clickTestId(view, "nav-back", 2000); await sleep(150); }
  steps.push(await pageOf());
  const stillIn = await kit.drawn("settings-area");
  await clickTestId(view, "nav-back", 2000);
  await sleep(150);
  steps.push(await pageOf());
  const stillInAtFirst = await kit.drawn("settings-area");
  if (stillInAtFirst) { await clickTestId(view, "nav-back", 2000); await sleep(150); }
  const outAfter = !(await kit.drawn("settings-area"));
  detail.back = { steps, forwardOk, stillIn, stillInAtFirst, outAfter };
  if (steps[0] !== "logs" || steps[1] !== target || steps[2] !== "logs" || steps[3] !== firstPage || !forwardOk || !stillIn || !outAfter) problems.push(`back and forward walked ${JSON.stringify(steps)} (first page ${firstPage}, forward offered ${forwardOk}, still inside at the first page ${stillIn}, out after ${outAfter})`);
  if (!outAfter) await leaveSettings(view);

  // Out: the workspace as it was; the player is the element that was left, was not loaded again, and is at the second it was at.
  const outMarks = await waitUntil(view, `(() => { const area = ${kit.at("workspace-area")}; return area?.getAttribute("data-suspended") === "false" && !area.hasAttribute("inert"); })()`, 4000);
  await waitUntil(view, `${DRAWN}(${kit.at("video-reader")})`, 4000);
  await sleep(400);
  const after = await marks();
  const tabsAfter = (await tabsOf(view)).map((tab) => `${tab.id}|${tab.kind}|${tab.title}|${tab.focused}`);
  const hostAfter = await settledHost(view);
  const dockAfter = await kit.drawn("shell-dock");
  if (!outMarks) problems.push("the workspace is still suspended after leaving the settings");
  if (!after.same || after.emptied !== 0 || after.loads !== 0 || after.ready < 2) problems.push(`the player after the settings: ${JSON.stringify(after)}`);
  if (after.time < timeBefore - 0.15 || after.time > timeBefore + 2.5) problems.push(`the film was at ${timeBefore.toFixed(2)} s when the settings came and is at ${after.time.toFixed(2)} s when they went`);
  if (JSON.stringify(tabsAfter) !== JSON.stringify(tabsBefore)) problems.push(`the tabs were ${JSON.stringify(tabsBefore)} and are ${JSON.stringify(tabsAfter)}`);
  if (JSON.stringify({ ...hostAfter, rects: null }) !== JSON.stringify({ ...hostBefore, rects: null })) problems.push("the layout of the workspace is not what it was");
  if (dockAfter !== dockBefore) problems.push("the dock is not as it was");
  const saved = ((await call("workspace.loadContext", { contextId: hostAfter?.key === "" ? null : hostAfter?.key ?? null })).value as { state?: { tabs?: Array<{ kind: string }> } } | undefined)?.state?.tabs ?? [];
  if (saved.some((tab) => ["settings", "search", "plugins", "keys"].includes(tab.kind))) problems.push("a settings tab was saved in the context");
  detail.after = { ...after, time: Number(after.time.toFixed(2)), before: Number(timeBefore.toFixed(2)) };

  // An icon of the rail, pressed while the settings are on, leaves them for that view; the video is still the same element.
  await pointerClick(view, "nav-settings", 3000);
  await waitDrawn(view, "settings-area", 3000);
  await pointerClick(view, "nav-comic", 3000);
  const leftByIcon = await waitUntil(view, `!${DRAWN}(${kit.at("settings-area")})`, 3000);
  const sidebarComic = await waitUntil(view, `${kit.at("sidebar")}?.getAttribute("data-view") === "comic"`, 3000);
  const last = await marks();
  if (!leftByIcon || !sidebarComic || !last.same || last.emptied !== 0 || last.loads !== 0) problems.push(`an icon pressed in the settings: left ${leftByIcon}, comic sidebar ${sidebarComic}, player ${JSON.stringify(last)}`);
  // Ctrl+, is another way in (the key table's global.settings): the settings come up over the comic view, and the player is still the same element.
  await pressChord(view, ",", ["control"]);
  const byChord = await waitDrawn(view, "settings-area", 3000);
  const chordMarks = await marks();
  if (!byChord || !chordMarks.same || chordMarks.emptied !== 0 || chordMarks.loads !== 0) problems.push(`Ctrl+, : the settings came ${byChord}, player ${JSON.stringify(chordMarks)}`);
  await leaveSettings(view);
  // The sidebar's color in the dark theme too: one picture.
  await kit.showView("home");
  await js(view, `document.documentElement.setAttribute("data-theme", "dark")`);
  await sleep(300);
  await shot("sidebar-dark");
  await js(view, `document.documentElement.removeAttribute("data-theme")`);
  await sleep(200);
  await closeTabs(view, "all");
  observe("settings-view", problems.length === 0, { problems, ...detail });
}

// ------------------------------------------------------------------------------------------------------------------------ legacy-tabs-dropped

async function walkLegacy(env: RailEnv, kit: Kit): Promise<void> {
  const { view, appService, call, observe } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await leaveSettings(view);
  // A project the window has not opened: its saved layout still holds the search, the settings, the plug-ins and the shortcuts, as one saved before this version does.
  const made = await call("project.create", { name: "旧版标签项目" });
  const legacy = String((made.value as { id?: string } | undefined)?.id ?? "");
  const tab = (id: string, kind: string, target: Record<string, unknown>, title: string) => ({ id, kind, target, title, view: {} });
  const saved = {
    version: 1 as const, preset: "two" as const, layout: null,
    tabs: [
      tab("lg-lib", "library", { page: "overview" }, "资料库"),
      tab("lg-search", "search", { query: "旧" }, "搜索"),
      tab("lg-settings", "settings", { page: "general" }, "设置"),
      tab("lg-plugins", "plugins", {}, "插件"),
      tab("lg-keys", "keys", {}, "快捷键"),
      tab("lg-records", "records", { section: "records", type: "note" }, "笔记"),
    ],
    focusedTab: "lg-settings",
    closed: [tab("lg-closed-settings", "settings", { page: "models" }, "设置"), tab("lg-closed-search", "search", {}, "搜索")],
  };
  const stored = await call("workspace.saveContext", { contextId: legacy, state: saved });
  if (stored.status !== "ok") problems.push(`the layout could not be saved: ${JSON.stringify(stored.error ?? null).slice(0, 200)}`);
  // The window finds the project in the sidebar (a view asks again when it is shown) and goes into it.
  await kit.showView("conversation");
  await kit.showView("home");
  const listed = await waitDrawn(view, `context-open-${legacy}`, 8000);
  if (!listed) problems.push("the project is not in the sidebar");
  else await clickTestId(view, `context-open-${legacy}`, 3000);
  const there = listed && await waitContext(view, legacy, 8000);
  const facts = await settledHost(view);
  const chips = await tabsOf(view);
  const chip = await focusedChip(view);
  const kinds = chips.map((item) => item.kind);
  detail.tabs = chips.map((item) => `${item.kind}:${item.title}`);
  if (!there) problems.push("the window did not go into the project");
  if (JSON.stringify(kinds.slice().sort()) !== JSON.stringify(["library", "records"])) problems.push(`the tabs are ${JSON.stringify(kinds)}, not the two that are tabs still`);
  if (chip?.id !== "lg-lib") problems.push(`the focus is on ${chip?.id ?? "nothing"}, not on the first tab that is left`);
  if ((facts?.columns ?? 0) !== 2) problems.push(`the layout has ${facts?.columns} column(s), not the two it was saved with`);
  if (await js<boolean>(view, `Boolean(document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab"][data-kind="settings"], [data-testid="context-host"][data-active="true"] [data-testid="tab"][data-kind="search"], [data-testid="context-host"][data-active="true"] [data-testid="tab"][data-kind="plugins"], [data-testid="context-host"][data-active="true"] [data-testid="tab"][data-kind="keys"]'))`)) problems.push("a tab of a kind that is gone is drawn");
  // The command gives the same, and the next save of the window writes the library's row without them and with nothing else changed.
  const loaded = ((await call("workspace.loadContext", { contextId: legacy })).value as { state?: { tabs?: Array<{ id: string; kind: string }>; closed?: unknown[]; preset?: string } } | undefined)?.state;
  if (!loaded || loaded.tabs?.some((item) => ["search", "settings", "plugins", "keys"].includes(item.kind)) || (loaded.closed?.length ?? 0) !== 0 || loaded.preset !== "two") problems.push(`the command answers ${JSON.stringify(loaded)?.slice(0, 200)}`);
  if (chips.some((item) => item.id === "lg-records") && await js(view, `(() => { const el = document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab"][data-tab="lg-records"]'); if (!el) return false; el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })); return true; })()`)) await sleep(1800);
  const row = appService.store.sqlite.prepare("SELECT state_json FROM workspace_contexts WHERE context_id = ?").get(legacy) as { state_json: string } | undefined;
  const rewritten = row ? (JSON.parse(row.state_json) as { tabs: Array<{ id: string; kind: string }>; closed: unknown[]; preset: string }) : null;
  if (!rewritten || rewritten.tabs.some((item) => ["search", "settings", "plugins", "keys"].includes(item.kind)) || rewritten.closed.length !== 0 || rewritten.preset !== "two" || rewritten.tabs.length !== 2) problems.push(`the saved row after the window's own save is ${row?.state_json.slice(0, 200) ?? "missing"}`);
  detail.rewritten = rewritten?.tabs.map((item) => item.kind);
  await closeTabs(view, "all");
  await kit.showView("home");
  if (await clickTestId(view, "context-open-recent", 3000)) await waitContext(view, "");
  observe("legacy-tabs-dropped", problems.length === 0, { problems, ...detail });
}

// ------------------------------------------------------------------------------------------------------------------------------------- the walk

export async function runRailWalk(env: RailEnv): Promise<void> {
  const { view, call } = env;
  const kit = makeKit(view, call);
  await toRail(view);
  await env.resize("wide");
  const seeded = await seed(env);
  await walkViews(env, kit, seeded);
  await walkHideMore(env, kit);
  await walkHoverCard(env, kit);
  await walkSearch(env, kit, seeded);
  await walkSettings(env, kit);
  await walkLegacy(env, kit);
}
