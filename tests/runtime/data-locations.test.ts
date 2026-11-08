import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MangaProductApp, TestVault } from "@manga/app-core";
import { peekSchemaMeta } from "@manga/storage-drizzle";
import { seedVideo } from "../helpers/media-seed.ts";
import { readPointer, resolveLaunchLayout, UPGRADE_MARKER } from "../../packages/app-core/src/locations.ts";

// AT-148 / AT-149 / 计划 4.9: the application's own data under %LOCALAPPDATA%, the person's files under Documents, downloads under Downloads; an old
// profile in Documents is moved on the first start (only the application's data; the person's files stay and are named by the pointer), checked before
// the switch, and on any failure the old place keeps working. Everything here is a synthetic profile in a temporary folder.

const VARS = ["MANGA_PROFILE_ROOT", "MANGA_POINTER_FILE", "MANGA_DOCUMENTS_DIR", "MANGA_DOWNLOADS_DIR", "LOCALAPPDATA", "USERPROFILE", "HOME", ...["DATA", "WORKS", "DOWNLOADS"].map((name) => `MANGA_DIR_${name}`)];
let saved: Record<string, string | undefined> = {};
let machine: { root: string; documents: string; downloads: string; local: string; roaming: string; home: string };
beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) if (name !== "USERPROFILE" && name !== "HOME") delete process.env[name];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-locations-"));
  machine = { root, documents: path.join(root, "D", "Docs"), downloads: path.join(root, "Downloads"), local: path.join(root, "home", "AppData", "Local"), roaming: path.join(root, "home", "AppData", "Roaming"), home: path.join(root, "home") };
  for (const dir of [machine.documents, machine.downloads, machine.local, machine.roaming]) fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  for (const name of VARS) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  fs.rmSync(machine.root, { recursive: true, force: true });
});

const request = (channel: "release" | "development" = "release") => ({ channel, documentsDir: machine.documents, downloadsDir: machine.downloads, localAppDataDir: machine.local });
const filesUnder = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);

/** An old profile as versions before the split made it: everything under <Documents>\manga\<channel>, a work's note file written, a pointer beside it. */
async function oldProfile(channel: "release" | "development" = "release", options: { root?: string; overrides?: Record<string, string> } = {}) {
  const root = options.root ?? path.join(machine.documents, "manga", channel);
  const pointerPath = path.join(machine.documents, "manga", channel, "launcher", "pointer.json");
  const app = new MangaProductApp({ profileRoot: root, channel, pointerPath, documentsDir: machine.documents, hostId: "old", vault: new TestVault("old-secret") });
  await app.start();
  const owner = app.issueOwnerGrant({ kind: "user", id: "u" });
  const video = seedVideo(app, { title: "旧的一集", file: path.join(machine.root, "library", "old-01.mkv") });
  const created = await app.call({ kind: "user", id: "u" }, { commandId: "notes.create", idempotencyKey: "old-note", input: { title: "旧的笔记", text: "升级以后还要能打开。", resourceId: video.resourceId } }, owner.handle);
  expect(created.status, JSON.stringify(created)).toBe("ok");
  app.noteFiles.flush();
  const noteFile = (app.store.sqlite.prepare("SELECT id FROM work_files WHERE kind = 'note'").all() as Array<{ id: string }>).map((row) => app.workFolders.pathOf(row.id)!)[0]!;
  expect(fs.existsSync(noteFile)).toBe(true);
  app.close();
  if (options.overrides) fs.writeFileSync(pointerPath, JSON.stringify({ ...readPointer(pointerPath), partitions: options.overrides }));
  return { root, pointerPath, noteFile, objectId: (created.value as { objectId: string }).objectId };
}

describe("where a new installation keeps things (AT-148)", () => {
  it("puts the application's data under LOCALAPPDATA and the person's files under the registered Documents and Downloads folders, per channel, all lowercase", () => {
    for (const [channel, folder] of [["release", "manga"], ["development", "manga-dev"]] as const) {
      const layout = resolveLaunchLayout(request(channel));
      expect(layout.appRoot).toBe(path.join(machine.local, folder));
      expect(layout.filesRoot).toBe(path.join(machine.documents, folder));
      expect(layout.pointerPath).toBe(path.join(machine.local, folder, "launcher", "pointer.json"));
      for (const name of ["data", "cache", "logs", "backups", "runtime"] as const) expect(layout.partitions[name]).toBe(path.join(machine.local, folder, name));
      for (const name of ["works", "projects", "attachments", "resources", "exports"] as const) expect(layout.partitions[name]).toBe(path.join(machine.documents, folder, name));
      expect(layout.partitions.downloads).toBe(path.join(machine.downloads, folder));
      expect(layout.overrides).toEqual({});
      expect(layout.upgrade).toBeUndefined();
    }
  });

  it("renames an existing uppercase MANGA folder in Documents or Downloads to lowercase manga, and rewrites uppercase overrides", () => {
    fs.mkdirSync(path.join(machine.documents, "MANGA", "release", "works"), { recursive: true });
    fs.mkdirSync(path.join(machine.downloads, "MANGA"), { recursive: true });
    const pointerPath = path.join(machine.local, "manga", "launcher", "pointer.json");
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    fs.writeFileSync(pointerPath, JSON.stringify({
      profileRoot: path.join(machine.local, "manga"),
      channel: "release",
      revision: 1,
      partitions: { works: path.join(machine.documents, "MANGA", "release", "works"), downloads: path.join(machine.downloads, "MANGA") },
    }));
    const layout = resolveLaunchLayout(request("release"));
    expect(fs.readdirSync(machine.documents)).toEqual(["manga"]);
    expect(fs.readdirSync(machine.downloads)).toEqual(["manga"]);
    expect(layout.partitions.works).toBe(path.join(machine.documents, "manga", "release", "works"));
    expect(layout.partitions.downloads).toBe(path.join(machine.downloads, "manga"));
  });

  it("writes nothing to the roaming profile or the home folder, and the Documents folder may be on another drive", async () => {
    process.env.USERPROFILE = machine.home;
    process.env.HOME = machine.home;
    const app = new MangaProductApp({ ...request("release"), hostId: "fresh", vault: new TestVault("s") });
    await app.start();
    expect(app.layout.partitions.works.startsWith(machine.documents)).toBe(true);
    app.close();
    expect(filesUnder(machine.roaming)).toEqual([]);
    expect(fs.readdirSync(machine.home).sort()).toEqual(["AppData"]);
    expect(fs.readdirSync(path.join(machine.home, "AppData", "Local"))).toEqual(["manga"]);
    expect(readPointer(path.join(machine.local, "manga", "launcher", "pointer.json"))).toMatchObject({ profileRoot: path.join(machine.local, "manga"), channel: "release" });
    // The next start reads the same places through the pointer.
    const again = resolveLaunchLayout(request("release"));
    expect(again.partitions).toEqual(app.layout.partitions);
  });

  it("leaves the Downloads folder alone on a start and stages downloads in the application's cache, moving what an earlier version staged there", async () => {
    for (const channel of ["release", "development"] as const) {
      const folder = channel === "release" ? "manga" : "manga-dev";
      const app = new MangaProductApp({ ...request(channel), hostId: "fresh", vault: new TestVault("s") });
      await app.start();
      expect(fs.existsSync(path.join(machine.local, folder, "cache", "acquisition"))).toBe(true);
      app.close();
      expect(fs.readdirSync(machine.downloads)).toEqual([]);
    }
    // An earlier version staged a job under <Downloads>mangaacquisition: it moves to the cache, and the emptied folders go.
    const legacyJob = path.join(machine.downloads, "manga", "acquisition", "job-1", "data");
    fs.mkdirSync(legacyJob, { recursive: true });
    fs.writeFileSync(path.join(legacyJob, "part.bin"), "partial bytes");
    const app = new MangaProductApp({ ...request("release"), hostId: "fresh", vault: new TestVault("s") });
    await app.start();
    app.close();
    expect(fs.readFileSync(path.join(machine.local, "manga", "cache", "acquisition", "job-1", "data", "part.bin"), "utf8")).toBe("partial bytes");
    expect(fs.readdirSync(machine.downloads)).toEqual([]);
  });

  it("falls back to the home folder when LOCALAPPDATA is missing, keeps the variables and the person's overrides, and a test still needs its own root", () => {
    process.env.USERPROFILE = machine.home;
    process.env.HOME = machine.home;
    const layout = resolveLaunchLayout({ channel: "release", documentsDir: machine.documents, downloadsDir: machine.downloads });
    expect(layout.appRoot).toBe(path.join(os.homedir(), "AppData", "Local", "manga"));
    process.env.MANGA_DIR_WORKS = path.join(machine.root, "elsewhere", "works");
    expect(resolveLaunchLayout(request()).partitions.works).toBe(path.join(machine.root, "elsewhere", "works"));
    delete process.env.MANGA_DIR_WORKS;
    // A root the person chose keeps every partition under it, as before.
    const chosen = path.join(machine.root, "chosen");
    expect(resolveLaunchLayout({ ...request(), profileRoot: chosen }).partitions.works).toBe(path.join(chosen, "works"));
    expect(() => resolveLaunchLayout({ channel: "test", documentsDir: machine.documents })).toThrow(/isolated profile root/);
  });

  it("isolates test installation identities under manga-test and manga-dev-test while keeping their release/development channel (计划 4.8)", async () => {
    // Even if a real legacy profile exists in Documents\manga\release, a test identity never touches or migrates it.
    const realOld = await oldProfile("release");
    for (const [channel, folder] of [["release", "manga-test"], ["development", "manga-dev-test"]] as const) {
      const layout = resolveLaunchLayout({ ...request(channel), testIdentity: true });
      expect(layout.channel).toBe(channel);
      expect(layout.appRoot).toBe(path.join(machine.local, folder));
      expect(layout.filesRoot).toBe(path.join(machine.documents, folder));
      expect(layout.pointerPath).toBe(path.join(machine.local, folder, "launcher", "pointer.json"));
      expect(layout.partitions.data).toBe(path.join(machine.local, folder, "data"));
      expect(layout.partitions.works).toBe(path.join(machine.documents, folder, "works"));
      expect(layout.partitions.downloads).toBe(path.join(machine.downloads, folder));
      expect(layout.upgrade).toBeUndefined();
    }
    expect(fs.existsSync(path.join(realOld.root, "RELOCATED.json"))).toBe(false);
  });
});

describe("moving a profile from where earlier versions kept it (AT-149)", () => {
  it("copies the application's data, checks it, names the person's files where they are, marks the old place and deletes nothing", async () => {
    const old = await oldProfile("release");
    const before = filesUnder(old.root).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm")).sort();
    const layout = resolveLaunchLayout(request("release"));
    const appRoot = path.join(machine.local, "manga");
    expect(layout.upgrade).toMatchObject({ state: "migrated", from: old.root, to: appRoot, marked: true });
    expect(layout.upgrade!.files).toBeGreaterThan(0);
    expect(layout.upgrade!.carried).toEqual(expect.arrayContaining(["works"]));
    expect(layout.defaultRoot).toBe(appRoot);
    expect(layout.partitions.data).toBe(path.join(appRoot, "data"));
    expect(layout.partitions.works).toBe(path.join(old.root, "works"));
    expect(layout.overrides.works).toBe(path.join(old.root, "works"));
    expect(fs.existsSync(path.join(appRoot, UPGRADE_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(appRoot, "cache"))).toBe(false);
    // Nothing old went: every file is still there, now with the marker beside it.
    const after = filesUnder(old.root).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"));
    for (const name of before) expect(after).toContain(name);
    expect(fs.existsSync(path.join(old.root, "RELOCATED.json"))).toBe(true);
    expect(peekSchemaMeta(path.join(old.root, "data"), "relocatedRoot")).toBe(appRoot);
    // An older version opening the old place through its own pointer follows the marker.
    expect(resolveLaunchLayout({ ...request("release"), pointerPath: old.pointerPath }).defaultRoot).toBe(appRoot);
    // The application opens the moved library, and the note file in the old works folder opens as before.
    const app = new MangaProductApp({ layout, hostId: "new", vault: new TestVault("old-secret") });
    await app.start();
    try {
      const row = app.store.sqlite.prepare("SELECT id FROM work_files WHERE kind = 'note'").get() as { id: string };
      expect(app.workFolders.pathOf(row.id)).toBe(old.noteFile);
      expect(fs.readFileSync(old.noteFile, "utf8")).toContain("升级以后还要能打开");
      // Settings offers to clean the old place: only the application's data goes, after the person asks; their files and the marker stay.
      const owner = app.issueOwnerGrant({ kind: "user", id: "u" });
      const call = (commandId: string, key: string) => app.call({ kind: "user", id: "u" }, { commandId, idempotencyKey: key, input: {} }, owner.handle);
      const offered = (await call("settings.get", "s1")).value as { legacyLocation: { root: string; bytes: number; cleaned: boolean } };
      expect(offered.legacyLocation).toMatchObject({ root: old.root, cleaned: false });
      expect(offered.legacyLocation.bytes).toBeGreaterThan(0);
      const cleaned = await call("settings.cleanLegacyLocation", "c1");
      expect(cleaned.status, JSON.stringify(cleaned)).toBe("ok");
      expect(fs.existsSync(path.join(old.root, "data"))).toBe(false);
      expect(fs.existsSync(path.join(old.root, "launcher"))).toBe(false);
      expect(fs.existsSync(old.noteFile)).toBe(true);
      expect(fs.existsSync(path.join(old.root, "RELOCATED.json"))).toBe(true);
      expect(((await call("settings.get", "s2")).value as { legacyLocation: { cleaned: boolean } }).legacyLocation.cleaned).toBe(true);
      expect((await call("settings.cleanLegacyLocation", "c2")).status).toBe("error");
    } finally {
      app.close();
    }
    // The next start finds the new pointer and moves nothing.
    expect(resolveLaunchLayout(request("release")).upgrade).toBeUndefined();
  });

  it("carries the overrides of the old pointer and moves a root the person had chosen", async () => {
    const custom = path.join(machine.root, "E", "MyManga");
    const kept = path.join(machine.root, "E", "Downloads-kept");
    fs.mkdirSync(kept, { recursive: true });
    const old = await oldProfile("development", { root: custom, overrides: { downloads: kept } });
    const layout = resolveLaunchLayout(request("development"));
    expect(layout.upgrade).toMatchObject({ state: "migrated", from: custom, to: path.join(machine.local, "manga-dev") });
    expect(layout.partitions.downloads).toBe(kept);
    expect(layout.partitions.works).toBe(path.join(custom, "works"));
    expect(readPointer(layout.pointerPath)?.partitions).toMatchObject({ downloads: kept, works: path.join(custom, "works") });
    expect(fs.existsSync(old.noteFile)).toBe(true);
  });

  it("keeps the old place working when the copy fails or there is no room, writes no new pointer and tries again next time", async () => {
    const old = await oldProfile("release");
    const appRoot = path.join(machine.local, "manga");
    // A link inside a partition, which a copy never follows, stands for a copy that fails half way (the data partition is copied first).
    fs.mkdirSync(path.join(old.root, "logs", "locked.log"), { recursive: true });
    fs.symlinkSync(path.join(old.root, "data"), path.join(old.root, "logs", "locked.log", "loop"), "junction");
    const failed = resolveLaunchLayout(request("release"));
    expect(failed.upgrade).toMatchObject({ state: "failed", from: old.root });
    expect(failed.defaultRoot).toBe(old.root);
    expect(failed.partitions.data).toBe(path.join(old.root, "data"));
    expect(failed.pointerPath).toBe(old.pointerPath);
    expect(fs.existsSync(path.join(appRoot, "launcher", "pointer.json"))).toBe(false);
    expect(fs.existsSync(path.join(appRoot, "data"))).toBe(false);
    expect(fs.existsSync(path.join(old.root, "RELOCATED.json"))).toBe(false);
    expect(peekSchemaMeta(path.join(old.root, "data"), "relocatedRoot")).toBeUndefined();
    // The old library opens as before.
    const app = new MangaProductApp({ layout: failed, hostId: "old-again", vault: new TestVault("old-secret") });
    await app.start();
    app.close();
    // Once the cause is gone the next start moves it.
    fs.rmSync(path.join(old.root, "logs", "locked.log"), { recursive: true, force: true });
    expect(resolveLaunchLayout(request("release")).upgrade).toMatchObject({ state: "migrated" });
  });

  it("is killed during the copy: the old place still works, and the next start clears the half copy and finishes", async () => {
    const old = await oldProfile("release");
    const appRoot = path.join(machine.local, "manga");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { resolveLaunchLayout } from '@manga/app-core'; resolveLaunchLayout(${JSON.stringify({ ...request("release"), crashAt: "upgrade-copy" })});`], { encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env } });
    expect(child.status, child.stderr).toBe(99);
    expect(fs.existsSync(path.join(appRoot, UPGRADE_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, "launcher", "pointer.json"))).toBe(false);
    expect(peekSchemaMeta(path.join(old.root, "data"), "relocatedRoot")).toBeUndefined();
    // A file left by the cut copy that the source does not have is cleared before the retry.
    fs.writeFileSync(path.join(appRoot, "data", "half-copied.tmp"), "x");
    const layout = resolveLaunchLayout(request("release"));
    expect(layout.upgrade).toMatchObject({ state: "migrated" });
    expect(fs.existsSync(path.join(appRoot, "data", "half-copied.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(appRoot, UPGRADE_MARKER))).toBe(false);
  });

  it("does not overwrite a library already in the new place that no pointer names", async () => {
    const old = await oldProfile("release");
    const appRoot = path.join(machine.local, "manga");
    fs.mkdirSync(path.join(appRoot, "data"), { recursive: true });
    new Database(path.join(appRoot, "data", "manga.sqlite")).close();
    const layout = resolveLaunchLayout(request("release"));
    expect(layout.upgrade).toMatchObject({ state: "failed", reason: "target-occupied" });
    expect(layout.defaultRoot).toBe(old.root);
  });

  it("stops before copying when the disk has no room", async () => {
    const old = await oldProfile("release");
    const statfs = fs.statfsSync;
    (fs as { statfsSync: unknown }).statfsSync = () => ({ bavail: 1, bsize: 4096 });
    try {
      const layout = resolveLaunchLayout(request("release"));
      expect(layout.upgrade).toMatchObject({ state: "failed", reason: "no-space", files: 0 });
      expect(layout.defaultRoot).toBe(old.root);
      expect(fs.existsSync(path.join(machine.local, "manga", "data"))).toBe(false);
    } finally {
      (fs as { statfsSync: unknown }).statfsSync = statfs;
    }
  });
});
