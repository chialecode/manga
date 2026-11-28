import { useCallback, useEffect, useRef, useState, type FocusEvent } from "react";
import { Camera, Mic, NotebookPen, PanelRight, Square } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { FullscreenPortal, useFullscreenElement } from "../../lib/fullscreen-portal.tsx";
import { formatClock } from "../../readers/video-model.ts";
import type { RecorderState } from "../../voice/recorder.ts";

type T = Translator["t"];

/** Hover dwell before sliding out from the right edge so dual-monitor pointer passes do not trigger accidentally. */
export const EDGE_DWELL_MS = 150;
/** Grace period after pointer leaves before sliding back out. */
export const EDGE_GRACE_MS = 260;

export type EdgeMicProps = {
  state: RecorderState;
  enabled: boolean;
  toggleKey: string;
  onToggle: () => void;
  onStop: () => void;
};

export type EdgeHandleProps = {
  t: T;
  mic: EdgeMicProps | null;
  noteable: boolean;
  quickNoteKey?: string;
  onOpenQuickNote?: () => void;
  screenshot?: { label: string; disabled: boolean; key?: string; onTake: () => void } | null;
  dock?: { key?: string; onOpen: () => void } | null;
  /** Portal into `document.fullscreenElement` when active (defaults to true). */
  portalToFullscreen?: boolean;
};

/**
 * Unified Right-Edge Magnetic Handle: replaces the top header-docked capsule everywhere the right dock is not visible
 * (folded dock, narrow window, window fullscreen W, and browser screen fullscreen F).
 * Completely transparent while idle; displays a slim vertical pulsing red indicator pill while long-session recording is active.
 */
export function EdgeHandle(props: EdgeHandleProps) {
  const { t, mic, noteable, onOpenQuickNote, screenshot, dock } = props;
  const fullscreenEl = useFullscreenElement();
  const [expanded, setExpanded] = useState(false);
  const dwellTimer = useRef<number | undefined>(undefined);
  const graceTimer = useRef<number | undefined>(undefined);
  const pointerInside = useRef(false);
  const zoneRef = useRef<HTMLDivElement>(null);

  const hasMic = Boolean(mic && mic.enabled);
  const hasNote = noteable && Boolean(onOpenQuickNote);
  const hasShot = Boolean(screenshot);
  const hasDockBtn = Boolean(dock) && !fullscreenEl;
  const recordingActive = Boolean(hasMic && mic && mic.state.phase !== "idle");

  const clearTimers = useCallback(() => {
    window.clearTimeout(dwellTimer.current);
    window.clearTimeout(graceTimer.current);
    dwellTimer.current = undefined;
    graceTimer.current = undefined;
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  if (!hasMic && !hasNote && !hasShot && !hasDockBtn) return null;

  const scheduleExpand = () => {
    pointerInside.current = true;
    window.clearTimeout(graceTimer.current);
    graceTimer.current = undefined;
    if (expanded || dwellTimer.current !== undefined) return;
    dwellTimer.current = window.setTimeout(() => {
      dwellTimer.current = undefined;
      setExpanded(true);
    }, EDGE_DWELL_MS);
  };

  const expandNow = () => {
    clearTimers();
    setExpanded(true);
  };

  const scheduleCollapse = () => {
    pointerInside.current = false;
    window.clearTimeout(dwellTimer.current);
    dwellTimer.current = undefined;
    if (!expanded) return;
    if (zoneRef.current?.contains(document.activeElement)) return;
    window.clearTimeout(graceTimer.current);
    graceTimer.current = window.setTimeout(() => {
      graceTimer.current = undefined;
      if (!pointerInside.current && !zoneRef.current?.contains(document.activeElement)) {
        setExpanded(false);
      }
    }, EDGE_GRACE_MS);
  };

  const onZoneFocus = () => {
    clearTimers();
    setExpanded(true);
  };

  const onZoneBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    if (pointerInside.current) return;
    window.clearTimeout(graceTimer.current);
    graceTimer.current = window.setTimeout(() => {
      graceTimer.current = undefined;
      if (!pointerInside.current && !zoneRef.current?.contains(document.activeElement)) {
        setExpanded(false);
      }
    }, EDGE_GRACE_MS);
  };

  const onMicClick = () => {
    if (!mic) return;
    if (mic.state.phase === "idle") mic.onToggle();
    else if (mic.state.phase === "recording") mic.onStop();
  };

  const micLabel = mic
    ? (recordingActive ? t("capture.recordStopKey", { key: mic.toggleKey }) : t("record.startKey", { key: mic.toggleKey }))
    : "";
  const noteLabel = props.quickNoteKey ? t("edge.noteKey", { key: props.quickNoteKey }) : t("chat.capsule.note");
  const shotLabel = screenshot
    ? (screenshot.key ? t("edge.screenshotKey", { label: screenshot.label, key: screenshot.key }) : screenshot.label)
    : "";
  const dockLabel = dock
    ? (dock.key ? t("edge.dockKey", { key: dock.key }) : t("edge.dock"))
    : "";

  const content = (
    <div
      ref={zoneRef}
      className="edge-handle-zone"
      data-testid="edge-handle-zone"
      data-expanded={expanded ? "true" : "false"}
      data-recording={recordingActive ? "true" : "false"}
      data-fullscreen={fullscreenEl ? "true" : "false"}
      onPointerEnter={() => { pointerInside.current = true; window.clearTimeout(graceTimer.current); graceTimer.current = undefined; }}
      onPointerLeave={scheduleCollapse}
      onMouseLeave={scheduleCollapse}
      onFocus={onZoneFocus}
      onBlur={onZoneBlur}
    >
      <button
        type="button"
        className="edge-handle-hotzone"
        data-testid="edge-handle-hotzone"
        aria-label={recordingActive ? t("edge.recording") : t("edge.trigger")}
        aria-expanded={expanded}
        onPointerEnter={scheduleExpand}
        onMouseEnter={scheduleExpand}
        onMouseDown={(event) => event.preventDefault()}
        onClick={expandNow}
      >
        {recordingActive && !expanded ? (
          <span className="edge-handle-pill" data-testid="edge-handle-recording-pill" aria-hidden="true" />
        ) : null}
      </button>

      <div
        className="edge-handle-capsule"
        data-testid="edge-handle"
        data-expanded={expanded ? "true" : "false"}
        role="toolbar"
        aria-orientation="vertical"
        aria-label={t("chat.capsule")}
      >
        {hasMic && mic ? (
          <button
            type="button"
            className="edge-handle-btn edge-handle-mic"
            data-testid="edge-mic"
            data-phase={mic.state.phase}
            aria-pressed={recordingActive}
            aria-label={micLabel}
            title={micLabel}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onMicClick}
          >
            {mic.state.phase === "recording" ? <Square size={15} /> : <Mic size={16} />}
            {recordingActive && mic.state.phase !== "starting" ? (
              <span className="edge-handle-timer" data-testid="edge-mic-time">{formatClock(mic.state.elapsedMs)}</span>
            ) : null}
          </button>
        ) : null}

        {hasNote && onOpenQuickNote ? (
          <button
            type="button"
            className="edge-handle-btn"
            data-testid="edge-note"
            aria-label={noteLabel}
            title={noteLabel}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { setExpanded(false); onOpenQuickNote(); }}
          >
            <NotebookPen size={16} />
          </button>
        ) : null}

        {hasShot && screenshot ? (
          <button
            type="button"
            className="edge-handle-btn"
            data-testid="edge-screenshot"
            aria-label={shotLabel}
            title={shotLabel}
            disabled={screenshot.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => screenshot.onTake()}
          >
            <Camera size={16} />
          </button>
        ) : null}

        {hasDockBtn && dock ? (
          <button
            type="button"
            className="edge-handle-btn"
            data-testid="edge-dock"
            aria-label={dockLabel}
            title={dockLabel}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { setExpanded(false); dock.onOpen(); }}
          >
            <PanelRight size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );

  if (props.portalToFullscreen === false) return content;
  return <FullscreenPortal>{content}</FullscreenPortal>;
}
