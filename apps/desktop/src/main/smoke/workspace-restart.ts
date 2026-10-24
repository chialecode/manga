import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { clickTestId, closeTabs, openFromShelf, openLibrary, openProjectsPage, pointerClick, pressKey, showTab, sleep, tabsOf, waitDrawn, waitForTestId, waitUntil, type TabFact } from "./driver.ts";
import { js, leaveSettings, toRail, type caller, type FlowResult } from "./common.ts";
import { hostFacts, waitContext } from "./workspace-walk.ts";
import { hideRailIcon, railHidden, railOrder } from "./rail-walk.ts";
import type { Observation } from "./window-walk.ts";

/**
 * What a restart and an upgrade leave of the workspace, in the packaged window (AT-110, plan 4.8, 7).
 *
 * `prepareRestart` ends the window walk: it puts two contexts into a known shape by the same menus and clicks a person uses, waits for the saves to reach the
 * library and writes down what the window showed. `runRestartSmoke` is the next start of the same Profile and compares: the context the window was left in,
 * the tabs of each context in order with the one in front, the columns, and a reader that really opens from its restored tab. `runMigratedSmoke` starts on
 * a synthetic v11 library of the two-mode shell (tests/helpers/legacy-v11.ts), made before the application had ever seen it, and checks that the
 * conversations and the open resources are where plan 4.8 puts them.
 */

export const RESTART_OBSERVATION = "workspace-restart";
export const MIGRATED_OBSERVATION = "migrated-profile";

type Call = ReturnType<typeof caller>;
type Shape = { key: string; columns: number; tabs: Array<{ kind: string; title: string }>; focused: { kind: string; title: string } | null };
type Snapshot = {
  prepared: boolean; active: string; contexts: Shape[]; persisted: Array<{ key: string; kinds: string[]; focusedKind: string | null; preset: string }>; problems: string[];
  /** The icons taken out of the rail before the quit, and the icons the rail drew then. */
  rail?: { hidden: string[]; icons: string[]; settingsPage: string | null };
};

const SNAPSHOT_FILE = "workspace-restart.json";

const shapeOf = async (view: BrowserWindow, key: string): Promise<Shape> => {
  const facts = await hostFacts(view);
  const chips = await tabsOf(view);
  const focused = chips.find((chip) => chip.focused);
  return { key, columns: facts?.columns ?? 0, tabs: chips.map((chip: TabFact) => ({ kind: chip.kind, title: chip.title })), focused: focused ? { kind: focused.kind, title: focused.title } : null };
};

const sameShape = (a: Shape, b: Shape) => a.columns === b.columns && JSON.stringify(a.tabs) === JSON.stringify(b.tabs) && JSON.stringify(a.focused) === JSON.stringify(b.focused);

/** The state the library holds for a context, as the window has saved it. */
async function persistedOf(call: Call, key: string) {
  const got = (await call("workspace.loadContext", { contextId: key || null })).value as { state?: { tabs?: Array<{ id: string; kind: string }>; focusedTab?: string | null; preset?: string } } | undefined;
  const tabs = got?.state?.tabs ?? [];
  return { key, kinds: tabs.map((tab) => tab.kind), focusedKind: tabs.find((tab) => tab.id === got?.state?.focusedTab)?.kind ?? null, preset: String(got?.state?.preset ?? "") };
}

/** Called when the window walk is over: the shape the next start has to find. */
export async function prepareRestart(env: { view: BrowserWindow; call: Call; observe: (name: string, ok: boolean, detail: unknown) => boolean; logsDir: string; novelId: string | null; projectId: string }): Promise<void> {
  const { view, call, logsDir, novelId, projectId } = env;
  const problems: string[] = [];
  await toRail(view);
  await closeTabs(view, "all");
  // 最近: the library and a book side by side.
  if (!(await clickTestId(view, "context-open-recent", 5000)) || !(await waitContext(view, ""))) problems.push("the window did not go to 最近");
  await closeTabs(view, "all");
  const opened = novelId ? await openFromShelf(view, "novel", novelId, 10_000, []) : false;
  if (!opened) problems.push("the book did not open in 最近");
  if (!(await openLibrary(view, 4000))) problems.push("the library did not open in 最近");
  await clickTestId(view, "layout-menu", 3000);
  if (!(await clickTestId(view, "layout-two", 3000))) problems.push("the two-column layout was not offered");
  await sleep(700);
  // The project: its own page, in one column, and the window is left in it.
  if (!(await clickTestId(view, `context-open-${projectId}`, 5000)) || !(await waitContext(view, projectId))) problems.push("the window did not go to the project");
  await closeTabs(view, "all");
  await openProjectsPage(view, 4000);
  await waitUntil(view, `document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab"][data-kind="project"]')`, 6000);
  await sleep(1200);
  const contexts = [await shapeOf(view, projectId)];
  if (await clickTestId(view, "context-open-recent", 5000) && await waitContext(view, "")) contexts.unshift(await shapeOf(view, ""));
  if (await clickTestId(view, `context-open-${projectId}`, 5000)) await waitContext(view, projectId);
  await sleep(1200);
  const active = (await hostFacts(view))?.key ?? "";
  const persisted = [await persistedOf(call, ""), await persistedOf(call, projectId)];
  for (const shape of contexts) {
    const saved = persisted.find((row) => row.key === shape.key);
    if (!saved || JSON.stringify(saved.kinds.slice().sort()) !== JSON.stringify(shape.tabs.map((tab) => tab.kind).sort())) problems.push(`the saved tabs of ${shape.key || "最近"} are not the tabs on screen`);
  }
  const recent = contexts.find((shape) => shape.key === "");
  if (!recent || recent.columns !== 2 || !recent.tabs.some((tab) => tab.kind === "reader") || !recent.tabs.some((tab) => tab.kind === "library")) problems.push("最近 was not left with a book and the library in two columns");
  const project = contexts.find((shape) => shape.key === projectId);
  if (!project || !project.tabs.some((tab) => tab.kind === "project")) problems.push("the project was not left with its page");
  if (active !== projectId) problems.push("the window was not left in the project");
  // An icon taken out of the rail with its menu is still out at the next start (A-99); the shell kept it, and "…" lists it.
  const iconsAll = await railOrder(view);
  if (!(await hideRailIcon(view, "whiteboard"))) problems.push("the whiteboard icon could not be taken out of the rail");
  const shell = (await call("settings.getShell", {})).value as { rail?: { settingsPage?: string | null } } | undefined;
  const rail = { hidden: await railHidden(call), icons: await railOrder(view), settingsPage: shell?.rail?.settingsPage ?? null };
  if (!rail.settingsPage) problems.push("the shell kept no settings page after the walk went through them");
  if (JSON.stringify(rail.hidden) !== JSON.stringify(["whiteboard"]) || rail.icons.length !== iconsAll.length - 1) problems.push(`the rail is ${JSON.stringify(rail.icons)} with ${JSON.stringify(rail.hidden)} kept as out`);
  const snapshot: Snapshot = { prepared: problems.length === 0, active, contexts, persisted, problems, rail };
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`);
  env.observe("workspace-restart-prepared", problems.length === 0, { problems, contexts: contexts.map((shape) => ({ key: shape.key ? "project" : "recent", columns: shape.columns, tabs: shape.tabs.length })) });
}

/** The next start of the Profile the window walk used. */
export async function runRestartSmoke(input: { view: BrowserWindow; call: Call; logsDir: string }): Promise<FlowResult & { observations: Observation[] }> {
  const { view, call, logsDir } = input;
  const file = path.join(logsDir, SNAPSHOT_FILE);
  const observations: Observation[] = [];
  const observe = (name: string, ok: boolean, detail: unknown) => {
    observations.push({ name, status: ok ? "passed" : "failed", detail });
    console.error(`restart ${name}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 700)}`);
    return ok;
  };
  if (!fs.existsSync(file)) { observe(RESTART_OBSERVATION, false, { reason: "the walk before the restart left no record" }); return { ok: false, observations }; }
  const before = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  if (!before.prepared) problems.push(`the state before the restart was not the one prepared (${before.problems.join("; ")})`);
  await toRail(view);
  // The window comes back in the context it was left in, with that context's tabs.
  const activeRestored = await waitContext(view, before.active, 10_000);
  detail.activeRestored = activeRestored;
  if (!activeRestored) problems.push("the window did not come back in the context it was left in");
  const now: Shape[] = [];
  let at = before.active;
  for (const wanted of before.contexts) {
    if (wanted.key !== at) {
      const switched = await clickTestId(view, wanted.key ? `context-open-${wanted.key}` : "context-open-recent", 5000) && await waitContext(view, wanted.key);
      if (!switched) { problems.push(`${wanted.key ? "the project" : "最近"} could not be opened after the restart`); continue; }
      at = wanted.key;
    }
    await sleep(900);
    const shape = await shapeOf(view, wanted.key);
    now.push(shape);
    if (!sameShape(wanted, shape)) problems.push(`${wanted.key ? "the project's" : "最近's"} tabs are not as they were (${JSON.stringify(shape.tabs.map((tab) => tab.kind))}, ${shape.columns} columns, in front ${shape.focused?.kind ?? "nothing"})`);
  }
  detail.contexts = now.map((shape) => ({ key: shape.key ? "project" : "recent", columns: shape.columns, tabs: shape.tabs.map((tab) => tab.kind), focused: shape.focused?.kind ?? null }));
  // The saved state is the same as it was before the quit.
  const persisted = [await persistedOf(call, ""), await persistedOf(call, before.active || "")];
  for (const row of before.persisted) {
    const got = persisted.find((item) => item.key === row.key) ?? await persistedOf(call, row.key);
    if (JSON.stringify(got) !== JSON.stringify(row)) problems.push(`the saved state of ${row.key ? "the project" : "最近"} changed over the restart`);
  }
  // A tab that was not in front is brought up and shows its content, not an empty panel.
  const recent = before.contexts.find((shape) => shape.key === "");
  if (recent) {
    if (!(await clickTestId(view, "context-open-recent", 5000)) || !(await waitContext(view, ""))) problems.push("最近 could not be opened to show its reader");
    else if (!(await showTab(view, { kind: "reader" }))) problems.push("the book's tab could not be brought forward");
    else {
      const body = await waitForTestId(view, "reading-body", "data-present", null, 15_000);
      detail.readerBody = body;
      if (!body) problems.push("the book did not open from its restored tab");
    }
  }
  // The icon that was taken out of the rail is still out, "…" lists it with its pin, and the pin puts it back where it was.
  if (before.rail) {
    const icons = await railOrder(view);
    const kept = await railHidden(call);
    detail.rail = { icons: icons.length, kept };
    if (JSON.stringify(icons) !== JSON.stringify(before.rail.icons) || JSON.stringify(kept) !== JSON.stringify(before.rail.hidden)) problems.push(`after the restart the rail is ${JSON.stringify(icons)} with ${JSON.stringify(kept)} out, as it was before: ${JSON.stringify(before.rail.icons)}`);
    // The settings come up on the page that was used last (the shell kept it), outside any project's tabs; leaving them goes back to the context.
    const tabsIn = (await tabsOf(view)).map((tab) => tab.id).join(",");
    await pointerClick(view, "nav-settings", 3000);
    const settingsIn = await waitDrawn(view, "settings-area", 4000);
    const page = await js<string | null>(view, `document.querySelector('[data-testid="settings-area"]')?.getAttribute("data-page") ?? null`);
    await leaveSettings(view);
    detail.settingsPage = page;
    if (!settingsIn || page !== before.rail.settingsPage || (await tabsOf(view)).map((tab) => tab.id).join(",") !== tabsIn) problems.push(`after the restart the settings came up ${settingsIn ? `on ${page}, not on ${before.rail.settingsPage}` : "not at all"}, or left tabs changed`);
    if (!(await pointerClick(view, "rail-more", 3000)) || !(await waitDrawn(view, "rail-pin-whiteboard", 3000))) problems.push('"…" does not list the icon that was taken out');
    else {
      await pointerClick(view, "rail-pin-whiteboard", 3000);
      if (!(await waitDrawn(view, "nav-whiteboard", 3000))) problems.push("the pin did not put the icon back after the restart");
      await pressKey(view, "Escape");
    }
  }
  observe(RESTART_OBSERVATION, problems.length === 0, { problems, ...detail });
  return { ok: observations.every((row) => row.status === "passed"), observations };
}

/** The synthetic v11 library of tests/helpers/legacy-v11.ts, started on by the application for the first time. */
export async function runMigratedSmoke(input: { view: BrowserWindow; call: Call; dataDir: string }): Promise<FlowResult & { observations: Observation[] }> {
  const { view, call, dataDir } = input;
  const observations: Observation[] = [];
  const observe = (name: string, ok: boolean, detail: unknown) => {
    observations.push({ name, status: ok ? "passed" : "failed", detail });
    console.error(`migrated ${name}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 700)}`);
    return ok;
  };
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const rows = async (contextId: string | null) => ((await call("workspace.sessions", { contextId })).value as Array<{ sessionId: string; title: string; kind: string; contextId: string | null }> | undefined) ?? [];
  await toRail(view);

  // The library is v12 and the version before it was kept whole beside it, once.
  const backups = fs.readdirSync(dataDir).filter((name) => name.includes("premigrate"));
  detail.backups = backups.length;
  if (backups.length !== 1 || backups[0] !== "manga.sqlite.premigrate-v11") problems.push(`${backups.length} backups beside the library, not the one of v11`);

  // The window opens in the project the person was working in (the shell preference kept it), with the project's page as its tab.
  const inProject = await waitContext(view, "proj-a", 10_000);
  detail.startedInProject = inProject;
  if (!inProject) problems.push("the window did not open in the project the person was working in");
  else {
    await sleep(600);
    const tabs = await tabsOf(view);
    detail.projectTabs = tabs.map((tab) => tab.kind);
    if (tabs.length !== 1 || tabs[0]!.kind !== "project" || !tabs[0]!.title.includes("项目甲")) problems.push(`the project's tabs are ${JSON.stringify(tabs.map((tab) => `${tab.kind}:${tab.title}`))}, not its page`);
  }
  // The columns of the entertainment mode were kept: the sidebar 300 wide and the dock folded.
  const columns = await js<{ sidebar: number | null; dock: boolean }>(view, `({ sidebar: document.querySelector('[data-testid="shell-sidebar"]')?.getBoundingClientRect().width ?? null, dock: Boolean(document.querySelector('[data-testid="shell-dock"]')?.getClientRects().length) })`);
  detail.columns = columns;
  if (columns.sidebar === null || Math.abs(columns.sidebar - 300) > 3) problems.push(`the sidebar is ${columns.sidebar === null ? "gone" : Math.round(columns.sidebar)}px wide, not the 300 the old layout kept`);
  if (columns.dock) problems.push("the dock is open although the old layout had folded it");

  // Conversations: nothing was deleted, the two of one target in two modes are one and a general conversation, the project's belong to it.
  const recent = await rows(null);
  const projectA = await rows("proj-a");
  const projectB = await rows("proj-b");
  const byId = (list: typeof recent, id: string) => list.find((row) => row.sessionId === id);
  detail.counts = { recent: recent.length, projectA: projectA.length, projectB: projectB.length };
  if (recent.length !== 8 || projectA.length !== 1 || projectB.length !== 1) problems.push(`conversations by context are ${recent.length}, ${projectA.length}, ${projectB.length}, not 8, 1, 1`);
  const older = byId(recent, "ses-cre-res");
  if (!older || older.kind !== "shared" || older.title !== "书（工作）（原工作模式）") problems.push("the older conversation of the book is not a general conversation that says where it came from");
  const newer = byId(recent, "ses-ent-res");
  if (!newer || newer.kind !== "resource") problems.push("the newer conversation of the book is no longer the book's conversation");
  if (!byId(projectA, "ses-proj-a") || !byId(projectB, "ses-proj-b")) problems.push("a project lost its own conversation");
  // The one that was closed from the left rail is a conversation again like the others.
  if (!byId(recent, "ses-closed-res")) problems.push("the conversation closed from the old rail is gone");

  // In 最近: the book that was open comes back as a tab, and the conversations are on the sidebar.
  if (!(await clickTestId(view, "context-open-recent", 5000)) || !(await waitContext(view, ""))) problems.push("最近 could not be opened");
  else {
    await sleep(700);
    const tabs = await tabsOf(view);
    detail.recentTabs = tabs.map((tab) => `${tab.kind}`);
    const book = tabs.find((tab) => tab.kind === "reader");
    if (tabs.length !== 1 || !book || !book.title.includes("旧库作品")) problems.push(`最近 has ${JSON.stringify(tabs.map((tab) => `${tab.kind}:${tab.title}`))}, not the book that was open`);
    const listed = await js<string[]>(view, `[...document.querySelectorAll('[data-testid="sidebar-recent"] [data-testid^="session-open-"]')].map((el) => el.getAttribute("data-testid").slice("session-open-".length))`);
    detail.sidebarRows = listed.length;
    for (const id of ["ses-cre-res", "ses-shared-cre"]) if (!listed.includes(id) && !(await rows(null)).some((row) => row.sessionId === id)) problems.push(`${id} is not among the conversations of 最近`);
    // The book opens from its tab and the position it had in the old library is where it is read (percent and place were moved to 最近).
    if (book && await showTab(view, { kind: "reader" })) {
      const body = await waitForTestId(view, "reading-body", "data-present", null, 15_000);
      detail.bookOpens = body;
      if (!body) problems.push("the book did not open from the tab the old library's rail became");
    }
  }
  // Positions: the same rows, now the positions of 最近, and the second resource keeps its 40 percent.
  const position = (await call("progress.get", { contextId: null, resourceId: "res-legacy-2" })).value as { percent?: number } | undefined;
  detail.secondPercent = position?.percent ?? null;
  if (!position || Math.abs((position.percent ?? 0) - 0.4) > 1e-9) problems.push(`the second resource's position is ${position?.percent ?? "gone"}, not 0.4`);
  const noneInProject = (await call("progress.get", { contextId: "proj-a", resourceId: "res-legacy-2" })).value as { percent?: number } | undefined;
  if (noneInProject && (noneInProject.percent ?? 0) > 0) problems.push("a position of 最近 shows in the project");

  // The archived project is not among the contexts the person switches between, and the closed project still is.
  const contexts = ((await call("workspace.contexts", {})).value as { contexts?: Array<{ contextId: string | null; name: string }> } | undefined)?.contexts ?? [];
  detail.contexts = contexts.map((row) => row.contextId ?? "");
  if (contexts.some((row) => row.contextId === "proj-c")) problems.push("the archived project is among the contexts");
  if (!contexts.some((row) => row.contextId === "proj-b")) problems.push("the project closed from the old rail is gone");
  if (!(await waitDrawn(view, "shell-sidebar", 3000)) && columns.sidebar !== null) problems.push("the sidebar is not on screen");
  observe(MIGRATED_OBSERVATION, problems.length === 0, { problems, ...detail });
  return { ok: observations.every((row) => row.status === "passed"), observations };
}
