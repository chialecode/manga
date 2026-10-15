import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { all, ok, one, run } from "../helpers/creative-project.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Clip = { id: string; resourceId: string; revisionId: string; title: string; label: string; inMs: number; outMs: number; sortKey: string; available: boolean; durationMs: number | null };
type Doc = { cut: { id: string; projectId: string | null; title: string }; clips: Clip[]; totalMs: number; ops: { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null }; exporting: boolean };

const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

async function boot(restartOf?: App) {
  restartOf?.app.close();
  const ctx = await startApp(restartOf ? { profileRoot: restartOf.profileRoot } : {});
  apps.push(ctx);
  return ctx;
}

/** A project with a sequence and two videos that only exist as rows: editing never reads a file, so these tests do not need the media tool (exporting does). */
async function setup(ctx: App) {
  const projectId = ok<{ id: string }>(await run(ctx, "project.create", { name: "粗剪项目" })).id;
  const cutId = ok<{ cut: { id: string } }>(await run(ctx, "roughcut.create", { projectId, title: "第一版" })).cut.id;
  const a = seedVideo(ctx.app, { title: "视频甲", durationMs: 12_000, probe: true });
  const b = seedVideo(ctx.app, { title: "视频乙", durationMs: 8_000, probe: true });
  return { projectId, cutId, a, b };
}
const edit = async (ctx: App, cutId: string, actions: unknown[], label?: string) => ok<{ doc: Doc; created: string[] }>(await run(ctx, "roughcut.edit", { cutId, actions, ...(label ? { label } : {}) }));
const get = async (ctx: App, cutId: string) => ok<Doc>(await run(ctx, "roughcut.get", { cutId }));
const order = (doc: Doc) => doc.clips.map((clip) => clip.id);

describe("rough cut sequences (AT-32)", () => {
  it("makes sequences in a project, lists them with their clips and length, renames and deletes them", async () => {
    const ctx = await boot();
    const { projectId, cutId, a } = await setup(ctx);
    await edit(ctx, cutId, [{ type: "add", id: "c1", resourceId: a.resourceId, inMs: 1000, outMs: 3500 }]);
    ok(await run(ctx, "roughcut.create", { projectId, title: "第二版" }));
    const listed = ok<{ cuts: Array<{ id: string; title: string; clips: number; totalMs: number; projectId: string }> }>(await run(ctx, "roughcut.list", { projectId })).cuts;
    expect(listed.map((cut) => [cut.title, cut.clips, cut.totalMs])).toEqual(expect.arrayContaining([["第一版", 1, 2500], ["第二版", 0, 0]]));
    expect(listed.every((cut) => cut.projectId === projectId)).toBe(true);
    ok(await run(ctx, "roughcut.rename", { cutId, title: "终版" }));
    expect((await get(ctx, cutId)).cut.title).toBe("终版");

    // The project knows how many sequences it holds, and a sequence cannot be made in a project that is not there.
    expect(ok<{ project: { counts: { roughCuts: number } } }>(await run(ctx, "project.get", { projectId })).project.counts.roughCuts).toBe(2);
    expect((await run(ctx, "roughcut.create", { projectId: "none", title: "x" })).error?.code).toBe("NOT_FOUND");
    expect((await run(ctx, "roughcut.get", { cutId: "none" })).error?.code).toBe("NOT_FOUND");

    const removed = ok<{ removedClips: number }>(await run(ctx, "roughcut.delete", { cutId }));
    expect(removed.removedClips).toBe(1);
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM rough_cut_clips WHERE cut_id = ?", cutId).n).toBe(0);
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM creative_ops WHERE doc_kind = 'roughcut' AND doc_id = ?", cutId).n).toBe(0);
    expect((await run(ctx, "roughcut.get", { cutId })).error?.code).toBe("NOT_FOUND");
  });

  it("adds clips of videos in the order given, each keeping the revision it was marked on, and totals their length", async () => {
    const ctx = await boot();
    const { cutId, a, b } = await setup(ctx);
    const first = await edit(ctx, cutId, [
      { type: "add", id: "c1", resourceId: a.resourceId, inMs: 1000, outMs: 3000, label: "开场" },
      { type: "add", id: "c2", resourceId: b.resourceId, resourceRevisionId: b.revisionId, inMs: 0, outMs: 2000 },
      { type: "add", id: "c3", resourceId: a.resourceId, inMs: 5000, outMs: 6000, index: 0 },
    ], "加入三段");
    expect(first.created).toEqual(["c1", "c2", "c3"]);
    expect(order(first.doc)).toEqual(["c3", "c1", "c2"]);
    expect(first.doc.totalMs).toBe(5000);
    expect(first.doc.clips.find((clip) => clip.id === "c1")).toMatchObject({ title: "视频甲", label: "开场", revisionId: a.revisionId, resourceId: a.resourceId, durationMs: 12_000, available: false });
    expect(first.doc.clips.find((clip) => clip.id === "c2")!.revisionId).toBe(b.revisionId);

    // Without an id the service makes one, and it is returned in the order the clips were added.
    const more = await edit(ctx, cutId, [{ type: "add", resourceId: b.resourceId, inMs: 100, outMs: 900 }]);
    expect(more.created).toHaveLength(1);
    expect(more.created[0]).toMatch(/^rcc_/);
  });

  it("moves, trims, relabels and removes clips; each call is one step to undo and redo, and a restart keeps the history", async () => {
    const first = await boot();
    const { cutId, a, b } = await setup(first);
    await edit(first, cutId, [
      { type: "add", id: "c1", resourceId: a.resourceId, inMs: 0, outMs: 2000 }, { type: "add", id: "c2", resourceId: b.resourceId, inMs: 0, outMs: 2000 }, { type: "add", id: "c3", resourceId: a.resourceId, inMs: 4000, outMs: 5000 },
    ], "加入");
    expect(order((await edit(first, cutId, [{ type: "move", clipId: "c3", index: 0 }], "移到最前")).doc)).toEqual(["c3", "c1", "c2"]);
    expect(order((await edit(first, cutId, [{ type: "move", clipId: "c3", index: 2 }])).doc)).toEqual(["c1", "c2", "c3"]);
    const trimmed = await edit(first, cutId, [{ type: "update", clipId: "c1", inMs: 500, outMs: 4000, label: "改过" }, { type: "update", clipId: "c2", label: "只改名" }], "修剪");
    expect(trimmed.doc.clips.map((clip) => [clip.id, clip.inMs, clip.outMs, clip.label])).toEqual([["c1", 500, 4000, "改过"], ["c2", 0, 2000, "只改名"], ["c3", 4000, 5000, ""]]);
    expect(trimmed.doc.ops).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "修剪" });
    const removed = (await edit(first, cutId, [{ type: "remove", clipId: "c2" }])).doc;
    expect(order(removed)).toEqual(["c1", "c3"]);
    expect(removed.totalMs).toBe(4500);

    const second = await boot(first);
    expect((await get(second, cutId)).ops.canUndo).toBe(true);
    const undone = ok<{ doc: Doc; label: string }>(await run(second, "roughcut.undo", { cutId }));
    expect(order(undone.doc)).toEqual(["c1", "c2", "c3"]);
    expect(undone.doc.clips[1]).toMatchObject({ inMs: 0, outMs: 2000, label: "只改名" });
    const back = ok<{ doc: Doc }>(await run(second, "roughcut.undo", { cutId }));
    // One call with two updates is undone as one step.
    expect(back.doc.clips.map((clip) => [clip.id, clip.inMs, clip.outMs, clip.label])).toEqual([["c1", 0, 2000, ""], ["c2", 0, 2000, ""], ["c3", 4000, 5000, ""]]);
    expect(back.doc.ops.redoLabel).toBe("修剪");
    expect(order(ok<{ doc: Doc }>(await run(second, "roughcut.redo", { cutId })).doc)).toEqual(["c1", "c2", "c3"]);
    expect((await get(second, cutId)).clips[0]).toMatchObject({ inMs: 500, outMs: 4000, label: "改过" });

    // Undo all the way, then there is nothing left; a new edit drops what could have been redone.
    for (let i = 0; i < 10; i += 1) { const step = await run(second, "roughcut.undo", { cutId }); if (step.status !== "ok") { expect(step.error?.code).toBe("NOT_FOUND"); break; } }
    expect((await get(second, cutId)).clips).toEqual([]);
    expect((await run(second, "roughcut.undo", { cutId })).error?.code).toBe("NOT_FOUND");
    await edit(second, cutId, [{ type: "add", id: "n1", resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    expect((await run(second, "roughcut.redo", { cutId })).error?.code).toBe("NOT_FOUND");
  });

  it("changes the order with sort keys, so moving a clip rewrites only that clip", async () => {
    const ctx = await boot();
    const { cutId, a } = await setup(ctx);
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    await edit(ctx, cutId, ids.map((id, i) => ({ type: "add", id, resourceId: a.resourceId, inMs: i * 1000, outMs: i * 1000 + 500 })));
    const keys = (doc: Doc) => Object.fromEntries(doc.clips.map((clip) => [clip.id, clip.sortKey]));
    const before = keys(await get(ctx, cutId));
    const moved = await edit(ctx, cutId, [{ type: "move", clipId: "c5", index: 1 }]);
    expect(order(moved.doc)).toEqual(["c1", "c5", "c2", "c3", "c4"]);
    const after = keys(moved.doc);
    expect(Object.keys(after).filter((id) => after[id] !== before[id])).toEqual(["c5"]);
    // Many moves in the same place do not make the keys grow without end.
    for (let i = 0; i < 80; i += 1) await edit(ctx, cutId, [{ type: "move", clipId: i % 2 ? "c4" : "c5", index: 1 }]);
    const doc = await get(ctx, cutId);
    expect(doc.clips).toHaveLength(5);
    expect(Math.max(...doc.clips.map((clip) => clip.sortKey.length))).toBeLessThan(40);
    expect(new Set(doc.clips.map((clip) => clip.sortKey)).size).toBe(5);
  });

  it("refuses what cannot be a clip, and an edit that fails changes nothing, not even the history", async () => {
    const ctx = await boot();
    const { cutId, a } = await setup(ctx);
    const comic = seedComic(ctx.app, { title: "一本漫画" });
    const text = ok<{ resourceId: string }>(await run(ctx, "library.importText", { title: "一篇小说", bytes: [...Buffer.from("小说正文。")] }));
    await edit(ctx, cutId, [{ type: "add", id: "c1", resourceId: a.resourceId, inMs: 0, outMs: 2000 }]);
    const reason = async (action: unknown) => { const result = await run(ctx, "roughcut.edit", { cutId, actions: [action] }); return [result.error?.code, (result.error?.details as { reason?: string } | undefined)?.reason]; };
    expect(await reason({ type: "add", resourceId: a.resourceId, inMs: 3000, outMs: 3000 })).toEqual(["VALIDATION_ERROR", "range"]);
    expect(await reason({ type: "add", resourceId: a.resourceId, inMs: 4000, outMs: 3000 })).toEqual(["VALIDATION_ERROR", "range"]);
    // A mark a little past the last frame is allowed (the end of the video is rarely on a frame), well past it is not.
    expect((await run(ctx, "roughcut.edit", { cutId, actions: [{ type: "add", id: "end", resourceId: a.resourceId, inMs: 11_000, outMs: 12_400 }] })).status).toBe("ok");
    expect(await reason({ type: "add", resourceId: a.resourceId, inMs: 11_000, outMs: 13_500 })).toEqual(["VALIDATION_ERROR", "range"]);
    expect(await reason({ type: "add", resourceId: comic.resourceId, inMs: 0, outMs: 1000 })).toEqual(["VALIDATION_ERROR", "not-video"]);
    expect(await reason({ type: "add", resourceId: text.resourceId, inMs: 0, outMs: 1000 })).toEqual(["VALIDATION_ERROR", "not-video"]);
    expect((await reason({ type: "add", resourceId: "nope", inMs: 0, outMs: 1000 }))[0]).toBe("NOT_FOUND");
    // A revision that belongs to another video is not this video's revision.
    expect((await reason({ type: "add", resourceId: a.resourceId, resourceRevisionId: comic.revisionId, inMs: 0, outMs: 1000 }))[0]).toBe("NOT_FOUND");
    expect(await reason({ type: "add", id: "c1", resourceId: a.resourceId, inMs: 0, outMs: 1000 })).toEqual(["VALIDATION_ERROR", "duplicate"]);
    expect((await reason({ type: "update", clipId: "nope", label: "x" }))[0]).toBe("NOT_FOUND");
    expect(await reason({ type: "update", clipId: "c1", outMs: 0 })).toEqual(["VALIDATION_ERROR", "range"]);
    expect((await reason({ type: "move", clipId: "nope", index: 0 }))[0]).toBe("NOT_FOUND");
    expect((await reason({ type: "remove", clipId: "nope" }))[0]).toBe("NOT_FOUND");
    // Input checks happen before the service sees them.
    expect((await reason({ type: "add", resourceId: a.resourceId, inMs: -1, outMs: 5 }))[0]).toBe("VALIDATION_ERROR");
    expect((await reason({ type: "add", resourceId: a.resourceId, inMs: 0.5, outMs: 5 }))[0]).toBe("VALIDATION_ERROR");
    expect((await reason({ type: "split", clipId: "c1" }))[0]).toBe("VALIDATION_ERROR");

    // A call of several steps whose last step fails leaves everything as it was, and adds nothing to undo.
    const before = await get(ctx, cutId);
    const failed = await run(ctx, "roughcut.edit", { cutId, actions: [{ type: "add", id: "ok", resourceId: a.resourceId, inMs: 0, outMs: 500 }, { type: "remove", clipId: "c1" }, { type: "remove", clipId: "ghost" }] });
    expect(failed.status).toBe("error");
    const after = await get(ctx, cutId);
    expect(after.clips).toEqual(before.clips);
    expect(after.ops).toEqual(before.ops);
    expect(after.cut).toEqual(before.cut);
  });

  it("holds at most two hundred clips", async () => {
    const ctx = await boot();
    const { cutId, a } = await setup(ctx);
    const adds = (count: number, from: number) => Array.from({ length: count }, (_, i) => ({ type: "add", resourceId: a.resourceId, inMs: 0, outMs: 100 + from + i }));
    await edit(ctx, cutId, adds(200, 0));
    const over = await run(ctx, "roughcut.edit", { cutId, actions: adds(1, 500) });
    expect(over.error).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "limit" } });
    expect((await get(ctx, cutId)).clips).toHaveLength(200);
  });

  it("keeps a clip whose video went, marked as missing, and says so in the plan instead of shortening the sequence", async () => {
    const ctx = await boot();
    const { cutId, a, b } = await setup(ctx);
    await edit(ctx, cutId, [{ type: "add", id: "c1", resourceId: a.resourceId, inMs: 0, outMs: 2000 }, { type: "add", id: "c2", resourceId: b.resourceId, inMs: 0, outMs: 2000 }]);
    // The video's streams are no longer recorded: it cannot be loaded as a video.
    ctx.app.store.sqlite.prepare("DELETE FROM media_probes WHERE resource_revision_id = ?").run(b.revisionId);
    const doc = await get(ctx, cutId);
    expect(doc.clips.map((clip) => [clip.id, clip.title, clip.available])).toEqual([["c1", "视频甲", false], ["c2", "视频乙", false]]);
    expect(doc.totalMs).toBe(4000);
    const plan = ok<{ plan: { compatible: boolean; problems: Array<{ code: string; clipId?: string }>; clips: Array<{ clipId: string; actualInMs: number; startShiftMs: number }> } }>(await run(ctx, "roughcut.plan", { cutId })).plan;
    expect(plan.compatible).toBe(false);
    expect(plan.problems).toEqual([{ code: "source-missing", clipId: "c1" }, { code: "source-missing", clipId: "c2" }]);
    expect(plan.clips.map((clip) => [clip.clipId, clip.actualInMs, clip.startShiftMs])).toEqual([["c1", 0, 0], ["c2", 0, 0]]);
  });

  // Exporting asks for the media tool before it plans, so this half needs it, unlike the rest of this file.
  it.skipIf(mediaPrerequisitesAbsent)("refuses to export a sequence whose video went, and starts nothing", async () => {
    const ctx = await boot();
    const { cutId, a, b } = await setup(ctx);
    await edit(ctx, cutId, [{ type: "add", id: "c1", resourceId: a.resourceId, inMs: 0, outMs: 2000 }, { type: "add", id: "c2", resourceId: b.resourceId, inMs: 0, outMs: 2000 }]);
    ctx.app.store.sqlite.prepare("DELETE FROM media_probes WHERE resource_revision_id = ?").run(b.revisionId);
    const exported = await run(ctx, "roughcut.export", { cutId, pathHandle: ctx.app.registerPath("directory", ctx.profileRoot) });
    expect(exported.error).toMatchObject({ code: "UNSUPPORTED_FORMAT", details: { reason: "incompatible" } });
    expect(all(ctx, "SELECT id FROM rough_cut_exports")).toEqual([]);
  });

  it("states an empty sequence as a problem of its own", async () => {
    const ctx = await boot();
    const { cutId } = await setup(ctx);
    const plan = ok<{ plan: { compatible: boolean; problems: Array<{ code: string }>; container: string | null; extension: string | null } }>(await run(ctx, "roughcut.plan", { cutId })).plan;
    expect(plan).toMatchObject({ compatible: false, problems: [{ code: "empty" }], container: null, extension: null });
  });

  it("logs making, renaming and deleting a sequence under rough cuts, by its title, and not each edit", async () => {
    const ctx = await boot();
    const { cutId, a } = await setup(ctx);
    await edit(ctx, cutId, [{ type: "add", resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    ok(await run(ctx, "roughcut.rename", { cutId, title: "改名后" }));
    ok(await run(ctx, "roughcut.undo", { cutId }));
    ok(await run(ctx, "roughcut.delete", { cutId }));
    const rows = all<{ action: string; category: string; object_kind: string; object_id: string; object_label: string | null }>(ctx, "SELECT action, category, object_kind, object_id, object_label FROM operation_log WHERE category = 'roughcut' ORDER BY id");
    expect(rows.map((row) => [row.action, row.object_kind, row.object_id === cutId])).toEqual([["roughcut.create", "roughcut", true], ["roughcut.rename", "roughcut", true], ["roughcut.delete", "roughcut", true]]);
    expect(rows[0]!.object_label).toBe("第一版");
    expect(rows[1]!.object_label).toBe("改名后");
  });

  it("goes with its project, and is not touched by the other projects' deletion", async () => {
    const ctx = await boot();
    const { projectId, cutId, a } = await setup(ctx);
    const other = ok<{ id: string }>(await run(ctx, "project.create", { name: "别的项目" })).id;
    const otherCut = ok<{ cut: { id: string } }>(await run(ctx, "roughcut.create", { projectId: other, title: "别的" })).cut.id;
    await edit(ctx, cutId, [{ type: "add", resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    await edit(ctx, otherCut, [{ type: "add", resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    const now = new Date().toISOString();
    ctx.app.store.sqlite.prepare("INSERT INTO rough_cut_exports(id, cut_id, state, plan_json, result_json, tmp_name, final_name, error_json, created_at, updated_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?)")
      .run("rce-old", cutId, "failed", JSON.stringify({ clips: [] }), "{}", now, now);
    ok(await run(ctx, "project.delete", { projectId }));
    expect(all(ctx, "SELECT id FROM rough_cuts")).toEqual([{ id: otherCut }]);
    expect(all(ctx, "SELECT cut_id FROM rough_cut_clips").map((row) => (row as { cut_id: string }).cut_id)).toEqual([otherCut]);
    expect(all(ctx, "SELECT id FROM rough_cut_exports")).toEqual([]);
    expect(all(ctx, "SELECT doc_id FROM creative_ops WHERE doc_kind = 'roughcut'").map((row) => (row as { doc_id: string }).doc_id)).not.toContain(cutId);
    expect(order(await get(ctx, otherCut))).toHaveLength(1);
  });

  it("is off with its module: the commands refuse, nothing is lost, and switching it on brings the sequences back", async () => {
    const ctx = await boot();
    const { cutId, a } = await setup(ctx);
    await edit(ctx, cutId, [{ type: "add", id: "c1", resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    ok(await run(ctx, "settings.setModule", { featureId: "roughcut", enabled: false }));
    const off = await run(ctx, "roughcut.get", { cutId });
    expect(off.status).toBe("error");
    expect((await run(ctx, "roughcut.edit", { cutId, actions: [{ type: "remove", clipId: "c1" }] })).status).toBe("error");
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM rough_cut_clips WHERE cut_id = ?", cutId).n).toBe(1);
    ok(await run(ctx, "settings.setModule", { featureId: "roughcut", enabled: true }));
    expect(order(await get(ctx, cutId))).toEqual(["c1"]);
  });

  it("does not need the video module: switching it off leaves the sequences readable and editable, and switching it on changes nothing", async () => {
    const ctx = await boot();
    const { cutId, a } = await setup(ctx);
    await edit(ctx, cutId, [{ type: "add", id: "c1", resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    ok(await run(ctx, "settings.setModule", { featureId: "video", enabled: false }));
    expect(order(await get(ctx, cutId))).toEqual(["c1"]);
    await edit(ctx, cutId, [{ type: "update", clipId: "c1", label: "仍可改" }]);
    expect((await get(ctx, cutId)).clips[0]!.label).toBe("仍可改");
    ok(await run(ctx, "settings.setModule", { featureId: "video", enabled: true }));
    expect(order(await get(ctx, cutId))).toEqual(["c1"]);
  });
});
