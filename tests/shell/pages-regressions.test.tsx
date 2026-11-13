/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { hiddenSettingsPages } from "../../apps/desktop/src/renderer/pages/settings/settings-view.tsx";
import { AgentPage } from "../../apps/desktop/src/renderer/pages/settings/agent-page.tsx";
import { RecordsPage } from "../../apps/desktop/src/renderer/pages/settings/records-page.tsx";
import { UsagePage } from "../../apps/desktop/src/renderer/pages/settings/usage-page.tsx";
import { Recording } from "../../apps/desktop/src/renderer/pages/settings-media.tsx";
import { ProjectPage } from "../../apps/desktop/src/renderer/pages/projects/project-page.tsx";
import { UnassignedGroup } from "../../apps/desktop/src/renderer/pages/unassigned-group.tsx";
import { MatchDialog, providerName } from "../../apps/desktop/src/renderer/pages/work-match.tsx";
import { ClipRow } from "../../apps/desktop/src/renderer/pages/projects/roughcut/roughcut-clip.tsx";
import type { ProjectTabContext } from "../../apps/desktop/src/renderer/pages/projects/project-page.tsx";
import type { WorkDetail } from "../../apps/desktop/src/renderer/lib/works.ts";

const i18n = createTranslator("zh-CN");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("settings page regressions", () => {
  it("hides the agent settings page when the agent facet is disabled", () => {
    const hidden = hiddenSettingsPages(new Set(["comic", "video"]));
    expect(hidden.has("agent")).toBe(true);
    expect(hidden.has("models")).toBe(true);
    expect(hidden.has("quick")).toBe(true);
    expect(hidden.has("usage")).toBe(true);
    expect(hiddenSettingsPages(new Set(["agent"])).has("agent")).toBe(false);
  });

  it("suppresses reset notice when recording.save returns false", async () => {
    (window as unknown as { manga: unknown }).manga = { command: async () => ({ status: "ok", value: {} }) };
    const save = vi.fn(async () => false);
    const onNotice = vi.fn();
    render(
      <Recording
        t={i18n.t}
        settings={{ deviceId: null, holdKey: "F8", toggleKey: "F9", dictationHoldKey: "F7", retention: "keep", duckPlayback: "lower", boundaryMarginMs: 250, overlay: { x: null, y: null } } as never}
        save={save}
        onNotice={onNotice}
      />,
    );
    fireEvent.click(screen.getByTestId("msettings-overlay-reset"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("keeps AgentPage controls disabled until initial settings load completes", async () => {
    const deferred = Promise.withResolvers<{ status: "ok"; value: unknown }>();
    (window as unknown as { manga: unknown }).manga = {
      command: ({ commandId }: { commandId: string }) => (
        commandId === "settings.getAgent" ? deferred.promise : Promise.resolve({ status: "ok", value: { count: 0, bytes: 0 } })
      ),
    };
    render(<AgentPage t={i18n.t} onNotice={vi.fn()} onError={vi.fn()} />);
    expect((screen.getByTestId("agent-steps") as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      deferred.resolve({
        status: "ok",
        value: {
          limits: { maxSteps: 12, maxDurationMs: 180_000 },
          trace: { enabled: false, retentionDays: 7, maxMb: 50 },
          media: { retentionDays: 30, maxMb: 500 },
        },
      });
      await deferred.promise;
    });
    await waitFor(() => expect((screen.getByTestId("agent-steps") as HTMLInputElement).disabled).toBe(false));
  });

  it("syncs RecordsPage work filter when initialWorkId prop changes", async () => {
    const queries: unknown[] = [];
    (window as unknown as { manga: unknown }).manga = {
      command: async ({ commandId, input }: { commandId: string; input: unknown }) => {
        if (commandId === "records.list") {
          queries.push(input);
          return { status: "ok", value: { items: [], total: 0 } };
        }
        return { status: "ok", value: {} };
      },
    };
    const { rerender } = render(
      <RecordsPage
        t={i18n.t}
        formatDate={(v) => v}
        scope="notes"
        initialWorkId="w1"
        onOpenNote={vi.fn()}
        onOpenNoteSource={vi.fn()}
        onOpenRecording={vi.fn()}
        onNotice={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(() => expect(queries.some((q) => (q as { workId?: string }).workId === "w1")).toBe(true));
    rerender(
      <RecordsPage
        t={i18n.t}
        formatDate={(v) => v}
        scope="notes"
        initialWorkId="w2"
        onOpenNote={vi.fn()}
        onOpenNoteSource={vi.fn()}
        onOpenRecording={vi.fn()}
        onNotice={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(() => expect(queries.some((q) => (q as { workId?: string }).workId === "w2")).toBe(true));
  });

  it("localizes run status in UsagePage instead of rendering raw English tokens", async () => {
    (window as unknown as { manga: unknown }).manga = {
      command: async ({ commandId }: { commandId: string }) => {
        if (commandId === "usage.query") {
          return {
            status: "ok",
            value: {
              rows: [{
                kind: "run",
                id: "u1",
                at: "2026-01-01T00:00:00Z",
                status: "completed",
                recorded: true,
                modelId: "deepseek-chat",
                inputTokens: 100,
                outputTokens: 50,
                costUsd: 0.01,
                durationMs: 1200,
                audioMs: null,
                sessionId: null,
                errorCode: null,
              }],
              total: 1,
              byDay: [],
              byModel: [],
              models: ["deepseek-chat"],
            },
          };
        }
        return { status: "ok", value: {} };
      },
    };
    render(<UsagePage t={i18n.t} formatDate={(v) => v} formatNumber={(n) => String(n)} onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("usage-rows")).toBeTruthy());
    expect(screen.getByTestId("usage-rows").textContent).toContain(i18n.t("usage.status.completed"));
    expect(screen.getByTestId("usage-rows").textContent).not.toContain("completed");
  });
});

describe("pages and projects regressions", () => {
  it("handles malformed empty project.get responses without throwing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    (window as unknown as { manga: unknown }).manga = {
      command: async () => ({ status: "ok", value: {} }),
    };
    render(
      <ProjectPage
        t={i18n.t}
        formatDate={(v) => v}
        projectId="p1"
        tab="materials"
        facets={new Set()}
        connections={[]}
        version={0}
        focus={null}
        onFocus={vi.fn()}
        onTab={vi.fn()}
        onChanged={vi.fn()}
        onOpenMaterial={vi.fn()}
        onError={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("page-project").getAttribute("aria-busy")).toBe("true"));
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("ignores malformed items without resourceId in UnassignedGroup without React key warnings", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    (window as unknown as { manga: unknown }).manga = {
      command: async () => ({ status: "ok", value: [{ workId: "w1", title: "Malformed" }] }),
    };
    render(<UnassignedGroup t={i18n.t} kind="novel" version={0} onOpen={vi.fn()} onMatched={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId("unassigned-group")).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("localizes ref validation failure reasons and local-file provider name in MatchDialog", async () => {
    expect(providerName("local-file", i18n.t)).toBe(i18n.t("match.provider.localFile"));
    (window as unknown as { manga: unknown }).manga = {
      command: async () => ({ status: "ok", value: { candidates: [] } }),
    };
    const detail = {
      id: "w1",
      title: "Test",
      kind: "novel",
      linkedSource: null,
      suggestedQuery: "",
    } as unknown as WorkDetail;
    render(
      <MatchDialog
        t={i18n.t}
        detail={detail}
        formatDate={(v) => String(v)}
        onClose={vi.fn()}
        onApplied={vi.fn()}
        onOpenExternal={vi.fn()}
        onError={vi.fn()}
      />,
    );
    const input = screen.getByTestId("match-query");
    fireEvent.change(input, { target: { value: "https://bgm.tv/character/123" } });
    fireEvent.click(screen.getByTestId("match-search"));
    await waitFor(() => expect(screen.getByTestId("match-direct-error").textContent).toBe(i18n.t("match.ref.reason.character-page")));
  });

  it("writes the snapped clock back into the roughcut input even when snapped inMs equals clip.inMs", () => {
    const onUpdate = vi.fn();
    const ctx = { t: i18n.t } as unknown as ProjectTabContext;
    render(
      <ol>
        <ClipRow
          ctx={ctx}
          clip={{ id: "c1", resourceId: "r1", revisionId: "v1", title: "Clip", label: "", inMs: 2000, outMs: 5000, durationMs: 10000, available: true }}
          index={0}
          count={1}
          busy={false}
          selected={false}
          keyframes={[0, 2000, 4000]}
          snap
          onPreview={vi.fn()}
          onUpdate={onUpdate}
          onMove={vi.fn()}
          onRemove={vi.fn()}
        />
      </ol>,
    );
    const inInput = screen.getByTestId("rc-in-c1") as HTMLInputElement;
    // User types 2.4s, which snaps back to keyframe 2.0s (same as clip.inMs = 2000).
    fireEvent.change(inInput, { target: { value: "0:02.400" } });
    fireEvent.blur(inInput);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(inInput.value).toBe("0:02.000");
  });
});
