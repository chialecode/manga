/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { TraceDialog } from "../../apps/desktop/src/renderer/components/trace-dialog.tsx";
import { AgentPage } from "../../apps/desktop/src/renderer/pages/settings/agent-page.tsx";
import { MessageList, type BubbleActions } from "../../apps/desktop/src/renderer/components/chat/messages.tsx";
import { entryTitle, readable, sizeLabel, spanLabel, type TraceEntry } from "../../apps/desktop/src/renderer/lib/trace-model.ts";
import type { StreamItem } from "../../apps/desktop/src/renderer/hooks/use-session-stream.ts";

/** AT-97 in the window: the timeline of a task's trace, its parts a page at a time, the copy, the settings of what is kept, and the way in from a reply. */

const i18n = createTranslator("zh-CN");
const t = i18n.t;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const entry = (patch: Partial<TraceEntry> & { id: string }): TraceEntry => ({
  runId: "run_1", step: 0, kind: "model", name: "chat", status: "ok", startedAt: "2026-10-09T03:00:00.000Z", firstTokenMs: 310, durationMs: 1_840, connectionId: "conn_1", modelId: "demo",
  protocol: "openai-chat-completions · native", requestBytes: 2_048, responseBytes: 512, truncated: false, hasContent: true, usage: { inputTokens: 1_234, outputTokens: 56 }, error: null, ...patch,
});
const ENTRIES: TraceEntry[] = [
  entry({ id: "req_1", step: 0 }),
  entry({ id: "req_2", step: 0, kind: "tool", name: "library.find", startedAt: "2026-10-09T03:00:02.000Z", firstTokenMs: null, durationMs: 40, usage: null, modelId: null, protocol: null }),
  entry({ id: "req_3", step: 1, kind: "compaction", name: "compaction#1", startedAt: "2026-10-09T03:00:03.000Z", firstTokenMs: null }),
  entry({ id: "req_4", step: 1, kind: "compaction", name: "compaction", startedAt: "2026-10-09T03:00:04.000Z", firstTokenMs: null, durationMs: 0, modelId: null, protocol: null, usage: null }),
  entry({ id: "req_5", step: 1, startedAt: "2026-10-09T03:00:05.000Z", status: "error", firstTokenMs: null, error: { code: "PROVIDER_UNAVAILABLE", message: "provider HTTP 500" }, truncated: true }),
];

const PRETTY_REQUEST = { model: "demo", messages: [{ role: "user", content: "在资料里找一下 x" }], maxOutputTokens: 2_048 };
const REQUEST_TEXT = JSON.stringify(PRETTY_REQUEST);

function host(options: { entries?: TraceEntry[]; stats?: { count: number; bytes: number }; pageChars?: number } = {}) {
  const calls: Array<{ commandId: string; input: Record<string, any> }> = [];
  let stats = options.stats ?? { count: 5, bytes: 2_500 };
  let settings = { limits: { maxSteps: 24, maxDurationMs: 600_000 }, trace: { mode: "full", retentionDays: 30, maxMegabytes: 500 } };
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, any> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      switch (payload.commandId) {
        case "agent.trace.list": return { status: "ok", value: { entries: options.entries ?? ENTRIES } };
        case "agent.trace.get": {
          const known = (options.entries ?? ENTRIES).find((item) => item.id === input.entryId);
          if (input.entryId === "req_4" || (known && !known.hasContent)) return { status: "ok", value: { entryId: "req_4", part: input.part, available: false, text: "", offset: 0, total: 0, truncated: false, bytes: 0 } };
          const text = input.entryId === "req_5" && input.part === "response" ? JSON.stringify({ truncated: true, note: "（已截断）" }) : REQUEST_TEXT;
          const chars = [...text];
          return { status: "ok", value: { entryId: input.entryId, part: input.part, available: true, text: chars.slice(input.offset, input.offset + (options.pageChars ?? input.limit)).join(""), offset: input.offset, total: chars.length, truncated: input.entryId === "req_5", bytes: text.length } };
        }
        case "agent.trace.export": return { status: "ok", value: { json: "{\"runId\":\"run_1\"}", entries: 5, omitted: 0 } };
        case "agent.trace.stats": return { status: "ok", value: stats };
        case "agent.trace.clear": { const removed = stats.count; stats = { count: 0, bytes: 0 }; return { status: "ok", value: { removed } }; }
        case "settings.getAgent": return { status: "ok", value: settings };
        case "settings.setAgent": {
          settings = { limits: { ...settings.limits, ...input.limits }, trace: { ...settings.trace, ...input.trace } } as typeof settings;
          return { status: "ok", value: settings };
        }
        default: return { status: "ok", value: {} };
      }
    },
    onNotice: () => () => undefined,
  };
  return { calls, written };
}

describe("how an entry is named and measured", () => {
  it("names a compaction by what it did and a tool by its command", () => {
    expect(entryTitle(t, ENTRIES[0]!)).toBe("对话请求");
    expect(entryTitle(t, ENTRIES[1]!)).toBe("library.find");
    expect(entryTitle(t, ENTRIES[2]!)).toBe("写摘要，第 1 次");
    expect(entryTitle(t, ENTRIES[3]!)).toBe("较早的对话换成摘要");
    expect(entryTitle(t, entry({ id: "x", kind: "compaction", name: "trim-tool-results" }))).toBe("裁短较早的工具结果");
    // A name this window has no words for falls back to the kind.
    expect(entryTitle(t, entry({ id: "y", name: "something-new" }))).toBe("模型请求");
  });

  it("writes spans and sizes as a person reads them, and indents a part only once it is whole", () => {
    expect(spanLabel(40)).toBe("40 ms");
    expect(spanLabel(1_840)).toBe("1.8 s");
    expect(spanLabel(125_000)).toBe("2 m 05 s");
    expect(sizeLabel(900)).toBe("900 B");
    expect(sizeLabel(2_048)).toBe("2.0 KB");
    expect(readable("{\"a\":1}", true)).toBe("{\n  \"a\": 1\n}");
    expect(readable("{\"a\":", false)).toBe("{\"a\":");
    expect(readable("not json", true)).toBe("not json");
  });
});

describe("the timeline of a task (AT-97)", () => {
  function open(onNotice = vi.fn()) {
    const view = render(<TraceDialog t={t} runId="run_1" formatNumber={i18n.formatNumber} onNotice={onNotice} onClose={vi.fn()} />);
    return { view, onNotice };
  }

  it("lists the requests, the tool and the compactions in order, with how long each took and when it began", async () => {
    host();
    open();
    const list = await screen.findByTestId("trace-list");
    const items = within(list).getAllByRole("button");
    expect(items.map((item) => item.getAttribute("data-kind"))).toEqual(["model", "tool", "compaction", "compaction", "model"]);
    expect(items[0]!.textContent).toContain("对话请求");
    expect(items[0]!.textContent).toContain("开始后 0 ms");
    expect(items[1]!.textContent).toContain("library.find");
    expect(items[1]!.textContent).toContain("40 ms");
    expect(items[1]!.textContent).toContain("开始后 2.0 s");
    expect(items[4]!.getAttribute("data-status")).toBe("error");
    expect(items[0]!.getAttribute("aria-current")).toBe("true");
  });

  it("shows the model, the times and the tokens of the picked entry, and what was sent, indented", async () => {
    host();
    open();
    expect((await screen.findByTestId("trace-model")).textContent).toContain("demo");
    expect(screen.getByTestId("trace-first-token").textContent).toBe("首字 310 ms");
    expect(screen.getByTestId("trace-duration").textContent).toBe("耗时 1.8 s");
    expect(screen.getByTestId("trace-tokens").textContent).toBe("输入 1,234 · 输出 56");
    await waitFor(() => expect(screen.getByTestId("trace-text-request").textContent).toBe(JSON.stringify(PRETTY_REQUEST, null, 2)));
    expect(screen.getByTestId("trace-text-response").textContent).toContain("maxOutputTokens");
    expect(screen.queryByTestId("trace-more-request")).toBeNull();
  });

  it("opens another entry from the list, and says what is missing when a part has no content", async () => {
    const { calls } = host();
    open();
    await screen.findByTestId("trace-detail");
    fireEvent.click(screen.getByTestId("trace-item-req_4"));
    await waitFor(() => expect(screen.getByTestId("trace-detail").getAttribute("data-entry")).toBe("req_4"));
    expect((await screen.findByTestId("trace-part-request-none")).textContent).toBe("这一部分没有内容。");
    expect(calls.some((call) => call.commandId === "agent.trace.get" && call.input.entryId === "req_4" && call.input.part === "request")).toBe(true);
  });

  it("says that only sizes were kept when the mode was the small one", async () => {
    host({ entries: [entry({ id: "req_m", hasContent: false })] });
    open();
    // The host answers "not available" for a part that was not kept; the sizes and times are still there.
    expect((await screen.findByTestId("trace-part-request-none")).textContent).toBe("按设置只记了大小、耗时和状态，没有保留内容。");
    expect((await screen.findByTestId("trace-part-response-none")).textContent).toContain("没有保留内容");
    expect(screen.getByTestId("trace-duration").textContent).toBe("耗时 1.8 s");
  });

  it("brings a long part a page at a time and indents it when it is whole", async () => {
    const { calls } = host({ pageChars: 40 });
    open();
    const more = await screen.findByTestId("trace-more-request");
    expect(screen.getByTestId("trace-text-request").textContent).toBe([...REQUEST_TEXT].slice(0, 40).join(""));
    expect(screen.getByTestId("trace-part-request").textContent).toContain(`已显示 40 / ${[...REQUEST_TEXT].length} 字`);
    fireEvent.click(more);
    await waitFor(() => expect(calls.filter((call) => call.commandId === "agent.trace.get" && call.input.part === "request" && call.input.offset === 40)).toHaveLength(1));
    for (let page = 0; page < 6 && screen.queryByTestId("trace-more-request"); page += 1) {
      fireEvent.click(screen.getByTestId("trace-more-request"));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    await waitFor(() => expect(screen.queryByTestId("trace-more-request")).toBeNull());
    expect(screen.getByTestId("trace-text-request").textContent).toBe(JSON.stringify(PRETTY_REQUEST, null, 2));
  });

  it("shows the error of a request that failed and the mark of a part that was cut", async () => {
    host();
    open();
    await screen.findByTestId("trace-detail");
    fireEvent.click(screen.getByTestId("trace-item-req_5"));
    expect((await screen.findByTestId("trace-error")).textContent).toBe("出错：provider HTTP 500");
    expect((await screen.findByTestId("trace-part-response-cut")).textContent).toContain("截断");
  });

  it("copies the whole trace as one JSON text and says how many entries it holds", async () => {
    const { written } = host();
    const { onNotice } = open();
    await screen.findByTestId("trace-detail");
    await act(async () => { fireEvent.click(screen.getByTestId("trace-copy")); });
    await waitFor(() => expect(written).toEqual(["{\"runId\":\"run_1\"}"]));
    expect(onNotice).toHaveBeenCalledWith("已复制 5 条调用记录");
  });

  it("says why there is nothing when nothing was kept", async () => {
    host({ entries: [] });
    open();
    expect((await screen.findByTestId("trace-empty")).textContent).toContain("没有留下调用记录");
    expect(screen.queryByTestId("trace-copy")).toBeNull();
  });
});

describe("what is kept, in the settings of the agent (AT-97)", () => {
  it("shows what is kept and its size, changes the mode and the limits, and clears it after asking", async () => {
    const { calls } = host();
    const onNotice = vi.fn();
    render(<AgentPage t={t} onError={vi.fn()} onNotice={onNotice} />);
    await waitFor(() => expect(screen.getByTestId("agent-trace-stats").textContent).toContain("已记录 5 条，占用 2.4 KB"));
    expect((screen.getByTestId("agent-trace-mode") as HTMLSelectElement).value).toBe("full");

    fireEvent.change(screen.getByTestId("agent-trace-mode"), { target: { value: "metadata" } });
    await waitFor(() => expect(calls.find((call) => call.commandId === "settings.setAgent")?.input).toEqual({ trace: { mode: "metadata" } }));
    fireEvent.change(screen.getByTestId("agent-retention"), { target: { value: "7" } });
    fireEvent.blur(screen.getByTestId("agent-retention"));
    await waitFor(() => expect(calls.filter((call) => call.commandId === "settings.setAgent").at(-1)?.input).toEqual({ trace: { retentionDays: 7 } }));
    fireEvent.change(screen.getByTestId("agent-max-mb"), { target: { value: "5" } });
    fireEvent.blur(screen.getByTestId("agent-max-mb"));
    expect((await screen.findByTestId("agent-max-mb-error")).textContent).toContain("10 – 5000");
    expect(calls.filter((call) => call.commandId === "settings.setAgent")).toHaveLength(2);

    // Clearing asks first, and cancelling leaves everything as it was.
    fireEvent.click(screen.getByTestId("agent-trace-clear"));
    expect(screen.getByTestId("agent-trace-confirm")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("agent-trace-confirm")).getByText("取消"));
    expect(calls.some((call) => call.commandId === "agent.trace.clear")).toBe(false);
    fireEvent.click(screen.getByTestId("agent-trace-clear"));
    fireEvent.click(screen.getByTestId("agent-trace-clear-confirm"));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("已清空 5 条调用记录"));
    await waitFor(() => expect(screen.getByTestId("agent-trace-stats").textContent).toContain("还没有调用记录"));
    expect((screen.getByTestId("agent-trace-clear") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the way in from a reply (AT-97)", () => {
  const actionsWith = (onOpenTrace?: (runId: string) => void): BubbleActions => ({
    onJumpNote: () => undefined, onJumpVoice: () => undefined, onEditNote: async () => true, onDeleteNote: async () => undefined,
    onQuoteNote: () => undefined, onOpenRecording: () => undefined, onRetry: () => undefined, ...(onOpenTrace ? { onOpenTrace } : {}),
  });
  const agent = (id: string, status: string): StreamItem => ({ kind: "agent", id, at: "2026-10-09T03:00:00.000Z", runId: `run_${id}`, status, text: status === "failed" ? "" : "答复", error: status === "failed" ? { code: "PROVIDER_UNAVAILABLE", message: "出错了" } : null });
  const list = (items: StreamItem[], actions: BubbleActions) => <MessageList t={t} items={items} hasMore={false} onOlder={() => undefined} actions={actions} empty={null} formatDate={String} />;

  it("puts a link to the trace under every reply that has finished, the failed one beside its retry, and none under a task still running", () => {
    const opened: string[] = [];
    render(list([agent("a", "succeeded"), agent("b", "failed"), agent("c", "running")], actionsWith((runId) => opened.push(runId))));
    fireEvent.click(screen.getByTestId("bubble-trace-a"));
    fireEvent.click(screen.getByTestId("bubble-trace-b"));
    expect(opened).toEqual(["run_a", "run_b"]);
    expect(screen.getByTestId("bubble-retry-b")).toBeTruthy();
    expect(screen.getByTestId("bubble-trace-a").textContent).toBe("查看调用记录");
    expect(screen.queryByTestId("bubble-trace-c")).toBeNull();
    expect(screen.queryByTestId("bubble-retry-a")).toBeNull();
  });

  it("shows no link where the conversation cannot open one", () => {
    render(list([agent("a", "succeeded")], actionsWith()));
    expect(screen.queryByTestId("bubble-trace-a")).toBeNull();
  });
});
