import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Camera, Captions, ChevronLeft, ChevronRight, Fullscreen, Gauge, Languages, ListVideo, Maximize2, Minimize2, MoreHorizontal, Pause, Play, Repeat, Shrink, StepBack, StepForward } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Menu, type MenuGroup, type MenuItem } from "../components/menu.tsx";
import { popupOpen } from "../components/popup.tsx";
import type { SourceCard } from "../lib/types.ts";
import { readerContext } from "../lib/reader-context.ts";
import { useTab } from "../workspace/tab-context.tsx";
import { tabMarks } from "../workspace/marks.ts";
import { useKeyTable } from "../lib/key-table.tsx";
import { quoteTags, useQuoteTags } from "../lib/quote-tags.ts";
import { SourceBanner } from "./source-banner.tsx";
import { isTypingTarget, useFullscreen } from "./use-fullscreen.ts";
import { useWindowFullscreen } from "./window-fullscreen.tsx";
import { MatchLink } from "./match-link.tsx";
import { SubtitleLayer } from "./subtitle-layer.tsx";
import { normalizeStyle } from "./subtitle-model.ts";
import { pageInk, shownLines } from "./subtitle-raster.ts";
import { useSubtitles } from "./use-subtitles.ts";
import { useVideoHealth } from "./use-video-health.ts";
import { videoFacts } from "../lib/video-facts.ts";
import { useVideoCapture } from "./use-video-capture.ts";
import { captureVideoFrame } from "./screenshot-capture.ts";
import type { ScreenshotPort } from "../hooks/use-screenshots.tsx";
import { useVideoPlayback, type ProgressReport } from "./use-video-playback.ts";
import { useVideoSource } from "./use-video-source.ts";
import {
  clampRate, displayFrame, DUCK_FACTOR, formatClock, intervalOf, parseClock, stepRate, subtitleRenderer, videoKeyAction,
  type TimeRange,
} from "./video-model.ts";
import { createArrowKeys } from "./video-keys.ts";
import { SeekBar, type SeekMarker } from "./video-seekbar.tsx";
import { VideoStatus } from "./video-status.tsx";
import { VideoTime } from "./video-time.tsx";
import { stepVolume, VolumeControl } from "./video-volume.tsx";
import { DanmakuLayer } from "./danmaku-layer.tsx";
import { DanmakuControl } from "./danmaku-controls.tsx";
import { shownCount, sourcesOf } from "./danmaku-model.ts";
import { useDanmaku } from "../hooks/use-danmaku.ts";
import { setDanmakuSources, useDanmakuSettings } from "../hooks/use-danmaku-settings.ts";

type T = Translator["t"];

export type AudioTrackInfo = { index: number; codec: string; language: string | null; title: string | null; channels: number | null; default: boolean };
export type EpisodeItem = { resourceId: string; label: string; available: boolean };

export type VideoDoc = {
  resourceId: string;
  revisionId: string;
  /** The work this episode belongs to, when it has one; the Agent pane lists related works from it. */
  workId?: string | null;
  /** The work's title. */
  title: string;
  /** "第 3 话 标题" or similar; null for a single film. */
  episodeLabel: string | null;
  durationMs: number;
  available: boolean;
  audio: AudioTrackInfo[];
  episodes: EpisodeItem[];
};

export type VideoSettings = {
  /** The rate now; `rates` is the list the menus offer (1× always in it) and `customRate` the one the R key switches to from 1×. */
  rate: number; rates: number[]; customRate: number; holdRate: number; volume: number; muted: boolean; seekStepSeconds: number; autoNext: boolean;
  /** How text subtitles are laid out (A-59): see `SubtitleStyle`. */
  subtitlePlacement: "auto" | "inside"; subtitleSizePct: number; subtitleFont: "sans" | "serif" | "kai"; subtitleOutline: boolean; assStyle: "keep" | "standard";
  /** A screenshot has the subtitles on screen drawn into it (A-92). */
  shotSubtitles: boolean;
};

/** Where a note's source points. `play` plays the interval and stops at its end; otherwise the player waits at the start. */
export type VideoFocus = { startMs: number; endMs?: number; play?: boolean; nonce: number; /** The player has gone there; a player mounted again starts from where the viewer is. */ applied?: boolean };

const IDLE_MS = 2500;
/** Below this width the bar keeps the play controls and the "…" panel takes the menus. */
const COMPACT_BELOW_PX = 720;

export function VideoPlayer(props: {
  t: T;
  doc: VideoDoc;
  settings: VideoSettings;
  onSettings: (patch: Partial<VideoSettings>) => void;
  startMs?: number;
  focus?: VideoFocus | null;
  onFocusApplied?: (nonce: number) => void;
  sourceCard?: SourceCard | null;
  /** The next episode, used only when "play the next one when this ends" is on; there is no button for it. */
  next?: { resourceId: string; title: string } | null;
  /** Recorded intervals of this video, drawn on the timeline as places to jump to. */
  markers?: Array<TimeRange & { id: string; label?: string }>;
  /** A recording is running: the picture may be made quieter or paused so the user's voice is clear, then restored. */
  duck?: { active: boolean; mode: "none" | "lower" | "pause" };
  /** Offered while the work is not linked to an online entry. */
  onMatch?: () => void;
  /** Other modules' actions on the marked stretch (the rough cut's "add"), drawn after the marks in the tool row. */
  tools?: (state: { currentMs: number; durationMs: number; interval: TimeRange | null }) => ReactNode;
  onBack: () => void;
  onNext: () => void;
  onEpisode: (resourceId: string) => void;
  onProgress: (report: ProgressReport) => void;
  onBackToNote: () => void;
  onRepair: () => void;
  /** Taking a picture of the current frame (S): the host saves it into the folder of the work and tells the person. */
  screenshots?: ScreenshotPort;
  /** The danmaku module is on: the layer, the bar's button and its key exist only then. `onDanmakuSettings` opens the danmaku page of the settings. */
  danmakuOn?: boolean;
  onDanmakuSettings?: () => void;
}) {
  const { t, doc, settings } = props;
  const tab = useTab();
  const target = useMemo(() => ({ resourceId: doc.resourceId, revisionId: doc.revisionId }), [doc.resourceId, doc.revisionId]);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const { fullscreen, toggle: toggleFullscreen } = useFullscreen(shell);
  const windowFull = useWindowFullscreen();
  /** Either full screen: the controls float over the picture and fade while it plays. */
  const full = fullscreen || windowFull.active;
  const [audioIndex, setAudioIndex] = useState<number | undefined>(undefined);
  const source = useVideoSource(target, audioIndex);
  const ready = source.state.phase === "ready";
  const url = source.state.phase === "ready" ? source.state.url : null;
  // The original file may start at a time other than zero on the element's clock; a play copy always starts at zero.
  const originMs = source.state.phase === "ready" ? source.state.startMs : 0;

  const playback = useVideoPlayback({
    element,
    target,
    url,
    startMs: props.focus && !props.focus.applied ? props.focus.startMs : props.startMs ?? 0,
    settings,
    volumeFactor: props.duck?.active && props.duck.mode === "lower" ? DUCK_FACTOR : 1,
    durationHintMs: doc.durationMs,
    originMs,
    onProgress: props.onProgress,
    onEnded: () => { if (settings.autoNext && props.next) props.onNext(); },
    onMediaError: source.reportMediaError,
  });
  useVideoCapture(element, target, playback.ready, originMs, tab.tabId);
  // A video that is playing shows on the tab's title (A-95).
  useEffect(() => {
    tabMarks.set(tab.tabId, "playing", playback.playing);
    return () => tabMarks.set(tab.tabId, "playing", false);
  }, [playback.playing, tab.tabId]);
  // A tab that cannot be seen does not keep playing; one that is only not in focus plays on as the person left it (A-94).
  useEffect(() => {
    if (!tab.visible && playback.playing) playback.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.visible]);
  // While a recording runs with "pause" chosen, a playing video waits and carries on when the recording ends.
  const pausedForRecording = useRef(false);
  const ducking = props.duck?.active === true && props.duck.mode === "pause";
  useEffect(() => {
    if (ducking && playback.playing) { pausedForRecording.current = true; playback.pause(); }
    if (!ducking && pausedForRecording.current) { pausedForRecording.current = false; void playback.play(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ducking]);
  const subtitleStyle = useMemo(() => normalizeStyle({ placement: settings.subtitlePlacement, sizePct: settings.subtitleSizePct, font: settings.subtitleFont, outline: settings.subtitleOutline, assStyle: settings.assStyle }), [settings.subtitlePlacement, settings.subtitleSizePct, settings.subtitleFont, settings.subtitleOutline, settings.assStyle]);
  const subtitles = useSubtitles({ target, video: element, ready: ready && playback.ready, sourceKey: url ?? "", style: subtitleStyle, originMs });

  // A picture that is not there is said so (the clock and the sound can run with nothing on screen), with the way out and the facts for the debug panel.
  const picture = useVideoHealth({ element, key: url ?? "", active: ready, playing: playback.playing });
  const [healthHidden, setHealthHidden] = useState(false);
  useEffect(() => { setHealthHidden(false); }, [url]);
  const planFacts = source.state.phase === "ready" ? source.state : null;
  useEffect(() => {
    videoFacts.set(doc.resourceId, {
      playing: planFacts ? planFacts.via : "none", decision: planFacts?.decision ?? "-", reasons: planFacts?.reasons ?? [],
      readyState: picture.facts.readyState, networkState: picture.facts.networkState, decodedFrames: picture.facts.decodedFrames, droppedFrames: picture.facts.droppedFrames,
      width: picture.facts.width, height: picture.facts.height, health: picture.health.state,
      subtitleRenderer: subtitles.facts.renderer, subtitleStatus: subtitles.status, defaultFont: subtitles.facts.defaultFont, missingFonts: subtitles.facts.missingFonts,
    });
  }, [doc.resourceId, planFacts?.via, planFacts?.decision, planFacts?.reasons, picture.facts, picture.health.state, subtitles.facts, subtitles.status]);
  useEffect(() => () => videoFacts.clear(doc.resourceId), [doc.resourceId]);

  const [markA, setMarkA] = useState<number | null>(null);
  const [markB, setMarkB] = useState<number | null>(null);
  const interval = intervalOf(markA, markB);
  const keys = useKeyTable();
  const [more, setMore] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // The menu is placed by window coordinates; on the top layer no tab, column or stacking context of the workspace shifts or hides it.
  const showOnTopLayer = useCallback((node: HTMLDivElement | null) => {
    try { if (node && typeof node.showPopover === "function" && !node.matches(":popover-open")) node.showPopover(); } catch { /* shown in place */ }
  }, []);
  const [idle, setIdle] = useState(false);
  const [inputError, setInputError] = useState("");
  // The T key asks the clock to open for typing.
  const [timeAsk, setTimeAsk] = useState(0);

  // In full screen the controls lie over the picture, which keeps its size; their height tells the subtitle layer how far to lift the dialogue so it is never
  // under them. A bar that is narrow keeps the play controls and hands its menus to the "…" panel.
  const controls = useRef<HTMLDivElement>(null);
  const [controlsH, setControlsH] = useState(0);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const node = controls.current;
    if (!node) return;
    const measure = () => {
      setControlsH(node.offsetHeight);
      setCompact(node.clientWidth > 0 && node.clientWidth < COMPACT_BELOW_PX);
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);

  // How far the bar, floating over the picture, reaches up from the bottom edge: the dialogue and every prompt over the picture are lifted by it.
  const lift = full && !idle ? controlsH : 0;
  const duration = playback.durationMs > 0 ? playback.durationMs : doc.durationMs;
  const rate = clampRate(settings.rate);
  const effectiveRate = playback.holding ? clampRate(settings.holdRate) : rate;

  // ---- a note's source: go there (and play it when asked) ----
  const applied = useRef(0);
  const focus = props.focus ?? null;
  useEffect(() => {
    if (!focus || focus.applied || !playback.ready || applied.current === focus.nonce) return;
    applied.current = focus.nonce;
    if (focus.play && focus.endMs !== undefined) playback.playRange(focus.startMs, focus.endMs);
    else playback.seekTo(focus.startMs);
    props.onFocusApplied?.(focus.nonce);
  }, [focus, playback.ready, playback]);

  const defaultAudio = doc.audio.find((track) => track.default) ?? doc.audio[0];

  // ---- danmaku ----
  // The comments of this episode come from the network only while the module is on and the person has danmaku switched on; the settings are shared with the settings page.
  const danmakuOn = props.danmakuOn === true;
  const danmakuSettings = useDanmakuSettings(danmakuOn);
  const danmaku = useDanmaku({ on: danmakuOn, enabled: danmakuSettings.settings.enabled, resourceId: doc.resourceId, revisionId: doc.revisionId, convert: danmakuSettings.settings.convert });
  const [danmakuOpen, setDanmakuOpen] = useState(false);
  useEffect(() => { if (danmakuOn) setDanmakuSources(sourcesOf(danmaku.items)); }, [danmakuOn, danmaku.items]);
  const danmakuCanvas = useRef<(() => HTMLCanvasElement | null) | null>(null);
  const danmakuShown = useMemo(() => shownCount(danmaku.items, danmakuSettings.settings), [danmaku.items, danmakuSettings.settings]);
  const toggleDanmaku = useCallback(() => { void danmakuSettings.save({ enabled: !danmakuSettings.settings.enabled }); }, [danmakuSettings]);

  // ---- a screenshot of the frame on screen ----
  // The picture is the video element's own frame at the size of the file; nothing is asked of FFmpeg, so it is the frame the person sees.
  const shooting = useRef(false);
  const takeScreenshot = useCallback(async () => {
    const port = props.screenshots;
    if (!port || !element || shooting.current) return;
    shooting.current = true;
    try {
      const positionMs = Math.max(0, Math.round(element.currentTime * 1000 - originMs));
      // Comments are in the picture only when the person asked for that and they are on screen.
      const canvas = danmakuOn && danmakuSettings.settings.enabled && danmakuSettings.settings.shotWith ? danmakuCanvas.current?.() ?? null : null;
      const track = subtitles.tracks.find((entry) => entry.id === subtitles.selectedId);
      const second = subtitles.secondaryId ? subtitles.tracks.find((entry) => entry.id === subtitles.secondaryId) : undefined;
      // What is on screen at that moment, as lines: it goes into the record whether or not it is drawn into the picture.
      const mainText = shownLines(subtitles.cues, positionMs).join("\n");
      const secondText = shownLines(subtitles.secondaryCues, positionMs).join("\n");
      const size = { w: element.videoWidth, h: element.videoHeight };
      const withSubtitles = settings.shotSubtitles !== false && (track !== undefined || second !== undefined);
      const shot = await captureVideoFrame(element, {
        // Asked for after the frame is taken: an ASS renderer needs a moment to draw at the size of the file.
        subtitles: withSubtitles ? async () => ({
          text: { main: subtitles.cues, second: subtitles.secondaryCues, timeMs: positionMs, style: subtitleStyle, ink: pageInk() },
          ass: track && subtitleRenderer(track) === "ass" ? await subtitles.assPicture(size) : null,
        }) : null,
        danmaku: canvas ? { canvas, area: danmakuSettings.settings.area, opacity: danmakuSettings.settings.opacity } : null,
      });
      if ("failure" in shot) { port.fail(shot.failure); return; }
      const audio = doc.audio.find((entry) => entry.index === (audioIndex ?? defaultAudio?.index));
      const frame = playback.frame.status === "ready" ? displayFrame(playback.frame.frame) : null;
      await port.save({
        resourceId: doc.resourceId, resourceRevisionId: doc.revisionId, data: shot.data,
        video: {
          positionMs, playbackRate: element.playbackRate,
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
  }, [props.screenshots, element, originMs, subtitles.tracks, subtitles.selectedId, subtitles.secondaryId, subtitles.cues, subtitles.secondaryCues, subtitles.assPicture, subtitleStyle, settings.shotSubtitles, doc.audio, doc.resourceId, doc.revisionId, audioIndex, defaultAudio?.index, playback.frame, danmakuOn, danmakuSettings.settings.enabled, danmakuSettings.settings.shotWith, danmakuSettings.settings.area, danmakuSettings.settings.opacity]);

  // ---- keyboard ----
  // ← and → are a step when tapped and a hold when held; the controller tells the two apart and reads the player as it is at that moment.
  const live = useRef({ playback, settings });
  live.current = { playback, settings };
  const arrows = useMemo(() => createArrowKeys({
    tap: (side) => live.current.playback.seekBy(side * live.current.settings.seekStepSeconds * 1000),
    holdStart: (side) => { if (side > 0) live.current.playback.holdStart(); else live.current.playback.rewindStart(); },
    holdEnd: (side) => { if (side > 0) live.current.playback.holdEnd(); else live.current.playback.rewindEnd(); },
  }), []);
  useEffect(() => () => arrows.release(), [arrows]);

  const act = useCallback((event: KeyboardEvent) => {
    const action = videoKeyAction(event, keys);
    if (!action) return false;
    switch (action.type) {
      case "toggle": playback.toggle(); break;
      case "arrow": arrows.down(action.side, event.repeat); break;
      case "volume": props.onSettings({ volume: stepVolume(settings.muted ? 0 : settings.volume, action.delta), muted: false }); break;
      case "frame": void playback.stepFrame(action.delta); break;
      case "mute": props.onSettings({ muted: !settings.muted }); break;
      case "fullscreen": toggleFullscreen(); break;
      case "markA": setMarkA(playback.currentMs); break;
      case "markB": setMarkB(playback.currentMs); break;
      case "rate": props.onSettings({ rate: stepRate(rate, action.direction, settings.rates) }); break;
      case "customRate": props.onSettings({ rate: rate === 1 ? clampRate(settings.customRate) : 1 }); break;
      case "start": playback.seekTo(0); break;
      case "time": setTimeAsk((count) => count + 1); break;
      case "screenshot": void takeScreenshot(); break;
      case "danmaku": if (danmakuOn) toggleDanmaku(); break;
      case "escape":
        if (volumeOpen) setVolumeOpen(false);
        else if (danmakuOpen) setDanmakuOpen(false);
        else if (menuAt) setMenuAt(null);
        else if (fullscreen) toggleFullscreen();
        else if (markA !== null || markB !== null) { setMarkA(null); setMarkB(null); }
        else return false;
        break;
    }
    return true;
  }, [keys, settings.volume, settings.muted, settings.rates, settings.customRate, rate, playback, props, arrows, toggleFullscreen, volumeOpen, menuAt, fullscreen, markA, markB, takeScreenshot]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const node = event.target;
      // A range slider is a control of this player: its arrow keys are the player's. Text fields keep their own keys.
      const slider = node instanceof HTMLInputElement && node.type === "range";
      if (isTypingTarget(node) && !slider) return;
      if (node instanceof HTMLElement && (node.closest("[role='dialog']") || node.closest("[role='menu']"))) return;
      if (event.defaultPrevented) return;
      if (act(event)) event.preventDefault();
    };
    // Only the focused tab answers the keys (A-94).
    if (!tab.focused) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, tab.focused]);
  // Letting go of an arrow ends a step or a hold wherever the focus is; a window that lost focus never sees the key go up.
  useEffect(() => {
    const onUp = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") arrows.up(-1);
      else if (event.key === "ArrowRight") arrows.up(1);
    };
    const onBlur = () => arrows.release();
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keyup", onUp); window.removeEventListener("blur", onBlur); };
  }, [arrows]);

  // ---- controls fade in full screen while a video plays ----
  // A menu or the volume slider that is open keeps them: they hang from a control, which would fade out from under them.
  useEffect(() => {
    // At the end the bar stays: the prompt to play again is lifted above it, and the person reaches for the bar next.
    if (!full || !playback.playing || playback.ended) { setIdle(false); return; }
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (popupOpen()) arm(); else setIdle(true); }, IDLE_MS);
    };
    const wake = () => { setIdle(false); arm(); };
    arm();
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => { window.clearTimeout(timer); window.removeEventListener("pointermove", wake); window.removeEventListener("keydown", wake); };
  }, [full, playback.playing, playback.ended]);

  // ---- right button: the menu (the temporary rate is a held → key, not the mouse) ----
  useEffect(() => {
    if (!menuAt) return;
    const close = () => setMenuAt(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuAt]);

  // ---- typed times and rates ----
  // The time is typed in the clock itself; a jump lands on the frame that contains the time. The reason a text was refused
  // is returned to the clock, which keeps the field open.
  const goTime = (text: string): string | null => {
    const ms = parseClock(text);
    if (ms === null) { setInputError(t("video.timeInvalid")); return t("video.timeInvalid"); }
    setInputError("");
    void playback.gotoTime(ms);
    return null;
  };

  // ---- menus ----
  const rateItems: MenuItem[] = settings.rates.map((preset) => ({ id: String(preset).replace(".", "_"), label: t("video.rateValue", { rate: preset }), checked: preset === rate, onSelect: () => props.onSettings({ rate: preset }) }));
  const trackName = (track: { language: string | null; title: string | null }, index: number) => {
    const text = [track.language, track.title].filter(Boolean).join(" ").trim();
    return text || t("video.trackPlain", { index });
  };
  const subtitleItems: MenuItem[] = [
    { id: "off", label: t("video.subtitleOff"), checked: subtitles.selectedId === null, onSelect: () => subtitles.select(null) },
    ...subtitles.tracks.map((track, index) => ({ id: track.id, label: trackName(track, index + 1), checked: subtitles.selectedId === track.id, disabled: track.format === null, onSelect: () => subtitles.select(track.id) })),
  ];
  // A secondary subtitle is a second text track under the main one: bilingual files and an explaining track, not a second ASS drawing.
  const secondaryItems: MenuItem[] = [
    { id: "off", testId: "video-subtitles-secondary-off", label: t("video.subtitleSecondaryOff"), checked: subtitles.secondaryId === null, onSelect: () => subtitles.selectSecondary(null) },
    ...subtitles.tracks.map((track, index) => ({ id: track.id, testId: `video-subtitles-secondary-${track.id}`, label: trackName(track, index + 1), checked: subtitles.secondaryId === track.id, disabled: track.format === null || track.format === "ass" || track.id === subtitles.selectedId, onSelect: () => subtitles.selectSecondary(track.id) })),
  ];
  // One button for both. The second group is there only when a second track can be chosen (or one is chosen and has to be switched off): a file with
  // a single track, or with nothing but ASS, has the main subtitle alone.
  const canHaveSecondary = subtitles.tracks.length > 1 && subtitles.tracks.some((track) => (track.format === "srt" || track.format === "vtt") && track.id !== subtitles.selectedId);
  const subtitleGroups: MenuGroup[] = [
    { id: "primary", title: t("video.subtitlePrimary"), items: subtitleItems },
    ...(canHaveSecondary || subtitles.secondaryId !== null ? [{ id: "secondary", title: t("video.subtitleSecondary"), items: secondaryItems }] : []),
  ];
  const audioItems: MenuItem[] = doc.audio.map((track, position) => ({
    id: String(track.index),
    label: t("video.track", { language: track.language ?? "", title: track.title ?? t("video.audioTrack", { index: position + 1 }) }).trim(),
    checked: (audioIndex ?? defaultAudio?.index) === track.index,
    onSelect: () => setAudioIndex(track.index === defaultAudio?.index ? undefined : track.index),
  }));
  const episodeItems: MenuItem[] = doc.episodes.map((episode) => ({ id: episode.resourceId, label: episode.label, checked: episode.resourceId === doc.resourceId, disabled: !episode.available, onSelect: () => props.onEpisode(episode.resourceId) }));

  // The menus open on the top layer above the bar (they are in the bar when it is wide and in the "…" panel when it is narrow).
  const menus = (
    <>
      <Menu label={t("video.subtitles")} testId="video-subtitles" className="video-menu" placement="above" align="end" {...(subtitleGroups.length > 1 ? { groups: subtitleGroups } : { items: subtitleItems })} trigger={<Captions size={18} />} />
      {doc.audio.length > 1 ? <Menu label={t("video.audio")} testId="video-audio" className="video-menu" placement="above" align="end" items={audioItems} trigger={<Languages size={18} />} /> : null}
      {doc.episodes.length > 1 ? <Menu label={t("video.episodes")} testId="video-episodes" className="video-menu" placement="above" align="end" items={episodeItems} trigger={<ListVideo size={18} />} /> : null}
      <Menu label={t("video.rate")} testId="video-rate" className="video-menu" placement="above" align="end" items={rateItems} trigger={<><Gauge size={16} /><span>{t("video.rateValue", { rate: effectiveRate })}</span></>} />
    </>
  );

  // ---- the timeline's markers ----
  const markers: SeekMarker[] = [
    ...(props.markers ?? []).map((marker) => ({ ...marker, kind: "recording" as const })),
    ...(focus ? [{ id: "source", kind: "source" as const, startMs: focus.startMs, endMs: focus.endMs ?? focus.startMs + 500 }] : []),
    ...(interval ? [{ id: "interval", kind: "mark" as const, ...interval }] : markA !== null ? [{ id: "mark-a", kind: "mark" as const, startMs: markA, endMs: markA + 300 }] : markB !== null ? [{ id: "mark-b", kind: "mark" as const, startMs: markB, endMs: markB + 300 }] : []),
  ];

  // ---- the Agent's right pane hears where the video is, to offer it as context ----
  const frameNow = playback.frame.status === "ready" ? displayFrame(playback.frame.frame) : null;
  const intervalStart = interval?.startMs;
  const intervalEnd = interval?.endMs;
  useEffect(() => {
    readerContext.set({
      kind: "video", resourceId: doc.resourceId, revisionId: doc.revisionId, title: doc.episodeLabel ? `${doc.title} ${doc.episodeLabel}` : doc.title, workId: doc.workId ?? null,
      positionMs: Math.round(playback.currentMs), durationMs: doc.durationMs, frame: frameNow,
      interval: intervalStart !== undefined && intervalEnd !== undefined ? { startMs: intervalStart, endMs: intervalEnd } : null,
    }, tab.tabId);
  }, [playback.currentMs, frameNow, intervalStart, intervalEnd, doc.resourceId, doc.revisionId, doc.title, doc.episodeLabel, doc.durationMs, doc.workId, tab.tabId]);
  useEffect(() => () => { readerContext.clear(doc.resourceId, tab.tabId); quoteTags.clearFor(doc.resourceId); }, [doc.resourceId, tab.tabId]);

  // A marked stretch (A-B) is a quote tag for the right pane; the player only reads. Removing the tag there clears the marks here.
  const tags = useQuoteTags(doc.resourceId);
  const intervalTagged = tags.some((tag) => tag.kind === "interval");
  const tagged = useRef(false);
  useEffect(() => {
    if (intervalStart !== undefined && intervalEnd !== undefined) {
      tagged.current = true;
      quoteTags.put({
        kind: "interval", resourceId: doc.resourceId, revisionId: doc.revisionId, startMs: Math.round(intervalStart), endMs: Math.round(intervalEnd),
        label: t("chat.tag.interval", { start: formatClock(intervalStart), end: formatClock(intervalEnd) }),
      });
    } else if (tagged.current) {
      tagged.current = false;
      quoteTags.removeKind("interval", doc.resourceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalStart, intervalEnd, doc.resourceId, doc.revisionId]);
  useEffect(() => {
    if (tagged.current && !intervalTagged) { tagged.current = false; setMarkA(null); setMarkB(null); }
  }, [intervalTagged]);

  const frameText2 = playback.playing ? "" : playback.frame.status === "ready"
    ? t("video.frameOf", { frame: displayFrame(playback.frame.frame), total: playback.frame.totalFrames })
    : playback.frame.status === "loading" ? t("video.frameLoading") : playback.frame.status === "absent" ? t("video.frameOnDemand") : playback.frame.status === "unavailable" ? t("video.frameUnavailable") : "";

  const copyBadge = source.state.phase === "ready" && source.state.via === "play_copy";
  const alternateAudio = audioIndex !== undefined && audioIndex !== defaultAudio?.index;
  const showPlayButton = ready && playback.ready && !playback.playing && !playback.ended;

  return (
    <section className="reader video-reader" data-testid="video-reader" data-ready={playback.ready || undefined} data-fullscreen={full || undefined} data-window-full={(windowFull.active && !fullscreen) || undefined}>
      {props.sourceCard ? <SourceBanner t={t} card={props.sourceCard} testPrefix="video" onBackToNote={props.onBackToNote} onRepair={props.onRepair} /> : null}

      <div ref={shell} className="video-shell" data-testid="video-shell" data-full={full || undefined} data-idle={idle || undefined}>
        <div
          className="video-stage"
          data-testid="video-stage"
          role="group"
          aria-label={t("video.stage")}
          style={{ "--player-lift": `${lift}px` } as CSSProperties}
          onClick={() => { if (ready) playback.toggle(); }}
          onDoubleClick={toggleFullscreen}
          onContextMenu={(event) => { event.preventDefault(); if (ready) setMenuAt({ x: event.clientX, y: event.clientY }); }}
        >
          <video
            ref={setElement}
            className="video-element"
            data-testid="video-element"
            crossOrigin="anonymous"
            src={url ?? undefined}
            preload="auto"
            playsInline
          />
          {source.state.phase !== "ready" ? (
            <div className="video-overlay" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
              <VideoStatus
                t={t}
                state={source.state}
                alternateAudio={alternateAudio}
                onMakeCopy={() => void source.createCopy(false)}
                onCancelCopy={() => void source.cancelCopy()}
                onRetry={() => void source.resolve()}
                onForceCopy={() => void source.createCopy(true)}
                onDefaultAudio={() => setAudioIndex(undefined)}
                onRepair={props.onRepair}
              />
            </div>
          ) : null}
          {danmakuOn ? (
            <DanmakuLayer
              media={element}
              items={danmaku.items}
              settings={danmakuSettings.settings}
              offsetMs={danmaku.match?.offsetMs ?? 0}
              originMs={originMs}
              visible={danmakuSettings.settings.enabled && danmaku.phase === "ready"}
              captureRef={danmakuCanvas}
            />
          ) : null}
          <SubtitleLayer video={element} cues={subtitles.cues} secondaryCues={subtitles.secondaryCues} style={subtitleStyle} originMs={originMs} lift={lift} />
          {ready && picture.health.state !== "ok" && !healthHidden ? (
            <div className="video-health" role="alert" data-testid="video-health" data-state={picture.health.state} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
              <p>{picture.health.state === "no-first-frame" ? t("video.health.noFirstFrame") : t("video.health.noFrames")}</p>
              <p className="video-status-note">{source.state.phase === "ready" && source.state.via === "original" ? t("video.copyNote") : t("video.health.fromCopy")}</p>
              <div className="video-status-actions">
                {source.state.phase === "ready" && source.state.via === "original" ? <button type="button" className="primary-button" data-testid="video-health-copy" onClick={() => void source.createCopy(true)}>{t("video.forceCopy")}</button> : null}
                <button type="button" className="secondary-button" data-testid="video-health-retry" onClick={() => void source.resolve()}>{t("video.retry")}</button>
                <button type="button" className="link-button" data-testid="video-health-dismiss" onClick={() => setHealthHidden(true)}>{t("video.health.dismiss")}</button>
              </div>
            </div>
          ) : null}
          {showPlayButton ? (
            <button type="button" className="video-big-play" data-testid="video-big-play" aria-label={t("video.playBig")} onClick={(event) => { event.stopPropagation(); playback.toggle(); }}><Play size={34} /></button>
          ) : null}
          {playback.holding ? <span className="video-holding" role="status" data-testid="video-holding">{t("video.holding", { rate: effectiveRate })}</span> : null}
          {playback.rewinding ? <span className="video-holding" role="status" data-testid="video-rewinding">{t("video.rewinding")}</span> : null}
          {subtitles.status === "failed" ? <span className="video-subtitle-notice" role="status" data-testid="video-subtitle-notice">{t("video.subtitleFailed", { reason: subtitles.message })}</span> : null}
          {playback.ended && !(settings.autoNext && props.next) ? (
            <div className="video-end" role="status" data-testid="video-end" onClick={(event) => event.stopPropagation()}>
              <strong>{t("video.ended")}</strong>
              <button type="button" className="secondary-button" data-testid="video-replay" onClick={() => { playback.seekTo(0); void playback.play(); }}><Repeat size={14} />{t("video.replay")}</button>
            </div>
          ) : null}
          {menuAt ? (
            <div ref={showOnTopLayer} popover="manual" className="video-context" role="menu" aria-label={t("video.menu")} data-testid="video-context" style={{ left: menuAt.x, top: menuAt.y, right: "auto", bottom: "auto" }} onMouseDown={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
              <button type="button" role="menuitem" onClick={() => { setMenuAt(null); playback.toggle(); }}>{playback.playing ? t("video.pause") : t("video.play")}</button>
              {settings.rates.map((preset) => (
                <button key={preset} type="button" role="menuitemradio" aria-checked={preset === rate} onClick={() => { setMenuAt(null); props.onSettings({ rate: preset }); }}>{t("video.rateValue", { rate: preset })}</button>
              ))}
            </div>
          ) : null}
        </div>

        <div ref={controls} className="video-controls" data-testid="video-controls" role="toolbar" aria-label={t("video.controls")} data-compact={compact || undefined}>
          <SeekBar t={t} currentMs={playback.currentMs} durationMs={duration} bufferedMs={playback.bufferedMs} markers={markers} disabled={!ready} onSeek={playback.seekTo} />
          <div className="video-row">
            <button type="button" className="icon-button" data-testid="video-toggle" aria-label={playback.playing ? t("video.pause") : t("video.play")} title={playback.playing ? t("video.pause") : t("video.play")} disabled={!ready} onClick={playback.toggle}>{playback.playing ? <Pause size={18} /> : <Play size={18} />}</button>
            <VideoTime t={t} currentMs={playback.currentMs} durationMs={duration} playing={playback.playing} disabled={!ready} openAsk={timeAsk} onGo={goTime} />
            {copyBadge ? <span className="chip" data-testid="video-copy-badge">{t("video.copyBadge")}</span> : null}
            <span
              className="video-frame"
              data-testid="video-frame"
              data-frame={playback.frame.status === "ready" ? displayFrame(playback.frame.frame) : undefined}
              data-verified={playback.frameVerified === null ? undefined : String(playback.frameVerified)}
              title={playback.frame.status === "unavailable" ? playback.frame.message : playback.frame.status === "ready" && playback.frame.variableFrameRate ? t("video.frameVfr") : undefined}
            >{frameText2}</span>
            <span className="flex-1" />
            {compact ? null : menus}
            {danmakuOn ? (
              <DanmakuControl t={t} view={danmaku} settings={danmakuSettings.settings} shown={danmakuShown} open={danmakuOpen} onOpen={setDanmakuOpen} onToggle={toggleDanmaku} onOpenSettings={props.onDanmakuSettings} />
            ) : null}
            <VolumeControl t={t} volume={settings.volume} muted={settings.muted} open={volumeOpen} onOpen={setVolumeOpen} onChange={(patch) => props.onSettings(patch)} />
            {props.screenshots ? <button type="button" className="icon-button" data-testid="video-screenshot" aria-label={t("screenshot.take")} title={`${t("screenshot.takeHint")}`} disabled={!ready} onClick={() => void takeScreenshot()}><Camera size={18} /></button> : null}
            <button type="button" className="icon-button" data-testid="video-window-fullscreen" aria-pressed={windowFull.active} aria-label={windowFull.active ? t("window.fullscreen.exit") : t("window.fullscreen")} title={windowFull.active ? t("window.fullscreen.exit") : t("window.fullscreen")} onClick={windowFull.toggle}>{windowFull.active ? <Shrink size={18} /> : <Fullscreen size={18} />}</button>
            <button type="button" className="icon-button" data-testid="video-fullscreen" aria-label={fullscreen ? t("video.exitFullscreen") : t("video.fullscreen")} title={fullscreen ? t("video.exitFullscreen") : t("video.fullscreen")} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
            <button type="button" className="icon-button" data-testid="video-more" aria-expanded={more} aria-label={t("video.more")} title={t("video.more")} onClick={() => setMore((open) => !open)}><MoreHorizontal size={18} /></button>
          </div>

          {more ? (
            <div className="video-more-panel" data-testid="video-more-panel">
              <div className="video-row">
                <button type="button" className="icon-button" data-testid="video-step-back" aria-label={t("video.back", { seconds: settings.seekStepSeconds })} title={t("video.back", { seconds: settings.seekStepSeconds })} disabled={!ready} onClick={() => playback.seekBy(-settings.seekStepSeconds * 1000)}><ChevronLeft size={18} /></button>
                <button type="button" className="icon-button" data-testid="video-step-forward" aria-label={t("video.forward", { seconds: settings.seekStepSeconds })} title={t("video.forward", { seconds: settings.seekStepSeconds })} disabled={!ready} onClick={() => playback.seekBy(settings.seekStepSeconds * 1000)}><ChevronRight size={18} /></button>
                <button type="button" className="icon-button" data-testid="video-prev-frame" aria-label={t("video.prevFrame")} title={t("video.prevFrame")} disabled={!ready} onClick={() => void playback.stepFrame(-1)}><StepBack size={16} /></button>
                <button type="button" className="icon-button" data-testid="video-next-frame" aria-label={t("video.nextFrame")} title={t("video.nextFrame")} disabled={!ready} onClick={() => void playback.stepFrame(1)}><StepForward size={16} /></button>
                {compact ? menus : null}
              </div>
              <div className="video-row video-tools">
                <button type="button" className="secondary-button" data-testid="video-mark-a" aria-pressed={markA !== null} onClick={() => setMarkA(playback.currentMs)}>{t("video.markA")}{markA !== null ? ` ${formatClock(markA)}` : ""}</button>
                <button type="button" className="secondary-button" data-testid="video-mark-b" aria-pressed={markB !== null} onClick={() => setMarkB(playback.currentMs)}>{t("video.markB")}{markB !== null ? ` ${formatClock(markB)}` : ""}</button>
                {interval ? <span className="video-interval" data-testid="video-interval">{t("video.interval", { start: formatClock(interval.startMs), end: formatClock(interval.endMs) })}</span> : null}
                {markA !== null || markB !== null ? <button type="button" className="link-button" data-testid="video-clear-marks" onClick={() => { setMarkA(null); setMarkB(null); }}>{t("video.clearMarks")}</button> : null}
                {props.tools ? props.tools({ currentMs: playback.currentMs, durationMs: duration, interval }) : null}
                <MatchLink label={t("match.fromReader")} onMatch={props.onMatch} />
              </div>
            </div>
          ) : null}
          {inputError ? <p className="video-input-error" role="alert" data-testid="video-input-error">{inputError}</p> : null}
        </div>
      </div>
    </section>
  );
}
