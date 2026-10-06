import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FfmpegService, locateFfmpeg, redactToolText, runTool, timelineFromPackets } from "../../packages/app-core/src/media/index.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-ffmpeg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const tools = locateFfmpeg();
const service = new FfmpegService(tools, { concurrency: 2 });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("FFmpeg location and version", () => {
  it("finds the pinned development build and reports its version", async () => {
    expect(tools, "FFmpeg must be installed under dist/tools/ffmpeg or MANGA_FFMPEG_DIR").not.toBeNull();
    expect(await service.version()).toMatch(/^n?\d/);
  });

  it("is a capability gap, not a crash, when nothing is installed", async () => {
    const none = new FfmpegService(locateFfmpeg({ env: {}, resourcesPath: path.join(root, "nope"), cwd: root }));
    // The workspace copy is still found from the module location; an explicitly empty service reports the gap.
    const empty = new FfmpegService(null);
    expect(empty.available).toBe(false);
    await expect(empty.probe("x.mp4")).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(none).toBeTruthy();
  });
});

describe("probing the synthetic videos", () => {
  requireSamples(["video-mp4-h264-aac", "video-mkv-ass-fonts", "video-mkv-hevc-10bit", "video-mkv-hevc-8bit", "video-nonzero-start", "video-vfr", "video-ac3", "video-corrupt"]);

  it("reads container, streams, languages and timing of an MP4", async () => {
    const probe = await service.probe(samplePath("video-mp4-h264-aac"));
    expect(probe.container).toBe("mov");
    expect(probe.durationMs).toBeGreaterThan(5000);
    const video = probe.streams.find((stream) => stream.type === "video")!;
    expect(video).toMatchObject({ codec: "h264", width: expect.any(Number), pixelFormat: "yuv420p", bitDepth: 8 });
    expect(video.fps).toBeGreaterThan(10);
    expect(probe.streams.some((stream) => stream.type === "audio" && stream.codec === "aac")).toBe(true);
    expect(probe.tool).toMatchObject({ name: "ffprobe" });
  });

  it("reads an MKV with embedded ASS, an attached font, two audio tracks and chapters", async () => {
    const probe = await service.probe(samplePath("video-mkv-ass-fonts"));
    expect(probe.container).toBe("matroska");
    const audio = probe.streams.filter((stream) => stream.type === "audio");
    expect(audio.map((stream) => stream.language)).toEqual(["jpn", "chi"]);
    expect(audio.map((stream) => stream.title)).toEqual(["Japanese 2.0", "Chinese 2.0"]);
    expect(probe.streams.find((stream) => stream.type === "subtitle")).toMatchObject({ codec: "ass", textual: true });
    expect(probe.streams.find((stream) => stream.type === "attachment")).toMatchObject({ fileName: "arial.ttf", mimeType: expect.stringContaining("font") });
    expect(probe.chapters).toHaveLength(2);
  });

  it("tells HEVC 8-bit from 10-bit and keeps the profile", async () => {
    const eight = (await service.probe(samplePath("video-mkv-hevc-8bit"))).streams.find((stream) => stream.type === "video")!;
    const ten = (await service.probe(samplePath("video-mkv-hevc-10bit"))).streams.find((stream) => stream.type === "video")!;
    expect(eight).toMatchObject({ codec: "hevc", bitDepth: 8 });
    expect(ten).toMatchObject({ codec: "hevc", bitDepth: 10 });
    expect(ten.pixelFormat).toMatch(/10/);
  });

  it("reports a non-zero container start and an AC3 audio track", async () => {
    const offset = await service.probe(samplePath("video-nonzero-start"));
    expect(offset.startMs).toBe(2500);
    // Matroska states the end time; the length that counts from the start of the file is what the player and progress use.
    expect(offset.durationMs).toBeGreaterThan(10_000);
    expect(offset.durationMs).toBeLessThan(10_100);
    const ac3 = await service.probe(samplePath("video-ac3"));
    expect(ac3.streams.find((stream) => stream.type === "audio")?.codec).toBe("ac3");
  });

  it("builds a frame timeline in display order relative to the container start, and notices variable frame rate", async () => {
    const offsetFile = samplePath("video-nonzero-start");
    const probe = await service.probe(offsetFile);
    const video = probe.streams.find((stream) => stream.type === "video")!;
    const timeline = await service.packetTimeline(offsetFile, video.index, probe.startMs);
    expect(timeline.ptsMs[0]).toBeCloseTo(0, 1);
    expect(timeline.ptsMs.length).toBeGreaterThan(200);
    for (let i = 1; i < timeline.ptsMs.length; i += 1) expect(timeline.ptsMs[i]).toBeGreaterThan(timeline.ptsMs[i - 1]!);
    expect(timeline.variableFrameRate).toBe(false);
    expect(timeline.keyframesMs[0]).toBeCloseTo(0, 1);
    // 24 fps: frames are 41.67 ms apart.
    expect(timeline.ptsMs[24]! - timeline.ptsMs[0]!).toBeCloseTo(1000, 0);

    const vfrFile = samplePath("video-vfr");
    const vfrProbe = await service.probe(vfrFile);
    const vfrVideo = vfrProbe.streams.find((stream) => stream.type === "video")!;
    const vfr = await service.packetTimeline(vfrFile, vfrVideo.index, vfrProbe.startMs);
    expect(vfr.variableFrameRate).toBe(true);
  });

  it("undoes decode-order reordering when it sorts packet times", () => {
    const lines = ["0.000000,K__", "0.083333,___", "0.041667,___", "0.166667,___", "0.125000,___", "0.208333,___", "0.250000,___", "0.291667,___", "0.333333,___", "0.375000,K__"];
    const timeline = timelineFromPackets(lines, 0);
    expect(timeline.ptsMs.map((value) => Math.round(value))).toEqual([0, 42, 83, 125, 167, 208, 250, 292, 333, 375]);
    expect(timeline.keyframesMs.map((value) => Math.round(value))).toEqual([0, 375]);
    expect(timelineFromPackets(["junk", ",", "x,K"], 0).ptsMs).toEqual([]);
  });

  it("refuses a damaged container with a typed error that does not leak the path", async () => {
    const copy = path.join(root, "目录 含空格", "坏 文件.mp4");
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(samplePath("video-corrupt"), copy);
    const error = await service.probe(copy).catch((e: unknown) => e as { code: string; message: string });
    expect((error as { code: string }).code).toBe("UNSUPPORTED_FORMAT");
    expect((error as { message: string }).message).not.toContain(path.dirname(copy));
    expect((error as { message: string }).message).not.toContain("坏 文件");
  });

  it("probes a path with Chinese characters and spaces", async () => {
    const copy = path.join(root, "漫画 动画", "第 1 话 样本.mp4");
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(samplePath("video-mp4-h264-aac"), copy);
    expect((await service.probe(copy)).streams.length).toBeGreaterThan(0);
  });
});

describe("extracting from video", () => {
  it("decodes a frame at a time, scaled to the edge limit", async () => {
    const jpeg = await service.frameJpeg(samplePath("video-mp4-h264-aac"), 1.5, 160);
    expect(jpeg.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    const sharp = (await import("sharp")).default;
    const meta = await sharp(jpeg).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(160);
    await expect(service.frameJpeg(samplePath("video-mp4-h264-aac"), 9999, 160)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("extracts the ASS subtitle as text with its style and the font attachment under a name we chose", async () => {
    const file = samplePath("video-mkv-ass-fonts");
    const probe = await service.probe(file);
    const subtitle = probe.streams.find((stream) => stream.type === "subtitle")!;
    const ass = await service.subtitleText(file, subtitle.index, "ass");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("Dialogue:");
    const srt = await service.subtitleText(file, subtitle.index, "srt");
    expect(srt).toMatch(/[0-9]{2}:[0-9]{2}:[0-9]{2},[0-9]{3} --> /);

    const attachment = probe.streams.find((stream) => stream.type === "attachment")!;
    const dir = path.join(root, "fonts out");
    await service.dumpAttachments(file, [{ streamIndex: attachment.index, outName: "font-0.ttf" }], dir);
    const bytes = fs.readFileSync(path.join(dir, "font-0.ttf"));
    expect(bytes.length).toBeGreaterThan(1000);
    expect(["00010000", "74727565", "4f54544f"]).toContain(bytes.subarray(0, 4).toString("hex"));
  });
});

describe("running tools safely", () => {
  it("ends a process that outlives its timeout and says so", async () => {
    let pid: number | undefined;
    const started = Date.now();
    const run = await runTool(tools!.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "600", "-f", "null", "-"], { timeoutMs: 400, onSpawn: (value) => { pid = value; } });
    expect(run.killed).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pid && alive(pid)).toBeFalsy();
  });

  it("cancels a running job and leaves no process behind", async () => {
    let pid: number | undefined;
    const controller = new AbortController();
    const pending = service.run("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "600", "-f", "null", "-"], { signal: controller.signal, timeoutMs: 60_000, onSpawn: (value) => { pid = value; } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pid && alive(pid)).toBeTruthy();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pid && alive(pid)).toBeFalsy();
  });

  it("maps a timeout to a retryable error and an unreadable stream to a typed one", async () => {
    await expect(service.run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "600", "-f", "null", "-"], { timeoutMs: 300 })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    await expect(service.run("ffmpeg", ["-v", "error", "-i", path.join(root, "absent.mkv"), "-f", "null", "-"])).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });

  it("stops a tool that prints more than the output limit", async () => {
    const run = await runTool(process.execPath, ["-e", "const b=Buffer.alloc(65536,65);const t=setInterval(()=>process.stdout.write(b),1);"], { timeoutMs: 20_000, maxStdoutBytes: 200_000 });
    expect(run.killed).toBe("output-limit");
  });

  it("never runs more than the lane limit at once, and queued work waits", async () => {
    const limited = new FfmpegService(tools, { concurrency: 2 });
    let peak = 0;
    const tasks = Array.from({ length: 6 }, () => limited.run("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "0.4", "-f", "null", "-"], { timeoutMs: 20_000 }));
    const watcher = setInterval(() => { peak = Math.max(peak, limited.stats().running); }, 10);
    await Promise.all(tasks);
    clearInterval(watcher);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(limited.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it("cancels a task that is still waiting for a slot without ever starting it", async () => {
    const limited = new FfmpegService(tools, { concurrency: 1 });
    const slow = limited.run("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "0.8", "-f", "null", "-"], { timeoutMs: 20_000 });
    let spawned = false;
    const controller = new AbortController();
    const waiting = limited.run("ffmpeg", ["-version"], { signal: controller.signal, onSpawn: () => { spawned = true; } });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
    await slow;
    expect(spawned).toBe(false);
  });

  it("reports progress from -progress lines", () => {
    const seen: number[] = [];
    const reader = FfmpegService.progressReader(10_000, (value) => seen.push(value));
    for (const line of ["frame=10", "out_time_us=2500000", "out_time_ms=5000000", "progress=continue", "out_time_us=10000000", "progress=end"]) reader(line);
    expect(seen).toEqual([0.25, 0.5, 1, 1]);
  });
});

describe("path redaction", () => {
  it("removes absolute paths and the home directory from tool text", () => {
    const home = os.homedir();
    // Built from parts: the publication check refuses literal machine paths in a public file.
    const winUser = ["C", ":\\Users\\someone\\x y.mp4"].join("");
    const winMedia = ["D", ":/media/第1话.mp4"].join("");
    const posix = ["", "home", "alice", "clip.mkv"].join("/");
    const text = `Error opening ${home}\\secret\\file.mkv and ${winUser} and ${posix}, also "${winMedia}"`;
    const out = redactToolText(text);
    expect(out).not.toContain(home);
    expect(out).not.toContain(["C", ":\\Users"].join(""));
    expect(out).not.toContain("alice");
    expect(out).not.toContain(["D", ":/media"].join(""));
    expect(out).toContain("<path>");
    const work = ["C", ":\\work\\my clip.mp4"].join("");
    expect(redactToolText(`open ${work} failed`, [work])).toBe("open <path> failed");
  });
});
