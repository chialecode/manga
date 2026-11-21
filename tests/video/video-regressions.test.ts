import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DrizzleStore } from "@manga/storage-drizzle";
import type { VideoProbe } from "@manga/contracts";
import { MediaServices } from "../../packages/app-core/src/media/index.ts";
import { answerFrame, type FrameIndex } from "../../packages/app-core/src/video/frames.ts";
import { PlayCopies } from "../../packages/app-core/src/video/play-copy.ts";
import { SqlitePlayCopyStore } from "../../packages/app-core/src/video/play-copy-store.ts";
import { VideoService } from "../../packages/app-core/src/video/service.ts";
import { discoverSidecars } from "../../packages/app-core/src/video/sidecars.ts";
import { libraryRoot } from "../helpers/app.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-video-reg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function makeProbe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    container: "matroska",
    formatNames: ["matroska", "webm"],
    durationMs: 30_000,
    startMs: 5_000,
    bitRate: 1_000_000,
    size: 4096,
    streams: [
      { index: 0, type: "video", codec: "mjpeg", width: 300, height: 300, attachedPic: true } as VideoProbe["streams"][number],
      { index: 1, type: "video", codec: "h264", width: 1280, height: 720, fps: 24, bitDepth: 8, pixelFormat: "yuv420p" } as VideoProbe["streams"][number],
      { index: 2, type: "audio", codec: "aac", channels: 2 } as VideoProbe["streams"][number],
    ],
    chapters: [],
    tool: { name: "ffprobe", version: "test" },
    keyframesMs: [0, 5000, 10000],
    keyframesTruncated: false,
    variableFrameRate: false,
    externalSubtitles: [],
    ...overrides,
  } as VideoProbe;
}

function seedVideoRow(store: DrizzleStore, libDir: string, fileName: string, probe: VideoProbe) {
  const filePath = path.join(libDir, fileName);
  fs.writeFileSync(filePath, Buffer.alloc(1024, 0x55));
  const rootPath = libraryRoot({ store }, libDir, "video");
  const lp = store.sqlite.prepare("SELECT id FROM library_paths WHERE path = ?").get(rootPath) as { id: string };
  const now = new Date().toISOString();
  const workId = `wrk_${Math.random().toString(36).slice(2, 10)}`;
  const resourceId = `res_${Math.random().toString(36).slice(2, 10)}`;
  const revisionId = `rev_${Math.random().toString(36).slice(2, 10)}`;
  const payload = { id: revisionId, format: "video", parserId: "video-probe-v1", video: { durationMs: probe.durationMs, container: probe.container, startMs: probe.startMs, hasSubtitles: false }, parts: [], warnings: [] };
  store.commit({
    mutations: [
      { sql: "INSERT INTO works(id, title, media_kind, created_at, updated_at) VALUES (?,?,?,?,?)", params: [workId, fileName, "video", now, now] },
      { sql: "INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at, sort_key) VALUES (?,?,?,?,?,?,?)", params: [resourceId, workId, "video", fileName, "[]", now, ""] },
      { sql: "INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)", params: [revisionId, resourceId, `fp_${revisionId}`, "video-probe-v1", JSON.stringify(payload), now] },
      { sql: "INSERT INTO media_probes(resource_revision_id, probe_json, tool_version, created_at) VALUES (?,?,?,?)", params: [revisionId, JSON.stringify(probe), "ffprobe test", now] },
      { sql: "INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,1,0)", params: [`fl_${revisionId}`, revisionId, lp.id, fileName, `fp_${revisionId}`] },
    ],
    events: [],
  });
  return { workId, resourceId, revisionId, filePath };
}

describe("video regressions", () => {
  it("frameImage and clipBytes do not double-shift non-zero probe.startMs, validate duration, and map primary video stream", async () => {
    const dir = path.join(root, "offset-seek");
    const libDir = path.join(dir, "lib");
    fs.mkdirSync(libDir, { recursive: true });
    const store = new DrizzleStore({ profileDir: path.join(dir, "data"), hostId: "v-offset", attachmentsDir: path.join(dir, "att") });
    const media = new MediaServices({ cacheDir: path.join(dir, "cache"), tools: null });
    try {
      const probe = makeProbe({ startMs: 5_000 });
      const seeded = seedVideoRow(store, libDir, "offset.mkv", probe);
      const service = new VideoService(store, media);

      const frameCalls: number[] = [];
      vi.spyOn(media.ffmpeg, "frameJpeg").mockImplementation(async (_file, sec) => {
        frameCalls.push(sec);
        return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      });

      const jpeg = await service.frameImage(seeded.resourceId, seeded.revisionId, 1_200, 320);
      expect(jpeg.subarray(0, 3).toString("hex")).toBe("ffd8ff");
      // Container-relative 1.200s (NOT 6.200s!).
      expect(frameCalls).toEqual([1.2]);

      const runCalls: string[][] = [];
      vi.spyOn(media.ffmpeg, "run").mockImplementation(async (tool, args) => {
        if (tool === "ffprobe") return { code: 0, signal: null, stdout: Buffer.from("0\n"), stderr: "", killed: null };
        runCalls.push(args);
        const outPath = args[args.length - 1]!;
        fs.writeFileSync(outPath, Buffer.from("mp4-bytes"));
        return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: "", killed: null };
      });

      await expect(service.clipBytes(seeded.resourceId, seeded.revisionId, 1000, 0)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      const clip = await service.clipBytes(seeded.resourceId, seeded.revisionId, 1_200, 2_500);
      expect(clip.toString()).toBe("mp4-bytes");
      expect(runCalls).toHaveLength(1);
      const args = runCalls[0]!;
      expect(args[args.indexOf("-ss") + 1]).toBe("1.200");
      expect(args[args.indexOf("-map") + 1]).toBe("0:1"); // skips index 0 attached_pic!
    } finally {
      media.dispose();
      store.close();
    }
  });

  it("forgetRevision removes frame-index, subtitles, and fonts dirs and clears memory caches and handles", () => {
    const dir = path.join(root, "forget-rev");
    const libDir = path.join(dir, "lib");
    fs.mkdirSync(libDir, { recursive: true });
    const store = new DrizzleStore({ profileDir: path.join(dir, "data"), hostId: "v-forget", attachmentsDir: path.join(dir, "att") });
    const media = new MediaServices({ cacheDir: path.join(dir, "cache"), tools: null });
    try {
      const seeded = seedVideoRow(store, libDir, "forget.mkv", makeProbe({ startMs: 0 }));
      const service = new VideoService(store, media);

      const frameDir = path.join(dir, "cache", "frame-index");
      const subDir = path.join(dir, "cache", "subtitles", seeded.revisionId);
      const fontDir = path.join(dir, "cache", "fonts", seeded.revisionId);
      fs.mkdirSync(frameDir, { recursive: true });
      fs.mkdirSync(subDir, { recursive: true });
      fs.mkdirSync(fontDir, { recursive: true });
      const frameFile = path.join(frameDir, `${seeded.revisionId}.json`);
      fs.writeFileSync(frameFile, JSON.stringify({ version: 1, streamIndex: 1, startMs: 0, ptsMs: [0, 42], keyframesMs: [0], variableFrameRate: false }));
      fs.writeFileSync(path.join(subDir, "s0.ass"), "sub");
      fs.writeFileSync(path.join(fontDir, "f0.ttf"), "font");

      const issued = media.handles.issue({ kind: "file", path: seeded.filePath, mediaType: "video/x-matroska" }, { moduleId: "video", resourceId: seeded.resourceId, revisionId: seeded.revisionId });
      expect(media.handles.resolve(issued.handle)).not.toBeNull();

      service.forgetRevision(seeded.revisionId);
      expect(fs.existsSync(frameFile)).toBe(false);
      expect(fs.existsSync(subDir)).toBe(false);
      expect(fs.existsSync(fontDir)).toBe(false);
      expect(media.handles.resolve(issued.handle)).toBeNull();
    } finally {
      media.dispose();
      store.close();
    }
  });

  it("PlayCopies.remove sweeps stray files even after DB rows are deleted post-commit", () => {
    const dir = path.join(root, "playcopy-strays");
    const store = new DrizzleStore({ profileDir: path.join(dir, "data"), hostId: "v-strays", attachmentsDir: path.join(dir, "att") });
    const media = new MediaServices({ cacheDir: path.join(dir, "cache"), tools: null });
    try {
      const copies = new PlayCopies(new SqlitePlayCopyStore(store.sqlite), media, () => { throw new Error("unused"); });
      const copyDir = path.join(dir, "cache", "play-copies");
      fs.mkdirSync(copyDir, { recursive: true });
      const stray = path.join(copyDir, "rev_gone-abc.mp4");
      fs.writeFileSync(stray, Buffer.alloc(64, 1));
      copies.remove("rev_gone");
      expect(fs.existsSync(stray)).toBe(false);
    } finally {
      media.dispose();
      store.close();
    }
  });

  it("discoverSidecars assigns unique IDs to same-named subtitles in root vs Subs folder", () => {
    const dir = path.join(root, "sidecars-unique");
    fs.mkdirSync(path.join(dir, "Subs"), { recursive: true });
    fs.mkdirSync(path.join(dir, "Subtitles"), { recursive: true });
    const vid = path.join(dir, "ep01.mkv");
    fs.writeFileSync(vid, Buffer.alloc(16));
    fs.writeFileSync(path.join(dir, "ep01.ass"), "root");
    fs.writeFileSync(path.join(dir, "Subs", "ep01.ass"), "subs");
    fs.writeFileSync(path.join(dir, "Subtitles", "ep01.ass"), "subtitles");

    const found = discoverSidecars(vid);
    expect(found).toHaveLength(3);
    expect(new Set(found.map((item) => item.id)).size).toBe(3);
  });

  it("answerFrame validates empty pts, negative or non-integer frame, and truncates delta", () => {
    const empty: FrameIndex = { version: 1, streamIndex: 0, startMs: 0, ptsMs: [], keyframesMs: [], variableFrameRate: false };
    expect(() => answerFrame(empty, 1000, { timeMs: 0 })).toThrowError(/no indexed frames/);

    const idx: FrameIndex = { version: 1, streamIndex: 0, startMs: 0, ptsMs: [0, 40, 80, 120], keyframesMs: [0], variableFrameRate: false };
    expect(() => answerFrame(idx, 160, { frame: -1 })).toThrowError(/non-negative integer/);
    expect(() => answerFrame(idx, 160, { frame: 1.5 })).toThrowError(/non-negative integer/);
    expect(answerFrame(idx, 160, { frame: 1, delta: 1.9 }).frame).toBe(2);
  });
});
