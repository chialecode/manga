/** @vitest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { PluginsPage } from "../../apps/desktop/src/renderer/pages/settings/plugins-page.tsx";
import { hiddenSettingsPages } from "../../apps/desktop/src/renderer/pages/settings/settings-view.tsx";
import { startApp } from "../helpers/app.ts";
import { bridgeToApp } from "../helpers/ui-host.ts";
import { makeKey, packageBytes, tmpDir, writePackage, type FixtureOptions } from "../helpers/plugin-fixtures.ts";

const i18n = createTranslator("zh-CN");
const first = makeKey("MANGA（第一方，测试）");
const stranger = makeKey("陌生发布者");
type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
const disposers: Array<() => void> = [];
afterEach(() => { cleanup(); while (disposers.length) disposers.pop()!(); while (apps.length) { try { apps.pop()!.app.close(); } catch { /* closed */ } } });

/** A real application whose plugins start as real processes, and the page talking to it; `pick` answers with what the test queued. */
async function boot(bundledDir?: string) {
  const ctx = await startApp({ options: { plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], bundledDir, limits: { readyMs: 2000, graceMs: 200, pingMs: 100 } } } });
  apps.push(ctx);
  const queue: Array<{ mode: "file" | "directory"; path: string }> = [];
  const pick = vi.fn(async (request: { mode: "file" | "directory" }) => {
    const next = queue.shift();
    if (!next) return null;
    return { pathHandle: ctx.app.registerPath(request.mode === "directory" ? "directory" : "file", next.path), name: path.basename(next.path), mode: request.mode };
  });
  const bridge = bridgeToApp(ctx, { pick });
  disposers.push(bridge.dispose);
  const errors: string[] = [];
  const notices: string[] = [];
  const modulesChanged = vi.fn();
  render(<PluginsPage t={i18n.t} formatDate={(iso) => iso.slice(0, 10)} onModulesChanged={modulesChanged} onError={(message) => errors.push(message)} onNotice={(message) => notices.push(message)} />);
  await screen.findByTestId("settings-page-plugins");
  await screen.findByTestId("plugins-installed");
  return {
    ctx, errors, notices, modulesChanged, bridge,
    offer: (file: string) => queue.push({ mode: "file", path: file }),
    offerFolder: (folder: string) => queue.push({ mode: "directory", path: folder }),
  };
}
type Booted = Awaited<ReturnType<typeof boot>>;
const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const text = (id: string) => screen.getByTestId(id).textContent ?? "";

async function installFrom(h: Booted, options: FixtureOptions) {
  h.offer(writePackage(options));
  click("plugins-from-file");
  await screen.findByTestId("plugin-install");
  for (const permission of options.permissions ?? []) click(`plugin-confirm-${permission}`);
  click("plugin-install-do");
  await waitFor(() => expect(screen.queryByTestId("plugin-install")).toBeNull());
}

describe("the plugin settings page", () => {
  it("is left out of the navigation when the plugin feature is off", () => {
    expect(hiddenSettingsPages(new Set(["agent"])).has("plugins")).toBe(true);
    expect(hiddenSettingsPages(new Set(["agent", "plugins"])).has("plugins")).toBe(false);
  });

  it("starts with nothing installed, says what a plugin process is and is not, and lists the application's own key that cannot be removed", async () => {
    const h = await boot();
    expect(text("plugins-none")).toContain("还没有安装任何插件");
    expect(text("plugins-trust-note")).toContain("不是安全沙箱");
    expect(text("plugins-bundled-none")).toContain("没有自带插件");
    const keys = within(screen.getByTestId("plugins-keys"));
    expect(await keys.findByText("MANGA（第一方，测试）")).toBeTruthy();
    expect(keys.getByText("应用自带")).toBeTruthy();
    expect(screen.queryByTestId("plugin-leftovers")).toBeNull();
    expect(h.errors).toEqual([]);
  });

  it("reads a package, shows who signed it and what it asks for, and installs only after every permission is ticked", async () => {
    const h = await boot();
    h.offer(writePackage({ key: first, permissions: ["network", "files"], facets: ["acquisition"], provides: [{ slot: "acquisition.engine", id: "demo-engine" }] }));
    click("plugins-from-file");
    await screen.findByTestId("plugin-install");
    expect(text("plugin-install-name")).toBe("演示插件 · 版本 1.0.0");
    expect(text("plugin-install-publisher")).toContain("演示发布者（demo）");
    expect(text("plugin-install-trust")).toContain("第一方");
    expect(text("plugin-install-fingerprint")).toMatch(/指纹 ([a-f0-9]{4} ){7}[a-f0-9]{4}/);
    const permissions = within(screen.getByTestId("plugin-install-permissions")).getAllByRole("checkbox");
    expect(permissions).toHaveLength(2);
    const install = screen.getByTestId("plugin-install-do") as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    click("plugin-confirm-network");
    expect(install.disabled).toBe(true);
    click("plugin-confirm-files");
    expect(install.disabled).toBe(false);
    // Nothing has been installed by reading.
    expect((h.ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM plugins").get() as { n: number }).n).toBe(0);
    click("plugin-install-do");
    const row = await screen.findByTestId("plugin-demo.tool");
    await waitFor(() => expect(row.getAttribute("data-state")).toBe("running"));
    expect(row.getAttribute("data-trust")).toBe("first-party");
    expect(text("plugin-demo.tool-meta")).toBe("版本 1.0.0 · 发布者 演示发布者");
    expect(text("plugin-demo.tool-permissions")).toContain("联网");
    expect(text("plugin-demo.tool-permissions")).toContain("读写你授权的文件夹");
    expect(h.notices).toEqual(["已安装并启用 演示插件"]);
    expect(h.modulesChanged).toHaveBeenCalled();
  });

  it("refuses a package from a publisher that is not trusted, and says why instead of offering to install it (AT-34)", async () => {
    const h = await boot();
    h.offer(writePackage({ key: stranger, publisher: { id: "manga", name: "MANGA（第一方）" } }));
    click("plugins-from-file");
    await screen.findByTestId("plugin-install");
    expect(screen.getByTestId("plugin-install-refused").getAttribute("data-reason")).toBe("untrusted");
    expect(text("plugin-install-refused")).toContain("发布者的密钥不在你信任的名单里");
    expect(text("plugin-install-refused")).toContain("不会安装");
    expect(text("plugin-install-trust")).toContain("不受信任");
    expect((screen.getByTestId("plugin-install-do") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("plugin-install-permissions")).toBeNull();
    click("plugin-install-cancel");
    await waitFor(() => expect(screen.queryByTestId("plugin-install")).toBeNull());
    expect(h.ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM plugins").get()).toEqual({ n: 0 });
  });

  it("says a package that was changed after signing, or is not a package, cannot be read", async () => {
    const h = await boot();
    const dir = tmpDir();
    const { unzipSync, zipSync, strToU8 } = await import("fflate");
    const tampered = path.join(dir, "tampered.manga-plugin");
    fs.writeFileSync(tampered, zipSync({ ...unzipSync(packageBytes({ key: first })), "payload/main.mjs": strToU8("process.exit(0)") }));
    h.offer(tampered);
    click("plugins-from-file");
    await screen.findByTestId("plugin-install");
    expect(screen.getByTestId("plugin-install-refused").getAttribute("data-reason")).toBe("signature");
    expect(text("plugin-install-refused")).toContain("签名和插件包的内容对不上");
    click("plugin-install-cancel");
    const junk = path.join(dir, "junk.manga-plugin");
    fs.writeFileSync(junk, "not a zip");
    h.offer(junk);
    click("plugins-from-file");
    await waitFor(() => expect(h.errors).toEqual(["这不是一个能读取的插件包。"]));
    expect(screen.queryByTestId("plugin-install")).toBeNull();
  });

  it("installs from a publisher the person chose to trust, and stops it when the person takes the key away", async () => {
    const h = await boot();
    click("plugins-key-add");
    await screen.findByTestId("plugin-key-add");
    const add = screen.getByTestId("plugin-key-add-do") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("plugin-key-label"), { target: { value: "朋友的发布者" } });
    fireEvent.change(screen.getByTestId("plugin-key-public"), { target: { value: stranger.publicKey } });
    expect(add.disabled).toBe(false);
    click("plugin-key-add-do");
    await waitFor(() => expect(h.notices).toContain("已信任 朋友的发布者"));
    const added = (await screen.findAllByText("朋友的发布者"))[0]!;
    expect(added).toBeTruthy();
    await installFrom(h, { key: stranger });
    const row = await screen.findByTestId("plugin-demo.tool");
    await waitFor(() => expect(row.getAttribute("data-state")).toBe("running"));
    expect(row.getAttribute("data-trust")).toBe("user");
    const keyId = (h.ctx.app.store.sqlite.prepare("SELECT key_id AS id FROM plugin_keys").get() as { id: string }).id;
    click(`plugin-key-${keyId}-remove`);
    await screen.findByTestId("plugin-key-remove");
    expect(text("plugin-key-remove")).toContain("立刻停止");
    click("plugin-key-remove-do");
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("untrusted"));
    expect(text("plugin-demo.tool-state")).toBe("发布者不再受信任");
    expect(text("plugin-demo.tool-toggle")).toBe("停用");
    expect(h.ctx.app.pluginRuntime.info("demo.tool").state).toBe("stopped");
    expect(screen.queryByTestId(`plugin-key-${keyId}-remove`)).toBeNull();
  });

  it("turns a plugin off and on, and tells what went wrong when it cannot start", async () => {
    const h = await boot();
    await installFrom(h, { key: first });
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("running"));
    expect(text("plugin-demo.tool-toggle")).toBe("停用");
    click("plugin-demo.tool-toggle");
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("disabled"));
    expect(h.notices.at(-1)).toBe("已停用 演示插件");
    expect(text("plugin-demo.tool-toggle")).toBe("启用");
    click("plugin-demo.tool-toggle");
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("running"));
    // The installed files are changed on disk: it will not start, and the page says so.
    click("plugin-demo.tool-toggle");
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("disabled"));
    fs.writeFileSync(path.join(h.ctx.profileRoot, "data", "plugins", "demo.tool", "1.0.0", "payload", "main.mjs"), "process.exit(0)");
    click("plugin-demo.tool-toggle");
    await waitFor(() => expect(h.errors).toEqual(["已安装的文件和签名对不上，不会运行。请重新安装。"]));
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("failed"));
    expect(text("plugin-demo.tool-error")).toContain("原因：");
  });

  it("marks a permission an upgrade adds as new, keeps the old version to go back to, and goes back", async () => {
    const h = await boot();
    await installFrom(h, { key: first, version: "1.0.0", permissions: ["network"] });
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("running"));
    h.offer(writePackage({ key: first, version: "1.1.0", permissions: ["network", "files"] }));
    click("plugin-demo.tool-upgrade");
    await screen.findByTestId("plugin-install");
    expect(text("plugin-install-from")).toContain("将从 1.0.0 升级到 1.1.0");
    const files = screen.getByTestId("plugin-install-permissions").querySelector('[data-permission="files"]')!;
    expect(files.getAttribute("data-new")).toBe("yes");
    expect(files.textContent).toContain("新增");
    expect(screen.getByTestId("plugin-install-permissions").querySelector('[data-permission="network"]')!.getAttribute("data-new")).toBe("no");
    expect(screen.getByTestId("plugin-install-do").textContent).toBe("升级");
    click("plugin-confirm-network");
    expect((screen.getByTestId("plugin-install-do") as HTMLButtonElement).disabled).toBe(true);
    click("plugin-confirm-files");
    click("plugin-install-do");
    await waitFor(() => expect(text("plugin-demo.tool-meta")).toContain("版本 1.1.0"));
    expect(h.notices.at(-1)).toBe("已升级 演示插件");
    expect(text("plugin-demo.tool-rollback")).toBe("退回到 1.0.0");
    click("plugin-demo.tool-rollback");
    await waitFor(() => expect(text("plugin-demo.tool-meta")).toContain("版本 1.0.0"));
    await waitFor(() => expect(h.notices.at(-1)).toBe("演示插件 已退回到 1.0.0"));
  });

  it("tells a person when a new version could not start and the old one was put back", async () => {
    const h = await boot();
    await installFrom(h, { key: first, version: "1.0.0" });
    await installFrom(h, { key: first, version: "2.0.0", mode: "crash-start" });
    await waitFor(() => expect(h.notices.at(-1)).toBe("新版本启动失败，已自动退回到原来的版本。"));
    expect(text("plugin-demo.tool-meta")).toContain("版本 1.0.0");
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("running"));
  });

  it("uninstalls keeping what the plugin kept, which can be exported and then deleted", async () => {
    const h = await boot();
    await installFrom(h, { key: first });
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("running"));
    await h.ctx.app.pluginRuntime.call("demo.tool", "write", { name: "state.json", text: "{}" });
    click("plugin-demo.tool-toggle");
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("disabled"));
    await waitFor(() => expect(text("plugin-demo.tool-permissions")).toContain("留下的数据"));
    click("plugin-demo.tool-uninstall");
    await screen.findByTestId("plugin-uninstall");
    expect((screen.getByTestId("plugin-uninstall-keep") as HTMLInputElement).checked).toBe(true);
    click("plugin-uninstall-do");
    await waitFor(() => expect(screen.queryByTestId("plugin-demo.tool")).toBeNull());
    expect(h.notices.at(-1)).toBe("已卸载 演示插件，它存下的数据保留着。");
    const left = await screen.findByTestId("plugin-left-demo.tool");
    expect(left.textContent).toContain("演示插件");
    const out = tmpDir();
    h.offerFolder(out);
    click("plugin-left-demo.tool-export");
    await waitFor(() => expect(h.notices.at(-1)).toMatch(/^已导出到 demo\.tool\.plugin-data.*\.zip$/));
    expect(fs.readdirSync(out)).toHaveLength(1);
    click("plugin-left-demo.tool-delete");
    await screen.findByTestId("plugin-delete-data");
    click("plugin-delete-data-do");
    await waitFor(() => expect(screen.queryByTestId("plugin-left-demo.tool")).toBeNull());
    expect(h.notices.at(-1)).toBe("已删除数据");
  });

  it("uninstalls and deletes the data together when asked", async () => {
    const h = await boot();
    await installFrom(h, { key: first });
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("running"));
    await h.ctx.app.pluginRuntime.call("demo.tool", "write", { name: "state.json", text: "{}" });
    click("plugin-demo.tool-toggle");
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("disabled"));
    await waitFor(() => expect(text("plugin-demo.tool-permissions")).toContain("留下的数据"));
    click("plugin-demo.tool-uninstall");
    await screen.findByTestId("plugin-uninstall");
    click("plugin-uninstall-drop");
    click("plugin-uninstall-do");
    await waitFor(() => expect(screen.queryByTestId("plugin-demo.tool")).toBeNull());
    expect(h.notices.at(-1)).toBe("已卸载 演示插件");
    expect(screen.queryByTestId("plugins-leftovers")).toBeNull();
    expect(fs.existsSync(path.join(h.ctx.profileRoot, "data", "plugin-data", "demo.tool"))).toBe(false);
  });

  it("offers what the application carries, installs it by its id after the same confirmation, and shows it as installed", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "demo-tool.manga-plugin"), packageBytes({ key: first, permissions: ["network"], version: "3.0.0" }));
    const h = await boot(dir);
    const row = await screen.findByTestId("plugin-bundled-demo.tool");
    expect(row.textContent).toContain("版本 3.0.0");
    expect(screen.queryByTestId("plugin-demo.tool")).toBeNull();
    click("plugin-bundled-demo.tool-install");
    await screen.findByTestId("plugin-install");
    expect(text("plugin-install-trust")).toContain("第一方");
    click("plugin-confirm-network");
    click("plugin-install-do");
    await waitFor(() => expect(screen.getByTestId("plugin-demo.tool").getAttribute("data-state")).toBe("running"));
    await waitFor(() => expect((screen.getByTestId("plugin-bundled-demo.tool-install") as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("plugin-bundled-demo.tool-installed")).toBeTruthy();
    expect(h.errors).toEqual([]);
  });
});
