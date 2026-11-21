import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { ChevronLeft, ChevronRight, StepBack, StepForward } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Popup } from "../components/popup.tsx";
import { MatchLink } from "./match-link.tsx";
import { formatClock, type TimeRange } from "./video-model.ts";

type T = Translator["t"];

export function VideoMorePopup(props: {
  t: T;
  anchor: RefObject<HTMLElement | null>;
  ready: boolean;
  compact: boolean;
  menus: ReactNode;
  seekStepSeconds: number;
  currentMs: number;
  durationMs: number;
  markA: number | null;
  markB: number | null;
  interval: TimeRange | null;
  tools?: (state: { currentMs: number; durationMs: number; interval: TimeRange | null }) => ReactNode;
  onMatch?: () => void;
  onSeekBy: (deltaMs: number) => void;
  onStepFrame: (delta: 1 | -1) => void;
  onMarkA: () => void;
  onMarkB: () => void;
  onClearMarks: () => void;
  onClose: () => void;
}) {
  const { t, ready, markA, markB, interval } = props;
  const boxRef = useRef<HTMLDivElement>(null);

  // Keep native top-layer anchor positioning above the legacy absolute rules on `.video-more-panel`.
  useLayoutEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    node.style.position = "fixed";
    node.style.inset = "auto";
  }, []);

  return (
    <Popup
      anchor={props.anchor}
      boxRef={boxRef}
      onClose={props.onClose}
      placement="above"
      align="end"
      role="group"
      label={t("video.more")}
      className="video-more-panel"
      testId="video-more-panel"
    >
      <div className="video-row">
        <button type="button" className="icon-button" data-testid="video-step-back" aria-label={t("video.back", { seconds: props.seekStepSeconds })} title={t("video.back", { seconds: props.seekStepSeconds })} disabled={!ready} onClick={() => props.onSeekBy(-props.seekStepSeconds * 1000)}><ChevronLeft size={18} /></button>
        <button type="button" className="icon-button" data-testid="video-step-forward" aria-label={t("video.forward", { seconds: props.seekStepSeconds })} title={t("video.forward", { seconds: props.seekStepSeconds })} disabled={!ready} onClick={() => props.onSeekBy(props.seekStepSeconds * 1000)}><ChevronRight size={18} /></button>
        <button type="button" className="icon-button" data-testid="video-prev-frame" aria-label={t("video.prevFrame")} title={t("video.prevFrame")} disabled={!ready} onClick={() => props.onStepFrame(-1)}><StepBack size={16} /></button>
        <button type="button" className="icon-button" data-testid="video-next-frame" aria-label={t("video.nextFrame")} title={t("video.nextFrame")} disabled={!ready} onClick={() => props.onStepFrame(1)}><StepForward size={16} /></button>
        {props.compact ? props.menus : null}
      </div>
      <div className="video-row video-tools">
        <button type="button" className="secondary-button" data-testid="video-mark-a" aria-pressed={markA !== null} onClick={props.onMarkA}>{t("video.markA")}{markA !== null ? ` ${formatClock(markA)}` : ""}</button>
        <button type="button" className="secondary-button" data-testid="video-mark-b" aria-pressed={markB !== null} onClick={props.onMarkB}>{t("video.markB")}{markB !== null ? ` ${formatClock(markB)}` : ""}</button>
        {interval ? <span className="video-interval" data-testid="video-interval">{t("video.interval", { start: formatClock(interval.startMs), end: formatClock(interval.endMs) })}</span> : null}
        {markA !== null || markB !== null ? <button type="button" className="link-button" data-testid="video-clear-marks" onClick={props.onClearMarks}>{t("video.clearMarks")}</button> : null}
        {props.tools ? props.tools({ currentMs: props.currentMs, durationMs: props.durationMs, interval }) : null}
        <MatchLink label={t("match.fromReader")} onMatch={props.onMatch} />
      </div>
    </Popup>
  );
}
