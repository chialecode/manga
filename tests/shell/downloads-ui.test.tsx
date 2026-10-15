/** @vitest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { DownloadsPage } from "../../apps/desktop/src/renderer/pages/downloads/downloads-page.tsx";
import { HASH, MAGNET, addLibrary, boot, emit, engineLog, installFake, jobOf, run, stage, until, type Rig } from "../helpers/acquisition-app.ts";
import { FAKE_ENGINE_ID } from "../helpers/fake-engine.ts";
import { bridgeToApp } from "../helpers/ui-host.ts";

const i18n = createTranslator("zh-CN");
const rigs: Rig[] = [];
const disposers: Array<() => void> = [];
afterEach(() => { cleanup(); while (disposers.length) disposers.pop()!(); while (rigs.length) { try { rigs.pop()!.app.close(); } catch { /* closed */ } } });

const chapter = (title: string) => `${title}\n\n${"这是用于下载页测试的一段合成文字。".repeat(20)}\n`;
const FILES = [{ path: "季卷/第1话.txt", text: chapter("第一话") }, { path: "季卷/第2话.txt", text: chapter("第二话") }, { path: "季卷/说明.nfo", text: "not a book" }];

async function mount(options: { engine?: boolean; library?: boolean; acquisition?: Parameters<typeof boot>[0] extends infer O ? (O extends { acquisition?: infer A } ? A : never) : never } = {}) {
  const rig = await boot({ acquisition: options.acquisition });
  rigs.push(rig);
  if (options.engine !== false) await installFake(rig);
  const library = options.library === false ? null : await addLibrary(rig);
  const queue: string[] = [];
  const pick = vi.fn(async () => { const next = queue.shift(); return next ? { pathHandle: rig.app.registerPath("file", next), name: path.basename(next), mode: "file" as const } : null; });
  const bridge = bridgeToApp(rig, { pick });
  disposers.push(bridge.dispose);
  const errors: string[] = [];
  const notices: string[] = [];
  const openSettings = vi.fn();
  render(<DownloadsPage t={i18n.t} onOpenSettings={openSettings} onError={(message) => errors.push(message)} onNotice={(message) => notices.push(message)} />);
  await screen.findByTestId("page-downloads");
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  return { rig, library, errors, notices, openSettings, offerFile: (file: string) => queue.push(file) };
}
type Mounted = Awaited<ReturnType<typeof mount>>;
const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const text = (id: string) => screen.getByTestId(id).textContent ?? "";

async function addByMagnet(h: Mounted, n: number): Promise<string> {
  fireEvent.change(screen.getByTestId("downloads-add-magnet"), { target: { value: MAGNET(HASH(n)) } });
  fireEvent.change(screen.getByTestId("downloads-add-subdir"), { target: { value: "下载" } });
  await waitFor(() => expect((screen.getByTestId("downloads-add-submit") as HTMLButtonElement).disabled).toBe(false));
  click("downloads-add-submit");
  const row = await until(() => h.rig.app.store.sqlite.prepare("SELECT id FROM acquisition_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined, (value) => Boolean(value), 10_000, "the job to be added") as { id: string };
  await screen.findByTestId(`download-${row.id}`);
  return row.id;
}
async function metadata(h: Mounted, jobId: string, n: number) {
  await emit(h.rig, "acq.metadata", { jobId, infoHash: HASH(n), name: "季卷", totalLength: 3000, pieceLength: 16384, files: FILES.map((file, index) => ({ index, path: file.path, length: Buffer.byteLength(file.text) })) });
  await screen.findByTestId(`download-${jobId}-files`);
}

describe("the downloads page", () => {
  it("says there is no engine and offers nothing to start until one is installed and a library path exists", async () => {
    const h = await mount({ engine: false, library: false });
    expect(text("downloads-engine")).toContain("还没有下载引擎");
    expect((screen.getByTestId("downloads-add-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(text("downloads-add-no-path")).toContain("添加一个路径");
    expect(text("downloads-empty")).toContain("还没有下载");
    expect(text("downloads-legal")).toContain("有权获取");
    click("downloads-open-plugins");
    expect(h.openSettings).toHaveBeenCalledWith("plugins");
    expect(h.errors).toEqual([]);
  });

  it("adds a download from a magnet link, lists the torrent's files for choosing, and downloads only those chosen", async () => {
    const h = await mount();
    expect(text("downloads-engine")).toContain("下载引擎在运行");
    const jobId = await addByMagnet(h, 1);
    expect(text(`download-${jobId}-state`)).toBe("获取文件列表");
    expect(text(`download-${jobId}-name`)).toContain("正在获取文件列表");
    // The source is not shown anywhere on the page.
    expect(document.body.textContent).not.toContain("SECRETKEY123");
    expect((screen.getByTestId("downloads-add-magnet") as HTMLTextAreaElement).value).toBe("");
    await metadata(h, jobId, 1);
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("等你选择文件"));
    expect(text(`download-${jobId}-name`)).toBe("季卷");
    const boxes = [0, 1, 2].map((index) => screen.getByTestId(`download-${jobId}-file-${index}`) as HTMLInputElement);
    expect(boxes.map((box) => box.checked)).toEqual([true, true, true]);
    fireEvent.click(boxes[2]!);
    await waitFor(() => expect(text(`download-${jobId}-start`)).toContain("2 个"));
    click(`download-${jobId}-none`);
    await waitFor(() => expect((screen.getByTestId(`download-${jobId}-start`) as HTMLButtonElement).disabled).toBe(true));
    click(`download-${jobId}-all`);
    fireEvent.click(screen.getByTestId(`download-${jobId}-file-2`));
    click(`download-${jobId}-start`);
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("下载中"));
    expect((await engineLog(h.rig)).filter((call) => call.method === "engine.select").map((call) => call.params.indexes)).toEqual([[0, 1]]);
    expect(screen.getByTestId(`download-${jobId}-bar`)).toBeTruthy();
    expect(h.errors).toEqual([]);
  });

  it("shows speed while downloading, and what became of each file when it is done, then lets the record go", async () => {
    const h = await mount();
    const jobId = await addByMagnet(h, 2);
    await metadata(h, jobId, 2);
    click(`download-${jobId}-start`);
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("下载中"));
    await emit(h.rig, "acq.progress", { jobId, state: "downloading", downloaded: 1500, uploaded: 0, downloadSpeed: 2048, uploadSpeed: 512, peers: 3 });
    await waitFor(() => expect(text(`download-${jobId}-speed`)).toContain("3 个连接"));
    for (const [index, file] of FILES.entries()) stage(h.rig, jobId, file.path, file.text);
    await emit(h.rig, "acq.verified", { jobId, files: FILES.map((file, index) => ({ index, path: file.path, length: Buffer.byteLength(file.text) })), downloaded: 3000, uploaded: 0 });
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("已完成"), { timeout: 15_000 });
    expect(text(`download-${jobId}-result`)).toBe("已入库 2 个，资源库不认的 1 个");
    expect(h.notices.some((notice) => notice.includes("下载完成"))).toBe(true);
    await waitFor(() => expect(text(`download-${jobId}-file-0-status`)).toBe("已入库"));
    expect(text(`download-${jobId}-file-2-status`)).toBe("资源库不认这种文件，已放在文件夹里");
    // Sharing is off, and these files are not where a torrent file could be shared from.
    expect(text(`download-${jobId}-share-impossible`)).toContain("没法共享");
    click(`download-${jobId}-remove`);
    await waitFor(() => expect(screen.queryByTestId(`download-${jobId}`)).toBeNull());
    expect(text("downloads-empty")).toContain("还没有下载");
    expect(fs.existsSync(h.library!.dir)).toBe(true);
    expect((h.rig.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n).toBe(2);
  });

  it("names the stage a download stopped in and offers the retry that fits it", async () => {
    let room: number | null = 10;
    const h = await mount({ acquisition: { forceCopy: true, freeBytes: () => room } });
    const jobId = await addByMagnet(h, 3);
    await metadata(h, jobId, 3);
    room = null;
    click(`download-${jobId}-none`);
    fireEvent.click(screen.getByTestId(`download-${jobId}-file-0`));
    click(`download-${jobId}-start`);
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("下载中"));
    room = 10;
    stage(h.rig, jobId, FILES[0]!.path, FILES[0]!.text);
    await emit(h.rig, "acq.verified", { jobId, files: [{ index: 0, path: FILES[0]!.path, length: Buffer.byteLength(FILES[0]!.text) }], downloaded: 100, uploaded: 0 });
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("出错了"), { timeout: 15_000 });
    expect(text(`download-${jobId}-error`)).toContain("放入资源库阶段");
    expect(text(`download-${jobId}-error`)).toContain("磁盘空间不够");
    expect(screen.queryByTestId(`download-${jobId}-retry-import`)).toBeNull();
    room = null;
    click(`download-${jobId}-retry-publish`);
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("已完成"), { timeout: 15_000 });
  });

  it("asks before stopping a download, says what is kept, and stops it", async () => {
    const h = await mount();
    const jobId = await addByMagnet(h, 4);
    await metadata(h, jobId, 4);
    click(`download-${jobId}-cancel`);
    expect(text("download-cancel-text")).toContain("已经放进资源库并入库的文件不会动");
    click("download-cancel-keep");
    await waitFor(() => expect(screen.queryByTestId("download-cancel-confirm")).toBeNull());
    expect(text(`download-${jobId}-state`)).toBe("等你选择文件");
    click(`download-${jobId}-cancel`);
    click("download-cancel-do");
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("已停止"));
    expect(fs.existsSync(h.rig.app.acquisition.stagingOf(jobId))).toBe(false);
  });

  it("says why a download waits while the engine is off, and keeps resume off until it is back", async () => {
    const h = await mount();
    const jobId = await addByMagnet(h, 5);
    await metadata(h, jobId, 5);
    click(`download-${jobId}-start`);
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("下载中"));
    await run(h.rig, "plugin.disable", { pluginId: FAKE_ENGINE_ID });
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("已暂停"));
    expect(text(`download-${jobId}-paused`)).toContain("下载引擎暂时不可用");
    await waitFor(() => expect(text("downloads-engine")).toContain("没有在运行"));
    expect((screen.getByTestId(`download-${jobId}-resume`) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("downloads-add-submit") as HTMLButtonElement).disabled).toBe(true);
    await run(h.rig, "plugin.enable", { pluginId: FAKE_ENGINE_ID });
    await waitFor(() => expect(text(`download-${jobId}-state`)).toBe("下载中"), { timeout: 15_000 });
    expect((await jobOf(h.rig, jobId)).pausedReason).toBeNull();
    await until(() => text("downloads-engine"), (value) => value.includes("在运行"), 10_000, "the engine chip");
  });

  it("turns the refusals of the host into sentences, and takes a torrent file in place of a link", async () => {
    const h = await mount();
    fireEvent.change(screen.getByTestId("downloads-add-magnet"), { target: { value: "https://example.invalid/not-a-torrent" } });
    fireEvent.change(screen.getByTestId("downloads-add-subdir"), { target: { value: "../outside" } });
    click("downloads-add-submit");
    await waitFor(() => expect(h.errors).toEqual(["这个子文件夹名不能用：不要用 .. 或盘符，也不要用系统不允许的字符。"]));
    fireEvent.change(screen.getByTestId("downloads-add-subdir"), { target: { value: "" } });
    click("downloads-add-submit");
    await waitFor(() => expect(h.errors.at(-1)).toBe("这不是可用的磁力链接或种子文件。"));
    const torrent = path.join(h.library!.dir, "..", `fake-${Date.now()}.torrent`);
    fs.writeFileSync(torrent, "d4:infod4:name1:xee");
    h.offerFile(torrent);
    click("downloads-add-pick");
    await waitFor(() => expect(text("downloads-add-file")).toContain("fake-"));
    expect((screen.getByTestId("downloads-add-magnet") as HTMLTextAreaElement).disabled).toBe(true);
    click("downloads-add-submit");
    await waitFor(() => expect(h.notices).toContain("已添加下载。"));
    fs.rmSync(torrent, { force: true });
  });
});
