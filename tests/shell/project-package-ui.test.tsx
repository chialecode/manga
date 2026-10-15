/** @vitest-environment jsdom */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createTranslator } from "@manga/i18n";
import { ProjectsPage } from "../../apps/desktop/src/renderer/pages/projects/projects-page.tsx";
import { ProjectPage } from "../../apps/desktop/src/renderer/pages/projects/project-page.tsx";
import { startApp } from "../helpers/app.ts";
import { bridgeToApp } from "../helpers/ui-host.ts";

Element.prototype.scrollIntoView = () => {};

const i18n = createTranslator("zh-CN");
const t = i18n.t;
type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;
const apps: App[] = [];
const dirs: string[] = [];
const disposers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  while (disposers.length) disposers.pop()!();
  while (apps.length) { try { apps.pop()!.app.close(); } catch { /* closed */ } }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-pkgui-")); dirs.push(dir); return dir; };

/** A profile whose window can "choose" what the test says it chooses: the host dialog is the one thing a test cannot click. */
async function boot(chooses: { file?: string | null; directory?: string | null } = {}, withPick = true) {
  const ctx = await startApp();
  apps.push(ctx);
  const picks: Array<{ mode: string; filter?: string }> = [];
  const state = { ...chooses };
  const pick = withPick ? async (request: { mode: "file" | "directory"; filter?: string }) => {
    picks.push(request);
    const chosen = request.mode === "file" ? state.file : state.directory;
    return chosen ? { pathHandle: ctx.app.registerPath(request.mode, chosen), name: path.basename(chosen), mode: request.mode } : null;
  } : undefined;
  const bridge = bridgeToApp(ctx, pick ? { pick } : {});
  disposers.push(bridge.dispose);
  const run = async (commandId: string, input: Record<string, unknown> = {}) => {
    counter += 1;
    const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `pui-${counter}`, input }, ctx.grant.handle);
    expect(result.status, `${commandId}: ${JSON.stringify(result)}`).toBe("ok");
    return result.value as Record<string, any>;
  };
  return { ctx, bridge, picks, state, run };
}
type Booted = Awaited<ReturnType<typeof boot>>;

/** A project that refers to a book and a note, with a board that holds a card and a link to the note. */
async function seed(h: Booted, name = "雨夜纪录片") {
  const book = await h.run("library.importText", { title: "雨夜行人", bytes: [...Buffer.from("雨夜里，一个行人撑着伞走过石桥。\n桥下的水很深。")] });
  const note = await h.run("notes.create", { title: "笔记甲", text: "甲的第一段话，说的是雨夜与石桥。" });
  const project = await h.run("project.create", { name, goal: "做一支十分钟的解说" });
  await h.run("project.addMaterial", { projectId: project.id, kind: "work", targetId: book.workId });
  await h.run("project.addMaterial", { projectId: project.id, kind: "note", targetId: note.objectId });
  const board = await h.run("whiteboard.create", { projectId: project.id, title: "素材墙" });
  await h.run("whiteboard.edit", { boardId: board.board.id, actions: [
    { type: "addNode", id: "c1", kind: "card", x: 0, y: 0, data: { title: "石桥" } },
    { type: "addNode", id: "r1", kind: "ref", x: 0, y: 200, data: { refKind: "note", targetId: note.objectId } },
  ] });
  return { projectId: project.id as string, noteId: note.objectId as string };
}
const exported = async (h: Booted, projectId: string) => {
  const dir = tmp();
  const out = await h.run("project.exportPackage", { projectId, pathHandle: h.ctx.app.registerPath("directory", dir) });
  return path.join(dir, out.fileName as string);
};

function mountProjects() {
  const errors: string[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  let changed = 0;
  const page = (version: number) => <ProjectsPage t={t} formatDate={(iso) => iso.slice(0, 10)} version={version} onOpen={(id) => opened.push(id)} onChanged={() => { changed += 1; }} onError={(message) => errors.push(message)} onNotice={(message) => notices.push(message)} />;
  const view = render(page(0));
  return { errors, notices, opened, changes: () => changed, rerender: (version: number) => view.rerender(page(version)) };
}
function mountProject(projectId: string, tab: "materials" | "settings") {
  const errors: string[] = [];
  const notices: string[] = [];
  render(<ProjectPage t={t} formatDate={(iso) => iso.slice(0, 10)} projectId={projectId} tab={tab} facets={new Set(["whiteboard", "mindmap"])} connections={[]} version={0}
    focus={null} onFocus={() => undefined} onTab={() => undefined} onBack={() => undefined} onChanged={() => undefined} onOpenMaterial={() => undefined}
    onError={(message) => errors.push(message)} onNotice={(message) => notices.push(message)} />);
  return { errors, notices };
}
const commands = (h: Booted, id: string) => h.bridge.calls.filter((call) => call.commandId === id);

describe("exporting a project package from the project's settings (AT-25)", () => {
  it("asks for a folder, writes the file there and says its name; a cancelled dialog changes nothing", async () => {
    const h = await boot();
    const { projectId } = await seed(h);
    const view = mountProject(projectId, "settings");
    const button = await screen.findByTestId("project-export");
    expect(screen.getByTestId("project-package").textContent).toContain("不含作品、文件和对话");

    fireEvent.click(button);
    await waitFor(() => expect(h.picks).toHaveLength(1));
    expect(h.picks[0]).toEqual({ mode: "directory" });
    expect(commands(h, "project.exportPackage")).toHaveLength(0);
    expect(view.notices).toEqual([]);

    const dir = tmp();
    h.state.directory = dir;
    fireEvent.click(button);
    await waitFor(() => expect(view.notices).toHaveLength(1));
    expect(view.notices[0]).toBe("已导出：雨夜纪录片.manga-project.zip");
    expect(fs.readdirSync(dir)).toEqual(["雨夜纪录片.manga-project.zip"]);
    expect(Object.keys(unzipSync(fs.readFileSync(path.join(dir, "雨夜纪录片.manga-project.zip")))).includes("manifest.json")).toBe(true);
    expect(view.errors).toEqual([]);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it("says when the folder cannot be written to, and when the window cannot choose a folder at all", async () => {
    const h = await boot();
    const { projectId } = await seed(h);
    const view = mountProject(projectId, "settings");
    h.state.directory = path.join(tmp(), "gone");
    fireEvent.click(await screen.findByTestId("project-export"));
    await waitFor(() => expect(view.errors).toHaveLength(1));
    expect(view.errors[0]).toMatch(/^项目包没有导出：/);

    cleanup();
    disposers.pop()!();
    const bare = await boot({}, false);
    const { projectId: other } = await seed(bare);
    const second = mountProject(other, "settings");
    fireEvent.click(await screen.findByTestId("project-export"));
    expect(second.errors).toEqual(["这个环境不能选择文件。"]);
  });
});

describe("importing a project package from the projects page (AT-25, AT-28)", () => {
  it("shows what a package holds and that importing it here makes a copy, and imports it as a copy only when asked", async () => {
    const h = await boot();
    const { projectId } = await seed(h);
    const file = await exported(h, projectId);
    const view = mountProjects();
    await screen.findByTestId("projects-list");
    fireEvent.click(screen.getByTestId("projects-import"));
    // The dialog asked for a zip file, and nothing is read until one is chosen.
    await waitFor(() => expect(h.picks).toHaveLength(1));
    expect(h.picks[0]).toEqual({ mode: "file", filter: "package" });
    expect(screen.queryByTestId("project-import")).toBeNull();
    expect(commands(h, "project.packagePreview")).toHaveLength(0);

    h.state.file = file;
    fireEvent.click(screen.getByTestId("projects-import"));
    const preview = await screen.findByTestId("project-import-preview");
    expect(preview.getAttribute("data-mode")).toBe("copy");
    expect(screen.getByTestId("project-import-name").textContent).toBe("雨夜纪录片");
    expect(screen.getByTestId("project-import-contents").textContent).toBe("包含 1 块白板、0 张导图、0 份文稿、0 条摘录、0 个粗剪，2 项材料引用和 0 条术语。");
    expect(screen.getByTestId("project-import-notice").textContent).toContain("导入会新建一个副本");
    expect(screen.getByTestId("project-import-missing").textContent).toBe("引用的材料在本机都能找到。");
    expect(within(screen.getByTestId("project-import-materials")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByTestId("project-import-do").textContent).toBe("导入为副本");
    // Looking at a package changes nothing.
    expect(commands(h, "project.importPackage")).toHaveLength(0);
    expect((await h.run("project.list", {})).projects).toHaveLength(1);

    // Cancelling leaves things as they were.
    fireEvent.click(screen.getByTestId("project-import-cancel"));
    expect(screen.queryByTestId("project-import")).toBeNull();
    expect(commands(h, "project.importPackage")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("projects-import"));
    await screen.findByTestId("project-import");
    fireEvent.click(screen.getByTestId("project-import-do"));
    await waitFor(() => expect(view.opened).toHaveLength(1));
    expect(view.opened[0]).not.toBe(projectId);
    expect(view.notices).toEqual(["已把项目“雨夜纪录片”导入为副本。"]);
    expect(view.changes()).toBe(1);
    expect(screen.queryByTestId("project-import")).toBeNull();
    const names = ((await h.run("project.list", {})).projects as Array<{ name: string }>).map((item) => item.name).sort();
    expect(names).toEqual(["雨夜纪录片", "雨夜纪录片（副本）"]);
    await waitFor(() => expect(screen.getByTestId("projects-list").querySelectorAll("li")).toHaveLength(2));
    expect(view.errors).toEqual([]);
  });

  it("in another profile restores the project, names what that profile lacks, and leaves the lacking references readable", async () => {
    const source = await boot();
    const { projectId, noteId } = await seed(source);
    const file = await exported(source, projectId);
    cleanup();
    source.bridge.dispose();
    disposers.splice(disposers.indexOf(source.bridge.dispose), 1);

    const other = await boot({ file });
    const view = mountProjects();
    await screen.findByTestId("projects-empty");
    fireEvent.click(screen.getByTestId("projects-import"));
    const preview = await screen.findByTestId("project-import-preview");
    expect(preview.getAttribute("data-mode")).toBe("restore");
    expect(screen.getByTestId("project-import-notice").textContent).toContain("本机没有这个项目");
    const rows = within(screen.getByTestId("project-import-materials")).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-present"))).toEqual(["no", "no"]);
    expect(rows[1]!.textContent).toContain("笔记甲");
    expect(rows[1]!.textContent).toContain("本机没有");
    expect(screen.getByTestId("project-import-missing").textContent).toContain("2 项材料在本机找不到");
    expect(screen.getByTestId("project-import-do").textContent).toBe("导入");

    fireEvent.click(screen.getByTestId("project-import-do"));
    await waitFor(() => expect(view.opened).toEqual([projectId]));
    expect(view.notices).toEqual(["已导入项目“雨夜纪录片”。"]);

    // The project page then says those references are gone and shows what the package kept of each.
    cleanup();
    mountProject(projectId, "materials");
    const list = await screen.findByTestId("material-list");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["missing", "missing"]);
    const noteItem = items.find((item) => item.getAttribute("data-kind") === "note")!;
    expect(noteItem.textContent).toContain("已不存在");
    const snapshot = within(noteItem).getByText("查看项目包记下的内容").closest("details")!;
    expect(snapshot.querySelector("[data-testid^='material-snapshot-text-']")!.textContent).toContain("雨夜与石桥");
    expect(snapshot.textContent).toContain("只是当时的样子");
    expect(noteId).toBeTruthy();
    expect(other.picks).toEqual([{ mode: "file", filter: "package" }]);
  });

  it("refuses a file that is not a project package, and one that was changed, with a sentence that says why and nothing imported", async () => {
    const h = await boot();
    const { projectId } = await seed(h);
    const good = await exported(h, projectId);
    const view = mountProjects();
    await screen.findByTestId("projects-list");
    const before = ((await h.run("project.list", {})).projects as unknown[]).length;

    const text = path.join(tmp(), "notes.zip");
    fs.writeFileSync(text, "not a zip file");
    h.state.file = text;
    fireEvent.click(screen.getByTestId("projects-import"));
    await waitFor(() => expect(view.errors).toHaveLength(1));
    expect(view.errors[0]).toBe("这不是 MANGA 项目包，或文件已经损坏。");

    const files = unzipSync(fs.readFileSync(good));
    files["tables/whiteboards.json"] = strToU8(strFromU8(files["tables/whiteboards.json"]!).replace("素材墙", "改过了"));
    const changed = path.join(tmp(), "changed.zip");
    fs.writeFileSync(changed, zipSync(files));
    h.state.file = changed;
    fireEvent.click(screen.getByTestId("projects-import"));
    await waitFor(() => expect(view.errors).toHaveLength(2));
    expect(view.errors[1]).toBe("项目包的内容与它记录的校验不符，文件可能已损坏或被改动，没有导入。");

    const newer = unzipSync(fs.readFileSync(good));
    const manifest = JSON.parse(strFromU8(newer["manifest.json"]!)) as Record<string, unknown>;
    manifest.formatVersion = 2;
    newer["manifest.json"] = strToU8(JSON.stringify(manifest));
    const future = path.join(tmp(), "future.zip");
    fs.writeFileSync(future, zipSync(newer));
    h.state.file = future;
    fireEvent.click(screen.getByTestId("projects-import"));
    await waitFor(() => expect(view.errors).toHaveLength(3));
    expect(view.errors[2]).toBe("这个项目包来自更新版本的 MANGA。请先升级应用再导入。");

    h.state.file = path.join(tmp(), "gone.zip");
    fireEvent.click(screen.getByTestId("projects-import"));
    await waitFor(() => expect(view.errors).toHaveLength(4));
    expect(view.errors[3]).toBe("找不到这个文件。");

    expect(screen.queryByTestId("project-import")).toBeNull();
    expect(commands(h, "project.importPackage")).toHaveLength(0);
    expect(((await h.run("project.list", {})).projects as unknown[]).length).toBe(before);
    expect(view.opened).toEqual([]);
  });

  it("says so when the window cannot choose a file", async () => {
    const h = await boot({}, false);
    await seed(h);
    const view = mountProjects();
    await screen.findByTestId("projects-list");
    fireEvent.click(screen.getByTestId("projects-import"));
    expect(view.errors).toEqual(["这个环境不能选择文件。"]);
  });
});
