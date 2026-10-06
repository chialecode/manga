import { Mic, Square } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { formatClock } from "../readers/video-model.ts";
import type { RecorderState } from "./recorder.ts";
import type { RecordingSettings } from "./use-recorder.ts";

type T = Translator["t"];

/**
 * The recording state in words and a light: what a person must see the whole time a microphone is open. The input level is always part of
 * it (it shows the microphone is really delivering sound); `compact` only leaves out the retention note, for the title bar.
 */
export function RecordIndicator(props: { t: T; state: RecorderState; onStop: () => void; compact?: boolean }) {
  const { t, state } = props;
  if (state.phase === "idle") return null;
  const stopping = state.phase === "stopping";
  const starting = state.phase === "starting";
  const label = starting ? t("record.starting") : stopping ? t("record.stopping") : t("record.recording");
  return (
    <span className="record-indicator" role="status" data-testid="record-indicator" data-phase={state.phase} data-retention={state.retention ?? undefined}>
      <span className="record-light" aria-hidden="true" />
      <strong data-testid="record-label">{label}</strong>
      {!starting ? <span className="record-time" data-testid="record-time">{formatClock(state.elapsedMs)}</span> : null}
      {state.phase === "recording" ? (
        <span className="record-level" role="meter" aria-label={t("record.level")} aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(state.level.toFixed(2))} data-testid="record-level">
          <span style={{ width: `${Math.round(state.level * 100)}%` }} />
        </span>
      ) : null}
      {state.retention && !props.compact ? <span className="record-retention" data-testid="record-retention">{state.retention === "keep" ? t("record.keep") : t("record.discard")}</span> : null}
      {state.phase === "recording" ? (
        <button type="button" className="record-stop" data-testid="record-stop" aria-label={t("record.stop")} title={t("record.stop")} onClick={props.onStop}><Square size={13} />{t("record.stop")}</button>
      ) : null}
    </span>
  );
}

/** The start controls: press to start and stop, or hold the button; the keys do the same from anywhere in the window. */
export function RecordControl(props: {
  t: T;
  state: RecorderState;
  settings: RecordingSettings;
  enabled: boolean;
  onToggle: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onStop: () => void;
  onReview?: () => void;
}) {
  const { t, state } = props;
  if (!props.enabled) return null;
  if (state.phase !== "idle") return <RecordIndicator t={t} state={state} onStop={props.onStop} />;
  return (
    <span className="record-control" data-testid="record-control">
      <button type="button" className="icon-button" data-testid="record-start" aria-label={t("record.startKey", { key: props.settings.toggleKey })} title={t("record.startKey", { key: props.settings.toggleKey })} onClick={props.onToggle}><Mic size={18} /></button>
      <button
        type="button"
        className="record-hold"
        data-testid="record-hold"
        title={t("record.holdKey", { key: props.settings.holdKey })}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); props.onHoldStart(); }}
        onPointerUp={props.onHoldEnd}
        onPointerCancel={props.onHoldEnd}
        onKeyDown={(event) => { if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); props.onHoldStart(); } }}
        onKeyUp={(event) => { if (event.key === " " || event.key === "Enter") props.onHoldEnd(); }}
      >{t("record.hold")}</button>
      {state.lastStop && state.lastStop.durationMs > 0 && props.onReview ? (
        <button type="button" className="link-button" data-testid="record-review" onClick={props.onReview}>{t("record.saved", { time: formatClock(state.lastStop.durationMs) })} · {t("record.review")}</button>
      ) : null}
    </span>
  );
}
