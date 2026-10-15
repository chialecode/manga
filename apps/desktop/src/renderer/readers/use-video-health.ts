import { useEffect, useRef, useState } from "react";
import { judgeHealth, type HealthSample, type VideoHealth } from "./video-health.ts";

const SAMPLE_MS = 500;
const KEEP = 12;

export type ElementFacts = { readyState: number; networkState: number; decodedFrames: number; droppedFrames: number; width: number; height: number };

const EMPTY: ElementFacts = { readyState: 0, networkState: 0, decodedFrames: 0, droppedFrames: 0, width: 0, height: 0 };

/**
 * Watches a video element for a missing picture. The frame count is the larger of the element's playback-quality counter and the number of frames
 * its frame callback reported, so a browser that supports only one of them still counts. `key` changes with the source, which restarts the watch.
 */
export function useVideoHealth(input: { element: HTMLVideoElement | null; key: string; active: boolean; playing: boolean }) {
  const { element, key, active } = input;
  const [health, setHealth] = useState<VideoHealth>({ state: "ok" });
  const [facts, setFacts] = useState<ElementFacts>(EMPTY);
  const playingRef = useRef(input.playing);
  playingRef.current = input.playing;

  useEffect(() => {
    setHealth({ state: "ok" });
    setFacts(EMPTY);
    if (!element || !active || !key) return;
    // An element that offers neither counter cannot be judged (a test environment): it is taken to be fine.
    if (typeof element.getVideoPlaybackQuality !== "function" && typeof element.requestVideoFrameCallback !== "function") return;
    const startedAt = Date.now();
    const samples: HealthSample[] = [];
    let callbackFrames = 0;
    let handle = 0;
    let stopped = false;
    const onFrame = () => {
      if (stopped) return;
      callbackFrames += 1;
      handle = element.requestVideoFrameCallback(onFrame);
    };
    if (typeof element.requestVideoFrameCallback === "function") handle = element.requestVideoFrameCallback(onFrame);

    const read = (): ElementFacts => {
      const quality = typeof element.getVideoPlaybackQuality === "function" ? element.getVideoPlaybackQuality() : null;
      return {
        readyState: element.readyState,
        networkState: element.networkState,
        decodedFrames: Math.max(quality?.totalVideoFrames ?? 0, callbackFrames),
        droppedFrames: quality?.droppedVideoFrames ?? 0,
        width: element.videoWidth,
        height: element.videoHeight,
      };
    };
    let lastFacts = EMPTY;
    let lastState: VideoHealth["state"] = "ok";
    const tick = () => {
      const now = Date.now();
      const next = read();
      samples.push({ at: now, mediaMs: element.currentTime * 1000, frames: next.decodedFrames, playing: playingRef.current && !element.paused && !element.seeking });
      if (samples.length > KEEP) samples.shift();
      const verdict = judgeHealth({ sourceAgeMs: now - startedAt, samples });
      if (verdict.state !== lastState) { lastState = verdict.state; setHealth(verdict); }
      const changed = next.readyState !== lastFacts.readyState || next.networkState !== lastFacts.networkState || next.width !== lastFacts.width
        || next.height !== lastFacts.height || Math.floor(next.decodedFrames / 12) !== Math.floor(lastFacts.decodedFrames / 12) || next.droppedFrames !== lastFacts.droppedFrames
        || (next.decodedFrames === 0) !== (lastFacts.decodedFrames === 0);
      if (changed) { lastFacts = next; setFacts(next); }
    };
    const timer = window.setInterval(tick, SAMPLE_MS);
    tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      if (typeof element.cancelVideoFrameCallback === "function") element.cancelVideoFrameCallback(handle);
    };
  }, [element, key, active]);

  return { health, facts };
}
