import { useCallback, useEffect, useRef, useState } from "react";
import { attempt, messageOf } from "../lib/api.ts";
import { pickSubtitleTrack, subtitleRenderer, type SubtitleTrack } from "./video-model.ts";
import { assFontNames, overrideAssStyles, parseSubtitleCues, SUBTITLE_FONT_NAMES, type SubtitleCue, type SubtitleStyle } from "./subtitle-model.ts";
import { installedFamilies, jassubFonts, type FallbackFont } from "./subtitle-fonts.ts";
import { snapshotAss, type AssSurface } from "./subtitle-ass-shot.ts";

export type SubtitleStatus = "none" | "loading" | "ready" | "failed";

/** What the subtitle drawing is made of, for the debug panel: the renderer, where its default font comes from, and the styles' fonts nobody has. */
export type SubtitleFacts = { renderer: "jassub" | "text" | "none"; defaultFont: string; missingFonts: string[] };
const NO_FACTS: SubtitleFacts = { renderer: "none", defaultFont: "-", missingFonts: [] };

type Target = { resourceId: string; revisionId: string };
type SubtitleHandle = { trackId: string; format: "ass" | "srt" | "vtt"; language: string | null; title: string | null; url: string };
type Renderer = { destroy: () => Promise<void> | void };
type AssRenderer = Renderer & AssSurface;

async function textOf(target: Target, trackId: string): Promise<{ text: string; format: SubtitleHandle["format"] }> {
  const handle = await attempt<SubtitleHandle>("video.subtitleHandle", { resourceId: target.resourceId, revisionId: target.revisionId, trackId });
  if (!handle.ok) throw handle.error;
  return { text: await (await fetch(handle.value.url)).text(), format: handle.value.format };
}

/**
 * The subtitle tracks of a video, the one drawn as the main subtitle and the one drawn under it as a secondary subtitle. ASS goes through JASSUB
 * (loaded only when such a track is chosen) with the fonts the file carries, as the file is written or restyled by the standard (the style's
 * `assStyle`). Text formats (SRT, WebVTT, embedded text) are read into cues that the player's own subtitle layer lays out by the standard. Picture
 * subtitles are listed as unsupported by the model and never offered. A failure here never stops the video.
 */
export function useSubtitles(input: { target: Target | null; video: HTMLVideoElement | null; ready: boolean; sourceKey: string; style: SubtitleStyle; preferredId?: string | null; originMs?: number }) {
  const { target, video, ready, sourceKey, preferredId, style } = input;
  const originMs = input.originMs ?? 0;
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [secondaryId, setSecondaryId] = useState<string | null>(null);
  const [status, setStatus] = useState<SubtitleStatus>("none");
  const [message, setMessage] = useState("");
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [secondaryCues, setSecondaryCues] = useState<SubtitleCue[]>([]);
  const [facts, setFacts] = useState<SubtitleFacts>(NO_FACTS);
  /** The ASS renderer drawing now, for a screenshot to read what it has drawn. */
  const ass = useRef<AssRenderer | null>(null);
  const preferred = useRef(preferredId);
  preferred.current = preferredId;
  const targetKey = target ? `${target.resourceId}:${target.revisionId}` : "";
  // Only the parts of the style that change an ASS drawing restart it; the text layer restyles itself.
  const assKey = style.assStyle === "standard" ? `standard:${style.sizePct}:${style.font}` : "keep";

  // ---- which tracks the file has ----
  // Shown again after the page was in the background, the list and the choice made there stay; only a cut-off request is made again.
  const listedFor = useRef("");
  useEffect(() => {
    if (listedFor.current === targetKey) return;
    listedFor.current = "";
    setTracks([]);
    setSelectedId(null);
    setSecondaryId(null);
    setStatus("none");
    setMessage("");
    setCues([]);
    setSecondaryCues([]);
    if (!target) return;
    let stale = false;
    void attempt<{ subtitles: SubtitleTrack[] }>("video.subtitles", { resourceId: target.resourceId, revisionId: target.revisionId }).then((result) => {
      if (stale || !result.ok) return;
      listedFor.current = targetKey;
      const list = result.value.subtitles ?? [];
      setTracks(list);
      setSelectedId(pickSubtitleTrack(list, preferred.current)?.id ?? null);
    });
    return () => { stale = true; };
  }, [targetKey]);

  // ---- drawing the chosen one ----
  useEffect(() => {
    setCues([]);
    setFacts(NO_FACTS);
    if (!target || !video || !ready || !selectedId) { setStatus("none"); return; }
    const track = tracks.find((item) => item.id === selectedId);
    const renderer = track ? subtitleRenderer(track) : null;
    if (!track || !renderer) { setStatus("none"); return; }
    let stale = false;
    let drawn: AssRenderer | null = null;
    setStatus("loading");
    setMessage("");
    void (async () => {
      try {
        const { text, format } = await textOf(target, track.id);
        if (stale) return;
        if (format === "ass") {
          const fonts = await attempt<{ fonts: Array<{ url: string; families?: string[] }>; fallback?: FallbackFont | null }>("video.fonts", { resourceId: target.resourceId, revisionId: target.revisionId });
          const installed = await installedFamilies();
          if (stale) return;
          // The default font has the glyphs of Chinese and Japanese, so a style whose font is nowhere is drawn with letters instead of boxes.
          const embedded = fonts.ok ? fonts.value.fonts : [];
          const options = jassubFonts({ embedded: embedded.map((font) => font.url), fallback: fonts.ok ? fonts.value.fallback ?? null : null, systemFamilies: installed });
          const carried = new Set(embedded.flatMap((font) => font.families ?? []));
          const missing = assFontNames(text).filter((name) => !carried.has(name) && !(installed?.has(name) ?? false));
          setFacts({ renderer: "jassub", defaultFont: options.defaultFont ? `${options.source}:${options.defaultFont}` : "jassub-default", missingFonts: missing });
          const [{ default: JASSUB }, worker, wasm, modernWasm] = await Promise.all([
            import("jassub"),
            import("jassub/dist/worker/worker.js?worker&url"),
            import("jassub/dist/wasm/jassub-worker.wasm?url"),
            import("jassub/dist/wasm/jassub-worker-modern.wasm?url"),
          ]);
          if (stale) return;
          const instance = new JASSUB({
            video,
            subContent: style.assStyle === "standard" ? overrideAssStyles(text, { fontName: SUBTITLE_FONT_NAMES[style.font], sizePct: style.sizePct }) : text,
            workerUrl: worker.default,
            wasmUrl: wasm.default,
            modernWasmUrl: modernWasm.default,
            fonts: options.fonts,
            ...(options.defaultFont ? { availableFonts: options.availableFonts, defaultFont: options.defaultFont } : {}),
            queryFonts: "local",
            // The subtitle times count from the start of the file; the element clock may start later.
            timeOffset: -originMs / 1000,
          });
          drawn = instance;
          await instance.ready;
          if (!stale) ass.current = instance;
          // The renderer draws when the video shows a frame. A track chosen on a paused picture, or opened before the first frame, would
          // show nothing until the next frame, so the frame that is on screen is drawn once now.
          if (!stale && video.videoWidth > 0) {
            void instance.manualRender({ mediaTime: video.currentTime, width: video.videoWidth, height: video.videoHeight, expectedDisplayTime: performance.now() }, true).catch(() => undefined);
          }
        } else {
          setCues(parseSubtitleCues(text));
          setFacts({ renderer: "text", defaultFont: "-", missingFonts: [] });
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
      if (drawn) {
        if (ass.current === drawn) ass.current = null;
        void Promise.resolve(drawn.destroy()).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.resourceId, target?.revisionId, video, ready, selectedId, tracks, sourceKey, originMs, assKey]);

  // ---- the secondary subtitle: a text track, drawn under the main one ----
  useEffect(() => {
    setSecondaryCues([]);
    if (!target || !ready || !secondaryId || secondaryId === selectedId) return;
    const track = tracks.find((item) => item.id === secondaryId);
    if (!track || subtitleRenderer(track) !== "text") return;
    let stale = false;
    void (async () => {
      try {
        const { text } = await textOf(target, track.id);
        if (!stale) setSecondaryCues(parseSubtitleCues(text));
      } catch { /* the main subtitle and the video go on without it */ }
    })();
    return () => { stale = true; };
  }, [target?.resourceId, target?.revisionId, ready, secondaryId, selectedId, tracks]);

  /** What the ASS renderer has drawn for the frame on screen, at `size` (the file's own); null when no ASS track is being drawn. */
  const assPicture = useCallback((size: { w: number; h: number }) => (ass.current ? snapshotAss(ass.current, size) : Promise.resolve(null)), []);

  const select = useCallback((id: string | null) => setSelectedId(id), []);
  const selectSecondary = useCallback((id: string | null) => setSecondaryId(id), []);

  return { tracks, selectedId, secondaryId: secondaryId === selectedId ? null : secondaryId, status, message, cues, secondaryCues, facts, assPicture, select, selectSecondary };
}
