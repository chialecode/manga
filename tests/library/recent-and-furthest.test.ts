import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NORMALIZATION_V1, createId } from "@manga/contracts";
import { libraryRoot, startApp } from "../helpers/app.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

/**
 * Removing an item from "最近" (`recent_dismissals`, A-129, AT-173, 计划 4.10) and library furthest progress (`progress_furthest`):
 * - Dismissing a work or standalone resource hides it from "最近" only, keeping progress, notes, bookmarks, screenshots, recordings, conversations, library shelves and projects intact.
 * - Undo restores the exact prior state.
 * - Reading or opening in a project does not bring a dismissed item back to "最近"; opening or reading in "最近" brings it back and resumes "最近"'s own position.
 * - Deleting a work or resource cleans up its `recent_dismissals` row.
 * - Library cards, sort-by-progress and work homepages report `progress_furthest` (completed anywhere counts as completed) and list per-context positions, while `progress_latest` keeps tracking the most recent action.
 */

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let seq = 0;
const apps: App[] = [];

afterEach(() => {
  while (apps.length) apps.pop()!.app.close();
});

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}

async function run(
  ctx: App,
  commandId: string,
  input: Record<string, unknown>,
  actor: { kind: "user" | "agent"; id: string } = ctx.actor,
  grantHandle = ctx.grant.handle,
  idempotencyKey = `rf-${++seq}`,
): Promise<Call> {
  return ctx.app.call(actor, { commandId, idempotencyKey, input }, grantHandle);
}

function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}

function ensureLibRoot(ctx: App): { id: string; path: string } {
  const dir = path.join(ctx.profileRoot, "lib");
  fs.mkdirSync(dir, { recursive: true });
  libraryRoot(ctx.app, dir, "comic");
  return ctx.app.store.sqlite.prepare("SELECT id, path FROM library_paths WHERE managed = 0 LIMIT 1").get() as { id: string; path: string };
}

function seedOpenableComic(ctx: App, title: string, pageCount = 10, extra: { workId?: string; ordinal?: { label?: string; number?: number; type?: string } } = {}) {
  const row = ensureLibRoot(ctx);
  const folder = path.join(row.path, `${title}_${createId("dir")}`);
  fs.mkdirSync(folder, { recursive: true });
  const seeded = seedComic(ctx.app, { title, pageCount, ...extra });
  ctx.app.store.sqlite
    .prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,1,0)")
    .run(createId("loc"), seeded.revisionId, row.id, path.relative(row.path, folder).split(path.sep).join("/"), createId("fp"));
  return seeded;
}

function seedStandaloneVideo(ctx: App, title: string, durationMs = 1_200_000) {
  const row = ensureLibRoot(ctx);
  const filePath = path.join(row.path, `${title}.mp4`);
  fs.writeFileSync(filePath, "synthetic-video");
  const seeded = seedVideo(ctx.app, { title, durationMs, file: filePath });
  // Detach from its auto-created work so this resource is a standalone unassigned video (`work_id IS NULL`).
  ctx.app.store.sqlite.prepare("UPDATE resources SET work_id = NULL WHERE id = ?").run(seeded.resourceId);
  ctx.app.store.sqlite.prepare("DELETE FROM works WHERE id = ?").run(seeded.workId);
  return { resourceId: seeded.resourceId, revisionId: seeded.revisionId, durationMs, filePath };
}

const recentKeys = async (ctx: App, view: "home" | "comic" | "video" | "novel") => {
  const res = ok<{ groups: Array<{ kind: string; sections: Array<{ items: Array<{ key: string; title: string }> }> }> }>(
    await run(ctx, "workspace.sidebar", { view, perGroup: 20 }),
  );
  const recent = res.groups.find((g) => g.kind === "recent");
  return (recent?.sections ?? []).flatMap((s) => s.items.map((item) => item.key));
};

const projectKeys = async (ctx: App, projectId: string, view: "home" | "comic" | "video") => {
  const res = ok<{ groups: Array<{ contextId: string | null; sections: Array<{ items: Array<{ key: string }> }> }> }>(
    await run(ctx, "workspace.sidebar", { view, perGroup: 20, open: [projectId] }),
  );
  const group = res.groups.find((g) => g.contextId === projectId);
  return (group?.sections ?? []).flatMap((s) => s.items.map((item) => item.key));
};

describe("dismissing items from 最近 (A-129, AT-173)", () => {
  it("hides a work and a standalone resource from 最近 without touching progress, notes, bookmarks, screenshots, recordings, conversations, projects or shelves, and supports undo", async () => {
    const ctx = await boot();
    const comic = seedOpenableComic(ctx, "可移除漫画", 10);
    const soloVideo = seedStandaloneVideo(ctx, "独立短片");
    const projectA = ok<{ id: string }>(await run(ctx, "project.create", { name: "项目 A" })).id;

    // Open & read in "最近" and in "项目 A".
    ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[7], consumed: true }));
    ok(await run(ctx, "progress.setPage", { contextId: projectA, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[2], consumed: true }));
    ok(await run(ctx, "progress.setTime", { contextId: null, resourceId: soloVideo.resourceId, resourceRevisionId: soloVideo.revisionId, timeMs: 180_000, played: [{ startMs: 0, endMs: 180_000 }] }));
    ok(await run(ctx, "project.addMaterial", { projectId: projectA, kind: "work", targetId: comic.workId }));

    // Attach user content: note, bookmark, screenshot row, recording session row, and resource conversation.
    const note = ok<{ objectId: string }>(await run(ctx, "notes.create", {
      title: "漫画笔记",
      text: "保留的笔记正文",
      resourceId: comic.resourceId,
      resourceRevisionId: comic.revisionId,
      locator: { kind: "image", pageId: comic.pageIds[7] },
    }));
    ok(await run(ctx, "reading.setBookmark", {
      resourceId: comic.resourceId,
      resourceRevisionId: comic.revisionId,
      label: "第八页书签",
      locator: { kind: "image", pageId: comic.pageIds[7] },
    }));
    const session = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId, contextId: null }));
    const now = new Date().toISOString();
    ctx.app.store.sqlite.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, live_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("run_keep_1", session.id, "succeeded", "g", "{}", "问一句", "答一句", now, now);
    ctx.app.store.sqlite.prepare("INSERT INTO screenshots(id, file_id, resource_id, resource_revision_id, work_id, media_kind, page_id, width, height, format, captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("shot_keep_1", "wf_shot_1", comic.resourceId, comic.revisionId, comic.workId, "comic", comic.pageIds[7], 800, 1200, "png", now);
    ctx.app.store.sqlite.prepare("INSERT INTO capture_sessions(id, clock_json, status, work_id, mode, retention, stage, audio_state, duration_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("cap_keep_1", "{}", "stopped", comic.workId, "toggle", "keep", "done", "cleaned", 5000, now, now);
    ctx.app.store.sqlite.prepare("INSERT INTO capture_events(session_id, payload_json, offset_ms, reason, resource_id, resource_revision_id) VALUES (?,?,?,?,?,?)")
      .run("cap_keep_1", "{}", 0, "start", comic.resourceId, comic.revisionId);

    expect(await recentKeys(ctx, "comic")).toContain(`work:${comic.workId}`);
    expect(await recentKeys(ctx, "video")).toContain(`resource:${soloVideo.resourceId}`);
    expect(await recentKeys(ctx, "home")).toEqual(expect.arrayContaining([`work:${comic.workId}`, `resource:${soloVideo.resourceId}`, `conversation:${session.id}`, `note:${note.objectId}`]));

    // Dismiss both the comic work and the standalone video, and verify idempotent replay.
    const dismissedComic = ok<{ key: string; dismissedAt: string; previousDismissedAt: string | null }>(
      await run(ctx, "workspace.dismissRecent", { key: `work:${comic.workId}` }, ctx.actor, ctx.grant.handle, "idem-dismiss-comic"),
    );
    const replayed = ok<{ key: string; dismissedAt: string; previousDismissedAt: string | null }>(
      await run(ctx, "workspace.dismissRecent", { key: `work:${comic.workId}` }, ctx.actor, ctx.grant.handle, "idem-dismiss-comic"),
    );
    expect(replayed).toEqual(dismissedComic);
    expect(dismissedComic.previousDismissedAt).toBeNull();

    ok(await run(ctx, "workspace.dismissRecent", { key: `resource:${soloVideo.resourceId}` }));

    // Gone from "最近" media views, home view, and paginated workspace.items!
    expect(await recentKeys(ctx, "comic")).not.toContain(`work:${comic.workId}`);
    expect(await recentKeys(ctx, "video")).not.toContain(`resource:${soloVideo.resourceId}`);
    const homeAfter = await recentKeys(ctx, "home");
    expect(homeAfter).not.toContain(`work:${comic.workId}`);
    expect(homeAfter).not.toContain(`resource:${soloVideo.resourceId}`);
    // Conversation and note in "最近" remain untouched!
    expect(homeAfter).toEqual(expect.arrayContaining([`conversation:${session.id}`, `note:${note.objectId}`]));

    const itemsAfter = ok<{ total: number; items: Array<{ key: string }> }>(
      await run(ctx, "workspace.items", { view: "comic", contextId: null, limit: 20 }),
    );
    expect(itemsAfter.items.map((i) => i.key)).not.toContain(`work:${comic.workId}`);

    // Project A's list, library shelf, unassigned list, progress, notes, bookmarks, screenshots, recordings and conversations are all intact.
    expect(await projectKeys(ctx, projectA, "comic")).toContain(`work:${comic.workId}`);
    expect(ok<{ items: Array<{ id: string }> }>(await run(ctx, "works.list", { kind: "comic" })).items.map((w) => w.id)).toContain(comic.workId);
    expect(ok<{ items: Array<{ resourceId: string }> }>(await run(ctx, "works.unassigned", { kind: "video" })).items.map((r) => r.resourceId)).toContain(soloVideo.resourceId);
    expect(ok<{ percent: number }>(await run(ctx, "progress.get", { contextId: null, resourceId: comic.resourceId })).percent).toBeCloseTo(0.8, 5);
    expect(ok<{ percent: number }>(await run(ctx, "progress.get", { contextId: projectA, resourceId: comic.resourceId })).percent).toBeCloseTo(0.3, 5);
    expect(ok<Array<{ objectId: string }>>(await run(ctx, "notes.list", { resourceId: comic.resourceId }))).toEqual(expect.arrayContaining([expect.objectContaining({ objectId: note.objectId })]));
    expect(ok<Array<{ label: string }>>(await run(ctx, "reading.bookmarks", { resourceId: comic.resourceId }))).toEqual(expect.arrayContaining([expect.objectContaining({ label: "第八页书签" })]));
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM screenshots WHERE id = 'shot_keep_1'").get()).toEqual({ n: 1 });
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM capture_sessions WHERE id = 'cap_keep_1'").get()).toEqual({ n: 1 });
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE id = ?").get(session.id)).toEqual({ n: 1 });

    // Undo restores the comic to "最近".
    ok(await run(ctx, "workspace.undismissRecent", { key: `work:${comic.workId}`, previousDismissedAt: dismissedComic.previousDismissedAt }));
    expect(await recentKeys(ctx, "comic")).toContain(`work:${comic.workId}`);
  });

  it("keeps a dismissed item hidden when opened or read in a project, and restores it at 最近's own position when reopened in 最近", async () => {
    const ctx = await boot();
    const comic = seedOpenableComic(ctx, "重开漫画", 10);
    const soloVideo = seedStandaloneVideo(ctx, "重开短片");
    const projectA = ok<{ id: string }>(await run(ctx, "project.create", { name: "项目 A" })).id;

    // Read to page 8 (80%) in "最近" and page 2 (20%) in "项目 A".
    ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[7], consumed: true }));
    ok(await run(ctx, "progress.setPage", { contextId: projectA, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[1], consumed: true }));
    ok(await run(ctx, "progress.setTime", { contextId: null, resourceId: soloVideo.resourceId, resourceRevisionId: soloVideo.revisionId, timeMs: 300_000 }));

    // Dismiss both in "最近".
    ok(await run(ctx, "workspace.dismissRecent", { key: `work:${comic.workId}` }));
    ok(await run(ctx, "workspace.dismissRecent", { key: `resource:${soloVideo.resourceId}` }));
    expect(await recentKeys(ctx, "comic")).not.toContain(`work:${comic.workId}`);
    expect(await recentKeys(ctx, "video")).not.toContain(`resource:${soloVideo.resourceId}`);

    // Opening and advancing inside Project A MUST NOT make either item reappear in "最近".
    ok(await run(ctx, "works.open", { resourceId: comic.resourceId, contextId: projectA }));
    ok(await run(ctx, "progress.setPage", { contextId: projectA, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[3], consumed: true }));
    ok(await run(ctx, "works.open", { resourceId: soloVideo.resourceId, contextId: projectA }));
    ok(await run(ctx, "progress.setTime", { contextId: projectA, resourceId: soloVideo.resourceId, resourceRevisionId: soloVideo.revisionId, timeMs: 60_000 }));
    expect(await recentKeys(ctx, "comic")).not.toContain(`work:${comic.workId}`);
    expect(await recentKeys(ctx, "video")).not.toContain(`resource:${soloVideo.resourceId}`);

    // Opening the comic in "最近" (`works.open` with `contextId: null`) brings it back immediately AND keeps "最近"'s page 8!
    ok(await run(ctx, "works.open", { resourceId: comic.resourceId, contextId: null }));
    expect(await recentKeys(ctx, "comic")).toContain(`work:${comic.workId}`);
    const restoredComic = ok<{ percent: number; locator: { pageId: string } }>(
      await run(ctx, "progress.get", { contextId: null, resourceId: comic.resourceId }),
    );
    expect(restoredComic.locator.pageId).toBe(comic.pageIds[7]);
    expect(restoredComic.percent).toBeCloseTo(0.8, 5);

    // Dismiss again, then report the same position in "最近" (`progress.setTime` while dismissed): wakes the dismissed standalone video too.
    ok(await run(ctx, "workspace.dismissRecent", { key: `work:${comic.workId}` }));
    expect(await recentKeys(ctx, "comic")).not.toContain(`work:${comic.workId}`);
    ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[7], consumed: false }));
    expect(await recentKeys(ctx, "comic")).toContain(`work:${comic.workId}`);

    ok(await run(ctx, "works.open", { resourceId: soloVideo.resourceId, contextId: null }));
    expect(await recentKeys(ctx, "video")).toContain(`resource:${soloVideo.resourceId}`);
    expect(ok<{ locator: { startMs: number } }>(await run(ctx, "progress.get", { contextId: null, resourceId: soloVideo.resourceId })).locator.startMs).toBe(300_000);
  });

  it("cleans up recent_dismissals when a work or standalone outside resource is deleted, and rejects non-owner or invalid calls", async () => {
    const ctx = await boot();
    const comic = seedOpenableComic(ctx, "待删条目漫画", 6);
    const outsideResId = createId("res");
    const outsideRevId = createId("rev");
    const now = new Date().toISOString();
    ctx.app.store.sqlite.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at, sort_key) VALUES (?,NULL,'video','库外短片','[]',?,'')").run(outsideResId, now);
    ctx.app.store.sqlite.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)")
      .run(outsideRevId, outsideResId, createId("fp"), "video-probe-v1", JSON.stringify({ id: outsideRevId, format: "video", video: { durationMs: 10_000 }, parts: [], warnings: [] }), now);
    ctx.app.store.sqlite.prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, legacy_path, fingerprint, available, hosted) VALUES (?,?,NULL,'','/synthetic/outside.mp4',?,0,0)")
      .run(createId("loc"), outsideRevId, createId("fp"));

    ok(await run(ctx, "workspace.dismissRecent", { key: `work:${comic.workId}` }));
    ok(await run(ctx, "workspace.dismissRecent", { key: `resource:${outsideResId}` }));
    expect(ctx.app.store.sqlite.prepare("SELECT key FROM recent_dismissals ORDER BY key").all()).toEqual([
      { key: `resource:${outsideResId}` },
      { key: `work:${comic.workId}` },
    ]);

    // Deleting the work entry triggers `recent_dismissals_work_gone`.
    ok(await run(ctx, "works.delete", { workId: comic.workId }));
    expect(ctx.app.store.sqlite.prepare("SELECT key FROM recent_dismissals WHERE key = ?").get(`work:${comic.workId}`)).toBeUndefined();

    // Removing the outside resource triggers `recent_dismissals_resource_gone`.
    ok(await run(ctx, "library.removeOutside", { expectedCount: 1 }));
    expect(ctx.app.store.sqlite.prepare("SELECT key FROM recent_dismissals WHERE key = ?").get(`resource:${outsideResId}`)).toBeUndefined();

    // Validation & access guards.
    expect((await run(ctx, "workspace.dismissRecent", { key: "work:does_not_exist" })).error?.code).toBe("NOT_FOUND");
    expect((await run(ctx, "workspace.dismissRecent", { key: "note:bad_prefix" })).error?.code).toBe("VALIDATION_ERROR");
    const agentRes = await run(ctx, "workspace.dismissRecent", { key: `resource:${comic.resourceId}` }, { kind: "agent", id: "agent-1" });
    expect(agentRes.status).toBe("error");
  });
});

describe("library furthest progress and work homepage per-context positions (A-129, AT-173)", () => {
  it("reports 80% from 最近 over a newer 10% in 项目 A, marks works completed only in a project as completed, sorts by furthest progress, and lists per-context positions", async () => {
    const ctx = await boot();
    const projectA = ok<{ id: string }>(await run(ctx, "project.create", { name: "项目 A" })).id;

    // 1. Comic read to 80% in "最近" (older) and 10% in "项目 A" (newer).
    const comic80 = seedOpenableComic(ctx, "八成漫画", 10);
    ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: comic80.resourceId, resourceRevisionId: comic80.revisionId, pageId: comic80.pageIds[7], consumed: true }));
    ok(await run(ctx, "progress.setPage", { contextId: projectA, resourceId: comic80.resourceId, resourceRevisionId: comic80.revisionId, pageId: comic80.pageIds[0], consumed: true }));
    ctx.app.store.sqlite.prepare("UPDATE progress SET last_interaction_at = ? WHERE context_id = '' AND resource_id = ?").run("2026-10-01T00:00:00.000Z", comic80.resourceId);
    ctx.app.store.sqlite.prepare("UPDATE progress SET last_interaction_at = ? WHERE context_id = ? AND resource_id = ?").run("2026-10-03T00:00:00.000Z", projectA, comic80.resourceId);

    // 2. Novel completed ONLY in "项目 A" (at 99% raw text range, which marks completion_state = 'completed').
    const body = "第一段合成小说正文。".repeat(100);
    const novelDone = ok<{ workId: string; resourceId: string; revisionId: string }>(
      await run(ctx, "library.importText", { title: "项目读完的小说", bytes: [...Buffer.from(body)] }),
    );
    const fullLen = [...body].length;
    const end99 = Math.ceil(fullLen * 0.99);
    ok(await run(ctx, "progress.set", {
      contextId: projectA,
      resourceId: novelDone.resourceId,
      resourceRevisionId: novelDone.revisionId,
      locator: {
        kind: "text",
        partId: "body",
        representationId: novelDone.revisionId,
        normalizationVersion: NORMALIZATION_V1,
        range: { start: 0, end: end99 },
        quote: { exact: [...body].slice(0, 10).join("") },
      },
      consumed: true,
    }));

    // 3. Multi-episode anime: "最近" at 第 3 话 12:30 (750_000 ms of 1_500_000 ms = 50%), "项目 A" at 第 1 话 05:00 (300_000 ms = 20%).
    const ep1 = seedVideo(ctx.app, { title: "第一话", durationMs: 1_500_000, ordinal: { type: "episode", number: 1, label: "第 1 话" } });
    const ep2 = seedVideo(ctx.app, { title: "第二话", workId: ep1.workId, durationMs: 1_500_000, ordinal: { type: "episode", number: 2, label: "第 2 话" } });
    const ep3 = seedVideo(ctx.app, { title: "第三话", workId: ep1.workId, durationMs: 1_500_000, ordinal: { type: "episode", number: 3, label: "第 3 话" } });
    void ep2;
    const libRow = ensureLibRoot(ctx);
    for (const ep of [ep1, ep2, ep3]) {
      fs.writeFileSync(path.join(libRow.path, `${ep.resourceId}.mp4`), "synthetic-video");
      ctx.app.store.sqlite
        .prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,1,0)")
        .run(createId("loc"), ep.revisionId, libRow.id, `${ep.resourceId}.mp4`, createId("fp"));
    }
    ok(await run(ctx, "works.open", { resourceId: ep3.resourceId, contextId: null }));
    ok(await run(ctx, "progress.setTime", { contextId: null, resourceId: ep3.resourceId, resourceRevisionId: ep3.revisionId, timeMs: 750_000, played: [{ startMs: 0, endMs: 750_000 }] }));
    ok(await run(ctx, "progress.setTime", { contextId: projectA, resourceId: ep1.resourceId, resourceRevisionId: ep1.revisionId, timeMs: 300_000, played: [{ startMs: 0, endMs: 300_000 }] }));

    // Sort library by progress: completed novel (100%) > comic80 (80%) > anime (50%).
    const sorted = ok<{ items: Array<{ id: string; progress: number; progressCompleted?: boolean; finishedCount: number; progressContext: { contextId: string | null; name: string } | null }> }>(
      await run(ctx, "works.list", { sort: "progress" }),
    ).items;
    expect(sorted.map((item) => item.id)).toEqual([novelDone.workId, comic80.workId, ep1.workId]);

    expect(sorted[0]).toMatchObject({
      id: novelDone.workId,
      progress: 1,
      progressCompleted: true,
      finishedCount: 1,
      progressContext: { contextId: projectA, name: "项目 A" },
    });
    expect(sorted[1]!.progress).toBeCloseTo(0.8, 5);
    expect(sorted[1]!.progressCompleted).toBe(false);
    expect(sorted[1]!.progressContext).toEqual({ contextId: null, name: "最近" });
    expect(sorted[2]!.progress).toBeCloseTo(0.5, 5);
    expect(sorted[2]!.progressContext).toEqual({ contextId: null, name: "最近" });

    // `progress_latest` still tracks the newest interaction (`projectA` on comic80).
    expect(ctx.app.store.sqlite.prepare("SELECT context_id AS contextId FROM progress_latest WHERE resource_id = ?").get(comic80.resourceId)).toEqual({ contextId: projectA });

    // Work homepage (`works.get`) returns furthest progress and per-context positions in display order ("最近" first, then projects).
    const comicDetail = ok<{
      progress: number;
      progressContext: { contextId: string | null; name: string } | null;
      contextPositions: Array<{ contextId: string | null; contextName: string; pageNumber: number | null; pageCount: number | null; percent: number }>;
    }>(await run(ctx, "works.get", { workId: comic80.workId }));
    expect(comicDetail.progress).toBeCloseTo(0.8, 5);
    expect(comicDetail.progressContext).toEqual({ contextId: null, name: "最近" });
    expect(comicDetail.contextPositions).toEqual([
      expect.objectContaining({ contextId: null, contextName: "最近", pageNumber: 8, pageCount: 10 }),
      expect.objectContaining({ contextId: projectA, contextName: "项目 A", pageNumber: 1, pageCount: 10 }),
    ]);

    const animeDetail = ok<{
      contextPositions: Array<{ contextId: string | null; contextName: string; ordinalLabel: string | null; locator: { startMs?: number } | null }>;
    }>(await run(ctx, "works.get", { workId: ep1.workId }));
    expect(animeDetail.contextPositions).toEqual([
      expect.objectContaining({ contextId: null, contextName: "最近", ordinalLabel: "第 3 话", locator: { kind: "temporal", startMs: 750_000 } }),
      expect.objectContaining({ contextId: projectA, contextName: "项目 A", ordinalLabel: "第 1 话", locator: { kind: "temporal", startMs: 300_000 } }),
    ]);
  });
});
