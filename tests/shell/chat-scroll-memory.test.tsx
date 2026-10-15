/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { MessageList, resetScrollMemory, type BubbleActions } from "../../apps/desktop/src/renderer/components/chat/messages.tsx";
import type { StreamItem } from "../../apps/desktop/src/renderer/hooks/use-session-stream.ts";

const t = createTranslator("zh-CN").t;
const actions: BubbleActions = {
  onJumpNote: () => undefined, onJumpVoice: () => undefined, onEditNote: async () => true, onDeleteNote: async () => undefined,
  onQuoteNote: () => undefined, onOpenRecording: () => undefined, onRetry: () => undefined,
};
const user = (id: string, text: string): StreamItem => ({ kind: "user", id, at: "2026-10-01T10:00:00.000Z", text } as StreamItem);

/** jsdom lays nothing out; the log gets a height of its own and a scroll position that stays where it is put. */
function layOut(node: HTMLElement) {
  let top = 0;
  Object.defineProperty(node, "clientHeight", { configurable: true, get: () => 300 });
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => 2000 });
  Object.defineProperty(node, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
  return (value: number) => { top = value; fireEvent.scroll(node); };
}

function List(props: { memoryKey: string; items: StreamItem[]; ready: boolean }) {
  return <MessageList t={t} items={props.items} hasMore={false} onOlder={() => undefined} actions={actions} empty={null} formatDate={String} memoryKey={props.memoryKey} ready={props.ready} />;
}

afterEach(() => { cleanup(); resetScrollMemory(); });

describe("AT-88 the right pane's place in a conversation", () => {
  it("comes back to where a conversation was scrolled to after another one was shown", () => {
    const a = [user("a1", "甲一"), user("a2", "甲二")];
    const b = [user("b1", "乙一")];
    const view = render(<List memoryKey="ses_a" items={a} ready />);
    const log = screen.getByTestId("chat-log").firstElementChild as HTMLElement;
    const scrollTo = layOut(log);
    scrollTo(740);

    // The other conversation is shown: its messages are loading, then there.
    view.rerender(<List memoryKey="ses_b" items={[]} ready={false} />);
    view.rerender(<List memoryKey="ses_b" items={b} ready />);
    scrollTo(0);

    view.rerender(<List memoryKey="ses_a" items={[]} ready={false} />);
    view.rerender(<List memoryKey="ses_a" items={a} ready />);
    expect(log.scrollTop).toBe(740);
  });

  it("keeps a conversation that was read at its newest message at the newest", () => {
    const a = [user("a1", "甲一")];
    const view = render(<List memoryKey="ses_a" items={a} ready />);
    const log = screen.getByTestId("chat-log").firstElementChild as HTMLElement;
    const scrollTo = layOut(log);
    scrollTo(1700);
    view.rerender(<List memoryKey="ses_b" items={[]} ready={false} />);
    view.rerender(<List memoryKey="ses_a" items={[]} ready={false} />);
    log.scrollTop = 0;
    view.rerender(<List memoryKey="ses_a" items={a} ready />);
    // It was at the bottom, so it is not put anywhere: the pane follows the newest message as it always does.
    expect(log.scrollTop).toBe(0);
  });

  it("does not take the movement of another conversation's messages sliding in for the place of this one", () => {
    const a = [user("a1", "甲一")];
    const b = [user("b1", "乙一")];
    const view = render(<List memoryKey="ses_a" items={a} ready />);
    const log = screen.getByTestId("chat-log").firstElementChild as HTMLElement;
    const scrollTo = layOut(log);
    scrollTo(500);
    // Under the new key the old messages are still there for a moment, and the browser reports a scroll as they are replaced.
    view.rerender(<List memoryKey="ses_b" items={a} ready={false} />);
    scrollTo(0);
    view.rerender(<List memoryKey="ses_b" items={b} ready />);
    view.rerender(<List memoryKey="ses_a" items={a} ready={false} />);
    view.rerender(<List memoryKey="ses_a" items={a} ready />);
    expect(log.scrollTop).toBe(500);
  });
});
