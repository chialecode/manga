import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGE_ATTACHMENT_PREFIX, exportLibraryPackage, exportLibraryPackageCancellable, importLibraryPackageResolved, previewLibraryPackage } from "../../packages/app-core/src/domain/library-package.ts";
import { startApp, tempProfile } from "../helpers/app.ts";
import { picture, startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { seedComic } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;
const call = async (ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> => {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `pkg2-${counter}`, input }, ctx.grant.handle);
};
const ok = <T = Record<string, any>>(result: Call): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};
const count = (ctx: App, table: string) => (ctx.app.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

let fake: FakeBangumi;
beforeAll(async () => { fake = await startFakeBangumi(); });
afterAll(async () => { await fake.stop(); });

/** A linked comic with a downloaded cover, a cover the user chose, and characters and staff with small pictures. */
async function seedLinked(ctx: App) {
  fake.reset();
  await fake.addImage("cover.png", "red", [300, 450]);
  fake.subject(101, { type: 1, platform: "漫画", name: "Synthetic Series", name_cn: "合成系列", imageName: "cover.png", volumes: 3, eps: 0, total_episodes: 0 });
  fake.character(101, 1);
  fake.character(101, 2, { images: null });
  fake.person(101, 11);
  await fake.addAvatars();
  const comic = seedComic(ctx.app, { title: "包里的漫画", pageCount: 2 });
  ctx.app.metadata.reproject(comic.workId);
  ok(await call(ctx, "metadata.link", { workId: comic.workId, providerId: "bangumi", externalId: "101" }));
  const mine = await ctx.app.covers.add(comic.workId, { bytes: await picture("gold", [200, 300]), source: "user", select: "user" });
  return { comic, mineId: mine.cover.id };
}

describe("a library package with covers and credits in the images table", () => {
  it("carries each picture once, by content, and restores them into an empty profile", async () => {
    fake.reset();
    const source = await startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
    const target = await startApp();
    try {
      const { comic, mineId } = await seedLinked(source);
      const dir = path.join(tempProfile(), "pkg");
      const manifest = exportLibraryPackage(source.app.store, dir);
      // Two covers (downloaded, chosen) and the small pictures: the identical avatars are one attachment.
      expect(manifest.covers!.map((item) => item.area)).toEqual(["images", "images"]);
      const pictures = manifest.attachments.filter((item) => item.id.startsWith(IMAGE_ATTACHMENT_PREFIX));
      expect(pictures).toHaveLength(3);
      for (const item of pictures) expect(createHash("sha256").update(fs.readFileSync(path.join(dir, item.relativePath))).digest("hex")).toBe(item.hash);
      expect(manifest.characters!.map((item) => [item.character_id, item.image !== null && item.image !== undefined])).toEqual([["1", true], ["2", false]]);
      expect(manifest.persons!.map((item) => [item.person_id, Boolean(item.image)])).toEqual([["11", true]]);
      // Picture bytes travel as files next to the manifest, never inside it.
      expect(JSON.stringify(manifest)).not.toContain('"payload":');

      expect(previewLibraryPackage(target.app.store, dir).empty).toBe(true);
      importLibraryPackageResolved(target.app.store, dir, { strategy: "replace" });
      expect(count(target, "images")).toBe(count(source, "images"));
      expect(count(target, "covers")).toBe(2);
      expect(count(target, "subject_characters")).toBe(2);
      expect(count(target, "subject_persons")).toBe(1);
      const restored = target.app.store.sqlite.prepare("SELECT cover_id, cover_state FROM works WHERE id = ?").get(comic.workId) as { cover_id: string; cover_state: string };
      expect(restored).toEqual({ cover_id: mineId, cover_state: "user" });
      // The bytes that come back are the bytes that went in (a picture stored as text would still be counted as a row).
      for (const row of source.app.store.sqlite.prepare("SELECT hash, payload FROM images").all() as Array<{ hash: string; payload: Buffer }>) {
        const back = target.app.store.sqlite.prepare("SELECT payload, bytes FROM images WHERE hash = ?").get(row.hash) as { payload: Buffer; bytes: number };
        expect(Buffer.isBuffer(back.payload), row.hash).toBe(true);
        expect(back.payload.equals(row.payload), row.hash).toBe(true);
        expect(back.bytes).toBe(row.payload.length);
        expect(createHash("sha256").update(back.payload).digest("hex")).toBe(row.hash);
      }
      // Pictures are in the table, not left behind as files, and the lists read them back.
      expect(fs.readdirSync(target.app.store.attachmentsDir).filter((name) => name.startsWith(IMAGE_ATTACHMENT_PREFIX))).toEqual([]);
      const shown = ok<{ characters: Array<{ id: string; avatar: { url: string } | null }>; persons: Array<{ avatar: { url: string } | null }> }>(await call(target, "metadata.characters", { workId: comic.workId }));
      expect(shown.characters.map((item) => item.avatar !== null)).toEqual([true, false]);
      expect(shown.persons[0]!.avatar).not.toBeNull();
      expect(target.app.store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(target.app.store.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally { source.app.close(); target.app.close(); }
  });

  it("leaves cover originals out when asked, and the package still restores", async () => {
    fake.reset();
    const source = await startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
    const target = await startApp();
    try {
      const { comic } = await seedLinked(source);
      const dir = path.join(tempProfile(), "pkg");
      const manifest = exportLibraryPackage(source.app.store, dir, { includeCovers: false });
      expect(manifest.covers).toEqual([]);
      // The small pictures of characters are part of the credits, not of the covers.
      expect(manifest.attachments.filter((item) => item.id.startsWith(IMAGE_ATTACHMENT_PREFIX))).toHaveLength(1);
      importLibraryPackageResolved(target.app.store, dir, { strategy: "replace" });
      expect(count(target, "covers")).toBe(0);
      expect(count(target, "subject_characters")).toBe(2);
      expect(target.app.store.sqlite.prepare("SELECT cover_id FROM works WHERE id = ?").get(comic.workId)).toEqual({ cover_id: null });
    } finally { source.app.close(); target.app.close(); }
  });

  it("refuses a picture whose bytes do not match the manifest", async () => {
    fake.reset();
    const source = await startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
    const target = await startApp();
    try {
      await seedLinked(source);
      const dir = path.join(tempProfile(), "pkg");
      const manifest = exportLibraryPackage(source.app.store, dir);
      const victim = manifest.attachments.find((item) => item.id.startsWith(IMAGE_ATTACHMENT_PREFIX))!;
      fs.appendFileSync(path.join(dir, victim.relativePath), "tampered");
      expect(() => importLibraryPackageResolved(target.app.store, dir, { strategy: "replace" })).toThrow();
      expect(count(target, "works")).toBe(0);
      expect(count(target, "images")).toBe(0);
    } finally { source.app.close(); target.app.close(); }
  });
});

describe("an export that can be stopped", () => {
  it("leaves nothing behind when it is cancelled between files, and keeps a folder that was already there", async () => {
    fake.reset();
    const ctx = await startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
    try {
      await seedLinked(ctx);
      const controller = new AbortController();
      const fresh = path.join(tempProfile(), "pkg-cancel");
      const pending = exportLibraryPackageCancellable(ctx.app.store, fresh, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
      expect(fs.existsSync(fresh)).toBe(false);

      // A folder the user picked that already exists is emptied of what the export wrote, not removed.
      const existing = path.join(tempProfile(), "pkg-existing");
      fs.mkdirSync(existing);
      const second = new AbortController();
      const again = exportLibraryPackageCancellable(ctx.app.store, existing, { signal: second.signal });
      second.abort();
      await expect(again).rejects.toMatchObject({ code: "CANCELLED" });
      expect(fs.existsSync(existing)).toBe(true);
      expect(fs.readdirSync(existing)).toEqual([]);

      // Not cancelled, it is the same package as the synchronous export.
      const done = path.join(tempProfile(), "pkg-done");
      const manifest = await exportLibraryPackageCancellable(ctx.app.store, done, {});
      expect(fs.existsSync(path.join(done, "manifest.json"))).toBe(true);
      expect(manifest.works).toHaveLength(1);
    } finally { ctx.app.close(); }
  });

  it("is cancelled through the command, once at a time, and reports a second export that starts while one runs", async () => {
    fake.reset();
    const ctx = await startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
    try {
      await seedLinked(ctx);
      const dir = path.join(tempProfile(), "pkg-cmd");
      const first = call(ctx, "library.exportPackage", { pathHandle: ctx.app.registerPath("export", dir), includeCovers: true });
      // The export yields between files, so these run while it is in progress.
      const second = await call(ctx, "library.exportPackage", { pathHandle: ctx.app.registerPath("export", path.join(tempProfile(), "pkg-second")) });
      expect(second.status).toBe("error");
      expect((second.error?.details as { reason?: string }).reason).toBe("busy");
      const cancelled = ok<{ cancelled: boolean }>(await call(ctx, "library.cancelExport", {}));
      expect(cancelled.cancelled).toBe(true);
      const result = await first;
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("CANCELLED");
      expect(fs.existsSync(dir)).toBe(false);
      // With nothing running, cancelling is harmless.
      expect(ok<{ cancelled: boolean }>(await call(ctx, "library.cancelExport", {})).cancelled).toBe(false);
      // The next export runs normally, covers included by default.
      const again = await call(ctx, "library.exportPackage", { pathHandle: ctx.app.registerPath("export", dir) });
      expect(again.status).toBe("ok");
      expect(fs.readdirSync(path.join(dir, "attachments")).some((name) => name.startsWith(IMAGE_ATTACHMENT_PREFIX))).toBe(true);
    } finally { ctx.app.close(); }
  });
});
