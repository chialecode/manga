import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Captions, Fullscreen, Gauge, Languages, ListVideo, Maximize2, Minimize2, MoreHorizontal, NotebookPen, Pause, Play, Repeat, Shrink, Sparkles, X } from "lucide-react";
import { chordLabel } from "@manga/contracts/keys";
import type { Translator } from "@manga/i18n";
import { SelectionBubble } from "../components/capture/selection-bubble.tsx";
import { Menu, type MenuGroup, type MenuItem } from "../components/menu.tsx";
import type { SourceCard } from "../lib/types.ts";
import { captureBridge, useCaptureActions, useQuickNoteSession } from "../lib/capture-bridge.ts";
import { isImeEvent } from "../lib/ime.ts";
import { readerContext } from "../lib/reader-context.ts";
import { useTab } from "../workspace/tab-context.tsx";
import { tabMarks } from "../workspace/marks.ts";
import { useKeyTable } from "../lib/key-table.tsx";
import { quoteTags, useQuoteTags, type QuoteTag } from "../lib/quote-tags.ts";
import { useAutoHide } from "../reader/use-auto-hide.ts";
import { SourceBanner } from "./source-banner.tsx";
import { isTypingTarget, useFullscreen } from "./use-fullscreen.ts";
import { useWindowFullscreen } from "./window-fullscreen.tsx";
import { SubtitleLayer } from "./subtitle-layer.tsx";
import { normalizeStyle } from "./subtitle-model.ts";
import { useSubtitles } from "./use-subtitles.ts";
import { useVideoHealth } from "./use-video-health.ts";
import { videoFacts } from "../lib/video-facts.ts";
import { useVideoCapture } from "./use-video-capture.ts";
import { useVideoScreenshot } from "./use-video-screenshot.ts";
import type { ScreenshotPort } from "../hooks/use-screenshots.tsx";
import { useVideoPlayback, type ProgressReport } from "./use-video-playback.ts";
import { useVideoSource } from "./use-video-source.ts";
import {
  clampRate, displayFrame, DUCK_FACTOR, formatClock, intervalOf, parseClock, stepRate, videoKeyAction,
  type TimeRange,
} from "./video-model.ts";
import { createArrowKeys, type ArrowSide } from "./video-keys.ts";
import { SeekBar, type SeekMarker } from "./video-seekbar.tsx";
import { VideoStatus } from "./video-status.tsx";
import { VideoTime } from "./video-time.tsx";
import { stepVolume, VolumeControl } from "./video-volume.tsx";
import { VideoMorePopup } from "./video-more-popup.tsx";
import { DanmakuLayer, type DanmakuCapture } from "./danmaku-layer.tsx";
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
  /** Opening quick-note pauses playback and resumes on close; false by default. */
  pauseOnQuickNote: boolean;
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
  const moreAnchor = useRef<HTMLButtonElement>(null);
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
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  useVideoCapture(element, target, playback.ready, originMs, tab.tabId);
  // A video that is playing shows on the tab's title (A-95).
  useEffect(() => {
    tabMarks.set(tab.tabId, "playing", playback.playing);
    return () => tabMarks.set(tab.tabId, "playing", false);
  }, [playback.playing, tab.tabId]);
  // A tab that cannot be seen does not keep playing; one that is only not in focus plays on as the person left it (A-94).
  useEffect(() => {
    if (!tab.visible && playbackRef.current.playing) playbackRef.current.pause();
  }, [tab.visible]);
  // While a recording runs with "pause" chosen, a playing video waits and carries on when the recording ends.
  const pausedForRecording = useRef(false);
  const ducking = props.duck?.active === true && props.duck.mode === "pause";
  useEffect(() => {
    if (ducking && playbackRef.current.playing) { pausedForRecording.current = true; playbackRef.current.pause(); }
    if (!ducking && pausedForRecording.current) { pausedForRecording.current = false; void playbackRef.current.play(); }
  }, [ducking]);

  // Optional pause-on-quick-note: default false (watching continues while typing). When enabled, auto-pauses playing
  // video on open and resumes on close only if the user did not manually toggle playback while the modal was open.
  const captureActions = useCaptureActions();
  const quickNoteState = useQuickNoteSession();
  const quickNoteOpenForMe = quickNoteState.open && quickNoteState.resourceId === doc.resourceId;
  const pausedForQuickNote = useRef(false);
  const prevQuickNoteOpen = useRef(false);
  const pauseOnQuickNoteRef = useRef(settings.pauseOnQuickNote);
  pauseOnQuickNoteRef.current = settings.pauseOnQuickNote;
  const elementRef = useRef(element);
  elementRef.current = element;

  useEffect(() => {
    if (!element || !quickNoteOpenForMe) return;
    const onPlay = () => { pausedForQuickNote.current = false; };
    element.addEventListener("play", onPlay);
    return () => element.removeEventListener("play", onPlay);
  }, [element, quickNoteOpenForMe]);

  useEffect(() => {
    const wasOpen = prevQuickNoteOpen.current;
    prevQuickNoteOpen.current = quickNoteOpenForMe;
    if (!wasOpen && quickNoteOpenForMe) {
      const el = elementRef.current;
      const isPlaying = playbackRef.current.playing || Boolean(el && !el.paused && !el.ended);
      if (pauseOnQuickNoteRef.current && isPlaying) {
        playbackRef.current.pause();
        pausedForQuickNote.current = true;
      } else {
        pausedForQuickNote.current = false;
      }
    } else if (wasOpen && !quickNoteOpenForMe) {
      if (pausedForQuickNote.current) {
        pausedForQuickNote.current = false;
        void playbackRef.current.play();
      }
    }
  }, [quickNoteOpenForMe]);
  useEffect(() => () => { pausedForQuickNote.current = false; }, []);

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
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const [more, setMore] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // The menu is placed by window coordinates; on the top layer no tab, column or stacking context of the workspace shifts or hides it.
  const showOnTopLayer = useCallback((node: HTMLDivElement | null) => {
    try { if (node && typeof node.showPopover === "function" && !node.matches(":popover-open")) node.showPopover(); } catch { /* shown in place */ }
  }, []);
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

  // ---- controls fade in full screen while a video plays (shared useAutoHide) ----
  const held = playback.holding || playback.rewinding;
  const controlsHide = useAutoHide(shell, {
    enabled: full && !playback.ended,
    hold: more,
    delayMs: IDLE_MS,
    wakeOnAnyPointerMove: true,
    resting: !playback.playing && !held,
    quietHold: held,
    barRef: controls,
    shouldWakeOnKey: (event) => videoKeyAction(event, keysRef.current)?.type !== "arrow",
    wakeOnPointerEnter: false,
  });
  const idle = controlsHide.hidden;
  const wakeBar = useRef<() => void>(() => undefined);
  wakeBar.current = full && !playback.ended ? controlsHide.wake : () => undefined;

  // How far the bar, floating over the picture, reaches up from the bottom edge: the dialogue and every prompt over the picture are lifted by it.
  const lift = full && !idle ? controlsH : 0;
  const duration = playback.durationMs > 0 ? playback.durationMs : doc.durationMs;
  const rate = clampRate(settings.rate);
  const effectiveRate = playback.holding ? clampRate(settings.holdRate) : rate;

  // ---- a note's source: go there (and play it when asked) ----
  const applied = useRef(0);
  const focus = props.focus ?? null;
  const onFocusAppliedRef = useRef(props.onFocusApplied);
  onFocusAppliedRef.current = props.onFocusApplied;
  useEffect(() => {
    if (!focus || focus.applied || !playback.ready || applied.current === focus.nonce) return;
    applied.current = focus.nonce;
    if (focus.play && focus.endMs !== undefined) playbackRef.current.playRange(focus.startMs, focus.endMs);
    else playbackRef.current.seekTo(focus.startMs);
    onFocusAppliedRef.current?.(focus.nonce);
  }, [focus, playback.ready]);

  const defaultAudio = doc.audio.find((track) => track.default) ?? doc.audio[0];

  // ---- danmaku ----
  // The comments of this episode come from the network only while the module is on and the person has danmaku switched on; the settings are shared with the settings page.
  const danmakuOn = props.danmakuOn === true;
  const danmakuSettings = useDanmakuSettings(danmakuOn);
  const danmaku = useDanmaku({ on: danmakuOn, enabled: danmakuSettings.settings.enabled, resourceId: doc.resourceId, revisionId: doc.revisionId, convert: danmakuSettings.settings.convert });
  const [danmakuOpen, setDanmakuOpen] = useState(false);
  useEffect(() => { if (danmakuOn && tab.focused) setDanmakuSources(sourcesOf(danmaku.items)); }, [danmakuOn, tab.focused, danmaku.items]);
  const danmakuCanvas = useRef<(() => DanmakuCapture | null) | null>(null);
  const danmakuShown = useMemo(() => shownCount(danmaku.items, danmakuSettings.settings), [danmaku.items, danmakuSettings.settings]);
  const toggleDanmaku = useCallback(() => { void danmakuSettings.save({ enabled: !danmakuSettings.settings.enabled }); }, [danmakuSettings]);

  // ---- a screenshot of the frame on screen ----
  const takeScreenshot = useVideoScreenshot({
    screenshots: props.screenshots,
    element,
    resourceId: doc.resourceId,
    revisionId: doc.revisionId,
    originMs,
    audio: doc.audio,
    audioIndex,
    defaultAudioIndex: defaultAudio?.index,
    frame: playback.frame,
    shotSubtitles: settings.shotSubtitles,
    subtitleStyle,
    subtitles,
    danmakuOn,
    danmakuSettings: danmakuSettings.settings,
    danmakuCanvas,
  });

  // Expose screenshot trigger & exact unthrottled clock to right-side capture surfaces (EdgeHandle, Composer, QuickNoteModal).
  const takeScreenshotRef = useRef(takeScreenshot);
  takeScreenshotRef.current = takeScreenshot;
  useEffect(() => {
    if (!props.screenshots) return;
    captureBridge.register({
      kind: "video",
      resourceId: doc.resourceId,
      label: t("screenshot.take"),
      disabled: !ready,
      take: () => takeScreenshotRef.current(),
      getExactVideoMs: () => Math.round(playbackRef.current.currentMs),
    }, tab.tabId);
    return () => captureBridge.unregister(doc.resourceId, tab.tabId);
  }, [props.screenshots, doc.resourceId, ready, tab.tabId, t]);

  // ---- keyboard ----
  // ← and → (or remapped seek keys) step when tapped and hold when held; activeArrow remembers the pressed key for keyup matching.
  const live = useRef({ playback, settings });
  live.current = { playback, settings };
  const activeArrow = useRef<{ side: ArrowSide; code: string; key: string } | null>(null);
  const arrows = useMemo(() => createArrowKeys({
    tap: (side) => { live.current.playback.seekBy(side * live.current.settings.seekStepSeconds * 1000); wakeBar.current(); },
    holdStart: (side) => { if (side > 0) live.current.playback.holdStart(); else live.current.playback.rewindStart(); },
    holdEnd: (side) => { if (side > 0) live.current.playback.holdEnd(); else live.current.playback.rewindEnd(); },
  }), []);
  useEffect(() => () => { activeArrow.current = null; arrows.release(); }, [arrows]);
  // Switching away from this tab releases any held seek key immediately.
  useEffect(() => {
    if (!tab.focused) { activeArrow.current = null; arrows.release(); }
  }, [tab.focused, arrows]);

  const actState = useRef({
    keys, settings, rate, playback, onSettings: props.onSettings, toggleFullscreen,
    volumeOpen, danmakuOpen, more, menuAt, fullscreen, markA, markB, takeScreenshot, danmakuOn, toggleDanmaku,
  });
  actState.current = {
    keys, settings, rate, playback, onSettings: props.onSettings, toggleFullscreen,
    volumeOpen, danmakuOpen, more, menuAt, fullscreen, markA, markB, takeScreenshot, danmakuOn, toggleDanmaku,
  };

  // Stable key action handler (reads volatile playback/UI state via ref so 10 Hz clock updates never re-bind window.keydown).
  const act = useCallback((event: KeyboardEvent) => {
    const s = actState.current;
    const action = videoKeyAction(event, s.keys);
    if (!action) return false;
    switch (action.type) {
      case "toggle": s.playback.toggle(); break;
      case "arrow":
        activeArrow.current = { side: action.side, code: event.code, key: event.key };
        arrows.down(action.side, event.repeat);
        break;
      case "volume": s.onSettings({ volume: stepVolume(s.settings.muted ? 0 : s.settings.volume, action.delta), muted: false }); break;
      case "frame": void s.playback.stepFrame(action.delta); break;
      case "mute": s.onSettings({ muted: !s.settings.muted }); break;
      case "fullscreen": s.toggleFullscreen(); break;
      case "markA": setMarkA(s.playback.currentMs); break;
      case "markB": setMarkB(s.playback.currentMs); break;
      case "rate": s.onSettings({ rate: stepRate(s.rate, action.direction, s.settings.rates) }); break;
      case "customRate": s.onSettings({ rate: s.rate === 1 ? clampRate(s.settings.customRate) : 1 }); break;
      case "start": s.playback.seekTo(0); break;
      case "time": setTimeAsk((count) => count + 1); break;
      case "screenshot": void s.takeScreenshot(); break;
      case "danmaku": if (s.danmakuOn) s.toggleDanmaku(); break;
      case "escape":
        if (s.volumeOpen) setVolumeOpen(false);
        else if (s.danmakuOpen) setDanmakuOpen(false);
        else if (s.more) setMore(false);
        else if (s.menuAt) setMenuAt(null);
        else if (s.fullscreen) s.toggleFullscreen();
        else if (s.markA !== null || s.markB !== null) { setMarkA(null); setMarkB(null); }
        else return false;
        break;
    }
    return true;
  }, [arrows]);

  // Put on in the commit that makes the tab the focused one, so that a key pressed at once is not lost.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isImeEvent(event)) return;
      const node = event.target;
      // A range slider is a control of this player: its arrow keys are the player's. Text fields keep their own keys.
      const slider = node instanceof HTMLInputElement && node.type === "range";
      if (isTypingTarget(node) && !slider) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (node instanceof HTMLElement && (node.closest("[role='dialog']") || node.closest("[role='menu']"))) return;
      if (event.defaultPrevented) return;
      if (act(event)) event.preventDefault();
    };
    // Only the focused tab answers the keys (A-94).
    if (!tab.focused) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, tab.focused]);
  // Letting go of a seek key ends a step or a hold wherever the focus is (works for remapped keys too); blur releases any hold.
  useEffect(() => {
    const onUp = (event: KeyboardEvent) => {
      const action = videoKeyAction(event, keysRef.current);
      if (action?.type === "arrow") {
        if (activeArrow.current?.side === action.side) activeArrow.current = null;
        arrows.up(action.side);
        return;
      }
      const heldArrow = activeArrow.current;
      if (heldArrow && ((heldArrow.code && event.code === heldArrow.code) || event.key === heldArrow.key)) {
        activeArrow.current = null;
        arrows.up(heldArrow.side);
      }
    };
    const onBlur = () => { activeArrow.current = null; arrows.release(); };
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keyup", onUp); window.removeEventListener("blur", onBlur); };
  }, [arrows]);

  // ---- right button: the menu (the temporary rate is a held → key, not the mouse) ----
  useEffect(() => {
    if (!menuAt) return;
    const close = () => setMenuAt(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuAt]);

  // ---- typed times and rates ----
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
  const frameNow = playback.frame.status === "ready" && Number.isFinite(playback.frame.frame) ? displayFrame(playback.frame.frame) : null;
  const intervalStart = interval?.startMs;
  const intervalEnd = interval?.endMs;
  // Throttle context broadcasts to 1 Hz during continuous playback while keeping exact ms when paused.
  const contextPositionMs = playback.playing ? Math.floor(playback.currentMs / 1000) * 1000 : Math.round(playback.currentMs);
  useEffect(() => {
    readerContext.set({
      kind: "video", resourceId: doc.resourceId, revisionId: doc.revisionId, title: doc.episodeLabel ? `${doc.title} ${doc.episodeLabel}` : doc.title, workId: doc.workId ?? null,
      positionMs: contextPositionMs, durationMs: doc.durationMs, frame: frameNow,
      interval: intervalStart !== undefined && intervalEnd !== undefined ? { startMs: intervalStart, endMs: intervalEnd } : null,
    }, tab.tabId);
  }, [contextPositionMs, frameNow, intervalStart, intervalEnd, doc.resourceId, doc.revisionId, doc.title, doc.episodeLabel, doc.durationMs, doc.workId, tab.tabId]);
  useEffect(() => () => { readerContext.clear(doc.resourceId, tab.tabId); quoteTags.clearFor(doc.resourceId); }, [doc.resourceId, tab.tabId]);

  // A marked stretch (A-B) is a quote tag for the right pane; the player only reads. Removing the tag there clears the marks here.
  const tags = useQuoteTags(doc.resourceId);
  const intervalTagged = tags.some((tag) => tag.kind === "interval");
  const tagged = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (intervalStart !== undefined && intervalEnd !== undefined) {
      tagged.current = true;
      quoteTags.put({
        kind: "interval", resourceId: doc.resourceId, revisionId: doc.revisionId, startMs: Math.round(intervalStart), endMs: Math.round(intervalEnd),
        label: tRef.current("chat.tag.interval", { start: formatClock(intervalStart), end: formatClock(intervalEnd) }),
      });
    } else if (tagged.current) {
      tagged.current = false;
      quoteTags.removeKind("interval", doc.resourceId);
    }
  }, [intervalStart, intervalEnd, doc.resourceId, doc.revisionId]);
  useEffect(() => {
    if (tagged.current && !intervalTagged) { tagged.current = false; setMarkA(null); setMarkB(null); }
  }, [intervalTagged]);

  const frameText = playback.playing ? "" : frameNow !== null && playback.frame.status === "ready"
    ? t("video.frameOf", { frame: frameNow, total: playback.frame.totalFrames })
    : playback.frame.status === "loading" ? t("video.frameLoading") : playback.frame.status === "absent" ? t("video.frameOnDemand") : playback.frame.status === "unavailable" ? t("video.frameUnavailable") : "";

  const copyBadge = source.state.phase === "ready" && source.state.via === "play_copy";
  const alternateAudio = audioIndex !== undefined && audioIndex !== defaultAudio?.index;
  const showPlayButton = ready && playback.ready && !playback.playing && !playback.ended;

  const quickNoteKey = keys["global.quickNote"]?.[0] ? chordLabel(keys["global.quickNote"]![0]!) : "N";
  const shotKey = keys["video.screenshot"]?.[0] ? chordLabel(keys["video.screenshot"]![0]!) : "S";
  const buildIntervalTag = (range: TimeRange): QuoteTag => ({
    id: `interval:${doc.resourceId}`,
    kind: "interval",
    resourceId: doc.resourceId,
    revisionId: doc.revisionId,
    startMs: Math.round(range.startMs),
    endMs: Math.round(range.endMs),
    label: t("chat.tag.interval", { start: formatClock(range.startMs), end: formatClock(range.endMs) }),
  });

  const openNoteFromVideo = () => {
    if (!captureActions) return;
    if (interval) {
      captureActions.openQuickNote({ tag: buildIntervalTag(interval) });
      return;
    }
    const atMs = Math.max(0, Math.round(playbackRef.current.currentMs));
    captureActions.openQuickNote({
      anchor: { resourceId: doc.resourceId, resourceRevisionId: doc.revisionId, quoteText: formatClock(atMs), locator: { kind: "temporal", startMs: atMs } },
      anchorLabel: formatClock(atMs),
    });
  };

  const openContextMenu = (clientX: number, clientY: number) => {
    const menuWidth = 200;
    const extraItems = 2 + (props.screenshots ? 1 : 0) + (captureActions?.voiceEnabled ? 1 : 0);
    const menuHeight = Math.min(460, (settings.rates.length + extraItems) * 34 + 24);
    const maxX = Math.max(8, (window.innerWidth || 1280) - menuWidth - 8);
    const maxY = Math.max(8, (window.innerHeight || 720) - menuHeight - 8);
    setMenuAt({ x: Math.max(8, Math.min(clientX, maxX)), y: Math.max(8, Math.min(clientY, maxY)) });
  };

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
          onContextMenu={(event) => { event.preventDefault(); if (ready) openContextMenu(event.clientX, event.clientY); }}
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
          {interval ? (
            <SelectionBubble
              kind="video"
              inline
              label={t("capture.bubble")}
              badge={t("chat.tag.interval", { start: formatClock(interval.startMs), end: formatClock(interval.endMs) })}
              actions={[
                {
                  id: "note",
                  testId: "selection-bubble-note",
                  label: t("capture.note"),
                  icon: <NotebookPen size={14} aria-hidden="true" />,
                  accent: true,
                  onClick: () => captureActions?.openQuickNote({ tag: buildIntervalTag(interval) }),
                },
                {
                  id: "ask",
                  testId: "selection-bubble-ask",
                  label: t("capture.askAgent"),
                  icon: <Sparkles size={14} aria-hidden="true" />,
                  onClick: () => captureActions?.askAgentWithTag(buildIntervalTag(interval)),
                },
                {
                  id: "clear",
                  testId: "selection-bubble-clear",
                  label: t("capture.clearInterval"),
                  icon: <X size={14} aria-hidden="true" />,
                  onClick: () => { setMarkA(null); setMarkB(null); quoteTags.removeKind("interval", doc.resourceId); },
                },
              ]}
              extra={props.tools && !more ? props.tools({ currentMs: playback.currentMs, durationMs: duration, interval }) : null}
            />
          ) : null}
          {menuAt ? (
            <div ref={showOnTopLayer} popover="manual" className="video-context" role="menu" aria-label={t("video.menu")} data-testid="video-context" style={{ left: menuAt.x, top: menuAt.y, right: "auto", bottom: "auto" }} onMouseDown={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
              <button type="button" role="menuitem" data-testid="video-context-note" onClick={() => { setMenuAt(null); openNoteFromVideo(); }}>{t("capture.noteHereKey", { key: quickNoteKey })}</button>
              {captureActions?.voiceEnabled ? (
                <button type="button" role="menuitem" data-testid="video-context-record" onClick={() => { setMenuAt(null); captureActions.toggleRecording(); }}>
                  {captureActions.recordingActive
                    ? t("capture.recordStopKey", { key: captureActions.recordingToggleKey })
                    : t("capture.recordStartKey", { key: captureActions.recordingToggleKey })}
                </button>
              ) : null}
              {props.screenshots ? (
                <button type="button" role="menuitem" data-testid="video-context-screenshot" disabled={!ready} onClick={() => { setMenuAt(null); void takeScreenshot(); }}>{t("capture.shotKey", { key: shotKey })}</button>
              ) : null}
              <div className="context-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => { setMenuAt(null); playback.toggle(); }}>{playback.playing ? t("video.pause") : t("video.play")}</button>
              {settings.rates.map((preset) => (
                <button key={preset} type="button" role="menuitemradio" aria-checked={preset === rate} onClick={() => { setMenuAt(null); props.onSettings({ rate: preset }); }}>{t("video.rateValue", { rate: preset })}</button>
              ))}
            </div>
          ) : null}
        </div>

        <div
          ref={controls}
          className="video-controls"
          data-testid="video-controls"
          role="toolbar"
          aria-label={t("video.controls")}
          data-compact={compact || undefined}
          {...controlsHide.bind}
        >
          <SeekBar t={t} currentMs={playback.currentMs} durationMs={duration} bufferedMs={playback.bufferedMs} markers={markers} disabled={!ready} onSeek={playback.seekTo} />
          <div className="video-row">
            <button type="button" className="icon-button" data-testid="video-toggle" aria-label={playback.playing ? t("video.pause") : t("video.play")} title={playback.playing ? t("video.pause") : t("video.play")} disabled={!ready} onClick={playback.toggle}>{playback.playing ? <Pause size={18} /> : <Play size={18} />}</button>
            <VideoTime t={t} currentMs={playback.currentMs} durationMs={duration} playing={playback.playing} disabled={!ready} openAsk={timeAsk} onGo={goTime} />
            {copyBadge ? <span className="chip" data-testid="video-copy-badge">{t("video.copyBadge")}</span> : null}
            <span
              className="video-frame"
              data-testid="video-frame"
              data-frame={frameNow ?? undefined}
              data-verified={playback.frameVerified === null ? undefined : String(playback.frameVerified)}
              title={playback.frame.status === "unavailable" ? playback.frame.message : playback.frame.status === "ready" && playback.frame.variableFrameRate ? t("video.frameVfr") : undefined}
            >{frameText}</span>
            <span className="flex-1" />
            {compact ? null : menus}
            {danmakuOn ? (
              <DanmakuControl t={t} view={danmaku} settings={danmakuSettings.settings} shown={danmakuShown} open={danmakuOpen} active={tab.visible} onOpen={setDanmakuOpen} onToggle={toggleDanmaku} onOpenSettings={props.onDanmakuSettings} />
            ) : null}
            <VolumeControl t={t} volume={settings.volume} muted={settings.muted} open={volumeOpen} onOpen={setVolumeOpen} onChange={(patch) => props.onSettings(patch)} />
            <button type="button" className="icon-button" data-testid="video-window-fullscreen" aria-pressed={windowFull.active} aria-label={windowFull.active ? t("window.fullscreen.exit") : t("window.fullscreen")} title={windowFull.active ? t("window.fullscreen.exit") : t("window.fullscreen")} onClick={windowFull.toggle}>{windowFull.active ? <Shrink size={18} /> : <Fullscreen size={18} />}</button>
            <button type="button" className="icon-button" data-testid="video-fullscreen" aria-label={fullscreen ? t("video.exitFullscreen") : t("video.fullscreen")} title={fullscreen ? t("video.exitFullscreen") : t("video.fullscreen")} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
            <button ref={moreAnchor} type="button" className="icon-button" data-testid="video-more" aria-expanded={more} aria-label={t("video.more")} title={t("video.more")} onClick={() => setMore((open) => !open)}><MoreHorizontal size={18} /></button>
          </div>

          {more ? (
            <VideoMorePopup
              t={t}
              anchor={moreAnchor}
              ready={ready}
              compact={compact}
              menus={menus}
              seekStepSeconds={settings.seekStepSeconds}
              currentMs={playback.currentMs}
              durationMs={duration}
              markA={markA}
              markB={markB}
              interval={interval}
              tools={props.tools}
              onMatch={props.onMatch}
              onSeekBy={(deltaMs) => playback.seekBy(deltaMs)}
              onStepFrame={(delta) => void playback.stepFrame(delta)}
              onMarkA={() => setMarkA(playback.currentMs)}
              onMarkB={() => setMarkB(playback.currentMs)}
              onClearMarks={() => { setMarkA(null); setMarkB(null); }}
              onClose={() => setMore(false)}
            />
          ) : null}
          {inputError ? <p className="video-input-error" role="alert" data-testid="video-input-error">{inputError}</p> : null}
        </div>
      </div>
    </section>
  );
}
