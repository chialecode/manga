import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { activeCues, arrangeLines, layoutSubtitles, liftDialogue, SUBTITLE_FONT_STACKS, type Box, type SubtitleCue, type SubtitleStyle } from "./subtitle-model.ts";

type Showing = { main: SubtitleCue[]; second: SubtitleCue[] };

const same = (a: readonly SubtitleCue[], b: readonly SubtitleCue[]) => a.length === b.length && a.every((cue, index) => cue === b[index]);

/** The cues showing now, and a re-render only when they change: the clock is read on every frame while the video plays, not rendered. */
function useShowing(video: HTMLVideoElement | null, main: readonly SubtitleCue[], second: readonly SubtitleCue[], originMs: number): Showing {
  const [showing, setShowing] = useState<Showing>({ main: [], second: [] });
  const cues = useRef({ main, second });
  cues.current = { main, second };
  useEffect(() => {
    if (!video) { setShowing({ main: [], second: [] }); return; }
    let frame = 0;
    const update = () => {
      const time = video.currentTime * 1000 - originMs;
      const next = { main: activeCues(cues.current.main, time), second: activeCues(cues.current.second, time) };
      setShowing((current) => (same(current.main, next.main) && same(current.second, next.second) ? current : next));
    };
    const tick = () => {
      update();
      frame = video.paused ? 0 : requestAnimationFrame(tick);
    };
    const wake = () => { if (!frame) frame = requestAnimationFrame(tick); update(); };
    const events = ["play", "playing", "seeking", "seeked", "timeupdate", "pause", "loadeddata"] as const;
    for (const name of events) video.addEventListener(name, wake);
    wake();
    return () => {
      for (const name of events) video.removeEventListener(name, wake);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [video, originMs, main, second]);
  return showing;
}

/** The size of the box the video is drawn in, and the video's own size, both kept current. */
function useGeometry(root: RefObject<HTMLElement | null>, video: HTMLVideoElement | null) {
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => setFrame((current) => (current.w === node.clientWidth && current.h === node.clientHeight ? current : { w: node.clientWidth, h: node.clientHeight }));
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [root]);
  useEffect(() => {
    if (!video) { setNatural({ w: 0, h: 0 }); return; }
    const read = () => setNatural((current) => (current.w === video.videoWidth && current.h === video.videoHeight ? current : { w: video.videoWidth, h: video.videoHeight }));
    read();
    video.addEventListener("loadedmetadata", read);
    video.addEventListener("resize", read);
    return () => { video.removeEventListener("loadedmetadata", read); video.removeEventListener("resize", read); };
  }, [video]);
  return { frame, natural };
}

const px = (value: number) => Math.round(value * 100) / 100;
const boxStyle = (box: Box): CSSProperties => ({ left: px(box.x), top: px(box.y), width: px(box.w), height: px(box.h) });

/**
 * The text subtitles of the player, drawn by the player itself so their place and size are the standard's and not a browser's (A-59). The layer
 * covers the video's frame; the zones are worked out from the picture inside it (the video as drawn, black bars excluded), so the type height
 * and the margins keep their share of the picture however the window or the full screen changes.
 */
export function SubtitleLayer(props: {
  video: HTMLVideoElement | null;
  cues: readonly SubtitleCue[];
  secondaryCues: readonly SubtitleCue[];
  style: SubtitleStyle;
  /** The element clock may start later than the file's: cue times are the file's. */
  originMs?: number;
  /** The height of controls laid over the bottom of the frame: the dialogue is kept above it and nothing else moves. */
  lift?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const { frame, natural } = useGeometry(root, props.video);
  const showing = useShowing(props.video, props.cues, props.secondaryCues, props.originMs ?? 0);
  const layout = liftDialogue(layoutSubtitles(frame, natural, props.style), frame.h, props.lift ?? 0);
  const family = SUBTITLE_FONT_STACKS[props.style.font];

  const dialogue: Array<{ key: string; text: string; size: "main" | "small" }> = [];
  const captions: Array<{ key: string; text: string }> = [];
  for (const [which, list] of [["m", showing.main], ["s", showing.second]] as const) {
    for (const cue of list) {
      const key = `${which}${cue.startMs}-${cue.endMs}`;
      if (cue.top) cue.lines.forEach((text, index) => captions.push({ key: `${key}:${index}`, text }));
      else if (which === "m") arrangeLines(cue.lines).forEach((line, index) => dialogue.push({ key: `${key}:${index}`, text: line.text, size: line.small ? "small" : "main" }));
      else cue.lines.forEach((text, index) => dialogue.push({ key: `${key}:${index}`, text, size: "small" }));
    }
  }

  return (
    <div ref={root} className="subtitle-layer" data-testid="subtitle-layer" data-outline={props.style.outline ? "on" : "off"} data-place={layout.place} data-lift={props.lift ? Math.round(props.lift) : undefined} style={{ fontFamily: family }}>
      {frame.w > 0 && layout.picture.w > 0 ? (
        <>
          <div className="subtitle-picture" data-testid="subtitle-picture" style={boxStyle(layout.picture)} aria-hidden="true" />
          <div className="subtitle-zone" data-zone="dialogue" data-place={layout.place} data-testid="subtitle-zone-dialogue" style={boxStyle(layout.dialogue)}>
            {dialogue.map((line) => (
              <p key={line.key} className="subtitle-line" data-size={line.size} data-testid="subtitle-line" style={{ fontSize: px(line.size === "main" ? layout.mainPx : layout.smallPx) }}><span>{line.text}</span></p>
            ))}
          </div>
          <div className="subtitle-zone" data-zone="top" data-testid="subtitle-zone-top" style={boxStyle(layout.top)}>
            {captions.map((line) => (
              <p key={line.key} className="subtitle-line" data-size="top" data-testid="subtitle-caption" style={{ fontSize: px(layout.topPx) }}><span>{line.text}</span></p>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
