import { afterEach, describe, expect, it } from "vitest";
import type { SearchHit } from "@manga/contracts";
import { startApp } from "../helpers/app.ts";
import { ok, run } from "../helpers/creative-project.ts";

/** The search box's body search in a medium's scope (计划 4.8, AT-128) and in the library paths only (A-113). Synthetic texts only. */
type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

describe("library.find in a medium's scope", () => {
  it("keeps the hits of that medium's resources, leaves every hit to 全部, and never lists a resource outside the library paths", async () => {
    const ctx = await startApp();
    apps.push(ctx);
    const sqlite = ctx.app.store.sqlite;
    const novel = ok<{ workId: string; resourceId: string }>(await run(ctx, "library.importText", { title: "雨夜小说", bytes: [...Buffer.from("灯塔下的雨夜，一个人在等船。")] }));
    const comic = ok<{ workId: string; resourceId: string }>(await run(ctx, "library.importText", { title: "雨夜漫画", bytes: [...Buffer.from("灯塔边的雨夜，两个人在说话。")] }));
    sqlite.prepare("UPDATE works SET media_kind = 'comic' WHERE id = ?").run(comic.workId);
    ok(await run(ctx, "notes.create", { title: "灯塔笔记", text: "关于灯塔的一条笔记。" }));
    const find = async (input: Record<string, unknown>) => ok<SearchHit[]>(await run(ctx, "library.find", { text: "灯塔", ...input }));

    const all = await find({});
    expect(new Set(all.flatMap((hit) => (hit.resourceId ? [hit.resourceId] : [])))).toEqual(new Set([novel.resourceId, comic.resourceId]));
    expect(all.some((hit) => hit.objectId)).toBe(true);
    const novels = await find({ mediaKind: "novel" });
    expect(novels.length).toBeGreaterThan(0);
    expect(novels.every((hit) => hit.resourceId === novel.resourceId)).toBe(true);
    expect((await find({ mediaKind: "comic" })).every((hit) => hit.resourceId === comic.resourceId)).toBe(true);
    expect(await find({ mediaKind: "video" })).toEqual([]);
    expect((await run(ctx, "library.find", { text: "灯塔", mediaKind: "note" })).status).toBe("error");

    // A resource whose file is under no library path is not a hit.
    const revision = (sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ?").get(comic.resourceId) as { id: string }).id;
    sqlite.prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted, legacy_path) VALUES (?,?,NULL,?,?,0,0,?)")
      .run("loc-out", revision, "x.txt", "f".repeat(64), "/gone/x.txt");
    expect((await find({})).some((hit) => hit.resourceId === comic.resourceId)).toBe(false);
  });
});
