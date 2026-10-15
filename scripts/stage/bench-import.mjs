import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { MangaProductApp, TestVault } from "../../packages/app-core/src/index.ts";
import { locateFfmpeg } from "../../packages/app-core/src/media/index.ts";
import { repoRoot } from "./lib.mjs";

// Importing a folder of videos, measured at the service with the real media tool and synthetic files. The figure is what a user waits for:
// from adding the folder as a library location to the whole season being listed as one work with every episode in it. A second figure counts
// the runs of the media tool that read every packet of a file; an import must not make one (the frame table waits for a frame-by-frame step).

const SAMPLE = path.join(repoRoot, "dist/samples/media/video/roughcut/a.mp4");

/** `videos` different episode files: the same short clip remuxed with a different tag each, so every file has its own identity. */
function writeEpisodes(folder, videos, ffmpeg) {
  fs.mkdirSync(folder, { recursive: true });
  for (let index = 1; index <= videos; index += 1) {
    const name = `Bench Show - ${String(index).padStart(2, "0")}.mp4`;
    const made = spawnSync(ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", SAMPLE, "-c", "copy", "-metadata", `comment=episode ${index}`, path.join(folder, name)], { encoding: "utf8", windowsHide: true });
    if (made.status !== 0) throw new Error(`could not make episode ${index}: ${made.stderr}`);
  }
}

/**
 * `runs` imports of `videos` episodes, each into a fresh profile. Every run is checked for what it holds: one work with every episode, a cover,
 * and no run of the media tool that read every packet; a fast wrong answer fails.
 */
export async function runVideoImportBench({ videos, runs }) {
  const tools = locateFfmpeg();
  if (!tools) throw new Error("the media tool is not installed");
  if (!fs.existsSync(SAMPLE)) throw new Error("the sample a.mp4 is missing; run node scripts/samples/generate-media-samples.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-import-"));
  try {
    const folder = path.join(root, "library", "Bench Show");
    writeEpisodes(folder, videos, tools.ffmpeg);
    const browsableMs = [];
    const packetReads = [];
    const detail = [];
    for (let run = 0; run < runs; run += 1) {
      const profile = path.join(root, `profile-${run}`);
      const app = new MangaProductApp({
        profileRoot: path.join(profile, "root"), documentsDir: path.join(profile, "documents"), pointerPath: path.join(profile, "launcher", "pointer.json"),
        channel: "test", hostId: `bench-import-${run}`, vault: new TestVault(`bench-import-${run}`),
      });
      try {
        await app.start();
        if (!app.media.ffmpeg.available) throw new Error("the media tool is not installed");
        const actor = { kind: "user", id: "bench-import" };
        const grant = app.issueOwnerGrant(actor);
        let n = 0;
        const call = async (commandId, input) => {
          n += 1;
          const result = await app.call(actor, { commandId, idempotencyKey: `bench-import-${run}-${n}`, input }, grant.handle);
          if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
          return result.value;
        };
        await call("settings.skipAi", {});
        const ffmpeg = app.media.ffmpeg;
        const original = ffmpeg.run.bind(ffmpeg);
        const counts = { packet: 0, probe: 0, frame: 0 };
        ffmpeg.run = (tool, args, options) => {
          if (args.some((arg) => String(arg).startsWith("packet="))) counts.packet += 1;
          else if (tool === "ffprobe") counts.probe += 1;
          else if (args.includes("image2pipe")) counts.frame += 1;
          return original(tool, args, options);
        };
        const started = performance.now();
        const added = await call("library.paths.add", { pathHandle: app.registerPath("directory", path.join(root, "library")), mediaKind: "video", autoScan: false });
        let finished = null;
        for (;;) {
          const status = await call("library.scan.status", {});
          if (!status.running && status.queued.length === 0) {
            finished = status.recent.find((job) => job.pathId === added.path.id) ?? null;
            if (finished) break;
          }
          if (performance.now() - started > 10 * 60_000) throw new Error("the import did not finish in 10 minutes");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // Browsable: the season is on the shelf as one work and every episode can be opened from it.
        const list = await call("works.list", { limit: 60 });
        const items = list.items ?? [];
        const work = await call("works.get", { workId: items[0]?.id });
        const listedMs = performance.now() - started;
        await app.media.jobs.idle();
        const idleMs = performance.now() - started;
        if (finished.failed !== 0 || finished.added !== videos) throw new Error(`the scan added ${finished.added} of ${videos} videos and failed ${finished.failed}`);
        if (items.length !== 1 || (work.resources ?? []).length !== videos) throw new Error(`the library lists ${items.length} works, the first with ${(work.resources ?? []).length} of ${videos} episodes`);
        if (!app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ? AND cover_id IS NOT NULL").get(work.id ?? items[0].id)) throw new Error("the work has no cover after the background work ended");
        browsableMs.push(Math.round(listedMs));
        packetReads.push(counts.packet);
        detail.push({ listedMs: Math.round(listedMs), backgroundIdleMs: Math.round(idleMs), probes: counts.probe, packetReads: counts.packet, coverFrames: counts.frame });
      } finally {
        app.close();
      }
    }
    return { videos, browsableMs, packetReads, detail };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
