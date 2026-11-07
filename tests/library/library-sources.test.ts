import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { HASH, MAGNET, boot, emit, installFake, ok as okAcq, run as runAcq, stage, waitState } from "../helpers/acquisition-app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>) {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `sources-${counter}`, input }, ctx.grant.handle);
}
const ok = <T = Record<string, any>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

const scratch = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), `manga-sources-${prefix}-`));
function write(root: string, rel: string, body: string): string {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
const chapter = (title: string) => `${title}\n\n${"这是用于资源库位置测试的一段合成文字。".repeat(20)}\n`;
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)).map((rel) => `${entry.name}/${rel}`) : [entry.name]));

type Item = { id: string; title: string; resourceCount: number; outsideCount: number };
type Detail = { id: string; resourceCount: number; outsideCount: number; resources: Array<{ id: string; outside: boolean; available: boolean }> };
const works = async (ctx: App) => ok<{ items: Item[] }>(await run(ctx, "works.list", {})).items;
async function addPath(ctx: App, dir: string, kind: "novel" | "comic" | "video" = "novel") {
  const added = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", dir), mediaKind: kind, autoScan: false }));
  await ctx.app.scan.whenIdle();
  return added.path.id;
}

describe("the library is what the library paths hold (AT-79)", () => {
  it("lists only files under the library paths, copies and moves nothing, and refuses a file no library path holds until its folder is added", async () => {
    const ctx = await startApp();
    try {
      const one = scratch("one");
      const two = scratch("two");
      const alone = scratch("alone");
      write(one, "甲系列/第1话.txt", chapter("甲一"));
      write(two, "乙系列/第1话.txt", chapter("乙一"));
      const single = write(alone, "单独的书.txt", chapter("单独"));
      const before = [walk(one), walk(two), walk(alone)];
      await addPath(ctx, one);
      await addPath(ctx, two);
      // A book from a folder that is no library path is not read at all (A-80): the answer names the folder to add.
      const refused = await run(ctx, "library.importDocument", { title: "单独的书", pathHandle: ctx.app.registerPath("file", single) });
      expect(refused.status).toBe("error");
      expect((refused as { error: { code: string; details: Record<string, unknown> } }).error).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "outside-library", folder: alone } });
      expect((await works(ctx)).map((item) => item.title).sort()).toEqual(["乙系列", "甲系列"].sort());
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources WHERE title = ?").get("单独的书")).toEqual({ n: 0 });

      // Once the folder is a library path the same file imports, inside it, and every work sits inside a library path.
      await addPath(ctx, alone);
      ok(await run(ctx, "library.importDocument", { title: "单独的书", pathHandle: ctx.app.registerPath("file", single) }));
      const listed = await works(ctx);
      expect(listed.map((item) => item.title).sort()).toEqual(["乙系列", "单独的书", "甲系列"].sort());
      expect(Object.fromEntries(listed.map((item) => [item.title, item.outsideCount]))).toEqual({ 甲系列: 0, 乙系列: 0, 单独的书: 0 });
      // Nothing was copied into the profile or moved out of the folders.
      expect([walk(one), walk(two), walk(alone)]).toEqual(before);
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM file_locations WHERE hosted = 1").get()).toEqual({ n: 0 });
      // A location is a library path and a path inside it; the folder itself is not stored in it.
      expect(ctx.app.store.sqlite.prepare("SELECT fl.relative_path AS rel, fl.legacy_path AS legacy FROM file_locations fl JOIN library_paths lp ON lp.id = fl.library_path_id WHERE lp.path = ?").all(alone)).toEqual([{ rel: "单独的书.txt", legacy: null }]);
    } finally { ctx.app.close(); }
  }, 60_000);

  it("turns the resources of a removed library path into ones outside every path, and keeps them", async () => {
    const ctx = await startApp();
    try {
      const dir = scratch("remove");
      write(dir, "丙系列/第1话.txt", chapter("丙一"));
      const pathId = await addPath(ctx, dir);
      expect((await works(ctx))[0]).toMatchObject({ title: "丙系列", outsideCount: 0, resourceCount: 1 });
      ok(await run(ctx, "library.paths.remove", { pathId }));
      expect((await works(ctx))[0]).toMatchObject({ title: "丙系列", outsideCount: 1, resourceCount: 1 });
      expect(fs.existsSync(path.join(dir, "丙系列", "第1话.txt"))).toBe(true);
    } finally { ctx.app.close(); }
  });

  it("has no command that imports an arbitrary file or folder for the interface to offer: the interface only adds paths", async () => {
    // The interface keeps no "import" entry (A-69). The commands that read a file stay, for tests, the Agent-free tools and the scan itself;
    // what the person sees is added by a library path and a scan.
    const ui = fs.readFileSync(path.resolve(import.meta.dirname, "../../apps/desktop/src/renderer/App.tsx"), "utf8");
    expect(ui).not.toContain("ImportDialog");
    expect(fs.existsSync(path.resolve(import.meta.dirname, "../../apps/desktop/src/renderer/pages/import-dialog.tsx"))).toBe(false);
  });
});

describe("downloads are published into a library path (AT-79)", () => {
  it("makes the default download folder a library path of its own for each medium, once", async () => {
    const ctx = await boot();
    try {
      const first = okAcq<{ path: { id: string; path: string; mediaKind: string }; created: boolean }>(await runAcq(ctx, "library.paths.ensureDownloads", { mediaKind: "video" }));
      expect(first.created).toBe(true);
      expect(first.path).toMatchObject({ mediaKind: "video" });
      expect(first.path.path.startsWith(ctx.app.layout.partitions.downloads)).toBe(true);
      expect(fs.statSync(first.path.path).isDirectory()).toBe(true);
      const again = okAcq<{ path: { id: string }; created: boolean }>(await runAcq(ctx, "library.paths.ensureDownloads", { mediaKind: "video" }));
      expect(again).toMatchObject({ created: false, path: { id: first.path.id } });
      const comic = okAcq<{ path: { id: string; path: string } }>(await runAcq(ctx, "library.paths.ensureDownloads", { mediaKind: "comic" }));
      expect(comic.path.id).not.toBe(first.path.id);
      const paths = okAcq<{ paths: Array<{ id: string }> }>(await runAcq(ctx, "library.paths.list", {})).paths;
      expect(paths.map((item) => item.id).sort()).toEqual([first.path.id, comic.path.id].sort());
    } finally { ctx.app.close(); }
  });

  it("puts a finished download into that folder, and the library lists it from there", async () => {
    const ctx = await boot();
    try {
      await installFake(ctx);
      const folder = okAcq<{ path: { id: string; path: string } }>(await runAcq(ctx, "library.paths.ensureDownloads", { mediaKind: "novel" })).path;
      const text = chapter("下载来的一话");
      const added = okAcq<{ jobId: string }>(await runAcq(ctx, "acquisition.add", { magnet: MAGNET(HASH(31)), pathId: folder.id, subdir: "下载" }));
      await emit(ctx, "acq.metadata", { jobId: added.jobId, infoHash: HASH(31), name: "下载", totalLength: Buffer.byteLength(text), pieceLength: 16384, files: [{ index: 0, path: "下载/第1话.txt", length: Buffer.byteLength(text) }] });
      await waitState(ctx, added.jobId, ["choosing"]);
      okAcq(await runAcq(ctx, "acquisition.select", { jobId: added.jobId, indexes: [0] }));
      stage(ctx, added.jobId, "下载/第1话.txt", text);
      await emit(ctx, "acq.verifying", { jobId: added.jobId });
      await emit(ctx, "acq.verified", { jobId: added.jobId, files: [{ index: 0, path: "下载/第1话.txt", length: Buffer.byteLength(text) }], downloaded: 1000, uploaded: 0 });
      await ctx.app.acquisition.whenSettled(added.jobId);
      const job = okAcq<{ job: { state: string; entries: Array<{ resourceId: string }> } }>(await runAcq(ctx, "acquisition.get", { jobId: added.jobId })).job;
      expect(job.state).toBe("done");
      // The file is inside the library path, which is where the library finds it; the library has no other source of it.
      const published = path.join(folder.path, "下载", "下载", "第1话.txt");
      expect(fs.existsSync(published) || walk(folder.path).some((rel) => rel.endsWith("第1话.txt"))).toBe(true);
      const row = ctx.app.store.sqlite.prepare("SELECT lf.path_id AS pathId, lf.resource_id AS resourceId FROM library_files lf WHERE lf.resource_id = ?").get(job.entries[0]!.resourceId) as { pathId: string; resourceId: string };
      expect(row.pathId).toBe(folder.id);
      const detail = okAcq<Detail>(await runAcq(ctx, "works.get", { workId: (ctx.app.store.sqlite.prepare("SELECT work_id AS id FROM resources WHERE id = ?").get(row.resourceId) as { id: string }).id }));
      expect(detail.outsideCount).toBe(0);
    } finally { ctx.app.close(); }
  }, 60_000);
});
