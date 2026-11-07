import { useEffect } from "react";
import { captureBus } from "../voice/capture-bus.ts";

const SAMPLE_EVERY_MS = 1000;

/**
 * Tells the recorder what the video is doing: it opened here, it plays, it paused, it was moved, its rate changed, and
 * where it is once a second while it plays. The time is the player's own, which is the time on the original file.
 */
export function useVideoCapture(element: HTMLVideoElement | null, target: { resourceId: string; revisionId: string }, enabled: boolean, originMs = 0): void {
  const { resourceId, revisionId } = target;
  useEffect(() => {
    if (!element || !enabled) return;
    const send = (reason: "resource_change" | "resume" | "pause" | "seek" | "rate_change" | "sample") => {
      captureBus.emit({
        reason,
        resourceId,
        resourceRevisionId: revisionId,
        locator: { kind: "temporal", startMs: Math.max(0, Math.round(element.currentTime * 1000 - originMs)) },
        playing: !element.paused,
        playbackRate: element.playbackRate,
      });
    };
    send("resource_change");
    const onPlay = () => send("resume");
    const onPause = () => send("pause");
    const onSeeked = () => send("seek");
    const onRate = () => send("rate_change");
    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("seeked", onSeeked);
    element.addEventListener("ratechange", onRate);
    const timer = window.setInterval(() => { if (!element.paused) send("sample"); }, SAMPLE_EVERY_MS);
    return () => {
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("seeked", onSeeked);
      element.removeEventListener("ratechange", onRate);
      window.clearInterval(timer);
      captureBus.clear(resourceId);
    };
  }, [element, enabled, resourceId, revisionId, originMs]);
}
