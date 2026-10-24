import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { MangaError } from "@manga/contracts";
import { collectBundle } from "../../packages/app-core/src/creative/bundle.ts";
import { PACKAGE_LIMITS, buildProjectPackage, importProjectPackage, readProjectPackageBytes } from "../../packages/app-core/src/creative/project-package.ts";
import { startApp } from "../helpers/app.ts";
import { OWNED_TABLES, PAGE_TEXT, makeProject, one, all, ok, run } from "../helpers/creative-project.ts";
import { DRIVE } from "../helpers/hostile-input.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
const apps: App[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (apps.length) { try { apps.pop()!.app.close(); } catch { /* closed */ } }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-pkg-")); dirs.push(dir); return dir; };
async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}
const fails = (result: Call) => {
  expect(result.status).toBe("error");
  return (result as { error: { code: string; details?: Record<string, unknown> } }).error;
};

const exportTo = async (ctx: App, projectId: string, dir = tmp()) => {
  const handle = ctx.app.registerPath("directory", dir);
  const result = ok<{ fileName: string; bytes: number; counts: Record<string, number> }>(await run(ctx, "project.exportPackage", { projectId, pathHandle: handle }));
  return { ...result, dir, file: path.join(dir, result.fileName) };
};
const importFrom = (ctx: App, file: string, key?: string) => run(ctx, "project.importPackage", { pathHandle: ctx.app.registerPath("file", file) }, key);
const previewOf = (ctx: App, file: string) => run(ctx, "project.packagePreview", { pathHandle: ctx.app.registerPath("file", file) });
const rowCounts = (ctx: App) => Object.fromEntries([...OWNED_TABLES, "projects", "excerpt_pages", "project_snapshots", "research_idx", "creative_ops"].map((table) => [table, one<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM ${table}`).n]));

/** The files of a package, changed by a test and put back into a zip; `fix` recomputes the manifest so only the change itself is wrong. */
function repack(bytes: Uint8Array, change: (files: Record<string, Uint8Array>) => void, fix = true): Buffer {
  const files = unzipSync(bytes);
  change(files);
  if (fix) {
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as { entries: Array<{ path: string; sha256: string; bytes: number }> };
    manifest.entries = manifest.entries.filter((entry) => files[entry.path]).map((entry) => ({ ...entry, sha256: createHash("sha256").update(files[entry.path]!).digest("hex"), bytes: files[entry.path]!.length }));
    for (const name of Object.keys(files)) {
      if (name !== "manifest.json" && !manifest.entries.some((entry) => entry.path === name)) {
        const kind = name === "project.json" ? "project" : name.startsWith("tables/") ? "table" : "snapshot";
        manifest.entries.push({ path: name, kind, sha256: createHash("sha256").update(files[name]!).digest("hex"), bytes: files[name]!.length } as never);
      }
    }
    files["manifest.json"] = strToU8(JSON.stringify(manifest));
  }
  return Buffer.from(zipSync(files));
}
const table = (files: Record<string, Uint8Array>, name: string) => JSON.parse(strFromU8(files[`tables/${name}.json`]!)) as Array<Record<string, any>>;
const setTable = (files: Record<string, Uint8Array>, name: string, rows: unknown[]) => { files[`tables/${name}.json`] = strToU8(JSON.stringify(rows)); };

describe("a project package: what it holds and how it is written (AT-25, AT-28)", () => {
  it("writes one zip: a manifest with sizes and hashes, the project, its tables and a snapshot of what it refers to, and nothing of the library", async () => {
    const ctx = await boot();
    const made = await makeProject(ctx);
    const out = await exportTo(ctx, made.projectId);
    expect(out.fileName).toBe("雨夜纪录片.manga-project.zip");
    expect(out.bytes).toBe(fs.statSync(out.file).size);
    expect(out.counts).toMatchObject({ whiteboards: 1, whiteboard_nodes: 5, whiteboard_edges: 1, mindmaps: 1, mindmap_nodes: 2, drafts: 1, draft_versions: expect.any(Number), excerpts: 1, excerpt_pages: 1, rough_cuts: 1, rough_cut_clips: 1, project_materials: 4, project_terms: 1 });

    const files = unzipSync(fs.readFileSync(out.file));
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as { format: string; formatVersion: number; dataVersion: number; projectId: string; entries: Array<{ path: string; sha256: string; bytes: number; kind: string }> };
    expect(manifest).toMatchObject({ format: "manga-project-package-v1", formatVersion: 1, dataVersion: 12, projectId: made.projectId });
    expect(new Set(manifest.entries.map((entry) => entry.path))).toEqual(new Set(Object.keys(files).filter((name) => name !== "manifest.json")));
    for (const entry of manifest.entries) {
      expect(createHash("sha256").update(files[entry.path]!).digest("hex")).toBe(entry.sha256);
      expect(files[entry.path]!.length).toBe(entry.bytes);
    }
    // Only the project's own rows and descriptions travel: no works, resources, attachments, pictures or conversations.
    expect(Object.keys(files).every((name) => /^(manifest\.json|project\.json|tables\/[a-z_]+\.json|snapshots\/[a-z]+-[a-f0-9]{24}\.json)$/.test(name))).toBe(true);
    expect(Object.keys(files).some((name) => /works|resources|attachments|sessions/.test(name))).toBe(false);
    // A suggestion still being written is not final, so it is not in the package.
    expect(table(files, "draft_suggestions").map((row) => row.id)).toEqual(["sug-done"]);
    // The snapshots describe the personal material the project points at, readably.
    const snapshots = manifest.entries.filter((entry) => entry.kind === "snapshot").map((entry) => JSON.parse(strFromU8(files[entry.path]!)) as { kind: string; id: string; label: string; text: string });
    const byKind = (kind: string) => snapshots.filter((snap) => snap.kind === kind);
    expect(byKind("note").map((snap) => snap.label).sort()).toEqual(["笔记乙", "笔记甲"].sort());
    expect(byKind("note").find((snap) => snap.label === "笔记甲")!.text).toContain("雨夜与石桥");
    expect(byKind("recording")[0]).toMatchObject({ id: "cap-1" });
    expect(byKind("recording")[0]!.text).toContain("灯塔");
    expect(byKind("work")[0]).toMatchObject({ id: made.book.workId, label: "雨夜行人" });
    expect(byKind("resource")[0]).toMatchObject({ id: made.book.resourceId });
    // What the project owns is not a snapshot: it is in the tables.
    expect(snapshots.some((snap) => snap.id === made.boardId || snap.id === made.mapId || snap.id === made.excerptId)).toBe(false);
  });

  it("writes a name that is safe on every system, and never over another file", async () => {
    const ctx = await boot();
    const made = await makeProject(ctx, 'a/b:c*?"<>| 项目');
    const dir = tmp();
    const first = await exportTo(ctx, made.projectId, dir);
    const second = await exportTo(ctx, made.projectId, dir);
    expect(first.fileName).toBe("a b c 项目.manga-project.zip");
    expect(second.fileName).toBe("a b c 项目 (2).manga-project.zip");
    expect(fs.readdirSync(dir).sort()).toEqual([first.fileName, second.fileName].sort());
    expect(fails(await run(ctx, "project.exportPackage", { projectId: made.projectId, pathHandle: ctx.app.registerPath("directory", path.join(dir, "nope")) })).code).toBe("NOT_FOUND");
    expect(fails(await run(ctx, "project.exportPackage", { projectId: "prj_none", pathHandle: ctx.app.registerPath("directory", dir) })).code).toBe("NOT_FOUND");
    expect(fails(await run(ctx, "project.exportPackage", { projectId: made.projectId, pathHandle: "path_unknown" })).code).toBe("FORBIDDEN");
    // The export read nothing back into the profile.
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM projects").n).toBe(1);
  });

  it("is the same package for the same project and time, so it can be compared", async () => {
    const ctx = await boot();
    const made = await makeProject(ctx);
    const a = buildProjectPackage(ctx.app.store, made.projectId, "2026-10-05T00:00:00.000Z");
    const b = buildProjectPackage(ctx.app.store, made.projectId, "2026-10-05T00:00:00.000Z");
    expect(a.data.equals(b.data)).toBe(true);
  });
});

describe("importing a package into the profile it came from (a copy)", () => {
  it("makes a copy under new ids and leaves the original as it was", async () => {
    const ctx = await boot();
    const made = await makeProject(ctx);
    const before = JSON.stringify(collectBundle(ctx.app.store, made.projectId, "t"));
    const beforeCounts = rowCounts(ctx);
    const out = await exportTo(ctx, made.projectId);

    const preview = ok<{ copy: boolean; name: string; missing: number; counts: Record<string, number>; materials: Array<{ kind: string; present: boolean }> }>(await previewOf(ctx, out.file));
    expect(preview).toMatchObject({ copy: true, name: "雨夜纪录片", missing: 0 });
    expect(preview.materials.every((item) => item.present)).toBe(true);
    expect(rowCounts(ctx)).toEqual(beforeCounts);

    const imported = ok<{ projectId: string; mode: string; counts: Record<string, number>; missing: unknown[] }>(await importFrom(ctx, out.file));
    expect(imported).toMatchObject({ mode: "copy", missing: [] });
    expect(imported.projectId).not.toBe(made.projectId);
    expect(JSON.stringify(collectBundle(ctx.app.store, made.projectId, "t"))).toBe(before);

    const copy = ok<{ project: { id: string; name: string; status: string; counts: Record<string, number> }; materials: Array<{ kind: string; targetId: string; state: string }>; terms: Array<{ term: string; heard: string; note: string }> }>(await run(ctx, "project.get", { projectId: imported.projectId }));
    expect(copy.project).toMatchObject({ name: "雨夜纪录片（副本）", status: "active" });
    expect(copy.project.counts).toMatchObject({ whiteboards: 1, mindmaps: 1, drafts: 1, excerpts: 1, roughCuts: 1, materials: 4, terms: 1 });
    expect(copy.terms).toEqual([expect.objectContaining({ term: "石桥", heard: "时桥", note: "地名" })]);
    // References to personal material still lead to the same things; references to what the project owns lead to the copies.
    expect(copy.materials.every((item) => item.state === "ok")).toBe(true);
    const copyBoard = one<{ id: string }>(ctx, "SELECT id FROM whiteboards WHERE project_id = ?", imported.projectId).id;
    const copyMap = one<{ id: string }>(ctx, "SELECT id FROM mindmaps WHERE project_id = ?", imported.projectId).id;
    const copyExcerpt = one<{ id: string }>(ctx, "SELECT id FROM excerpts WHERE project_id = ?", imported.projectId).id;
    expect([copyBoard, copyMap, copyExcerpt].every((id) => ![made.boardId, made.mapId, made.excerptId].includes(id))).toBe(true);
    expect(copy.materials.find((item) => item.kind === "excerpt")!.targetId).toBe(copyExcerpt);
    expect(copy.materials.find((item) => item.kind === "note")!.targetId).toBe(made.noteA);
    expect(copy.materials.find((item) => item.kind === "work")!.targetId).toBe(made.book.workId);

    // The board: same layout, grouping and link, new ids that agree with each other; a reference to the project's own map leads to the copy of the map.
    const board = ok<{ nodes: Array<{ id: string; kind: string; x: number; y: number; parentId: string | null; data: Record<string, any> }>; edges: Array<{ id: string; sourceId: string; targetId: string; label: string }> }>(await run(ctx, "whiteboard.get", { boardId: copyBoard }));
    const original = ok<{ nodes: Array<{ id: string; kind: string; x: number; y: number; parentId: string | null; data: Record<string, any> }> }>(await run(ctx, "whiteboard.get", { boardId: made.boardId }));
    expect(board.nodes.map((node) => [node.kind, node.x, node.y])).toEqual(original.nodes.map((node) => [node.kind, node.x, node.y]));
    expect(board.nodes.some((node) => original.nodes.some((other) => other.id === node.id))).toBe(false);
    const group = board.nodes.find((node) => node.kind === "group")!;
    expect(board.nodes.filter((node) => node.parentId).map((node) => node.parentId)).toEqual([group.id, group.id]);
    expect(board.edges).toHaveLength(1);
    expect(board.edges[0]).toMatchObject({ label: "引出" });
    const ids = new Set(board.nodes.map((node) => node.id));
    expect(ids.has(board.edges[0]!.sourceId) && ids.has(board.edges[0]!.targetId)).toBe(true);
    expect(board.nodes.find((node) => node.data.refKind === "note")!.data.targetId).toBe(made.noteA);
    expect(board.nodes.find((node) => node.data.refKind === "mindmap")!.data.targetId).toBe(copyMap);

    // The map: refs to notes stay, and its tree is the same.
    const map = ok<{ nodes: Array<{ id: string; parentId: string | null; text: string; refs: Array<{ kind: string; targetId: string }> }> }>(await run(ctx, "mindmap.get", { mapId: copyMap }));
    expect(map.nodes.map((node) => node.text).sort()).toEqual(["开场", "解说结构"]);
    expect(map.nodes.find((node) => node.text === "开场")!.refs.map((ref) => [ref.kind, ref.targetId])).toEqual([["note", made.noteB], ["work", made.book.workId]]);
    expect(map.nodes.find((node) => node.text === "开场")!.parentId).toBe(map.nodes.find((node) => node.text === "解说结构")!.id);

    // Embeds follow: the copy of the board holds the same embeds, in the copy's own slots, and they resolve.
    const embeds = ok<{ embeds: Array<{ slot: string; targetKind: string; targetId: string; mode: string; state: string }> }>(await run(ctx, "embed.list", { sourceKind: "whiteboard", sourceId: copyBoard })).embeds;
    expect(embeds.map((item) => [item.targetKind, item.mode, item.state]).sort()).toEqual([["mindmap", "snapshot", "valid"], ["note", "live", "valid"]].sort());
    expect(embeds.every((item) => ids.has(item.slot))).toBe(true);
    expect(embeds.find((item) => item.targetKind === "mindmap")!.targetId).toBe(copyMap);
    const mapEmbeds = ok<{ embeds: Array<{ targetKind: string; targetId: string; state: string }> }>(await run(ctx, "embed.list", { sourceKind: "mindmap", sourceId: copyMap })).embeds;
    expect(mapEmbeds.map((item) => [item.targetKind, item.state])).toEqual([["note", "valid"]]);

    // The draft with its history and its finished suggestion; the one still running was not carried.
    const copyDraft = one<{ id: string; text: string; version: number }>(ctx, "SELECT id, text, version FROM drafts WHERE project_id = ?", imported.projectId);
    expect(copyDraft).toMatchObject({ text: "第二稿，加了开场。", version: one<{ version: number }>(ctx, "SELECT version FROM drafts WHERE id = ?", made.draftId).version });
    expect(all<{ text: string; label: string }>(ctx, "SELECT text, label FROM draft_versions WHERE draft_id = ? ORDER BY version", copyDraft.id)).toEqual(all(ctx, "SELECT text, label FROM draft_versions WHERE draft_id = ? ORDER BY version", made.draftId));
    const suggestions = all<{ status: string; sources: string }>(ctx, "SELECT status, sources_json AS sources FROM draft_suggestions WHERE draft_id = ?", copyDraft.id);
    expect(suggestions).toHaveLength(1);
    expect(JSON.parse(suggestions[0]!.sources)).toEqual([{ kind: "excerpt", targetId: copyExcerpt }, { kind: "note", targetId: made.noteA }]);

    // The excerpt points into the page already kept, which is not kept twice, and can be found again.
    expect(one<{ pageId: string; text: string; note: string }>(ctx, "SELECT page_id AS pageId, text, note FROM excerpts WHERE id = ?", copyExcerpt)).toMatchObject({ pageId: "pgv-1", note: "可以当开场" });
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM excerpt_pages").n).toBe(1);
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM research_idx WHERE ref_kind = 'excerpt' AND ref_id = ?", copyExcerpt).n).toBe(1);
    expect(ok<{ results: Array<{ id: string }> }>(await run(ctx, "research.search", { text: "驼队", scopes: ["excerpt"], projectId: imported.projectId })).results.map((item) => item.id)).toContain(copyExcerpt);

    // The cut points at the same video revision.
    expect(one<{ resource: string; label: string }>(ctx, "SELECT c.resource_id AS resource, c.label AS label FROM rough_cut_clips c JOIN rough_cuts r ON r.id = c.cut_id WHERE r.project_id = ?", imported.projectId)).toEqual({ resource: made.book.resourceId, label: "开头" });

    // Counts add up: the original plus the copy.
    const after = rowCounts(ctx);
    for (const name of ["projects", "whiteboards", "mindmaps", "drafts", "excerpts", "rough_cuts", "project_materials", "project_terms", "whiteboard_nodes", "whiteboard_edges", "mindmap_nodes", "embeds"]) expect(after[name], name).toBe(beforeCounts[name]! * 2);
    expect(after.project_snapshots).toBe(0);
  });

  it("imports the same file twice as two copies, and one request twice as one", async () => {
    const ctx = await boot();
    const made = await makeProject(ctx);
    const out = await exportTo(ctx, made.projectId);
    const first = ok<{ projectId: string }>(await importFrom(ctx, out.file, "same-request"));
    const again = await importFrom(ctx, out.file, "same-request");
    expect(again.status === "ok" ? (again.value as { projectId: string }).projectId : "replay").toBe(again.status === "ok" ? first.projectId : "replay");
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM projects").n).toBe(2);
    const other = ok<{ projectId: string }>(await importFrom(ctx, out.file));
    expect(other.projectId).not.toBe(first.projectId);
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM projects").n).toBe(3);
    const names = all<{ name: string }>(ctx, "SELECT name FROM projects ORDER BY created_at, rowid").map((row) => row.name);
    expect(names).toEqual(["雨夜纪录片", "雨夜纪录片（副本）", "雨夜纪录片（副本）"]);
  });

  it("restores the project under its own ids when it was deleted from the profile", async () => {
    const ctx = await boot();
    const made = await makeProject(ctx);
    const out = await exportTo(ctx, made.projectId);
    const original = collectBundle(ctx.app.store, made.projectId, "t");
    ok(await run(ctx, "project.delete", { projectId: made.projectId }));
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM projects").n).toBe(0);
    const restored = ok<{ projectId: string; mode: string }>(await importFrom(ctx, out.file));
    expect(restored).toMatchObject({ projectId: made.projectId, mode: "restore" });
    const again = collectBundle(ctx.app.store, made.projectId, "t");
    const strip = (bundle: typeof original) => ({ ...bundle, project: { ...bundle.project, updated_at: "" } });
    expect(strip(again)).toEqual(strip(original));
  });
});

describe("importing a package into another profile", () => {
  it("restores the project, and shows what it points at that this profile does not have as missing, still readable from the snapshot", async () => {
    const source = await boot();
    const made = await makeProject(source);
    const out = await exportTo(source, made.projectId);
    const other = await boot();

    const preview = ok<{ copy: boolean; missing: number; materials: Array<{ kind: string; label: string; present: boolean }> }>(await previewOf(other, out.file));
    expect(preview.copy).toBe(false);
    expect(preview.missing).toBe(3);
    expect(preview.materials.filter((item) => !item.present).map((item) => item.kind).sort()).toEqual(["note", "recording", "work"]);
    expect(preview.materials.find((item) => item.kind === "note")!.label).toBe("笔记甲");
    expect(one<{ n: number }>(other, "SELECT COUNT(*) AS n FROM projects").n).toBe(0);

    const imported = ok<{ projectId: string; mode: string; missing: Array<{ kind: string; id: string; label: string }> }>(await importFrom(other, out.file));
    expect(imported).toMatchObject({ projectId: made.projectId, mode: "restore" });
    expect(imported.missing.map((item) => [item.kind, item.label]).sort()).toEqual([["note", "笔记乙"], ["note", "笔记甲"], ["recording", expect.any(String)], ["resource", "雨夜行人"], ["work", "雨夜行人"]].sort());

    const detail = ok<{ materials: Array<{ kind: string; targetId: string; label: string; state: string; snapshot?: { text: string } }> }>(await run(other, "project.get", { projectId: made.projectId }));
    const byKind = (kind: string) => detail.materials.find((item) => item.kind === kind)!;
    expect(byKind("note")).toMatchObject({ state: "missing", label: "笔记甲", targetId: made.noteA });
    expect(byKind("note").snapshot!.text).toContain("雨夜与石桥");
    expect(byKind("recording")).toMatchObject({ state: "missing", snapshot: { text: expect.stringContaining("灯塔") } });
    expect(byKind("work")).toMatchObject({ state: "missing", label: "雨夜行人" });
    // What the project owns is here, and is not missing.
    expect(byKind("excerpt")).toMatchObject({ state: "ok", targetId: made.excerptId });
    expect(one<{ pageId: string }>(other, "SELECT page_id AS pageId FROM excerpts WHERE id = ?", made.excerptId).pageId).toBe("pgv-1");
    expect(one<{ body: string }>(other, "SELECT body_text AS body FROM excerpt_pages WHERE id = 'pgv-1'").body).toBe(PAGE_TEXT);

    // The embeds of the board hold a note this profile does not have: the state says so, and the title and a line of the note are still there.
    const embeds = ok<{ embeds: Array<{ targetKind: string; targetId: string; state: string; title: string; summary: string; recovery: string[] }> }>(await run(other, "embed.list", { sourceKind: "whiteboard", sourceId: made.boardId })).embeds;
    const noteEmbed = embeds.find((item) => item.targetKind === "note")!;
    expect(noteEmbed).toMatchObject({ targetId: made.noteA, state: "deleted", title: "笔记甲" });
    expect(noteEmbed.summary).toContain("雨夜与石桥");
    expect(noteEmbed.recovery).toContain("remove");
    // The embed of the map, which came with the project, is valid, and the board still draws every node.
    expect(embeds.find((item) => item.targetKind === "mindmap")).toMatchObject({ targetId: made.mapId, state: "valid" });
    expect(ok<{ nodes: unknown[] }>(await run(other, "whiteboard.get", { boardId: made.boardId })).nodes).toHaveLength(5);
    expect(ok<{ nodes: Array<{ refs: Array<{ kind: string; state: string; label: string }> }> }>(await run(other, "mindmap.get", { mapId: made.mapId })).nodes.flatMap((node) => node.refs).map((ref) => [ref.kind, ref.state])).toEqual([["note", "missing"], ["work", "missing"]]);

    // The rest of the profile is untouched: nothing of the library came with the package.
    expect(one<{ n: number }>(other, "SELECT COUNT(*) AS n FROM works").n).toBe(0);
    expect(one<{ n: number }>(other, "SELECT COUNT(*) AS n FROM content_objects").n).toBe(0);
  });

  it("carries a project from one profile to the next and the next, with the same content each time", async () => {
    const a = await boot();
    const made = await makeProject(a);
    const first = await exportTo(a, made.projectId);
    const b = await boot();
    ok(await importFrom(b, first.file));
    const second = await exportTo(b, made.projectId);
    const c = await boot();
    ok(await importFrom(c, second.file));
    const strip = (bundle: ReturnType<typeof collectBundle>) => JSON.stringify({ ...bundle, project: { ...bundle.project, updated_at: "" }, snapshots: bundle.snapshots.map((snap) => ({ ...snap, takenAt: "" })).sort((x, y) => `${x.kind}${x.id}`.localeCompare(`${y.kind}${y.id}`)) });
    expect(strip(collectBundle(c.app.store, made.projectId, "t"))).toBe(strip(collectBundle(b.app.store, made.projectId, "t")));
    // B knew less about the personal material than A did, but not less than it was told: what B says about it is what A said.
    const aBundle = collectBundle(a.app.store, made.projectId, "t");
    const cBundle = collectBundle(c.app.store, made.projectId, "t");
    expect(cBundle.tables.whiteboard_nodes).toEqual(aBundle.tables.whiteboard_nodes);
    expect(cBundle.tables.mindmap_nodes).toEqual(aBundle.tables.mindmap_nodes);
    expect(cBundle.tables.draft_versions).toEqual(aBundle.tables.draft_versions);
  });
});

describe("a package that cannot be trusted is refused before anything is written", () => {
  async function packageOf() {
    const ctx = await boot();
    const made = await makeProject(ctx);
    const out = await exportTo(ctx, made.projectId);
    return { ctx, made, bytes: fs.readFileSync(out.file) };
  }
  const attempt = async (ctx: App, bytes: Buffer | Uint8Array) => {
    const file = path.join(tmp(), "package.manga-project.zip");
    fs.writeFileSync(file, bytes);
    const before = rowCounts(ctx);
    const preview = await previewOf(ctx, file);
    const imported = await importFrom(ctx, file);
    expect(rowCounts(ctx)).toEqual(before);
    const a = fails(preview);
    const b = fails(imported);
    expect(b.code).toBe(a.code);
    return { code: b.code, reason: (b.details as { reason?: string } | undefined)?.reason };
  };

  it("refuses a file that is not a zip, a zip that is not a project package, and a missing file", async () => {
    const { ctx } = await packageOf();
    expect(await attempt(ctx, Buffer.from("this is not a zip file"))).toMatchObject({ code: "VALIDATION_ERROR", reason: "format" });
    expect(await attempt(ctx, Buffer.from(zipSync({ "hello.txt": strToU8("hi") })))).toMatchObject({ code: "VALIDATION_ERROR", reason: "format" });
    expect(await attempt(ctx, Buffer.from(zipSync({ "manifest.json": strToU8(JSON.stringify({ format: "other" })) })))).toMatchObject({ code: "VALIDATION_ERROR", reason: "format" });
    expect(fails(await run(ctx, "project.packagePreview", { pathHandle: ctx.app.registerPath("file", path.join(tmp(), "none.zip")) })).code).toBe("NOT_FOUND");
    expect(fails(await run(ctx, "project.importPackage", { pathHandle: ctx.app.registerPath("file", tmp()) })).code).toBe("VALIDATION_ERROR");
    expect(fails(await run(ctx, "project.importPackage", { pathHandle: "path_unknown" })).code).toBe("FORBIDDEN");
  });

  it("refuses a file that does not match its manifest, one the manifest does not list, one that is missing, and a manifest that lists a file twice", async () => {
    const { ctx, bytes } = await packageOf();
    expect(await attempt(ctx, repack(bytes, (files) => { files["tables/whiteboards.json"] = strToU8(strFromU8(files["tables/whiteboards.json"]!).replace("素材墙", "改过了")); }, false))).toMatchObject({ reason: "hash" });
    expect(await attempt(ctx, repack(bytes, (files) => { files["project.json"] = files["project.json"]!.slice(0, 40); }, false))).toMatchObject({ reason: "hash" });
    expect(await attempt(ctx, repack(bytes, (files) => { files["tables/extra.json"] = strToU8("[]"); }, false))).toMatchObject({ reason: "extra" });
    expect(await attempt(ctx, repack(bytes, (files) => { delete files["tables/whiteboards.json"]; }, false))).toMatchObject({ reason: "missing" });
    expect(await attempt(ctx, repack(bytes, (files) => {
      const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as { entries: unknown[] };
      manifest.entries.push(manifest.entries[0]);
      files["manifest.json"] = strToU8(JSON.stringify(manifest));
    }, false))).toMatchObject({ reason: "format" });
  });

  it("refuses a package from a newer version of the format or of the data, and says so", async () => {
    const { ctx, bytes } = await packageOf();
    const withManifest = (change: (manifest: Record<string, unknown>) => void) => repack(bytes, (files) => {
      const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as Record<string, unknown>;
      change(manifest);
      files["manifest.json"] = strToU8(JSON.stringify(manifest));
    }, false);
    expect(await attempt(ctx, withManifest((manifest) => { manifest.formatVersion = 2; }))).toMatchObject({ reason: "newer" });
    expect(await attempt(ctx, withManifest((manifest) => { manifest.dataVersion = 13; }))).toMatchObject({ reason: "newer" });
    expect(await attempt(ctx, withManifest((manifest) => { manifest.formatVersion = 0; }))).toMatchObject({ reason: "format" });
    expect(await attempt(ctx, withManifest((manifest) => { manifest.format = "manga-library-package-v1"; }))).toMatchObject({ reason: "format" });
  });

  it("refuses names that could leave the folder, and a zip that unpacks to far more than it says", async () => {
    const { ctx, bytes } = await packageOf();
    for (const name of ["../evil.json", "/abs.json", "tables/../../evil.json", `${DRIVE}:/evil.json`, "tables\\evil.json", "a//b.json", ".hidden.json"]) {
      expect(await attempt(ctx, repack(bytes, (files) => { files[name] = strToU8("[]"); }, false)), name).toMatchObject({ reason: "unsafe" });
    }
    expect(await attempt(ctx, repack(bytes, (files) => { files["tables/big.json"] = new Uint8Array(PACKAGE_LIMITS.entryBytes + 1); }, false))).toMatchObject({ reason: "size" });
    // Many files of a fitting size add up to more than a package may hold.
    expect(await attempt(ctx, repack(bytes, (files) => { for (let i = 0; i < 5; i += 1) files[`tables/pad${i}.json`] = new Uint8Array(PACKAGE_LIMITS.entryBytes); }, false))).toMatchObject({ reason: "size" });
  });

  it("refuses rows that are not what a table holds, and rows that point at what the package does not have", async () => {
    const { ctx, bytes } = await packageOf();
    const schema = (change: (files: Record<string, Uint8Array>) => void) => attempt(ctx, repack(bytes, change));
    expect(await schema((files) => setTable(files, "whiteboard_nodes", table(files, "whiteboard_nodes").map((row, index) => (index ? row : { ...row, x: "left" }))))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "whiteboard_nodes", table(files, "whiteboard_nodes").map((row, index) => (index ? row : { ...row, extra: 1 }))))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "whiteboard_nodes", table(files, "whiteboard_nodes").map((row, index) => { if (index) return row; const { data_json, ...rest } = row; return rest; })))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "whiteboard_nodes", table(files, "whiteboard_nodes").map((row, index) => (index ? row : { ...row, data_json: "{not json" }))))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "whiteboard_nodes", table(files, "whiteboard_nodes").map((row) => ({ ...row, board_id: "wb-nowhere" }))))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "whiteboard_edges", table(files, "whiteboard_edges").map((row) => ({ ...row, target_id: "wbn-nowhere" }))))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "project_materials", table(files, "project_materials").map((row, index) => (index ? row : { ...row, kind: "spaceship" }))))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "project_materials", table(files, "project_materials").map((row, index) => (index ? row : { ...row, project_id: "prj-other" }))))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "embeds", table(files, "embeds").map((row, index) => (index ? row : { ...row, source_id: "wb-nowhere" }))))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "embeds", table(files, "embeds").map((row, index) => (index ? row : { ...row, target_kind: "excerpt" }))))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "excerpts", table(files, "excerpts").map((row) => ({ ...row, page_id: "pgv-nowhere" }))))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => setTable(files, "draft_versions", [...table(files, "draft_versions"), ...table(files, "draft_versions").slice(0, 1)]))).toMatchObject({ reason: "schema" });
    expect(await schema((files) => { files["project.json"] = strToU8(JSON.stringify({ ...JSON.parse(strFromU8(files["project.json"]!)), id: "prj-other" })); })).toMatchObject({ reason: "schema" });
    expect(await schema((files) => { const name = Object.keys(files).find((file) => file.startsWith("snapshots/"))!; files[name] = strToU8(JSON.stringify({ kind: "note" })); })).toMatchObject({ reason: "schema" });
  });

  it("writes all of a project or none of it: a failure part of the way through leaves the profile as it was", async () => {
    const { ctx, made } = await packageOf();
    const file = path.join(tmp(), "p.zip");
    fs.writeFileSync(file, buildProjectPackage(ctx.app.store, made.projectId).data);
    const before = rowCounts(ctx);
    let seen = 0;
    expect(() => importProjectPackage(ctx.app.store, file, {
      adoptPage: () => "pgv-1", indexExcerpt: () => { seen += 1; throw new MangaError("INTERRUPTED", "stopped part of the way"); },
    })).toThrow("stopped part of the way");
    expect(seen).toBe(1);
    expect(rowCounts(ctx)).toEqual(before);
  });

  it("reads what it wrote: the bytes of a package are accepted by the reader without a file", async () => {
    const { ctx, made } = await packageOf();
    const built = buildProjectPackage(ctx.app.store, made.projectId, "2026-10-05T00:00:00.000Z");
    const read = readProjectPackageBytes(built.data);
    expect(read.manifest.createdAt).toBe("2026-10-05T00:00:00.000Z");
    expect(read.bundle.project.id).toBe(made.projectId);
    expect(read.bundle.tables.whiteboard_nodes).toHaveLength(5);
  });
});

describe("a project carries where it was being read and how it was laid out (A-94, A-96)", () => {
  /** A project that was read in and laid out: a position of its own in the book, and tabs that open its board, its map and its draft. */
  async function laidOut(ctx: App) {
    const made = await makeProject(ctx);
    const locator = { kind: "text", partId: "body", representationId: made.book.revisionId, normalizationVersion: "text-nfc-lf-v1", range: { start: 4, end: 8 }, quote: { exact: "撑着伞走" } };
    ok(await run(ctx, "progress.set", { contextId: made.projectId, resourceId: made.book.resourceId, resourceRevisionId: made.book.revisionId, locator, consumed: true }));
    const tab = (id: string, kind: string, target: Record<string, unknown>, title: string) => ({ id, kind, target, title, view: {} });
    const state = {
      version: 1, preset: "two", layout: null, focusedTab: "t-board", closed: [],
      tabs: [
        tab("t-board", "whiteboard", { projectId: made.projectId, objectId: made.boardId }, "素材墙"),
        tab("t-map", "mindmap", { projectId: made.projectId, objectId: made.mapId }, "结构导图"),
        tab("t-draft", "draft", { projectId: made.projectId, objectId: made.draftId }, "解说词"),
        tab("t-book", "reader", { resourceId: made.book.resourceId, mediaKind: "novel", workId: made.book.workId }, "雨夜行人"),
      ],
    };
    ok(await run(ctx, "workspace.saveContext", { contextId: made.projectId, state }));
    return { made, locator };
  }
  const tabsOf = async (ctx: App, contextId: string) => ok<{ state: { tabs: Array<{ id: string; kind: string; target: Record<string, any> }>; preset: string; focusedTab: string } }>(await run(ctx, "workspace.loadContext", { contextId })).state;

  it("writes the project's own positions and its layout, and nothing of the positions kept elsewhere", async () => {
    const ctx = await boot();
    const { made } = await laidOut(ctx);
    ok(await run(ctx, "progress.set", { contextId: null, resourceId: made.book.resourceId, resourceRevisionId: made.book.revisionId, locator: { kind: "text", partId: "body", representationId: made.book.revisionId, normalizationVersion: "text-nfc-lf-v1", range: { start: 0, end: 2 }, quote: { exact: "雨夜" } }, consumed: true }));
    const out = await exportTo(ctx, made.projectId);
    const files = unzipSync(fs.readFileSync(out.file));
    const progress = table(files, "project_progress");
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ resource_id: made.book.resourceId, resource_revision_id: made.book.revisionId, completion_state: "reading" });
    expect(JSON.parse(String(progress[0]!.last_locator_json))).toMatchObject({ range: { start: 4, end: 8 } });
    const workspace = table(files, "project_workspace");
    expect(workspace).toHaveLength(1);
    expect(workspace[0]!.id).toBe(made.projectId);
    expect((JSON.parse(String(workspace[0]!.state_json)) as { tabs: unknown[] }).tabs).toHaveLength(4);
    expect(out.counts).toMatchObject({ project_progress: 1, project_workspace: 1 });
  });

  it("restores them under the project's own id when the project was deleted, with the same tabs and the same position", async () => {
    const ctx = await boot();
    const { made, locator } = await laidOut(ctx);
    const out = await exportTo(ctx, made.projectId);
    const before = await tabsOf(ctx, made.projectId);
    ok(await run(ctx, "project.delete", { projectId: made.projectId }));
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM progress WHERE context_id = ?", made.projectId).n).toBe(0);
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM workspace_contexts WHERE context_id = ?", made.projectId).n).toBe(0);
    ok(await importFrom(ctx, out.file));
    expect(await tabsOf(ctx, made.projectId)).toEqual(before);
    const restored = ok<{ locator: unknown; contextId: string }>(await run(ctx, "progress.get", { contextId: made.projectId, resourceId: made.book.resourceId }));
    expect(restored.contextId).toBe(made.projectId);
    expect(restored.locator).toEqual(locator);
  });

  it("makes a copy whose tabs open the copy's own objects and whose position is the copy's, and leaves the original as it was", async () => {
    const ctx = await boot();
    const { made, locator } = await laidOut(ctx);
    const before = await tabsOf(ctx, made.projectId);
    const out = await exportTo(ctx, made.projectId);
    const imported = ok<{ projectId: string; mode: string }>(await importFrom(ctx, out.file));
    expect(imported.mode).toBe("copy");
    const copyBoard = one<{ id: string }>(ctx, "SELECT id FROM whiteboards WHERE project_id = ?", imported.projectId).id;
    const copyMap = one<{ id: string }>(ctx, "SELECT id FROM mindmaps WHERE project_id = ?", imported.projectId).id;
    const copyDraft = one<{ id: string }>(ctx, "SELECT id FROM drafts WHERE project_id = ?", imported.projectId).id;

    const tabs = await tabsOf(ctx, imported.projectId);
    expect(tabs).toMatchObject({ preset: "two", focusedTab: "t-board" });
    const byId = Object.fromEntries(tabs.tabs.map((item) => [item.id, item]));
    expect(byId["t-board"]!.target).toEqual({ projectId: imported.projectId, objectId: copyBoard });
    expect(byId["t-map"]!.target).toEqual({ projectId: imported.projectId, objectId: copyMap });
    expect(byId["t-draft"]!.target).toEqual({ projectId: imported.projectId, objectId: copyDraft });
    // The book is the same book in this profile, so its tab still opens it.
    expect(byId["t-book"]!.target).toMatchObject({ resourceId: made.book.resourceId, mediaKind: "novel" });
    expect(ok<{ locator: unknown }>(await run(ctx, "progress.get", { contextId: imported.projectId, resourceId: made.book.resourceId })).locator).toEqual(locator);
    // The original is as it was.
    expect(await tabsOf(ctx, made.projectId)).toEqual(before);
    expect(ok<{ locator: unknown }>(await run(ctx, "progress.get", { contextId: made.projectId, resourceId: made.book.resourceId })).locator).toEqual(locator);
  });

  it("leaves out a position in a book the other profile does not have, and keeps the tab that would open it", async () => {
    const source = await boot();
    const { made } = await laidOut(source);
    const out = await exportTo(source, made.projectId);
    const other = await boot();
    const imported = ok<{ projectId: string; counts: Record<string, number> }>(await importFrom(other, out.file));
    expect(one<{ n: number }>(other, "SELECT COUNT(*) AS n FROM progress WHERE context_id = ?", imported.projectId).n).toBe(0);
    expect(imported.counts.project_progress ?? 0).toBe(0);
    const tabs = await tabsOf(other, imported.projectId);
    expect(tabs.tabs.map((item) => item.kind)).toEqual(["whiteboard", "mindmap", "draft", "reader"]);
  });

  it("imports a package written before positions and layouts were carried, as it did then", async () => {
    const ctx = await boot();
    const { made } = await laidOut(ctx);
    const out = await exportTo(ctx, made.projectId);
    const old = repack(fs.readFileSync(out.file), (files) => {
      delete files["tables/project_progress.json"];
      delete files["tables/project_workspace.json"];
      const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as { dataVersion: number; entries: Array<{ path: string }> };
      manifest.dataVersion = 9;
      manifest.entries = manifest.entries.filter((entry) => !entry.path.includes("project_progress") && !entry.path.includes("project_workspace"));
      files["manifest.json"] = strToU8(JSON.stringify(manifest));
    });
    const file = path.join(tmp(), "old.manga-project.zip");
    fs.writeFileSync(file, old);
    const imported = ok<{ projectId: string; mode: string }>(await importFrom(ctx, file));
    expect(imported.mode).toBe("copy");
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM progress WHERE context_id = ?", imported.projectId).n).toBe(0);
    expect((await tabsOf(ctx, imported.projectId)).tabs).toEqual([]);
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM whiteboards WHERE project_id = ?", imported.projectId).n).toBe(1);
  });
});
