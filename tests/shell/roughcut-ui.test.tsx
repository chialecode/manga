/** @vitest-environment jsdom */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { AddToRoughcut } from "../../apps/desktop/src/renderer/components/add-to-roughcut.tsx";
import { RoughcutTab } from "../../apps/desktop/src/renderer/pages/projects/roughcut/roughcut-tab.tsx";
import {
  DEFAULT_CHOICE, choiceSummary, exportSummary, lengthText, moveTarget, nextKeyframe, optionsOf, prevKeyframe, problemText, readRange, secondsText, snapToKeyframe, stepText, tickPath, toggleAudio, toggleSubtitle, trackLabel,
} from "../../apps/desktop/src/renderer/pages/projects/roughcut/roughcut-model.ts";
import { parseClock } from "../../apps/desktop/src/renderer/readers/video-model.ts";
import { startApp } from "../helpers/app.ts";
import { seedVideo } from "../helpers/media-seed.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";
import { inLibrary, requireSamples, samplePath } from "../helpers/samples.ts";
import { bridgeToApp, tabContext } from "../helpers/ui-host.ts";

const { t } = createTranslator("zh-CN");
type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;
const apps: App[] = [];
const disposers: Array<() => void> = [];
const dirs: string[] = [];
afterEach(() => { cleanup(); while (disposers.length) disposers.pop()!(); while (apps.length) apps.pop()!.app.close(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-rc-ui-")); dirs.push(dir); return dir; };

async function boot(extra: Record<string, unknown> = {}) {
  const ctx = await startApp();
  apps.push(ctx);
  const bridge = bridgeToApp(ctx, extra);
  disposers.push(bridge.dispose);
  const run = async (commandId: string, input: Record<string, unknown>) => {
    counter += 1;
    const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `rcui-${counter}`, input }, ctx.grant.handle);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    return result.value as Record<string, any>;
  };
  const projectId = (await run("project.create", { name: "纪录片" })).id as string;
  return { ctx, bridge, run, projectId };
}
type Booted = Awaited<ReturnType<typeof boot>>;

async function makeCut(b: Booted, title: string, clips: Array<{ id: string; resourceId: string; inMs: number; outMs: number }>) {
  const cutId = (await b.run("roughcut.create", { projectId: b.projectId, title })).cut.id as string;
  if (clips.length) await b.run("roughcut.edit", { cutId, actions: clips.map((clip) => ({ type: "add", ...clip })) });
  return cutId;
}
function mount(projectId: string) {
  const tab = tabContext(projectId, { facets: new Set(["roughcut"]) });
  render(<RoughcutTab ctx={tab.ctx} />);
  return tab;
}
const order = () => [...screen.getByTestId("rc-clips").children].map((item) => item.getAttribute("data-testid")!.replace("rc-clip-", ""));
const edits = (b: Booted) => b.bridge.calls.filter((call) => call.commandId === "roughcut.edit");
const plans = (b: Booted) => b.bridge.calls.filter((call) => call.commandId === "roughcut.plan").length;
const type = (id: string, value: string) => { fireEvent.change(screen.getByTestId(id), { target: { value } }); };

describe("rough cut words and rules the page keeps (CLIP-01/02)", () => {
  it("writes lengths without noise, and how far a cut moved in seconds", () => {
    expect(lengthText(0)).toBe("0:00");
    expect(lengthText(2500)).toBe("0:02.500");
    expect(lengthText(61_000)).toBe("1:01");
    expect(lengthText(3_661_000)).toBe("1:01:01");
    expect(secondsText(500)).toBe("0.500");
    expect(secondsText(-42)).toBe("0.042");
  });

  it("reads a range from typed times and says which part is wrong", () => {
    expect(readRange("0:01", "0:03.500", parseClock, 12_000)).toEqual({ inMs: 1000, outMs: 3500 });
    expect(readRange("x", "0:03", parseClock, 12_000)).toBe("time");
    expect(readRange("0:01", "", parseClock, 12_000)).toBe("time");
    expect(readRange("0:05", "0:05", parseClock, 12_000)).toBe("range");
    expect(readRange("0:05", "0:04", parseClock, 12_000)).toBe("range");
    // A mark a little past the last frame is allowed, as the service allows it.
    expect(readRange("0:10", "0:12.900", parseClock, 12_000)).toEqual({ inMs: 10_000, outMs: 12_900 });
    expect(readRange("0:10", "0:14", parseClock, 12_000)).toBe("range");
    expect(readRange("0:10", "9:00", parseClock, null)).toEqual({ inMs: 10_000, outMs: 540_000 });
  });

  it("moves a clip one place and not past either end", () => {
    expect(moveTarget(0, "up", 3)).toBeNull();
    expect(moveTarget(0, "down", 3)).toBe(1);
    expect(moveTarget(2, "down", 3)).toBeNull();
    expect(moveTarget(2, "up", 3)).toBe(1);
  });

  it("names the clip and what differs for every kind of problem the check can find", () => {
    const title = (id?: string) => (id === "c1" ? "视频乙" : "");
    expect(problemText(t, { code: "empty" }, title)).toBe("序列是空的。");
    expect(problemText(t, { code: "source-missing", clipId: "c1" }, title)).toBe("片段“视频乙”的视频找不到文件。");
    expect(problemText(t, { code: "resolution", clipId: "c1", detail: { first: "640x360", other: "480x270" } }, title)).toBe("片段“视频乙”的画面尺寸和第一段不同（640x360，这一段是 480x270）。");
    expect(problemText(t, { code: "audio-tracks", clipId: "c1", detail: { first: 1, other: 0 } }, title)).toBe("片段“视频乙”的音轨数和第一段不同（1，这一段是 0）。");
    for (const code of ["empty", "source-missing", "no-video", "range", "no-keyframe", "container", "video-codec", "video-profile", "resolution", "pixel-format", "frame-rate", "time-base", "audio-codec", "audio-format", "audio-tracks", "track-missing", "subtitle-codec", "subtitle-container"] as const) {
      expect(problemText(t, { code, clipId: "c1", detail: { first: "A", other: "B" } }, title), code).not.toMatch(/roughcut\.problem|\{/);
    }
  });

  it("describes a running, finished, cancelled, interrupted and refused export in one place", () => {
    const base = { id: "e", cutId: "c", plan: null, fileName: null, bytes: null, check: null, timing: null, error: null, createdAt: "x", updatedAt: "x", total: 3, done: 1, step: null };
    expect(stepText(t, { step: null, done: 0, total: 3 })).toBe("正在开始导出…");
    expect(stepText(t, { step: "cutting", done: 1, total: 3 })).toBe("正在切出片段 1/3");
    expect(exportSummary(t, { ...base, state: "running", step: "joining" } as never)).toEqual(["正在拼接"]);
    expect(exportSummary(t, { ...base, state: "cancelled" } as never)).toEqual(["已取消，没有留下文件。"]);
    expect(exportSummary(t, { ...base, state: "failed", error: { code: "INTERRUPTED", message: "x" } } as never)).toEqual(["上一次导出没有完成（应用中途退出），没有留下文件。"]);
    expect(exportSummary(t, { ...base, state: "failed", error: { code: "NOT_FOUND", message: "文件没了" } } as never)).toEqual(["导出失败，没有留下文件：文件没了"]);
    expect(exportSummary(t, { ...base, state: "failed", error: { code: "UNSUPPORTED_FORMAT", message: "x" }, check: { ok: false, expectedFrames: 84, actualFrames: 85, expectedMs: 3500, actualMs: 3542, streamsMatch: true } } as never)).toEqual(["导出的文件和计划对不上（85 / 84 帧），所以没有保留。"]);
    const done = exportSummary(t, { ...base, state: "done", fileName: "成片.mp4", check: { ok: true, expectedFrames: 84, actualFrames: 84, expectedMs: 3500, actualMs: 3520, streamsMatch: true }, timing: { totalMs: 900, toolMs: 700, overheadMs: 200 } } as never);
    expect(done).toEqual(["已导出“成片.mp4”：84 帧，约 0:03.520。", "检查通过：84 / 84 帧，长度相差 20 毫秒。", "用时 0:00.900，其中媒体工具 0:00.700，应用自己 0:00.200。"]);
  });
});

describe("the rough cut tab", () => {
  it("starts empty, makes a sequence, and says an empty sequence cannot be exported", async () => {
    const b = await boot();
    mount(b.projectId);
    expect(await screen.findByTestId("roughcut-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("roughcut-new"));
    await screen.findByTestId("rc-no-clips");
    expect(screen.getByTestId("rc-title").textContent).toBe("粗剪 1");
    await waitFor(() => expect(screen.getByTestId("rc-plan-verdict").textContent).toBe("现在不能导出，原因见下。"));
    expect(within(screen.getByTestId("rc-problems")).getByText("序列是空的。")).toBeTruthy();
    expect((screen.getByTestId("rc-export") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("rc-undo")).toHaveProperty("disabled", true);
    expect((await b.run("roughcut.list", { projectId: b.projectId })).cuts).toHaveLength(1);
  });

  it("lists the clips with their times, and a typed time becomes one edit that can be undone", async () => {
    const b = await boot();
    const a = seedVideo(b.ctx.app, { title: "视频甲", durationMs: 12_000, probe: true });
    const v = seedVideo(b.ctx.app, { title: "视频乙", durationMs: 8_000, probe: true });
    const cutId = await makeCut(b, "第一版", [{ id: "c1", resourceId: a.resourceId, inMs: 1000, outMs: 3500 }, { id: "c2", resourceId: v.resourceId, inMs: 0, outMs: 2000 }]);
    mount(b.projectId);
    await screen.findByTestId("rc-clips");
    expect(order()).toEqual(["c1", "c2"]);
    expect(screen.getByTestId("rc-clip-c1").textContent).toContain("视频甲");
    expect((screen.getByTestId("rc-in-c1") as HTMLInputElement).value).toBe("0:01.000");
    expect((screen.getByTestId("rc-out-c1") as HTMLInputElement).value).toBe("0:03.500");
    expect(screen.getByTestId("rc-length-c1").textContent).toBe("长 0:02.500");
    expect(screen.getByTestId("rc-total").textContent).toBe("2 段，请求的长度共 0:04.500");

    const before = edits(b).length;
    type("rc-in-c1", "0:02");
    fireEvent.keyDown(screen.getByTestId("rc-in-c1"), { key: "Enter" });
    await waitFor(() => expect(edits(b)).toHaveLength(before + 1));
    expect(edits(b).at(-1)!.input).toMatchObject({ cutId, label: "修改片段", actions: [{ type: "update", clipId: "c1", inMs: 2000, outMs: 3500 }] });
    await waitFor(() => expect((screen.getByTestId("rc-in-c1") as HTMLInputElement).value).toBe("0:02.000"));
    expect(screen.getByTestId("rc-length-c1").textContent).toBe("长 0:01.500");
    expect(screen.getByTestId("rc-undo").getAttribute("aria-label")).toBe("撤销：修改片段");

    fireEvent.click(screen.getByTestId("rc-undo"));
    await waitFor(() => expect((screen.getByTestId("rc-in-c1") as HTMLInputElement).value).toBe("0:01.000"));
    expect(screen.getByTestId("rc-redo").getAttribute("aria-label")).toBe("重做：修改片段");
    fireEvent.click(screen.getByTestId("rc-redo"));
    await waitFor(() => expect((screen.getByTestId("rc-in-c1") as HTMLInputElement).value).toBe("0:02.000"));
    expect((await b.run("roughcut.get", { cutId })).clips[0]).toMatchObject({ inMs: 2000, outMs: 3500 });
  });

  it("refuses a time that is not a time, or a clip that ends before it starts, and makes no edit", async () => {
    const b = await boot();
    const a = seedVideo(b.ctx.app, { title: "视频甲", durationMs: 12_000, probe: true });
    await makeCut(b, "第一版", [{ id: "c1", resourceId: a.resourceId, inMs: 1000, outMs: 3500 }]);
    mount(b.projectId);
    await screen.findByTestId("rc-clips");
    const before = edits(b).length;
    type("rc-in-c1", "抱歉");
    fireEvent.keyDown(screen.getByTestId("rc-in-c1"), { key: "Enter" });
    expect((await screen.findByTestId("rc-time-error-c1")).textContent).toBe("时间的写法不对，例如 1:23.500");
    type("rc-in-c1", "0:05");
    fireEvent.keyDown(screen.getByTestId("rc-in-c1"), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("rc-time-error-c1").textContent).toBe("终点要在起点之后，且不超过视频的长度"));
    type("rc-out-c1", "0:30");
    fireEvent.keyDown(screen.getByTestId("rc-out-c1"), { key: "Enter" });
    expect(edits(b)).toHaveLength(before);
    // Escape puts the clip's own times back.
    fireEvent.keyDown(screen.getByTestId("rc-in-c1"), { key: "Escape" });
    expect((screen.getByTestId("rc-in-c1") as HTMLInputElement).value).toBe("0:01.000");
    expect((screen.getByTestId("rc-out-c1") as HTMLInputElement).value).toBe("0:03.500");
    expect(screen.queryByTestId("rc-time-error-c1")).toBeNull();
  });

  it("moves clips up and down, keeps a note, removes a clip, and each is one undo", async () => {
    const b = await boot();
    const a = seedVideo(b.ctx.app, { title: "视频甲", durationMs: 12_000, probe: true });
    const cutId = await makeCut(b, "第一版", ["c1", "c2", "c3"].map((id, i) => ({ id, resourceId: a.resourceId, inMs: i * 1000, outMs: i * 1000 + 500 })));
    mount(b.projectId);
    await screen.findByTestId("rc-clips");
    expect((screen.getByTestId("rc-up-c1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("rc-down-c3") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("rc-down-c1"));
    await waitFor(() => expect(order()).toEqual(["c2", "c1", "c3"]));
    expect(edits(b).at(-1)!.input).toMatchObject({ label: "调整顺序", actions: [{ type: "move", clipId: "c1", index: 1 }] });
    fireEvent.click(screen.getByTestId("rc-up-c3"));
    await waitFor(() => expect(order()).toEqual(["c2", "c3", "c1"]));

    const note = screen.getByTestId("rc-label-c2");
    fireEvent.change(note, { target: { value: "开场镜头" } });
    fireEvent.blur(note);
    await waitFor(() => expect(edits(b).at(-1)!.input).toMatchObject({ actions: [{ type: "update", clipId: "c2", label: "开场镜头" }] }));
    fireEvent.click(screen.getByTestId("rc-remove-c3"));
    await waitFor(() => expect(order()).toEqual(["c2", "c1"]));
    expect((await b.run("roughcut.get", { cutId })).clips.map((clip: { id: string; label: string }) => [clip.id, clip.label])).toEqual([["c2", "开场镜头"], ["c1", ""]]);
    fireEvent.click(screen.getByTestId("rc-undo"));
    await waitFor(() => expect(order()).toEqual(["c2", "c3", "c1"]));
  });

  it("says why clips whose videos cannot be found cannot be exported, naming each, and keeps the clip", async () => {
    const b = await boot();
    const a = seedVideo(b.ctx.app, { title: "视频甲", durationMs: 12_000, probe: true });
    await makeCut(b, "第一版", [{ id: "c1", resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    mount(b.projectId);
    await screen.findByTestId("rc-clips");
    expect(screen.getByTestId("rc-missing-c1").textContent).toBe("视频找不到文件");
    expect(screen.getByTestId("rc-clip-c1").getAttribute("data-missing")).toBe("true");
    expect((screen.getByTestId("rc-preview-c1") as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId("rc-plan-verdict").textContent).toBe("现在不能导出，原因见下。"));
    expect(within(screen.getByTestId("rc-problems")).getByText("片段“视频甲”的视频找不到文件。")).toBeTruthy();
    expect((screen.getByTestId("rc-export") as HTMLButtonElement).disabled).toBe(true);
  });

  it("checks again a moment after the sequence changed, not after every keystroke", async () => {
    const b = await boot();
    const a = seedVideo(b.ctx.app, { title: "视频甲", durationMs: 12_000, probe: true });
    await makeCut(b, "第一版", ["c1", "c2"].map((id, i) => ({ id, resourceId: a.resourceId, inMs: i * 1000, outMs: i * 1000 + 500 })));
    mount(b.projectId);
    await screen.findByTestId("rc-clips");
    await waitFor(() => expect(screen.getByTestId("rc-plan").getAttribute("data-planning")).toBe("false"));
    const base = plans(b);
    fireEvent.click(screen.getByTestId("rc-down-c1"));
    fireEvent.click(screen.getByTestId("rc-down-c2"));
    fireEvent.click(screen.getByTestId("rc-up-c2"));
    await waitFor(() => expect(screen.getByTestId("rc-plan").getAttribute("data-planning")).toBe("false"), { timeout: 4000 });
    expect(plans(b) - base).toBeLessThanOrEqual(2);
    fireEvent.click(screen.getByTestId("rc-plan-again"));
    await waitFor(() => expect(plans(b)).toBeGreaterThan(base));
  });
});

describe.skipIf(mediaPrerequisitesAbsent)("the rough cut tab with real videos (AT-33)", () => {
  requireSamples(["video-roughcut"]);

  async function importSample(b: Booted, name: string) {
    const file = path.join(tmp(), name);
    fs.copyFileSync(samplePath("video-roughcut", name), file);
    return (await b.run("library.importDocument", { title: path.parse(name).name, kind: "video", pathHandle: b.ctx.app.registerPath("file", inLibrary(b.ctx.app, file, "video")) })).resourceId as string;
  }

  it("shows what will really be cut, then exports into the chosen folder and reports the check, the name and the time", async () => {
    const out = tmp();
    const b = await boot({});
    const picked = { pathHandle: b.ctx.app.registerPath("directory", out), name: "输出", mode: "directory" };
    (window.manga as unknown as { pick: () => Promise<unknown> }).pick = async () => picked;
    const a = await importSample(b, "a.mp4");
    await makeCut(b, "试剪", [{ id: "c1", resourceId: a, inMs: 2500, outMs: 5500 }, { id: "c2", resourceId: a, inMs: 3000, outMs: 5000 }]);
    mount(b.projectId);
    await screen.findByTestId("rc-clips");
    await waitFor(() => expect(screen.getByTestId("rc-plan-verdict").textContent).toBe("可以直接拼接导出，不重新编码。"), { timeout: 15_000 });
    const first = screen.getByTestId("rc-plan-clip-c1");
    expect(first.getAttribute("data-on-keyframe")).toBe("false");
    expect(first.textContent).toContain("请求 0:02.500 – 0:05.500，实际 0:02.000 – 0:05.500");
    expect(first.textContent).toContain("起点提前 0.500 秒");
    expect(first.textContent).toContain("84 帧");
    expect(screen.getByTestId("rc-plan-clip-c2").getAttribute("data-on-keyframe")).toBe("true");
    expect(screen.getByTestId("rc-plan-totals").textContent).toContain("输出 mov 文件（.mp4）");

    const exportButton = screen.getByTestId("rc-export") as HTMLButtonElement;
    await waitFor(() => expect(exportButton.disabled).toBe(false));
    fireEvent.click(exportButton);
    const dialog = await screen.findByTestId("rc-export-dialog");
    fireEvent.change(within(dialog).getByTestId("rc-export-name"), { target: { value: "界面导出" } });
    fireEvent.click(within(dialog).getByTestId("rc-export-dest-folder"));
    fireEvent.click(within(dialog).getByTestId("rc-export-pick"));
    await waitFor(() => expect(screen.queryByTestId("rc-export-dialog")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("rc-exports").querySelector("[data-state='done']")).toBeTruthy(), { timeout: 30_000 });
    const text = screen.getByTestId("rc-exports").textContent!;
    expect(text).toContain("已导出“界面导出.mp4”：");
    expect(text).toMatch(/检查通过：\d+ \/ \d+ 帧，长度相差 \d+ 毫秒。/);
    expect(text).toMatch(/用时 .*其中媒体工具 .*应用自己 /);
    expect(fs.readdirSync(out)).toEqual(["界面导出.mp4"]);
    expect(screen.queryByTestId("rc-export-running")).toBeNull();
    // Nothing on the page says where the file went.
    expect(document.body.textContent).not.toContain(out);
    expect((b.bridge.calls.find((call) => call.commandId === "roughcut.export")!.input as { fileName: string }).fileName).toBe("界面导出");
  });

  it("names the clip that cannot be joined and what differs, and offers no export until it is taken out", async () => {
    const b = await boot();
    const a = await importSample(b, "a.mp4");
    const c = await importSample(b, "c-resolution.mp4");
    await makeCut(b, "混编", [{ id: "c1", resourceId: a, inMs: 0, outMs: 2000 }, { id: "c2", resourceId: c, inMs: 0, outMs: 2000 }]);
    mount(b.projectId);
    await screen.findByTestId("rc-clips");
    await waitFor(() => expect(screen.getByTestId("rc-plan-verdict").textContent).toBe("现在不能导出，原因见下。"), { timeout: 15_000 });
    const list = screen.getByTestId("rc-problems");
    expect(list.querySelector("[data-code='resolution']")!.textContent).toBe("片段“c-resolution”的画面尺寸和第一段不同（640x360，这一段是 480x270）。");
    expect(screen.getByText(/不重新编码，所以每一段的编码/)).toBeTruthy();
    expect((screen.getByTestId("rc-export") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("rc-remove-c2"));
    await waitFor(() => expect(screen.getByTestId("rc-plan-verdict").textContent).toBe("可以直接拼接导出，不重新编码。"), { timeout: 15_000 });
    await waitFor(() => expect((screen.getByTestId("rc-export") as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows the progress of a running export, locks the sequence, and a cancel leaves nothing", async () => {
    const out = tmp();
    const b = await boot();
    (window.manga as unknown as { pick: () => Promise<unknown> }).pick = async () => ({ pathHandle: b.ctx.app.registerPath("directory", out), name: "输出", mode: "directory" });
    const a = await importSample(b, "a.mp4");
    const cutId = await makeCut(b, "长一些", Array.from({ length: 40 }, (_, i) => ({ id: `k${i}`, resourceId: a, inMs: (i % 10) * 1000, outMs: (i % 10) * 1000 + 800 })));
    mount(b.projectId);
    await screen.findByTestId("rc-clips");
    await waitFor(() => expect((screen.getByTestId("rc-export") as HTMLButtonElement).disabled).toBe(false), { timeout: 30_000 });
    fireEvent.click(screen.getByTestId("rc-export"));
    fireEvent.click(await screen.findByTestId("rc-export-dest-folder"));
    fireEvent.click(await screen.findByTestId("rc-export-pick"));
    const cancel = await screen.findByTestId("rc-export-cancel", {}, { timeout: 10_000 });
    expect(screen.getByTestId("rc-view").getAttribute("data-busy")).toBe("true");
    expect(screen.getByTestId("rc-busy").textContent).toBe("正在导出，序列暂时不能修改。");
    expect((screen.getByTestId("rc-remove-k0") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("rc-in-k0") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("rc-export") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.getByTestId("rc-exports").querySelector("[data-state='cancelled']")).toBeTruthy(), { timeout: 30_000 });
    expect(screen.getByTestId("rc-exports").textContent).toContain("已取消，没有留下文件。");
    await waitFor(() => expect(screen.getByTestId("rc-view").getAttribute("data-busy")).toBe("false"));
    expect(fs.readdirSync(out)).toEqual([]);
    expect((await b.run("roughcut.exports", { cutId })).exports[0].state).toBe("cancelled");
  });

  it("previews the requested stretch of a clip from the video's own handle, and closes the preview again", async () => {
    const b = await boot();
    const a = await importSample(b, "a.mp4");
    await makeCut(b, "试看", [{ id: "c1", resourceId: a, inMs: 2500, outMs: 5500 }]);
    mount(b.projectId);
    await screen.findByTestId("rc-clips");
    fireEvent.click(screen.getByTestId("rc-preview-c1"));
    const video = (await screen.findByTestId("rc-video", {}, { timeout: 10_000 })) as HTMLVideoElement;
    expect(video.getAttribute("src")).toMatch(/^manga-media:/);
    expect(screen.getByTestId("rc-preview-play")).toBeTruthy();
    expect(b.bridge.calls.some((call) => call.commandId === "video.handle")).toBe(true);
    fireEvent.click(screen.getByTestId("rc-preview-c1"));
    expect(screen.queryByTestId("rc-preview")).toBeNull();
  });
});

describe("adding the marked stretch from the player", () => {
  const props = (b: Booted, resourceId: string, revisionId: string, over: Partial<Parameters<typeof AddToRoughcut>[0]> = {}) => ({
    t, resourceId, revisionId, title: "视频甲", durationMs: 12_000, currentMs: 4000, interval: { startMs: 2500, endMs: 6000 } as { startMs: number; endMs: number } | null,
    onError: () => undefined, onNotice: () => undefined, ...over,
  });

  it("puts the marked interval into a new sequence of a new project made right there", async () => {
    const b = await boot();
    const a = seedVideo(b.ctx.app, { title: "视频甲", durationMs: 12_000, probe: true });
    const notices: string[] = [];
    const errors: string[] = [];
    render(<AddToRoughcut {...props(b, a.resourceId, a.revisionId, { onNotice: (m) => notices.push(m), onError: (m) => errors.push(m) })} />);
    fireEvent.click(screen.getByTestId("add-to-roughcut"));
    const dialog = await screen.findByTestId("add-to-roughcut-dialog");
    // The project made in `boot` is offered; a new one is chosen instead.
    expect(within(dialog).getByTestId("add-to-roughcut-source").textContent).toBe("视频甲 · 已用你标记的起点和终点");
    expect((within(dialog).getByTestId("add-to-roughcut-in") as HTMLInputElement).value).toBe("0:02.500");
    expect((within(dialog).getByTestId("add-to-roughcut-out") as HTMLInputElement).value).toBe("0:06.000");
    expect((within(dialog).getByTestId("add-to-roughcut-project") as HTMLSelectElement).value).toBe(b.projectId);
    fireEvent.change(within(dialog).getByTestId("add-to-roughcut-project"), { target: { value: "__new__" } });
    fireEvent.change(within(dialog).getByTestId("add-to-roughcut-project-name"), { target: { value: "新项目" } });
    fireEvent.change(within(dialog).getByTestId("add-to-roughcut-sequence-name"), { target: { value: "开场" } });
    fireEvent.click(within(dialog).getByTestId("add-to-roughcut-do"));
    await waitFor(() => expect(notices).toEqual(["已加入序列“开场”。"]));
    expect(errors).toEqual([]);
    expect(screen.queryByTestId("add-to-roughcut-dialog")).toBeNull();
    const projects = (await b.run("project.list", { status: "all" })).projects as Array<{ id: string; name: string }>;
    const made = projects.find((project) => project.name === "新项目")!;
    const cuts = (await b.run("roughcut.list", { projectId: made.id })).cuts as Array<{ id: string; title: string }>;
    expect(cuts.map((cut) => cut.title)).toEqual(["开场"]);
    const doc = await b.run("roughcut.get", { cutId: cuts[0]!.id });
    expect(doc.clips).toEqual([expect.objectContaining({ resourceId: a.resourceId, revisionId: a.revisionId, inMs: 2500, outMs: 6000 })]);
  });

  it("adds to a sequence that is already there, from the position when nothing is marked, and keeps the order", async () => {
    const b = await boot();
    const a = seedVideo(b.ctx.app, { title: "视频甲", durationMs: 12_000, probe: true });
    const cutId = await makeCut(b, "已有", [{ id: "c1", resourceId: a.resourceId, inMs: 0, outMs: 1000 }]);
    const notices: string[] = [];
    const added: string[] = [];
    render(<AddToRoughcut {...props(b, a.resourceId, a.revisionId, { interval: null, currentMs: 10_000, onNotice: (m) => notices.push(m), onAdded: (id) => added.push(id) })} />);
    fireEvent.click(screen.getByTestId("add-to-roughcut"));
    const dialog = await screen.findByTestId("add-to-roughcut-dialog");
    expect(within(dialog).getByTestId("add-to-roughcut-source").textContent).toBe("视频甲 · 没有标记，起点取当前位置，终点取 5 秒之后");
    expect((within(dialog).getByTestId("add-to-roughcut-in") as HTMLInputElement).value).toBe("0:10.000");
    // Near the end the default stops at the end of the video.
    expect((within(dialog).getByTestId("add-to-roughcut-out") as HTMLInputElement).value).toBe("0:12.000");
    await waitFor(() => expect((within(dialog).getByTestId("add-to-roughcut-sequence") as HTMLSelectElement).value).toBe(cutId));
    fireEvent.click(within(dialog).getByTestId("add-to-roughcut-do"));
    await waitFor(() => expect(added).toEqual([cutId]));
    expect(notices).toEqual(["已加入序列“已有”。"]);
    expect((await b.run("roughcut.get", { cutId })).clips.map((clip: { inMs: number; outMs: number }) => [clip.inMs, clip.outMs])).toEqual([[0, 1000], [10_000, 12_000]]);
  });

  it("refuses times that are not a stretch of the video, and adds nothing", async () => {
    const b = await boot();
    const a = seedVideo(b.ctx.app, { title: "视频甲", durationMs: 12_000, probe: true });
    const cutId = await makeCut(b, "已有", []);
    render(<AddToRoughcut {...props(b, a.resourceId, a.revisionId)} />);
    fireEvent.click(screen.getByTestId("add-to-roughcut"));
    const dialog = await screen.findByTestId("add-to-roughcut-dialog");
    await waitFor(() => expect((within(dialog).getByTestId("add-to-roughcut-sequence") as HTMLSelectElement).value).toBe(cutId));
    fireEvent.change(within(dialog).getByTestId("add-to-roughcut-out"), { target: { value: "0:01" } });
    fireEvent.click(within(dialog).getByTestId("add-to-roughcut-do"));
    expect((await within(dialog).findByTestId("add-to-roughcut-error")).textContent).toBe("终点要在起点之后，且不超过视频的长度");
    fireEvent.change(within(dialog).getByTestId("add-to-roughcut-in"), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByTestId("add-to-roughcut-do"));
    await waitFor(() => expect(within(dialog).getByTestId("add-to-roughcut-error").textContent).toBe("时间的写法不对，例如 1:23.500"));
    expect((await b.run("roughcut.get", { cutId })).clips).toEqual([]);
  });
});

describe("choosing tracks, files and keyframes in the model (AT-98)", () => {
  const keys = [0, 1000, 2000, 3000, 4000];

  it("lands a start on the keyframe at or before it, and finds the keyframes around a time", () => {
    expect(snapToKeyframe(keys, 2500)).toBe(2000);
    expect(snapToKeyframe(keys, 2000)).toBe(2000);
    expect(snapToKeyframe(keys, 1999.7)).toBe(2000);
    expect(snapToKeyframe(keys, 9000)).toBe(4000);
    expect(snapToKeyframe([1000, 2000], 500)).toBe(500);
    expect(snapToKeyframe([], 700)).toBe(700);
    expect(prevKeyframe(keys, 2500)).toBe(2000);
    expect(prevKeyframe(keys, 2000)).toBe(1000);
    expect(prevKeyframe(keys, 0)).toBeNull();
    expect(nextKeyframe(keys, 2500)).toBe(3000);
    expect(nextKeyframe(keys, 3000)).toBe(4000);
    expect(nextKeyframe(keys, 4000)).toBeNull();
    expect(nextKeyframe([], 10)).toBeNull();
  });

  it("draws each tick of a timeline once, however many keyframes there are", () => {
    const move = "M"; // the path command, which a stage-label check would otherwise take for a label when it is followed by a digit
    expect(tickPath([0, 500, 1000], 1000)).toBe(`${move}0 0V24${move}500 0V24${move}1000 0V24`);
    const many = Array.from({ length: 30_000 }, (_, i) => i * 100);
    expect(tickPath(many, 3_000_000).split("M").filter(Boolean)).toHaveLength(1001);
    expect(tickPath([100], 0)).toBe("");
  });

  it("sends only what differs from the default, and turns a track off and on again", () => {
    expect(optionsOf(DEFAULT_CHOICE)).toEqual({ mode: "merge" });
    expect(optionsOf({ mode: "separate", audio: [1], subtitle: [0], chapters: true })).toEqual({ mode: "separate", audioTracks: [1], subtitleTracks: [0], chapters: true });
    expect(optionsOf({ mode: "merge", audio: [], subtitle: [], chapters: false })).toEqual({ mode: "merge", audioTracks: [] });
    const off = toggleAudio(DEFAULT_CHOICE, 0, 2);
    expect(off.audio).toEqual([1]);
    expect(toggleAudio(off, 0, 2).audio).toBe("all");
    expect(toggleAudio(toggleAudio(DEFAULT_CHOICE, 0, 1), 0, 1).audio).toBe("all");
    expect(toggleAudio(toggleAudio(DEFAULT_CHOICE, 0, 1), 0, 1)).toEqual(DEFAULT_CHOICE);
    expect(toggleAudio(DEFAULT_CHOICE, 0, 1).audio).toEqual([]);
    expect(toggleSubtitle(toggleSubtitle(DEFAULT_CHOICE, 1), 0).subtitle).toEqual([0, 1]);
    expect(toggleSubtitle(toggleSubtitle(DEFAULT_CHOICE, 1), 1).subtitle).toEqual([]);
  });

  it("names a track by its number, codec, channels, language and title, and the whole choice in a line", () => {
    expect(trackLabel(t, { codec: "aac", channels: 2, language: "jpn", title: "原声" }, 0)).toBe("1. aac · 2 声道 · jpn · 原声");
    expect(trackLabel(t, { codec: "ass", language: "", title: "" }, 2)).toBe("3. ass");
    const plan = { tracks: { audio: [{}, {}], subtitle: [{}] } } as never;
    expect(choiceSummary(t, DEFAULT_CHOICE, plan)).toBe("一个文件（拼接）；音轨 全部；字幕轨 不要");
    expect(choiceSummary(t, { mode: "separate", audio: [1], subtitle: [0], chapters: true }, plan)).toBe("每段一个文件；音轨 2；字幕轨 1");
    expect(choiceSummary(t, { mode: "merge", audio: [], subtitle: [0, 1], chapters: true }, plan)).toBe("一个文件（拼接）；音轨 不要；字幕轨 1、2；每段写成章节");
  });

  it("reports separate files, a partial export, chapters and the folder of the work", () => {
    const check = (frames: number, ms = 1000) => ({ ok: true, expectedFrames: frames, actualFrames: frames, expectedMs: ms, actualMs: ms, streamsMatch: true });
    const base = { id: "e", cutId: "c", plan: null, bytes: null, timing: null, error: null, createdAt: "x", updatedAt: "x", total: 3, done: 3, step: null, commands: [], destination: "folder", folder: null };
    const files = ["甲.mp4", "乙.mp4", "丙.mp4", "丁.mp4", "戊.mp4"].map((fileName, i) => ({ clipId: `c${i}`, fileName, bytes: 10, check: check(24 + i) }));
    const many = exportSummary(t, { ...base, state: "done", mode: "separate", fileName: "甲.mp4", check: null, files } as never);
    expect(many).toEqual(["已导出 5 个文件，共 130 帧，约 0:05。", "文件：“甲.mp4”、“乙.mp4”、“丙.mp4”、“丁.mp4” 等 5 个", "5 个文件都检查通过。"]);
    const two = exportSummary(t, { ...base, state: "done", mode: "separate", fileName: "甲.mp4", check: null, files: files.slice(0, 2) } as never);
    expect(two[1]).toBe("文件：“甲.mp4”、“乙.mp4”");
    expect(exportSummary(t, { ...base, state: "failed", mode: "separate", fileName: null, check: null, files: files.slice(0, 2), error: { code: "NOT_FOUND", message: "视频没了" } } as never))
      .toEqual(["导出中途失败：已经完成的 2 个文件保留了，其余没有留下文件。原因：视频没了"]);
    expect(exportSummary(t, { ...base, state: "cancelled", mode: "separate", fileName: null, check: null, files: files.slice(0, 1) } as never)).toEqual(["已取消，没有留下文件。", "文件：“甲.mp4”"]);
    const merged = exportSummary(t, { ...base, state: "done", mode: "merge", destination: "work", folder: "动漫/某作品/粗剪", fileName: "成片.mp4", files: [], check: { ...check(48, 2000), chapters: { expected: 2, actual: 2 } } } as never);
    expect(merged).toEqual(["已导出“成片.mp4”：48 帧，约 0:02。", "检查通过：48 / 48 帧，长度相差 0 毫秒。", "已写入 2 个章节。", "放在“动漫/某作品/粗剪”里。"]);
  });
});

describe.skipIf(mediaPrerequisitesAbsent)("the rough cut tab by tracks, files and keyframes (AT-98)", () => {
  requireSamples(["video-roughcut", "video-mkv-ass-fonts"]);

  async function importFrom(b: Booted, sampleId: string, name: string | null, target: string) {
    const file = path.join(tmp(), target);
    fs.copyFileSync(name ? samplePath(sampleId, name) : samplePath(sampleId), file);
    return (await b.run("library.importDocument", { title: path.parse(target).name, kind: "video", pathHandle: b.ctx.app.registerPath("file", inLibrary(b.ctx.app, file, "video")) })).resourceId as string;
  }
  const show = (b: Booted) => importFrom(b, "video-mkv-ass-fonts", null, "第一集.mkv");
  const exportCalls = (b: Booted) => b.bridge.calls.filter((call) => call.commandId === "roughcut.export");

  it("lists the tracks of the first clip's source, asks the check again when one is turned off, and exports exactly those tracks into the work's folder", async () => {
    const b = await boot();
    const resourceId = await show(b);
    const cutId = await makeCut(b, "分集", [{ id: "c1", resourceId, inMs: 1000, outMs: 6000 }, { id: "c2", resourceId, inMs: 8000, outMs: 11_000 }]);
    mount(b.projectId);
    await screen.findByTestId("rc-options", {}, { timeout: 20_000 });
    expect(screen.getByTestId("rc-audio").textContent).toContain("1. aac · 1 声道 · jpn · Japanese 2.0");
    expect(screen.getByTestId("rc-audio").textContent).toContain("2. aac · 1 声道 · chi · Chinese 2.0");
    expect(screen.getByTestId("rc-subtitle").textContent).toContain("1. ass · eng · English (ASS)");
    expect((screen.getByTestId("rc-audio-0") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("rc-subtitle-0") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("rc-chapters") as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId("rc-fonts-note")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("rc-plan-verdict").textContent).toBe("可以直接拼接导出，不重新编码。"), { timeout: 20_000 });

    const base = plans(b);
    fireEvent.click(screen.getByTestId("rc-audio-0"));
    fireEvent.click(screen.getByTestId("rc-subtitle-0"));
    fireEvent.click(screen.getByTestId("rc-chapters"));
    await waitFor(() => expect(plans(b)).toBeGreaterThan(base), { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId("rc-plan").getAttribute("data-planning")).toBe("false"), { timeout: 20_000 });
    const last = b.bridge.calls.filter((call) => call.commandId === "roughcut.plan").at(-1)!;
    expect(last.input).toMatchObject({ cutId, options: { mode: "merge", audioTracks: [1], subtitleTracks: [0], chapters: true } });
    expect(screen.getByTestId("rc-fonts-note").textContent).toContain("内嵌的字体带不进去");

    fireEvent.click(screen.getByTestId("rc-export"));
    const dialog = await screen.findByTestId("rc-export-dialog");
    expect(within(dialog).getByTestId("rc-export-choice").textContent).toBe("一个文件（拼接）；音轨 2；字幕轨 1；每段写成章节");
    expect((within(dialog).getByTestId("rc-export-dest-work") as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByTestId("rc-export-pick").textContent).toContain("导出");
    fireEvent.click(within(dialog).getByTestId("rc-export-pick"));
    await waitFor(() => expect(screen.queryByTestId("rc-export-dialog")).toBeNull());
    expect(exportCalls(b).at(-1)!.input).toEqual({ cutId, options: { mode: "merge", audioTracks: [1], subtitleTracks: [0], chapters: true } });
    await waitFor(() => expect(screen.getByTestId("rc-exports").querySelector("[data-state='done']")).toBeTruthy(), { timeout: 60_000 });
    const text = screen.getByTestId("rc-exports").textContent!;
    expect(text).toContain("已导出“分集.mkv”");
    expect(text).toContain("已写入 2 个章节。");
    expect(text).toMatch(/放在“未分类\/.*\/粗剪”里。/);
    // The record of what the media tool was asked, with this machine's places left out.
    const details = screen.getByTestId("rc-exports").querySelector("details")!;
    expect(details).toBeTruthy();
    const commands = details.querySelector("pre")!.textContent!;
    expect(commands).toContain("-map 0:a:1");
    expect(commands).toContain("-map 0:s:0");
    expect(commands).toContain("-c copy");
    expect(commands).toContain("<source-1>");
    expect(commands).not.toContain(os.tmpdir());
    expect(document.body.textContent).not.toContain(os.tmpdir());
    const file = (await b.run("roughcut.exports", { cutId })).exports[0] as { files: Array<{ fileName: string }> };
    expect(file.files.map((item) => item.fileName)).toEqual(["分集.mkv"]);
  });

  it("offers each clip as a file of its own when the clips cannot be joined, and exports them", async () => {
    const b = await boot();
    const a = await importFrom(b, "video-roughcut", "a.mp4", "a.mp4");
    const c = await importFrom(b, "video-roughcut", "c-resolution.mp4", "c-resolution.mp4");
    const cutId = await makeCut(b, "混编", [{ id: "c1", resourceId: a, inMs: 0, outMs: 2000 }, { id: "c2", resourceId: c, inMs: 0, outMs: 2000 }]);
    mount(b.projectId);
    await waitFor(() => expect(screen.getByTestId("rc-plan-verdict").textContent).toBe("现在不能导出，原因见下。"), { timeout: 20_000 });
    expect(screen.getByTestId("rc-plan-separate-only").textContent).toBe("这些片段拼不成一个文件，但可以改成“每段一个文件”导出。");
    expect((screen.getByTestId("rc-export") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("rc-mode-separate"));
    await waitFor(() => expect(screen.getByTestId("rc-plan-verdict").textContent).toBe("可以每段单独导出，不重新编码。"), { timeout: 20_000 });
    expect(screen.queryByTestId("rc-problems")).toBeNull();
    expect((screen.getByTestId("rc-chapters") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("rc-plan-clip-c2").textContent).toContain("文件 .mp4");
    await waitFor(() => expect((screen.getByTestId("rc-export") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("rc-export"));
    fireEvent.click(await screen.findByTestId("rc-export-pick"));
    await waitFor(() => expect(screen.getByTestId("rc-exports").querySelector("[data-state='done']")).toBeTruthy(), { timeout: 60_000 });
    const text = screen.getByTestId("rc-exports").textContent!;
    expect(text).toMatch(/已导出 2 个文件，共 96 帧，约 0:04/);
    expect(text).toContain("文件：“混编 01 a.mp4”、“混编 02 c-resolution.mp4”");
    expect(text).toContain("2 个文件都检查通过。");
    const done = (await b.run("roughcut.exports", { cutId })).exports[0] as { mode: string; files: Array<{ fileName: string }> };
    expect(done.mode).toBe("separate");
    expect(done.files).toHaveLength(2);
  });

  it("shows the keyframes of the video, jumps between them, marks the start on a keyframe and the end where it is, and snaps a typed start", async () => {
    const b = await boot();
    const a = await importFrom(b, "video-roughcut", "a.mp4", "a.mp4");
    await makeCut(b, "标记", [{ id: "c1", resourceId: a, inMs: 2500, outMs: 5500 }]);
    mount(b.projectId);
    await screen.findByTestId("rc-clips");
    await waitFor(() => expect(b.bridge.calls.some((call) => call.commandId === "video.keyframes")).toBe(true), { timeout: 20_000 });
    fireEvent.click(screen.getByTestId("rc-preview-c1"));
    await screen.findByTestId("rc-video", {}, { timeout: 10_000 });
    await waitFor(() => expect(screen.getByTestId("rc-key-count").textContent).toBe("12 个关键帧"), { timeout: 20_000 });
    expect(screen.getByTestId("rc-ticks").getAttribute("d")!.split("M").filter(Boolean)).toHaveLength(12);
    // The video opens at the start of the clip, 2.5 s: the keyframes around it are 2 s and 3 s.
    expect(screen.getByTestId("rc-current").textContent).toBe("当前 0:02.500");
    fireEvent.click(screen.getByTestId("rc-key-next"));
    expect(screen.getByTestId("rc-current").textContent).toBe("当前 0:03.000");
    fireEvent.click(screen.getByTestId("rc-key-next"));
    fireEvent.click(screen.getByTestId("rc-key-prev"));
    expect(screen.getByTestId("rc-current").textContent).toBe("当前 0:03.000");
    const before = edits(b).length;
    fireEvent.click(screen.getByTestId("rc-set-in"));
    await waitFor(() => expect(edits(b)).toHaveLength(before + 1));
    expect(edits(b).at(-1)!.input).toMatchObject({ actions: [{ type: "update", clipId: "c1", inMs: 3000 }] });
    // The video stays on show while the start changes.
    expect(screen.getByTestId("rc-video")).toBeTruthy();
    fireEvent.click(screen.getByTestId("rc-key-next"));
    fireEvent.click(screen.getByTestId("rc-set-out"));
    await waitFor(() => expect(edits(b)).toHaveLength(before + 2));
    expect(edits(b).at(-1)!.input).toMatchObject({ actions: [{ type: "update", clipId: "c1", outMs: 4000 }] });

    // A typed start lands on the keyframe before it while snapping is on, and stays where it was typed when it is off.
    type("rc-in-c1", "0:02.700");
    fireEvent.keyDown(screen.getByTestId("rc-in-c1"), { key: "Enter" });
    await waitFor(() => expect(edits(b)).toHaveLength(before + 3));
    expect(edits(b).at(-1)!.input).toMatchObject({ actions: [{ type: "update", clipId: "c1", inMs: 2000, outMs: 4000 }] });
    expect((await screen.findByTestId("rc-snapped-c1")).textContent).toBe("起点已吸附到关键帧 0:02.000");
    fireEvent.click(screen.getByTestId("rc-snap"));
    expect((screen.getByTestId("rc-snap") as HTMLInputElement).checked).toBe(false);
    type("rc-in-c1", "0:02.700");
    fireEvent.keyDown(screen.getByTestId("rc-in-c1"), { key: "Enter" });
    await waitFor(() => expect(edits(b)).toHaveLength(before + 4));
    expect(edits(b).at(-1)!.input).toMatchObject({ actions: [{ type: "update", clipId: "c1", inMs: 2700, outMs: 4000 }] });
    expect(window.localStorage.getItem("manga.roughcut.snap")).toBe("off");
    window.localStorage.removeItem("manga.roughcut.snap");
  });
});
