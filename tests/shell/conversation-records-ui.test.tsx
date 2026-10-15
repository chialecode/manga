/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTranslator } from "@manga/i18n";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { RecordsPage } from "../../apps/desktop/src/renderer/pages/settings/records-page.tsx";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { installMatchMedia, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

Element.prototype.scrollIntoView = () => {};

/**
 * Deleting conversations from "设置 › 记录" (A-89, AT-103): the list with its filters, the question before anything is deleted and what it says goes and
 * stays, one / several / all, what is said when a task kept a conversation, and the right pane taking a new conversation when its own was deleted.
 */
const i18n = createTranslator("zh-CN");
const t = i18n.t;

type Handler = (input: Record<string, unknown>) => unknown;
type Call = { commandId: string; input: Record<string, unknown> };
type Notice = { topic: string; payload: Record<string, unknown> };

function installHost(handlers: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const listeners = new Set<(notice: Notice) => void>();
  const base: Record<string, Handler> = {
    "records.list": () => ({ items: [], total: 0 }),
    "notes.list": () => [],
    "works.list": () => ({ items: [{ id: "w1", title: "合成作品", author: "", mediaKind: "comic", shelf: "reading", coverId: null, lastResource: null, progress: 0, finishedCount: 0, resourceCount: 0, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null }], total: 1, nextCursor: null }),
    "workspace.get": () => ({ uiFacets: ["agent", "library", "settings"], sessions: [], runs: [], notes: [], resources: [] }),
    "workspace.sessions": () => [],
    "settings.get": () => ({ needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: [{ purpose: "text" }] }),
    "inventory.overview": () => ({ items: [], totals: {} }),
    "quickTasks.list": () => ({ tasks: [] }),
    ...handlers,
  };
  (window as unknown as { manga: unknown }).manga = {
    async state() { return { layout: { channel: "test", pointerPath: "pointer.json", partitions: { data: "d" }, writable: true, recovery: "none" }, writable: true, vaultAvailable: true }; },
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = base[payload.commandId];
      const value = handler ? handler(input) : {};
      if (value && typeof value === "object" && "__error" in value) return { status: "error", error: (value as { __error: unknown }).__error };
      return { status: "ok", value };
    },
    onNotice(listener: (notice: Notice) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async chooseDirectory() { return null; },
    async chooseFile() { return null; },
    async chooseAudio() { return null; },
    async stashSecret() { return null; },
    async reveal() { return { status: "ok", value: {} }; },
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id), notify: (notice: Notice) => act(() => { for (const listener of listeners) listener(notice); }) };
}

beforeEach(() => { window.innerWidth = 1600; installMatchMedia({ reducedMotion: true }); installPointerEvent(); quoteTags.reset(); readerContext.reset(); try { window.localStorage.clear(); } catch { /* none */ } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); removeMatchMedia(); });

type Row = { sessionId: string; title: string; kind: string; mode: "enthusiast" | "creator"; targetId: string | null; ownerTitle: string | null; runCount: number; createdAt: string; lastAt: string; excerpt: string; current: boolean; running: boolean };
const row = (id: string, extra: Partial<Row> = {}): Row => ({ sessionId: id, title: `对话 ${id}`, kind: "shared", mode: "enthusiast", targetId: null, ownerTitle: null, runCount: 2, createdAt: "2026-10-01T10:00:00.000Z", lastAt: "2026-10-02T10:00:00.000Z", excerpt: `${id} 的第一句`, current: false, running: false, ...extra });

function page(overrides: Partial<Parameters<typeof RecordsPage>[0]> = {}) {
  const handlers = { onOpenNote: vi.fn(), onOpenNoteSource: vi.fn(), onOpenRecording: vi.fn(), onError: vi.fn(), onNotice: vi.fn() };
  render(<RecordsPage t={t} formatDate={(value) => value.slice(0, 10)} {...handlers} {...overrides} />);
  return handlers;
}
const openConversations = async () => { await userEvent.selectOptions(screen.getByTestId("records-type"), "conversation"); await screen.findByTestId("conv-filters"); };

describe("the conversations category in the records page", () => {
  it("lists every kind with its owner, rounds and last time, marks the one in use and the one at work, and hides the note filters", async () => {
    const host = installHost({
      "conversation.list": () => ({
        total: 3,
        items: [
          row("a", { current: true, title: "全局对话甲" }),
          row("b", { kind: "resource", ownerTitle: "合成视频 第一集", runCount: 0, excerpt: "" }),
          row("c", { kind: "project", mode: "creator", ownerTitle: "合成项目", running: true }),
        ],
      }),
    });
    page();
    expect(screen.getByTestId("settings-page-records").textContent).toContain(t("records.hint"));
    await openConversations();
    await screen.findByTestId("conv-a");
    expect(host.of("conversation.list")[0]!.input).toEqual({ limit: 30, offset: 0 });
    expect(screen.queryByTestId("records-kind")).toBeNull();
    expect(screen.queryByTestId("records-deleted")).toBeNull();
    expect(screen.getByTestId("conv-meta-a").textContent).toBe(`${t("records.conv.kind.shared")} · ${t("records.conv.mode.enthusiast")} · ${t("records.conv.rounds", { count: 2 })} · 2026-10-02`);
    expect(screen.getByTestId("conv-meta-b").textContent).toContain("合成视频 第一集");
    expect(screen.getByTestId("conv-meta-b").textContent).toContain(t("records.conv.noRounds"));
    expect(screen.getByTestId("conv-meta-c").textContent).toContain(t("records.conv.kind.project"));
    expect(screen.getByTestId("conv-current-a")).toBeTruthy();
    expect(screen.getByTestId("conv-running-c")).toBeTruthy();
    expect(screen.queryByTestId("conv-current-b")).toBeNull();
  });

  it("says what stays in the backup copies the application keeps, and that packages hold no conversations", async () => {
    installHost({ "conversation.list": () => ({ items: [], total: 0 }) });
    page();
    await openConversations();
    const scope = await screen.findByTestId("conv-scope");
    expect(scope.textContent).toContain("premigrate");
    expect(scope.textContent).toContain("资料包与项目包不包含对话");
    expect(await screen.findByTestId("conv-empty")).toBeTruthy();
    expect((screen.getByTestId("conv-delete-all") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before deleting one, says what goes and what stays, and deletes only after the answer", async () => {
    let items = [row("a"), row("b")];
    const host = installHost({
      "conversation.list": () => ({ items, total: items.length }),
      "conversation.delete": (input) => { items = items.filter((item) => !(input.sessionIds as string[]).includes(item.sessionId)); return { removed: input.sessionIds, skipped: [], counts: {}, replaced: {} }; },
    });
    const handlers = page();
    await openConversations();
    await userEvent.click(await screen.findByTestId("conv-delete-a"));
    const dialog = await screen.findByTestId("conv-confirm");
    expect(within(dialog).getByTestId("conv-confirm-removes").textContent).toContain("消息");
    expect(within(dialog).getByTestId("conv-confirm-removes").textContent).toContain("使用记录");
    expect(within(dialog).getByTestId("conv-confirm-keeps").textContent).toContain("笔记");
    expect(within(dialog).getByTestId("conv-confirm-warning").textContent).toContain("不能恢复");
    expect(host.of("conversation.delete")).toEqual([]);

    // Saying no changes nothing.
    await userEvent.click(within(dialog).getByTestId("conv-confirm-cancel"));
    expect(screen.queryByTestId("conv-confirm")).toBeNull();
    expect(host.of("conversation.delete")).toEqual([]);

    await userEvent.click(screen.getByTestId("conv-delete-a"));
    await userEvent.click(await screen.findByTestId("conv-confirm-ok"));
    await waitFor(() => expect(host.of("conversation.delete")).toHaveLength(1));
    expect(host.of("conversation.delete")[0]!.input).toEqual({ sessionIds: ["a"] });
    await waitFor(() => expect(screen.queryByTestId("conv-a")).toBeNull());
    expect(screen.getByTestId("conv-b")).toBeTruthy();
    expect(handlers.onNotice).toHaveBeenCalledWith(t("records.conv.done", { count: 1 }));
  });

  it("deletes the ones chosen, counted on the button, and the page selects all of itself", async () => {
    let items = [row("a"), row("b"), row("c")];
    const host = installHost({
      "conversation.list": () => ({ items, total: items.length }),
      "conversation.delete": (input) => { items = items.filter((item) => !(input.sessionIds as string[]).includes(item.sessionId)); return { removed: input.sessionIds, skipped: [], counts: {}, replaced: {} }; },
    });
    page();
    await openConversations();
    await screen.findByTestId("conv-c");
    expect((screen.getByTestId("conv-delete-picked") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("conv-pick-a"));
    await userEvent.click(screen.getByTestId("conv-pick-c"));
    expect(screen.getByTestId("conv-delete-picked").textContent).toContain("（2）");
    await userEvent.click(screen.getByTestId("conv-delete-picked"));
    expect(screen.getByTestId("conv-confirm").textContent).toContain(t("records.conv.confirm.title", { count: 2 }));
    await userEvent.click(screen.getByTestId("conv-confirm-ok"));
    await waitFor(() => expect(host.of("conversation.delete")[0]?.input).toEqual({ sessionIds: ["a", "c"] }));
    await waitFor(() => expect(screen.queryByTestId("conv-c")).toBeNull());
    expect(screen.getByTestId("conv-b")).toBeTruthy();
    // Nothing is chosen any more; "select the page" chooses what is there.
    expect((screen.getByTestId("conv-delete-picked") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("conv-select-page"));
    expect(screen.getByTestId("conv-delete-picked").textContent).toContain("（1）");
  });

  it("deletes everything the filter shows with the same filter, and says so on the button and in the question", async () => {
    const host = installHost({
      "conversation.list": () => ({ items: [row("a", { kind: "resource", ownerTitle: "某资源" })], total: 7 }),
      "conversation.deleteAll": () => ({ removed: ["a", "b", "c", "d", "e", "f", "g"], skipped: [], counts: {}, replaced: {} }),
    });
    const handlers = page();
    await openConversations();
    await screen.findByTestId("conv-a");
    expect(screen.getByTestId("conv-delete-all").textContent).toBe(t("records.conv.deleteAll", { count: 7 }));
    await userEvent.selectOptions(screen.getByTestId("conv-kind"), "resource");
    await userEvent.selectOptions(screen.getByTestId("conv-mode"), "enthusiast");
    await userEvent.selectOptions(screen.getByTestId("conv-time"), "week");
    await waitFor(() => expect(host.of("conversation.list").at(-1)!.input).toMatchObject({ kind: "resource", mode: "enthusiast", after: expect.any(String), limit: 30, offset: 0 }));
    expect(screen.getByTestId("conv-delete-all").textContent).toBe(t("records.conv.deleteFiltered", { count: 7 }));
    await userEvent.click(screen.getByTestId("conv-delete-all"));
    expect(screen.getByTestId("conv-confirm").textContent).toContain(t("records.conv.confirm.title", { count: 7 }));
    expect(screen.getByTestId("conv-confirm").textContent).toContain(t("records.conv.confirm.filtered"));
    await userEvent.click(screen.getByTestId("conv-confirm-ok"));
    await waitFor(() => expect(host.of("conversation.deleteAll")).toHaveLength(1));
    // The list asked and the deletion asked with the same filter (the time window is "the last 7 days" counted from the moment of asking).
    const asked = host.of("conversation.deleteAll")[0]!.input as { after: string };
    expect(asked).toEqual({ kind: "resource", mode: "enthusiast", after: expect.any(String) });
    expect(Math.abs(Date.parse(asked.after) - (Date.now() - 7 * 86_400_000))).toBeLessThan(60_000);
    expect(handlers.onNotice).toHaveBeenCalledWith(t("records.conv.done", { count: 7 }));
  });

  it("searches by title after the typing stops, and starts again from the first page", async () => {
    const host = installHost({ "conversation.list": () => ({ items: [row("a")], total: 61 }) });
    page();
    await openConversations();
    await screen.findByTestId("conv-a");
    await userEvent.click(screen.getByTestId("conv-pager-next"));
    await waitFor(() => expect(host.of("conversation.list").at(-1)!.input).toMatchObject({ offset: 30 }));
    await userEvent.type(screen.getByTestId("conv-search"), "合成");
    await waitFor(() => expect(host.of("conversation.list").at(-1)!.input).toEqual({ q: "合成", limit: 30, offset: 0 }));
  });

  it("tells when a task kept a conversation, and keeps the ones that could be deleted deleted", async () => {
    installHost({
      "conversation.list": () => ({ items: [row("a"), row("b", { running: true })], total: 2 }),
      "conversation.delete": () => ({ removed: ["a"], skipped: [{ sessionId: "b", reason: "running" }], counts: {}, replaced: {} }),
    });
    const handlers = page();
    await openConversations();
    await userEvent.click(await screen.findByTestId("conv-pick-a"));
    await userEvent.click(screen.getByTestId("conv-pick-b"));
    await userEvent.click(screen.getByTestId("conv-delete-picked"));
    await userEvent.click(screen.getByTestId("conv-confirm-ok"));
    await waitFor(() => expect(handlers.onNotice).toHaveBeenCalled());
    const message = String(handlers.onNotice.mock.calls[0]![0]);
    expect(message).toContain(t("records.conv.done", { count: 1 }));
    expect(message).toContain(t("records.conv.skipped", { count: 1 }));
  });

  it("shows an error from the main process and leaves the list as it was", async () => {
    installHost({
      "conversation.list": () => ({ items: [row("a")], total: 1 }),
      "conversation.delete": () => ({ __error: { code: "STORAGE_READ_ONLY", message: "这个资料库现在只读" } }),
    });
    const handlers = page();
    await openConversations();
    await userEvent.click(await screen.findByTestId("conv-delete-a"));
    await userEvent.click(screen.getByTestId("conv-confirm-ok"));
    await waitFor(() => expect(handlers.onError).toHaveBeenCalledWith("这个资料库现在只读"));
    expect(screen.queryByTestId("conv-confirm")).toBeNull();
    expect(screen.getByTestId("conv-a")).toBeTruthy();
  });

  it("has a grid column for each piece of a row: the tick, the icon, the text and the buttons, and the buttons drop under the text on a narrow page", async () => {
    installHost({ "conversation.list": () => ({ items: [row("a")], total: 1 }) });
    page();
    await openConversations();
    const li = await screen.findByTestId("conv-a");
    // The tick comes first, then the icon, the text and the buttons: four pieces, so four columns (the plain record row has no tick and three).
    expect([...li.children].map((child) => child.className.split(" ")[0])).toEqual(["record-check", "record-icon", "record-main", "record-actions"]);
    expect(li.classList.contains("record-row-select")).toBe(true);
    const css = readFileSync(join(process.cwd(), "apps/desktop/src/renderer/styles-workspace.css"), "utf8").replace(/\r\n/g, "\n");
    // Count the tracks of a `grid-template-columns` value: the words outside the brackets.
    const tracks = (value: string): number => { let depth = 0; let count = 0; let inWord = false; for (const char of value.trim()) { if (char === "(") depth += 1; if (char === ")") depth -= 1; if (/\s/.test(char) && depth === 0) inWord = false; else if (!inWord) { inWord = true; count += 1; } } return count; };
    const wide = /\n\.record-row-select \{ grid-template-columns: ([^;]+);/.exec(css)?.[1];
    expect(wide, "no columns for the row that can be picked").toBeTruthy();
    expect(tracks(wide!)).toBe(li.children.length);
    // On a narrow page the buttons take the whole row below, so the other three pieces are the columns.
    const narrow = /@media \(max-width: 760px\) \{[^@]*?\n  \.record-row-select \{ grid-template-columns: ([^;]+);[^@]*?\n  \.record-actions \{ grid-column: 1 \/ -1;/.exec(css)?.[1];
    expect(narrow, "no narrow columns for the row that can be picked").toBeTruthy();
    expect(tracks(narrow!)).toBe(li.children.length - 1);
  });
});

describe("the right pane after its conversation was deleted", () => {
  it("takes the new conversation the main process made, so the next question is asked there", async () => {
    let current = "ses-old";
    const sent: Array<Record<string, unknown>> = [];
    const host = installHost({
      "conversation.current": () => ({ conversation: { sessionId: current, title: "对话" } }),
      "conversation.history": () => ({ current, items: [] }),
      "workspace.sessions": () => [{ sessionId: current, title: "对话", kind: "shared", targetId: null, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null }],
      "session.stream": () => ({ items: [], hasMore: false, session: { id: current, kind: "shared", targetId: null, workId: null, resourceId: null } }),
      "agent.send": (input) => { sent.push(input); return { runId: "run-1", id: "run-1", status: "running", sessionId: input.sessionId, grantHandle: "g" }; },
      "agent.getRun": () => ({ status: "running" }),
    });
    render(<App />);
    await userEvent.click(await screen.findByTestId("nav-agent"));
    await screen.findByTestId("conversation-bar");
    const before = host.of("workspace.sessions").length;

    current = "ses-new";
    host.notify({ topic: "conversation.deleted", payload: { sessionIds: ["ses-old"], replaced: { enthusiast: { sessionId: "ses-new" } } } });
    await waitFor(() => expect(host.of("workspace.sessions").length).toBeGreaterThan(before));

    const composer = within(screen.getByTestId("page-agent")).getByTestId("agent-composer");
    await userEvent.type(composer, "删除之后的第一句");
    await userEvent.click(within(screen.getByTestId("page-agent")).getByTestId("agent-send"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ sessionId: "ses-new", text: "删除之后的第一句" });
  });
});
