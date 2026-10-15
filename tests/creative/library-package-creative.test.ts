import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCreative, type CreativeSection } from "../../packages/app-core/src/creative/library-section.ts";
import { importLibraryPackageResolved, previewLibraryPackage, readLibraryPackage } from "../../packages/app-core/src/domain/library-package.ts";
import { startApp } from "../helpers/app.ts";
import { OWNED_TABLES, makeProject, one, all, ok, run } from "../helpers/creative-project.ts";

type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (apps.length) { try { apps.pop()!.app.close(); } catch { /* closed */ } }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-libpkg-")); dirs.push(dir); return dir; };
async function boot() { const ctx = await startApp(); apps.push(ctx); return ctx; }
const fails = (result: Awaited<ReturnType<typeof run>>) => {
  expect(result.status).toBe("error");
  return (result as { error: { code: string; details?: Record<string, unknown> } }).error;
};

/** The profile of a creator: a library, a project that uses it, and the things kept outside any project (two versions of a page, a loose excerpt). */
async function seed(ctx: App) {
  const made = await makeProject(ctx);
  const sql = ctx.app.store.sqlite;
  const at = "2026-10-01T10:00:00.000Z";
  const page = (id: string, url: string, version: number, previous: string | null, body: string) => sql.prepare("INSERT INTO excerpt_pages(id, url, title, fetched_at, content_hash, body_text, version, previous_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, url, "海边小镇", at, `hash-${id}`, body, version, previous, at);
  page("pgv-loose-1", "https://pages.example.org/sea", 1, null, "海边的小镇有一座白色的灯塔，渔船在清晨出港。");
  page("pgv-loose-2", "https://pages.example.org/sea", 2, "pgv-loose-1", "海边的小镇有一座白色的灯塔，渔船在清晨出港，傍晚满载而归。");
  const loose = ok<{ excerpt: { id: string } }>(await run(ctx, "excerpt.create", { pageId: "pgv-loose-2", start: 0, end: 16, title: "灯塔", note: "不属于任何项目" })).excerpt.id;
  return { ...made, loose };
}
const exportTo = async (ctx: App, dir = tmp()) => {
  ok(await run(ctx, "library.exportPackage", { pathHandle: ctx.app.registerPath("export", dir) }));
  return dir;
};
const importInto = (ctx: App, dir: string, extra: Record<string, unknown> = {}) => run(ctx, "package.importResolved", { pathHandle: ctx.app.registerPath("import", dir), ...extra });

/** A section with what only the time of writing changes taken out, so two profiles can be compared. */
const plain = (section: CreativeSection) => JSON.parse(JSON.stringify({
  ...section,
  projects: section.projects.map((bundle) => ({ ...bundle, project: { ...bundle.project, updated_at: "" }, snapshots: bundle.snapshots.map((snap) => ({ ...snap, takenAt: "" })).sort((a, b) => `${a.kind}${a.id}`.localeCompare(`${b.kind}${b.id}`)) })),
}));
const counts = (ctx: App) => Object.fromEntries([...OWNED_TABLES, "projects", "excerpt_pages", "works", "content_objects"].map((table) => [table, one<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM ${table}`).n]));

describe("projects in a library package (AT-25, AT-28, DATA-01)", () => {
  it("writes the projects and what no project holds into the package, and nothing of the conversations or the search indexes", async () => {
    const ctx = await boot();
    const made = await seed(ctx);
    const dir = await exportTo(ctx);
    const manifest = readLibraryPackage(dir);
    expect(manifest.creative!.projects).toHaveLength(1);
    expect((manifest.creative!.projects[0] as { project: { id: string } }).project.id).toBe(made.projectId);
    expect(manifest.creative!.loose.pages.map((page) => page.id)).toEqual(["pgv-loose-1", "pgv-loose-2"]);
    expect(manifest.creative!.loose.excerpts.map((row) => row.id)).toEqual([made.loose]);
    expect(Object.keys(manifest)).not.toContain("research_idx");
    expect(JSON.stringify(manifest.creative)).not.toMatch(/agent_sessions|research_idx|semantic/);
    // A profile with no project writes the package as it always was.
    const bare = await boot();
    expect(Object.keys(readLibraryPackage(await exportTo(bare)))).not.toContain("creative");
  });

  it("restores everything into an empty profile, and the project is whole there: its references resolve, so nothing is missing", async () => {
    const source = await boot();
    const made = await seed(source);
    const dir = await exportTo(source);
    const target = await boot();
    const preview = ok<{ empty: boolean; counts: Record<string, number>; conflicts: unknown[] }>(await run(target, "package.preview", { pathHandle: target.app.registerPath("import", dir) }));
    expect(preview).toMatchObject({ empty: true, conflicts: [] });
    expect(preview.counts.projects).toBe(1);
    ok(await run(target, "library.importPackage", { pathHandle: target.app.registerPath("import", dir) }));

    expect(plain(collectCreative(target.app.store))).toEqual(plain(collectCreative(source.app.store)));
    const detail = ok<{ materials: Array<{ kind: string; state: string; snapshot?: unknown }> }>(await run(target, "project.get", { projectId: made.projectId }));
    expect(detail.materials.map((item) => item.state)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(detail.materials.some((item) => item.snapshot)).toBe(false);
    expect(one<{ n: number }>(target, "SELECT COUNT(*) AS n FROM project_snapshots").n).toBe(0);
    // The page history keeps its order, and the excerpts can be found again.
    expect(all<{ id: string; version: number; previous: string | null }>(target, "SELECT id, version, previous_id AS previous FROM excerpt_pages WHERE url = 'https://pages.example.org/sea' ORDER BY version")).toEqual([
      { id: "pgv-loose-1", version: 1, previous: null }, { id: "pgv-loose-2", version: 2, previous: "pgv-loose-1" },
    ]);
    const found = ok<{ results: Array<{ id: string }> }>(await run(target, "research.search", { text: "灯塔", scopes: ["excerpt"] })).results.map((item) => item.id);
    expect(found).toContain(made.loose);
    const embeds = ok<{ embeds: Array<{ state: string }> }>(await run(target, "embed.list", { sourceKind: "whiteboard", sourceId: made.boardId })).embeds;
    expect(embeds.map((item) => item.state)).toEqual(["valid", "valid"]);
    // A second trip gives the same package content.
    const again = await exportTo(target);
    expect(plain(readLibraryPackage(again).creative as unknown as CreativeSection)).toEqual(plain(readLibraryPackage(dir).creative as unknown as CreativeSection));
  });

  it("names a project that the profile already has as a conflict, and the default is then not to overwrite it", async () => {
    const ctx = await boot();
    const made = await seed(ctx);
    const dir = await exportTo(ctx);
    const preview = previewLibraryPackage(ctx.app.store, dir);
    expect(preview.empty).toBe(false);
    expect(preview.conflicts).toContainEqual({ kind: "project", id: made.projectId, label: "雨夜纪录片", reason: "project id already exists" });
    expect(preview.defaultStrategy).toBe("duplicate");
  });

  it("duplicates: the copy is a project of its own whose references follow the duplicated works and notes, and the original does not change", async () => {
    const ctx = await boot();
    const made = await seed(ctx);
    const dir = await exportTo(ctx);
    const original = JSON.stringify(plain(collectCreative(ctx.app.store)).projects);
    const before = counts(ctx);
    ok(await importInto(ctx, dir, { strategy: "duplicate" }));
    const after = counts(ctx);
    expect(after.projects).toBe(2);
    expect(after.works).toBe(before.works! * 2);
    expect(after.content_objects).toBe(before.content_objects! * 2);
    expect(after.whiteboards).toBe(2);
    expect(JSON.stringify(plain(collectCreative(ctx.app.store)).projects.filter((bundle: { project: { id: string } }) => bundle.project.id === made.projectId))).toBe(original);

    const copyId = one<{ id: string }>(ctx, "SELECT id FROM projects WHERE id <> ?", made.projectId).id;
    const copy = ok<{ project: { name: string }; materials: Array<{ kind: string; targetId: string; state: string }> }>(await run(ctx, "project.get", { projectId: copyId }));
    expect(copy.project.name).toBe("雨夜纪录片（副本）");
    // The package's book and note became new works and notes; the copy's references lead to those, and all of them are there.
    expect(copy.materials.map((item) => item.state)).toEqual(["ok", "ok", "ok", "ok"]);
    const newWork = one<{ id: string }>(ctx, "SELECT id FROM works WHERE id <> ?", made.book.workId).id;
    expect(copy.materials.find((item) => item.kind === "work")!.targetId).toBe(newWork);
    const newNote = one<{ id: string }>(ctx, "SELECT id FROM content_objects WHERE title = '笔记甲' AND id <> ?", made.noteA).id;
    const boardRefs = all<{ data: string }>(ctx, "SELECT data_json AS data FROM whiteboard_nodes WHERE board_id = (SELECT id FROM whiteboards WHERE project_id = ?) AND kind = 'ref'", copyId).map((row) => JSON.parse(row.data) as { refKind: string; targetId: string });
    expect(boardRefs.find((ref) => ref.refKind === "note")!.targetId).toBe(newNote);
    expect(copy.materials.find((item) => item.kind === "note")!.targetId).toBe(newNote);
    expect(one<{ resource: string }>(ctx, "SELECT c.resource_id AS resource FROM rough_cut_clips c JOIN rough_cuts r ON r.id = c.cut_id WHERE r.project_id = ?", copyId).resource).not.toBe(made.book.resourceId);
  });

  it("skips: a project that is already there stays as it is, whatever the package says", async () => {
    const ctx = await boot();
    const made = await seed(ctx);
    const dir = await exportTo(ctx);
    ok(await run(ctx, "project.update", { projectId: made.projectId, name: "改过名字" }));
    const before = counts(ctx);
    ok(await importInto(ctx, dir, { strategy: "skip" }));
    expect(counts(ctx)).toEqual(before);
    expect(one<{ name: string }>(ctx, "SELECT name FROM projects WHERE id = ?", made.projectId).name).toBe("改过名字");
  });

  it("replaces: the packaged project takes the place of the one here, under the same ids, and a per-project decision overrides the strategy", async () => {
    const ctx = await boot();
    const made = await seed(ctx);
    const dir = await exportTo(ctx);
    const changed = async () => {
      ok(await run(ctx, "project.update", { projectId: made.projectId, name: "改过名字" }));
      ok(await run(ctx, "whiteboard.rename", { boardId: made.boardId, title: "改过的白板" }));
      ok(await run(ctx, "project.addTerm", { projectId: made.projectId, term: "新词" }));
    };
    await changed();
    // Decided to keep this one: the strategy says replace, the decision for the project says skip.
    ok(await importInto(ctx, dir, { strategy: "replace", decisions: [{ kind: "project", id: made.projectId, action: "skip" }] }));
    expect(one<{ name: string }>(ctx, "SELECT name FROM projects WHERE id = ?", made.projectId).name).toBe("改过名字");
    expect(one<{ title: string }>(ctx, "SELECT title FROM whiteboards WHERE id = ?", made.boardId).title).toBe("改过的白板");

    ok(await importInto(ctx, dir, { strategy: "replace" }));
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM projects").n).toBe(1);
    expect(one<{ name: string }>(ctx, "SELECT name FROM projects WHERE id = ?", made.projectId).name).toBe("雨夜纪录片");
    expect(one<{ title: string }>(ctx, "SELECT title FROM whiteboards WHERE id = ?", made.boardId).title).toBe("素材墙");
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM project_terms WHERE project_id = ?", made.projectId).n).toBe(1);
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM whiteboards").n).toBe(1);
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM excerpts WHERE project_id IS NULL").n).toBe(1);
  });

  it("refuses a package whose projects are not well formed, before anything is written", async () => {
    const source = await boot();
    await seed(source);
    const dir = await exportTo(source);
    const manifestFile = path.join(dir, "manifest.json");
    const original = fs.readFileSync(manifestFile, "utf8");
    const tamper = (change: (manifest: { creative: { projects: Array<{ tables: Record<string, Array<Record<string, unknown>>> }>; loose: { pages: unknown[]; excerpts: Array<Record<string, unknown>> } } }) => void) => {
      const manifest = JSON.parse(original);
      change(manifest);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    };
    const target = await boot();
    const before = counts(target);
    for (const change of [
      (m: Parameters<Parameters<typeof tamper>[0]>[0]) => { m.creative.projects[0]!.tables.whiteboard_nodes![0]!.x = "left"; },
      (m: Parameters<Parameters<typeof tamper>[0]>[0]) => { m.creative.projects[0]!.tables.whiteboard_nodes![0]!.board_id = "wb-nowhere"; },
      (m: Parameters<Parameters<typeof tamper>[0]>[0]) => { m.creative.loose.excerpts[0]!.page_id = "pg-nowhere"; },
      (m: Parameters<Parameters<typeof tamper>[0]>[0]) => { m.creative.loose.excerpts[0]!.project_id = "prj-x"; },
      (m: Parameters<Parameters<typeof tamper>[0]>[0]) => { m.creative.projects.push(m.creative.projects[0]!); },
    ]) {
      tamper(change);
      expect(fails(await run(target, "package.preview", { pathHandle: target.app.registerPath("import", dir) })).code).toBe("VALIDATION_ERROR");
      expect(fails(await run(target, "library.importPackage", { pathHandle: target.app.registerPath("import", dir) })).code).toBe("VALIDATION_ERROR");
      expect(counts(target)).toEqual(before);
    }
    fs.writeFileSync(manifestFile, original);
    ok(await run(target, "library.importPackage", { pathHandle: target.app.registerPath("import", dir) }));
  });

  it("is all or nothing: a failure while the projects are written takes the books and notes of the same import back out", async () => {
    const source = await boot();
    await seed(source);
    const dir = await exportTo(source);
    const target = await boot();
    const before = counts(target);
    const hooks = {
      adoptPage: () => "pgv-x", indexExcerpt: () => { throw new Error("stopped part of the way"); }, removeProject: () => undefined,
    };
    expect(() => importLibraryPackageResolved(target.app.store, dir, { strategy: "replace", creative: hooks })).toThrow("stopped part of the way");
    expect(counts(target)).toEqual(before);
    expect(one<{ status: string }>(target, "SELECT status FROM recovery_jobs ORDER BY created_at DESC LIMIT 1").status).toBe("rolled-back");
    // Without the means to write projects, a package that holds some is not half imported either.
    expect(() => importLibraryPackageResolved(target.app.store, dir, { strategy: "replace" })).toThrow("no way to import them");
    expect(counts(target)).toEqual(before);
  });
});
