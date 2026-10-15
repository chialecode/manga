import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { DanmakuItem, DanmakuSettings } from "@manga/contracts/danmaku";
import { createEngine, type EngineFactory } from "./danmaku-engine.ts";
import { danmakuMetrics, pictureRect, prepareDanmaku } from "./danmaku-model.ts";

type Rect = { left: number; top: number; width: number; height: number };
const NONE: Rect = { left: 0, top: 0, width: 0, height: 0 };
/** A resize that goes on (dragging a window edge) rebuilds the display once it settles, not at every step. */
const SETTLE_MS = 120;
/** Smaller than this there is nothing to draw on. */
const MIN_SIDE = 16;

const sameRect = (a: Rect, b: Rect) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

/**
 * The flying comments, laid over the picture (not over the bars around it) and under the subtitles and the controls. The `danmaku` engine draws them
 * on a canvas and follows the video element's own play, pause and seek (and its rate, unless the settings keep the speed on the screen); this layer builds it from the comments the settings show and builds it
 * again when the picture changes size, so full screen and window full screen need nothing more.
 */
export function DanmakuLayer(props: {
  media: HTMLVideoElement | null;
  items: readonly DanmakuItem[];
  settings: DanmakuSettings;
  /** Added to every comment's time: the person's offset for this episode. */
  offsetMs: number;
  /** Where the file's own clock starts, which is the clock of the video element. */
  originMs: number;
  visible: boolean;
  /** Receives a function that gives the canvas the comments are on at that moment (for a screenshot that keeps them), or `null`. */
  captureRef?: MutableRefObject<(() => HTMLCanvasElement | null) | null>;
  /** A stand-in for the engine, for a test without a canvas. */
  factory?: EngineFactory;
}) {
  const { media, settings, visible } = props;
  const host = useRef<HTMLDivElement>(null);
  const [picture, setPicture] = useState<Rect>(NONE);

  // The stage is the layer's parent; the picture is the part of it the video covers.
  useLayoutEffect(() => {
    const stage = host.current?.parentElement;
    if (!stage) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const next = pictureRect(stage.clientWidth, stage.clientHeight, media?.videoWidth ?? 0, media?.videoHeight ?? 0);
      setPicture((current) => (sameRect(current, next) ? current : next));
    };
    const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(measure, SETTLE_MS); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    observer?.observe(stage);
    media?.addEventListener("loadedmetadata", measure);
    media?.addEventListener("resize", later);
    return () => {
      if (timer) clearTimeout(timer);
      observer?.disconnect();
      media?.removeEventListener("loadedmetadata", measure);
      media?.removeEventListener("resize", later);
    };
  }, [media]);

  // What the engine is built from: the comments the settings show, in the video element's clock. Opacity and the area do not need a rebuild.
  const filterKey = JSON.stringify([settings.scroll, settings.top, settings.bottom, settings.color, settings.merge, settings.blockWords, settings.blockPatterns, settings.sourcesOff]);
  const prepared = useMemo(
    () => prepareDanmaku(props.items, settings, props.offsetMs, props.originMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.items, filterKey, props.offsetMs, props.originMs],
  );
  const areaHeight = Math.round(picture.height * settings.area);
  const { fontPx, speedPxPerS } = danmakuMetrics(picture.width, picture.height, settings);
  const { followRate } = settings;

  const { factory, captureRef } = props;
  useEffect(() => {
    const container = host.current;
    if (!container || !media || !visible || picture.width < MIN_SIDE || areaHeight < MIN_SIDE) return;
    const engine = (factory ?? createEngine)({ container, media, comments: prepared, fontPx, speedPxPerS, followRate });
    if (captureRef) captureRef.current = () => engine.canvas();
    return () => {
      if (captureRef) captureRef.current = null;
      engine.destroy();
    };
  }, [media, visible, prepared, fontPx, speedPxPerS, followRate, picture.width, areaHeight, factory, captureRef]);

  return (
    <div
      ref={host}
      className="danmaku-layer"
      data-testid="danmaku-layer"
      data-visible={visible || undefined}
      data-count={prepared.length}
      aria-hidden="true"
      style={{ left: picture.left, top: picture.top, width: picture.width, height: areaHeight, opacity: settings.opacity }}
    />
  );
}
