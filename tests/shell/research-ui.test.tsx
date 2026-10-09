/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ResearchTab } from "../../apps/desktop/src/renderer/pages/projects/research/research-tab.tsx";
import { segmentsOf, selectedRange } from "../../apps/desktop/src/renderer/pages/projects/research/research-model.ts";
import { startApp } from "../helpers/app.ts";
import { bridgeToApp, tabContext } from "../helpers/ui-host.ts";

Element.prototype.scrollIntoView = () => {};

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;
const apps: App[] = [];
const disposers: Array<() => void> = [];
afterEach(() => { cleanup(); while (disposers.length) disposers.pop()!(); while (apps.length) apps.pop()!.app.close(); });

const ARTICLE = (body: string) => `<html><head><title>雨夜的灯</title></head><body><article><h1>雨夜的灯</h1>${body}</article></body></html>`;
const LONG = "<p>城市在雨里安静下来，路灯一盏一盏亮起，照着湿漉漉的石板路。她撑着伞走过桥，听见远处有人在拉手风琴，曲子很慢，像是在等什么人。</p><p>桥下的水很深，倒映着整座城市的光。她停了一会儿，把伞举高了一点，继续往前走，没有回头。</p><p>第二天早晨，雨停了，石板路上留下一串浅浅的水迹，一直通到旧书店的门口。</p>";
const ADDRESS = "https://pages.example.org/rain";

/** The pages the test lets the application fetch; the answers can change while the test runs. */
function web() {
  const state = { html: ARTICLE(LONG), asked: [] as string[], long: "" };
  const fetchLike = (async (url: string) => {
    state.asked.push(url);
    if (url === ADDRESS) return new Response(state.html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    if (url === "https://pages.example.org/long") return new Response(state.long, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response("missing", { status: 404 });
  }) as never;
  return { state, fetchLike };
}

async function boot() {
  const site = web();
  const ctx = await startApp({ options: { netFetch: site.fetchLike, network: { lookup: async () => ["93.184.216.34"] } } });
  apps.push(ctx);
  const bridge = bridgeToApp(ctx);
  disposers.push(bridge.dispose);
  const run = async (commandId: string, input: Record<string, unknown>) => {
    counter += 1;
    const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `rui-${counter}`, input }, ctx.grant.handle);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    return result.value as Record<string, any>;
  };
  const project = await run("project.create", { name: "雨夜" });
  return { ctx, run, site, bridge, projectId: project.id as string };
}

function mount(projectId: string, extra: Parameters<typeof tabContext>[1] = {}) {
  const tab = tabContext(projectId, extra);
  render(<ResearchTab ctx={tab.ctx} />);
  return tab;
}
async function fetchIn(address = ADDRESS) {
  fireEvent.change(screen.getByTestId("research-url"), { target: { value: address } });
  fireEvent.click(screen.getByTestId("research-fetch"));
  await screen.findByTestId("research-reader");
}
/** Selects `phrase` in the page body the way a drag would: from one text node to another, then tells the document the selection changed. */
function select(phrase: string) {
  const body = screen.getByTestId("research-body");
  const text = body.textContent ?? "";
  const from = text.indexOf(phrase);
  expect(from, `"${phrase}" is on the page`).toBeGreaterThanOrEqual(0);
  const place = (offset: number): [Node, number] => {
    let seen = 0;
    for (const piece of body.querySelectorAll("[data-start]")) {
      const length = piece.textContent!.length;
      if (offset <= seen + length) return [piece.firstChild!, offset - seen];
      seen += length;
    }
    throw new Error("offset past the end");
  };
  const [a, ao] = place(from);
  const [b, bo] = place(from + phrase.length);
  window.getSelection()!.setBaseAndExtent(a, ao, b, bo);
  fireEvent(document, new Event("selectionchange"));
}
const excerptTexts = () => screen.queryAllByTestId("research-excerpt-text").map((node) => node.textContent);
const dbExcerpts = (c: App) => c.app.store.sqlite.prepare("SELECT text, start_offset AS start, end_offset AS end, project_id AS projectId FROM excerpts ORDER BY created_at").all() as Array<{ text: string; start: number; end: number; projectId: string | null }>;

describe("the pieces a page is drawn in", () => {
  it("cuts the text at the edges of the excerpts and says which excerpts cover each piece", () => {
    const text = "0123456789";
    const segments = segmentsOf(text, [{ id: "a", start: 2, end: 6, title: "A" }, { id: "b", start: 4, end: 8, title: "B" }]);
    expect(segments.map((piece) => [piece.start, piece.end, piece.text, piece.marks.map((mark) => mark.id)])).toEqual([
      [0, 2, "01", []], [2, 4, "23", ["a"]], [4, 6, "45", ["a", "b"]], [6, 8, "67", ["b"]], [8, 10, "89", []],
    ]);
    expect(segmentsOf("abc", []).map((piece) => piece.text)).toEqual(["abc"]);
    expect(segmentsOf("", [])).toEqual([]);
  });

  it("turns a selection into offsets whether it starts in a piece, between pieces or at the edge of the body", () => {
    const root = document.createElement("div");
    root.innerHTML = '<span data-start="0">ab</span><mark data-start="2">cd</mark><span data-start="4">ef</span>';
    document.body.append(root);
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(root.children[0]!.firstChild!, 1, root.children[2]!.firstChild!, 1);
    expect(selectedRange(root, selection)).toEqual({ start: 1, end: 5 });
    selection.setBaseAndExtent(root, 0, root, 3);
    expect(selectedRange(root, selection)).toEqual({ start: 0, end: 6 });
    selection.setBaseAndExtent(root.children[2]!.firstChild!, 2, root.children[1]!.firstChild!, 0);
    expect(selectedRange(root, selection)).toEqual({ start: 2, end: 6 });
    selection.collapse(root.children[0]!.firstChild!, 1);
    expect(selectedRange(root, selection)).toBeNull();
    selection.setBaseAndExtent(document.body, 0, document.body, 0);
    expect(selectedRange(root, selection)).toBeNull();
    root.remove();
  });
});

describe("fetching and reading a page", () => {
  it("fetches the address, keeps it in the list, and shows its text to read", async () => {
    const { projectId, site } = await boot();
    const tab = mount(projectId);
    await screen.findByTestId("research-pages-empty");
    await fetchIn();
    expect(screen.getByTestId("research-page-title").textContent).toBe("雨夜的灯");
    expect(screen.getByTestId("research-body").textContent).toContain("路灯一盏一盏亮起");
    expect(screen.getByTestId("research-body").textContent).not.toContain("<");
    await waitFor(() => expect(within(screen.getByTestId("research-page-list")).getByText("雨夜的灯")).toBeTruthy());
    expect(tab.notices).toContain("已获取「雨夜的灯」");
    expect((screen.getByTestId("research-url") as HTMLInputElement).value).toBe("");
    expect(site.state.asked).toEqual([ADDRESS]);
  });

  it("says why an address could not be fetched, in its own words, and keeps what was typed", async () => {
    const { projectId } = await boot();
    mount(projectId);
    await screen.findByTestId("research-pages-empty");
    for (const [address, words] of [["http://192.168.1.1/admin", "本机或局域网"], ["ftp://pages.example.org/a", "http 或 https"], ["https://pages.example.org/missing", "错误（404）"]] as const) {
      fireEvent.change(screen.getByTestId("research-url"), { target: { value: address } });
      fireEvent.click(screen.getByTestId("research-fetch"));
      await waitFor(() => expect(screen.getByTestId("research-fetch-error").textContent).toContain(words));
      expect((screen.getByTestId("research-url") as HTMLInputElement).value).toBe(address);
    }
    expect(screen.queryByTestId("research-reader")).toBeNull();
  });

  it("keeps the selection as an excerpt of this project, exactly the words selected, and draws it over the page", async () => {
    const { ctx, projectId } = await boot();
    const tab = mount(projectId);
    await screen.findByTestId("research-pages-empty");
    await fetchIn();
    expect(screen.getByTestId("research-select-hint")).toBeTruthy();
    select("她撑着伞走过桥，听见远处有人在拉手风琴");
    expect(screen.getByTestId("research-selected").textContent).toBe("已选 19 字");
    fireEvent.change(screen.getByTestId("research-title"), { target: { value: "桥上的琴声" } });
    fireEvent.change(screen.getByTestId("research-note"), { target: { value: "开头的画面" } });
    fireEvent.click(screen.getByTestId("research-save"));
    await waitFor(() => expect(excerptTexts()).toEqual(["她撑着伞走过桥，听见远处有人在拉手风琴"]));
    expect(dbExcerpts(ctx)).toEqual([expect.objectContaining({ text: "她撑着伞走过桥，听见远处有人在拉手风琴", projectId })]);
    expect(screen.getByTestId("research-excerpt-title").textContent).toBe("桥上的琴声");
    expect(screen.getByTestId("research-excerpt-note").textContent).toBe("开头的画面");
    expect(screen.getByTestId("research-excerpt-source").textContent).toMatch(/^出处：pages\.example\.org · 第 1 版 · \d{4}-\d{2}-\d{2}$/);
    expect(tab.notices).toContain("已保存摘录");
    // The excerpt is drawn over the page, the form is ready for the next selection, and the page list counts it.
    await waitFor(() => expect(screen.getByTestId("research-body").querySelector("mark")?.textContent).toBe("她撑着伞走过桥，听见远处有人在拉手风琴"));
    expect(screen.getByTestId("research-select-hint")).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId("research-page-list")).getByText(/1 条摘录/)).toBeTruthy());
  });

  it("takes a selection that starts in plain text and ends inside an earlier excerpt, with the right offsets", async () => {
    const { ctx, projectId } = await boot();
    mount(projectId);
    await screen.findByTestId("research-pages-empty");
    await fetchIn();
    select("路灯一盏一盏亮起");
    fireEvent.click(screen.getByTestId("research-save"));
    await waitFor(() => expect(excerptTexts()).toHaveLength(1));
    select("石板路。她撑着伞走过桥，听见");
    fireEvent.click(screen.getByTestId("research-save"));
    await waitFor(() => expect(excerptTexts()).toHaveLength(2));
    expect(dbExcerpts(ctx).map((row) => row.text)).toEqual(["路灯一盏一盏亮起", "石板路。她撑着伞走过桥，听见"]);
    const page = ctx.app.store.sqlite.prepare("SELECT body_text AS text FROM excerpt_pages").get() as { text: string };
    for (const row of dbExcerpts(ctx)) expect(page.text.slice(row.start, row.end)).toBe(row.text);
  });

  it("keeps the selection while the person names it, and refuses one that is too long", async () => {
    const { run, projectId, site } = await boot();
    site.state.long = "字".repeat(25_000);
    mount(projectId);
    await screen.findByTestId("research-pages-empty");
    await fetchIn();
    select("桥下的水很深");
    // Moving into the form (a selection somewhere else) does not lose the words.
    window.getSelection()!.setBaseAndExtent(screen.getByTestId("research-page-title").firstChild!, 0, screen.getByTestId("research-page-title").firstChild!, 2);
    fireEvent(document, new Event("selectionchange"));
    expect(screen.getByTestId("research-selected").textContent).toBe("已选 6 字");
    fireEvent.change(screen.getByTestId("research-url"), { target: { value: "https://pages.example.org/long" } });
    fireEvent.click(screen.getByTestId("research-fetch"));
    await waitFor(() => expect(screen.getByTestId("research-page-title").textContent).toBe("pages.example.org"));
    const body = screen.getByTestId("research-body");
    window.getSelection()!.setBaseAndExtent(body.firstChild!.firstChild!, 0, body.firstChild!.firstChild!, 21_000);
    fireEvent(document, new Event("selectionchange"));
    expect(screen.getByTestId("research-too-long").textContent).toBe("一次最多摘录 20000 字。");
    expect((screen.getByTestId("research-save") as HTMLButtonElement).disabled).toBe(true);
    window.getSelection()!.setBaseAndExtent(body.firstChild!.firstChild!, 0, body.firstChild!.firstChild!, 200);
    fireEvent(document, new Event("selectionchange"));
    expect((screen.getByTestId("research-save") as HTMLButtonElement).disabled).toBe(false);
    expect((await run("excerpt.list", {})).excerpts).toEqual([]);
  });
});

describe("a page that changed after an excerpt was taken", () => {
  async function withExcerpt() {
    const booted = await boot();
    const tab = mount(booted.projectId);
    await screen.findByTestId("research-pages-empty");
    await fetchIn();
    select("桥下的水很深，倒映着整座城市的光");
    fireEvent.click(screen.getByTestId("research-save"));
    await waitFor(() => expect(excerptTexts()).toHaveLength(1));
    return { ...booted, tab };
  }

  it("fetching again keeps the old version, offers the new one, and the excerpt says its page has a newer version", async () => {
    const { site, ctx } = await withExcerpt();
    site.state.html = ARTICLE(`<p>序章：这是新加的一段话，放在文章的最前面，让后面的文字整体向后移动。</p>${LONG}`);
    fireEvent.click(screen.getByTestId("research-refetch"));
    await waitFor(() => expect(screen.getByTestId("research-reader").textContent).toContain("序章"));
    expect(screen.getByTestId("research-reader").textContent).toContain("第 2 版");
    // The new version has no excerpt drawn on it (the excerpt points into version 1).
    expect(screen.getByTestId("research-body").querySelector("mark")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("research-excerpt-newer")).toBeTruthy());
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM excerpt_pages").get()).toEqual({ n: 2 });

    // The excerpt shows its own version in the page, with the banner that says it is the old one.
    fireEvent.click(screen.getByTestId("research-excerpt-show"));
    await waitFor(() => expect(screen.getByTestId("research-outdated").textContent).toContain("网页已有第 2 版"));
    expect(screen.getByTestId("research-body").querySelector("mark")?.textContent).toBe("桥下的水很深，倒映着整座城市的光");
    expect(screen.getByTestId("research-body").textContent).not.toContain("序章");
    fireEvent.click(screen.getByTestId("research-to-newer"));
    await waitFor(() => expect(screen.queryByTestId("research-outdated")).toBeNull());
    expect(screen.getByTestId("research-body").textContent).toContain("序章");
  });

  it("follows the passage into the new version as an excerpt of its own, and leaves the first one", async () => {
    const { site, ctx, tab } = await withExcerpt();
    site.state.html = ARTICLE(`<p>序章：这是新加的一段话，放在文章的最前面，让后面的文字整体向后移动。</p>${LONG}`);
    fireEvent.click(screen.getByTestId("research-refetch"));
    const follow = await screen.findByTestId("research-excerpt-follow");
    fireEvent.click(follow);
    await waitFor(() => expect(excerptTexts()).toHaveLength(2));
    expect(tab.notices).toContain("已在新版本里保存为另一条摘录，原摘录保持不变。");
    const rows = dbExcerpts(ctx);
    expect(rows[0]!.text).toBe(rows[1]!.text);
    expect(rows[1]!.start).toBeGreaterThan(rows[0]!.start);
    // The new excerpt is shown on the new version of the page.
    await waitFor(() => expect(screen.getByTestId("research-body").querySelector("mark")?.textContent).toBe("桥下的水很深，倒映着整座城市的光"));
    expect(screen.queryByTestId("research-outdated")).toBeNull();
  });

  it("says so when the passage is gone from the new version", async () => {
    const { site, tab } = await withExcerpt();
    site.state.html = ARTICLE(LONG.replace("桥下的水很深，倒映着整座城市的光。", "桥下什么也没有。"));
    fireEvent.click(screen.getByTestId("research-refetch"));
    fireEvent.click(await screen.findByTestId("research-excerpt-follow"));
    await waitFor(() => expect(tab.notices).toContain("新版本里找不到这一段，原摘录保持不变。"));
    expect(excerptTexts()).toEqual(["桥下的水很深，倒映着整座城市的光"]);
  });

  it("fetching an unchanged page says so and makes no new version", async () => {
    const { tab, ctx } = await withExcerpt();
    fireEvent.click(screen.getByTestId("research-refetch"));
    await waitFor(() => expect(tab.notices).toContain("「雨夜的灯」没有变化"));
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM excerpt_pages").get()).toEqual({ n: 1 });
    expect(screen.queryByTestId("research-versions")).toBeNull();
  });
});

describe("editing and deleting", () => {
  it("renames and annotates an excerpt, and deletes it after a confirmation that names it", async () => {
    const { projectId, ctx } = await boot();
    mount(projectId);
    await screen.findByTestId("research-pages-empty");
    await fetchIn();
    select("桥下的水很深");
    fireEvent.click(screen.getByTestId("research-save"));
    await waitFor(() => expect(excerptTexts()).toHaveLength(1));
    fireEvent.click(screen.getByTestId("research-excerpt-edit"));
    fireEvent.change(screen.getByTestId("research-edit-title"), { target: { value: "水" } });
    fireEvent.change(screen.getByTestId("research-edit-note"), { target: { value: "意象" } });
    fireEvent.click(screen.getByTestId("research-edit-save"));
    await waitFor(() => expect(screen.getByTestId("research-excerpt-title").textContent).toBe("水"));
    expect(screen.getByTestId("research-excerpt-note").textContent).toBe("意象");
    fireEvent.click(screen.getByTestId("research-excerpt-delete"));
    expect(within(screen.getByTestId("research-excerpt-delete-dialog")).getByText("删除摘录「水」？网页本身不受影响。")).toBeTruthy();
    fireEvent.click(screen.getByTestId("research-excerpt-delete-confirm"));
    await waitFor(() => expect(screen.getByTestId("research-excerpts-empty")).toBeTruthy());
    expect(dbExcerpts(ctx)).toEqual([]);
    expect(screen.getByTestId("research-body").querySelector("mark")).toBeNull();
  });

  it("deletes a page version only when no excerpt is taken from it", async () => {
    const { projectId, ctx } = await boot();
    const tab = mount(projectId);
    await screen.findByTestId("research-pages-empty");
    await fetchIn();
    select("手风琴");
    fireEvent.click(screen.getByTestId("research-save"));
    await waitFor(() => expect(excerptTexts()).toHaveLength(1));
    fireEvent.click(screen.getByTestId("research-page-delete"));
    fireEvent.click(screen.getByTestId("research-page-delete-confirm"));
    await waitFor(() => expect(tab.errors).toContain("还有 1 条摘录取自这一版，先删除这些摘录。"));
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM excerpt_pages").get()).toEqual({ n: 1 });
    fireEvent.click(screen.getByTestId("research-excerpt-delete"));
    fireEvent.click(screen.getByTestId("research-excerpt-delete-confirm"));
    await waitFor(() => expect(screen.getByTestId("research-excerpts-empty")).toBeTruthy());
    fireEvent.click(screen.getByTestId("research-page-delete"));
    fireEvent.click(screen.getByTestId("research-page-delete-confirm"));
    await waitFor(() => expect(screen.queryByTestId("research-reader")).toBeNull());
    await screen.findByTestId("research-pages-empty");
  });
});

describe("searching one's own material", () => {
  async function seeded() {
    const booted = await boot();
    const book = (await booted.run("library.importText", { title: "雨夜行人", bytes: [...Buffer.from("第一章\n她在旧书店里找到了一本讲手风琴的书，书页已经发黄。")] })) as { workId: string; resourceId: string };
    const note = (await booted.run("notes.create", { title: "读书笔记", text: "今天读到手风琴的那一段。" })) as { objectId: string };
    return { ...booted, book, note };
  }

  it("lists what was found with what it is, adds a result to the project once, and opens the others", async () => {
    const { projectId, book, note, ctx, bridge } = await seeded();
    const opened: Array<{ kind: string; targetId: string }> = [];
    const tab = mount(projectId, { onOpenMaterial: (material) => { opened.push({ kind: material.kind, targetId: material.targetId }); } });
    await screen.findByTestId("research-search");
    fireEvent.change(screen.getByTestId("research-search-input"), { target: { value: "手风琴" } });
    fireEvent.click(screen.getByTestId("research-search-go"));
    const results = await screen.findByTestId("research-results");
    expect(within(results).getByTestId("research-result-work").textContent).toContain("雨夜行人");
    expect(within(results).getByTestId("research-result-note").textContent).toContain("读书笔记");
    expect(screen.getByTestId("research-result-count").textContent).toBe("找到 2 条");

    fireEvent.click(within(screen.getByTestId("research-result-note")).getByTestId("research-result-add"));
    await waitFor(() => expect(within(screen.getByTestId("research-result-note")).getByTestId("research-result-in")).toBeTruthy());
    expect(tab.notices).toContain("已加入项目");
    expect(ctx.app.store.sqlite.prepare("SELECT kind, target_id AS targetId FROM project_materials WHERE project_id = ?").all(projectId)).toEqual([{ kind: "note", targetId: note.objectId }]);
    expect(bridge.calls.filter((call) => call.commandId === "project.addMaterial")).toHaveLength(1);

    fireEvent.click(within(screen.getByTestId("research-result-work")).getByTestId("research-result-open"));
    expect(opened).toEqual([{ kind: "work", targetId: book.workId }]);
  });

  it("only looks in the scopes that are ticked, says when nothing is found, and cannot search with no scope", async () => {
    const { projectId } = await seeded();
    mount(projectId);
    await screen.findByTestId("research-search");
    fireEvent.change(screen.getByTestId("research-search-input"), { target: { value: "手风琴" } });
    fireEvent.click(screen.getByTestId("research-scope-work"));
    fireEvent.click(screen.getByTestId("research-search-go"));
    await screen.findByTestId("research-results");
    expect(screen.queryByTestId("research-result-work")).toBeNull();
    expect(screen.getByTestId("research-result-note")).toBeTruthy();
    fireEvent.change(screen.getByTestId("research-search-input"), { target: { value: "不存在的词语" } });
    fireEvent.click(screen.getByTestId("research-search-go"));
    await waitFor(() => expect(screen.getByTestId("research-none").textContent).toBe("没有找到「不存在的词语」。"));
    for (const scope of ["note", "recording", "excerpt", "page"]) fireEvent.click(screen.getByTestId(`research-scope-${scope}`));
    expect((screen.getByTestId("research-search-go") as HTMLButtonElement).disabled).toBe(true);
  });

  it("finds the page and the excerpt that were kept, and opens them in the reader at the right version", async () => {
    const { projectId } = await seeded();
    mount(projectId);
    await screen.findByTestId("research-pages-empty");
    await fetchIn();
    select("听见远处有人在拉手风琴");
    fireEvent.click(screen.getByTestId("research-save"));
    await waitFor(() => expect(excerptTexts()).toHaveLength(1));

    fireEvent.change(screen.getByTestId("research-search-input"), { target: { value: "拉手风琴" } });
    fireEvent.click(screen.getByTestId("research-search-go"));
    const results = await screen.findByTestId("research-results");
    expect(within(results).getByTestId("research-result-excerpt")).toBeTruthy();
    expect(within(results).getByTestId("research-result-page")).toBeTruthy();
    // Opening the excerpt brings its page up with the passage marked, and opening the page result shows the same page.
    fireEvent.click(within(screen.getByTestId("research-result-excerpt")).getByTestId("research-result-open"));
    await waitFor(() => expect(screen.getByTestId("research-body").querySelector("mark.is-focused")?.textContent).toBe("听见远处有人在拉手风琴"));
    fireEvent.click(within(screen.getByTestId("research-result-page")).getByTestId("research-result-open"));
    await waitFor(() => expect(screen.getByTestId("research-body").querySelector("mark")?.textContent).toBe("听见远处有人在拉手风琴"));
  });

  it("opens an excerpt that the project's materials pointed at, and hands the focus back", async () => {
    const { projectId, run } = await boot();
    const fetched = await run("webpage.fetch", { url: ADDRESS }) as { page: { id: string } };
    const made = await run("excerpt.create", { pageId: fetched.page.id, start: 0, end: 6, projectId }) as { excerpt: { id: string; text: string } };
    const focused: Array<unknown> = [];
    mount(projectId, { focus: { kind: "excerpt", id: made.excerpt.id }, onFocus: (focus) => { focused.push(focus); } });
    await waitFor(() => expect(screen.getByTestId("research-body").querySelector("mark")?.textContent).toBe(made.excerpt.text));
    expect(screen.getByTestId("research-body").querySelector("mark.is-focused")).toBeTruthy();
    await waitFor(() => expect(focused).toEqual([null]));
  });
});
