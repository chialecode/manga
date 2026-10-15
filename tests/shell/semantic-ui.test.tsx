/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { MangaError } from "@manga/contracts";
import { SemanticPage } from "../../apps/desktop/src/renderer/pages/settings/semantic-page.tsx";
import { ResearchTab } from "../../apps/desktop/src/renderer/pages/projects/research/research-tab.tsx";
import { hiddenSettingsPages } from "../../apps/desktop/src/renderer/pages/settings/settings-view.tsx";
import { startApp } from "../helpers/app.ts";
import { BOOK, controlled } from "../helpers/embedder.ts";
import { bridgeToApp, tabContext } from "../helpers/ui-host.ts";

Element.prototype.scrollIntoView = () => {};

const i18n = createTranslator("zh-CN");
type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;
const apps: App[] = [];
const disposers: Array<() => void> = [];
afterEach(() => { cleanup(); while (disposers.length) disposers.pop()!(); while (apps.length) { try { apps.pop()!.app.close(); } catch { /* closed */ } } });

async function boot(model = controlled()) {
  const ctx = await startApp({ options: { embedding: model.port, semantic: { vec: false, retryBaseMs: 0 } } });
  apps.push(ctx);
  const bridge = bridgeToApp(ctx);
  disposers.push(bridge.dispose);
  const run = async (commandId: string, input: Record<string, unknown> = {}) => {
    counter += 1;
    const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `sui-${counter}`, input }, ctx.grant.handle);
    expect(result.status, `${commandId}: ${JSON.stringify(result)}`).toBe("ok");
    return result.value as Record<string, any>;
  };
  return { ctx, model, bridge, run, sql: ctx.app.store.sqlite };
}
type Booted = Awaited<ReturnType<typeof boot>>;

/** A book, a note and a recorded sentence, so a search has something of each kind to find. */
async function seed(h: Booted) {
  const book = await h.run("library.importText", { title: "雨夜行人", bytes: [...Buffer.from(BOOK)] }) as { resourceId: string; revisionId: string; workId: string };
  const note = await h.run("notes.create", { title: "灯下记", text: "今天在咖啡馆里读完了整本诗集，窗外的梧桐叶落了一地，店员安静地擦着杯子。" });
  h.sql.prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, updated_at, stage, work_id) VALUES (?,?,?,?,?,?,?)").run("cap-1", "{}", "done", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z", "done", book.workId);
  h.sql.prepare("INSERT INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, revised_text, state, precision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("seg-1", "cap-1", 1, "c1", 61_000, 66_000, "语音里提到了海边的灯塔和夜航的渔船", null, "done", "segment", "2026-10-01T10:00:01.000Z", "2026-10-01T10:00:01.000Z");
  h.sql.prepare("INSERT INTO excerpt_pages(id, url, title, fetched_at, content_hash, body_text, version, previous_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("pg-1", "https://pages.example.org/a", "沙漠网页", "2026-10-01T10:00:00.000Z", "h", "沙漠里的驼队在黄昏时分才开始赶路，星空低得像要落下来。", 1, null, "2026-10-01T10:00:00.000Z");
  const excerpt = await h.run("excerpt.create", { pageId: "pg-1", start: 0, end: 26, title: "驼队" });
  const project = await h.run("project.create", { name: "雨夜" });
  for (const [kind, targetId] of [["resource", book.resourceId], ["note", note.objectId], ["recording", "cap-1"], ["excerpt", excerpt.excerpt.id]] as const) {
    await h.run("project.addMaterial", { projectId: project.id, kind, targetId });
  }
  return { book, noteId: note.objectId as string, excerptId: excerpt.excerpt.id as string, projectId: project.id as string };
}

function mountPage(extra: { onGoto?: (page: "models") => void } = {}) {
  const errors: string[] = [];
  const notices: string[] = [];
  render(<SemanticPage t={i18n.t} formatDate={(iso) => iso.slice(0, 10)} formatNumber={i18n.formatNumber} onGoto={extra.onGoto ?? (() => undefined)} onError={(message) => errors.push(message)} onNotice={(message) => notices.push(message)} />);
  return { errors, notices };
}
const active = () => screen.findByTestId("semantic-active");
const text = (id: string) => screen.getByTestId(id).textContent ?? "";
const builtIn = (h: Booted) => h.ctx.app.semantic.settled();

describe("the semantic settings page", () => {
  it("is left out of the navigation when the module is off", () => {
    expect(hiddenSettingsPages(new Set(["agent", "library", "settings"])).has("semantic")).toBe(true);
    expect(hiddenSettingsPages(new Set(["agent", "library", "settings", "semantic"])).has("semantic")).toBe(false);
  });

  it("starts off: nothing is sent, the content that would be sent is counted, and the switch is there to turn it on", async () => {
    const h = await boot();
    await seed(h);
    mountPage();
    const enabled = await screen.findByTestId("semantic-enabled") as HTMLInputElement;
    expect(enabled.checked).toBe(false);
    expect(enabled.disabled).toBe(false);
    expect(text("semantic-none")).toContain("还没有索引");
    expect(text("semantic-estimate")).toMatch(/约 \d+ 段、[\d,]+ 字会发给所选连接/);
    expect((screen.getByTestId("semantic-connection") as HTMLSelectElement).value).toBe("emb-a");
    expect((screen.getByTestId("semantic-segmentation") as HTMLSelectElement).value).toBe("paragraph-600");
    expect(screen.getByTestId("semantic-rebuild")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("semantic-clear")).toHaveProperty("disabled", true);
    expect(h.model.state.calls).toEqual([]);
  });

  it("without an embedding connection cannot be turned on, and points to where one is added", async () => {
    const h = await boot();
    h.model.state.connections = [];
    const goto = vi.fn();
    mountPage({ onGoto: goto });
    expect(await screen.findByTestId("semantic-connection-none")).toBeTruthy();
    expect((screen.getByTestId("semantic-enabled") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("semantic-goto-models"));
    expect(goto).toHaveBeenCalledWith("models");
    expect(h.bridge.calls.some((call) => call.commandId === "semantic.configure")).toBe(false);
  });

  it("turns on, shows the build while it runs, and then says what the index is", async () => {
    const h = await boot();
    await seed(h);
    const release = h.model.hold("emb-a");
    const { notices } = mountPage();
    fireEvent.click(await screen.findByTestId("semantic-enabled"));
    const building = await screen.findByTestId("semantic-building");
    expect(building.textContent).toContain("正在建立索引");
    expect(within(building).getByRole("progressbar")).toBeTruthy();
    expect(screen.getByTestId("semantic-cancel")).toBeTruthy();
    expect(screen.queryByTestId("semantic-rebuild")).toBeNull();
    expect(h.bridge.calls.find((call) => call.commandId === "semantic.configure")!.input).toEqual({ enabled: true, connectionId: "emb-a", segmentation: "paragraph-600" });
    expect(notices).toContain("语义检索已开启，正在后台建立索引。");

    release();
    await builtIn(h);
    expect((await active()).textContent).toMatch(/model-a，48 维，\d+ 段，内置检索，建立于 \d{4}-\d{2}-\d{2}/);
    expect(screen.queryByTestId("semantic-building")).toBeNull();
    expect(notices).toContain("语义索引建好了。");
    expect((screen.getByTestId("semantic-enabled") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("semantic-rebuild")).toHaveProperty("disabled", false);
    expect(screen.queryByTestId("semantic-pending")).toBeNull();
  });

  it("stops a build the person no longer wants, and the page goes back to having no index", async () => {
    const h = await boot();
    await seed(h);
    h.model.hold("emb-a");
    mountPage();
    fireEvent.click(await screen.findByTestId("semantic-enabled"));
    await screen.findByTestId("semantic-building");
    fireEvent.click(screen.getByTestId("semantic-cancel"));
    await waitFor(() => expect(screen.queryByTestId("semantic-building")).toBeNull());
    expect(text("semantic-none")).toContain("还没有索引");
    expect(screen.queryByTestId("semantic-failed")).toBeNull();
  });

  it("builds a new index when another connection is chosen, and the first keeps being the one in use until then", async () => {
    const h = await boot();
    await seed(h);
    mountPage();
    fireEvent.click(await screen.findByTestId("semantic-enabled"));
    await builtIn(h);
    await waitFor(() => expect(text("semantic-active")).toContain("model-a"));

    const release = h.model.hold("emb-b");
    fireEvent.change(screen.getByTestId("semantic-connection"), { target: { value: "emb-b" } });
    const building = await screen.findByTestId("semantic-building");
    expect(building.textContent).toContain("model-b");
    expect(text("semantic-active")).toContain("model-a");
    release();
    await builtIn(h);
    await waitFor(() => expect(text("semantic-active")).toContain("model-b，32 维"));
    expect(screen.queryByTestId("semantic-stale")).toBeNull();
  });

  it("says when a build failed and that the earlier index is still the one in use, and when the settings no longer match it", async () => {
    const h = await boot();
    await seed(h);
    mountPage();
    fireEvent.click(await screen.findByTestId("semantic-enabled"));
    await builtIn(h);
    await waitFor(() => expect(text("semantic-active")).toContain("model-a"));

    h.model.state.failWith = (_n, connectionId) => (connectionId === "emb-b" ? new MangaError("AUTHENTICATION_FAILED", "密钥被拒绝") : null);
    fireEvent.change(screen.getByTestId("semantic-connection"), { target: { value: "emb-b" } });
    await builtIn(h);
    const failed = await screen.findByTestId("semantic-failed");
    expect(failed.getAttribute("role")).toBe("alert");
    expect(failed.textContent).toContain("这次没有建完");
    expect(failed.textContent).toContain("原来的索引仍在使用");
    expect(text("semantic-active")).toContain("model-a");
    expect(text("semantic-stale")).toContain("设置已经改变");
    expect(text("semantic-stale")).toContain("「model-a」");
    expect(screen.getByTestId("semantic-update")).toHaveProperty("disabled", true);

    // Rebuilding with the connection that works again clears both.
    h.model.state.failWith = null;
    fireEvent.click(screen.getByTestId("semantic-rebuild"));
    await builtIn(h);
    await waitFor(() => expect(text("semantic-active")).toContain("model-b"));
    expect(screen.queryByTestId("semantic-failed")).toBeNull();
    expect(screen.queryByTestId("semantic-stale")).toBeNull();
  });

  it("counts what was written after the index was made, and adds it on request", async () => {
    const h = await boot();
    await seed(h);
    mountPage();
    fireEvent.click(await screen.findByTestId("semantic-enabled"));
    await builtIn(h);
    await waitFor(() => expect(text("semantic-active")).toContain("model-a"));
    expect(screen.queryByTestId("semantic-pending")).toBeNull();

    await h.run("notes.create", { title: "新笔记", text: "清晨的集市上有人在卖刚出炉的面包，香味一直飘到街角。" });
    fireEvent.click(screen.getByTestId("semantic-rebuild"));
    await builtIn(h);
    await h.run("notes.create", { title: "又一篇", text: "傍晚的河边有人钓鱼，浮标在水面上轻轻晃动。" });
    // The page reads the status again when a notice arrives; opening it afresh is the same read.
    cleanup();
    mountPage();
    const pending = await screen.findByTestId("semantic-pending");
    expect(pending.textContent).toMatch(/有 \d+ 段新写的或新导入的内容还没有加入索引/);
    fireEvent.click(screen.getByTestId("semantic-update"));
    await builtIn(h);
    await waitFor(() => expect(screen.queryByTestId("semantic-pending")).toBeNull());
  });

  it("clears the index after a confirmation, and leaves what it was made from alone", async () => {
    const h = await boot();
    const { noteId } = await seed(h);
    const { notices } = mountPage();
    fireEvent.click(await screen.findByTestId("semantic-enabled"));
    await builtIn(h);
    await waitFor(() => expect(text("semantic-active")).toContain("model-a"));
    const before = (h.sql.prepare("SELECT COUNT(*) AS n FROM text_fragments").get() as { n: number }).n;

    fireEvent.click(screen.getByTestId("semantic-clear"));
    const dialog = await screen.findByTestId("semantic-clear-dialog");
    expect(dialog.textContent).toContain("正文、笔记、录音和摘录都不受影响");
    fireEvent.click(within(dialog).getByText("取消"));
    await waitFor(() => expect(screen.queryByTestId("semantic-clear-dialog")).toBeNull());
    expect(text("semantic-active")).toContain("model-a");

    fireEvent.click(screen.getByTestId("semantic-clear"));
    fireEvent.click(await screen.findByTestId("semantic-clear-confirm"));
    await waitFor(() => expect(screen.queryByTestId("semantic-active")).toBeNull());
    expect(text("semantic-none")).toContain("还没有索引");
    expect(notices).toContain("已清除语义索引。");
    expect((h.sql.prepare("SELECT COUNT(*) AS n FROM semantic_chunks").get() as { n: number }).n).toBe(0);
    expect((h.sql.prepare("SELECT COUNT(*) AS n FROM text_fragments").get() as { n: number }).n).toBe(before);
    expect(h.sql.prepare("SELECT 1 FROM content_objects WHERE id = ? AND deleted_at IS NULL").get(noteId)).toBeTruthy();
  });

  it("turns off without losing the index, which can still be cleared", async () => {
    const h = await boot();
    await seed(h);
    mountPage();
    fireEvent.click(await screen.findByTestId("semantic-enabled"));
    await builtIn(h);
    await waitFor(() => expect(text("semantic-active")).toContain("model-a"));
    fireEvent.click(screen.getByTestId("semantic-enabled"));
    await waitFor(() => expect((screen.getByTestId("semantic-enabled") as HTMLInputElement).checked).toBe(false));
    expect(text("semantic-active")).toContain("model-a");
    expect(screen.getByTestId("semantic-clear")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("semantic-rebuild")).toHaveProperty("disabled", true);
  });
});

function mountResearch(projectId: string, extra: Parameters<typeof tabContext>[1] = {}) {
  const tab = tabContext(projectId, extra);
  render(<ResearchTab ctx={tab.ctx} />);
  return tab;
}
async function ask(query: string) {
  fireEvent.change(screen.getByTestId("semantic-search-input"), { target: { value: query } });
  fireEvent.click(screen.getByTestId("semantic-search-go"));
}
async function enable(h: Booted) {
  await h.run("semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" });
  await h.ctx.app.semantic.settled();
}

describe("searching by meaning in a project's research tab", () => {
  it("offers the switch only when the module is on, and starts with the search by words", async () => {
    const h = await boot();
    const { projectId } = await seed(h);
    mountResearch(projectId, { facets: new Set(["research"]) });
    await screen.findByTestId("research-search");
    expect(screen.queryByTestId("research-modes")).toBeNull();
    cleanup();
    mountResearch(projectId);
    expect(await screen.findByTestId("research-modes")).toBeTruthy();
    expect(screen.getByTestId("research-search")).toBeTruthy();
    expect((screen.getByTestId("research-mode-keyword") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("research-mode-meaning"));
    expect(await screen.findByTestId("semantic-search")).toBeTruthy();
    expect(screen.queryByTestId("research-search")).toBeNull();
  });

  it("says the index is not on yet and points to the settings, instead of showing an empty list", async () => {
    const h = await boot();
    const { projectId } = await seed(h);
    const opened: string[] = [];
    mountResearch(projectId, { onOpenSettings: (page) => { opened.push(page); } });
    fireEvent.click(await screen.findByTestId("research-mode-meaning"));
    await ask("手风琴的声音");
    const state = await screen.findByTestId("semantic-state");
    expect(state.getAttribute("data-state")).toBe("off");
    expect(state.textContent).toContain("语义检索还没有开启");
    expect(screen.queryByTestId("semantic-results")).toBeNull();
    fireEvent.click(screen.getByTestId("semantic-open-settings"));
    expect(opened).toEqual(["semantic"]);
    expect(h.model.state.calls).toEqual([]);
  });

  it("says the index is still being built", async () => {
    const h = await boot();
    const { projectId } = await seed(h);
    h.model.hold("emb-a");
    await h.run("semantic.configure", { enabled: true, connectionId: "emb-a" });
    mountResearch(projectId);
    fireEvent.click(await screen.findByTestId("research-mode-meaning"));
    await ask("手风琴的声音");
    expect((await screen.findByTestId("semantic-state")).getAttribute("data-state")).toBe("building");
    await h.run("semantic.cancel");
  });

  it("finds passages by what they say, nearest first, each with its kind, its place and how close it is", async () => {
    const h = await boot();
    const { projectId } = await seed(h);
    await enable(h);
    mountResearch(projectId);
    fireEvent.click(await screen.findByTestId("research-mode-meaning"));
    await ask("手风琴的声音在雨夜的桥上");
    const list = await screen.findByTestId("semantic-results");
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(3);
    expect(items[0]!.getAttribute("data-testid")).toBe("semantic-result-body");
    expect(items[0]!.textContent).toContain("雨夜行人");
    expect(items[0]!.textContent).toContain("手风琴");
    expect(items[0]!.textContent).toMatch(/相近度 \d+%/);
    const scores = items.map((item) => Number(item.getAttribute("data-score")));
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(text("semantic-count")).toBe(`找到 ${items.length} 段，按相近程度排列`);
    expect(h.bridge.calls.filter((call) => call.commandId === "semantic.search").at(-1)!.input).toEqual({ text: "手风琴的声音在雨夜的桥上", projectId });

    await ask("海边的灯塔和夜航的渔船");
    await waitFor(() => expect(screen.getAllByTestId("semantic-result-recording").length).toBeGreaterThan(0));
    const recording = screen.getAllByTestId("semantic-result-recording")[0]!;
    expect(recording.textContent).toContain("01:01 处");
  });

  it("limits the search to the kinds chosen, to this project, and to what has been read", async () => {
    const h = await boot();
    const { projectId } = await seed(h);
    await enable(h);
    mountResearch(projectId);
    fireEvent.click(await screen.findByTestId("research-mode-meaning"));
    fireEvent.click(screen.getByTestId("semantic-kind-body"));
    fireEvent.click(screen.getByTestId("semantic-kind-recording"));
    fireEvent.click(screen.getByTestId("semantic-kind-excerpt"));
    fireEvent.click(screen.getByTestId("semantic-in-project"));
    await ask("咖啡馆读完诗集梧桐叶");
    const list = await screen.findByTestId("semantic-results");
    expect(within(list).getAllByRole("listitem").every((item) => item.getAttribute("data-testid") === "semantic-result-note")).toBe(true);
    expect(h.bridge.calls.filter((call) => call.commandId === "semantic.search").at(-1)!.input).toEqual({ text: "咖啡馆读完诗集梧桐叶", kinds: ["note"] });

    // Nothing of the book has been read, so asking only for what was read gives nothing, and says so.
    fireEvent.click(screen.getByTestId("semantic-kind-note"));
    fireEvent.click(screen.getByTestId("semantic-kind-body"));
    fireEvent.click(screen.getByTestId("semantic-progress"));
    await ask("手风琴的声音在雨夜的桥上");
    await waitFor(() => expect(screen.queryByTestId("semantic-results")).toBeNull());
    expect(text("semantic-none")).toBe("没有意思相近的段落。");
    expect(h.bridge.calls.filter((call) => call.commandId === "semantic.search").at(-1)!.input).toEqual({ text: "手风琴的声音在雨夜的桥上", kinds: ["body"], withinProgress: true });
    expect((screen.getByTestId("semantic-search-go") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("semantic-kind-body"));
    expect((screen.getByTestId("semantic-search-go") as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens a book passage, a note and a recording at their place, and an excerpt in this tab", async () => {
    const h = await boot();
    const { projectId, book, noteId, excerptId } = await seed(h);
    await enable(h);
    const opened: Array<Record<string, any>> = [];
    mountResearch(projectId, { onOpenHit: (hit) => { opened.push(hit as never); } });
    fireEvent.click(await screen.findByTestId("research-mode-meaning"));

    await ask("手风琴的声音在雨夜的桥上");
    fireEvent.click(within((await screen.findAllByTestId("semantic-result-body"))[0]!).getByTestId("semantic-result-open"));
    expect(opened.at(-1)).toMatchObject({ kind: "body", resourceId: book.resourceId, revisionId: book.revisionId, locator: { kind: "text", partId: "body" } });
    expect(opened.at(-1)!.locator.range.end).toBeGreaterThan(opened.at(-1)!.locator.range.start);

    await ask("咖啡馆读完诗集梧桐叶");
    await waitFor(() => expect(screen.getAllByTestId("semantic-result-note").length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getAllByTestId("semantic-result-note")[0]!).getByTestId("semantic-result-open"));
    expect(opened.at(-1)).toMatchObject({ kind: "note", objectId: noteId });

    await ask("海边的灯塔和夜航的渔船");
    await waitFor(() => expect(screen.getAllByTestId("semantic-result-recording").length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getAllByTestId("semantic-result-recording")[0]!).getByTestId("semantic-result-open"));
    expect(opened.at(-1)).toMatchObject({ kind: "recording", sessionId: "cap-1", startMs: 61_000 });

    const before = opened.length;
    await ask("沙漠驼队黄昏赶路星空");
    await waitFor(() => expect(screen.getAllByTestId("semantic-result-excerpt").length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getAllByTestId("semantic-result-excerpt")[0]!).getByTestId("semantic-result-open"));
    expect(await screen.findByTestId("research-reader")).toBeTruthy();
    expect(screen.getByTestId("research-page-title").textContent).toBe("沙漠网页");
    expect(opened.length).toBe(before);
    expect(excerptId).toBeTruthy();
  });
});
