/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { MessageList, ROW_ESTIMATE, resetScrollMemory, type BubbleActions, type RevealRequest } from "../../apps/desktop/src/renderer/components/chat/messages.tsx";
import { useSessionStream, type StreamItem } from "../../apps/desktop/src/renderer/hooks/use-session-stream.ts";

// AT-143 / LOOP-07 in the renderer: only the rows near the viewport are rendered; a refresh keeps the pages already loaded (and drops what was
// deleted); a page loaded above or a refresh leaves the message at the top of the viewport where it was; the top of the list reads the next
// page on its own, once; a message not loaded yet is brought into view after the pages above it. Synthetic messages only.

const t = createTranslator("zh-CN").t;
const actions: BubbleActions = {
  onJumpNote: () => undefined, onJumpVoice: () => undefined, onEditNote: async () => true, onDeleteNote: async () => undefined,
  onQuoteNote: () => undefined, onOpenRecording: () => undefined, onRetry: () => undefined,
};
const at = (index: number) => new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString();
const user = (index: number): StreamItem => ({ kind: "user", id: `msg-${index}`, at: at(index), runId: `r${index}`, text: `第${index}条`, quickTask: null } as StreamItem);
const many = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => user(from + offset));

afterEach(() => { cleanup(); resetScrollMemory(); vi.unstubAllGlobals(); });

/** jsdom lays nothing out: the log gets a height, a content height and a scroll position that stays where it is put. */
function layOut(node: HTMLElement, height = 300, content = 1_000_000) {
  let top = content - height;
  Object.defineProperty(node, "clientHeight", { configurable: true, get: () => height });
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => content });
  Object.defineProperty(node, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
  // use-stick-to-bottom takes a scroll for the person's once it has seen where the list was, and decides a moment later.
  fireEvent.scroll(node);
  return async (value: number) => { top = value; fireEvent.scroll(node); await new Promise((resolve) => setTimeout(resolve, 10)); };
}

type ListOptions = { items: StreamItem[]; memoryKey?: string; hasMore?: boolean; onOlder?: () => void; loadingOlder?: boolean; reveal?: RevealRequest | null; onRevealed?: (found: boolean) => void };
const List = (props: ListOptions) => (
  <MessageList t={t} items={props.items} hasMore={props.hasMore ?? false} onOlder={props.onOlder ?? (() => undefined)} loadingOlder={props.loadingOlder} actions={actions} empty={null} formatDate={String}
    reveal={props.reveal} onRevealed={props.onRevealed} memoryKey={props.memoryKey} />
);
const rendered = () => document.querySelectorAll("[data-testid='chat-rows'] .chat-row").length;
const log = () => screen.getByTestId("chat-log").firstElementChild as HTMLElement;

describe("a long conversation's list (AT-143)", () => {
  it("renders the rows near the viewport, not all 5000", () => {
    render(<List items={many(0, 5000)} />);
    expect(screen.getByTestId("chat-rows").getAttribute("data-count")).toBe("5000");
    expect(rendered()).toBeGreaterThan(0);
    expect(rendered()).toBeLessThan(60);
  });

  it("keeps the message at the top of the viewport in place when an older page is loaded above it", async () => {
    const view = render(<List items={many(200, 400)} hasMore />);
    const scrollTo = layOut(log());
    // Scrolled up to message 250 and a little into it.
    await act(async () => { await scrollTo(50 * ROW_ESTIMATE + 10); });
    view.rerender(<List items={many(0, 400)} hasMore={false} />);
    expect(log().scrollTop).toBe(250 * ROW_ESTIMATE + 10);
  });

  it("puts the next message at the top when the one there was deleted before a refresh", async () => {
    const view = render(<List items={many(0, 300)} />);
    const scrollTo = layOut(log());
    await act(async () => { await scrollTo(100 * ROW_ESTIMATE); });
    // Message 100 and two above it are gone: message 101 is at the top, where 100 was read.
    view.rerender(<List items={many(0, 300).filter((item) => !["msg-10", "msg-50", "msg-100"].includes(item.id))} />);
    expect(log().scrollTop).toBe(98 * ROW_ESTIMATE);
  });

  it("reads the next older page on its own near the top, and not again while it is on its way", async () => {
    const onOlder = vi.fn();
    const view = render(<List items={many(200, 400)} hasMore onOlder={onOlder} />);
    const scrollTo = layOut(log());
    await act(async () => { await scrollTo(100); });
    expect(onOlder).toHaveBeenCalledTimes(1);
    view.rerender(<List items={many(200, 400)} hasMore onOlder={onOlder} loadingOlder />);
    await act(async () => { await scrollTo(50); });
    await act(async () => { await scrollTo(0); });
    expect(onOlder).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("chat-older") as HTMLButtonElement).disabled).toBe(true);
  });

  it("brings a message that is not loaded yet into view: the pages above it first, then the message, highlighted", async () => {
    const onOlder = vi.fn();
    const onRevealed = vi.fn();
    const reveal = { id: "msg-42", token: 1 };
    const view = render(<List items={many(200, 400)} hasMore onOlder={onOlder} reveal={reveal} onRevealed={onRevealed} />);
    layOut(log());
    // The list scrolls to the message the way a browser would.
    log().scrollTo = ((options: ScrollToOptions) => { log().scrollTop = options.top ?? 0; fireEvent.scroll(log()); }) as typeof HTMLElement.prototype.scrollTo;
    expect(onOlder).toHaveBeenCalledTimes(1);
    view.rerender(<List items={many(200, 400)} hasMore onOlder={onOlder} loadingOlder reveal={reveal} onRevealed={onRevealed} />);
    expect(onOlder).toHaveBeenCalledTimes(1);
    view.rerender(<List items={many(0, 400)} hasMore={false} onOlder={onOlder} reveal={reveal} onRevealed={onRevealed} />);
    await waitFor(() => expect(onRevealed).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByTestId("bubble-user-msg-42").parentElement!.getAttribute("data-highlight")).toBe("true"));
    // The message is centred in the viewport.
    expect(log().scrollTop).toBe(Math.round(42 * ROW_ESTIMATE + ROW_ESTIMATE / 2 - 150));
  });

  it("stays at the very bottom when the newest message grows, and does not undo a scroll up that has not been reported yet", async () => {
    const view = render(<List items={many(0, 300)} />);
    const node = log();
    let content = 30_000;
    const scrollTo = layOut(node, 300, 30_000);
    Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => content });
    await act(async () => { await scrollTo(content - 300); });
    // The newest message grows (a reply being written): the list is at the new bottom before it is painted.
    content += 157;
    view.rerender(<List items={[...many(0, 299), { ...user(299), text: "更长的一条" } as StreamItem]} />);
    expect(node.scrollTop).toBe(content - 300);
    // Scrolled up by the scrollbar: a commit that comes before the scroll event reaches the list leaves the position alone.
    node.scrollTop = 600;
    content += 200;
    view.rerender(<List items={[...many(0, 299), { ...user(299), text: "再长一些的一条" } as StreamItem]} />);
    expect(node.scrollTop).toBe(600);
    // Rows drawn up there measure shorter than their estimate: the content shrinks a little, and the place the person went to stays.
    content -= 300;
    view.rerender(<List items={[...many(0, 299), { ...user(299), text: "又改了一次的一条" } as StreamItem]} />);
    expect(node.scrollTop).toBe(600);
  });

  it("stays at the newest message when the browser lowers the position for shorter content (another conversation in the same list), and follows it as it grows", async () => {
    const view = render(<List items={many(0, 300)} memoryKey="a" />);
    const node = log();
    let content = 30_000;
    const scrollTo = layOut(node, 300, 30_000);
    Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => content });
    await act(async () => { await scrollTo(content - 300); });
    // The other conversation is shorter at first: the browser puts the position at the new end, which is not the person scrolling up.
    content = 19_200;
    node.scrollTop = content - 300;
    view.rerender(<List items={many(1000, 1200)} memoryKey="b" />);
    expect(node.scrollTop).toBe(content - 300);
    content = 19_500;
    view.rerender(<List items={[...many(1000, 1199), { ...user(1199), text: "长一些" } as StreamItem]} memoryKey="b" />);
    expect(node.scrollTop).toBe(content - 300);
  });

  it("says a message that is in no page is not there", () => {
    const onRevealed = vi.fn();
    render(<List items={many(0, 10)} reveal={{ id: "gone", token: 2 }} onRevealed={onRevealed} />);
    expect(onRevealed).toHaveBeenCalledWith(false);
  });
});

describe("the stream of a session keeps the pages already loaded (LOOP-07)", () => {
  /** A host holding `total` messages, the ones in `deleted` removed; it answers `session.stream` as the application does. */
  function host(total: number) {
    const deleted = new Set<string>();
    const calls: Array<Record<string, unknown>> = [];
    const all = () => many(0, total).filter((item) => !deleted.has(item.id));
    let hold: Promise<void> | null = null;
    const command = vi.fn(async ({ commandId, input }: { commandId: string; input: Record<string, unknown> }) => {
      if (commandId !== "session.stream") return { status: "ok", value: {} };
      calls.push(input);
      if (hold) await hold;
      const session = { id: "ses", kind: "resource", targetId: "res", workId: null, resourceId: "res" };
      const list = all();
      if (typeof input.from === "string") {
        const from = input.from;
        const kept = list.filter((item) => item.at >= from);
        return { status: "ok", value: { items: kept.slice(-5000), hasMore: kept.length > 5000 || list.some((item) => item.at < from), session } };
      }
      const before = (input.before as string | undefined) ?? "9999";
      const older = list.filter((item) => item.at < before);
      const limit = input.limit as number;
      return { status: "ok", value: { items: older.slice(-limit), hasMore: older.length > limit, session } };
    });
    vi.stubGlobal("manga", { command, onNotice: () => () => undefined });
    return { calls, deleted, holdNext: () => { let release!: () => void; hold = new Promise((resolve) => { release = resolve; }); return () => { hold = null; release(); }; } };
  }

  it("reads the newest page, then from the oldest loaded message on a refresh, without the deleted ones", async () => {
    const server = host(450);
    const { result } = renderHook(() => useSessionStream("ses", { version: 0, running: false }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.items).toHaveLength(200);
    expect(result.current.hasMore).toBe(true);
    // A refresh with only the first page loaded reads the newest page again.
    await act(async () => { await result.current.reload(); });
    expect(server.calls.at(-1)).toEqual({ sessionId: "ses", limit: 200 });
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.items).toHaveLength(400);
    expect(result.current.items[0]!.id).toBe("msg-50");
    server.deleted.add("msg-60");
    await act(async () => { await result.current.reload(); });
    expect(server.calls.at(-1)).toEqual({ sessionId: "ses", from: at(50) });
    expect(result.current.items).toHaveLength(399);
    expect(result.current.items[0]!.id).toBe("msg-50");
    expect(result.current.items.some((item) => item.id === "msg-60")).toBe(false);
    expect(result.current.hasMore).toBe(true);
  });

  it("asks for one older page at a time", async () => {
    const server = host(700);
    const { result } = renderHook(() => useSessionStream("ses", { version: 0, running: false }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const release = server.holdNext();
    const before = server.calls.length;
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => { first = result.current.loadOlder(); second = result.current.loadOlder(); });
    expect(await second).toBe(false);
    await waitFor(() => expect(result.current.loadingOlder).toBe(true));
    release();
    await act(async () => { expect(await first).toBe(true); });
    expect(server.calls.length - before).toBe(1);
    expect(result.current.loadingOlder).toBe(false);
  });

  it("does not show the previous session's messages under the next one", async () => {
    host(10);
    const { result, rerender } = renderHook(({ id }) => useSessionStream(id, { version: 0, running: false }), { initialProps: { id: "ses" as string | undefined } });
    await waitFor(() => expect(result.current.items).toHaveLength(10));
    rerender({ id: "other" });
    expect(result.current.items).toHaveLength(0);
  });
});
