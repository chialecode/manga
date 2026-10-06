import type { Translator } from "@manga/i18n";
import { formatClock, percentOf, type TimeRange } from "./video-model.ts";

type T = Translator["t"];

export type SeekMarker = TimeRange & { id: string; kind: "recording" | "mark" | "source"; label?: string };

/**
 * The timeline: a range input for the position (keyboard and screen readers work as they do for any slider) with the
 * buffered part, the A–B interval, the interval a note points at and the recorded intervals drawn under it. A marker
 * is a place to jump to, so clicking one seeks to its start.
 */
export function SeekBar(props: {
  t: T;
  currentMs: number;
  durationMs: number;
  bufferedMs: number;
  markers: SeekMarker[];
  disabled?: boolean;
  onSeek: (ms: number) => void;
}) {
  const { t, currentMs, durationMs } = props;
  const span = (range: TimeRange) => {
    const left = percentOf(range.startMs, durationMs);
    return { left: `${left}%`, width: `${Math.max(0.4, percentOf(range.endMs, durationMs) - left)}%` };
  };
  return (
    <div className="video-seek" data-testid="video-seek">
      <div className="video-seek-track" aria-hidden="true">
        <span className="video-seek-buffered" style={{ width: `${percentOf(props.bufferedMs, durationMs)}%` }} />
        <span className="video-seek-played" style={{ width: `${percentOf(currentMs, durationMs)}%` }} />
        {props.markers.map((marker) => (
          <span key={marker.id} className="video-seek-marker" data-kind={marker.kind} style={span(marker)} />
        ))}
      </div>
      <input
        type="range"
        className="video-seek-input"
        data-testid="video-seek-input"
        aria-label={t("video.seek")}
        aria-valuetext={`${formatClock(currentMs)} / ${formatClock(durationMs)}`}
        min={0}
        max={Math.max(1, Math.round(durationMs))}
        step={100}
        value={Math.min(Math.round(currentMs), Math.max(1, Math.round(durationMs)))}
        disabled={props.disabled || durationMs <= 0}
        onChange={(event) => props.onSeek(Number(event.target.value))}
      />
      <div className="video-seek-jumps">
        {props.markers.filter((marker) => marker.kind !== "mark").map((marker) => (
          <button
            key={marker.id}
            type="button"
            className="video-seek-jump"
            data-testid={`video-marker-${marker.id}`}
            data-kind={marker.kind}
            aria-label={`${marker.label ?? (marker.kind === "source" ? t("video.sourceTime") : t("video.markers"))} ${formatClock(marker.startMs)}`}
            title={`${marker.label ?? (marker.kind === "source" ? t("video.sourceTime") : t("video.markers"))} ${formatClock(marker.startMs)}`}
            style={{ left: `${percentOf(marker.startMs, durationMs)}%` }}
            onClick={() => props.onSeek(marker.startMs)}
          />
        ))}
      </div>
    </div>
  );
}
