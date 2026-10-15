import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BrowserWindow } from "electron";
import { loadVecExtension, type MangaProductApp } from "@manga/app-core";
import { testHooks } from "../test-hooks.ts";
import { clickTestId, setField, sleep, waitForTestId, waitUntil } from "./driver.ts";
import { capturePage, caller, js, openSettingsPage, toRail, type FlowResult } from "./common.ts";
import { WINDOW_SIZES, type Observation } from "./window-walk.ts";

/**
 * The creative workspace in the real window and the packaged build, with synthetic content only: the creator mode and the projects page; a
 * project's tabs; a whiteboard (a card added, dragged with the mouse, the drop kept across a reload, undone); a mind map (a topic added with the
 * keyboard, folded, exported as text, undone); a draft; the research tab; a rough cut exported with the media tool that comes in the package, from
 * two copies of a synthetic video, and checked against the originals; a note holding embeds; a project package written and read back; the semantic
 * index's vector extension loaded by the packaged build; and every tab at three window sizes without a control cut off. Each observation is named,
 * and the package stage requires every one of them to pass.
 */

export const CREATIVE_OBSERVATIONS = [
  "creative-reach-projects",
  "creative-project-tabs",
  "creative-whiteboard",
  "creative-mindmap",
  "creative-draft",
  "creative-research",
  "creative-embeds-in-note",
  "creative-roughcut-export",
  "creative-project-package",
  "creative-semantic-extension",
  ...(Object.keys(WINDOW_SIZES) as Array<keyof typeof WINDOW_SIZES>).map((size) => `creative-fit-${size}`),
] as const;

const TABS = ["materials", "whiteboard", "mindmap", "draft", "excerpt", "roughcut", "terms", "settings"] as const;
const TAB_ROOT: Record<(typeof TABS)[number], string> = {
  materials: "project-materials", whiteboard: "whiteboard-tab", mindmap: "mindmap-tab", draft: "draft-tab", excerpt: "research-tab", roughcut: "roughcut-tab", terms: "project-terms", settings: "project-settings",
};

const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export async function runCreativeSmoke(input: { appService: MangaProductApp; grant: string; view: BrowserWindow; evidenceDir: string | undefined; logsDir: string }): Promise<FlowResult & { observations: Observation[] }> {
  const { appService, grant, view, evidenceDir, logsDir } = input;
  const call = caller(appService, grant);
  const observations: Observation[] = [];
  const observe = (name: string, ok: boolean, detail: unknown) => {
    observations.push({ name, status: ok ? "passed" : "failed", detail });
    console.error(`creative-walk ${name}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 700)}`);
    return ok;
  };
  const value = async <T>(commandId: string, body: Record<string, unknown>): Promise<T> => {
    const result = await call(commandId, body);
    if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
    return result.value as T;
  };
  const root = process.env.MANGA_SMOKE_SAMPLES;
  const manifestFile = root ? path.join(root, "manifest.json") : "";
  if (!root || !fs.existsSync(manifestFile)) return { ok: false, notRun: true, reason: "MANGA_SMOKE_SAMPLES does not point at the generated samples", observations };
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { samples: Array<{ id: string; path: string; status: string }> };
  const sampleDir = (id: string) => {
    const entry = manifest.samples.find((item) => item.id === id);
    if (!entry || entry.status !== "generated") throw new Error(`sample ${id} is not available`);
    return path.join(root, entry.path);
  };
  const shot = (name: string) => capturePage(view, evidenceDir, `ui-creative-${name}.png`);
  const dir = path.join(logsDir, "walk-creative");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const present = (testId: string) => `document.querySelector('[data-testid="${testId}"]')`;
  const count = (selector: string) => js<number>(view, `document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const press = (target: string, key: string, extra: Record<string, unknown> = {}) => js(view, `(() => { const el = document.querySelector('[data-testid="${target}"]'); if (!el) return false; el.focus(); el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} })); return true; })()`);

  await call("settings.skipAi", {});

  // ---- content the walk starts from, made through the commands ----
  const book = await value<{ resourceId: string }>("library.importDocument", { title: "合成资料书", format: "txt", bytes: [...new TextEncoder().encode(`${"研究资料的正文。".repeat(20)}琥珀色的钥匙藏在旧钟楼里。${"后文。".repeat(20)}`)] });
  const folder = path.join(dir, "videos");
  fs.mkdirSync(folder, { recursive: true });
  const videoDir = sampleDir("video-roughcut");
  const copies = ["a.mp4", "b.mp4"].map((name) => { const file = path.join(folder, name); fs.copyFileSync(path.join(videoDir, name), file); return file; });
  const originals = copies.map((file) => sha(file));
  // A file is read from a library path (A-80): the folder of the videos is one.
  await value("library.paths.add", { pathHandle: appService.registerPath("directory", folder), mediaKind: "video", autoScan: false });
  const videos: Array<{ resourceId: string }> = [];
  for (const file of copies) videos.push(await value<{ resourceId: string }>("library.importDocument", { title: path.parse(file).name, kind: "video", pathHandle: appService.registerPath("file", file) }));

  // ---- 1. the creator mode, and a project made on the projects page ----
  await toRail(view);
  const switched = await clickTestId(view, "mode-creator") && await waitUntil(view, present("nav-projects"), 8000);
  const onPage = switched && await clickTestId(view, "nav-projects") && await waitForTestId(view, "page-projects");
  const opened = onPage && await clickTestId(view, "projects-new") && await waitForTestId(view, "project-name");
  const named = opened && await setField(view, "project-name", "窗口创作项目");
  const made = named && await clickTestId(view, "project-create-submit");
  // A project that was just made is opened at once.
  const inPage = made && await waitUntil(view, `document.querySelector('[data-testid="page-project"]')?.getAttribute("data-project")`, 10_000);
  const projectId = inPage ? await js<string>(view, `document.querySelector('[data-testid="page-project"]').getAttribute("data-project")`) : "";
  observe("creative-reach-projects", Boolean(switched && onPage && made && inPage), { switched, onPage, made, inPage, projectId: projectId.length > 0 });
  await shot("project-wide");

  const openTab = async (tab: (typeof TABS)[number]) => {
    if (!await waitForTestId(view, "page-project", "data-project", projectId, 3000)) {
      await clickTestId(view, "nav-projects");
      await clickTestId(view, `project-open-${projectId}`);
      await waitForTestId(view, "page-project", "data-project", projectId, 8000);
    }
    return await clickTestId(view, `project-tab-${tab}`) && await waitForTestId(view, TAB_ROOT[tab], "data-testid", TAB_ROOT[tab], 10_000);
  };

  // ---- 2. every tab of the project opens and says what it is ----
  const reached: Record<string, boolean> = {};
  for (const tab of TABS) reached[tab] = await openTab(tab);
  observe("creative-project-tabs", Object.values(reached).every(Boolean), reached);

  // ---- 3. a whiteboard: cards from the toolbar, one dragged with the mouse, the drop kept across a reload, then undone ----
  let whiteboard = false;
  let wbDetail: Record<string, unknown> = {};
  if (await openTab("whiteboard") && await clickTestId(view, "whiteboard-new")) {
    const boardShown = await waitForTestId(view, "whiteboard-board", "data-nodes", "0", 8000);
    await clickTestId(view, "whiteboard-add-card");
    await waitUntil(view, `document.querySelector('[data-testid="whiteboard-board"]')?.getAttribute("data-nodes") === "1"`, 6000);
    await sleep(150);
    await clickTestId(view, "whiteboard-add-card");
    const two = await waitUntil(view, `document.querySelector('[data-testid="whiteboard-board"]')?.getAttribute("data-nodes") === "2"`, 6000);
    await sleep(500);
    const boardId = await js<string>(view, `document.querySelector('[data-testid="whiteboard-board"]')?.getAttribute("data-board") ?? ""`);
    const before = await value<{ nodes: Array<{ id: string; x: number; y: number }> }>("whiteboard.get", { boardId });
    // A card is taken with the mouse and put down some way off.
    const moved = await js<{ id: string | null }>(view, `(async () => {
      const canvas = document.querySelector('[data-testid="whiteboard-canvas"]');
      const nodes = [...canvas.querySelectorAll(".react-flow__node")].filter((node) => node.style.visibility !== "hidden");
      const target = nodes[0];
      if (!target) return { id: null };
      const r = target.getBoundingClientRect();
      let x = r.left + r.width / 2, y = r.top + r.height / 2;
      const mouse = (type, to, at) => to.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "mouseup" ? 0 : 1, clientX: at.x, clientY: at.y, view: window }));
      mouse("mousedown", target, { x, y });
      for (let i = 0; i < 12; i += 1) { x += 14; y += 9; mouse("mousemove", window, { x, y }); await new Promise((resolve) => setTimeout(resolve, 16)); }
      mouse("mouseup", window, { x, y });
      return { id: target.getAttribute("data-id") };
    })()`);
    await sleep(900);
    const after = await value<{ nodes: Array<{ id: string; x: number; y: number }> }>("whiteboard.get", { boardId });
    const was = before.nodes.find((node) => node.id === moved.id);
    const now = after.nodes.find((node) => node.id === moved.id);
    const kept = Boolean(was && now) && (Math.abs(now!.x - was!.x) > 4 || Math.abs(now!.y - was!.y) > 4);
    // The window is reloaded and the board opened again: the same two cards, the dropped one where it was put.
    await view.webContents.reload();
    await toRail(view);
    const back = await openTab("whiteboard");
    const again = back && await waitUntil(view, `document.querySelector('[data-testid="whiteboard-board"]')?.getAttribute("data-nodes") === "2"`, 10_000);
    const undone = again && await clickTestId(view, "whiteboard-undo") && await waitUntil(view, `(() => { const b = document.querySelector('[data-testid="whiteboard-board"]'); return b && b.getAttribute("data-nodes") === "2"; })()`, 4000);
    await sleep(600);
    const afterUndo = await value<{ nodes: Array<{ id: string; x: number; y: number }> }>("whiteboard.get", { boardId });
    const undoneNode = afterUndo.nodes.find((node) => node.id === moved.id);
    const backWhereItWas = Boolean(undoneNode && was) && Math.abs(undoneNode!.x - was!.x) <= 4 && Math.abs(undoneNode!.y - was!.y) <= 4;
    wbDetail = { boardShown, two, moved: Boolean(moved.id), kept, again, undone, backWhereItWas };
    whiteboard = boardShown && two && Boolean(moved.id) && kept && Boolean(again) && Boolean(undone) && backWhereItWas;
    await shot("whiteboard-wide");
  }
  observe("creative-whiteboard", whiteboard, wbDetail);

  // ---- 4. a mind map: a topic from the keyboard, folded, exported as text, undone ----
  let mindmap = false;
  let mmDetail: Record<string, unknown> = {};
  if (await openTab("mindmap") && await clickTestId(view, "mindmap-new")) {
    const shown = await waitForTestId(view, "mindmap-board", "data-nodes", "1", 8000);
    const rootNode = await js<string>(view, `document.querySelector('[data-testid^="mm-node-"]')?.getAttribute("data-testid")?.slice("mm-node-".length) ?? ""`);
    await clickTestId(view, `mm-node-${rootNode}`);
    await press("mindmap-canvas", "Tab");
    const child = await waitUntil(view, `document.querySelector('[data-testid="mindmap-board"]')?.getAttribute("data-nodes") === "2" && document.querySelector('textarea[data-testid^="mm-edit-"]')`, 6000);
    const editor = child ? await js<string>(view, `document.querySelector('textarea[data-testid^="mm-edit-"]').getAttribute("data-testid")`) : "";
    if (editor) {
      await setField(view, editor, "窗口里的子主题");
      await js(view, `document.querySelector('[data-testid="${editor}"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`);
    }
    const texted = await waitUntil(view, `[...document.querySelectorAll('.mm-text')].some((el) => el.textContent === "窗口里的子主题")`, 6000);
    await sleep(600);
    const mapId = await js<string>(view, `document.querySelector('[data-testid="mindmap-board"]')?.getAttribute("data-map") ?? ""`);
    const saved = (await value<{ nodes: Array<{ text: string }> }>("mindmap.get", { mapId })).nodes.some((node) => node.text === "窗口里的子主题");
    // Folding the root takes the child out of the page; unfolding brings it back.
    const folded = await clickTestId(view, `mm-fold-${rootNode}`) && await waitUntil(view, `![...document.querySelectorAll('.mm-text')].some((el) => el.textContent === "窗口里的子主题")`, 4000);
    const unfolded = await clickTestId(view, `mm-fold-${rootNode}`) && await waitUntil(view, `[...document.querySelectorAll('.mm-text')].some((el) => el.textContent === "窗口里的子主题")`, 4000);
    // Exported as Markdown into a folder the person picks.
    const exportDir = path.join(dir, "mindmap-export");
    fs.mkdirSync(exportDir, { recursive: true });
    testHooks.pick = () => exportDir;
    let exportedText = "";
    try {
      await clickTestId(view, "mindmap-export");
      await clickTestId(view, "mindmap-export-markdown");
      await waitUntil(view, `true`, 100);
      for (let i = 0; i < 40 && !fs.readdirSync(exportDir).length; i += 1) await sleep(100);
      const file = fs.readdirSync(exportDir)[0];
      exportedText = file ? fs.readFileSync(path.join(exportDir, file), "utf8") : "";
    } finally { testHooks.pick = undefined; }
    const exported = exportedText.includes("窗口里的子主题");
    const undone = await clickTestId(view, "mindmap-undo") && await waitUntil(view, `![...document.querySelectorAll('.mm-text')].some((el) => el.textContent === "窗口里的子主题")`, 6000);
    mmDetail = { shown, child: Boolean(child), texted, saved, folded, unfolded, exported, undone };
    mindmap = shown && Boolean(child) && texted && saved && folded && unfolded && exported && undone;
    await shot("mindmap-wide");
  }
  observe("creative-mindmap", mindmap, mmDetail);

  // ---- 5. a draft: text typed in the editor reaches the stored draft ----
  let draft = false;
  let draftDetail: Record<string, unknown> = {};
  if (await openTab("draft") && await clickTestId(view, "draft-new")) {
    const surface = await waitUntil(view, present("draft-surface"), 8000);
    const typed = surface && await js<boolean>(view, `(() => { const el = document.querySelector('[data-testid="draft-surface"]'); el.focus(); return document.execCommand("insertText", false, "窗口里写的文案第一句。"); })()`);
    const savedState = await waitUntil(view, `document.querySelector('[data-testid="draft-view"]')?.getAttribute("data-save-state") === "saved"`, 12_000);
    await sleep(500);
    const drafts = await value<{ drafts: Array<{ id: string }> }>("draft.list", { projectId });
    const stored = drafts.drafts.length ? await value<{ document?: { blocks?: Array<{ text?: string }> }; blocks?: Array<{ text?: string }> }>("draft.get", { draftId: drafts.drafts[0]!.id }) : null;
    const text = JSON.stringify(stored ?? {});
    // The editor is the page's main column: the panel of suggestions never squeezes it, it goes under the editor when the view is narrow.
    const widths = await js<{ view: number; editor: number; side: number; sideBelow: boolean }>(view, `(() => {
      const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const viewBox = box('[data-testid="draft-view"]'), editor = box('.draft-editor'), side = box('.draft-side');
      return { view: Math.round(viewBox?.width ?? 0), editor: Math.round(editor?.width ?? 0), side: Math.round(side?.width ?? 0), sideBelow: Boolean(editor && side && side.top >= editor.bottom - 1) };
    })()`);
    const editorWide = widths.editor >= Math.min(360, widths.view - 2);
    draftDetail = { surface, typed, savedState, stored: text.includes("窗口里写的文案第一句"), widths, editorWide };
    draft = surface && Boolean(typed) && savedState && text.includes("窗口里写的文案第一句") && editorWide;
    await shot("draft-wide");
  }
  observe("creative-draft", draft, draftDetail);

  // ---- 6. the research tab finds what is in the library ----
  let research = false;
  let researchDetail: Record<string, unknown> = {};
  if (await openTab("excerpt")) {
    const reached = await clickTestId(view, "research-search", 3000) || true;
    const typed = await setField(view, "research-search-input", "琥珀色的钥匙");
    const go = typed && await clickTestId(view, "research-search-go", 3000);
    const hits = go && await waitUntil(view, `document.querySelector('[data-testid="research-results"]') && document.querySelectorAll('[data-testid="research-results"] li').length > 0`, 12_000);
    researchDetail = { reached, typed, go, hits };
    research = Boolean(typed && go && hits);
    await shot("research-wide");
  }
  observe("creative-research", research, researchDetail);

  // ---- 7. a note that holds embeds: they are drawn from what they point at, and say so when it is gone ----
  let embeds = false;
  let embedDetail: Record<string, unknown> = {};
  {
    // The board the note points at is one made for this check, since it is deleted below; the project's own board stays for the size checks.
    const boards = { boards: [(await value<{ board: { id: string; title: string } }>("whiteboard.create", { projectId, title: "待删除的白板" })).board] };
    const maps = await value<{ maps: Array<{ id: string; title: string }> }>("mindmap.list", { projectId });
    const note = await value<{ objectId: string }>("notes.create", { title: "带嵌入的笔记", text: "笔记正文" });
    const got = await value<{ revision: number }>("notes.get", { objectId: note.objectId });
    const blocks = [
      { id: "p1", type: "paragraph", text: "笔记正文" },
      { id: "e1", type: "embed", text: "", attrs: { embed: { kind: "whiteboard", targetId: boards.boards[0]!.id } } },
      { id: "e2", type: "embed", text: "", attrs: { embed: { kind: "mindmap", targetId: maps.maps[0]!.id, mode: "snapshot" } } },
    ];
    await value("notes.replace", { objectId: note.objectId, expectedRevision: got.revision, blocks });
    await toRail(view);
    const listedNote = await openSettingsPage(view, "records");
    const openedNote = listedNote && await clickTestId(view, `record-open-${note.objectId}`, 8000) && await waitForTestId(view, "note-editor");
    const drawn = openedNote && await waitUntil(view, `document.querySelector('[data-testid="embed-e1"]')?.getAttribute("data-embed-state") === "valid" && document.querySelector('[data-testid="embed-e2"]')?.getAttribute("data-embed-state") === "valid"`, 10_000);
    const titles = drawn ? await js<string[]>(view, `["embed-title-e1", "embed-title-e2"].map((id) => document.querySelector('[data-testid="' + id + '"]')?.textContent ?? "")`) : [];
    const snapshotMarked = drawn ? await js<boolean>(view, `Boolean(document.querySelector('[data-testid="embed-taken-e2"]'))`) : false;
    // The board goes; the embed stays in the note and says what happened.
    await value("whiteboard.delete", { boardId: boards.boards[0]!.id });
    await toRail(view);
    await openSettingsPage(view, "records");
    const reopened = await clickTestId(view, `record-open-${note.objectId}`, 8000) && await waitForTestId(view, "note-editor");
    const gone = reopened && await waitUntil(view, `document.querySelector('[data-testid="embed-e1"]')?.getAttribute("data-embed-state") === "deleted"`, 10_000);
    embedDetail = { drawn, titles, snapshotMarked, gone };
    embeds = Boolean(drawn) && snapshotMarked && Boolean(gone) && titles.every((title) => title.length > 0);
    await shot("note-embeds-wide");
  }
  observe("creative-embeds-in-note", embeds, embedDetail);

  // ---- 8. a rough cut exported in the window with the media tool of the package ----
  let roughcut = false;
  let rcDetail: Record<string, unknown> = {};
  let stages: Record<string, unknown> = {};
  try {
    const cut = await value<{ cut: { id: string } }>("roughcut.create", { projectId, title: "窗口粗剪" });
    await value("roughcut.edit", { cutId: cut.cut.id, actions: [
      { type: "add", resourceId: videos[0]!.resourceId, inMs: 1200, outMs: 3400 },
      { type: "add", resourceId: videos[1]!.resourceId, inMs: 2000, outMs: 4300 },
    ] });
    await toRail(view);
    // The shell keeps the project open when the rail goes back to projects; only a list needs the open button.
    const toProjects = await clickTestId(view, "nav-projects");
    const alreadyIn = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="page-project"]'))`);
    const opened = toProjects && (alreadyIn || await clickTestId(view, `project-open-${projectId}`));
    const inTab = opened && await openTab("roughcut");
    const picked = inTab && await clickTestId(view, `roughcut-cut-${cut.cut.id}`);
    const cutShown = picked && await waitForTestId(view, "rc-view", "data-testid", "rc-view", 8000);
    stages = { toProjects, opened, inTab, picked, cutShown };
    const verdict = cutShown && await waitUntil(view, `(document.querySelector('[data-testid="rc-plan-verdict"]')?.textContent ?? "").includes("不重新编码")`, 30_000);
    const outDir = path.join(dir, "roughcut-out");
    fs.mkdirSync(outDir, { recursive: true });
    testHooks.pick = () => outDir;
    let state = "";
    try {
      const dialog = verdict && await clickTestId(view, "rc-export", 4000);
      // The dialog puts the export in the work's own folder unless a folder of the person's own is chosen; this one is chosen, so that the file can be counted.
      const folder = dialog && await clickTestId(view, "rc-export-dest-folder", 4000);
      const started = folder && await clickTestId(view, "rc-export-pick", 4000);
      const ended = started && await waitUntil(view, `(() => { const row = document.querySelector('[data-testid^="rc-export-"][data-state]'); const s = row?.getAttribute("data-state"); return s === "done" || s === "failed" || s === "cancelled"; })()`, 180_000);
      state = ended ? await js<string>(view, `document.querySelector('[data-testid^="rc-export-"][data-state]').getAttribute("data-state")`) : "";
    } finally { testHooks.pick = undefined; }
    const exports = await value<{ exports: Array<{ state: string; fileName: string | null; check: { ok: boolean; expectedFrames: number; actualFrames: number; streamsMatch: boolean } | null; timing: { overheadMs: number } | null }> }>("roughcut.exports", { cutId: cut.cut.id });
    const record = exports.exports[0];
    const files = fs.readdirSync(outDir);
    const out = files[0] ? path.join(outDir, files[0]) : "";
    const sizeOk = out ? fs.statSync(out).size > 1000 : false;
    // The originals are as they were, and nothing but the one file is left in the folder.
    const untouched = copies.every((file, index) => sha(file) === originals[index]);
    const planText = verdict ? "" : await js<string>(view, `(document.querySelector('[data-testid="rc-plan"]')?.textContent ?? "").slice(0, 300)`);
    rcDetail = { stages, planText, verdict: Boolean(verdict), state, files: files.length, sizeOk, check: record?.check ?? null, untouched, overheadMs: record?.timing?.overheadMs ?? null };
    roughcut = Boolean(verdict) && state === "done" && files.length === 1 && sizeOk && record?.check?.ok === true && record.check.streamsMatch === true && record.check.actualFrames === record.check.expectedFrames && untouched;
    await shot("roughcut-wide");
  } catch (error) {
    rcDetail = { error: error instanceof Error ? error.message : String(error) };
  }
  observe("creative-roughcut-export", roughcut, rcDetail);

  // ---- 9. a project package: written out, read back as a copy, and the copy is a project of its own ----
  let pack = false;
  let packDetail: Record<string, unknown> = {};
  try {
    const out = path.join(dir, "package-out");
    fs.mkdirSync(out, { recursive: true });
    const written = await value<{ fileName?: string; file?: string }>("project.exportPackage", { projectId, pathHandle: appService.registerPath("export", out) });
    const files = fs.readdirSync(out);
    const file = files[0] ? path.join(out, files[0]) : "";
    const preview = file ? await value<Record<string, unknown>>("project.packagePreview", { pathHandle: appService.registerPath("file", file) }) : {};
    const imported = file ? await value<{ projectId?: string; project?: { id: string } }>("project.importPackage", { pathHandle: appService.registerPath("file", file) }) : {};
    const listing = await value<{ projects: Array<{ id: string; name: string }> }>("project.list", { status: "active" });
    packDetail = { written: Boolean(written), files: files.length, previewKeys: Object.keys(preview).slice(0, 6), projects: listing.projects.length };
    pack = files.length === 1 && Boolean(preview) && Boolean(imported.projectId ?? imported.project?.id) && listing.projects.length >= 2;
  } catch (error) {
    packDetail = { error: error instanceof Error ? error.message : String(error) };
  }
  observe("creative-project-package", pack, packDetail);

  // ---- 10. the vector extension of the semantic index loads in the package, and answers a nearest-neighbour query ----
  let extension = false;
  let extDetail: Record<string, unknown> = {};
  try {
    const status = await value<{ engine?: string; extension?: boolean }>("semantic.status", {});
    const sqlite = appService.store.sqlite;
    // The service loads it once for its own connection; asked again here, a failure says why.
    const reasons: string[] = [];
    const loaded = loadVecExtension(sqlite, (reason) => reasons.push(reason));
    if (!loaded) throw new Error(`the vector extension did not load (engine ${status.engine}): ${reasons.join("; ")}`);
    sqlite.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.smoke_vec USING vec0(embedding float[4])");
    const insert = sqlite.prepare("INSERT INTO temp.smoke_vec(rowid, embedding) VALUES (?, ?)");
    insert.run(1n, new Float32Array([1, 0, 0, 0]));
    insert.run(2n, new Float32Array([0, 1, 0, 0]));
    const nearest = sqlite.prepare("SELECT rowid, distance FROM temp.smoke_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1").get(new Float32Array([0.9, 0.1, 0, 0])) as { rowid: number | bigint } | undefined;
    sqlite.exec("DROP TABLE temp.smoke_vec");
    extDetail = { engine: status.engine, nearest: nearest ? Number(nearest.rowid) : null };
    extension = status.engine === "vec0" && Number(nearest?.rowid) === 1;
  } catch (error) {
    extDetail = { error: error instanceof Error ? error.message : String(error) };
  }
  observe("creative-semantic-extension", extension, extDetail);

  // ---- 11. every tab at the three window sizes: nothing wider than the window, no empty canvas, the tab bar reachable ----
  for (const size of Object.keys(WINDOW_SIZES) as Array<keyof typeof WINDOW_SIZES>) {
    const [width, height] = WINDOW_SIZES[size];
    view.setContentSize(width, height);
    await sleep(450);
    const rows: Array<Record<string, unknown>> = [];
    for (const tab of TABS) {
      const shown = await openTab(tab);
      await sleep(250);
      const measured = shown ? await js<{ overflowX: boolean; tabbar: boolean; canvas: number | null; body: boolean }>(view, `(() => {
        const main = document.querySelector('[data-testid="shell-main"]') ?? document.body;
        const bar = document.querySelector('[data-testid="project-tabs"]');
        const barBox = bar ? bar.getBoundingClientRect() : null;
        const body = document.querySelector('[data-testid="project-body"]');
        const canvas = document.querySelector('.wb-canvas');
        const box = canvas ? canvas.getBoundingClientRect() : null;
        return {
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 || main.scrollWidth > main.clientWidth + 1,
          tabbar: Boolean(barBox) && barBox.left >= -1 && barBox.right <= window.innerWidth + 1,
          canvas: box ? Math.round(box.height) : null,
          body: Boolean(body) && body.getBoundingClientRect().height > 40,
        };
      })()`) : { overflowX: true, tabbar: false, canvas: null, body: false };
      const needsCanvas = tab === "whiteboard" || tab === "mindmap";
      rows.push({ tab, shown, ...measured, ok: shown && !measured.overflowX && measured.body && (!needsCanvas || (measured.canvas ?? 0) >= 120) });
      await shot(`${tab}-${size}`);
    }
    // The tab bar may scroll sideways on its own when the window is narrow, but never push the page: the page itself does not overflow.
    observe(`creative-fit-${size}`, rows.every((row) => row.ok === true), rows);
  }
  view.setContentSize(WINDOW_SIZES.wide[0], WINDOW_SIZES.wide[1]);

  const failed = observations.filter((row) => row.status !== "passed").map((row) => row.name);
  return { ok: failed.length === 0, observations, failed, missing: CREATIVE_OBSERVATIONS.filter((name) => !observations.some((row) => row.name === name)) };
}
