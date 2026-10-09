import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { all, ok, one, run } from "../helpers/creative-project.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";
import { inLibrary, requireSamples, samplePath } from "../helpers/samples.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Problem = { code: string; clipId?: string };
type Plan = { compatible: boolean; problems: Problem[]; container: string | null; extension: string | null; requestedMs: number; actualMs: number; clips: Array<{ clipId: string; requestedInMs: number; requestedOutMs: number; actualInMs: number; actualOutMs: number; startShiftMs: number; endShiftMs: number; onKeyframe: boolean; frames: number; toEnd: boolean; problems: Problem[] }> };
type Export = { id: string; state: string; step: string | null; done: number; total: number; fileName: string | null; bytes: number | null; check: { ok: boolean; expectedFrames: number; actualFrames: number; expectedMs: number; actualMs: number; streamsMatch: boolean } | null; timing: { totalMs: number; toolMs: number; overheadMs: number } | null; error: { code: string; message: string } | null };

const apps: App[] = [];
const dirs: string[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const tmp = (): string => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-roughcut-")); dirs.push(dir); return dir; };
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function boot(restartOf?: App) {
  restartOf?.app.close();
  const ctx = await startApp(restartOf ? { profileRoot: restartOf.profileRoot } : {});
  apps.push(ctx);
  return ctx;
}

const pick = (ctx: App, purpose: "file" | "directory", target: string) => ctx.app.registerPath(purpose, target);

/** A copy of a sample under the name given, in a folder of its own, imported as a video: the original is never the file that gets cut. */
async function importCopy(ctx: App, sample: string, name = sample, folder = tmp(), sampleId = "video-roughcut") {
  const file = path.join(folder, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(sample ? samplePath(sampleId, sample) : samplePath(sampleId), file);
  const value = ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importDocument", { title: path.parse(name).name, kind: "video", pathHandle: pick(ctx, "file", inLibrary(ctx.app, file, "video")) }));
  return { ...value, file };
}

async function sequence(ctx: App, clips: Array<{ resourceId: string; inMs: number; outMs: number }>) {
  const projectId = ok<{ id: string }>(await run(ctx, "project.create", { name: "粗剪" })).id;
  const cutId = ok<{ cut: { id: string } }>(await run(ctx, "roughcut.create", { projectId, title: "试剪" })).cut.id;
  const edit = ok<{ created: string[] }>(await run(ctx, "roughcut.edit", { cutId, actions: clips.map((clip) => ({ type: "add", ...clip })) }));
  return { projectId, cutId, clipIds: edit.created };
}

const plan = async (ctx: App, cutId: string) => ok<{ plan: Plan }>(await run(ctx, "roughcut.plan", { cutId })).plan;
const exportTo = (ctx: App, cutId: string, dir: string, fileName?: string) => run(ctx, "roughcut.export", { cutId, pathHandle: pick(ctx, "directory", dir), ...(fileName ? { fileName } : {}) });

/** Waits for the export to end, as the interface does: by what the record says. */
async function finish(ctx: App, cutId: string, exportId?: string): Promise<Export> {
  await ctx.app.roughcuts.exports.whenIdle();
  const list = ok<{ exports: Export[] }>(await run(ctx, "roughcut.exports", { cutId })).exports;
  const found = exportId ? list.find((item) => item.id === exportId) : list[0];
  expect(found, JSON.stringify(list)).toBeTruthy();
  return found!;
}

type Packet = { size: number; key: boolean };
/** The video packets of a file as the media tool reads them: their sizes are those of the compressed pictures, so equal lists mean the same pictures were copied. */
async function packets(ctx: App, file: string): Promise<Packet[]> {
  const result = await ctx.app.media.ffmpeg.run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=size,flags", "-of", "csv=p=0", "-i", file], { timeoutMs: 30_000 });
  return result.stdout.toString("utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => { const [size, flags] = line.split(","); return { size: Number(size), key: (flags ?? "").startsWith("K") }; });
}
/** The decoded pictures of a file, one hash each in presentation order: equal lists mean the pictures are the same, whatever the packets around them hold. */
async function pictures(ctx: App, file: string): Promise<string[]> {
  const result = await ctx.app.media.ffmpeg.run("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"], { timeoutMs: 60_000 });
  return result.stdout.toString("utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)!.trim());
}
/** Decodes a file to nothing: any error the decoder finds is printed. */
async function decodeErrors(ctx: App, file: string): Promise<string> {
  const result = await ctx.app.media.ffmpeg.run("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-f", "null", "-"], { timeoutMs: 60_000, allowFailure: true });
  return result.stderr.trim();
}
const visible = (dir: string) => fs.readdirSync(dir);
/** An export asked for directly, the way the interface does through the service, into a folder that was chosen. */
const startInto = (ctx: App, made: Awaited<ReturnType<App["app"]["roughcuts"]["plan"]>>, dir: string, fileName?: string) =>
  ctx.app.roughcuts.exports.start({ plan: made.plan, sources: made.sources, streams: made.streams, chapterTitles: new Map(), destination: { kind: "folder", label: null, at: () => ({ dir }) }, fileName });

describe.skipIf(mediaPrerequisitesAbsent)("exporting a rough cut without re-encoding (AT-33)", () => {
  requireSamples(["video-roughcut", "video-nonzero-start", "video-vfr"]);

  it("states what will really be cut: the start moves back to a keyframe, the end on to the next frame", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const { cutId, clipIds } = await sequence(ctx, [
      { resourceId: a.resourceId, inMs: 2500, outMs: 5500 },
      { resourceId: a.resourceId, inMs: 3000, outMs: 5520 },
      { resourceId: a.resourceId, inMs: 11_000, outMs: 12_400 },
    ]);
    const value = await plan(ctx, cutId);
    expect(value).toMatchObject({ compatible: true, problems: [], container: "mov", extension: "mp4" });
    expect(value.clips[0]).toMatchObject({ clipId: clipIds[0], requestedInMs: 2500, requestedOutMs: 5500, actualInMs: 2000, actualOutMs: 5500, startShiftMs: 500, endShiftMs: 0, onKeyframe: false, frames: 84, toEnd: false });
    expect(value.clips[1]).toMatchObject({ actualInMs: 3000, startShiftMs: 0, onKeyframe: true, endShiftMs: 22, frames: 61 });
    expect(value.clips[2]).toMatchObject({ actualInMs: 11_000, toEnd: true, frames: 24, onKeyframe: true });
    expect(value.requestedMs).toBe(3000 + 2520 + 1400);
    expect(value.actualMs).toBe(Math.round(value.clips.reduce((sum, clip) => sum + clip.actualOutMs - clip.actualInMs, 0)));
    // Planning changes nothing: no export record, no file.
    expect(all(ctx, "SELECT id FROM rough_cut_exports")).toEqual([]);
  });

  it("copies one clip frame for frame: the same compressed pictures from the keyframe to the end frame, nothing re-encoded", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const before = sha(a.file);
    const { cutId } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 2500, outMs: 5500 }]);
    const out = tmp();
    const started = ok<{ export: Export }>(await exportTo(ctx, cutId, out, "单段"));
    expect(["planned", "running"]).toContain(started.export.state);
    const done = await finish(ctx, cutId, started.export.id);
    expect(done).toMatchObject({ state: "done", error: null, fileName: "单段.mp4", done: 1, total: 1 });
    expect(done.check).toMatchObject({ ok: true, expectedFrames: 84, actualFrames: 84, streamsMatch: true });
    expect(Math.abs(done.check!.actualMs - done.check!.expectedMs)).toBeLessThanOrEqual(180);
    expect(done.bytes).toBe(fs.statSync(path.join(out, "单段.mp4")).size);
    expect(visible(out)).toEqual(["单段.mp4"]);
    // The pictures are the source's pictures from frame 48 (the keyframe at 2 s) up to, not including, frame 132 (5.5 s).
    const source = await packets(ctx, a.file);
    const copied = await packets(ctx, path.join(out, "单段.mp4"));
    expect(copied).toEqual(source.slice(48, 132));
    expect(copied[0]!.key).toBe(true);
    expect(await decodeErrors(ctx, path.join(out, "单段.mp4"))).toBe("");
    // The source stays as it was, and the application's working files are gone.
    expect(sha(a.file)).toBe(before);
    expect(visible(path.join(ctx.app.layout.partitions.cache, "roughcut"))).toEqual([]);
    expect(done.timing!.toolMs).toBeGreaterThan(0);
    expect(done.timing!.overheadMs).toBe(done.timing!.totalMs - done.timing!.toolMs);
  });

  it("joins clips of several videos and of one video twice, in the order of the sequence", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const b = await importCopy(ctx, "b.mp4");
    const { cutId } = await sequence(ctx, [
      { resourceId: b.resourceId, inMs: 7000, outMs: 9200 },
      { resourceId: a.resourceId, inMs: 2500, outMs: 5500 },
      { resourceId: a.resourceId, inMs: 0, outMs: 1000 },
    ]);
    const value = await plan(ctx, cutId);
    expect(value.compatible).toBe(true);
    const out = tmp();
    const done = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out)).export.id);
    expect(done, JSON.stringify([done.error, done.check])).toMatchObject({ state: "done", fileName: "试剪.mp4", done: 3, total: 3 });
    expect(done.check).toMatchObject({ ok: true, expectedFrames: value.clips.reduce((sum, clip) => sum + clip.frames, 0), streamsMatch: true });
    const source = { a: await packets(ctx, a.file), b: await packets(ctx, b.file) };
    const first = value.clips[0]!;
    const frameOf = (ms: number) => Math.round((ms * 24) / 1000);
    // The pictures are the sources' pictures, in the order of the sequence. (The join may repeat the parameter sets in front of a keyframe, so the packets are not byte for byte the sources'.)
    const shown = { a: await pictures(ctx, a.file), b: await pictures(ctx, b.file) };
    expect(await pictures(ctx, path.join(out, "试剪.mp4"))).toEqual([...shown.b.slice(frameOf(first.actualInMs), frameOf(first.actualOutMs)), ...shown.a.slice(48, 132), ...shown.a.slice(0, 24)]);
    expect((await packets(ctx, path.join(out, "试剪.mp4"))).map((packet) => packet.key)).toEqual([...source.b.slice(frameOf(first.actualInMs), frameOf(first.actualOutMs)), ...source.a.slice(48, 132), ...source.a.slice(0, 24)].map((packet) => packet.key));
    expect(await decodeErrors(ctx, path.join(out, "试剪.mp4"))).toBe("");
  });

  it("runs a clip that ends after the last frame to the end of the file", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const { cutId } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 10_500, outMs: 12_400 }]);
    const out = tmp();
    const done = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out, "尾段")).export.id);
    expect(done).toMatchObject({ state: "done", check: { ok: true, expectedFrames: 48, actualFrames: 48 } });
    expect(await packets(ctx, path.join(out, "尾段.mp4"))).toEqual((await packets(ctx, a.file)).slice(240));
    expect(await decodeErrors(ctx, path.join(out, "尾段.mp4"))).toBe("");
  });

  it.each([["video-nonzero-start", "a.mkv", "matroska", "mkv"], ["video-vfr", "a.mp4", "mov", "mp4"]])("cuts by the times the frame index states, also for %s", async (sampleId, name, container, extension) => {
    const ctx = await boot();
    const video = await importCopy(ctx, "", name, tmp(), sampleId);
    const { index } = await ctx.app.videos.index(video.resourceId);
    const keyframe = index.keyframesMs[2]!;
    const { cutId } = await sequence(ctx, [{ resourceId: video.resourceId, inMs: Math.round(keyframe) + 700, outMs: Math.round(keyframe) + 2600 }]);
    const value = await plan(ctx, cutId);
    expect(value, JSON.stringify(value.problems)).toMatchObject({ compatible: true, container, extension });
    const clip = value.clips[0]!;
    expect(clip.actualInMs).toBeCloseTo(keyframe, 3);
    expect(clip.startShiftMs).toBe(Math.round(clip.requestedInMs - keyframe));
    const out = tmp();
    const done = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out, "尺度")).export.id);
    expect(done, JSON.stringify([done.error, done.check])).toMatchObject({ state: "done", fileName: `尺度.${extension}`, check: { ok: true, expectedFrames: clip.frames, actualFrames: clip.frames } });
    // The frames are exactly those the index lists from the keyframe up to the end frame.
    const first = index.ptsMs.findIndex((time) => time >= keyframe - 0.5);
    const shown = await pictures(ctx, video.file);
    expect(shown).toHaveLength(index.ptsMs.length);
    expect(await pictures(ctx, path.join(out, `尺度.${extension}`))).toEqual(shown.slice(first, first + clip.frames));
    expect(await decodeErrors(ctx, path.join(out, `尺度.${extension}`))).toBe("");
  });

  const cases: Array<[string, string]> = [
    ["c-resolution.mp4", "resolution"], ["d-audio.mp4", "audio-format"], ["e-timebase.mp4", "time-base"], ["f-rate.mp4", "frame-rate"],
    ["g-container.mkv", "container"], ["h-codec.mp4", "video-codec"], ["i-no-audio.mp4", "audio-tracks"],
  ];
  it.each(cases)("refuses to join a clip of %s (%s differs) and writes nothing", async (sample, code) => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const other = await importCopy(ctx, sample);
    const { cutId, clipIds } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 0, outMs: 2000 }, { resourceId: other.resourceId, inMs: 0, outMs: 2000 }]);
    const value = await plan(ctx, cutId);
    expect(value.compatible).toBe(false);
    expect(value.problems.map((problem) => problem.code)).toContain(code);
    // The difference is named on the clip that differs, and the first clip, the one the rest are compared with, is clean.
    expect(value.problems.every((problem) => problem.clipId === clipIds[1])).toBe(true);
    expect(value.clips[0]!.problems).toEqual([]);
    const out = tmp();
    const refused = await exportTo(ctx, cutId, out);
    expect(refused.error).toMatchObject({ code: "UNSUPPORTED_FORMAT", details: { reason: "incompatible" } });
    expect(visible(out)).toEqual([]);
    expect(all(ctx, "SELECT id FROM rough_cut_exports")).toEqual([]);
    // Taking the odd clip out makes it exportable again.
    ok(await run(ctx, "roughcut.edit", { cutId, actions: [{ type: "remove", clipId: clipIds[1] }] }));
    expect((await plan(ctx, cutId)).compatible).toBe(true);
  });

  it("can start the sequence with the other container too: the first clip decides, so a matroska file written as matroska, and the mp4 refused", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const mkv = await importCopy(ctx, "g-container.mkv");
    const { cutId } = await sequence(ctx, [{ resourceId: mkv.resourceId, inMs: 1000, outMs: 3000 }]);
    const value = await plan(ctx, cutId);
    expect(value).toMatchObject({ compatible: true, container: "matroska", extension: "mkv" });
    const out = tmp();
    const done = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out, "mkv 版")).export.id);
    expect(done).toMatchObject({ state: "done", fileName: "mkv 版.mkv" });
    expect(await decodeErrors(ctx, path.join(out, "mkv 版.mkv"))).toBe("");
    ok(await run(ctx, "roughcut.edit", { cutId, actions: [{ type: "add", resourceId: a.resourceId, inMs: 0, outMs: 1000 }] }));
    expect((await plan(ctx, cutId)).problems.map((problem) => problem.code)).toContain("container");
  });

  const names = ["it's a clip & more; [1] 100% #1 $x ^ ~ ,=@ !.mp4", "-i.mp4", "空格 与 中文　全角（一）.mp4", "ｆｕｌｌ ｗｉｄｅ ‘quotes’.mp4", ...(process.platform === "win32" ? [] : ['say "hi" `cmd` $(x).mp4'])];
  it.each(names)("cuts and joins a video called %s: the name is only ever a file, never part of a command", async (name) => {
    const ctx = await boot();
    const video = await importCopy(ctx, "a.mp4", name, path.join(tmp(), "子 文件夹's [x]"));
    const { cutId } = await sequence(ctx, [{ resourceId: video.resourceId, inMs: 1000, outMs: 2000 }, { resourceId: video.resourceId, inMs: 6000, outMs: 7000 }]);
    expect((await plan(ctx, cutId)).compatible).toBe(true);
    const out = path.join(tmp(), "输出 's' folder");
    fs.mkdirSync(out);
    const done = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out, name.replace(/\.mp4$/, ""))).export.id);
    expect(done, JSON.stringify(done.error)).toMatchObject({ state: "done", check: { ok: true, expectedFrames: 48, actualFrames: 48 } });
    expect(visible(out)).toEqual([done.fileName]);
    expect(await decodeErrors(ctx, path.join(out, done.fileName!))).toBe("");
    const shown = await pictures(ctx, video.file);
    expect(await pictures(ctx, path.join(out, done.fileName!))).toEqual([...shown.slice(24, 48), ...shown.slice(144, 168)]);
  });

  it("makes a name that is safe on every system from what was typed, and never goes outside the chosen folder", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const { cutId } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    const out = tmp();
    const done = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out, '../../escape: a<b>c|d?e*"f".mp4')).export.id);
    expect(done.state).toBe("done");
    expect(visible(out)).toEqual([done.fileName]);
    expect(done.fileName).not.toMatch(/[<>:"/\\|?*]/);
    expect(done.fileName!.endsWith(".mp4")).toBe(true);
    expect(fs.readdirSync(path.dirname(out)).includes("escape")).toBe(false);
    // A name that is only reserved falls back to the sequence's own.
    const reserved = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out, "CON")).export.id);
    expect(reserved.fileName).toBe("roughcut.mp4");
  });

  it("never replaces a file: a second export takes the next free name, and a file already there is left as it was", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const { cutId } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    const out = tmp();
    fs.writeFileSync(path.join(out, "试剪.mp4"), "这是别人的文件");
    const first = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out)).export.id);
    const second = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out)).export.id);
    expect([first.fileName, second.fileName]).toEqual(["试剪 (2).mp4", "试剪 (3).mp4"]);
    expect(fs.readFileSync(path.join(out, "试剪.mp4"), "utf8")).toBe("这是别人的文件");
    expect(visible(out).sort()).toEqual(["试剪 (2).mp4", "试剪 (3).mp4", "试剪.mp4"]);
    expect(ok<{ exports: Export[] }>(await run(ctx, "roughcut.exports", { cutId })).exports.map((item) => item.fileName)).toEqual(["试剪 (3).mp4", "试剪 (2).mp4"]);
  });

  it("refuses a folder that is not there or is a file, before anything is recorded", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const { cutId } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    const dir = tmp();
    const gone = path.join(dir, "没有");
    expect((await exportTo(ctx, cutId, gone)).error).toMatchObject({ code: "NOT_FOUND", details: { reason: "missing-dir" } });
    fs.writeFileSync(path.join(dir, "文件"), "x");
    expect((await exportTo(ctx, cutId, path.join(dir, "文件"))).error?.code).toBe("VALIDATION_ERROR");
    expect((await run(ctx, "roughcut.export", { cutId, pathHandle: "不存在的句柄" })).status).toBe("error");
    expect(all(ctx, "SELECT id FROM rough_cut_exports")).toEqual([]);
  });

  it("cancels an export: no file, no temporary file, no working files, and the sequence can be edited and exported again", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const clips = Array.from({ length: 10 }, (_, i) => ({ resourceId: a.resourceId, inMs: i * 1000, outMs: i * 1000 + 1500 }));
    const { cutId, clipIds } = await sequence(ctx, clips);
    const out = tmp();
    const started = ok<{ export: Export }>(await exportTo(ctx, cutId, out)).export;
    // While it runs, the sequence cannot change, and cannot be exported a second time.
    expect(ok<{ exporting: boolean }>(await run(ctx, "roughcut.get", { cutId })).exporting).toBe(true);
    expect((await run(ctx, "roughcut.edit", { cutId, actions: [{ type: "remove", clipId: clipIds[0] }] })).error).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "busy" } });
    expect((await run(ctx, "roughcut.undo", { cutId })).error?.details).toMatchObject({ reason: "busy" });
    expect((await run(ctx, "roughcut.delete", { cutId })).error?.details).toMatchObject({ reason: "busy" });
    expect((await exportTo(ctx, cutId, out)).error?.details).toMatchObject({ reason: "busy" });
    expect((await run(ctx, "project.delete", { projectId: one<{ project_id: string }>(ctx, "SELECT project_id FROM rough_cuts WHERE id = ?", cutId).project_id })).error?.details).toMatchObject({ reason: "busy" });
    ok(await run(ctx, "roughcut.cancel", { exportId: started.id }));
    const ended = await finish(ctx, cutId, started.id);
    expect(ended).toMatchObject({ state: "cancelled", fileName: null, error: null });
    expect(visible(out)).toEqual([]);
    expect(visible(path.join(ctx.app.layout.partitions.cache, "roughcut"))).toEqual([]);
    expect((await run(ctx, "roughcut.cancel", { exportId: started.id })).error?.details).toMatchObject({ reason: "state" });
    expect((await run(ctx, "roughcut.cancel", { exportId: "none" })).error?.code).toBe("NOT_FOUND");
    // Free again.
    ok(await run(ctx, "roughcut.edit", { cutId, actions: [{ type: "remove", clipId: clipIds[0] }] }));
    const again = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out)).export.id);
    expect(again).toMatchObject({ state: "done", done: 9, total: 9 });
    expect(visible(out)).toEqual(["试剪.mp4"]);
  });

  it("keeps nothing from an export whose result does not match the plan", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const { cutId } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 2500, outMs: 5500 }]);
    const made = await ctx.app.roughcuts.plan(cutId);
    // A plan that promises a frame more than the copy will hold.
    made.plan.clips[0]!.frames += 1;
    const out = tmp();
    const started = startInto(ctx, made, out, "不对的");
    await ctx.app.roughcuts.exports.whenIdle();
    const ended = ctx.app.roughcuts.exports.get(started.id);
    expect(ended).toMatchObject({ state: "failed", fileName: null, error: { code: "UNSUPPORTED_FORMAT" } });
    expect(ended.error!.message).toMatch(/does not match the plan/);
    expect(visible(out)).toEqual([]);
    expect(visible(path.join(ctx.app.layout.partitions.cache, "roughcut"))).toEqual([]);
  });

  it("fails clearly when a source went between the plan and the export, and keeps nothing", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const b = await importCopy(ctx, "b.mp4");
    const { cutId } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 0, outMs: 1000 }, { resourceId: b.resourceId, inMs: 0, outMs: 1000 }]);
    const made = await ctx.app.roughcuts.plan(cutId);
    fs.rmSync(b.file);
    const out = tmp();
    const started = startInto(ctx, made, out);
    await ctx.app.roughcuts.exports.whenIdle();
    expect(ctx.app.roughcuts.exports.get(started.id)).toMatchObject({ state: "failed", error: { code: "NOT_FOUND" } });
    expect(visible(out)).toEqual([]);
    // Planned afresh, the missing source is named instead.
    expect((await plan(ctx, cutId)).problems).toEqual([{ code: "source-missing", clipId: expect.any(String) }]);
    expect((await exportTo(ctx, cutId, out)).error?.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("marks an export the application did not live to finish as interrupted, and removes what it left", async () => {
    const first = await boot();
    const a = await importCopy(first, "a.mp4");
    const { cutId } = await sequence(first, [{ resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    const out = tmp();
    const part = path.join(out, ".试剪.rce-left.part");
    fs.writeFileSync(part, "half");
    const stage = path.join(first.app.layout.partitions.cache, "roughcut", "rce-left");
    const stranger = path.join(first.app.layout.partitions.cache, "roughcut", "rce-stranger");
    fs.mkdirSync(stage, { recursive: true });
    fs.mkdirSync(stranger, { recursive: true });
    fs.writeFileSync(path.join(stage, "part-0001.mp4"), "half");
    const now = new Date().toISOString();
    first.app.store.sqlite.prepare("INSERT INTO rough_cut_exports(id, cut_id, state, plan_json, result_json, tmp_name, final_name, error_json, created_at, updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,?,?)")
      .run("rce-left", cutId, "running", JSON.stringify({ clips: [{}] }), JSON.stringify({ step: "cutting", done: 0 }), part, now, now);
    expect(ok<{ exporting: boolean }>(await run(first, "roughcut.get", { cutId })).exporting).toBe(true);
    const second = await boot(first);
    expect(ok<{ exporting: boolean }>(await run(second, "roughcut.get", { cutId })).exporting).toBe(false);
    expect(ok<{ exports: Export[] }>(await run(second, "roughcut.exports", { cutId })).exports[0]).toMatchObject({ id: "rce-left", state: "failed", error: { code: "INTERRUPTED" }, fileName: null });
    expect(visible(out)).toEqual([]);
    expect(visible(path.join(second.app.layout.partitions.cache, "roughcut"))).toEqual([]);
    // And the sequence can be exported.
    const done = await finish(second, cutId, ok<{ export: Export }>(await exportTo(second, cutId, out)).export.id);
    expect(done.state).toBe("done");
  });

  it("stops an export that is running when its module is switched off, and says so", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const { cutId } = await sequence(ctx, Array.from({ length: 8 }, (_, i) => ({ resourceId: a.resourceId, inMs: i * 1000, outMs: i * 1000 + 1500 })));
    const out = tmp();
    const started = ok<{ export: Export }>(await exportTo(ctx, cutId, out)).export;
    ok(await run(ctx, "settings.setModule", { featureId: "roughcut", enabled: false }));
    await ctx.app.roughcuts.exports.whenIdle();
    expect(visible(out)).toEqual([]);
    ok(await run(ctx, "settings.setModule", { featureId: "roughcut", enabled: true }));
    expect(["cancelled", "failed", "done"]).toContain((await finish(ctx, cutId, started.id)).state);
    expect(visible(out).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("reports each step as a notice and the finished file by name only, never by where it is", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const { cutId } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 0, outMs: 1000 }, { resourceId: a.resourceId, inMs: 3000, outMs: 4000 }]);
    const notices: Array<{ topic: string; payload: Export }> = [];
    ctx.app.onNotice((notice) => { if (notice.topic === "roughcut.export") notices.push(notice as unknown as { topic: string; payload: Export }); });
    const out = tmp();
    const done = await finish(ctx, cutId, ok<{ export: Export }>(await exportTo(ctx, cutId, out)).export.id);
    expect(notices.at(-1)!.payload.state).toBe("done");
    const steps = notices.map((notice) => notice.payload.step).filter((step, i, list) => step !== list[i - 1]);
    expect(steps).toEqual(expect.arrayContaining(["cutting", "joining", "checking", "placing"]));
    expect(steps.indexOf("cutting")).toBeLessThan(steps.indexOf("joining"));
    expect(steps.indexOf("checking")).toBeLessThan(steps.indexOf("placing"));
    const everything = JSON.stringify([notices, done, all(ctx, "SELECT * FROM operation_log"), all(ctx, "SELECT * FROM rough_cut_exports")]);
    expect(all<{ action: string; object_label: string | null }>(ctx, "SELECT action, object_label FROM operation_log WHERE category = 'roughcut' ORDER BY id").map((row) => [row.action, row.object_label])).toEqual([["roughcut.create", "试剪"], ["roughcut.export", "试剪"]]);
    expect(everything).not.toContain(out);
    expect(everything).not.toContain(path.dirname(a.file));
    expect(everything).not.toContain(a.file);
  });
});

type Streams = { streams: Array<{ codec_type: string; codec_name: string; tags?: Record<string, string> }>; chapters: Array<{ start_time: string; end_time: string; tags?: Record<string, string> }> };
/** What a finished file holds, as the media tool reads it. */
async function holds(ctx: App, file: string): Promise<{ audio: Array<{ codec: string; language?: string; title?: string }>; subtitle: Array<{ codec: string; language?: string; title?: string }>; attachments: number; chapters: Array<{ start: number; end: number; title?: string }> }> {
  const result = await ctx.app.media.ffmpeg.run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_chapters", "-i", file], { timeoutMs: 30_000 });
  const json = JSON.parse(result.stdout.toString("utf8")) as Streams;
  const named = (kind: string) => json.streams.filter((stream) => stream.codec_type === kind).map((stream) => ({ codec: stream.codec_name, language: stream.tags?.language, title: stream.tags?.title }));
  return {
    audio: named("audio"), subtitle: named("subtitle"), attachments: json.streams.filter((stream) => stream.codec_type === "attachment").length,
    chapters: json.chapters.map((chapter) => ({ start: Math.round(Number(chapter.start_time) * 1000), end: Math.round(Number(chapter.end_time) * 1000), title: chapter.tags?.title })),
  };
}
type Detail = Export & { mode: string; destination: string; folder: string | null; files: Array<{ clipId: string | null; fileName: string; bytes: number; check: { ok: boolean; expectedFrames: number; actualFrames: number; chapters?: { expected: number; actual: number } } }>; commands: Array<{ step: string; clip?: number; tool: string; args: string[] }> };
type Options = { mode?: "merge" | "separate"; audioTracks?: number[]; subtitleTracks?: number[]; chapters?: boolean };
const planWith = async (ctx: App, cutId: string, options: Options) => ok<{ plan: Plan & { options: Options; separable: boolean; tracks: { audio: Array<{ codec: string; language: string; title: string }>; subtitle: Array<{ codec: string; language: string }> } } }>(await run(ctx, "roughcut.plan", { cutId, options })).plan;
const exportWith = (ctx: App, cutId: string, options: Options, extra: Record<string, unknown> = {}) => run(ctx, "roughcut.export", { cutId, options, ...extra });
const detail = async (ctx: App, cutId: string, exportId: string) => (await finish(ctx, cutId, exportId)) as Detail;

describe.skipIf(mediaPrerequisitesAbsent)("rough cuts by tracks, files and folder (AT-98)", () => {
  requireSamples(["video-roughcut", "video-mkv-ass-fonts"]);
  const importShow = (ctx: App, name = "show.mkv") => importCopy(ctx, "", name, undefined, "video-mkv-ass-fonts");

  it("offers the tracks of the first clip's source, and keeps every audio track and no subtitle track when nothing is chosen", async () => {
    const ctx = await boot();
    const show = await importShow(ctx);
    const { cutId } = await sequence(ctx, [{ resourceId: show.resourceId, inMs: 1000, outMs: 6500 }]);
    const value = await planWith(ctx, cutId, { mode: "merge" });
    expect(value.tracks.audio.map((track) => [track.codec, track.language, track.title])).toEqual([["aac", "jpn", "Japanese 2.0"], ["aac", "chi", "Chinese 2.0"]]);
    expect(value.tracks.subtitle).toEqual([{ codec: "ass", language: "eng", title: "English (ASS)" }]);
    const out = tmp();
    const done = await detail(ctx, cutId, ok<{ export: Export }>(await exportWith(ctx, cutId, { mode: "merge" }, { pathHandle: pick(ctx, "directory", out) })).export.id);
    expect(done).toMatchObject({ state: "done", mode: "merge", destination: "folder" });
    const file = path.join(out, done.fileName!);
    const kept = await holds(ctx, file);
    expect(kept.audio.map((track) => track.language)).toEqual(["jpn", "chi"]);
    expect(kept.subtitle).toEqual([]);
    expect(kept.chapters).toEqual([]);
  });

  it("keeps exactly the audio and subtitle tracks that were chosen, with their language and title, and the fonts of the subtitles", async () => {
    const ctx = await boot();
    const show = await importShow(ctx);
    const { cutId } = await sequence(ctx, [{ resourceId: show.resourceId, inMs: 1000, outMs: 6500 }]);
    const out = tmp();
    const options = { mode: "merge" as const, audioTracks: [1], subtitleTracks: [0] };
    expect(await planWith(ctx, cutId, options)).toMatchObject({ compatible: true, problems: [], options });
    const done = await detail(ctx, cutId, ok<{ export: Export }>(await exportWith(ctx, cutId, options, { pathHandle: pick(ctx, "directory", out) })).export.id);
    expect(done).toMatchObject({ state: "done" });
    expect(done.files).toHaveLength(1);
    expect(done.files[0]!.check).toMatchObject({ ok: true, streamsMatch: true });
    const kept = await holds(ctx, path.join(out, done.fileName!));
    expect(kept.audio).toEqual([{ codec: "aac", language: "chi", title: "Chinese 2.0" }]);
    expect(kept.subtitle).toEqual([{ codec: "ass", language: "eng", title: "English (ASS)" }]);
    expect(kept.attachments).toBe(1);
    expect(await decodeErrors(ctx, path.join(out, done.fileName!))).toBe("");
  });

  it("keeps no audio at all when none is chosen, and says so when a chosen track is not in a clip's source", async () => {
    const ctx = await boot();
    const show = await importShow(ctx);
    const { cutId, clipIds } = await sequence(ctx, [{ resourceId: show.resourceId, inMs: 0, outMs: 3000 }]);
    const out = tmp();
    const silent = await detail(ctx, cutId, ok<{ export: Export }>(await exportWith(ctx, cutId, { mode: "merge", audioTracks: [] }, { pathHandle: pick(ctx, "directory", out) })).export.id);
    expect(silent.state).toBe("done");
    expect((await holds(ctx, path.join(out, silent.fileName!))).audio).toEqual([]);
    const missing = await planWith(ctx, cutId, { mode: "merge", audioTracks: [2], subtitleTracks: [3] });
    expect(missing).toMatchObject({ compatible: false, separable: false });
    expect(missing.problems).toEqual([
      { code: "track-missing", clipId: clipIds[0], detail: { first: "audio 3", other: 2 } },
      { code: "track-missing", clipId: clipIds[0], detail: { first: "subtitle 4", other: 1 } },
    ]);
    expect((await exportWith(ctx, cutId, { mode: "merge", audioTracks: [2] }, { pathHandle: pick(ctx, "directory", out) })).error).toMatchObject({ code: "UNSUPPORTED_FORMAT", details: { reason: "incompatible" } });
    // The numbers are validated before anything is planned.
    expect((await run(ctx, "roughcut.plan", { cutId, options: { mode: "merge", audioTracks: [-1] } })).status).toBe("error");
    expect((await run(ctx, "roughcut.plan", { cutId, options: { mode: "tiled" } })).status).toBe("error");
  });

  it("writes a chapter for each clip of a merged file, named by the clip's label or its video, and none for a single clip", async () => {
    const ctx = await boot();
    const show = await importShow(ctx, "第一集.mkv");
    const { cutId, clipIds } = await sequence(ctx, [
      { resourceId: show.resourceId, inMs: 0, outMs: 3000 },
      { resourceId: show.resourceId, inMs: 6000, outMs: 9000 },
    ]);
    ok(await run(ctx, "roughcut.edit", { cutId, actions: [{ type: "update", clipId: clipIds[0], label: "开场; a=b" }] }));
    const options = { mode: "merge" as const, chapters: true, audioTracks: [0], subtitleTracks: [0] };
    expect((await planWith(ctx, cutId, options)).options.chapters).toBe(true);
    const out = tmp();
    const done = await detail(ctx, cutId, ok<{ export: Export }>(await exportWith(ctx, cutId, options, { pathHandle: pick(ctx, "directory", out) })).export.id);
    expect(done.state, JSON.stringify([done.error, done.check])).toBe("done");
    expect(done.files[0]!.check).toMatchObject({ ok: true, chapters: { expected: 2, actual: 2 } });
    const kept = await holds(ctx, path.join(out, done.fileName!));
    expect(kept.chapters.map((chapter) => chapter.title)).toEqual(["开场; a=b", "第一集"]);
    expect(kept.chapters[0]!.start).toBe(0);
    expect(kept.chapters[1]!.start).toBe(kept.chapters[0]!.end);
    expect(kept.chapters[0]!.end).toBeGreaterThanOrEqual(3000 - 50);
    expect(kept.subtitle).toHaveLength(1);
    expect(kept.audio).toHaveLength(1);
    // A single clip has nothing to divide: the plan leaves the chapters out, and so does the file.
    const single = await sequence(ctx, [{ resourceId: show.resourceId, inMs: 0, outMs: 3000 }]);
    expect((await planWith(ctx, single.cutId, { mode: "merge", chapters: true })).options.chapters).toBeUndefined();
    const alone = await detail(ctx, single.cutId, ok<{ export: Export }>(await exportWith(ctx, single.cutId, { mode: "merge", chapters: true }, { pathHandle: pick(ctx, "directory", out) })).export.id);
    expect((await holds(ctx, path.join(out, alone.fileName!))).chapters).toEqual([]);
  });

  it("writes a file for each clip when asked to, even for clips that cannot be joined, each checked against its own part of the plan", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const c = await importCopy(ctx, "c-resolution.mp4");
    const { cutId, clipIds } = await sequence(ctx, [
      { resourceId: a.resourceId, inMs: 2500, outMs: 5500 },
      { resourceId: c.resourceId, inMs: 1000, outMs: 4000 },
      { resourceId: a.resourceId, inMs: 0, outMs: 1000 },
    ]);
    const merged = await planWith(ctx, cutId, { mode: "merge" });
    expect(merged).toMatchObject({ compatible: false, separable: true });
    expect(merged.problems.map((problem) => problem.code)).toContain("resolution");
    const separate = await planWith(ctx, cutId, { mode: "separate" });
    expect(separate).toMatchObject({ compatible: false, separable: true, problems: [] });
    expect(separate.clips.map((clip) => clip.extension)).toEqual(["mp4", "mp4", "mp4"]);
    const out = tmp();
    expect((await exportWith(ctx, cutId, { mode: "merge" }, { pathHandle: pick(ctx, "directory", out) })).error).toMatchObject({ code: "UNSUPPORTED_FORMAT", details: { reason: "incompatible", mode: "merge" } });
    const done = await detail(ctx, cutId, ok<{ export: Export }>(await exportWith(ctx, cutId, { mode: "separate" }, { pathHandle: pick(ctx, "directory", out), fileName: "分段" })).export.id);
    expect(done).toMatchObject({ state: "done", mode: "separate", done: 3, total: 3 });
    expect(done.files.map((file) => file.clipId)).toEqual(clipIds);
    expect(done.files.map((file) => file.fileName)).toEqual(["分段 01 a.mp4", "分段 02 c-resolution.mp4", "分段 03 a.mp4"]);
    expect(done.files.every((file) => file.check.ok)).toBe(true);
    expect(done.files.map((file) => file.check.actualFrames)).toEqual([84, 72, 24]);
    expect(done.bytes).toBe(done.files.reduce((sum, file) => sum + file.bytes, 0));
    expect(visible(out).sort()).toEqual(done.files.map((file) => file.fileName).sort());
    for (const file of done.files) expect(file.bytes).toBe(fs.statSync(path.join(out, file.fileName)).size);
    // The first file holds the source's own pictures from its keyframe.
    expect(await packets(ctx, path.join(out, done.files[0]!.fileName))).toEqual((await packets(ctx, a.file)).slice(48, 132));
    expect(visible(path.join(ctx.app.layout.partitions.cache, "roughcut"))).toEqual([]);
  });

  it("keeps the files that were finished when a later clip fails, and nothing half written", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const b = await importCopy(ctx, "b.mp4");
    const { cutId } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 0, outMs: 1000 }, { resourceId: b.resourceId, inMs: 0, outMs: 1000 }]);
    const made = await ctx.app.roughcuts.plan(cutId, { mode: "separate" });
    fs.rmSync(b.file);
    const out = tmp();
    const started = startInto(ctx, made, out, "分段");
    await ctx.app.roughcuts.exports.whenIdle();
    const ended = ctx.app.roughcuts.exports.get(started.id);
    expect(ended).toMatchObject({ state: "failed", error: { code: "NOT_FOUND" }, done: 1 });
    expect(ended.files).toHaveLength(1);
    expect(visible(out)).toEqual([ended.files[0]!.fileName]);
    expect(visible(path.join(ctx.app.layout.partitions.cache, "roughcut"))).toEqual([]);
  });

  it("shows the media tool's arguments of every step, with the places on this machine replaced by what they are", async () => {
    const ctx = await boot();
    const show = await importShow(ctx);
    const { cutId } = await sequence(ctx, [{ resourceId: show.resourceId, inMs: 1000, outMs: 4000 }, { resourceId: show.resourceId, inMs: 6000, outMs: 9000 }]);
    const out = tmp();
    const done = await detail(ctx, cutId, ok<{ export: Export }>(await exportWith(ctx, cutId, { mode: "merge", audioTracks: [1], subtitleTracks: [0], chapters: true }, { pathHandle: pick(ctx, "directory", out) })).export.id);
    expect(done.state, JSON.stringify([done.error, done.check])).toBe("done");
    const steps = done.commands.map((command) => `${command.step}:${command.tool}`);
    expect(steps.filter((step) => step === "cut:ffmpeg")).toHaveLength(2);
    expect(steps).toEqual(expect.arrayContaining(["join:ffmpeg", "check:ffprobe"]));
    const cut = done.commands.find((command) => command.step === "cut")!;
    expect(cut.clip).toBe(1);
    expect(cut.args).toEqual(expect.arrayContaining(["-map", "0:a:1", "0:s:0", "-c", "copy"]));
    expect(cut.args).not.toContain("-c:v");
    const join = done.commands.find((command) => command.step === "join")!;
    expect(join.args.slice(join.args.indexOf("-c"), join.args.indexOf("-c") + 2)).toEqual(["-c", "copy"]);
    expect(join.args).toEqual(expect.arrayContaining(["-map_chapters", "1"]));
    // Nothing that re-encodes appears anywhere: every codec choice is a copy.
    for (const command of done.commands.filter((item) => item.tool === "ffmpeg")) {
      const choices = command.args.flatMap((arg, i) => (/^-(c|codec)(:[vasdt])?$/.test(arg) ? [command.args[i + 1]] : []));
      expect(choices.length).toBeGreaterThan(0);
      expect(choices.every((choice) => choice === "copy")).toBe(true);
    }
    const everything = JSON.stringify([done, all(ctx, "SELECT * FROM rough_cut_exports")]);
    for (const place of [out, path.dirname(show.file), show.file, ctx.app.layout.partitions.cache, os.tmpdir()]) expect(everything).not.toContain(place.replace(/\\/g, "\\\\"));
    expect(everything).toContain("<source-1>");
  });

  it("puts the files in the folder of the file for rough cuts when no folder is chosen, and writes each one down as a file of the resource", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const work = one<{ work_id: string | null }>(ctx, "SELECT work_id FROM resources WHERE id = ?", a.resourceId).work_id;
    expect(work, "a video that is imported belongs to a work").toBeTruthy();
    const { cutId } = await sequence(ctx, [{ resourceId: a.resourceId, inMs: 0, outMs: 1000 }, { resourceId: a.resourceId, inMs: 3000, outMs: 4000 }]);
    const merged = await detail(ctx, cutId, ok<{ export: Export }>(await exportWith(ctx, cutId, { mode: "merge" })).export.id);
    expect(merged).toMatchObject({ state: "done", destination: "work", fileName: "试剪.mp4" });
    expect(merged.folder).toMatch(/\/粗剪$/);
    // The work is not linked to an online entry, so the folder is the file's own, under 未分类 (A-88).
    const folder = ctx.app.workFolders.folderFor({ resourceId: a.resourceId }, { create: false })!;
    expect(folder.relDir).toMatch(/^未分类\//);
    const dir = path.join(ctx.app.workFolders.absolute(folder), "粗剪");
    expect(visible(dir)).toEqual(["试剪.mp4"]);
    expect(merged.folder).toBe(`${folder.relDir}/粗剪`);
    expect(ctx.app.workFolders.filesOfResource(a.resourceId, "roughcut").map((file) => [file.fileName, file.subDir, file.bytes, file.refKind, file.refId, file.resourceId])).toEqual([["试剪.mp4", "粗剪", merged.bytes, "roughcut", cutId, a.resourceId]]);
    // A second export is a file of its own, never over the first; separate files go to the same folder.
    const again = await detail(ctx, cutId, ok<{ export: Export }>(await exportWith(ctx, cutId, { mode: "separate" })).export.id);
    expect(again.files).toHaveLength(2);
    expect(visible(dir).sort()).toEqual(["试剪 01 a.mp4", "试剪 02 a.mp4", "试剪.mp4"].sort());
    expect(ctx.app.workFolders.filesOfResource(a.resourceId, "roughcut")).toHaveLength(3);
    // The work's folder is never shown as a place on this machine.
    expect(JSON.stringify([merged, again])).not.toContain(ctx.app.workFolders.root.replace(/\\/g, "\\\\"));
  });

  it("serves the keyframes of a video for a timeline, without building the frame table unless asked", async () => {
    const ctx = await boot();
    const a = await importCopy(ctx, "a.mp4");
    const before = ok<{ ready: boolean; state?: unknown }>(await run(ctx, "video.keyframes", { resourceId: a.resourceId }));
    expect(before.ready).toBe(false);
    const built = ok<{ ready: boolean; keyframesMs: number[]; truncated: boolean; frames: number; durationMs: number }>(await run(ctx, "video.keyframes", { resourceId: a.resourceId, build: true }));
    expect(built).toMatchObject({ ready: true, truncated: false, frames: 288 });
    expect(built.keyframesMs).toEqual(Array.from({ length: 12 }, (_, i) => i * 1000));
    // Once the table exists a plain ask answers from it.
    expect(ok<{ ready: boolean; keyframesMs: number[] }>(await run(ctx, "video.keyframes", { resourceId: a.resourceId }))).toMatchObject({ ready: true, keyframesMs: built.keyframesMs });
    expect((await run(ctx, "video.keyframes", { resourceId: "没有" })).status).toBe("error");
  });
});
