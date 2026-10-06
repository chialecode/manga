import { useCallback, useEffect, useRef, useState } from "react";
import { attempt, messageOf } from "../lib/api.ts";
import { parseVtt, pickSubtitleTrack, subtitleRenderer, type SubtitleTrack } from "./video-model.ts";

export type SubtitleStatus = "none" | "loading" | "ready" | "failed";

type Target = { resourceId: string; revisionId: string };
type SubtitleHandle = { trackId: string; format: "ass" | "vtt"; url: string; language: string | null; title: string | null };
type Renderer = { destroy: () => Promise<void> | void };

/** Text tracks cannot be removed from a video element, so each element keeps one and its cues are swapped. */
const nativeTracks = new WeakMap<HTMLVideoElement, TextTrack>();

function clearNative(video: HTMLVideoElement): void {
  const track = nativeTracks.get(video);
  if (!track) return;
  track.mode = "disabled";
  const cues = track.cues ? Array.from(track.cues) : [];
  for (const cue of cues) track.removeCue(cue);
}

async function showNative(video: HTMLVideoElement, text: string, label: string, language: string | null, originMs: number): Promise<void> {
  const Cue = (globalThis as { VTTCue?: new (start: number, end: number, text: string) => TextTrackCue }).VTTCue;
  if (!Cue || typeof video.addTextTrack !== "function") throw new Error("text tracks are not available");
  let track = nativeTracks.get(video);
  if (!track) {
    track = video.addTextTrack("subtitles", label, language ?? "");
    nativeTracks.set(video, track);
  }
  clearNative(video);
  for (const cue of parseVtt(text)) track.addCue(new Cue((cue.startMs + originMs) / 1000, (cue.endMs + originMs) / 1000, cue.text));
  track.mode = "showing";
}

/**
 * The subtitle tracks of a video and the one being drawn. ASS goes through JASSUB (loaded only when such a track is
 * chosen) with the fonts the file carries; text formats become a native text track. Picture subtitles are listed
 * as unsupported by the model and never offered. A failure here never stops the video.
 */
export function useSubtitles(input: { target: Target | null; video: HTMLVideoElement | null; ready: boolean; sourceKey: string; preferredId?: string | null; originMs?: number }) {
  const { target, video, ready, sourceKey, preferredId } = input;
  const originMs = input.originMs ?? 0;
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<SubtitleStatus>("none");
  const [message, setMessage] = useState("");
  const preferred = useRef(preferredId);
  preferred.current = preferredId;
  const targetKey = target ? `${target.resourceId}:${target.revisionId}` : "";

  // ---- which tracks the file has ----
  useEffect(() => {
    setTracks([]);
    setSelectedId(null);
    setStatus("none");
    setMessage("");
    if (!target) return;
    let stale = false;
    void attempt<{ subtitles: SubtitleTrack[] }>("video.subtitles", { resourceId: target.resourceId, revisionId: target.revisionId }).then((result) => {
      if (stale || !result.ok) return;
      const list = result.value.subtitles ?? [];
      setTracks(list);
      setSelectedId(pickSubtitleTrack(list, preferred.current)?.id ?? null);
    });
    return () => { stale = true; };
  }, [targetKey]);

  // ---- drawing the chosen one ----
  useEffect(() => {
    if (!target || !video || !ready || !selectedId) {
      if (video) clearNative(video);
      setStatus("none");
      return;
    }
    const track = tracks.find((item) => item.id === selectedId);
    const renderer = track ? subtitleRenderer(track) : null;
    if (!track || !renderer) { setStatus("none"); return; }
    let stale = false;
    let drawn: Renderer | null = null;
    setStatus("loading");
    setMessage("");
    void (async () => {
      try {
        const handle = await attempt<SubtitleHandle>("video.subtitleHandle", { resourceId: target.resourceId, revisionId: target.revisionId, trackId: track.id });
        if (stale) return;
        if (!handle.ok) throw handle.error;
        const text = await (await fetch(handle.value.url)).text();
        if (stale) return;
        if (handle.value.format === "ass") {
          clearNative(video);
          const fonts = await attempt<{ fonts: Array<{ url: string }> }>("video.fonts", { resourceId: target.resourceId, revisionId: target.revisionId });
          if (stale) return;
          const [{ default: JASSUB }, worker, wasm, modernWasm] = await Promise.all([
            import("jassub"),
            import("jassub/dist/worker/worker.js?worker&url"),
            import("jassub/dist/wasm/jassub-worker.wasm?url"),
            import("jassub/dist/wasm/jassub-worker-modern.wasm?url"),
          ]);
          if (stale) return;
          const instance = new JASSUB({
            video,
            subContent: text,
            workerUrl: worker.default,
            wasmUrl: wasm.default,
            modernWasmUrl: modernWasm.default,
            fonts: fonts.ok ? fonts.value.fonts.map((font) => font.url) : [],
            queryFonts: "local",
            // The subtitle times count from the start of the file; the element clock may start later.
            timeOffset: -originMs / 1000,
          });
          drawn = instance;
          await instance.ready;
        } else {
          await showNative(video, text, track.title ?? track.language ?? track.id, track.language, originMs);
        }
        if (!stale) setStatus("ready");
      } catch (error) {
        if (stale) return;
        setStatus("failed");
        setMessage(messageOf(error));
      }
    })();
    return () => {
      stale = true;
      if (drawn) void Promise.resolve(drawn.destroy()).catch(() => undefined);
      else clearNative(video);
    };
  }, [target?.resourceId, target?.revisionId, video, ready, selectedId, tracks, sourceKey, originMs]);

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  return { tracks, selectedId, status, message, select };
}
