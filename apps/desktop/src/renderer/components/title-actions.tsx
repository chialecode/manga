import { Bug, Loader2 } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { RecordIndicator } from "../voice/record-control.tsx";
import type { RecorderState } from "../voice/recorder.ts";
import type { ScanJob } from "../hooks/use-scan.ts";

type T = Translator["t"];

/**
 * What sits on the right of the title bar (交互设计 3.5): the context debug button; the recording state while there is one (it is the
 * stop button too); the scan that is running (it opens the library page); nothing else. There is no microphone here: recording
 * starts from the right pane or the capsule.
 */
export function TitleActions(props: {
  t: T;
  debugOpen: boolean;
  onDebug: () => void;
  recorder: RecorderState | null;
  onStopRecording: () => void;
  scan: ScanJob | null;
  onScan: () => void;
}) {
  const { t } = props;
  return (
    <>
      {props.recorder && props.recorder.phase !== "idle" ? <RecordIndicator t={t} state={props.recorder} onStop={props.onStopRecording} compact /> : null}
      {props.scan ? (
        <button type="button" className="scan-indicator" data-testid="scan-indicator" title={t("scan.indicator.open")} onClick={props.onScan}>
          <Loader2 size={14} className="spin" aria-hidden="true" />
          <span>{props.scan.total > 0 ? t("scan.indicator.count", { done: props.scan.processed, total: props.scan.total }) : t("scan.indicator")}</span>
        </button>
      ) : null}
      <button type="button" className="shell-icon" data-testid="debug-toggle" aria-pressed={props.debugOpen} aria-label={t("debug.open")} title={`${t("debug.open")} (Ctrl+Shift+D)`} onClick={props.onDebug}><Bug size={17} /></button>
    </>
  );
}
