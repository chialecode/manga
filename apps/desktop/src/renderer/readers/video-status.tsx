import type { MessageKey, Translator } from "@manga/i18n";
import type { SourceState } from "./use-video-source.ts";

type T = Translator["t"];

const REASONS = ["no_hardware_hevc", "unsupported_audio", "audio_track", "unsupported_video", "unsupported_container"] as const;

/**
 * What stands in for the picture when the file cannot play as it is: why, what a play copy is and that the original is
 * never touched, the build's progress with a way to stop it, and the plain failures. A reason the plan names that this
 * list does not know is shown as the plan's own sentence instead of being hidden.
 */
export function VideoStatus(props: {
  t: T;
  state: SourceState;
  /** An audio track other than the file's default was asked for; offering the default again is the way out. */
  alternateAudio: boolean;
  onMakeCopy: () => void;
  onCancelCopy: () => void;
  onRetry: () => void;
  onForceCopy: () => void;
  onDefaultAudio: () => void;
  onRepair: () => void;
}) {
  const { t, state } = props;
  switch (state.phase) {
    case "ready":
      return null;
    case "loading":
      return <p className="video-status" role="status" data-testid="video-loading">{t("video.loading")}</p>;
    case "missing":
      return (
        <div className="video-status" role="alert" data-testid="video-missing">
          <p>{t("video.missing")}</p>
          <button type="button" className="secondary-button" data-testid="video-repair" onClick={props.onRepair}>{t("reading.sourceRepair")}</button>
        </div>
      );
    case "unsupported":
      return <p className="video-status" role="alert" data-testid="video-unsupported">{t("video.unsupported", { detail: state.detail })}</p>;
    case "failed":
      return (
        <div className="video-status" role="alert" data-testid="video-failed">
          <p>{t("video.failed", { message: state.message || state.code || "" })}</p>
          <div className="video-status-actions">
            <button type="button" className="secondary-button" data-testid="video-retry" onClick={props.onRetry}>{t("video.retry")}</button>
            {state.canForceCopy ? <button type="button" className="secondary-button" data-testid="video-force-copy" onClick={props.onForceCopy}>{t("video.forceCopy")}</button> : null}
          </div>
        </div>
      );
    case "needs_copy": {
      const known = (REASONS as readonly string[]).includes(state.reason);
      return (
        <div className="video-status" role="status" data-testid="video-needs-copy" data-reason={state.reason}>
          <p>{t("video.needsCopy")}</p>
          <p className="video-status-reason" data-testid="video-copy-reason">{known ? t(`video.reason.${state.reason}` as MessageKey) : state.detail}</p>
          <p className="video-status-note">{t("video.copyNote")}</p>
          <div className="video-status-actions">
            <button type="button" className="primary-button" data-testid="video-make-copy" onClick={props.onMakeCopy}>{t("video.makeCopy")}</button>
            {props.alternateAudio ? <button type="button" className="secondary-button" data-testid="video-default-audio" onClick={props.onDefaultAudio}>{t("video.useDefaultAudio")}</button> : null}
          </div>
        </div>
      );
    }
    case "building": {
      const percent = Math.round(Math.max(0, Math.min(1, state.copy.progress)) * 100);
      return (
        <div className="video-status" role="status" data-testid="video-building" data-state={state.copy.state}>
          <p>{t("video.building", { percent })}</p>
          <progress max={100} value={percent} aria-label={t("video.building", { percent })} />
          <div className="video-status-actions">
            <button type="button" className="secondary-button" data-testid="video-cancel-copy" onClick={props.onCancelCopy}>{t("video.cancelCopy")}</button>
          </div>
        </div>
      );
    }
  }
}
