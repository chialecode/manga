/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { DraftTab } from "../../apps/desktop/src/renderer/pages/projects/copy/draft-tab.tsx";
import { selectedRange, textOf } from "../../apps/desktop/src/renderer/pages/projects/copy/draft-editor.tsx";
import { contentOf, wordDiff } from "../../apps/desktop/src/renderer/pages/projects/copy/draft-model.ts";
import type { LlmPort } from "../../packages/app-core/src/voice/ports.ts";
import { startApp } from "../helpers/app.ts";
import { bridgeToApp, tabContext } from "../helpers/ui-host.ts";

Element.prototype.scrollIntoView = () => {};
// jsdom has no layout; ProseMirror asks ranges for their rectangles when it scrolls the caret into view.
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects = noRects;
Range.prototype.getBoundingClientRect = () => new DOMRect();

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;
const apps: App[] = [];
const disposers: Array<() => void> = [];
afterEach(() => { cleanup(); while (disposers.length) disposers.pop()!(); while (apps.length) apps.pop()!.app.close(); });

function controlledLlm() {
  const state: { reply: (user: string, signal: AbortSignal) => string | Promise<string>; asked: string[] } = { reply: () => "生成的内容", asked: [] };
  const port: LlmPort = {
    resolve: () => ({ id: "conn-a", model: "test-model" }),
    complete: async (_connection, request) => { state.asked.push(request.user); return state.reply(request.user, request.signal); },
  };
  return { port, state };
}

async function boot() {
  const llm = controlledLlm();
  const ctx = await startApp({ options: { llm: llm.port } });
  apps.push(ctx);
  const bridge = bridgeToApp(ctx);
  disposers.push(bridge.dispose);
  const run = async (commandId: string, input: Record<string, unknown>) => {
    counter += 1;
    const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `dui-${counter}`, input }, ctx.grant.handle);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    return result.value as Record<string, any>;
  };
  const project = await run("project.create", { name: "文案项目" });
  const draft = (await run("draft.create", { projectId: project.id, title: "稿子", text: "第一段。\n第二段。" })).draft as { id: string };
  return { ctx, run, llm, bridge, projectId: project.id as string, draftId: draft.id };
}

const editorOf = () => (screen.getByTestId("draft-surface") as HTMLElement & { editor: Editor }).editor;
const draftText = (c: App, id: string) => (c.app.store.sqlite.prepare("SELECT text FROM drafts WHERE id = ?").get(id) as { text: string }).text;
const mount = (projectId: string) => { const tab = tabContext(projectId); render(<DraftTab ctx={tab.ctx} />); return tab; };

describe("the draft tab (CRE-05, AT-29)", () => {
  it("lists the project's drafts, opens one, and saves what is typed without being asked", async () => {
    const { ctx, projectId, draftId } = await boot();
    mount(projectId);
    await screen.findByTestId(`draft-draft-${draftId}`);
    const surface = await screen.findByTestId("draft-surface");
    expect(surface.textContent).toBe("第一段。第二段。");
    expect(textOf(editorOf().state.doc)).toBe("第一段。\n第二段。");

    editorOf().chain().focus("end").insertContent("新写的。").run();
    await waitFor(() => expect(screen.getByTestId("draft-view").getAttribute("data-save-state")).toBe("saving"));
    await waitFor(() => expect(draftText(ctx, draftId)).toBe("第一段。\n第二段。新写的。"), { timeout: 4000 });
    await waitFor(() => expect(screen.getByTestId("draft-state").textContent).toBe("已保存"));
  });

  it("creates a draft from the list and makes it the open one", async () => {
    const { projectId } = await boot();
    mount(projectId);
    await screen.findByTestId("draft-view");
    fireEvent.click(screen.getByTestId("draft-new"));
    const second = await screen.findByText("文稿 2");
    expect(second).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("heading", { name: "文稿 2" })).toBeTruthy());
  });

  it("asks for a suggestion, shows it apart from the draft with the difference, and changes the draft only when it is adopted and again when undone", async () => {
    const { ctx, llm, projectId, draftId } = await boot();
    llm.state.reply = () => "【润色后的第一段。】";
    mount(projectId);
    await screen.findByTestId("suggest-form");
    fireEvent.change(screen.getByTestId("suggest-kind"), { target: { value: "polish" } });
    fireEvent.change(screen.getByTestId("suggest-instruction"), { target: { value: "更正式" } });
    fireEvent.click(screen.getByTestId("suggest-go"));

    // The suggestion opens, finishes by itself (the app tells the page), and the draft has not moved.
    const generated = await screen.findByTestId("generated-text", undefined, { timeout: 4000 });
    expect(generated.textContent).toBe("【润色后的第一段。】");
    expect(within(screen.getByTestId("suggestion-generated")).getByText("生成内容")).toBeTruthy();
    expect(llm.state.asked.at(-1)).toContain("要求：更正式");
    expect(draftText(ctx, draftId)).toBe("第一段。\n第二段。");
    const diff = screen.getByTestId("suggestion-diff-text");
    expect(diff.querySelector("ins")?.textContent).toContain("润色后");
    expect(diff.querySelector("del")).toBeTruthy();

    fireEvent.click(screen.getByTestId("suggestion-adopt"));
    await waitFor(() => expect(draftText(ctx, draftId)).toBe("【润色后的第一段。】"));
    await waitFor(() => expect(screen.getByTestId("draft-surface").textContent).toBe("【润色后的第一段。】"));
    await screen.findByTestId("suggestion-adopted");

    fireEvent.click(screen.getByTestId("suggestion-undo"));
    await waitFor(() => expect(draftText(ctx, draftId)).toBe("第一段。\n第二段。"));
    await waitFor(() => expect(screen.getByTestId("draft-surface").textContent).toBe("第一段。第二段。"));
    // Typing after a text was put back is saved against the right version, not refused.
    editorOf().chain().focus("end").insertContent("续。").run();
    await waitFor(() => expect(draftText(ctx, draftId)).toBe("第一段。\n第二段。续。"), { timeout: 4000 });
  });

  it("works on the selected text only when asked to", async () => {
    const { ctx, llm, projectId, draftId } = await boot();
    llm.state.reply = () => "改";
    mount(projectId);
    await screen.findByTestId("suggest-form");
    fireEvent.change(screen.getByTestId("suggest-kind"), { target: { value: "polish" } });
    expect((screen.getByTestId("suggest-selection") as HTMLInputElement).disabled).toBe(true);
    // Select "第二段" (offsets 4..7 of the paragraph text, after "第一段。" and a line break).
    editorOf().commands.focus();
    editorOf().commands.setTextSelection({ from: 7, to: 10 });
    await waitFor(() => expect((screen.getByTestId("suggest-selection") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("suggest-selection"));
    fireEvent.click(screen.getByTestId("suggest-go"));
    await screen.findByTestId("generated-text", undefined, { timeout: 4000 });
    expect(llm.state.asked.at(-1)).toContain("待处理的文字：\n第二段");
    fireEvent.click(screen.getByTestId("suggestion-adopt"));
    await waitFor(() => expect(draftText(ctx, draftId)).toBe("第一段。\n改。"));
  });

  it("quotes the chosen material apart from what was generated, and shows old against new when the material changed", async () => {
    const { ctx, run, llm, projectId, draftId } = await boot();
    const noteId = (await run("notes.create", { title: "资料", text: "旧的说法" })).objectId as string;
    await run("project.addMaterial", { projectId, kind: "note", targetId: noteId });
    llm.state.reply = () => "写成的话 [1]";
    mount(projectId);
    await screen.findByTestId("suggest-form");
    fireEvent.change(screen.getByTestId("suggest-kind"), { target: { value: "cite" } });
    fireEvent.click(await screen.findByTestId(`suggest-source-${noteId}`));
    fireEvent.click(screen.getByTestId("suggest-go"));
    await screen.findByTestId("generated-text", undefined, { timeout: 4000 });
    expect(screen.getByTestId(`quote-${noteId}`).textContent).toBe("旧的说法");
    // The quote is original text and carries its own tag; the generated block is tagged as generated.
    expect(within(screen.getByTestId("suggestion-quoted")).getByText("引用原文")).toBeTruthy();
    expect(screen.queryByTestId("suggestion-stale")).toBeNull();

    // The material changes; opening the suggestion again says its basis changed and offers the comparison.
    const got = await run("notes.get", { objectId: noteId });
    await run("notes.replace", { objectId: noteId, expectedRevision: got.revision, blocks: [{ id: "b1", type: "paragraph", text: "新的说法" }] });
    fireEvent.click(screen.getByTestId("suggestion-back"));
    await waitFor(() => expect(screen.getByTestId(`suggestion-status-${(ctx.app.store.sqlite.prepare("SELECT id FROM draft_suggestions WHERE draft_id = ?").get(draftId) as { id: string }).id}`)).toBeTruthy());
    const row = (ctx.app.store.sqlite.prepare("SELECT id FROM draft_suggestions WHERE draft_id = ?").get(draftId) as { id: string }).id;
    await waitFor(() => expect(screen.getByTestId(`suggestion-stale-${row}`).textContent).toBe("依据已变化"), { timeout: 4000 });
    fireEvent.click(screen.getByTestId(`suggestion-${row}`));
    await screen.findByTestId("suggestion-stale");
    expect(screen.getByTestId(`source-state-${noteId}`).textContent).toBe("已变化");
    fireEvent.click(screen.getByTestId("stale-compare"));
    const compare = await screen.findByTestId(`compare-${noteId}`);
    expect(compare.textContent).toContain("旧的说法");
    expect(compare.textContent).toContain("新的说法");

    // Keeping the suggestion takes the new material as its basis; the banner goes.
    fireEvent.click(screen.getByTestId("stale-keep"));
    await waitFor(() => expect(screen.queryByTestId("suggestion-stale")).toBeNull());
  });

  it("shows a suggestion an agent wrote as the agent's own, waiting beside the draft; no model was asked, and adopting it is the person's step (AT-85)", async () => {
    const { ctx, run, llm, projectId, draftId } = await boot();
    const session = await run("session.open", { kind: "project", targetId: projectId, contextId: projectId });
    const grant = ctx.app.issueAgentGrant(ctx.grant, { kind: "agent", id: "agent:ui-85" }, { sessionId: session.id as string, runId: "run-ui-85", readResourceIds: [], projectId });
    const made = await ctx.app.call({ kind: "agent", id: "agent:ui-85" }, { commandId: "draft.suggest", idempotencyKey: "ui85-suggest", input: { draftId, kind: "polish", range: { start: 0, end: 4 }, text: "首段。" } }, grant.handle);
    expect(made.status, JSON.stringify(made)).toBe("ok");
    mount(projectId);
    const id = (made.value as { suggestion: { id: string } }).suggestion.id;
    fireEvent.click(await screen.findByTestId(`suggestion-${id}`));
    await screen.findByTestId("suggestion-detail");
    expect(screen.getByTestId("suggestion-by-agent").textContent).toContain("Agent");
    expect(screen.getByTestId("suggestion-detail").getAttribute("data-status")).toBe("pending");
    expect(llm.state.asked).toEqual([]);
    expect(draftText(ctx, draftId)).toBe("第一段。\n第二段。");
    fireEvent.click(screen.getByTestId("suggestion-adopt"));
    await waitFor(() => expect(draftText(ctx, draftId)).toBe("首段。\n第二段。"));
  });

  it("makes a suggestion again from the new material", async () => {
    const { ctx, run, llm, projectId, draftId } = await boot();
    const noteId = (await run("notes.create", { title: "资料", text: "甲" })).objectId as string;
    await run("project.addMaterial", { projectId, kind: "note", targetId: noteId });
    llm.state.reply = (user) => (user.includes("乙") ? "依据乙" : "依据甲");
    mount(projectId);
    await screen.findByTestId("suggest-form");
    fireEvent.change(screen.getByTestId("suggest-kind"), { target: { value: "cite" } });
    fireEvent.click(await screen.findByTestId(`suggest-source-${noteId}`));
    fireEvent.click(screen.getByTestId("suggest-go"));
    await waitFor(() => expect(screen.getByTestId("generated-text").textContent).toBe("依据甲"), { timeout: 4000 });
    const got = await run("notes.get", { objectId: noteId });
    await run("notes.replace", { objectId: noteId, expectedRevision: got.revision, blocks: [{ id: "b1", type: "paragraph", text: "乙" }] });
    fireEvent.click(screen.getByTestId("suggestion-back"));
    const first = (ctx.app.store.sqlite.prepare("SELECT id FROM draft_suggestions WHERE draft_id = ?").get(draftId) as { id: string }).id;
    fireEvent.click(await screen.findByTestId(`suggestion-${first}`));
    fireEvent.click(await screen.findByTestId("stale-redo"));
    await waitFor(() => expect(screen.getByTestId("generated-text").textContent).toBe("依据乙"), { timeout: 4000 });
    expect(screen.queryByTestId("suggestion-stale")).toBeNull();
  });

  it("tells a failed suggestion and a missing model in words, not codes", async () => {
    const { llm, projectId } = await boot();
    llm.state.reply = () => { throw Object.assign(new Error("service down"), { code: "PROVIDER_UNAVAILABLE" }); };
    const tab = mount(projectId);
    await screen.findByTestId("suggest-form");
    fireEvent.click(screen.getByTestId("suggest-go"));
    await screen.findByTestId("suggestion-error", undefined, { timeout: 4000 });
    expect(screen.getByTestId("suggestion-error").textContent).toContain("service down");
    // The kind that needs material says what is missing before anything is sent.
    fireEvent.click(screen.getByTestId("suggestion-back"));
    fireEvent.change(screen.getByTestId("suggest-kind"), { target: { value: "cite" } });
    fireEvent.click(screen.getByTestId("suggest-go"));
    await waitFor(() => expect(tab.errors.at(-1)).toBe("引用材料生成需要至少选一份材料。"));
  });

  it("names versions, shows an older one against the text now, and goes back to it without losing the text it leaves", async () => {
    const { ctx, run, projectId, draftId } = await boot();
    mount(projectId);
    await screen.findByTestId("suggest-form");
    fireEvent.click(screen.getByTestId("draft-panel-versions"));
    fireEvent.change(await screen.findByTestId("version-label"), { target: { value: "初稿" } });
    fireEvent.click(screen.getByTestId("version-checkpoint"));
    await screen.findByText("初稿");
    editorOf().chain().focus("end").insertContent("后来加的。").run();
    await waitFor(() => expect(draftText(ctx, draftId)).toBe("第一段。\n第二段。后来加的。"), { timeout: 4000 });
    fireEvent.click(await screen.findByTestId("version-1"));
    const open = await screen.findByTestId("version-open-1");
    // The older text is compared with the text now: what was added since shows as added, and going back would take it out.
    await waitFor(() => expect(open.querySelector("ins")?.textContent).toContain("后来加的"));
    fireEvent.click(screen.getByTestId("version-restore-1"));
    await waitFor(() => expect(draftText(ctx, draftId)).toBe("第一段。\n第二段。"));
    await waitFor(() => expect(screen.getByTestId("draft-surface").textContent).toBe("第一段。第二段。"));
    const versions = (await run("draft.get", { draftId })).versions as Array<{ label: string }>;
    expect(versions.map((item) => item.label)).toEqual(expect.arrayContaining(["回到 v1 之前"]));
  });

  it("does not save over a draft that was changed elsewhere, and offers to read the newest", async () => {
    const { ctx, run, projectId, draftId } = await boot();
    mount(projectId);
    await screen.findByTestId("draft-surface");
    // Another window saved in the meantime.
    await run("draft.save", { draftId, expectedVersion: 1, text: "别处写的" });
    editorOf().chain().focus("end").insertContent("这里写的。").run();
    await waitFor(() => expect(screen.getByTestId("draft-view").getAttribute("data-save-state")).toBe("conflict"), { timeout: 4000 });
    expect(draftText(ctx, draftId)).toBe("别处写的");
    expect(screen.getByTestId("draft-state").textContent).toContain("别处已经改动");
    fireEvent.click(screen.getByTestId("draft-reload"));
    await waitFor(() => expect(screen.getByTestId("draft-surface").textContent).toBe("别处写的"));
    expect(screen.getByTestId("draft-view").getAttribute("data-save-state")).toBe("saved");
  });
});

describe("the text model of a draft", () => {
  it("turns text into one paragraph per line and back, and finds the selection as offsets in the text", () => {
    expect(contentOf("甲\n\n乙").content.map((block) => block.content.length)).toEqual([1, 0, 1]);
    const doc = { forEach: (fn: (node: { textContent: string; content: { size: number } }, pos: number) => void) => { fn({ textContent: "甲甲", content: { size: 2 } }, 0); fn({ textContent: "乙乙乙", content: { size: 3 } }, 4); } };
    expect(textOf(doc)).toBe("甲甲\n乙乙乙");
    // Inside the first paragraph, across the break into the second, and select-all.
    expect(selectedRange(doc, { from: 1, to: 2, empty: false })).toEqual({ start: 0, end: 1 });
    expect(selectedRange(doc, { from: 2, to: 6, empty: false })).toEqual({ start: 1, end: 4 });
    expect(selectedRange(doc, { from: 0, to: 9, empty: false })).toEqual({ start: 0, end: 6 });
    expect(selectedRange(doc, { from: 2, to: 2, empty: true })).toBeNull();
  });

  it("compares by words and gives up on texts too long to compare", () => {
    expect(wordDiff("a b", "a b")).toEqual([{ kind: "same", text: "a b" }]);
    const parts = wordDiff("今天天气很好", "今天天气不错")!;
    expect(parts.some((part) => part.kind === "add")).toBe(true);
    expect(parts.some((part) => part.kind === "del")).toBe(true);
    expect(wordDiff("a".repeat(40_000), "b".repeat(40_000))).toBeNull();
  });
});
