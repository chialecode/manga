import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Play, SkipBack, SkipForward, Square, Trash2 } from "lucide-react";
import { isImeEvent } from "../../../lib/ime.ts";
import { useVideoSource } from "../../../readers/use-video-source.ts";
import { formatClockMs, parseClock } from "../../../readers/video-model.ts";
import type { ProjectTabContext } from "../project-page.tsx";
import {
  lengthText, nextKeyframe, prevKeyframe, readRange, snapToKeyframe, tickPath,
  type ClipView,
} from "./roughcut-model.ts";

export type Patch = { inMs?: number; outMs?: number; label?: string };

/** One clip of the sequence: where it comes from, its two times (typed like the player's clock), its note, and what can be done with it. */
export function ClipRow(props: {
  ctx: ProjectTabContext; clip: ClipView; index: number; count: number; busy: boolean; selected: boolean; keyframes: number[] | null; snap: boolean;
  onPreview: () => void; onUpdate: (patch: Patch, label: string) => void; onMove: (direction: "up" | "down") => void; onRemove: () => void;
}) {
  const { t } = props.ctx;
  const { clip } = props;
  const [problem, setProblem] = useState<"time" | "range" | null>(null);
  const [snapped, setSnapped] = useState<number | null>(null);
  const inField = useRef<HTMLInputElement>(null);
  const outField = useRef<HTMLInputElement>(null);

  function commitTimes() {
    const inText = inField.current?.value ?? "";
    const outText = outField.current?.value ?? "";
    const range = readRange(inText, outText, parseClock, clip.durationMs);
    if (typeof range === "string") { setProblem(range); return; }
    setProblem(null);
    // A start the person changed lands on the keyframe before it when that is asked for: it is where the copy begins anyway.
    let inMs = range.inMs;
    if (props.snap && props.keyframes && inMs !== clip.inMs) inMs = snapToKeyframe(props.keyframes, inMs);
    // Sync uncontrolled inputs back to the normalized/snapped values even if snapped inMs equals clip.inMs.
    if (inField.current) inField.current.value = formatClockMs(inMs);
    if (outField.current) outField.current.value = formatClockMs(range.outMs);
    setSnapped(inMs !== range.inMs ? inMs : null);
    if (inMs !== clip.inMs || range.outMs !== clip.outMs) props.onUpdate({ inMs, outMs: range.outMs }, t("roughcut.op.update"));
  }
  const keys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeEvent(event)) return;
    if (event.key === "Enter") { event.preventDefault(); commitTimes(); }
    else if (event.key === "Escape") { event.preventDefault(); if (inField.current) inField.current.value = formatClockMs(clip.inMs); if (outField.current) outField.current.value = formatClockMs(clip.outMs); setProblem(null); setSnapped(null); }
  };
  return (
    <li className={`rc-clip${props.selected ? " is-selected" : ""}${clip.available ? "" : " is-missing"}`} data-testid={`rc-clip-${clip.id}`} data-missing={clip.available ? "false" : "true"}>
      <span className="rc-n" aria-hidden="true">{props.index + 1}</span>
      <div className="rc-clip-main">
        <strong className="rc-clip-title" title={clip.title}>{clip.title}</strong>
        {clip.available ? null : <small className="rc-clip-warn" data-testid={`rc-missing-${clip.id}`}>{t(clip.title ? "roughcut.clip.missing" : "roughcut.clip.gone")}</small>}
        <div className="rc-times">
          <label>{t("roughcut.clip.in")}
            <input ref={inField} key={`in:${clip.inMs}`} type="text" inputMode="decimal" spellCheck={false} data-testid={`rc-in-${clip.id}`} defaultValue={formatClockMs(clip.inMs)} disabled={props.busy} aria-invalid={problem ? true : undefined} onBlur={commitTimes} onKeyDown={keys} />
          </label>
          <label>{t("roughcut.clip.out")}
            <input ref={outField} key={`out:${clip.outMs}`} type="text" inputMode="decimal" spellCheck={false} data-testid={`rc-out-${clip.id}`} defaultValue={formatClockMs(clip.outMs)} disabled={props.busy} aria-invalid={problem ? true : undefined} onBlur={commitTimes} onKeyDown={keys} />
          </label>
          <span className="detail-muted" data-testid={`rc-length-${clip.id}`}>{t("roughcut.clip.length", { length: lengthText(clip.outMs - clip.inMs) })}</span>
        </div>
        {problem ? <small className="rc-clip-warn" role="alert" data-testid={`rc-time-error-${clip.id}`}>{t(problem === "time" ? "roughcut.timeInvalid" : "roughcut.rangeInvalid")}</small> : null}
        {snapped !== null && !problem ? <small className="detail-muted" role="status" data-testid={`rc-snapped-${clip.id}`}>{t("roughcut.timeline.snapped", { time: formatClockMs(snapped) })}</small> : null}
        <input className="rc-note" type="text" maxLength={200} data-testid={`rc-label-${clip.id}`} defaultValue={clip.label} key={`label:${clip.label}`} disabled={props.busy} aria-label={t("roughcut.clip.label")} placeholder={t("roughcut.clip.labelPlaceholder")}
          onBlur={(event) => { if (event.target.value !== clip.label) props.onUpdate({ label: event.target.value }, t("roughcut.op.update")); }}
          onKeyDown={(event) => { if (isImeEvent(event)) return; if (event.key === "Enter") event.currentTarget.blur(); }} />
      </div>
      <div className="rc-clip-actions">
        <button type="button" className="icon-button" data-testid={`rc-preview-${clip.id}`} aria-pressed={props.selected} aria-label={t("roughcut.clip.preview")} title={t("roughcut.clip.preview")} disabled={!clip.available} onClick={props.onPreview}><Play size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-button" data-testid={`rc-up-${clip.id}`} aria-label={t("roughcut.clip.up")} title={t("roughcut.clip.up")} disabled={props.busy || props.index === 0} onClick={() => props.onMove("up")}><ArrowUp size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-button" data-testid={`rc-down-${clip.id}`} aria-label={t("roughcut.clip.down")} title={t("roughcut.clip.down")} disabled={props.busy || props.index === props.count - 1} onClick={() => props.onMove("down")}><ArrowDown size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-button" data-testid={`rc-remove-${clip.id}`} aria-label={t("roughcut.clip.remove")} title={t("roughcut.clip.remove")} disabled={props.busy} onClick={props.onRemove}><Trash2 size={15} aria-hidden="true" /></button>
      </div>
    </li>
  );
}

/**
 * The requested stretch of one video played from the original (or the play copy the player made), stopping at its end, with the keyframes of the video
 * on a timeline: jump from keyframe to keyframe, and mark the start or end where the picture is.
 */
export function ClipPreview({ ctx, clip, busy, keyframes, snap, onSnap, onUpdate }: { ctx: ProjectTabContext; clip: ClipView; busy: boolean; keyframes: number[] | null; snap: boolean; onSnap: (on: boolean) => void; onUpdate: (patch: Patch) => void }) {
  const { t } = ctx;
  const target = useMemo(() => ({ resourceId: clip.resourceId, revisionId: clip.revisionId }), [clip.resourceId, clip.revisionId]);
  const source = useVideoSource(target, undefined);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(clip.inMs);
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const state = source.state;
  const origin = state.phase === "ready" ? state.startMs : 0;
  const duration = clip.durationMs ?? Math.max(clip.outMs, 1);
  const seek = useCallback((ms: number) => {
    if (video.current) video.current.currentTime = (ms + origin) / 1000;
    setCurrentMs(ms);
  }, [origin]);
  const here = (element: HTMLVideoElement) => setCurrentMs(Math.max(0, Math.round(element.currentTime * 1000 - origin)));

  function play() {
    const element = video.current;
    if (!element) return;
    seek(clip.inMs);
    setPlaying(true);
    void element.play().catch(() => setPlaying(false));
  }
  function stop() { video.current?.pause(); setPlaying(false); }

  const previous = keyframes ? prevKeyframe(keyframes, currentMs) : null;
  const following = keyframes ? nextKeyframe(keyframes, currentMs) : null;
  const barClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width > 0) seek(Math.round(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * duration));
  };

  return (
    <section className="rc-preview" data-testid="rc-preview" aria-label={t("roughcut.preview.title")}>
      <h4>{t("roughcut.preview.title")}: {clip.title}</h4>
      {state.phase === "ready" ? (
        <>
          <video ref={video} src={state.url} controls preload="metadata" data-testid="rc-video"
            onLoadedMetadata={(event) => { if (video.current) video.current.currentTime = (clipRef.current.inMs + origin) / 1000; here(event.currentTarget); }}
            onPlay={() => setPlaying(true)}
            onTimeUpdate={(event) => { here(event.currentTarget); if (playing && (event.currentTarget.currentTime - origin / 1000) * 1000 >= clipRef.current.outMs) stop(); }}
            onSeeked={(event) => here(event.currentTarget)}
            onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} />
          <div className="rc-timeline" data-testid="rc-timeline" aria-label={t("roughcut.timeline.title")}>
            <div className="rc-bar" data-testid="rc-bar" role="presentation" title={t("roughcut.timeline.seek")} onClick={barClick}>
              <svg viewBox="0 0 1000 24" preserveAspectRatio="none" aria-hidden="true">
                <rect className="rc-range" x={(clip.inMs / duration) * 1000} y="0" width={Math.max(1, ((clip.outMs - clip.inMs) / duration) * 1000)} height="24" />
                {keyframes ? <path className="rc-ticks" d={tickPath(keyframes, duration)} data-testid="rc-ticks" /> : null}
                <rect className="rc-head" x={Math.min(998, (currentMs / duration) * 1000)} y="0" width="2" height="24" />
              </svg>
            </div>
            <div className="rc-timeline-tools">
              <button type="button" className="icon-button" data-testid="rc-key-prev" aria-label={t("roughcut.timeline.prev")} title={t("roughcut.timeline.prev")} disabled={previous === null} onClick={() => previous !== null && seek(previous)}><SkipBack size={15} aria-hidden="true" /></button>
              <button type="button" className="icon-button" data-testid="rc-key-next" aria-label={t("roughcut.timeline.next")} title={t("roughcut.timeline.next")} disabled={following === null} onClick={() => following !== null && seek(following)}><SkipForward size={15} aria-hidden="true" /></button>
              <button type="button" className="secondary-button" data-testid="rc-set-in" disabled={busy} onClick={() => onUpdate({ inMs: snap && keyframes ? snapToKeyframe(keyframes, currentMs) : currentMs })}>{t("roughcut.timeline.setIn")}</button>
              <button type="button" className="secondary-button" data-testid="rc-set-out" disabled={busy} onClick={() => onUpdate({ outMs: currentMs })}>{t("roughcut.timeline.setOut")}</button>
              <label className="rc-snap" title={t("roughcut.timeline.snapHint")}>
                <input type="checkbox" data-testid="rc-snap" checked={snap} onChange={(event) => onSnap(event.target.checked)} /> {t("roughcut.timeline.snap")}
              </label>
              <small className="detail-muted" data-testid="rc-current">{t("roughcut.timeline.current", { time: formatClockMs(currentMs) })}</small>
              <small className="detail-muted" data-testid="rc-key-count">{keyframes ? t("roughcut.timeline.count", { count: keyframes.length }) : t("roughcut.timeline.loading")}</small>
            </div>
          </div>
          <div className="rc-preview-actions">
            <button type="button" className="secondary-button" data-testid="rc-preview-play" onClick={playing ? stop : play}>{playing ? <><Square size={13} aria-hidden="true" /> {t("roughcut.preview.stop")}</> : <><Play size={13} aria-hidden="true" /> {t("roughcut.preview.play")}</>}</button>
            <small className="detail-muted">{t("roughcut.preview.hint")}</small>
          </div>
        </>
      ) : state.phase === "loading" || state.phase === "building" ? <p className="detail-muted" role="status">{t("status.loading")}</p>
        : state.phase === "needs_copy" ? <p className="detail-muted" data-testid="rc-preview-needs-copy">{t("roughcut.preview.needsCopy")}</p>
          : <p className="detail-muted" data-testid="rc-preview-unavailable">{t("roughcut.preview.unavailable")}</p>}
    </section>
  );
}
