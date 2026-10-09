import { useEffect, useRef, useState } from "react";
import type { Translator } from "@manga/i18n";
import { formatClockMs } from "./video-model.ts";

type T = Translator["t"];

/** While a video plays the text is redrawn this often: a clock that changes sixty times a second cannot be read. */
export const PLAYING_REFRESH_MS = 500;

/**
 * The current time and the length as one editable text, `m:ss.mmm / m:ss.mmm`. Playing, it refreshes about twice a second;
 * paused, it shows the exact time. A click turns the current time into a field: Enter goes there, Esc or leaving the field
 * keeps the video where it is. `onGo` returns the reason a typed time was refused, or null when it was taken.
 */
export function VideoTime(props: { t: T; currentMs: number; durationMs: number; playing: boolean; disabled?: boolean; openAsk?: number; onGo: (text: string) => string | null }) {
  const { t, currentMs, durationMs, playing } = props;
  const [shown, setShown] = useState(currentMs);
  const lastShown = useRef(0);
  useEffect(() => {
    if (!playing) { setShown(currentMs); lastShown.current = Date.now(); return; }
    const wait = PLAYING_REFRESH_MS - (Date.now() - lastShown.current);
    if (wait <= 0) { setShown(currentMs); lastShown.current = Date.now(); return; }
    const timer = window.setTimeout(() => { setShown(currentMs); lastShown.current = Date.now(); }, wait);
    return () => window.clearTimeout(timer);
  }, [currentMs, playing]);

  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { field.current?.focus(); field.current?.select(); } }, [editing]);

  const total = formatClockMs(durationMs);
  const asked = useRef(props.openAsk ?? 0);
  useEffect(() => {
    if ((props.openAsk ?? 0) !== asked.current) { asked.current = props.openAsk ?? 0; open(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.openAsk]);
  function open() {
    if (props.disabled) return;
    setText(formatClockMs(currentMs));
    setInvalid(false);
    setEditing(true);
  }
  const commit = () => {
    const reason = props.onGo(text);
    if (reason === null) { setEditing(false); setInvalid(false); } else setInvalid(true);
  };

  if (editing) {
    return (
      <span className="video-time video-time-editing" data-testid="video-time" data-editing="">
        <input
          ref={field}
          type="text"
          inputMode="decimal"
          className="video-time-input"
          data-testid="video-time-input"
          aria-label={t("video.timeInput")}
          aria-invalid={invalid || undefined}
          value={text}
          spellCheck={false}
          onChange={(event) => { setText(event.target.value); setInvalid(false); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commit(); }
            else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); }
          }}
          onBlur={() => setEditing(false)}
        />
        <span aria-hidden="true"> / {total}</span>
      </span>
    );
  }
  return (
    <button type="button" className="video-time" data-testid="video-time" disabled={props.disabled} aria-live="off" aria-label={t("video.timeEdit", { current: formatClockMs(currentMs), total })} title={t("video.timeEdit", { current: formatClockMs(currentMs), total })} onClick={open}>
      {t("video.time", { current: formatClockMs(shown), total })}
    </button>
  );
}
