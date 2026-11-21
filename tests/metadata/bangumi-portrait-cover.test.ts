import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { picture, startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { seedVideo } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>) {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `bgm-portrait-${counter}`, input }, ctx.grant.handle);
}

const ok = <T = Record<string, unknown>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

let fake: FakeBangumi;

beforeAll(async () => {
  fake = await startFakeBangumi();
});

afterAll(async () => {
  if (fake) await fake.stop();
});

describe("Bangumi synced vertical cover & thumbnail dimensions for anime works", () => {
  it("replaces horizontal video frame with vertical Bangumi cover, preserves portrait width/height across thumbnail cache hits, and updates on re-match", async () => {
    fake.reset();
    fake.images.set("anime-201.png", { bytes: await picture("blue", [300, 420]), mediaType: "image/png" });
    fake.images.set("anime-202.png", { bytes: await picture("gold", [250, 350]), mediaType: "image/png" });
    fake.subject(201, { type: 2, name: "Anime One", name_cn: "测试番剧一", imageName: "anime-201.png" });
    fake.subject(202, { type: 2, name: "Anime Two", name_cn: "测试番剧二", imageName: "anime-202.png" });

    const ctx = await startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
    try {
      const dummyVideo = path.join(ctx.profileRoot, "ep01.mp4");
      fs.writeFileSync(dummyVideo, "synthetic");
      const seeded = seedVideo(ctx.app, { title: "测试番剧", file: dummyVideo });

      // Simulate initial horizontal 16:9 video frame cover extracted from video file.
      const frameBytes = await picture("red", [640, 360]);
      const fileCover = await ctx.app.covers.add(seeded.workId, { bytes: frameBytes, source: "file", select: "auto" });
      expect(fileCover.selected).toBe(true);
      expect(fileCover.cover.width).toBe(640);
      expect(fileCover.cover.height).toBe(360);

      // Link to Bangumi 201 (vertical 300x420 poster): vertical Bangumi cover becomes active cover.
      const linked = ok<{ cover: { coverId: string; selected: boolean } }>(await run(ctx, "metadata.link", {
        workId: seeded.workId,
        providerId: "bangumi",
        externalId: "201",
      }));
      expect(linked.cover.selected).toBe(true);

      // Late background video frame extraction must NOT override the synced vertical Bangumi cover.
      const lateFrame = await ctx.app.covers.add(seeded.workId, { bytes: await picture("green", [640, 360]), source: "file", select: "auto" });
      expect(lateFrame.selected).toBe(false);

      const coversAfterFirst = ok<{ coverId: string; covers: Array<{ id: string; source: string; width: number; height: number; selected: boolean }> }>(
        await run(ctx, "covers.list", { workId: seeded.workId }),
      );
      expect(coversAfterFirst.coverId).toBe(linked.cover.coverId);
      const selectedFirst = coversAfterFirst.covers.find((c) => c.selected)!;
      expect(selectedFirst).toMatchObject({ id: linked.cover.coverId, source: "bangumi", width: 300, height: 420 });

      // First call generates the grid thumbnail; second call hits ThumbnailCache on disk — both must report portrait width < height > 0!
      const coldHandles = ok<{ covers: Array<{ coverId: string; available: boolean; width?: number; height?: number }> }>(
        await run(ctx, "covers.handles", { coverIds: [linked.cover.coverId], size: "grid" }),
      );
      expect(coldHandles.covers[0]).toMatchObject({ coverId: linked.cover.coverId, available: true, width: 257, height: 360 });
      expect(coldHandles.covers[0]!.height!).toBeGreaterThan(coldHandles.covers[0]!.width!);

      const warmHandles = ok<{ covers: Array<{ coverId: string; available: boolean; width?: number; height?: number }> }>(
        await run(ctx, "covers.handles", { coverIds: [linked.cover.coverId], size: "grid" }),
      );
      expect(warmHandles.covers[0]).toMatchObject({ coverId: linked.cover.coverId, available: true, width: 257, height: 360 });

      // Previewing and re-matching to another Bangumi entry (202, vertical 250x350) replaces the old Bangumi cover automatically.
      const preview = ok<{ cover: { willReplace: boolean; protected: boolean } }>(
        await run(ctx, "metadata.preview", { workId: seeded.workId, externalId: "202" }),
      );
      expect(preview.cover).toMatchObject({ protected: false, willReplace: true });

      const relinked = ok<{ cover: { coverId: string; selected: boolean } }>(await run(ctx, "metadata.link", {
        workId: seeded.workId,
        providerId: "bangumi",
        externalId: "202",
      }));
      expect(relinked.cover.selected).toBe(true);
      expect(relinked.cover.coverId).not.toBe(linked.cover.coverId);

      const detailHandles = ok<{ covers: Array<{ coverId: string; available: boolean; width?: number; height?: number }> }>(
        await run(ctx, "covers.handles", { coverIds: [relinked.cover.coverId], size: "detail" }),
      );
      expect(detailHandles.covers[0]).toMatchObject({ coverId: relinked.cover.coverId, available: true, width: 250, height: 350 });
    } finally {
      ctx.app.close();
    }
  });
});
