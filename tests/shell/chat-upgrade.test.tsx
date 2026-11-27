// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { memo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import type { AgentStreamEvent, StreamAgent, StreamItem, StreamUser } from "@manga/contracts";
import { Bubble, type BubbleActions } from "../../apps/desktop/src/renderer/components/chat/bubbles.tsx";
import { sanitizeMermaidSvg } from "../../apps/desktop/src/renderer/components/chat/code-block.tsx";
import { Composer } from "../../apps/desktop/src/renderer/components/chat/composer.tsx";
import { ChatMarkdown, injectCitationMarkers } from "../../apps/desktop/src/renderer/components/chat/markdown.tsx";
import { MathFormula } from "../../apps/desktop/src/renderer/components/chat/math-formula.tsx";
import { collectSources, SourcesFooter } from "../../apps/desktop/src/renderer/components/chat/citations.tsx";
import { ThinkingTimeline } from "../../apps/desktop/src/renderer/components/chat/timeline.tsx";
import { applyAgentStreamEvents } from "../../apps/desktop/src/renderer/hooks/use-session-stream.ts";
import { localizeChatError } from "../../apps/desktop/src/renderer/lib/chat-errors.ts";
import { localizedToolName } from "../../apps/desktop/src/renderer/lib/chat-tools.ts";
import { stripMarkdownForSpeech } from "../../apps/desktop/src/renderer/voice/read-aloud.ts";
import { hasAvailableTextModel } from "../../apps/desktop/src/renderer/workspace/agent.tsx";
import { Drafts, DraftsContext, useDraftMeta } from "../../apps/desktop/src/renderer/workspace/drafts.ts";
import { ModelsPage } from "../../apps/desktop/src/renderer/pages/settings/models-page.tsx";

const i18n = createTranslator("zh-CN");
const t = i18n.t;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function baseActions(overrides: Partial<BubbleActions> = {}): BubbleActions {
  return {
    onJumpNote: vi.fn(),
    onJumpVoice: vi.fn(),
    onEditNote: vi.fn(async () => true),
    onDeleteNote: vi.fn(async () => {}),
    onQuoteNote: vi.fn(),
    onOpenRecording: vi.fn(),
    onRetry: vi.fn(),
    onOpenTrace: vi.fn(),
    ...overrides,
  };
}

describe("Chat Markdown, Code, Math, Mermaid, and Citations", () => {
  it("preserves CJK single-tilde ranges, pads ragged GFM tables, and sanitizes unsafe links", () => {
    const openExternal = vi.fn(async () => true);
    (window as unknown as { manga?: unknown }).manga = { openExternal };

    const md = [
      "预算大约 100~200 元，而 ~~旧价格~~ 已过期。",
      "",
      "| 列1 | 列2 | 列3 |",
      "| --- | --- | --- |",
      "| A | B |",
      "",
      "[安全链接](https://example.com/guide) 和 [危险链接](javascript:alert(1))",
    ].join("\n");

    const { container } = render(<ChatMarkdown t={t} text={md} />);
    const del = container.querySelectorAll("del");
    expect(del).toHaveLength(1);
    expect(del[0]!.textContent).toBe("旧价格");
    expect(container.textContent).toContain("100~200");

    // Ragged row padded to 3 cells inside scrollable `.chat-table-wrap`.
    expect(container.querySelector(".chat-table-wrap")).not.toBeNull();
    expect(container.querySelectorAll("tbody tr:first-child td")).toHaveLength(3);

    // Unsafe javascript: URL stripped; safe https: opens externally.
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://example.com/guide");
    fireEvent.click(links[0]!);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/guide");

    // External Markdown images never render <img> (preventing CSP violations & tracking pixels), while local safe schemes do.
    cleanup();
    const imgMd = [
      "![追踪像素](https://tracker.example/pixel.png)",
      "![恶意SVG](data:image/svg+xml,<svg/>)",
      "![本地图](manga-media://thumb/1)",
      "![内联图](data:image/png;base64,iVBORw0KGgo=)",
    ].join("\n\n");
    const { container: imgContainer } = render(<ChatMarkdown t={t} text={imgMd} />);
    const renderedImgs = imgContainer.querySelectorAll("img");
    expect(renderedImgs).toHaveLength(2);
    expect(renderedImgs[0]!.getAttribute("src")).toBe("manga-media://thumb/1");
    expect(renderedImgs[0]!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(renderedImgs[1]!.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    const extImgLink = screen.getByTestId("chat-markdown-external-img");
    expect(extImgLink.textContent).toBe("追踪像素");
    fireEvent.click(extImgLink);
    expect(openExternal).toHaveBeenCalledWith("https://tracker.example/pixel.png");
  });

  it("renders code blocks with language badge, line wrap toggle, and copy feedback", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<ChatMarkdown t={t} text={"```ts\nconst answer = 42;\n```"} />);
    const block = screen.getByTestId("chat-codeblock");
    expect(block.getAttribute("data-language")).toBe("typescript");
    expect(block.getAttribute("data-wrapped")).toBe("false");

    fireEvent.click(screen.getByTestId("chat-code-wrap"));
    expect(block.getAttribute("data-wrapped")).toBe("true");

    fireEvent.click(screen.getByTestId("chat-code-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const answer = 42;"));
    await waitFor(() => expect(screen.getByTestId("chat-code-copy").getAttribute("data-copied")).toBe("true"));
  });

  it("provides Mermaid diagram/code toggle and strips image/script tags from SVG output", () => {
    render(<ChatMarkdown t={t} text={"```mermaid\ngraph TD\n  A --> B\n```"} />);
    expect(screen.getByTestId("chat-mermaid")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-mermaid-code"));
    expect(screen.queryByTestId("chat-mermaid")).toBeNull();
    expect(screen.getByText(/graph TD/)).toBeTruthy();

    const dirty = '<svg><image href="https://evil.example/a.png"/><img src="x"/><script>alert(1)</script><rect/></svg>';
    const clean = sanitizeMermaidSvg(dirty);
    expect(clean).not.toContain("<image");
    expect(clean).not.toContain("<img");
    expect(clean).not.toContain("<script");
    expect(clean).toContain("<rect/>");
  });

  it("parses inline and display LLM math delimiters ($...$, \\(...\\), \\[...\\]) and preserves last-valid HTML while streaming", async () => {
    const { rerender } = render(
      <ChatMarkdown t={t} text={"质能方程 $E = mc^2$ 与 \\(a^2 + b^2 = c^2\\)\n\n\\[\n\\frac{1}{2}\n\\]"} streaming />,
    );
    await waitFor(() => expect(screen.getAllByTestId("chat-math-inline")).toHaveLength(2));
    expect(screen.getByTestId("chat-math-block")).toBeTruthy();

    // Instant flush once streaming ends.
    rerender(<ChatMarkdown t={t} text={"公式 $E = mc^2$ 完成"} streaming={false} />);
    expect(screen.getAllByTestId("chat-math-inline")).toHaveLength(1);

    // Direct MathFormula last-valid HTML retention while streaming incomplete TeX.
    cleanup();
    const { rerender: rerenderFormula, container } = render(<MathFormula value="E = mc^2" streaming />);
    await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
    const validHtml = screen.getByTestId("chat-math-inline").innerHTML;
    rerenderFormula(<MathFormula value="\\frac{1" streaming />);
    expect(screen.getByTestId("chat-math-inline").innerHTML).toBe(validHtml);
  });

  it("supports 3-tier citations: inline badge, hover/focus portal card, and sources footer/panel", () => {
    const citations = [
      { index: 1, start: 0, end: 4, url: "https://docs.example.com/a", title: "示例来源一", site: "docs.example.com", publishedAt: "2026-05-01", snippet: "这是一段摘要内容。" },
      { index: 2, url: "https://news.example.com/b", title: "示例来源二", site: "news.example.com" },
    ];
    const sources = collectSources(citations);
    expect(injectCitationMarkers("正文内容，更多细节", citations)).toBe("正文内容[citation:1]，更多细节");

    render(
      <>
        <ChatMarkdown t={t} text="正文内容[citation:1]" citations={citations} sources={sources} />
        <SourcesFooter t={t} id="a1" sources={sources} />
      </>,
    );

    const badge = screen.getByTestId("cite-badge-1");
    fireEvent.focus(badge);
    expect(screen.getByTestId("cite-hover-1").textContent).toContain("示例来源一");
    expect(screen.getByTestId("cite-hover-1").textContent).toContain("这是一段摘要内容。");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("cite-hover-1")).toBeNull();

    // Tier 3 preserves `bubble-sources-${id}` with titles readable directly in DOM, plus expandable panel.
    const footer = screen.getByTestId("bubble-sources-a1");
    expect(footer.textContent).toContain("2 个参考来源");
    expect(footer.textContent).toContain("示例来源一");
    fireEvent.click(screen.getByTestId("bubble-sources-toggle-a1"));
    expect(screen.getByTestId("bubble-sources-panel-a1")).toBeTruthy();
  });
});

describe("Unified Thinking + Server Tool + MANGA Tool Timeline", () => {
  it("opens while actively thinking, auto-collapses on completion, and opens again on summary click", () => {
    const item: StreamAgent = {
      kind: "agent",
      id: "run-1",
      at: "2026-11-27T10:00:00Z",
      runId: "run-1",
      status: "running",
      text: "",
      error: null,
      reasoning: "先分析问题并搜索资料。",
      reasoningStartedAt: "2026-11-27T10:00:00Z",
      serverToolSteps: [
        { id: "s1", kind: "search", status: "done", queries: ["查询一", "查询二"], pages: [{ url: "https://a.example.com", title: "网页A" }] },
        { id: "s2", kind: "find_in_page", status: "done", keywords: [{ pattern: "关键词", found: true }] },
      ],
      toolSteps: [
        { id: "t1", name: "library.find", status: "done", elapsedMs: 1200 },
      ],
    };

    const { rerender } = render(<ThinkingTimeline t={t} item={item} live />);
    const box = screen.getByTestId("bubble-thinking-run-1") as HTMLDetailsElement;
    expect(box.open).toBe(true);
    expect(screen.getByTestId("timeline-server-search")).toBeTruthy();
    expect(screen.getByTestId("timeline-server-find_in_page")).toBeTruthy();
    // Localized Chinese tool label, never raw command ID.
    expect(screen.getByTestId("timeline-tool-t1").textContent).toContain(localizedToolName(t, "library.find"));
    expect(screen.getByTestId("timeline-tool-t1").textContent).not.toContain("library.find");

    // Transition to finished -> auto-collapsed so deepseek-walk clicking summary opens it.
    rerender(<ThinkingTimeline t={t} item={{ ...item, status: "succeeded", text: "最终回答", reasoningElapsedMs: 3000 }} live={false} />);
    expect(box.open).toBe(false);
    fireEvent.click(box.querySelector("summary")!);
    expect(box.open).toBe(true);
  });
});

describe("Message Actions, Read-Aloud Cleanup, and Error Localization", () => {
  it("renders assistant actions (copy, regenerate, continue, save-note, trace, usage) and localized errors", async () => {
    const onRegenerate = vi.fn();
    const onContinue = vi.fn();
    const onSaveNote = vi.fn(async () => true);
    const onOpenSettings = vi.fn();
    const onOpenTrace = vi.fn();

    const item: StreamAgent = {
      kind: "agent",
      id: "msg-1",
      at: "2026-11-27T10:00:00Z",
      runId: "run-1",
      status: "cancelled",
      stopReason: "cancelled",
      canContinue: true,
      text: "回答内容",
      error: { code: "QUOTA_EXCEEDED", message: "HTTP 402 insufficient balance", errorCode: "balance" },
      usage: { inputTokens: 1200, outputTokens: 350, cachedInputTokens: 600, searches: 2, estimatedCost: 0.0025, currency: "CNY" },
    };

    render(
      <Bubble
        t={t}
        item={item}
        formatDate={() => "刚刚"}
        actions={baseActions({ onRegenerate, onContinue, onSaveNote, onOpenSettings, onOpenTrace, canSaveNote: true })}
      />,
    );

    expect(screen.getByTestId("bubble-agent-msg-1").textContent).toContain("MANGA 助手");
    expect(screen.getByTestId("bubble-error-msg-1").textContent).toContain("余额不足");
    expect(screen.getByTestId("bubble-error-msg-1").textContent).not.toContain("HTTP 402");

    fireEvent.click(screen.getByTestId("bubble-error-settings-msg-1"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("bubble-continue-msg-1"));
    expect(onContinue).toHaveBeenCalledWith("run-1");

    fireEvent.click(screen.getByTestId("bubble-regenerate-msg-1"));
    expect(onRegenerate).toHaveBeenCalledWith("run-1");

    fireEvent.click(screen.getByTestId("bubble-save-note-msg-1"));
    await waitFor(() => expect(onSaveNote).toHaveBeenCalledTimes(1));

    // Trace button stays directly mounted and clickable for smoke walkthroughs.
    fireEvent.click(screen.getByTestId("bubble-trace-msg-1"));
    expect(onOpenTrace).toHaveBeenCalledWith("run-1");

    expect(screen.getByTestId("bubble-usage-msg-1").textContent).toContain("1.2k");
    expect(screen.getByTestId("bubble-usage-msg-1").textContent).toContain("¥0.0025");
  });

  it("supports inline UserBubble edit & resend with IME guard", async () => {
    const onEditUser = vi.fn(async () => true);
    const userItem: StreamUser = {
      kind: "user",
      id: "u1",
      at: "2026-11-27T10:00:00Z",
      runId: "run-u1",
      text: "旧问题",
      quickTask: null,
    };

    render(<Bubble t={t} item={userItem} formatDate={() => "刚刚"} actions={baseActions({ onEditUser })} />);
    fireEvent.click(screen.getByTestId("bubble-user-edit-u1"));
    const input = screen.getByTestId("bubble-user-edit-input-u1") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "新问题" } });

    // IME Enter must NOT submit.
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onEditUser).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onEditUser).toHaveBeenCalledWith("run-u1", "新问题"));
  });

  it("strips Markdown syntax and URLs for read-aloud and maps error categories cleanly", () => {
    const cleaned = stripMarkdownForSpeech("# 标题\n\n看[说明](https://example.com)和[citation:1]\n\n```ts\nconst x = 1;\n```\n\n继续正文 https://foo.bar/baz");
    expect(cleaned).toContain("标题");
    expect(cleaned).toContain("看说明和");
    expect(cleaned).toContain("继续正文");
    expect(cleaned).not.toContain("https://");
    expect(cleaned).not.toContain("const x = 1");
    expect(cleaned).not.toContain("[citation:1]");

    expect(localizeChatError(t, { status: "failed", error: { code: "UNKNOWN", message: "401 unauthorized" } })?.code).toBe("auth");
    expect(localizeChatError(t, { status: "failed", error: { code: "RATE_LIMITED", message: "429" } })?.code).toBe("rate_limit");
    expect(localizeChatError(t, { status: "succeeded", refusal: true, error: null })?.code).toBe("refusal");
  });
});

describe("Live IPC Stream Patching & Draft Isolation", () => {
  it("patches only the active StreamAgent row while preserving object identity of prior rows", () => {
    const first: StreamItem = { kind: "user", id: "u1", at: "2026-11-27T10:00:00Z", runId: "r1", text: "你好", quickTask: null };
    const initial: StreamItem[] = [first];
    const events: AgentStreamEvent[] = [
      { kind: "start", sessionId: "s1", runId: "r1", modelId: "deepseek-chat", at: "2026-11-27T10:00:01Z" },
      { kind: "reasoning-delta", sessionId: "s1", runId: "r1", delta: "思考A" },
      { kind: "text-delta", sessionId: "s1", runId: "r1", delta: "你好" },
      { kind: "text-delta", sessionId: "s1", runId: "r1", delta: "世界" },
      { kind: "done", sessionId: "s1", runId: "r1", status: "succeeded", stopReason: "end_turn" },
    ];

    const updated = applyAgentStreamEvents(initial, events);
    expect(updated).toHaveLength(2);
    expect(updated[0]).toBe(first);
    const reply = updated[1] as StreamAgent;
    expect(reply.reasoning).toBe("思考A");
    expect(reply.text).toBe("你好世界");
    expect(reply.status).toBe("succeeded");
    expect(reply.modelId).toBe("deepseek-chat");
  });

  it("isolates typing state in Drafts so typing does not re-render MessageList siblings and preserves per-session drafts", () => {
    const drafts = new Drafts();
    let listRenders = 0;
    const SpyList = memo(function SpyList() {
      listRenders += 1;
      return <div data-testid="spy-list">list</div>;
    });

    function Harness() {
      const [key, setKey] = useState("session:a");
      const { composer } = useDraftMeta(key);
      return (
        <div>
          <button type="button" data-testid="switch-session" onClick={() => setKey((k) => (k === "session:a" ? "session:b" : "session:a"))}>switch</button>
          <SpyList />
          <Composer
            t={t}
            draftKey={key}
            mode="ask"
            onMode={() => {}}
            tags={[]}
            images={composer.images}
            onRemoveTag={() => {}}
            onRemoveImage={() => {}}
            quick={[]}
            onQuick={() => {}}
            noModel={false}
            onSettings={() => {}}
            running={false}
            onStop={() => {}}
            onSend={() => {}}
            sending={false}
            plus={{ attach: null, online: false, subtitle: false, allowOnline: false, subtitleAheadMin: 0, materials: 0 }}
            onAttach={() => {}}
            onToggleOnline={() => {}}
            onSubtitleAhead={() => {}}
            onMaterials={() => {}}
            mic={null}
          />
        </div>
      );
    }

    render(
      <DraftsContext.Provider value={drafts}>
        <Harness />
      </DraftsContext.Provider>,
    );
    expect(listRenders).toBe(1);

    const textarea = screen.getByTestId("agent-composer") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "会话A草稿" } });
    fireEvent.change(textarea, { target: { value: "会话A草稿继续输入" } });
    // Zero re-renders of sibling list while typing!
    expect(listRenders).toBe(1);
    expect(textarea.value).toBe("会话A草稿继续输入");

    // Switch to session B and back to session A: draft is preserved per session.
    fireEvent.click(screen.getByTestId("switch-session"));
    expect(textarea.value).toBe("");
    fireEvent.change(textarea, { target: { value: "会话B草稿" } });
    fireEvent.click(screen.getByTestId("switch-session"));
    expect(textarea.value).toBe("会话A草稿继续输入");
  });
});

describe("Composer Pills, Note-While-Running, Drag/Paste, Balance & Dark Danger Tokens", () => {
  it("keeps Note send enabled while running=true, exposes direct DeepSeek pills, and handles drag/paste files", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const onToggleThink = vi.fn();
    const onToggleSearch = vi.fn();
    const onDropFiles = vi.fn();

    const { rerender } = render(
      <Composer
        t={t}
        value="一条新笔记"
        onChange={() => {}}
        mode="note"
        onMode={() => {}}
        tags={[]}
        images={[]}
        onRemoveTag={() => {}}
        onRemoveImage={() => {}}
        onDropFiles={onDropFiles}
        quick={[]}
        onQuick={() => {}}
        noModel={false}
        onSettings={() => {}}
        thinking={{ supported: true, enabled: false, levelLabel: "", onToggle: onToggleThink }}
        running
        onStop={onStop}
        onSend={onSend}
        sending={false}
        plus={{ attach: null, online: false, webSearch: true, allowWebSearch: false, subtitle: false, allowOnline: false, subtitleAheadMin: 0, materials: 0 }}
        onAttach={() => {}}
        onToggleOnline={() => {}}
        onToggleWebSearch={onToggleSearch}
        onSubtitleAhead={() => {}}
        onMaterials={() => {}}
        mic={null}
      />,
    );

    // Note mode while running keeps BOTH Note Send enabled AND Stop reachable.
    expect(screen.getByTestId("agent-send")).toBeTruthy();
    expect(screen.getByTestId("agent-stop")).toBeTruthy();
    fireEvent.click(screen.getByTestId("agent-send"));
    expect(onSend).toHaveBeenCalledTimes(1);

    // Ask mode while running shows stop and direct DeepSeek quick pills.
    rerender(
      <Composer
        t={t}
        value="提问"
        onChange={() => {}}
        mode="ask"
        onMode={() => {}}
        tags={[]}
        images={[]}
        onRemoveTag={() => {}}
        onRemoveImage={() => {}}
        onDropFiles={onDropFiles}
        quick={[]}
        onQuick={() => {}}
        noModel={false}
        onSettings={() => {}}
        thinking={{ supported: true, enabled: false, levelLabel: "", onToggle: onToggleThink }}
        running
        onStop={onStop}
        onSend={onSend}
        sending={false}
        plus={{ attach: null, online: false, webSearch: true, allowWebSearch: true, subtitle: false, allowOnline: false, subtitleAheadMin: 0, materials: 0 }}
        onAttach={() => {}}
        onToggleOnline={() => {}}
        onToggleWebSearch={onToggleSearch}
        onSubtitleAhead={() => {}}
        onMaterials={() => {}}
        mic={null}
      />,
    );
    expect(screen.queryByTestId("agent-send")).toBeNull();
    expect(screen.getByTestId("agent-stop")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-pill-think"));
    expect(onToggleThink).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("chat-pill-search"));
    expect(onToggleSearch).toHaveBeenCalledTimes(1);

    // Drag-and-drop & paste attach files cleanly.
    const file = new File(["hello"], "sample.txt", { type: "text/plain" });
    const box = screen.getByTestId("agent-composer").closest(".chat-box")!;
    fireEvent.dragEnter(box, { dataTransfer: { types: ["Files"] } });
    expect(screen.getByTestId("chat-drop-mask")).toBeTruthy();
    fireEvent.drop(box, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(onDropFiles).toHaveBeenCalledWith([file]);
  });

  it("checks account availability in hasAvailableTextModel (#92) and renders account balance in ModelsPage", async () => {
    expect(hasAvailableTextModel([{ purpose: "text", account: { available: false } }])).toBe(false);
    expect(hasAvailableTextModel([{ purpose: "text", account: { available: true } }])).toBe(true);

    const command = vi.fn(async ({ commandId }: { commandId: string }) => {
      if (commandId === "providers.balance") {
        return {
          status: "ok",
          value: {
            accountId: "acc-ds",
            providerRef: "manga-provider-deepseek/deepseek",
            available: true,
            checkedAt: "2026-11-27T10:00:00Z",
            balances: [{ currency: "CNY", totalBalance: "42.50" }],
          },
        };
      }
      return { status: "error", error: { code: "UNKNOWN", message: "skip" } };
    });
    (window as unknown as { manga?: unknown }).manga = { command };

    await act(async () => {
      render(
        <ModelsPage
          i18n={i18n}
          settings={{
            aiRuntime: "native",
            connections: [
              {
                id: "c1",
                label: "DeepSeek · DeepSeek Chat",
                protocol: "openai-chat-completions",
                baseUrl: "https://api.deepseek.com/v1",
                modelId: "deepseek-chat",
                purpose: "text",
                account: { id: "acc-ds", label: "主账户", providerRef: "manga-provider-deepseek/deepseek", available: true },
              },
            ],
          }}
          providers={{
            providers: [{ ref: "manga-provider-deepseek/deepseek", name: "DeepSeek", models: [], services: [] }],
            accounts: [{ id: "acc-ds", label: "主账户", providerRef: "manga-provider-deepseek/deepseek", available: true }],
            offered: [],
          }}
          onRuntime={async () => {}}
          onSaveConnection={async () => ({ ok: true, id: "c1" })}
          onDeleteConnection={async () => {}}
          onTestConnection={async () => ({ ok: true, message: "ok" })}
          onProbeConnection={async () => {}}
          onSkip={() => {}}
        />,
      );
    });

    await waitFor(() => expect(screen.getByTestId("account-balance-acc-ds").textContent).toContain("CNY 42.50"));

    // Balance query error renders balanceError ("余额查询失败") rather than falsely showing "余额不足".
    cleanup();
    const errCommand = vi.fn(async ({ commandId }: { commandId: string }) => {
      if (commandId === "providers.balance") {
        return {
          status: "ok",
          value: {
            accounts: [
              {
                accountId: "acc-ds",
                providerRef: "manga-provider-deepseek/deepseek",
                available: false,
                checkedAt: "2026-11-27T10:00:00Z",
                balances: [],
                error: "provider HTTP 500",
              },
            ],
            accountId: "acc-ds",
            providerRef: "manga-provider-deepseek/deepseek",
            available: false,
            checkedAt: "2026-11-27T10:00:00Z",
            balances: [],
            error: "provider HTTP 500",
          },
        };
      }
      return { status: "error", error: { code: "UNKNOWN", message: "skip" } };
    });
    (window as unknown as { manga?: unknown }).manga = { command: errCommand };
    await act(async () => {
      render(
        <ModelsPage
          i18n={i18n}
          settings={{
            aiRuntime: "native",
            connections: [
              {
                id: "c1",
                label: "DeepSeek · DeepSeek Chat",
                protocol: "openai-chat-completions",
                baseUrl: "https://api.deepseek.com/v1",
                modelId: "deepseek-chat",
                purpose: "text",
                account: { id: "acc-ds", label: "主账户", providerRef: "manga-provider-deepseek/deepseek", available: true },
              },
            ],
          }}
          providers={{
            providers: [{ ref: "manga-provider-deepseek/deepseek", name: "DeepSeek", models: [], services: [] }],
            accounts: [{ id: "acc-ds", label: "主账户", providerRef: "manga-provider-deepseek/deepseek", available: true }],
            offered: [],
          }}
          onRuntime={async () => {}}
          onSaveConnection={async () => ({ ok: true, id: "c1" })}
          onDeleteConnection={async () => {}}
          onTestConnection={async () => ({ ok: true, message: "ok" })}
          onProbeConnection={async () => {}}
          onSkip={() => {}}
        />,
      );
    });
    await waitFor(() => expect(screen.getByTestId("account-balance-acc-ds").textContent).toBe(t("models.account.balanceError")));
    expect(screen.getByTestId("account-balance-acc-ds").textContent).not.toBe(t("models.account.balanceEmpty"));
  });

  it("uses --color-danger-text (not low-contrast --color-danger) for chat error and recording text", () => {
    const wsCss = readFileSync("apps/desktop/src/renderer/styles-workspace.css", "utf8");
    expect(wsCss).toMatch(/\.bubble-error\s*\{[^}]*color:\s*var\(--color-danger-text\)/);
    expect(wsCss).toMatch(/\.chat-error\s*\{[^}]*color:\s*var\(--color-danger-text\)/);
    expect(wsCss).toMatch(/\.toast-danger\s*\{[^}]*color:\s*var\(--color-danger-text\)/);
    expect(wsCss).toMatch(/\.chat-mic\[aria-pressed="true"\][^{]*\{[^}]*color:\s*var\(--color-danger-text\)/);
  });
});
