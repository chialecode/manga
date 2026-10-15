/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { DebugPanel } from "../../apps/desktop/src/renderer/pages/debug-panel.tsx";
import type { VideoFacts } from "../../apps/desktop/src/renderer/readers/video-health.ts";

const i18n = createTranslator("zh-CN");

const facts: VideoFacts = {
  playing: "original", decision: "direct", reasons: [], readyState: 4, networkState: 1, decodedFrames: 96, droppedFrames: 0, width: 1920, height: 1080,
  health: "ok", subtitleRenderer: "jassub", subtitleStatus: "ready", defaultFont: "bundled:noto sans sc", missingFonts: ["方正黑体_gbk", "华文楷体"],
};

function panel(video: VideoFacts | null) {
  (window as unknown as { manga: unknown }).manga = { command: vi.fn(async () => ({ status: "ok", value: {} })), onNotice: () => () => undefined };
  return render(
    <DebugPanel t={i18n.t} view={{ open: true, height: 260, tab: "current" }} onView={vi.fn()} scope={{ page: "video" }} live={{ page: "video" }} video={video} events={[]} version={0} onNotice={vi.fn()} />,
  );
}

afterEach(() => cleanup());

describe("AT-84 debug panel: the facts of a video's picture", () => {
  it("shows how the file plays, the element's counters, the subtitle renderer and the fonts nobody has", async () => {
    panel(facts);
    await waitFor(() => expect(screen.getByTestId("debug-video")).toBeTruthy());
    const row = screen.getByTestId("debug-video");
    expect(row.getAttribute("data-health")).toBe("ok");
    expect(screen.getByTestId("debug-video-playing").textContent).toContain("原文件");
    expect(screen.getByTestId("debug-video-playing").textContent).toContain("direct");
    const element = screen.getByTestId("debug-video-element").textContent ?? "";
    expect(element).toContain("readyState 4");
    expect(element).toContain("已解码 96 帧");
    expect(element).toContain("1920×1080");
    const subtitles = screen.getByTestId("debug-video-subtitles").textContent ?? "";
    expect(subtitles).toContain("jassub (ready)");
    expect(subtitles).toContain("bundled:noto sans sc");
    expect(subtitles).toContain("方正黑体_gbk、华文楷体");
  });

  it("says when the picture is missing, and shows the plan's reasons for a play copy", async () => {
    panel({ ...facts, playing: "play_copy", decision: "play_copy", reasons: ["no_hardware_hevc"], decodedFrames: 0, health: "no-frames", missingFonts: [] });
    await waitFor(() => expect(screen.getByTestId("debug-video")).toBeTruthy());
    expect(screen.getByTestId("debug-video").getAttribute("data-health")).toBe("no-frames");
    expect(screen.getByTestId("debug-video-element").textContent).toContain("时间在走但没有帧");
    expect(screen.getByTestId("debug-video-playing").textContent).toContain("no_hardware_hevc");
    expect(screen.getByTestId("debug-video-subtitles").textContent).toContain("无");
  });

  it("has no video row outside a video", async () => {
    panel(null);
    await waitFor(() => expect(screen.getByTestId("debug-panel")).toBeTruthy());
    expect(screen.queryByTestId("debug-video")).toBeNull();
  });
});
