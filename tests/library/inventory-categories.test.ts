import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown> = {}) {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `inv-${counter}`, input }, ctx.grant.handle);
}
type Item = Record<string, any>;
async function overview(ctx: App) {
  const result = await run(ctx, "inventory.overview");
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as { items: Item[]; totals: Record<string, any> };
}
const category = (view: { items: Item[] }, id: string) => view.items.find((item) => item.id === `category:${id}`)!;

/** A profile holding one of everything M2 stores: hosted and indexed media, kept and cleaned recordings, covers, a playback copy. */
function seed(ctx: App) {
  const db = ctx.app.store.sqlite;
  const attachments = ctx.app.store.attachmentsDir;
  fs.mkdirSync(attachments, { recursive: true });
  const now = "2026-10-01T08:00:00.000Z";
  const comic = seedComic(ctx.app, { title: "合成漫画" });
  const video = seedVideo(ctx.app, { title: "合成动画" });
  const indexedVideo = seedVideo(ctx.app, { title: "原位置动画", workId: video.workId });

  // The comic is hosted (a file MANGA stores); the first video is hosted too, the second stays where the user keeps it.
  const hostedComic = path.join(attachments, `${comic.revisionId}.bin`);
  fs.writeFileSync(hostedComic, Buffer.alloc(3000, 1));
  db.prepare("INSERT INTO file_locations(id, resource_revision_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,?)").run("loc-c", comic.revisionId, hostedComic, "f1", 1, 1);
  const hostedVideo = path.join(attachments, `${video.revisionId}.bin`);
  fs.writeFileSync(hostedVideo, Buffer.alloc(5000, 2));
  db.prepare("INSERT INTO file_locations(id, resource_revision_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,?)").run("loc-v", video.revisionId, hostedVideo, "f2", 1, 1);
  db.prepare("INSERT INTO file_locations(id, resource_revision_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,?)").run("loc-i", indexedVideo.revisionId, path.join(attachments, "..", "not-managed", "episode.mkv"), "f3", 1, 0);

  // Two recordings: one kept as audio, one whose audio the user chose not to keep.
  fs.writeFileSync(path.join(attachments, "cap-kept.opus"), Buffer.alloc(700, 3));
  const insertCapture = (id: string, opus: string | null, audioState: string, createdAt: string) => db.prepare("INSERT INTO capture_sessions(id, clock_json, status, attachment_id, created_at, mode, retention, audio_state, stage, duration_ms, stopped_at, staging_name, opus_name, device_label, work_id, vad_json, error_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, '{"domainId":"d","startedAtMs":0,"sampleRate":16000}', "saved", opus, createdAt, "toggle", opus ? "keep" : "discard", audioState, "done", 65_000, createdAt, null, opus, "合成麦克风", video.workId, "{}", null, createdAt);
  insertCapture("cap-kept", "cap-kept.opus", "retained", "2026-10-02T09:00:00.000Z");
  insertCapture("cap-cleaned", null, "cleaned", "2026-10-01T09:00:00.000Z");

  // One cover stored in attachments, one extracted into the cache.
  fs.writeFileSync(path.join(attachments, "cover-a.jpg"), Buffer.alloc(400, 4));
  const insertCover = (id: string, area: string, file: string, bytes: number) => db.prepare("INSERT INTO covers(id, work_id, source, provider_id, external_id, content_hash, media_type, width, height, bytes, area, file_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, comic.workId, area === "attachments" ? "user" : "file", null, null, id.padEnd(64, "0"), "image/jpeg", 10, 10, bytes, area, file, now);
  insertCover("cov-a", "attachments", "cover-a.jpg", 400);
  insertCover("cov-b", "cache", "cover-b.jpg", 250);

  db.prepare("INSERT INTO play_copies(id, resource_revision_id, reason, state, audio_stream_index, file_name, bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("pc-1", video.revisionId, "hevc", "ready", null, "pc-1.mp4", 9000, now, now);

  fs.writeFileSync(path.join(attachments, "stray-note.txt"), "x");
  return { comic, video, indexedVideo, attachments };
}

describe("resource overview categories for media (LIB-04)", () => {
  it("counts comics, videos, recordings, covers and playback copies, with the space each holds", async () => {
    const ctx = await boot();
    seed(ctx);
    const view = await overview(ctx);
    expect(view.totals.comic).toMatchObject({ count: 1, bytes: 3000, hosted: 1, missing: 0 });
    expect(view.totals.video).toMatchObject({ count: 2, bytes: 5000, hosted: 1 });
    expect(view.totals.recording).toMatchObject({ count: 2, bytes: 700, missing: 0 });
    expect(view.totals.cover).toMatchObject({ count: 2, bytes: 650 });
    expect(view.totals.playCopy).toMatchObject({ count: 1, bytes: 9000 });
    // Resources keep their own total and the rest of the existing totals are still there.
    expect(view.totals.resource.count).toBe(3);
    expect(Object.keys(view.totals)).toEqual(expect.arrayContaining(["note", "attachment", "backup", "cache", "indexedRoot"]));

    expect(category(view, "comic")).toMatchObject({ kind: "media-category", count: 1, bytes: 3000, status: "ready", moduleEnabled: true, indexed: false });
    expect(category(view, "video")).toMatchObject({ count: 2, indexed: true });
    expect(category(view, "recording")).toMatchObject({ count: 2, bytes: 700 });
    expect(category(view, "cover")).toMatchObject({ count: 2, bytes: 650 });
    expect(category(view, "playCopy")).toMatchObject({ count: 1, bytes: 9000 });
  });

  it("lists each recording with its length and whether its audio was kept, and does not repeat media files as loose attachments", async () => {
    const ctx = await boot();
    seed(ctx);
    const view = await overview(ctx);
    const kept = view.items.find((item) => item.id === "capture:cap-kept")!;
    const cleaned = view.items.find((item) => item.id === "capture:cap-cleaned")!;
    expect(kept).toMatchObject({ kind: "recording", bytes: 700, durationMs: 65_000, status: "ready", revealable: true });
    expect(kept.title).toContain("合成动画");
    // Not keeping the audio is the user's choice, not a fault: nothing is missing and there is nothing to reveal.
    expect(cleaned).toMatchObject({ kind: "recording", bytes: 0, status: "cleaned", available: true, revealable: false });

    const attachmentTitles = view.items.filter((item) => item.kind === "attachment").map((item) => item.title);
    expect(attachmentTitles).toEqual(["stray-note.txt"]);
    // The flat total still counts every file so the number matches the folder.
    expect(view.totals.attachment.count).toBe(5);
  });

  it("keeps the numbers and the entry for a switched-off module, marked as such", async () => {
    const ctx = await boot();
    seed(ctx);
    for (const featureId of ["comic", "video", "voice", "metadata"]) {
      const off = await run(ctx, "settings.setModule", { featureId, enabled: false });
      expect(off.status).toBe("ok");
    }
    const view = await overview(ctx);
    for (const id of ["comic", "video", "recording", "cover", "playCopy"]) expect(category(view, id), id).toMatchObject({ status: "disabled", moduleEnabled: false });
    expect(category(view, "comic").count).toBe(1);
    expect(category(view, "recording").bytes).toBe(700);
    expect(view.items.find((item) => item.id === "capture:cap-kept")).toMatchObject({ status: "disabled", moduleEnabled: false });
    // The data is still reachable: a recording's location can be revealed while the voice module is off.
    const reveal = await run(ctx, "inventory.reveal", { id: "capture:cap-kept" });
    expect(reveal.status, JSON.stringify(reveal)).toBe("ok");
    expect((reveal.value as { path: string }).path.endsWith("cap-kept.opus")).toBe(true);
  });

  it("reports hosted media or recordings whose file is gone as missing instead of counting them as present", async () => {
    const ctx = await boot();
    const seeded = seed(ctx);
    fs.rmSync(path.join(seeded.attachments, `${seeded.comic.revisionId}.bin`));
    fs.rmSync(path.join(seeded.attachments, "cap-kept.opus"));
    const view = await overview(ctx);
    expect(category(view, "comic")).toMatchObject({ status: "missing", available: false, missing: 1, bytes: 0 });
    expect(category(view, "recording")).toMatchObject({ status: "missing", missing: 1, bytes: 0 });
    expect(view.items.find((item) => item.id === "capture:cap-kept")).toMatchObject({ status: "missing", available: false });
    expect(category(view, "video").status).toBe("ready");
  });

  it("an empty profile shows every category with zero, not a missing one", async () => {
    const ctx = await boot();
    const view = await overview(ctx);
    for (const id of ["comic", "video", "recording", "cover", "playCopy"]) expect(category(view, id), id).toMatchObject({ count: 0, bytes: 0, status: "ready" });
  });
});
