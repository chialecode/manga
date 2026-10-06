import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import { ComicService, MediaServices } from "@manga/app-core";
import { planDirectory, VIDEO_EXTENSIONS } from "../../packages/app-core/src/comic/scan.ts";
import { serveMedia } from "../../packages/app-core/src/media/serve.ts";
import { startApp } from "../helpers/app.ts";
import { suggestKind } from "../../packages/app-core/src/comic/suggest.ts";
import { evidenceRunDir } from "../../scripts/desktop-paths.ts";

/**
 * Read-only open trial on the developer's own library (plan section 7.4). The roots come from MANGA_REAL_SAMPLE_ROOTS
 * (";" separated). Nothing is copied, nothing is written next to the sources, and the summary carries counts and
 * categories only: no file names, no paths, no titles.
 */
const ROOTS = (process.env.MANGA_REAL_SAMPLE_ROOTS ?? "").split(";").map((root) => root.trim()).filter(Boolean);

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function spread(values: number[]) {
  return { n: values.length, min: values.length ? Math.min(...values) : null, p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null };
}

function bump(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

/** Evenly spaced picks so a sample covers a long series, not just its first volumes. */
function stride<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.floor((i * items.length) / count)]!);
}

describe.skipIf(!ROOTS.length)("real library, read-only trial", () => {
  it("opens a sample of every kind without writing to the sources", async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "manga-real-"));
    const media = new MediaServices({ cacheDir: cache });
    const comics = new ComicService(undefined as never, media);
    const summary: Record<string, unknown> = { generatedAt: new Date().toISOString(), roots: [] as unknown[] };
    const before = ROOTS.map((root) => fs.statSync(root).mtimeMs);
    try {
      for (const [index, root] of ROOTS.entries()) {
        const extensions: Record<string, number> = {};
        const walkCount = { files: 0, dirs: 0, maxDepth: 0 };
        const walk = (dir: string, depth: number) => {
          walkCount.maxDepth = Math.max(walkCount.maxDepth, depth);
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) { walkCount.dirs += 1; walk(path.join(dir, entry.name), depth + 1); }
            else { walkCount.files += 1; bump(extensions, path.extname(entry.name).toLowerCase() || "(none)"); }
          }
        };
        walk(root, 0);
        const comic = planDirectory(root, "comic", { maxItems: 100_000, maxDepth: 12 });
        const novel = planDirectory(root, "novel", { maxItems: 100_000, maxDepth: 12 });
        const video = planDirectory(root, "video", { maxItems: 100_000, maxDepth: 12 });
        const planned = { comic: comic.items.length, novel: novel.items.length, video: video.items.length, truncated: comic.truncated || novel.truncated || video.truncated };
        const itemTypes: Record<string, number> = {};
        for (const item of comic.items) bump(itemTypes, `${item.type}:${path.extname(item.name).toLowerCase() || "dir"}`);

        // Comics: documents, folders and archives.
        const failures: Record<string, number> = {};
        const timings: number[] = [];
        const pageCounts: number[] = [];
        const unreadable: number[] = [];
        const warningKinds: Record<string, number> = {};
        const sampled: Record<string, number> = {};
        const byType = (type: string, ext?: string) => comic.items.filter((item) => item.type === type && (!ext || item.name.toLowerCase().endsWith(ext)));
        const picks = [
          ...stride(byType("document", ".pdf"), 6),
          ...stride(byType("document", ".epub"), 4),
          ...stride([...byType("document", ".mobi"), ...byType("document", ".azw3")], 4),
          ...stride(byType("image-dir"), 5),
          ...stride(byType("archive"), 3),
        ];
        for (const item of picks) {
          const kind = `${item.type}:${path.extname(item.name).toLowerCase() || "dir"}`;
          bump(sampled, kind);
          const started = performance.now();
          try {
            const scan = await comics.scan(item.path, { signal: AbortSignal.timeout(180_000) });
            timings.push(Math.round(performance.now() - started));
            pageCounts.push(scan.manifest.pages.length);
            unreadable.push(scan.manifest.pages.filter((page) => !page.ok).length);
            for (const warning of scan.manifest.warnings) bump(warningKinds, warning.replace(/[^\s]*\.[a-z0-9]{2,4}\b/gi, "<file>").replace(/\d+/g, "N").slice(0, 80));
          } catch (error) {
            const code = error instanceof MangaError ? `${error.code}:${error.message.replace(/[A-Za-z]:\\[^\s]*/g, "<path>").replace(/\d+/g, "N").slice(0, 60)}` : "OTHER";
            bump(failures, `${kind}→${code}`);
          }
        }

        // Kind suggestion for documents.
        const suggestions: Record<string, number> = {};
        const docs = stride([...comic.items.filter((item) => item.type === "document"), ...novel.items.filter((item) => item.type === "document" && !comic.items.some((c) => c.path === item.path))], 24);
        for (const item of docs) {
          const result = await suggestKind(item.path, { zips: media.zips, signal: AbortSignal.timeout(60_000) });
          bump(suggestions, `${path.extname(item.name).toLowerCase()}→${result.kind}/${result.basis}/${result.confidence}`);
        }

        // Video probes.
        const videoSummary: Record<string, unknown> = { available: media.ffmpeg.available };
        if (video.items.length && media.ffmpeg.available) {
          const codecs: Record<string, number> = {};
          const probeMs: number[] = [];
          let withSubtitles = 0;
          let withAttachments = 0;
          let multiAudio = 0;
          let failed = 0;
          for (const item of stride(video.items, 5)) {
            const started = performance.now();
            try {
              const probe = await media.ffmpeg.probe(item.path, { signal: AbortSignal.timeout(60_000) });
              probeMs.push(Math.round(performance.now() - started));
              const v = probe.streams.find((stream) => stream.type === "video");
              bump(codecs, `${probe.container}|${v?.codec}|${v?.profile ?? "-"}|${v?.bitDepth ?? "?"}bit|${v?.width}x${v?.height}|${probe.streams.filter((s) => s.type === "audio").map((s) => s.codec).join("+")}`);
              if (probe.streams.some((s) => s.type === "subtitle")) withSubtitles += 1;
              if (probe.streams.some((s) => s.type === "attachment")) withAttachments += 1;
              if (probe.streams.filter((s) => s.type === "audio").length > 1) multiAudio += 1;
            } catch { failed += 1; }
          }
          Object.assign(videoSummary, { probed: probeMs.length, failed, probeMs: spread(probeMs), formats: codecs, withSubtitles, withAttachments, multiAudio });
        }

        // Episode name parsing over every video file.
        const { parseOrdinalName } = await import("../../packages/app-core/src/domain/ordinal.ts");
        const parsed = { total: 0, withNumber: 0, types: {} as Record<string, number> };
        for (const item of video.items) {
          const result = parseOrdinalName(item.name.replace(/\.[^.]+$/, ""), "video");
          parsed.total += 1;
          if (result.number !== undefined) parsed.withNumber += 1;
          bump(parsed.types, result.type ?? "none");
        }

        (summary.roots as unknown[]).push({
          root: `root${index + 1}`,
          files: walkCount.files, dirs: walkCount.dirs, maxDepth: walkCount.maxDepth,
          extensions,
          planned, itemTypes,
          comicScan: { sampled, scanMs: spread(timings), pages: spread(pageCounts), unreadablePerItem: spread(unreadable), failures, warnings: warningKinds },
          suggestions,
          video: videoSummary,
          episodeNames: parsed,
          videoExtensionsKnown: [...VIDEO_EXTENSIONS].length,
        });
      }
      // End to end: import small real folders in place into a throwaway profile, then read pages through the media table.
      const imports: unknown[] = [];
      const ctx = await startApp();
      try {
        const candidates: Array<{ dir: string; kind: "comic" | "novel" }> = [];
        for (const root of ROOTS) {
          const walkDirs = (dir: string, depth: number) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (!entry.isDirectory() || depth > 4) continue;
              const full = path.join(dir, entry.name);
              const comic = planDirectory(full, "comic", { maxItems: 50, maxDepth: 4 });
              const novel = planDirectory(full, "novel", { maxItems: 50, maxDepth: 4 });
              if (comic.items.length >= 2 && comic.items.length <= 8 && !comic.truncated) candidates.push({ dir: full, kind: "comic" });
              else if (novel.items.length >= 2 && novel.items.length <= 8 && !novel.truncated) candidates.push({ dir: full, kind: "novel" });
              walkDirs(full, depth + 1);
            }
          };
          walkDirs(root, 0);
        }
        const chosen = [...stride(candidates.filter((c) => c.kind === "comic"), 3), ...stride(candidates.filter((c) => c.kind === "novel"), 2)];
        for (const [position, candidate] of chosen.entries()) {
          const started = performance.now();
          const result = await ctx.app.call(ctx.actor, { commandId: "works.importDirectory", idempotencyKey: `real-import-${position}`, input: { pathHandle: ctx.app.registerPath("directory", candidate.dir), kind: candidate.kind } }, ctx.grant.handle);
          const importMs = Math.round(performance.now() - started);
          const entry: Record<string, unknown> = { kind: candidate.kind, status: result.status, importMs, errorCode: result.error?.code };
          if (result.status === "ok") {
            const value = result.value as { workId: string; resources: Array<{ resourceId?: string; revisionId?: string; pages?: number; error?: { code: string }; unreadablePages?: number }> };
            entry.resources = value.resources.length;
            entry.failed = value.resources.filter((item) => item.error).length;
            entry.failureCodes = value.resources.filter((item) => item.error).map((item) => item.error!.code);
            if (candidate.kind === "comic") {
              const served: number[] = [];
              const kinds: Record<string, number> = {};
              for (const resource of value.resources.filter((item) => item.resourceId).slice(0, 3)) {
                const pages = await ctx.app.call(ctx.actor, { commandId: "comic.pages", idempotencyKey: `real-pages-${position}-${resource.resourceId}`, input: { resourceId: resource.resourceId } }, ctx.grant.handle);
                const manifest = pages.value as { pages: Array<{ id: string }>; revisionId: string };
                for (const pageId of stride(manifest.pages.map((page) => page.id), 3)) {
                  const t = performance.now();
                  const handle = await ctx.app.call(ctx.actor, { commandId: "comic.pageHandle", idempotencyKey: `real-h-${position}-${resource.resourceId}-${pageId}`, input: { resourceId: resource.resourceId, revisionId: manifest.revisionId, pageId } }, ctx.grant.handle);
                  const info = handle.value as { available: boolean; kind?: string; url?: string; mediaType?: string; reason?: string };
                  if (!info?.available) { bump(kinds, `unavailable:${String(info?.reason).slice(0, 40)}`); continue; }
                  bump(kinds, `${info.kind}:${info.mediaType}`);
                  if (info.kind === "image") {
                    const response = await serveMedia({ handles: ctx.app.media.handles, zips: ctx.app.media.zips }, { url: info.url!, method: "GET", headers: { get: (name) => (name.toLowerCase() === "range" ? "bytes=0-15" : null) } });
                    const bytes = Buffer.from(await response.arrayBuffer());
                    bump(kinds, `range:${response.status}:${bytes.length}`);
                  }
                  served.push(Math.round(performance.now() - t));
                }
              }
              entry.pageHandleMs = spread(served);
              entry.pageKinds = kinds;
            }
          }
          imports.push(entry);
        }
        (summary as Record<string, unknown>).imports = imports;
      } finally { ctx.app.close(); }
      const after = ROOTS.map((root) => fs.statSync(root).mtimeMs);
      expect(after, "the trial must not touch the sources").toEqual(before);
      const out = path.join(evidenceRunDir("m2", "real-samples"), "summary.json");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(summary, null, 2));
      console.log(JSON.stringify(summary, null, 1));
    } finally {
      media.dispose();
      fs.rmSync(cache, { recursive: true, force: true });
    }
  }, 900_000);
});
