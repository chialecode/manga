/** @vitest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createId } from "@manga/contracts";
import { createTranslator } from "@manga/i18n";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { Shelf } from "../../apps/desktop/src/renderer/pages/shelf.tsx";
import { WorkHome } from "../../apps/desktop/src/renderer/pages/work-home.tsx";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { resetListsChanged } from "../../apps/desktop/src/renderer/lib/lists-changed.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { libraryRoot, startApp } from "../helpers/app.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";
import { bridgeToApp } from "../helpers/ui-host.ts";
import { installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

Element.prototype.scrollIntoView = () => {};

/**
 * UI tests for removing items from "最近" and displaying furthest progress + per-context positions (A-129, AT-173):
 * - Right-click and keyboard context menu on media items in "最近" (cover, list and home views) offer "从最近移除", show an undoable toast, and restore on "撤销".
 * - Project media items, conversations and notes never offer "从最近移除".
 * - Shelf cards and WorkHome display `progress_furthest`, mark project-only completions as finished, list per-context positions, and open the active context's own resource on "继续阅读/继续观看" (A-96).
 */

const i18n = createTranslator("zh-CN");
const t = i18n.t;

type Started = Awaited<ReturnType<typeof startApp>>;
const apps: Started[] = [];
const bridges: Array<{ dispose: () => void }> = [];
let media: ReturnType<typeof installMediaElement>;

beforeEach(() => {
  window.innerWidth = 1600;
  window.innerHeight = 1000;
  media = installMediaElement();
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetCovers();
  resetListsChanged();
  shelfMemory.reset();
  readerContext.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
});

afterEach(() => {
  cleanup();
  while (bridges.length) bridges.pop()!.dispose();
  while (apps.length) apps.pop()!.app.close();
  media.restore();
  vi.restoreAllMocks();
  removeMatchMedia();
  readerContext.reset();
});

async function bootRealApp() {
  const ctx = await startApp();
  apps.push(ctx);
  const dir = path.join(ctx.profileRoot, "lib");
  fs.mkdirSync(dir, { recursive: true });
  libraryRoot(ctx.app, dir, "comic");
  const libRow = ctx.app.store.sqlite.prepare("SELECT id, path FROM library_paths WHERE managed = 0 LIMIT 1").get() as { id: string; path: string };
  const buildInfo = { version: "0.1.0", channel: "test", commit: "c79f49a", builtAt: "2026-11-08T08:00:00.000Z", schemaVersion: 15 };
  const bridge = bridgeToApp(ctx, {
    async state() {
      return {
        layout: { channel: "test", pointerPath: "pointer.json", partitions: { data: "d" }, writable: true, recovery: "none" },
        writable: true,
        vaultAvailable: true,
        appVersion: "0.1.0",
        buildInfo,
      };
    },
    async chooseDirectory() { return null; },
    async chooseFile() { return null; },
    async chooseAudio() { return null; },
    async stashSecret() { return null; },
    async reveal() { return { status: "ok", value: {} }; },
  });
  bridges.push(bridge);
  return { ctx, libRow, bridge };
}

let seq = 0;
async function callReal<T = Record<string, any>>(ctx: Started, commandId: string, input: Record<string, unknown>): Promise<T> {
  const res = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `ui-rf-${++seq}`, input }, ctx.grant.handle);
  expect(res.status, JSON.stringify(res)).toBe("ok");
  return res.value as T;
}

describe("AT-173 sidebar 从最近移除 menu, keyboard access, and undoable toast", () => {
  it("removes a comic from 最近 via right-click and Shift+F10, shows an undoable toast, restores on 撤销, and never offers 从最近移除 on projects, notes or conversations", async () => {
    const { ctx, libRow, bridge } = await bootRealApp();
    await callReal(ctx, "settings.skipAi", {});
    const projectA = (await callReal<{ id: string }>(ctx, "project.create", { name: "项目 A" })).id;

    // Seed a comic in "最近" and another comic in "项目 A".
    const recentComic = seedComic(ctx.app, { title: "最近看的漫画", pageCount: 10 });
    const projComic = seedComic(ctx.app, { title: "项目里的漫画", pageCount: 6 });
    for (const c of [recentComic, projComic]) {
      const folder = path.join(libRow.path, c.resourceId);
      fs.mkdirSync(folder, { recursive: true });
      ctx.app.store.sqlite.prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,1,0)")
        .run(createId("loc"), c.revisionId, libRow.id, c.resourceId, createId("fp"));
    }
    await callReal(ctx, "progress.setPage", { contextId: null, resourceId: recentComic.resourceId, resourceRevisionId: recentComic.revisionId, pageId: recentComic.pageIds[7], consumed: true });
    await callReal(ctx, "project.addMaterial", { projectId: projectA, kind: "work", targetId: projComic.workId });

    // Seed a note and a shared conversation in "最近".
    const note = await callReal<{ objectId: string }>(ctx, "notes.create", { title: "最近的笔记", text: "正文" });
    const conv = await callReal<{ conversation?: { sessionId: string }; sessionId?: string; id?: string }>(ctx, "conversation.new", { contextId: null });
    const convId = conv.conversation?.sessionId ?? conv.sessionId ?? conv.id!;

    render(<App />);

    // Home view: conversations and notes in "最近" must NOT show "从最近移除".
    const convRow = await screen.findByTestId(`session-open-${convId}`);
    fireEvent.contextMenu(convRow, { clientX: 40, clientY: 160 });
    expect(within(screen.getByTestId("sidebar-menu")).queryByTestId("sidebar-menu-remove-recent")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("sidebar-menu"), { key: "Escape" });

    const noteRow = await screen.findByTestId(`sidebar-item-note-${note.objectId}`);
    fireEvent.contextMenu(noteRow, { clientX: 40, clientY: 180 });
    expect(within(screen.getByTestId("sidebar-menu")).queryByTestId("sidebar-menu-remove-recent")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("sidebar-menu"), { key: "Escape" });

    // Switch to comic view: cover item in "最近" supports keyboard Shift+F10 context menu AND right-click removal.
    fireEvent.click(await screen.findByTestId("nav-comic"));
    const recentTestId = `sidebar-item-resource-${recentComic.resourceId}`;
    const recentItem = await screen.findByTestId(recentTestId);
    fireEvent.keyDown(recentItem, { key: "F10", shiftKey: true });
    const kbMenu = await screen.findByTestId("sidebar-menu");
    expect(within(kbMenu).getAllByRole("menuitem").map((n) => (n.textContent ?? "").trim())).toEqual(["打开", "在后台打开", "打开作品主页", "从最近移除"]);
    fireEvent.keyDown(kbMenu, { key: "Escape" });

    // Project A's comic shows "从这个项目移除" and NOT "从最近移除".
    fireEvent.click(screen.getByTestId(`context-toggle-${projectA}`));
    const projItem = await screen.findByTestId(`sidebar-item-work-${projComic.workId}`);
    fireEvent.contextMenu(projItem, { clientX: 40, clientY: 240 });
    const projMenu = screen.getByTestId("sidebar-menu");
    expect(within(projMenu).queryByTestId("sidebar-menu-remove-recent")).toBeNull();
    expect(within(projMenu).getByTestId("sidebar-menu-remove").textContent).toContain("从这个项目移除");
    fireEvent.keyDown(projMenu, { key: "Escape" });

    // Switch comic sidebar to list view and remove via right-click -> disappears + undoable toast -> click "撤销" restores!
    fireEvent.click(screen.getByTestId("sidebar-display"));
    await waitFor(() => expect(screen.queryByTestId("sidebar-covers-recent")).toBeNull());
    fireEvent.contextMenu(screen.getByTestId(recentTestId), { clientX: 40, clientY: 180 });
    fireEvent.click(screen.getByTestId("sidebar-menu-remove-recent"));

    await waitFor(() => expect(bridge.calls.filter((c) => c.commandId === "workspace.dismissRecent").at(-1)?.input).toEqual({ key: `work:${recentComic.workId}` }));
    await waitFor(() => expect(screen.queryByTestId(recentTestId)).toBeNull());
    // Project A's comic and underlying progress remain untouched.
    expect(screen.getByTestId(`sidebar-item-work-${projComic.workId}`)).toBeTruthy();
    expect((await callReal<{ percent: number }>(ctx, "progress.get", { contextId: null, resourceId: recentComic.resourceId })).percent).toBeCloseTo(0.8, 5);

    const toast = await screen.findByTestId("toast-notice");
    expect(toast.textContent).toContain("已从最近移除《最近看的漫画》");
    const undoBtn = screen.getByTestId("toast-notice-action");
    expect(undoBtn.textContent).toBe("撤销");

    fireEvent.click(undoBtn);
    await waitFor(() => expect(bridge.calls.filter((c) => c.commandId === "workspace.undismissRecent").at(-1)?.input).toEqual({ key: `work:${recentComic.workId}`, previousDismissedAt: null }));
    await waitFor(() => expect(screen.getByTestId(recentTestId)).toBeTruthy());
  });
});

describe("AT-173 library Shelf cards and WorkHome furthest progress & per-context positions", () => {
  it("renders furthest progress and project-only completion on Shelf cards, lists per-context positions on WorkHome, and opens the active context's own episode", async () => {
    const { ctx, libRow } = await bootRealApp();
    const projectA = (await callReal<{ id: string }>(ctx, "project.create", { name: "项目 A" })).id;

    // 1. Comic at 80% in "最近" (older) and 10% in "项目 A" (newer).
    const comic80 = seedComic(ctx.app, { title: "远进度漫画", pageCount: 10 });
    const dir80 = path.join(libRow.path, "comic80");
    fs.mkdirSync(dir80, { recursive: true });
    ctx.app.store.sqlite.prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,1,0)")
      .run(createId("loc"), comic80.revisionId, libRow.id, "comic80", createId("fp"));
    await callReal(ctx, "progress.setPage", { contextId: null, resourceId: comic80.resourceId, resourceRevisionId: comic80.revisionId, pageId: comic80.pageIds[7], consumed: true });
    await callReal(ctx, "progress.setPage", { contextId: projectA, resourceId: comic80.resourceId, resourceRevisionId: comic80.revisionId, pageId: comic80.pageIds[0], consumed: true });
    ctx.app.store.sqlite.prepare("UPDATE progress SET last_interaction_at = ? WHERE context_id = '' AND resource_id = ?").run("2026-10-01T00:00:00.000Z", comic80.resourceId);
    ctx.app.store.sqlite.prepare("UPDATE progress SET last_interaction_at = ? WHERE context_id = ? AND resource_id = ?").run("2026-10-03T00:00:00.000Z", projectA, comic80.resourceId);

    // 2. Comic completed ONLY in "项目 A".
    const comicDone = seedComic(ctx.app, { title: "项目读完漫画", pageCount: 4 });
    const dirDone = path.join(libRow.path, "comicDone");
    fs.mkdirSync(dirDone, { recursive: true });
    ctx.app.store.sqlite.prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,1,0)")
      .run(createId("loc"), comicDone.revisionId, libRow.id, "comicDone", createId("fp"));
    await callReal(ctx, "progress.setPage", { contextId: projectA, resourceId: comicDone.resourceId, resourceRevisionId: comicDone.revisionId, pageId: comicDone.pageIds[3], consumed: true });

    // Render comic Shelf in "最近" (`context={null}`):
    // - comic80 shows "已读 80%" without origin tag (furthest is already in "最近")
    // - comicDone shows "已读" (no %) with 100% bar and "来自“项目 A”"
    const { unmount: unmountShelf } = render(
      <Shelf
        t={t}
        kind="comic"
        refreshKey={0}
        facets={new Set(["library", "comic"])}
        context={null}
        onOpen={() => undefined}
        onContinue={() => undefined}
        onDetail={() => undefined}
        onAddPath={() => undefined}
        onViewAll={() => undefined}
        onSetShelf={() => undefined}
      />,
    );
    const prog80 = await screen.findByTestId(`work-progress-${comic80.workId}`);
    expect(prog80.textContent).toContain("已读 80%");
    expect(screen.queryByTestId(`work-origin-${comic80.workId}`)).toBeNull();

    const progDone = await screen.findByTestId(`work-progress-${comicDone.workId}`);
    expect(progDone.textContent).toContain("已读");
    expect(progDone.textContent).not.toContain("%");
    expect(screen.getByTestId(`work-origin-${comicDone.workId}`).textContent).toBe("来自“项目 A”");
    unmountShelf();

    // Render comic80's WorkHome in "项目 A": shows "已读 80% · 来自“最近”" and "最近：第 8 页 · 项目 A：第 1 页".
    const { unmount: unmountComicHome } = render(
      <WorkHome
        t={t}
        workId={comic80.workId}
        context={projectA}
        facets={new Set(["library", "comic"])}
        formatDate={i18n.formatDate}
        onBack={() => undefined}
        onOpenResource={() => undefined}
        onOpenNote={() => undefined}
        onOpenWork={() => undefined}
        onOpenConversation={() => undefined}
        onAddPath={() => undefined}
        onChanged={() => undefined}
        onError={() => undefined}
        onNotice={() => undefined}
      />,
    );
    const comicSummary = await screen.findByTestId("work-progress-summary");
    expect(comicSummary.textContent).toContain("已读 80%");
    expect(screen.getByTestId("work-progress-origin").textContent).toBe("来自“最近”");
    expect(screen.getByTestId("work-context-positions").textContent).toBe("最近：第 8 页 · 项目 A：第 1 页");
    unmountComicHome();

    // 3. Multi-episode anime: "最近" at 第 3 话 12:30 (750_000 / 1_500_000), "项目 A" at 第 1 话 05:00 (300_000 / 1_500_000).
    const ep1 = seedVideo(ctx.app, { title: "第一话", durationMs: 1_500_000, ordinal: { type: "episode", number: 1, label: "第 1 话" } });
    const ep2 = seedVideo(ctx.app, { title: "第二话", workId: ep1.workId, durationMs: 1_500_000, ordinal: { type: "episode", number: 2, label: "第 2 话" } });
    const ep3 = seedVideo(ctx.app, { title: "第三话", workId: ep1.workId, durationMs: 1_500_000, ordinal: { type: "episode", number: 3, label: "第 3 话" } });
    for (const ep of [ep1, ep2, ep3]) {
      fs.writeFileSync(path.join(libRow.path, `${ep.resourceId}.mp4`), "synthetic-video");
      ctx.app.store.sqlite.prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,1,0)")
        .run(createId("loc"), ep.revisionId, libRow.id, `${ep.resourceId}.mp4`, createId("fp"));
    }
    await callReal(ctx, "progress.setTime", { contextId: null, resourceId: ep3.resourceId, resourceRevisionId: ep3.revisionId, timeMs: 750_000, played: [{ startMs: 0, endMs: 750_000 }] });
    await callReal(ctx, "progress.setTime", { contextId: projectA, resourceId: ep1.resourceId, resourceRevisionId: ep1.revisionId, timeMs: 300_000, played: [{ startMs: 0, endMs: 300_000 }] });

    // In "最近" (`context={null}`), WorkHome lists `最近：第 3 话 12:30 · 项目 A：第 1 话 05:00` and clicking `work-read` opens `ep3`.
    const openedRecent: string[] = [];
    const { unmount: unmountAnimeRecent } = render(
      <WorkHome
        t={t}
        workId={ep1.workId}
        context={null}
        facets={new Set(["library", "video"])}
        formatDate={i18n.formatDate}
        onBack={() => undefined}
        onOpenResource={(id) => openedRecent.push(id)}
        onOpenNote={() => undefined}
        onOpenWork={() => undefined}
        onOpenConversation={() => undefined}
        onAddPath={() => undefined}
        onChanged={() => undefined}
        onError={() => undefined}
        onNotice={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("work-context-positions").textContent).toBe("最近：第 3 话 12:30 · 项目 A：第 1 话 05:00"));
    expect(screen.getByTestId("work-progress-summary").textContent).toContain("已看 50%");
    expect(screen.getByTestId("work-progress-origin").textContent).toBe("来自“最近”");
    fireEvent.click(screen.getByTestId("work-read"));
    expect(openedRecent).toEqual([ep3.resourceId]);
    unmountAnimeRecent();

    // In "项目 A" (`context={projectA}`), clicking `work-read` opens "项目 A"'s own episode `ep1` (A-96 preserved!).
    const openedProjA: string[] = [];
    render(
      <WorkHome
        t={t}
        workId={ep1.workId}
        context={projectA}
        facets={new Set(["library", "video"])}
        formatDate={i18n.formatDate}
        onBack={() => undefined}
        onOpenResource={(id) => openedProjA.push(id)}
        onOpenNote={() => undefined}
        onOpenWork={() => undefined}
        onOpenConversation={() => undefined}
        onAddPath={() => undefined}
        onChanged={() => undefined}
        onError={() => undefined}
        onNotice={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("work-read")).toBeTruthy());
    fireEvent.click(screen.getByTestId("work-read"));
    expect(openedProjA).toEqual([ep1.resourceId]);
  });
});
