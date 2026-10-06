import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Captions, ChevronLeft, ChevronRight, Gauge, Languages, ListVideo, Maximize2, Minimize2, MoreHorizontal, Pause, Play, Repeat, SkipForward, StepBack, StepForward, Volume2, VolumeX } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { Menu, type MenuItem } from "../components/menu.tsx";
import type { SourceCard } from "../lib/types.ts";
import { readerContext } from "../lib/reader-context.ts";
import { quoteTags, useQuoteTags } from "../lib/quote-tags.ts";
import { SourceBanner } from "./source-banner.tsx";
import { isTypingTarget, useFullscreen } from "./use-fullscreen.ts";
import { useSubtitles } from "./use-subtitles.ts";
import { useVideoCapture } from "./use-video-capture.ts";
import { useVideoPlayback, type ProgressReport } from "./use-video-playback.ts";
import { useVideoSource } from "./use-video-source.ts";
import {
  clampRate, displayFrame, DUCK_FACTOR, formatClock, formatClockPrecise, HOLD_MS, intervalOf, parseClock, parseFrameInput, parseRate, RATE_PRESETS, SHORTCUTS, stepRate, videoKeyAction,
  type TimeRange,
} from "./video-model.ts";
import { SeekBar, type SeekMarker } from "./video-seekbar.tsx";
import { VideoStatus } from "./video-status.tsx";

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

export type VideoSettings = { rate: number; holdRate: number; volume: number; muted: boolean; seekStepSeconds: number; autoNext: boolean };

/** Where a note's source points. `play` plays the interval and stops at its end; otherwise the player waits at the start. */
export type VideoFocus = { startMs: number; endMs?: number; play?: boolean; nonce: number };

const IDLE_MS = 2500;

export function VideoPlayer(props: {
  t: T;
  doc: VideoDoc;
  settings: VideoSettings;
  onSettings: (patch: Partial<VideoSettings>) => void;
  startMs?: number;
  focus?: VideoFocus | null;
  sourceCard?: SourceCard | null;
  next?: { resourceId: string; title: string } | null;
  /** Recorded intervals of this video, drawn on the timeline as places to jump to. */
  markers?: Array<TimeRange & { id: string; label?: string }>;
  /** A recording is running: the picture may be made quieter or paused so the user's voice is clear, then restored. */
  duck?: { active: boolean; mode: "none" | "lower" | "pause" };
  onBack: () => void;
  onNext: () => void;
  onEpisode: (resourceId: string) => void;
  onProgress: (report: ProgressReport) => void;
  onBackToNote: () => void;
  onRepair: () => void;
}) {
  const { t, doc, settings } = props;
  const target = useMemo(() => ({ resourceId: doc.resourceId, revisionId: doc.revisionId }), [doc.resourceId, doc.revisionId]);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const { fullscreen, toggle: toggleFullscreen } = useFullscreen(shell);
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
    startMs: props.focus?.startMs ?? props.startMs ?? 0,
    settings,
    volumeFactor: props.duck?.active && props.duck.mode === "lower" ? DUCK_FACTOR : 1,
    durationHintMs: doc.durationMs,
    originMs,
    onProgress: props.onProgress,
    onEnded: () => { if (settings.autoNext && props.next) props.onNext(); },
    onMediaError: source.reportMediaError,
  });
  useVideoCapture(element, target, playback.ready, originMs);
  // While a recording runs with "pause" chosen, a playing video waits and carries on when the recording ends.
  const pausedForRecording = useRef(false);
  const ducking = props.duck?.active === true && props.duck.mode === "pause";
  useEffect(() => {
    if (ducking && playback.playing) { pausedForRecording.current = true; playback.pause(); }
    if (!ducking && pausedForRecording.current) { pausedForRecording.current = false; void playback.play(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ducking]);
  const subtitles = useSubtitles({ target, video: element, ready: ready && playback.ready, sourceKey: url ?? "", originMs });

  const [markA, setMarkA] = useState<number | null>(null);
  const [markB, setMarkB] = useState<number | null>(null);
  const interval = intervalOf(markA, markB);
  const [help, setHelp] = useState(false);
  const [more, setMore] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [idle, setIdle] = useState(false);
  const [timeText, setTimeText] = useState("");
  const [frameText, setFrameText] = useState("");
  const [rateText, setRateText] = useState("");
  const [inputError, setInputError] = useState("");

  const duration = playback.durationMs > 0 ? playback.durationMs : doc.durationMs;
  const rate = clampRate(settings.rate);
  const effectiveRate = playback.holding ? clampRate(settings.holdRate) : rate;

  // ---- a note's source: go there (and play it when asked) ----
  const applied = useRef(0);
  const focus = props.focus ?? null;
  useEffect(() => {
    if (!focus || !playback.ready || applied.current === focus.nonce) return;
    applied.current = focus.nonce;
    if (focus.play && focus.endMs !== undefined) playback.playRange(focus.startMs, focus.endMs);
    else playback.seekTo(focus.startMs);
  }, [focus, playback.ready, playback]);

  // ---- keyboard ----
  const act = useCallback((event: KeyboardEvent) => {
    const action = videoKeyAction(event, settings.seekStepSeconds);
    if (!action) return false;
    switch (action.type) {
      case "toggle": playback.toggle(); break;
      case "seek": playback.seekBy(action.deltaMs); break;
      case "volume": props.onSettings({ volume: Math.min(1, Math.max(0, Math.round((settings.volume + action.delta) * 100) / 100)), muted: false }); break;
      case "frame": void playback.stepFrame(action.delta); break;
      case "mute": props.onSettings({ muted: !settings.muted }); break;
      case "fullscreen": toggleFullscreen(); break;
      case "markA": setMarkA(playback.currentMs); break;
      case "markB": setMarkB(playback.currentMs); break;
      case "rate": props.onSettings({ rate: stepRate(rate, action.direction) }); break;
      case "start": playback.seekTo(0); break;
      case "escape":
        if (menuAt) setMenuAt(null);
        else if (fullscreen) toggleFullscreen();
        else if (markA !== null || markB !== null) { setMarkA(null); setMarkB(null); }
        else return false;
        break;
    }
    return true;
  }, [settings.seekStepSeconds, settings.volume, settings.muted, rate, playback, props, toggleFullscreen, menuAt, fullscreen, markA, markB]);

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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  // ---- controls fade in full screen while a video plays ----
  useEffect(() => {
    if (!fullscreen || !playback.playing) { setIdle(false); return; }
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => { setIdle(false); window.clearTimeout(timer); timer = window.setTimeout(() => setIdle(true), IDLE_MS); };
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => { window.clearTimeout(timer); window.removeEventListener("pointermove", wake); window.removeEventListener("keydown", wake); };
  }, [fullscreen, playback.playing]);

  // ---- right button: held, the video plays at the temporary rate; pressed and released at once, a menu ----
  const hold = useRef<{ timer: number; active: boolean } | null>(null);
  const endHold = useCallback((event?: { clientX: number; clientY: number }) => {
    const current = hold.current;
    if (!current) return;
    hold.current = null;
    window.clearTimeout(current.timer);
    if (current.active) playback.holdEnd();
    else if (event) setMenuAt({ x: event.clientX, y: event.clientY });
  }, [playback]);
  const onStagePointerDown = (event: React.PointerEvent) => {
    if (event.button !== 2 || !ready || hold.current) return;
    const state = { timer: 0, active: false };
    state.timer = window.setTimeout(() => { state.active = true; playback.holdStart(); }, HOLD_MS);
    hold.current = state;
    const release = (up: PointerEvent) => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", cancel); endHold(up); };
    const cancel = () => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", cancel); endHold(); };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", cancel);
  };
  useEffect(() => () => { if (hold.current) window.clearTimeout(hold.current.timer); }, []);
  useEffect(() => {
    if (!menuAt) return;
    const close = () => setMenuAt(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuAt]);

  // ---- typed times, frames and rates ----
  const goTime = () => {
    const ms = parseClock(timeText);
    if (ms === null) { setInputError(t("video.timeInvalid")); return; }
    setInputError("");
    playback.seekTo(ms);
    setTimeText("");
  };
  const totalFrames = playback.frame.status === "ready" ? playback.frame.totalFrames : 0;
  const goFrame = () => {
    const index = parseFrameInput(frameText, totalFrames);
    if (index === null) { setInputError(t("video.frameInvalid", { total: totalFrames || "?" })); return; }
    setInputError("");
    void playback.gotoFrame(index);
    setFrameText("");
  };
  const goRate = () => {
    const value = parseRate(rateText);
    if (value === null) { setInputError(t("video.rateInvalid")); return; }
    setInputError("");
    props.onSettings({ rate: value });
    setRateText("");
  };

  // ---- menus ----
  const rateItems: MenuItem[] = RATE_PRESETS.map((preset) => ({ id: String(preset).replace(".", "_"), label: t("video.rateValue", { rate: preset }), checked: preset === rate, onSelect: () => props.onSettings({ rate: preset }) }));
  const trackName = (track: { language: string | null; title: string | null }, index: number) => {
    const text = [track.language, track.title].filter(Boolean).join(" ").trim();
    return text || t("video.trackPlain", { index });
  };
  const subtitleItems: MenuItem[] = [
    { id: "off", label: t("video.subtitleOff"), checked: subtitles.selectedId === null, onSelect: () => subtitles.select(null) },
    ...subtitles.tracks.map((track, index) => ({ id: track.id, label: trackName(track, index + 1), checked: subtitles.selectedId === track.id, disabled: track.format === null, onSelect: () => subtitles.select(track.id) })),
  ];
  const defaultAudio = doc.audio.find((track) => track.default) ?? doc.audio[0];
  const audioItems: MenuItem[] = doc.audio.map((track, position) => ({
    id: String(track.index),
    label: t("video.track", { language: track.language ?? "", title: track.title ?? t("video.audioTrack", { index: position + 1 }) }).trim(),
    checked: (audioIndex ?? defaultAudio?.index) === track.index,
    onSelect: () => setAudioIndex(track.index === defaultAudio?.index ? undefined : track.index),
  }));
  const episodeItems: MenuItem[] = doc.episodes.map((episode) => ({ id: episode.resourceId, label: episode.label, checked: episode.resourceId === doc.resourceId, disabled: !episode.available, onSelect: () => props.onEpisode(episode.resourceId) }));

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
    });
  }, [playback.currentMs, frameNow, intervalStart, intervalEnd, doc.resourceId, doc.revisionId, doc.title, doc.episodeLabel, doc.durationMs, doc.workId]);
  useEffect(() => () => { readerContext.clear(doc.resourceId); quoteTags.clearFor(doc.resourceId); }, [doc.resourceId]);

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
    : playback.frame.status === "loading" ? t("video.frameLoading") : playback.frame.status === "unavailable" ? t("video.frameUnavailable") : "";

  const copyBadge = source.state.phase === "ready" && source.state.via === "play_copy";
  const alternateAudio = audioIndex !== undefined && audioIndex !== defaultAudio?.index;
  const showPlayButton = ready && playback.ready && !playback.playing && !playback.ended;

  return (
    <section className="reader video-reader" data-testid="video-reader" data-ready={playback.ready || undefined} data-fullscreen={fullscreen || undefined}>
      <header className="reader-top">
        <button type="button" className="icon-button" data-testid="video-back" aria-label={t("common.back")} title={t("common.back")} onClick={props.onBack}><ArrowLeft size={18} /></button>
        <div className="reader-heading">
          <h1 className="truncate" data-testid="video-title">{doc.title}</h1>
          <span className="chip">{t("shelf.kind.video")}</span>
          {doc.episodeLabel ? <span className="reader-chapter" data-testid="video-episode">{doc.episodeLabel}</span> : null}
          {copyBadge ? <span className="chip" data-testid="video-copy-badge">{t("video.copyBadge")}</span> : null}
        </div>
        <span className="flex-1" />
      </header>

      {props.sourceCard ? <SourceBanner t={t} card={props.sourceCard} testPrefix="video" onBackToNote={props.onBackToNote} onRepair={props.onRepair} /> : null}

      <div ref={shell} className="video-shell" data-testid="video-shell" data-idle={idle || undefined}>
        <div
          className="video-stage"
          data-testid="video-stage"
          role="group"
          aria-label={t("video.stage")}
          onClick={() => { if (ready) playback.toggle(); }}
          onDoubleClick={toggleFullscreen}
          onPointerDown={onStagePointerDown}
          onContextMenu={(event) => event.preventDefault()}
        >
          <video
            ref={setElement}
            className="video-element"
            data-testid="video-element"
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
          {showPlayButton ? (
            <button type="button" className="video-big-play" data-testid="video-big-play" aria-label={t("video.playBig")} onClick={(event) => { event.stopPropagation(); playback.toggle(); }}><Play size={34} /></button>
          ) : null}
          {playback.holding ? <span className="video-holding" role="status" data-testid="video-holding">{t("video.holding", { rate: effectiveRate })}</span> : null}
          {subtitles.status === "failed" ? <span className="video-subtitle-notice" role="status" data-testid="video-subtitle-notice">{t("video.subtitleFailed", { reason: subtitles.message })}</span> : null}
          {playback.ended && !(settings.autoNext && props.next) ? (
            <div className="video-end" role="status" data-testid="video-end" onClick={(event) => event.stopPropagation()}>
              <strong>{t("video.ended")}</strong>
              <button type="button" className="secondary-button" data-testid="video-replay" onClick={() => { playback.seekTo(0); void playback.play(); }}><Repeat size={14} />{t("video.replay")}</button>
              {props.next ? <button type="button" className="primary-button" data-testid="video-end-next" onClick={props.onNext}><SkipForward size={14} />{t("video.next", { title: props.next.title })}</button> : null}
            </div>
          ) : null}
          {menuAt ? (
            <div className="video-context" role="menu" aria-label={t("video.menu")} data-testid="video-context" style={{ left: menuAt.x, top: menuAt.y }} onMouseDown={(event) => event.stopPropagation()}>
              <button type="button" role="menuitem" onClick={() => { setMenuAt(null); playback.toggle(); }}>{playback.playing ? t("video.pause") : t("video.play")}</button>
              {RATE_PRESETS.map((preset) => (
                <button key={preset} type="button" role="menuitemradio" aria-checked={preset === rate} onClick={() => { setMenuAt(null); props.onSettings({ rate: preset }); }}>{t("video.rateValue", { rate: preset })}</button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="video-controls" data-testid="video-controls" role="toolbar" aria-label={t("video.controls")}>
          <SeekBar t={t} currentMs={playback.currentMs} durationMs={duration} bufferedMs={playback.bufferedMs} markers={markers} disabled={!ready} onSeek={playback.seekTo} />
          <div className="video-row">
            <button type="button" className="icon-button" data-testid="video-toggle" aria-label={playback.playing ? t("video.pause") : t("video.play")} title={playback.playing ? t("video.pause") : t("video.play")} disabled={!ready} onClick={playback.toggle}>{playback.playing ? <Pause size={18} /> : <Play size={18} />}</button>
            <span className="video-time" data-testid="video-time" aria-live="off" title={formatClockPrecise(playback.currentMs)}>{t("video.time", { current: formatClock(playback.currentMs), total: formatClock(duration) })}</span>
            <span
              className="video-frame"
              data-testid="video-frame"
              data-frame={playback.frame.status === "ready" ? displayFrame(playback.frame.frame) : undefined}
              data-verified={playback.frameVerified === null ? undefined : String(playback.frameVerified)}
              title={playback.frame.status === "unavailable" ? playback.frame.message : playback.frame.status === "ready" && playback.frame.variableFrameRate ? t("video.frameVfr") : undefined}
            >{frameText2}</span>
            <span className="flex-1" />
            <Menu label={t("video.rate")} testId="video-rate" className="video-menu" items={rateItems} trigger={<><Gauge size={16} /><span>{t("video.rateValue", { rate: effectiveRate })}</span></>} />
            <button type="button" className="icon-button" data-testid="video-mute" aria-label={settings.muted ? t("video.unmute") : t("video.mute")} title={settings.muted ? t("video.unmute") : t("video.mute")} aria-pressed={settings.muted} onClick={() => props.onSettings({ muted: !settings.muted })}>{settings.muted || settings.volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
            <input type="range" className="video-volume" data-testid="video-volume" aria-label={t("video.volume")} min={0} max={1} step={0.05} value={settings.muted ? 0 : settings.volume} onChange={(event) => props.onSettings({ volume: Number(event.target.value), muted: false })} />
            {props.next ? <button type="button" className="icon-button" data-testid="video-next" aria-label={t("video.next", { title: props.next.title })} title={t("video.next", { title: props.next.title })} onClick={props.onNext}><SkipForward size={18} /></button> : null}
            <button type="button" className="icon-button" data-testid="video-fullscreen" aria-label={fullscreen ? t("video.exitFullscreen") : t("video.fullscreen")} title={fullscreen ? t("video.exitFullscreen") : t("video.fullscreen")} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
            <button type="button" className="icon-button" data-testid="video-more" aria-expanded={more} aria-label={t("video.more")} title={t("video.more")} onClick={() => setMore((open) => !open)}><MoreHorizontal size={18} /></button>
          </div>

          {more ? (
            <div className="video-more-panel" data-testid="video-more-panel">
              <div className="video-row">
                <button type="button" className="icon-button" data-testid="video-step-back" aria-label={t("video.back", { seconds: settings.seekStepSeconds })} title={t("video.back", { seconds: settings.seekStepSeconds })} disabled={!ready} onClick={() => playback.seekBy(-settings.seekStepSeconds * 1000)}><ChevronLeft size={18} /></button>
                <button type="button" className="icon-button" data-testid="video-step-forward" aria-label={t("video.forward", { seconds: settings.seekStepSeconds })} title={t("video.forward", { seconds: settings.seekStepSeconds })} disabled={!ready} onClick={() => playback.seekBy(settings.seekStepSeconds * 1000)}><ChevronRight size={18} /></button>
                <button type="button" className="icon-button" data-testid="video-prev-frame" aria-label={t("video.prevFrame")} title={`${t("video.prevFrame")} ,`} disabled={!ready} onClick={() => void playback.stepFrame(-1)}><StepBack size={16} /></button>
                <button type="button" className="icon-button" data-testid="video-next-frame" aria-label={t("video.nextFrame")} title={`${t("video.nextFrame")} .`} disabled={!ready} onClick={() => void playback.stepFrame(1)}><StepForward size={16} /></button>
                <Menu label={t("video.subtitles")} testId="video-subtitles" className="video-menu" align="end" items={subtitleItems} trigger={<Captions size={18} />} />
                {doc.audio.length > 1 ? <Menu label={t("video.audio")} testId="video-audio" className="video-menu" align="end" items={audioItems} trigger={<Languages size={18} />} /> : null}
                {doc.episodes.length > 1 ? <Menu label={t("video.episodes")} testId="video-episodes" className="video-menu" align="end" items={episodeItems} trigger={<ListVideo size={18} />} /> : null}
              </div>
              <div className="video-row video-tools">
                <button type="button" className="secondary-button" data-testid="video-mark-a" aria-pressed={markA !== null} onClick={() => setMarkA(playback.currentMs)}>{t("video.markA")}{markA !== null ? ` ${formatClock(markA)}` : ""}</button>
                <button type="button" className="secondary-button" data-testid="video-mark-b" aria-pressed={markB !== null} onClick={() => setMarkB(playback.currentMs)}>{t("video.markB")}{markB !== null ? ` ${formatClock(markB)}` : ""}</button>
                {interval ? <span className="video-interval" data-testid="video-interval">{t("video.interval", { start: formatClock(interval.startMs), end: formatClock(interval.endMs) })}</span> : null}
                {markA !== null || markB !== null ? <button type="button" className="link-button" data-testid="video-clear-marks" onClick={() => { setMarkA(null); setMarkB(null); }}>{t("video.clearMarks")}</button> : null}
              </div>
              <div className="video-row video-tools">
                <label className="video-field">{t("video.timeInput")}
                  <input type="text" inputMode="decimal" data-testid="video-time-input" value={timeText} placeholder="0:00" onChange={(event) => setTimeText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); goTime(); } }} />
                </label>
                <button type="button" className="secondary-button" data-testid="video-time-go" disabled={!timeText.trim()} onClick={goTime}>{t("video.go")}</button>
                <label className="video-field">{t("video.frameInput")}
                  <input type="text" inputMode="numeric" data-testid="video-frame-input" value={frameText} onChange={(event) => setFrameText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); goFrame(); } }} />
                </label>
                <button type="button" className="secondary-button" data-testid="video-frame-go" disabled={!frameText.trim()} onClick={goFrame}>{t("video.go")}</button>
                <label className="video-field">{t("video.rateCustom")}
                  <input type="text" inputMode="decimal" data-testid="video-rate-input" value={rateText} placeholder="1.75" onChange={(event) => setRateText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); goRate(); } }} />
                </label>
                <button type="button" className="link-button" data-testid="video-shortcuts" aria-expanded={help} onClick={() => setHelp((current) => !current)}>{t("video.shortcuts")}</button>
              </div>
            </div>
          ) : null}
          {inputError ? <p className="video-input-error" role="alert" data-testid="video-input-error">{inputError}</p> : null}
          {help ? (
            <div className="video-help" data-testid="video-shortcuts-panel">
              <dl>
                {SHORTCUTS.map((item) => (<div key={item.keys}><dt>{item.keys}</dt><dd>{t(item.label as MessageKey)}</dd></div>))}
              </dl>
              <p>{t("video.holdHint")}</p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
