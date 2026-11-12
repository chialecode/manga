import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Captions, ChevronLeft, ChevronRight, Fullscreen, Gauge, Languages, Maximize2, Minimize2, MoreHorizontal, Pause, Play, Repeat, Shrink, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Menu, type MenuGroup, type MenuItem } from "../renderer/components/menu.tsx";
import { popupOpen } from "../renderer/components/popup.tsx";
import { useKeyTable } from "../renderer/lib/key-table.tsx";
import { isTypingTarget, useFullscreen } from "../renderer/readers/use-fullscreen.ts";
import { useWindowFullscreen } from "../renderer/readers/window-fullscreen.tsx";
import { SubtitleLayer } from "../renderer/readers/subtitle-layer.tsx";
import { normalizeStyle } from "../renderer/readers/subtitle-model.ts";
import { useSubtitles } from "../renderer/readers/use-subtitles.ts";
import { useVideoHealth } from "../renderer/readers/use-video-health.ts";
import { useVideoPlayback, type ProgressReport } from "../renderer/readers/use-video-playback.ts";
import { useVideoSource } from "../renderer/readers/use-video-source.ts";
import { clampRate, displayFrame, parseClock, stepRate, videoKeyAction } from "../renderer/readers/video-model.ts";
import { createArrowKeys } from "../renderer/readers/video-keys.ts";
import { SeekBar } from "../renderer/readers/video-seekbar.tsx";
import { VideoStatus } from "../renderer/readers/video-status.tsx";
import { VideoTime } from "../renderer/readers/video-time.tsx";
import { stepVolume, VolumeControl } from "../renderer/readers/video-volume.tsx";
import { FINISHED_WITHIN_MS, lightHost, type LightOpened } from "./light-host.ts";
import { readLightSettings, writeLightSettings } from "./light-settings.ts";

type T = Translator["t"];
type VideoOpened = Extract<LightOpened, { kind: "video" }>;

/** The player's own settings in light open: the full app's defaults, kept in light open's own profile (never the library's settings). */
export type LightVideoSettings = {
  rate: number; rates: number[]; customRate: number; holdRate: number; volume: number; muted: boolean; seekStepSeconds: number;
  subtitlePlacement: "auto" | "inside"; subtitleSizePct: number; subtitleFont: "sans" | "serif" | "kai"; subtitleOutline: boolean; assStyle: "keep" | "standard";
};
export const LIGHT_VIDEO_DEFAULTS: LightVideoSettings = {
  rate: 1, rates: [0.5, 0.75, 1, 1.25, 1.5, 2, 3], customRate: 1.5, holdRate: 2, volume: 1, muted: false, seekStepSeconds: 5,
  subtitlePlacement: "auto", subtitleSizePct: 5, subtitleFont: "sans", subtitleOutline: true, assStyle: "keep",
};

const IDLE_MS = 2500;
const COMPACT_BELOW_PX = 640;

/**
 * Light open's video player (READ-05, 4.4): the full app's player hooks and controls (source, playback, subtitles, the bar, the clock, volume, the
 * keys) in a shell of its own. No danmaku, screenshots, notes, recording, Agent, works or rough cut; "previous" and "next" are the folder's files.
 */
export function LightVideoPlayer(props: { t: T; opened: VideoOpened; resume: unknown; onSibling: (direction: 1 | -1) => void }) {
  const { t, opened } = props;
  const host = lightHost();
  const [settings, setSettings] = useState<LightVideoSettings>(() => readLightSettings("video", LIGHT_VIDEO_DEFAULTS));
  const onSettings = useCallback((patch: Partial<LightVideoSettings>) => {
    setSettings((current) => { const next = { ...current, ...patch }; writeLightSettings("video", next); return next; });
  }, []);
  const target = useMemo(() => ({ resourceId: opened.resourceId, revisionId: opened.revisionId }), [opened.resourceId, opened.revisionId]);
  const startMs = props.resume && typeof props.resume === "object" && "positionMs" in props.resume ? Number((props.resume as { positionMs: number }).positionMs) || 0 : 0;
  const [resumedShown, setResumedShown] = useState(startMs > 0);
  useEffect(() => { if (!resumedShown) return; const timer = window.setTimeout(() => setResumedShown(false), 2500); return () => window.clearTimeout(timer); }, [resumedShown]);

  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const { fullscreen, toggle: toggleFullscreen } = useFullscreen(shell);
  const windowFull = useWindowFullscreen();
  const full = fullscreen || windowFull.active;
  const [audioIndex, setAudioIndex] = useState<number | undefined>(undefined);
  const source = useVideoSource(target, audioIndex);
  const ready = source.state.phase === "ready";
  const url = source.state.phase === "ready" ? source.state.url : null;
  const originMs = source.state.phase === "ready" ? source.state.startMs : 0;

  // Where the person is goes to light open's own memory (positions.json), never to a library.
  const durationRef = useRef(opened.durationMs);
  const onProgress = useCallback((report: ProgressReport) => {
    const durationMs = durationRef.current;
    const finished = report.ended || (durationMs > 0 && report.timeMs >= durationMs - FINISHED_WITHIN_MS);
    void host?.position({ sessionId: opened.sessionId, kind: "video", positionMs: report.timeMs, durationMs, finished });
  }, [host, opened.sessionId]);
  const playback = useVideoPlayback({
    element, target, url, startMs, settings, volumeFactor: 1, durationHintMs: opened.durationMs, originMs,
    onProgress, onEnded: () => undefined, onMediaError: source.reportMediaError,
  });
  durationRef.current = playback.durationMs > 0 ? playback.durationMs : opened.durationMs;
  // A file opened with MANGA plays at once, as a player chosen in "Open with" is expected to; one that was finished starts from the beginning.
  const started = useRef(false);
  useEffect(() => {
    if (!playback.ready || started.current) return;
    started.current = true;
    void playback.play();
  }, [playback.ready, playback]);
  // Asked by the main process before closing the window, switching files, or leaving for an update: hand over the place now and await IPC persistence.
  const live = useRef({ playback, settings, element, originMs });
  live.current = { playback, settings, element, originMs };
  const saveCurrentPosition = useCallback(() => {
    const { playback: now, element: video, originMs: origin } = live.current;
    if (!now.ready || !host) return Promise.resolve();
    const durationMs = durationRef.current;
    const positionMs = Math.round(video ? Math.max(0, video.currentTime * 1000 - origin) : now.currentMs);
    return host.position({
      sessionId: opened.sessionId,
      kind: "video",
      positionMs,
      durationMs,
      finished: now.ended || (durationMs > 0 && positionMs >= durationMs - FINISHED_WITHIN_MS),
    });
  }, [host, opened.sessionId]);
  useEffect(() => host?.onSaveNow(saveCurrentPosition), [host, saveCurrentPosition]);
  // Fallback if the page unloads without a main-process close flush.
  useEffect(() => {
    const leave = () => { void saveCurrentPosition(); };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [saveCurrentPosition]);

  const subtitleStyle = useMemo(() => normalizeStyle({ placement: settings.subtitlePlacement, sizePct: settings.subtitleSizePct, font: settings.subtitleFont, outline: settings.subtitleOutline, assStyle: settings.assStyle }), [settings.subtitlePlacement, settings.subtitleSizePct, settings.subtitleFont, settings.subtitleOutline, settings.assStyle]);
  const subtitles = useSubtitles({ target, video: element, ready: ready && playback.ready, sourceKey: url ?? "", style: subtitleStyle, originMs });
  const picture = useVideoHealth({ element, key: url ?? "", active: ready, playing: playback.playing });
  const [healthHidden, setHealthHidden] = useState(false);
  useEffect(() => { setHealthHidden(false); }, [url]);

  const keys = useKeyTable();
  const [more, setMore] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [inputError, setInputError] = useState("");
  const [timeAsk, setTimeAsk] = useState(0);
  const controls = useRef<HTMLDivElement>(null);
  const [controlsH, setControlsH] = useState(0);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const node = controls.current;
    if (!node) return;
    const measure = () => { setControlsH(node.offsetHeight); setCompact(node.clientWidth > 0 && node.clientWidth < COMPACT_BELOW_PX); };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);
  const lift = full && !idle ? controlsH : 0;
  const duration = playback.durationMs > 0 ? playback.durationMs : opened.durationMs;
  const rate = clampRate(settings.rate);
  const effectiveRate = playback.holding ? clampRate(settings.holdRate) : rate;
  const defaultAudio = opened.audio.find((track) => track.default) ?? opened.audio[0];

  // ---- keyboard: the full app's default table, without the keys of what light open does not have ----
  const wakeBar = useRef<() => void>(() => undefined);
  const arrows = useMemo(() => createArrowKeys({
    tap: (side) => { live.current.playback.seekBy(side * live.current.settings.seekStepSeconds * 1000); wakeBar.current(); },
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
      case "volume": onSettings({ volume: stepVolume(settings.muted ? 0 : settings.volume, action.delta), muted: false }); break;
      case "frame": void playback.stepFrame(action.delta); break;
      case "mute": onSettings({ muted: !settings.muted }); break;
      case "fullscreen": toggleFullscreen(); break;
      case "rate": onSettings({ rate: stepRate(rate, action.direction, settings.rates) }); break;
      case "customRate": onSettings({ rate: rate === 1 ? clampRate(settings.customRate) : 1 }); break;
      case "start": playback.seekTo(0); break;
      case "time": setTimeAsk((count) => count + 1); break;
      case "escape":
        if (volumeOpen) setVolumeOpen(false);
        else if (fullscreen) toggleFullscreen();
        else return false;
        break;
      default: return false;
    }
    return true;
  }, [keys, settings.volume, settings.muted, settings.rates, settings.customRate, rate, playback, arrows, toggleFullscreen, volumeOpen, fullscreen, onSettings]);
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const node = event.target;
      const slider = node instanceof HTMLInputElement && node.type === "range";
      if (isTypingTarget(node) && !slider) return;
      if (node instanceof HTMLElement && (node.closest("[role='dialog']") || node.closest("[role='menu']"))) return;
      if (event.defaultPrevented) return;
      if (act(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);
  useEffect(() => {
    const onUp = (event: KeyboardEvent) => { if (event.key === "ArrowLeft") arrows.up(-1); else if (event.key === "ArrowRight") arrows.up(1); };
    const onBlur = () => arrows.release();
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keyup", onUp); window.removeEventListener("blur", onBlur); };
  }, [arrows]);

  // ---- the bar fades in full screen while the video plays (the full app's rule) ----
  const held = playback.holding || playback.rewinding;
  useEffect(() => {
    if (!full || playback.ended) { setIdle(false); wakeBar.current = () => undefined; return; }
    const resting = !playback.playing && !held;
    let timer = 0;
    const onBar = () => { try { return Boolean(controls.current?.matches(":hover")); } catch { return false; } };
    const arm = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (popupOpen() || onBar()) arm(); else setIdle(true); }, IDLE_MS); };
    const wake = () => { setIdle(false); if (!resting) arm(); };
    if (held) { if (!popupOpen() && !onBar()) setIdle(true); else arm(); } else if (resting) setIdle(false); else arm();
    wakeBar.current = wake;
    window.addEventListener("pointermove", wake);
    return () => { window.clearTimeout(timer); window.removeEventListener("pointermove", wake); };
  }, [full, playback.playing, playback.ended, held]);

  const goTime = (text: string): string | null => {
    const ms = parseClock(text);
    if (ms === null) { setInputError(t("video.timeInvalid")); return t("video.timeInvalid"); }
    setInputError("");
    void playback.gotoTime(ms);
    return null;
  };

  // ---- menus ----
  const rateItems: MenuItem[] = settings.rates.map((preset) => ({ id: String(preset).replace(".", "_"), label: t("video.rateValue", { rate: preset }), checked: preset === rate, onSelect: () => onSettings({ rate: preset }) }));
  const trackName = (track: { language: string | null; title: string | null }, index: number) => [track.language, track.title].filter(Boolean).join(" ").trim() || t("video.trackPlain", { index });
  const subtitleItems: MenuItem[] = [
    { id: "off", label: t("video.subtitleOff"), checked: subtitles.selectedId === null, onSelect: () => subtitles.select(null) },
    ...subtitles.tracks.map((track, index) => ({ id: track.id, label: trackName(track, index + 1), checked: subtitles.selectedId === track.id, disabled: track.format === null, onSelect: () => subtitles.select(track.id) })),
  ];
  const secondaryItems: MenuItem[] = [
    { id: "off", testId: "video-subtitles-secondary-off", label: t("video.subtitleSecondaryOff"), checked: subtitles.secondaryId === null, onSelect: () => subtitles.selectSecondary(null) },
    ...subtitles.tracks.map((track, index) => ({ id: track.id, testId: `video-subtitles-secondary-${track.id}`, label: trackName(track, index + 1), checked: subtitles.secondaryId === track.id, disabled: track.format === null || track.format === "ass" || track.id === subtitles.selectedId, onSelect: () => subtitles.selectSecondary(track.id) })),
  ];
  const canHaveSecondary = subtitles.tracks.length > 1 && subtitles.tracks.some((track) => (track.format === "srt" || track.format === "vtt") && track.id !== subtitles.selectedId);
  const subtitleGroups: MenuGroup[] = [
    { id: "primary", title: t("video.subtitlePrimary"), items: subtitleItems },
    ...(canHaveSecondary || subtitles.secondaryId !== null ? [{ id: "secondary", title: t("video.subtitleSecondary"), items: secondaryItems }] : []),
  ];
  const audioItems: MenuItem[] = opened.audio.map((track, position) => ({
    id: String(track.index),
    label: t("video.track", { language: track.language ?? "", title: track.title ?? t("video.audioTrack", { index: position + 1 }) }).trim(),
    checked: (audioIndex ?? defaultAudio?.index) === track.index,
    onSelect: () => setAudioIndex(track.index === defaultAudio?.index ? undefined : track.index),
  }));
  const menus = (
    <>
      <Menu label={t("video.subtitles")} testId="video-subtitles" className="video-menu" placement="above" align="end" {...(subtitleGroups.length > 1 ? { groups: subtitleGroups } : { items: subtitleItems })} trigger={<Captions size={18} />} />
      {opened.audio.length > 1 ? <Menu label={t("video.audio")} testId="video-audio" className="video-menu" placement="above" align="end" items={audioItems} trigger={<Languages size={18} />} /> : null}
      <Menu label={t("video.rate")} testId="video-rate" className="video-menu" placement="above" align="end" items={rateItems} trigger={<><Gauge size={16} /><span>{t("video.rateValue", { rate: effectiveRate })}</span></>} />
    </>
  );
  const episodes = (
    <>
      <button type="button" className="icon-button" data-testid="light-previous" aria-label={t("light.previousVideo")} title={t("light.previousVideo")} disabled={!opened.siblings.previous} onClick={() => props.onSibling(-1)}><SkipBack size={16} /></button>
      <button type="button" className="icon-button" data-testid="light-next" aria-label={t("light.nextVideo")} title={t("light.nextVideo")} disabled={!opened.siblings.next} onClick={() => props.onSibling(1)}><SkipForward size={16} /></button>
    </>
  );

  const frameText = playback.playing ? "" : playback.frame.status === "ready"
    ? t("video.frameOf", { frame: displayFrame(playback.frame.frame), total: playback.frame.totalFrames })
    : playback.frame.status === "loading" ? t("video.frameLoading") : playback.frame.status === "absent" ? t("video.frameOnDemand") : playback.frame.status === "unavailable" ? t("video.frameUnavailable") : "";
  const copyBadge = source.state.phase === "ready" && source.state.via === "play_copy";
  const alternateAudio = audioIndex !== undefined && audioIndex !== defaultAudio?.index;
  const showPlayButton = ready && playback.ready && !playback.playing && !playback.ended;

  return (
    <section className="reader video-reader light-video" data-testid="video-reader" data-ready={playback.ready || undefined} data-fullscreen={full || undefined} data-window-full={(windowFull.active && !fullscreen) || undefined}>
      <div ref={shell} className="video-shell" data-testid="video-shell" data-full={full || undefined} data-idle={idle || undefined}>
        <div className="video-stage" data-testid="video-stage" role="group" aria-label={t("video.stage")} style={{ "--player-lift": `${lift}px` } as CSSProperties} onClick={() => { if (ready) playback.toggle(); }} onDoubleClick={toggleFullscreen}>
          <video ref={setElement} className="video-element" data-testid="video-element" crossOrigin="anonymous" src={url ?? undefined} preload="auto" playsInline />
          {source.state.phase !== "ready" ? (
            <div className="video-overlay" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
              <VideoStatus t={t} state={source.state} alternateAudio={alternateAudio} onMakeCopy={() => void source.createCopy(false)} onCancelCopy={() => void source.cancelCopy()} onRetry={() => void source.resolve()} onForceCopy={() => void source.createCopy(true)} onDefaultAudio={() => setAudioIndex(undefined)} onRepair={() => undefined} />
            </div>
          ) : null}
          <SubtitleLayer video={element} cues={subtitles.cues} secondaryCues={subtitles.secondaryCues} style={subtitleStyle} originMs={originMs} lift={lift} />
          {ready && picture.health.state !== "ok" && !healthHidden ? (
            <div className="video-health" role="alert" data-testid="video-health" data-state={picture.health.state} onClick={(event) => event.stopPropagation()}>
              <p>{picture.health.state === "no-first-frame" ? t("video.health.noFirstFrame") : t("video.health.noFrames")}</p>
              <div className="video-status-actions">
                {source.state.phase === "ready" && source.state.via === "original" ? <button type="button" className="primary-button" data-testid="video-health-copy" onClick={() => void source.createCopy(true)}>{t("video.forceCopy")}</button> : null}
                <button type="button" className="secondary-button" onClick={() => void source.resolve()}>{t("video.retry")}</button>
                <button type="button" className="link-button" onClick={() => setHealthHidden(true)}>{t("video.health.dismiss")}</button>
              </div>
            </div>
          ) : null}
          {showPlayButton ? <button type="button" className="video-big-play" data-testid="video-big-play" aria-label={t("video.playBig")} onClick={(event) => { event.stopPropagation(); playback.toggle(); }}><Play size={34} /></button> : null}
          {playback.holding ? <span className="video-holding" role="status" data-testid="video-holding">{t("video.holding", { rate: effectiveRate })}</span> : null}
          {playback.rewinding ? <span className="video-holding" role="status" data-testid="video-rewinding">{t("video.rewinding")}</span> : null}
          {resumedShown && playback.ready ? <span className="video-holding light-resumed" role="status" data-testid="light-resumed">{t("light.resumed")}</span> : null}
          {subtitles.status === "failed" ? <span className="video-subtitle-notice" role="status" data-testid="video-subtitle-notice">{t("video.subtitleFailed", { reason: subtitles.message })}</span> : null}
          {playback.ended ? (
            <div className="video-end" role="status" data-testid="video-end" onClick={(event) => event.stopPropagation()}>
              <strong>{t("video.ended")}</strong>
              <button type="button" className="secondary-button" data-testid="video-replay" onClick={() => { playback.seekTo(0); void playback.play(); }}><Repeat size={14} />{t("video.replay")}</button>
              {opened.siblings.next ? <button type="button" className="primary-button" data-testid="light-end-next" onClick={() => props.onSibling(1)}><SkipForward size={14} />{t("light.nextVideo")}</button> : null}
            </div>
          ) : null}
        </div>

        <div ref={controls} className="video-controls" data-testid="video-controls" role="toolbar" aria-label={t("video.controls")} data-compact={compact || undefined}>
          <SeekBar t={t} currentMs={playback.currentMs} durationMs={duration} bufferedMs={playback.bufferedMs} markers={[]} disabled={!ready} onSeek={playback.seekTo} />
          <div className="video-row">
            <button type="button" className="icon-button" data-testid="video-toggle" aria-label={playback.playing ? t("video.pause") : t("video.play")} title={playback.playing ? t("video.pause") : t("video.play")} disabled={!ready} onClick={playback.toggle}>{playback.playing ? <Pause size={18} /> : <Play size={18} />}</button>
            {compact ? null : episodes}
            <VideoTime t={t} currentMs={playback.currentMs} durationMs={duration} playing={playback.playing} disabled={!ready} openAsk={timeAsk} onGo={goTime} />
            {copyBadge ? <span className="chip" data-testid="video-copy-badge">{t("video.copyBadge")}</span> : null}
            <span className="video-frame" data-testid="video-frame" data-frame={playback.frame.status === "ready" ? displayFrame(playback.frame.frame) : undefined}>{frameText}</span>
            <span className="flex-1" />
            {compact ? null : menus}
            <VolumeControl t={t} volume={settings.volume} muted={settings.muted} open={volumeOpen} onOpen={setVolumeOpen} onChange={(patch) => onSettings(patch)} />
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
                {compact ? <>{episodes}{menus}</> : null}
              </div>
            </div>
          ) : null}
          {inputError ? <p className="video-input-error" role="alert" data-testid="video-input-error">{inputError}</p> : null}
        </div>
      </div>
    </section>
  );
}
