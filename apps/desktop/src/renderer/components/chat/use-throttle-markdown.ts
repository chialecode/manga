import { useEffect, useRef, useState } from "react";

const MAX_THROTTLE_MS = 2000;
const MIN_THROTTLE_MS = 16;

/**
 * Adaptive render-cost Markdown throttler for streaming answers.
 * Measures actual commit duration and spaces the next Markdown re-parse by `min(2000ms, renderCost * 2)`,
 * keeping frames smooth on very long replies while flushing immediately once streaming ends (`!live`).
 */
export function useThrottleMarkdownRender(text: string, live: boolean): string {
  const [rendered, setRendered] = useState(text);
  const nextAllowedAt = useRef(0);
  const renderStart = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const latestText = useRef(text);
  latestText.current = text;

  useEffect(() => {
    if (!live) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      nextAllowedAt.current = 0;
      setRendered(text);
      return;
    }

    const now = performance.now();
    const wait = Math.max(0, nextAllowedAt.current - now);
    if (wait <= 0) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      renderStart.current = now;
      setRendered(text);
      return;
    }

    if (timer.current === undefined) {
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        renderStart.current = performance.now();
        setRendered(latestText.current);
      }, wait);
    }
  }, [text, live]);

  // Measure the render-to-effect commit cost for each throttled update.
  useEffect(() => {
    if (!live || renderStart.current === 0) return;
    const cost = Math.max(0, performance.now() - renderStart.current);
    renderStart.current = 0;
    const delay = Math.min(MAX_THROTTLE_MS, Math.max(MIN_THROTTLE_MS, Math.round(cost * 2)));
    nextAllowedAt.current = performance.now() + delay;
  }, [rendered, live]);

  useEffect(() => () => {
    window.clearTimeout(timer.current);
  }, []);

  return live ? rendered : text;
}
