import { describe, expect, it } from "vitest";
import { createTranslator } from "@manga/i18n";
import { startApp } from "./helpers.ts";

describe("P4 Chinese workspace flows", () => {
  it("shares one session between the agent page and copilot entry", async () => {
    const { app, actor, grant } = await startApp();
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "s1", input: { title: "共享" } }, grant.handle);
    const ws = await app.call(actor, { commandId: "workspace.get", idempotencyKey: "ws", input: {} }, grant.handle);
    expect(ws.status).toBe("ok");
    expect((ws.value?.sessions as Array<{ id: string }>)[0]?.id).toBe(session.value?.id);
    expect(ws.value?.uiFacets).toEqual(expect.arrayContaining(["agent", "library", "settings"]));
    app.close();
  });

  it("allows skipping AI and still using inventory", async () => {
    const { app, actor, grant } = await startApp();
    const skipped = await app.call(actor, { commandId: "settings.skipAi", idempotencyKey: "skip", input: {} }, grant.handle);
    expect(skipped.value?.skipped).toBe(true);
    await app.call(actor, { commandId: "library.importText", idempotencyKey: "inv-imp", input: { title: "可见", bytes: [...Buffer.from("内容")] } }, grant.handle);
    const overview = await app.call(actor, { commandId: "inventory.overview", idempotencyKey: "ov", input: {} }, grant.handle);
    expect(overview.status).toBe("ok");
    expect((overview.value?.totals as { resource: { count: number } }).resource.count).toBeGreaterThan(0);
    const settings = await app.call(actor, { commandId: "settings.get", idempotencyKey: "st", input: {} }, grant.handle);
    expect(settings.value?.aiSkipped).toBe(true);
    expect(settings.value?.needsSetup).toBe(false);
    expect(settings.value?.layout).toBeTruthy();
    app.close();
  });

  it("cancels an inventory scan", async () => {
    const { app, actor, grant } = await startApp();
    const scan = app.call(actor, { commandId: "inventory.scan", idempotencyKey: "scan", input: {} }, grant.handle);
    await app.call(actor, { commandId: "inventory.cancelScan", idempotencyKey: "cancel", input: { scanId: "current" } }, grant.handle);
    const result = await scan;
    expect(result.status).toBe("ok");
    app.close();
  });

  it("keeps message keys stable across the test locale", () => {
    const zh = createTranslator("zh-CN");
    const testLocale = createTranslator("qps-ploc");
    expect(zh.t("nav.settings")).toBe("设置");
    expect(zh.t("app.channel.test")).toBe("测试通道");
    expect(testLocale.t("nav.settings")).toBe("[[设置]]");
    expect(zh.t("error.validation", { message: "范围" })).toContain("范围");
    expect(zh.t("library.import")).toBe("导入 TXT");
    expect(zh.t("settings.saveConnection")).toBe("保存连接");
    expect(zh.t("agent.retry")).toBe("重试");
    expect(zh.t("settings.chooseDirectory")).toContain("数据目录");
    expect(zh.t("settings.purposeEmbedding")).toBe("向量");
    expect(zh.t("library.transcribe")).toContain("转录");
    expect(zh.t("settings.recoveryResume")).toBe("恢复中断任务");
    expect(zh.t("library.repair")).toBe("修复位置");
  });
});
