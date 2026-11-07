import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { evidenceRunDir } from "../../scripts/desktop-paths.ts";
import { readLocalEnv } from "../helpers/local-env.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";

/**
 * Read-only import trial on the developer's own anime library (AT-80), run with MANGA_REAL_SAMPLES=1: the folder becomes a library path of a
 * throwaway profile and the scan runs for a fixed time, the way a person adds it. Nothing is copied or written next to the sources. The
 * summary carries counts and times only (no file names, no paths, no titles): how long the first work took to list, how many files the scan
 * got through, how many runs of the media tool it made and of what kind, and how many bytes the volume served while it ran, when the system
 * can say.
 */
const KEY = "MANGA_TEST_LIBRARY_ANIME";
const enabled = process.env.MANGA_REAL_SAMPLES === "1" && !process.env.CI;
const root = enabled ? readLocalEnv([KEY])[KEY] : undefined;
const BUDGET_MS = Number(process.env.MANGA_REAL_IMPORT_BUDGET_MS ?? 240_000);

/** Bytes the source's volume read per second, sampled once a second by the system's own counter; null when the counter is not there. */
function watchVolume(source: string) {
  const letter = path.parse(source).root.slice(0, 1);
  if (process.platform !== "win32" || !/^[A-Za-z]$/.test(letter)) return { stop: async () => null as number | null };
  const samples: number[] = [];
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Counter -Counter '\\LogicalDisk(${letter}:)\\Disk Read Bytes/sec' -SampleInterval 1 -Continuous | ForEach-Object { $_.CounterSamples[0].CookedValue }`], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let tail = "";
  child.stdout.on("data", (chunk: Buffer) => {
    tail += chunk.toString();
    const lines = tail.split(/\r?\n/);
    tail = lines.pop() ?? "";
    for (const line of lines) { const value = Number(line.trim().replace(",", ".")); if (Number.isFinite(value)) samples.push(value); }
  });
  return {
    stop: async () => {
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return samples.length ? Math.round(samples.reduce((sum, value) => sum + value, 0)) : null;
    },
  };
}

describe.skipIf(!root || !fs.existsSync(root) || mediaPrerequisitesAbsent)("real anime library, read-only import trial (AT-80)", () => {
  it("scans the library path for a fixed time and reads no frame table", async () => {
    const source = root!;
    const before = fs.statSync(source).mtimeMs;
    const ctx = await startApp();
    try {
      const tools = { probe: 0, packet: 0, frame: 0, other: 0 };
      const ffmpeg = ctx.app.media.ffmpeg;
      const original = ffmpeg.run.bind(ffmpeg);
      ffmpeg.run = ((tool: "ffmpeg" | "ffprobe", args: string[], options: never) => {
        if (args.some((arg) => String(arg).startsWith("packet="))) tools.packet += 1;
        else if (tool === "ffprobe") tools.probe += 1;
        else if (args.includes("image2pipe")) tools.frame += 1;
        else tools.other += 1;
        return original(tool, args, options);
      }) as typeof ffmpeg.run;
      const call = async (commandId: string, input: Record<string, unknown>, n: number) => {
        const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `real-import-${commandId}-${n}`, input }, ctx.grant.handle);
        expect(result.status, commandId).toBe("ok");
        return result.value as Record<string, any>;
      };
      const volume = watchVolume(source);
      const started = performance.now();
      const added = await call("library.paths.add", { pathHandle: ctx.app.registerPath("directory", source), mediaKind: "video", autoScan: false }, 0);
      await call("library.scan.start", { pathId: added.path.id }, 1);
      let firstWorkMs: number | null = null;
      let cancelled = false;
      let polls = 0;
      for (;;) {
        polls += 1;
        const status = await call("library.scan.status", {}, polls + 10);
        const elapsed = performance.now() - started;
        if (firstWorkMs === null && (ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM works").get() as { n: number }).n > 0) firstWorkMs = Math.round(elapsed);
        if (!status.running && status.queued.length === 0 && status.recent.some((job: { pathId: string }) => job.pathId === added.path.id)) break;
        if (elapsed > BUDGET_MS && !cancelled) { cancelled = true; await call("library.scan.cancel", { pathId: added.path.id }, polls + 100_000); }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const elapsedMs = Math.round(performance.now() - started);
      const volumeBytes = await volume.stop();
      const sql = ctx.app.store.sqlite;
      const count = (query: string) => (sql.prepare(query).get() as { n: number }).n;
      const job = sql.prepare("SELECT status, processed, total, added, changed, failed, skipped FROM scan_jobs ORDER BY rowid DESC LIMIT 1").get() as Record<string, number | string>;
      const files = Number(job.processed);
      const summary = {
        generatedAt: new Date().toISOString(), medium: "anime", budgetMs: BUDGET_MS, ranOutOfBudget: cancelled, elapsedMs, firstWorkMs,
        scan: job, works: count("SELECT COUNT(*) AS n FROM works"), resources: count("SELECT COUNT(*) AS n FROM resources"),
        filesPerSecond: files && elapsedMs ? Math.round((files / (elapsedMs / 1000)) * 10) / 10 : null,
        toolRuns: tools, toolRunsPerFile: files ? { probe: Math.round((tools.probe / files) * 100) / 100, frame: Math.round((tools.frame / files) * 100) / 100 } : null,
        volumeReadBytes: volumeBytes, volumeReadBytesPerFile: volumeBytes !== null && files ? Math.round(volumeBytes / files) : null,
      };
      const out = path.join(evidenceRunDir("real-import"), "summary.json");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(summary, null, 2));
      // The point of the trial: a scan is a probe of each file and a cover per work, and never a pass over every packet.
      expect(tools.packet, "no import may read every packet of a file").toBe(0);
      expect(fs.statSync(source).mtimeMs, "the trial must not touch the sources").toBe(before);
    } finally { ctx.app.close(); }
  }, BUDGET_MS + 180_000);
});
