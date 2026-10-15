import { useEffect, useRef } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Popup } from "../components/popup.tsx";

type T = Translator["t"];

/** One notch of the wheel is five percent of the volume. */
export const WHEEL_STEP = 0.05;

export const stepVolume = (volume: number, delta: number): number => Math.min(1, Math.max(0, Math.round((volume + delta) * 100) / 100));

/**
 * The volume (A-77): a button that opens a vertical slider on the top layer. The wheel over the button or the slider turns the volume by five percent
 * a notch; a click outside or Esc (which the player passes in as `open` going false) closes it. The slider is the browser's own range, laid out upright.
 */
export function VolumeControl(props: {
  t: T;
  volume: number;
  muted: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (patch: { volume?: number; muted?: boolean }) => void;
}) {
  const { t } = props;
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const live = useRef(props);
  live.current = props;
  const shown = props.muted ? 0 : props.volume;

  // A wheel listener that may cancel the event: the page behind has nothing to scroll, but a panel under the pointer might.
  useEffect(() => {
    const node = wrap.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const { volume, muted, onChange } = live.current;
      onChange({ volume: stepVolume(muted ? 0 : volume, event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP), muted: false });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <span ref={wrap} className="video-volume-root">
      <button
        ref={button}
        type="button"
        className="icon-button"
        data-testid="video-volume-button"
        aria-label={t("video.volume")}
        title={t("video.volume")}
        aria-haspopup="true"
        aria-expanded={props.open}
        onClick={() => props.onOpen(!props.open)}
      >{props.muted || props.volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
      {props.open ? (
        <Popup anchor={button} onClose={() => props.onOpen(false)} placement="above" align="start" role="group" label={t("video.volume")} className="video-volume-pop" testId="video-volume-pop">
          <output className="video-volume-value" data-testid="video-volume-value">{Math.round(shown * 100)}</output>
          <input
            type="range"
            className="video-volume"
            data-testid="video-volume"
            aria-label={t("video.volume")}
            min={0}
            max={1}
            step={0.05}
            value={shown}
            onChange={(event) => props.onChange({ volume: Number(event.target.value), muted: false })}
          />
          <button type="button" className="icon-button" data-testid="video-volume-mute" aria-label={props.muted ? t("video.unmute") : t("video.mute")} title={props.muted ? t("video.unmute") : t("video.mute")} aria-pressed={props.muted} onClick={() => props.onChange({ muted: !props.muted })}>
            {props.muted || props.volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        </Popup>
      ) : null}
    </span>
  );
}
