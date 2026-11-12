import { useEffect, useState, type CSSProperties } from "react";
import { Mic, Square, X } from "lucide-react";
import type { DictationMode, DictationStage } from "@manga/contracts";
import type { MessageKey, Translator } from "@manga/i18n";

type T = Translator["t"];

export type CapsuleAnchor = {
  centerX: number;
  bottomPx: number;
} | null;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export type DictationUiStage = DictationStage | "starting" | "loading_model";

export function dictationStageLabel(t: T, stage: DictationUiStage): string {
  return t(`dictation.stage.${stage}` as MessageKey);
}

function usePrefersReducedMotion(): boolean {
  const read = () => {
    try {
      return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    } catch {
      return false;
    }
  };
  const [reduced, setReduced] = useState<boolean>(read);
  useEffect(() => {
    let media: MediaQueryList | undefined;
    try {
      media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    } catch {
      media = undefined;
    }
    if (!media) return;
    setReduced(media.matches);
    const onChange = () => setReduced(Boolean(media?.matches));
    media.addEventListener?.("change", onChange);
    return () => media?.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/**
 * Compact bottom-center dictation capsule anchored to the focused pane (VOICE-10, U1).
 * Uses theme variables only, never displays microphone device names, switches to a 2-state
 * sound/silent indicator under `prefers-reduced-motion`, and suppresses mousedown focus steal
 * so transient canvas/mindmap inputs never commit/unmount while interacting with the capsule.
 */
export function DictationCapsule(props: {
  t: T;
  active: boolean;
  stage: DictationUiStage;
  mode: DictationMode;
  elapsedMs: number;
  level: number;
  anchor: CapsuleAnchor;
  onStop: () => void;
  onCancel: () => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  if (!props.active) return null;

  const { t, mode, elapsedMs, level, anchor } = props;
  const currentStage = props.stage;
  const stageText = dictationStageLabel(t, currentStage);
  const timeText = formatElapsed(elapsedMs);
  const capturing = currentStage === "starting" || currentStage === "loading_model" || currentStage === "recording";
  const speaking = capturing && level >= 0.04;
  const clampedLevel = Math.max(0, Math.min(1, level));

  const style: CSSProperties = anchor
    ? { left: `${Math.round(anchor.centerX)}px`, bottom: `${Math.round(anchor.bottomPx)}px` }
    : { left: "50%", bottom: "20px" };

  const micStyle: CSSProperties = reducedMotion
    ? {}
    : speaking
      ? { opacity: Number((0.55 + clampedLevel * 0.45).toFixed(2)), transform: `scale(${(1 + clampedLevel * 0.16).toFixed(3)})` }
      : { opacity: 0.45 };

  return (
    <div
      className="dictation-capsule"
      style={style}
      role="status"
      aria-live="polite"
      aria-label={t("dictation.ariaStatus", { stage: stageText, time: timeText })}
      data-testid="dictation-capsule"
      data-mode={mode}
      data-motion={reducedMotion ? "reduced" : "normal"}
      data-voice-state={speaking ? "sound" : "silent"}
      onMouseDown={(event) => event.preventDefault()}
    >
      <span
        className="dictation-capsule-mic"
        data-testid="dictation-capsule-mic"
        data-active={speaking ? "true" : "false"}
        style={micStyle}
        aria-hidden="true"
      >
        <Mic size={15} />
      </span>
      <span className="dictation-capsule-time" data-testid="dictation-capsule-time">{timeText}</span>
      <span className="dictation-capsule-stage" data-testid="dictation-capsule-stage">{stageText}</span>
      {capturing ? (
        <span className="dictation-capsule-badge" data-testid="dictation-capsule-mode">
          {mode === "locked" ? t("dictation.lockedBadge") : t("dictation.holdBadge")}
        </span>
      ) : null}
      {mode === "locked" && capturing ? (
        <button
          type="button"
          className="dictation-capsule-stop"
          data-testid="dictation-stop"
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onStop}
        >
          <Square size={11} />
          {t("dictation.stop")}
        </button>
      ) : null}
      <button
        type="button"
        className="dictation-capsule-cancel"
        data-testid="dictation-cancel"
        aria-label={t("dictation.cancel")}
        title={t("dictation.cancel")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onCancel}
      >
        <X size={14} />
      </button>
    </div>
  );
}
