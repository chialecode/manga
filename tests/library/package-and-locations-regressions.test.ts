import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { exportLibraryPackageCancellable, importLibraryPackageResolved } from "@manga/app-core";
import { resolveLaunchLayout } from "../../packages/app-core/src/locations.ts";
import { fingerprintTree, ownedFileFingerprint } from "../../packages/app-core/src/domain/file-ownership.ts";
import { startApp, tempProfile } from "../helpers/app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
const dirs: string[] = [];
let seq = 0;

afterEach(() => {
  while (apps.length) {
    try { apps.pop()!.app.close(); } catch { /* closed */ }
  }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-reg-${prefix}-`));
  dirs.push(dir);
  return dir;
}

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}

const run = (ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle, actor: { kind: "user" | "agent"; id: string } = ctx.actor) =>
  ctx.app.call(actor, { commandId, idempotencyKey: `pkg-reg-${++seq}`, input }, grantHandle);

describe("App-Core library package, locations & visibility regressions", () => {
  it("A-01: refuses non-empty export destDir and attachmentsDir without deleting pre-existing files", async () => {
    const ctx = await boot();
    await run(ctx, "library.importText", { title: "样本", bytes: [...Buffer.from("导出正文")] });
    const dest = scratch("nonempty-dest");
    const keepFile = path.join(dest, "precious.txt");
    fs.writeFileSync(keepFile, "do-not-delete");

    await expect(exportLibraryPackageCancellable(ctx.app.store, dest)).rejects.toThrow(/empty/i);
    expect(fs.readFileSync(keepFile, "utf8")).toBe("do-not-delete");

    const dest2 = scratch("nonempty-att");
    const attDir = path.join(dest2, "attachments");
    fs.mkdirSync(attDir, { recursive: true });
    const attKeep = path.join(attDir, "user-file.bin");
    fs.writeFileSync(attKeep, "keep-me");

    await expect(exportLibraryPackageCancellable(ctx.app.store, dest2)).rejects.toThrow(/empty/i);
    expect(fs.readFileSync(attKeep, "utf8")).toBe("keep-me");
  });

  it("A-04: package import honors skip on work metadata/links and remaps metadata_candidates.id on duplicate", async () => {
    const src = await boot();
    const imp = await run(src, "library.importText", { title: "元测试", bytes: [...Buffer.from("正文内容甲")] });
    const resId = String(imp.value?.resourceId);
    const workId = (src.app.store.sqlite.prepare("SELECT work_id FROM resources WHERE id = ?").get(resId) as { work_id: string }).work_id;
    const now = new Date().toISOString();
    src.app.store.sqlite.prepare("INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json, fetched_at) VALUES (?,?,?,?,?)")
      .run(workId, "bangumi", "101", JSON.stringify({ title: "导入标题" }), now);
    src.app.store.sqlite.prepare("INSERT INTO metadata_overrides(work_id, fields_json, locked_json, cleared_json) VALUES (?,?,?,?)")
      .run(workId, JSON.stringify({ author: "导入作者" }), "[]", "[]");
    src.app.store.sqlite.prepare("INSERT INTO metadata_candidates(id, work_id, provider_id, payload_json) VALUES (?,?,?,?)")
      .run("cand_fixed", workId, "bangumi", JSON.stringify({ title: "候选标题" }));
    src.app.store.sqlite.prepare("INSERT INTO work_links(work_id, provider_id, external_id, link_state, snapshot_json, confirmed_at) VALUES (?,?,?,?,?,?)")
      .run(workId, "bangumi", "101", "linked", "{}", now);

    const pkgDir = path.join(scratch("a04-pkg"), "out");
    await exportLibraryPackageCancellable(src.app.store, pkgDir);

    // Target profile already has the same work with local overrides/candidates.
    const dst = await boot();
    dst.app.store.sqlite.prepare("INSERT INTO works(id, title, created_at, media_kind, updated_at) VALUES (?,?,?,?,?)")
      .run(workId, "本地保留", now, "novel", now);
    dst.app.store.sqlite.prepare("INSERT INTO metadata_overrides(work_id, fields_json, locked_json, cleared_json) VALUES (?,?,?,?)")
      .run(workId, JSON.stringify({ author: "本地作者" }), '["author"]', "[]");
    dst.app.store.sqlite.prepare("INSERT INTO metadata_candidates(id, work_id, provider_id, payload_json) VALUES (?,?,?,?)")
      .run("cand_fixed", workId, "bangumi", JSON.stringify({ title: "本地候选" }));

    // 1) Skip policy must NOT overwrite or insert metadata/links/candidates for the skipped work.
    importLibraryPackageResolved(dst.app.store, pkgDir, { strategy: "skip" });
    const overrideAfterSkip = dst.app.store.sqlite.prepare("SELECT fields_json FROM metadata_overrides WHERE work_id = ?").get(workId) as { fields_json: string };
    expect(JSON.parse(overrideAfterSkip.fields_json)).toEqual({ author: "本地作者" });
    expect(dst.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM metadata_snapshots WHERE work_id = ?").get(workId)).toEqual({ n: 0 });
    expect(dst.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM work_links WHERE work_id = ?").get(workId)).toEqual({ n: 0 });
    expect(dst.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM metadata_candidates").get()).toEqual({ n: 1 });

    // 2) Duplicate policy must remap colliding metadata_candidates.id cleanly without overwriting local cand_fixed.
    const srcCands = (src.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM metadata_candidates").get() as { n: number }).n;
    importLibraryPackageResolved(dst.app.store, pkgDir, { strategy: "duplicate" });
    const localCand = dst.app.store.sqlite.prepare("SELECT payload_json, work_id FROM metadata_candidates WHERE id = 'cand_fixed'").get() as { payload_json: string; work_id: string };
    expect(JSON.parse(localCand.payload_json)).toEqual({ title: "本地候选" });
    expect(localCand.work_id).toBe(workId);
    const allCands = dst.app.store.sqlite.prepare("SELECT id, work_id FROM metadata_candidates").all() as Array<{ id: string; work_id: string }>;
    expect(allCands.length).toBe(1 + srcCands);
    expect(new Set(allCands.map((c) => c.work_id)).size).toBe(2);
  });

  it("A-08: follows multi-hop pointer redirect chains and terminates safely on cycles", () => {
    const root = scratch("a08-ptrs");
    const p1 = path.join(root, "p1.json");
    const p2 = path.join(root, "p2.json");
    const p3 = path.join(root, "p3.json");
    const finalRoot = path.join(root, "final-profile");
    fs.writeFileSync(p1, JSON.stringify({ redirectedTo: p2 }));
    fs.writeFileSync(p2, JSON.stringify({ redirectedTo: p3 }));
    fs.writeFileSync(p3, JSON.stringify({ profileRoot: finalRoot, channel: "test", revision: 3 }));

    const layout = resolveLaunchLayout({ channel: "test", pointerPath: p1, profileRoot: path.join(root, "fallback") });
    expect(layout.pointerPath).toBe(path.resolve(p3));
    expect(layout.revision).toBe(3);

    // Cycle A -> B -> A must terminate cleanly without hanging.
    const cA = path.join(root, "cycA.json");
    const cB = path.join(root, "cycB.json");
    fs.writeFileSync(cA, JSON.stringify({ redirectedTo: cB }));
    fs.writeFileSync(cB, JSON.stringify({ redirectedTo: cA }));
    expect(() => resolveLaunchLayout({ channel: "test", pointerPath: cA, profileRoot: path.join(root, "fallback") })).not.toThrow();
  });

  it("A-09: computes chunked file/tree fingerprints accurately and checkpoints data partition before copying", async () => {
    const dir = scratch("a09-hash");
    const file = path.join(dir, "big-ish.bin");
    const buf = crypto.randomBytes(1_500_000);
    fs.writeFileSync(file, buf);
    const expectedHash = crypto.createHash("sha256").update(buf).digest("hex");
    expect(JSON.parse(ownedFileFingerprint(file)).hash).toBe(expectedHash);
    expect(fingerprintTree(dir).bytes).toBe(buf.length);

    // applyLocations moving profile root leaves an integrity-clean sqlite file at destination.
    const ctx = await boot();
    await run(ctx, "library.importText", { title: "迁移验证", bytes: [...Buffer.from("数据库迁移一致性")] });
    const nextRoot = path.join(tempProfile(), "new-root");
    const proposed = await run(ctx, "settings.proposeLocations", {
      pathHandle: ctx.app.registerPath("directory", nextRoot),
    });
    expect(proposed.status, JSON.stringify(proposed)).toBe("ok");
    const res = await run(ctx, "settings.applyLocations", {
      checkpointId: String((proposed.value as { checkpointId: string }).checkpointId),
    });
    expect(res.status, JSON.stringify(res)).toBe("ok");
    const copied = new Database(path.join(nextRoot, "data", "manga.sqlite"), { readonly: true });
    try {
      const check = copied.pragma("integrity_check") as Array<{ integrity_check: string }>;
      expect(check[0]?.integrity_check).toBe("ok");
      expect((copied.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n).toBe(1);
    } finally {
      copied.close();
    }
  });

  it("A-13: removeOutside removes resource search_idx/text_fragments while preserving kept note FTS rows", async () => {
    const ctx = await boot();
    const rootDir = scratch("a13-lib");
    const bookPath = path.join(rootDir, "外移小说.txt");
    fs.writeFileSync(bookPath, "外移小说正文内容独一无二关键词\n\n第二段内容。");
    const added = await run(ctx, "library.paths.add", {
      pathHandle: ctx.app.registerPath("directory", rootDir),
      mediaKind: "novel",
    });
    expect(added.status).toBe("ok");
    await ctx.app.scan.whenIdle();

    const resRow = ctx.app.store.sqlite.prepare("SELECT id FROM resources LIMIT 1").get() as { id: string };
    const noteRes = await run(ctx, "notes.create", { title: "保留笔记", text: "重要个人感悟笔记词条", resourceId: resRow.id });
    expect(noteRes.status).toBe("ok");
    const noteId = String(noteRes.value?.objectId);

    // Remove library path -> resource moves outside -> library.removeOutside cleans resource index while keeping note FTS row.
    const pathId = String((added.value as { path: { id: string } }).path.id);
    expect((await run(ctx, "library.paths.remove", { pathId })).status).toBe("ok");
    const removed = await run(ctx, "library.removeOutside", { expectedCount: 1 });
    expect(removed.status, JSON.stringify(removed)).toBe("ok");
    expect((removed.value as { removed: number }).removed).toBe(1);

    const resFrags = ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM text_fragments WHERE resource_id = ? AND object_id IS NULL").get(resRow.id) as { n: number };
    const noteFrags = ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM text_fragments WHERE object_id = ?").get(noteId) as { n: number };
    const noteIdx = ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM search_idx WHERE fragment_id IN (SELECT id FROM text_fragments WHERE object_id = ?)").get(noteId) as { n: number };
    expect(resFrags.n).toBe(0);
    expect(noteFrags.n).toBeGreaterThan(0);
    expect(noteIdx.n).toBeGreaterThan(0);
  });

  it("A-14: scoped agent grant only sees authorized resources in works.list and works.get", async () => {
    const ctx = await boot();
    const r1 = await run(ctx, "library.importText", { title: "公开章节", bytes: [...Buffer.from("第一章正文")] });
    const r2 = await run(ctx, "library.importText", { title: "私密章节", bytes: [...Buffer.from("第二章绝密内容")] });
    const res1 = String(r1.value?.resourceId);
    const res2 = String(r2.value?.resourceId);
    const workId = (ctx.app.store.sqlite.prepare("SELECT work_id FROM resources WHERE id = ?").get(res1) as { work_id: string }).work_id;
    expect((await run(ctx, "works.moveResource", { resourceId: res2, toWorkId: workId })).status).toBe("ok");

    const agentActor = { kind: "agent" as const, id: "scoped-reader" };
    const agentGrant = ctx.app.issueAgentGrant(ctx.grant, agentActor, { readResourceIds: [res1] });

    const listed = await run(ctx, "works.list", {}, agentGrant.handle, agentActor);
    expect(listed.status).toBe("ok");
    const items = (listed.value as { items: Array<{ id: string; resourceCount: number; lastResource: { id: string } | null }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: workId, resourceCount: 1 });
    expect(items[0]!.lastResource?.id).toBe(res1);

    const detail = await run(ctx, "works.get", { workId }, agentGrant.handle, agentActor);
    expect(detail.status).toBe("ok");
    expect((detail.value as { resourceCount: number; resources: Array<{ id: string }> }).resourceCount).toBe(1);
    expect((detail.value as { resources: Array<{ id: string }> }).resources.map((r) => r.id)).toEqual([res1]);
  });

  it("A-15: workspace.sidebar downloads never exposes raw source_ref when name is empty", async () => {
    const ctx = await boot();
    const now = new Date().toISOString();
    const secretRef = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=http://private.local/passkey123";
    ctx.app.store.sqlite.prepare(
      "INSERT INTO acquisition_jobs(id, engine, resume_format, source_kind, source_ref, info_hash, name, state, path_id, subdir, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("acq_a15", "bt", "v1", "magnet", secretRef, "0123456789abcdef0123456789abcdef01234567", "", "downloading", "lp_1", "", now, now);

    const sidebar = await run(ctx, "workspace.sidebar", { view: "home", open: [null] });
    expect(sidebar.status).toBe("ok");
    const text = JSON.stringify(sidebar.value);
    expect(text).not.toContain("passkey123");
    expect(text).not.toContain("magnet:?xt=");
  });
});
