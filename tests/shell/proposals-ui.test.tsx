/** @vitest-environment jsdom */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import type { ProposalCard } from "@manga/contracts";
import { Composer, type ComposerProps } from "../../apps/desktop/src/renderer/components/chat/composer.tsx";
import { MessageList, type BubbleActions } from "../../apps/desktop/src/renderer/components/chat/messages.tsx";
import type { StreamItem } from "../../apps/desktop/src/renderer/hooks/use-session-stream.ts";
import { emptyComposer, type ComposerState } from "../../apps/desktop/src/renderer/lib/types.ts";

const i18n = createTranslator("zh-CN");
const t = i18n.t;

const noopActions: BubbleActions = {
  onJumpNote: () => undefined,
  onJumpVoice: () => undefined,
  onEditNote: async () => true,
  onDeleteNote: async () => undefined,
  onQuoteNote: () => undefined,
  onOpenRecording: () => undefined,
  onRetry: () => undefined,
};

afterEach(() => {
  cleanup();
});

function makeProposal(overrides: Partial<ProposalCard> & { id: string }): ProposalCard {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? "ses_1",
    runId: overrides.runId ?? "run_1",
    projectId: overrides.projectId ?? "prj_1",
    kind: overrides.kind ?? "delete",
    target: overrides.target ?? { kind: "whiteboard", targetId: "wb_1", title: "旧分镜", revision: "wb:1" },
    commandId: overrides.commandId ?? "whiteboard.delete",
    preview: overrides.preview ?? {
      title: "删除白板《旧分镜》",
      summary: "3 张卡片 · 1 条连线",
      lines: ["反向引用（2 处）：笔记《第一章》、导图《结构》"],
      warnings: ["删除后这些引用会显示为已删除", "删除后不能撤销"],
      irreversible: true,
      meta: { nodes: 3, edges: 1, backlinks: 2 },
    },
    reason: overrides.reason ?? "已有新版分镜",
    status: overrides.status ?? "pending",
    result: overrides.result ?? null,
    createdAt: overrides.createdAt ?? "2026-10-03T14:00:00.000Z",
    decidedAt: overrides.decidedAt ?? null,
  };
}

describe("proposal cards & batch actions in MessageList (W4, AT-151, AT-154)", () => {
  it("renders a delete proposal with irreversible warning and danger button, and calls proposal.apply / proposal.reject", async () => {
    const calls: Array<{ commandId: string; input: Record<string, unknown> }> = [];
    (window as unknown as { manga: unknown }).manga = {
      async command(payload: { commandId: string; input?: Record<string, unknown> }) {
        calls.push({ commandId: payload.commandId, input: payload.input ?? {} });
        return { status: "ok", value: {} };
      },
      onNotice: () => () => undefined,
    };

    const pDel = makeProposal({ id: "prop_del_1" });
    const items: StreamItem[] = [
      { id: "msg_1", kind: "user", runId: "run_1", text: "删掉旧分镜", createdAt: "2026-10-03T14:00:00.000Z" },
      { id: "msg_2", kind: "agent", runId: "run_1", status: "succeeded", text: "我提出了删除白板的提议，请在下面确认。", tools: [], proposals: [pDel], createdAt: "2026-10-03T14:00:01.000Z" },
    ];

    render(
      <MessageList
        t={t}
        items={items}
        hasMore={false}
        onOlder={() => undefined}
        actions={noopActions}
        empty={null}
        formatDate={(v) => v}
      />,
    );

    const card = screen.getByTestId("proposal-card-prop_del_1");
    expect(card.textContent).toContain("删除白板《旧分镜》");
    expect(card.textContent).toContain("3 张卡片 · 1 条连线");
    expect(card.textContent).toContain("反向引用（2 处）");
    expect(screen.getByTestId("proposal-irreversible-prop_del_1").textContent).toBe("不能撤销");

    const applyBtn = screen.getByTestId("proposal-apply-prop_del_1");
    expect(applyBtn.className).toContain("danger-button");
    fireEvent.click(applyBtn);
    await waitFor(() => {
      expect(calls).toContainEqual({ commandId: "proposal.apply", input: { proposalId: "prop_del_1" } });
    });

    const rejectBtn = screen.getByTestId("proposal-reject-prop_del_1");
    fireEvent.click(rejectBtn);
    await waitFor(() => {
      expect(calls).toContainEqual({ commandId: "proposal.reject", input: { proposalId: "prop_del_1" } });
    });
  });

  it("opens directory picker for exportProject proposal and leaves proposal pending when cancelled", async () => {
    const calls: Array<{ commandId: string; input: Record<string, unknown> }> = [];
    let pickResult: { pathHandle: string; path: string } | null = null;
    (window as unknown as { manga: unknown }).manga = {
      async pick() {
        return pickResult;
      },
      async command(payload: { commandId: string; input?: Record<string, unknown> }) {
        calls.push({ commandId: payload.commandId, input: payload.input ?? {} });
        return { status: "ok", value: {} };
      },
      onNotice: () => () => undefined,
    };

    const pPkg = makeProposal({
      id: "prop_pkg_1",
      kind: "exportProject",
      commandId: "project.exportPackage",
      target: { kind: "project", targetId: "prj_1", title: "测试项目", revision: "proj:1" },
      preview: {
        title: "导出项目包《测试项目》",
        summary: "材料 2 项 · 白板 1 · 约 4.2 KiB",
        lines: ["建议文件名：测试项目.manga-project.zip", "确认时选择保存位置"],
        warnings: [],
        irreversible: false,
        meta: {},
      },
    });

    render(
      <MessageList
        t={t}
        items={[{ id: "msg_1", kind: "agent", runId: "run_1", status: "succeeded", text: "导出项目包", tools: [], proposals: [pPkg], createdAt: "2026-10-03T14:00:01.000Z" }]}
        hasMore={false}
        onOlder={() => undefined}
        actions={noopActions}
        empty={null}
        formatDate={(v) => v}
      />,
    );

    // Cancel directory picker -> no proposal.apply call.
    fireEvent.click(screen.getByTestId("proposal-apply-prop_pkg_1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);

    // Choose directory -> calls proposal.apply with pathHandle.
    pickResult = { pathHandle: "ph_export_dir" };
    fireEvent.click(screen.getByTestId("proposal-apply-prop_pkg_1"));
    await waitFor(() => {
      expect(calls).toEqual([{ commandId: "proposal.apply", input: { proposalId: "prop_pkg_1", pathHandle: "ph_export_dir" } }]);
    });
  });

  it("shows batch confirm/reject bar when >= 2 proposals are pending, opens batch modal on confirm, and displays decided statuses", async () => {
    const calls: Array<{ commandId: string; input: Record<string, unknown> }> = [];
    (window as unknown as { manga: unknown }).manga = {
      async command(payload: { commandId: string; input?: Record<string, unknown> }) {
        calls.push({ commandId: payload.commandId, input: payload.input ?? {} });
        return { status: "ok", value: {} };
      },
      onNotice: () => () => undefined,
    };

    const p1 = makeProposal({ id: "prop_1", preview: { title: "删除白板《甲》", summary: "1 张卡片", lines: [], warnings: ["删除后不能撤销"], irreversible: true, meta: {} } });
    const p2 = makeProposal({ id: "prop_2", kind: "rename", preview: { title: "重命名导图：《旧》→《新》", summary: "原名称《旧》 → 新名称《新》", lines: [], warnings: [], irreversible: false, meta: {} } });
    const pStale = makeProposal({ id: "prop_3", status: "stale", result: { reason: "文稿在提议后被修改过，请让 Agent 重新提出" } });

    render(
      <MessageList
        t={t}
        items={[{ id: "msg_1", kind: "agent", runId: "run_batch", status: "succeeded", text: "请确认以下两项修改", tools: [], proposals: [p1, p2, pStale], createdAt: "2026-10-03T14:00:01.000Z" }]}
        hasMore={false}
        onOlder={() => undefined}
        actions={noopActions}
        empty={null}
        formatDate={(v) => v}
      />,
    );

    expect(screen.getByTestId("proposal-batch-run_batch")).toBeTruthy();
    expect(screen.getByTestId("proposal-status-prop_3").textContent).toContain("已失效：文稿在提议后被修改过");

    fireEvent.click(screen.getByTestId("proposal-batch-apply-run_batch"));
    expect(screen.getByTestId("proposal-batch-modal")).toBeTruthy();
    fireEvent.click(screen.getByTestId("proposal-batch-confirm"));
    await waitFor(() => {
      expect(calls).toEqual([
        { commandId: "proposal.apply", input: { proposalId: "prop_1" } },
        { commandId: "proposal.apply", input: { proposalId: "prop_2" } },
      ]);
    });
  });

  it("confirms only the proposals shown when the dialog opened and continues after a failed item while showing its error", async () => {
    const calls: string[] = [];
    const changed = vi.fn();
    (window as unknown as { manga: unknown }).manga = {
      async command(payload: { input: { proposalId: string } }) {
        calls.push(payload.input.proposalId);
        return payload.input.proposalId === "batch_first"
          ? { status: "error", error: { code: "PROPOSAL_STALE", message: "白板已经被修改" } }
          : { status: "ok", value: {} };
      },
      onNotice: () => () => undefined,
    };
    const first = makeProposal({ id: "batch_first" });
    const second = makeProposal({ id: "batch_second", kind: "rename" });
    const later = makeProposal({ id: "batch_later" });
    const view = (proposals: ProposalCard[]) => <MessageList t={t} items={[{
      id: "batch_message", kind: "agent", runId: "batch_run", status: "succeeded", text: "请确认", tools: [], proposals, createdAt: "2026-10-03T14:00:01.000Z",
    }]} hasMore={false} onOlder={() => undefined} actions={{ ...noopActions, onProposalChanged: changed }} empty={null} formatDate={(value) => value} />;
    const rendered = render(view([first, second]));
    fireEvent.click(screen.getByTestId("proposal-batch-apply-batch_run"));
    rendered.rerender(view([first, second, later]));
    expect(screen.getByTestId("proposal-batch-list").children).toHaveLength(2);
    fireEvent.click(screen.getByTestId("proposal-batch-confirm"));
    await waitFor(() => expect(calls).toEqual(["batch_first", "batch_second"]));
    expect(screen.getByTestId("proposal-batch-errors-batch_run").textContent).toContain("白板已经被修改");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("shows confirmation failures in the card and catches a failing save dialog without losing the pending action", async () => {
    (window as unknown as { manga: unknown }).manga = {
      async pick() { throw new Error("保存位置暂时不可用"); },
      async command() { return { status: "error", error: { code: "FORBIDDEN", message: "无法执行此提议" } }; },
      onNotice: () => () => undefined,
    };
    const items: StreamItem[] = [{
      id: "error_message", kind: "agent", runId: "error_run", status: "succeeded", text: "请确认", tools: [],
      proposals: [makeProposal({ id: "error_delete" }), makeProposal({ id: "error_export", kind: "exportProject" })], createdAt: "2026-10-03T14:00:01.000Z",
    }];
    render(<MessageList t={t} items={items} hasMore={false} onOlder={() => undefined} actions={noopActions} empty={null} formatDate={(value) => value} />);
    fireEvent.click(screen.getByTestId("proposal-apply-error_delete"));
    await waitFor(() => expect(screen.getByTestId("proposal-error-error_delete").textContent).toContain("无法执行此提议"));
    fireEvent.click(screen.getByTestId("proposal-apply-error_export"));
    await waitFor(() => expect(screen.getByTestId("proposal-error-error_export").textContent).toContain("保存位置暂时不可用"));
    expect(screen.getByTestId("proposal-card-error_export").getAttribute("data-status")).toBe("pending");
    expect((screen.getByTestId("proposal-apply-error_export") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows export progress and a cancel action, and translates compatibility problems into Chinese", async () => {
    const calls: Array<{ commandId: string; input: unknown }> = [];
    (window as unknown as { manga: unknown }).manga = {
      async command(payload: { commandId: string; input: unknown }) { calls.push(payload); return { status: "ok", value: {} }; },
      onNotice: () => () => undefined,
    };
    const proposal = makeProposal({ id: "running_export", kind: "exportRoughcut", status: "applying", result: {
      output: { export: { id: "rce_test", step: "cutting", done: 1, total: 2 } },
    }, preview: {
      title: "导出粗剪《预告》", summary: "2 个片段", lines: [], warnings: [], irreversible: false,
      meta: { problems: [{ code: "resolution", clipId: "second", detail: { first: "1280×720", other: "1920×1080" } }], clipTitles: { second: "片段乙" } },
    } });
    render(<MessageList t={t} items={[{
      id: "export_message", kind: "agent", runId: "export_run", status: "succeeded", text: "正在导出", tools: [], proposals: [proposal], createdAt: "2026-10-03T14:00:01.000Z",
    }]} hasMore={false} onOlder={() => undefined} actions={noopActions} empty={null} formatDate={(value) => value} />);
    expect(screen.getByTestId("proposal-status-running_export").textContent).toContain("片段");
    expect(screen.getByTestId("proposal-warnings-running_export").textContent).toContain("片段乙");
    expect(screen.getByTestId("proposal-warnings-running_export").textContent).toContain("画面尺寸");
    fireEvent.click(screen.getByTestId("proposal-cancel-running_export"));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ commandId: "roughcut.cancel", input: { exportId: "rce_test" } })));
  });
});

describe("Composer per-task opt-in menu & tags (W5, AT-155)", () => {
  function OptInHarness(props: { online: boolean; semantic: boolean; webpage: boolean }) {
    const [composer, setComposer] = useState<ComposerState>(emptyComposer());
    const composerProps: ComposerProps = {
      t,
      value: composer.draft,
      onChange: (draft) => setComposer((c) => ({ ...c, draft })),
      mode: "ask",
      onMode: () => undefined,
      tags: [],
      images: [],
      onRemoveTag: () => undefined,
      onRemoveImage: () => undefined,
      quick: [],
      onQuick: () => undefined,
      noModel: false,
      onSettings: () => undefined,
      running: false,
      onStop: () => undefined,
      onSend: () => undefined,
      sending: false,
      plus: {
        attach: null,
        online: props.online,
        semantic: props.semantic,
        webpage: props.webpage,
        subtitle: false,
        allowOnline: composer.allowOnline,
        allowSemantic: composer.allowSemantic,
        allowWebpage: composer.allowWebpage,
        subtitleAheadMin: null,
        materials: 0,
      },
      onAttach: () => undefined,
      onToggleOnline: () => setComposer((c) => ({ ...c, allowOnline: !c.allowOnline })),
      onToggleSemantic: () => setComposer((c) => ({ ...c, allowSemantic: !c.allowSemantic })),
      onToggleWebpage: () => setComposer((c) => ({ ...c, allowWebpage: !c.allowWebpage })),
      onSubtitleAhead: () => undefined,
      onMaterials: () => undefined,
      mic: null,
    };
    return <Composer {...composerProps} />;
  }

  it("shows semantic and webpage checkboxes only when enabled, and renders removable opt-in tags below the input", () => {
    const { rerender } = render(<OptInHarness online={true} semantic={false} webpage={false} />);
    fireEvent.click(screen.getByTestId("chat-plus"));
    expect(screen.getByTestId("chat-plus-online")).toBeTruthy();
    expect(screen.queryByTestId("chat-plus-semantic")).toBeNull();
    expect(screen.queryByTestId("chat-plus-webpage")).toBeNull();

    rerender(<OptInHarness online={true} semantic={true} webpage={true} />);
    expect(screen.getByTestId("chat-plus-semantic").textContent).toContain("Embedding");
    expect(screen.getByTestId("chat-plus-webpage").textContent).toContain("会联网");

    fireEvent.click(screen.getByTestId("chat-plus-semantic"));
    fireEvent.click(screen.getByTestId("chat-plus"));
    fireEvent.click(screen.getByTestId("chat-plus-webpage"));

    expect(screen.getByTestId("chat-opt-in-semantic")).toBeTruthy();
    expect(screen.getByTestId("chat-opt-in-webpage")).toBeTruthy();
  });
});
