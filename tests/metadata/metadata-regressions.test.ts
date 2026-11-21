import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { DrizzleStore } from "@manga/storage-drizzle";
import {
  BANGUMI_PAGE_HOSTS as CONTRACT_HOSTS,
  classifySearchInput as contractClassify,
  parseBangumiRef as contractParse,
} from "@manga/contracts/bangumi-ref";
import { MediaServices } from "../../packages/app-core/src/media/index.ts";
import { BangumiClient } from "../../packages/app-core/src/metadata/bangumi.ts";
import { CoverService } from "../../packages/app-core/src/metadata/covers.ts";
import { BANGUMI_PAGE_HOSTS, classifySearchInput, parseBangumiRef } from "../../packages/app-core/src/metadata/ref.ts";
import { MetadataService } from "../../packages/app-core/src/metadata/service.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-meta-reg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("metadata regressions", () => {
  it("metadata/ref.ts delegates identically to @manga/contracts/bangumi-ref", () => {
    expect(BANGUMI_PAGE_HOSTS).toBe(CONTRACT_HOSTS);
    expect(parseBangumiRef).toBe(contractParse);
    expect(classifySearchInput).toBe(contractClassify);
    expect(parseBangumiRef("https://bgm.tv/subject/12345")).toEqual({ ok: true, externalId: "12345", form: "url" });
    expect(classifySearchInput("12345")).toEqual({ type: "number", externalId: "12345", query: "12345" });
  });

  it("BangumiClient enforces concurrency cap via Lane, refuses non-GET/HEAD redirects & malformed Location, and maps body abort to CANCELLED", async () => {
    let active = 0;
    let maxActive = 0;
    const laneClient = new BangumiClient({
      userAgent: "manga-test/1.0",
      concurrency: 2,
      fetch: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return new Response(JSON.stringify({ id: 1, type: 2, name: "A" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await Promise.all([1, 2, 3, 4, 5].map((id) => laneClient.subject(id)));
    expect(maxActive).toBeLessThanOrEqual(2);

    // POST redirect must be refused (search uses POST).
    const postRedirect = new BangumiClient({
      userAgent: "manga-test/1.0",
      fetch: async () => new Response("", { status: 302, headers: { location: "https://api.bgm.tv/v0/search/subjects" } }),
    });
    await expect(postRedirect.search({ keyword: "test" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Malformed Location header produces typed FORBIDDEN, not uncaught TypeError.
    const badLocation = new BangumiClient({
      userAgent: "manga-test/1.0",
      fetch: async () => new Response("", { status: 302, headers: { location: "http://[::1" } }),
    });
    await expect(badLocation.subject(1)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Abort mid-body stream maps to CANCELLED.
    const ac = new AbortController();
    const abortClient = new BangumiClient({
      userAgent: "manga-test/1.0",
      fetch: async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([123]));
            ac.abort();
          },
          pull() {
            return new Promise<void>(() => undefined);
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    await expect(abortClient.subject(1, ac.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("CoverService promotes cache cover to durable images on hash match, resets locked cover_state when missing cache cover is forgotten, and MetadataService.related tolerates malformed projection JSON", async () => {
    const dir = path.join(root, "covers-and-related");
    const store = new DrizzleStore({ profileDir: path.join(dir, "data"), hostId: "meta-covers", attachmentsDir: path.join(dir, "att") });
    const media = new MediaServices({ cacheDir: path.join(dir, "cache"), tools: null });
    try {
      const now = new Date().toISOString();
      const workId = "wrk_cover_1";
      store.commit({
        mutations: [{ sql: "INSERT INTO works(id, title, media_kind, created_at, updated_at) VALUES (?,?,?,?,?)", params: [workId, "CoverTest", "comic", now, now] }],
        events: [],
      });

      const covers = new CoverService(store, media);
      const png = await sharp({ create: { width: 120, height: 160, channels: 3, background: { r: 80, g: 120, b: 200 } } }).png().toBuffer();

      // 1) Store as file cache cover first, then store identical bytes as durable user cover -> must promote area='images' and insert into images table.
      const first = await covers.add(workId, { bytes: png, source: "file" });
      expect((store.sqlite.prepare("SELECT area FROM covers WHERE id = ?").get(first.cover.id) as { area: string }).area).toBe("cache");

      const promoted = await covers.add(workId, { bytes: png, source: "user" });
      expect(promoted.cover.id).toBe(first.cover.id);
      const row = store.sqlite.prepare("SELECT area, source, image_hash FROM covers WHERE id = ?").get(promoted.cover.id) as { area: string; source: string; image_hash: string | null };
      expect(row.area).toBe("images");
      expect(row.source).toBe("user");
      expect(row.image_hash).toBeTruthy();
      expect(covers.images.has(row.image_hash!)).toBe(true);

      // 2) Locked cache cover whose cache file disappeared -> forgetMissingCacheCovers nulls cover_id AND resets cover_state to 'auto'.
      const workId2 = "wrk_cover_2";
      store.commit({
        mutations: [{ sql: "INSERT INTO works(id, title, media_kind, created_at, updated_at) VALUES (?,?,?,?,?)", params: [workId2, "LockedCache", "comic", now, now] }],
        events: [],
      });
      const cached = await covers.add(workId2, { bytes: png, source: "file" });
      store.sqlite.prepare("UPDATE works SET cover_id = ?, cover_state = 'locked' WHERE id = ?").run(cached.cover.id, workId2);
      const fileName = (store.sqlite.prepare("SELECT file_name FROM covers WHERE id = ?").get(cached.cover.id) as { file_name: string }).file_name;
      fs.rmSync(path.join(media.dir("covers"), fileName), { force: true });

      covers.forgetMissingCacheCovers(workId2);
      const work2 = store.sqlite.prepare("SELECT cover_id, cover_state FROM works WHERE id = ?").get(workId2) as { cover_id: string | null; cover_state: string };
      expect(work2).toEqual({ cover_id: null, cover_state: "auto" });

      // 3) Malformed projection_json on works in related() does not crash with SyntaxError.
      store.sqlite.prepare("INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json, fetched_at, detached) VALUES (?,?,?,?,?,0)")
        .run(workId, "bangumi", "99", JSON.stringify({ version: 1, fields: {}, related: [{ externalId: "100", title: "Seq", relation: "续集", subjectType: 1 }], episodes: [] }), now);
      store.sqlite.prepare("INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at, namespace, subject_type, link_state, match_basis) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(workId2, "bangumi", "100", "{}", now, "bangumi:subject", 1, "linked", "manual");
      store.sqlite.prepare("UPDATE works SET projection_json = ? WHERE id = ?")
        .run("{corrupt-json", workId);

      const meta = new MetadataService({ store, media, covers, providers: [] });
      const rel = meta.related(workId) as { relations: Array<{ inLibraryWorkId: string | null }> };
      expect(rel.relations).toHaveLength(1);
      expect(rel.relations[0]!.inLibraryWorkId).toBe(workId2);
    } finally {
      media.dispose();
      store.close();
    }
  });
});
