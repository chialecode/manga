import { Bug, Loader2 } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { RecordIndicator } from "../voice/record-control.tsx";
import type { RecorderState } from "../voice/recorder.ts";
import type { ScanJob } from "../hooks/use-scan.ts";
import type { UpdateHandle } from "../hooks/use-update.ts";

type T = Translator["t"];

/**
 * What sits on the right of the title bar (交互设计 3.5, 计划 6): the update ready prompt / post-update notice; the context debug button;
 * the recording state while there is one (it is the stop button too); the scan that is running (it opens the library page); nothing else.
 */
export function TitleActions(props: {
  t: T;
  debugOpen: boolean;
  onDebug: () => void;
  recorder: RecorderState | null;
  onStopRecording: () => void;
  scan: ScanJob | null;
  onScan: () => void;
  update?: UpdateHandle;
}) {
  const { t, update } = props;
  const status = update?.status ?? null;
  const readyVersion = status?.state === "ready" && !update?.snoozed ? status.availableVersion : null;
  const justUpdated = status?.justUpdated ?? null;
  const notesText = status?.releaseNotes || justUpdated?.releaseNotes || t("update.notesEmpty");

  return (
    <>
      {justUpdated && !readyVersion ? (
        <div className="scan-indicator flex items-center gap-1.5" data-testid="update-just-updated" role="status">
          <span>{t("update.justUpdated", { version: justUpdated.version })}</span>
          <button
            type="button"
            className="underline text-xs"
            data-testid="update-just-updated-notes"
            onClick={() => update?.setNotesOpen(!update.notesOpen)}
          >
            {t("update.notes")}
          </button>
          <button
            type="button"
            className="text-xs opacity-75 hover:opacity-100"
            data-testid="update-just-updated-dismiss"
            aria-label={t("common.close")}
            onClick={() => void update?.dismissJustUpdated()}
          >
            ×
          </button>
        </div>
      ) : null}
      {readyVersion ? (
        <div className="scan-indicator flex items-center gap-1.5" data-testid="update-banner" role="status">
          <span>{t("update.banner.ready", { version: readyVersion })}</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="font-medium underline text-xs"
            data-testid="update-restart-button"
            onClick={() => void update?.requestRestart()}
          >
            {t("update.restart")}
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="underline text-xs"
            data-testid="update-notes-button"
            aria-expanded={Boolean(update?.notesOpen)}
            onClick={() => update?.setNotesOpen(!update.notesOpen)}
          >
            {t("update.notes")}
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="text-xs opacity-80 hover:opacity-100"
            data-testid="update-later-button"
            onClick={() => update?.snooze()}
          >
            {t("update.later")}
          </button>
        </div>
      ) : null}
      {update?.notesOpen && (readyVersion || justUpdated) ? (
        <div
          role="region"
          aria-label={t("update.notes")}
          data-testid="update-notes-popover"
          className="fixed top-10 right-4 z-50 max-w-sm rounded border border-[var(--color-border)] bg-[var(--color-surface,white)] p-3 text-xs shadow-md"
        >
          <div className="flex items-center justify-between font-medium mb-1">
            <span>{t("update.notes")}</span>
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={() => update.setNotesOpen(false)}
            >
              ×
            </button>
          </div>
          {status?.willUpgradeSchema ? (
            <p className="font-medium mb-1" data-testid="update-schema-notice">
              {t("update.schemaNotice")}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap">{notesText}</p>
        </div>
      ) : null}
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
