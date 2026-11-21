import { useCallback, useRef, type RefObject } from "react";
import type { DanmakuSettings } from "@manga/contracts/danmaku";
import type { ScreenshotPort } from "../hooks/use-screenshots.tsx";
import type { DanmakuCapture } from "./danmaku-layer.tsx";
import { captureVideoFrame } from "./screenshot-capture.ts";
import type { SubtitleCue, SubtitleStyle } from "./subtitle-model.ts";
import { pageInk, shownLines } from "./subtitle-raster.ts";
import type { FrameState } from "./use-video-playback.ts";
import { displayFrame, subtitleRenderer, type SubtitleTrack } from "./video-model.ts";
import type { AudioTrackInfo } from "./video-player.tsx";

export type VideoScreenshotInput = {
  screenshots?: ScreenshotPort;
  element: HTMLVideoElement | null;
  resourceId: string;
  revisionId: string;
  originMs: number;
  audio: AudioTrackInfo[];
  audioIndex: number | undefined;
  defaultAudioIndex: number | undefined;
  frame: FrameState;
  shotSubtitles: boolean;
  subtitleStyle: SubtitleStyle;
  subtitles: {
    tracks: SubtitleTrack[];
    selectedId: string | null;
    secondaryId: string | null;
    cues: SubtitleCue[];
    secondaryCues: SubtitleCue[];
    assPicture: (size: { w: number; h: number }) => Promise<HTMLCanvasElement | null>;
  };
  danmakuOn: boolean;
  danmakuSettings: Pick<DanmakuSettings, "enabled" | "shotWith" | "opacity">;
  danmakuCanvas: RefObject<(() => DanmakuCapture | null) | null>;
};

/**
 * Captures the video element's current frame at its native resolution, optionally compositing
 * text/ASS subtitles and visible danmaku comments, then persists the shot through `ScreenshotPort`.
 */
export function useVideoScreenshot(input: VideoScreenshotInput) {
  const shooting = useRef(false);
  const inputRef = useRef(input);
  inputRef.current = input;

  return useCallback(async () => {
    const current = inputRef.current;
    const port = current.screenshots;
    const element = current.element;
    if (!port || !element || shooting.current) return;
    shooting.current = true;
    try {
      const positionMs = Math.max(0, Math.round(element.currentTime * 1000 - current.originMs));
      // Comments are in the picture only when the person asked for that and they are on screen.
      const comments = current.danmakuOn && current.danmakuSettings.enabled && current.danmakuSettings.shotWith
        ? current.danmakuCanvas.current?.() ?? null
        : null;
      const track = current.subtitles.tracks.find((entry) => entry.id === current.subtitles.selectedId);
      const second = current.subtitles.secondaryId
        ? current.subtitles.tracks.find((entry) => entry.id === current.subtitles.secondaryId)
        : undefined;
      // What is on screen at that moment, as lines: it goes into the record whether or not it is drawn into the picture.
      const mainText = shownLines(current.subtitles.cues, positionMs).join("\n");
      const secondText = shownLines(current.subtitles.secondaryCues, positionMs).join("\n");
      const size = { w: element.videoWidth, h: element.videoHeight };
      const withSubtitles = current.shotSubtitles !== false && (track !== undefined || second !== undefined);
      const shot = await captureVideoFrame(element, {
        // Asked for after the frame is taken: an ASS renderer needs a moment to draw at the size of the file.
        subtitles: withSubtitles ? async () => ({
          text: { main: current.subtitles.cues, second: current.subtitles.secondaryCues, timeMs: positionMs, style: current.subtitleStyle, ink: pageInk() },
          ass: track && subtitleRenderer(track) === "ass" ? await current.subtitles.assPicture(size) : null,
        }) : null,
        danmaku: comments ? { ...comments, opacity: current.danmakuSettings.opacity } : null,
      });
      if ("failure" in shot) { port.fail(shot.failure); return; }
      const audio = current.audio.find((entry) => entry.index === (current.audioIndex ?? current.defaultAudioIndex));
      const frame = current.frame.status === "ready" && Number.isFinite(current.frame.frame) ? displayFrame(current.frame.frame) : null;
      await port.save({
        resourceId: current.resourceId,
        resourceRevisionId: current.revisionId,
        data: shot.data,
        video: {
          positionMs,
          playbackRate: element.playbackRate,
          ...(frame !== null ? { frame } : {}),
          ...(audio ? { audioTrack: [audio.language, audio.title].filter(Boolean).join(" ") || `#${audio.index}` } : {}),
          ...(track ? { subtitleTrack: [track.language, track.title].filter(Boolean).join(" ") || track.id, subtitleTrackId: track.id } : {}),
          ...(mainText ? { subtitleText: mainText } : {}),
          ...(second ? { subtitleSecondaryTrack: [second.language, second.title].filter(Boolean).join(" ") || second.id } : {}),
          ...(secondText ? { subtitleSecondaryText: secondText } : {}),
          composited: shot.subtitlesDrawn && shot.danmakuDrawn ? "both" : shot.subtitlesDrawn ? "subtitles" : shot.danmakuDrawn ? "danmaku" : "none",
        },
      });
    } finally {
      shooting.current = false;
    }
  }, []);
}
