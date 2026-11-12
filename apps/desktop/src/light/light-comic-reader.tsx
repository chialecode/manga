import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Columns2, Fullscreen, Maximize2, Minimize2, Minus, MoreHorizontal, Plus, ScrollText, Shrink, SkipBack, SkipForward, Square } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { attempt } from "../renderer/lib/api.ts";
import { useKeyTable } from "../renderer/lib/key-table.tsx";
import {
  buildSpreads, comicKeyAction, effectiveAnimation, pageBoxes, prefetchPages, spreadIndexOf, stepSpread, stripLayout, tapAction, topPageOfStrip, visibleStripRange, visualOrder,
  type ComicDirection, type ComicFit, type ComicLayout, type ComicPageInfo, type Size,
} from "../renderer/readers/comic-model.ts";
import { ComicPageView } from "../renderer/readers/comic-page.tsx";
import { EditableNumber } from "../renderer/readers/editable-number.tsx";
import { isTypingTarget, useFullscreen, usePrefersReducedMotion } from "../renderer/readers/use-fullscreen.ts";
import { usePageSources } from "../renderer/readers/use-page-sources.ts";
import { useWindowFullscreen } from "../renderer/readers/window-fullscreen.tsx";
import { lightHost, type LightOpened } from "./light-host.ts";
import { readLightSettings, writeLightSettings } from "./light-settings.ts";

type T = Translator["t"];
type ComicOpened = Extract<LightOpened, { kind: "comic" }>;
type Book = { resourceId: string; revisionId: string; direction: ComicDirection | null; warnings: string[]; pages: ComicPageInfo[] };

export type LightComicSettings = { direction: ComicDirection; layout: ComicLayout; coverAlone: boolean; fit: ComicFit; zoom: number };
/** The full app's defaults (`DEFAULT_COMIC_SETTINGS`): right to left, one page, fitted to the page. */
export const LIGHT_COMIC_DEFAULTS: LightComicSettings = { direction: "rtl", layout: "single", coverAlone: true, fit: "page", zoom: 1 };

const FALLBACK_VIEWPORT: Size = { width: 1000, height: 700 };
const STAGE_PADDING = 16;
const STRIP_GAP = 8;
const POSITION_DELAY_MS = 500;
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const WHEEL_GESTURE_GAP_MS = 220;
const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Light open's comic reader (READ-05, 4.4): a CBZ/ZIP, or the folder of an opened picture starting at that picture, with the full app's page
 * model, page view and page sources. Turning pages, direction, one or two pages or a strip, fit and size, full screen, the page number and the
 * folder's previous and next book. No region tool, screenshots, notes, Agent or works.
 */
export function LightComicReader(props: { t: T; opened: ComicOpened; resume: unknown; onSibling: (direction: 1 | -1) => void }) {
  const { t, opened } = props;
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void attempt<Book>("comic.pages", { resourceId: opened.resourceId, revisionId: opened.revisionId }).then((result) => {
      if (!live) return;
      if (result.ok) setBook({ ...result.value, pages: Array.isArray(result.value.pages) ? result.value.pages : [], warnings: Array.isArray(result.value.warnings) ? result.value.warnings : [] });
      else setError(result.error.message);
    });
    return () => { live = false; };
  }, [opened.resourceId, opened.revisionId]);
  const resumePage = props.resume && typeof props.resume === "object" && "pageId" in props.resume ? String((props.resume as { pageId: string }).pageId) : null;
  if (error) return <div className="light-empty" data-testid="light-error" data-error="broken"><p className="light-empty-title" role="alert">{t("light.broken", { reason: error })}</p></div>;
  if (!book) return <div className="light-empty" data-testid="light-loading"><p className="light-empty-title">{t("light.opening")}</p></div>;
  return <LightComicView t={t} opened={opened} book={book} startPageId={resumePage ?? opened.startPageId} resumed={resumePage !== null} onSibling={props.onSibling} />;
}

function LightComicView(props: { t: T; opened: ComicOpened; book: Book; startPageId: string | null; resumed: boolean; onSibling: (direction: 1 | -1) => void }) {
  const { t, book, opened } = props;
  const host = lightHost();
  const pages = book.pages;
  const [settings, setSettings] = useState<LightComicSettings>(() => readLightSettings("comic", LIGHT_COMIC_DEFAULTS));
  const onSettings = useCallback((patch: Partial<LightComicSettings>) => {
    setSettings((current) => { const next = { ...current, ...patch }; writeLightSettings("comic", next); return next; });
  }, []);
  const [directionOverride, setDirectionOverride] = useState<ComicDirection | null>(null);
  const reading = directionOverride ?? book.direction ?? settings.direction;
  const layout = settings.layout;
  const animation = effectiveAnimation("fade", usePrefersReducedMotion());
  const zoom = settings.zoom;

  const root = useRef<HTMLElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLElement>(null);
  const [footerH, setFooterH] = useState(0);
  const { fullscreen, toggle: toggleFullscreen } = useFullscreen(root);
  const windowFull = useWindowFullscreen();
  const [viewport, setViewport] = useState<Size>(FALLBACK_VIEWPORT);
  const [scrollTop, setScrollTop] = useState(0);
  const [pageIndex, setPageIndex] = useState(() => Math.max(0, props.startPageId ? pages.findIndex((page) => page.id === props.startPageId) : 0));
  const [step, setStep] = useState<1 | -1>(1);
  const [ended, setEnded] = useState(false);
  const [more, setMore] = useState(false);
  const [resumedShown, setResumedShown] = useState(props.resumed);
  useEffect(() => { if (!resumedShown) return; const timer = window.setTimeout(() => setResumedShown(false), 2500); return () => window.clearTimeout(timer); }, [resumedShown]);
  const [failed, setFailed] = useState<Record<string, true>>({});
  const retried = useRef(new Set<string>());
  const [tick, setTick] = useState(0);

  const spreads = useMemo(() => buildSpreads(pages, layout, settings.coverAlone), [pages, layout, settings.coverAlone]);
  const spreadIndex = Math.max(0, spreadIndexOf(spreads, pageIndex));
  const spread = spreads[spreadIndex];
  const strip = layout === "strip";
  const ids = useMemo(() => pages.map((page) => page.id), [pages]);
  const { sources, load, forget } = usePageSources({ resourceId: book.resourceId, revisionId: book.revisionId, pageIds: ids }, strip ? 40 : 24);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => {
      const bar = stage.current ? Math.max(0, stage.current.offsetWidth - stage.current.clientWidth) : 0;
      const width = node.clientWidth - STAGE_PADDING - bar;
      const height = node.clientHeight - STAGE_PADDING;
      setViewport(width > 0 && height > 0 ? { width, height } : FALLBACK_VIEWPORT);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = footer.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setFooterH(node.offsetHeight));
    observer.observe(node);
    setFooterH(node.offsetHeight);
    return () => observer.disconnect();
  }, []);

  const stripWidth = useMemo(() => {
    if (!strip) return 0;
    const natural = pages.find((page) => page.width > 0)?.width ?? 800;
    return Math.max(120, Math.round((settings.fit === "original" ? natural : Math.min(viewport.width, 960)) * zoom));
  }, [strip, pages, settings.fit, zoom, viewport.width]);
  const stripBoxes = useMemo(() => (strip ? stripLayout(pages, stripWidth, STRIP_GAP) : null), [strip, pages, stripWidth]);

  useEffect(() => {
    if (!pages.length) return;
    if (strip && stripBoxes) {
      const range = visibleStripRange(stripBoxes.tops, stripBoxes.heights, scrollTop, viewport.height, viewport.height);
      void load(Array.from({ length: Math.max(0, range.last - range.first + 1) }, (_, offset) => range.first + offset));
      return;
    }
    if (!spread) return;
    let stale = false;
    const shown = spread.pages;
    const ahead = prefetchPages(spreads, spreadIndex);
    void load(shown, [...shown, ...ahead]).then(() => { if (!stale) return load(ahead, [...shown, ...ahead]); });
    return () => { stale = true; };
  }, [pages.length, strip, stripBoxes, scrollTop, viewport.height, spread, spreads, spreadIndex, load, tick]);

  // ---- the place: light open's own memory, a moment after the page settles, on leaving and when the main process asks ----
  const shownLast = strip ? pageIndex : (spread?.pages[spread.pages.length - 1] ?? pageIndex);
  const place = useRef({ pageIndex, shownLast });
  place.current = { pageIndex, shownLast };
  const report = useCallback(() => {
    const { pageIndex: index, shownLast: last } = place.current;
    const page = pages[index];
    if (!page) return Promise.resolve();
    return host?.position({ sessionId: opened.sessionId, kind: "comic", pageId: page.id, pageIndex: index, pageCount: pages.length, finished: last >= pages.length - 1 }) ?? Promise.resolve();
  }, [host, opened.sessionId, pages]);
  useEffect(() => {
    const timer = window.setTimeout(() => void report(), POSITION_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pageIndex, shownLast, report]);
  useEffect(() => host?.onSaveNow(report), [host, report]);
  useEffect(() => {
    const leave = () => { void report(); };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [report]);

  const scrollToPage = useCallback((index: number) => {
    const node = stage.current;
    if (!node || !stripBoxes) return;
    node.scrollTop = stripBoxes.tops[index] ?? 0;
    setScrollTop(node.scrollTop);
  }, [stripBoxes]);
  const jump = useCallback((index: number) => {
    const clamped = Math.min(Math.max(0, index), Math.max(0, pages.length - 1));
    setEnded(false);
    setStep(clamped >= pageIndex ? 1 : -1);
    setPageIndex(clamped);
    if (strip) scrollToPage(clamped);
  }, [pages.length, pageIndex, strip, scrollToPage]);
  const go = useCallback((delta: 1 | -1) => {
    if (!pages.length) return;
    if (strip) {
      if (delta > 0 && pageIndex >= pages.length - 1) { setEnded(true); return; }
      jump(Math.min(pages.length - 1, Math.max(0, pageIndex + delta)));
      return;
    }
    const nextSpread = stepSpread(spreads, spreadIndex, delta);
    if (nextSpread === spreadIndex) { if (delta > 0) setEnded(true); return; }
    setEnded(false);
    setStep(delta);
    setPageIndex(spreads[nextSpread]!.pages[0]!);
    stage.current?.scrollTo?.(0, 0);
  }, [pages.length, strip, pageIndex, spreads, spreadIndex, jump]);
  const latest = useRef({ go, jump, zoom, strip, onSettings, toggleFullscreen });
  latest.current = { go, jump, zoom, strip, onSettings, toggleFullscreen };

  // Leaving strip mode and coming back lands on the same page.
  useEffect(() => {
    if (strip && stage.current && stripBoxes) {
      stage.current.scrollTop = stripBoxes.tops[pageIndex] ?? 0;
      setScrollTop(stage.current.scrollTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strip, stripWidth]);
  const onStripScroll = (event: { currentTarget: HTMLDivElement }) => {
    if (!stripBoxes) return;
    const top = event.currentTarget.scrollTop;
    setScrollTop(top);
    const index = topPageOfStrip(stripBoxes.tops, stripBoxes.heights, top);
    setPageIndex((current) => (current === index ? current : index));
  };

  const keys = useKeyTable();
  const keysRef = useRef(keys);
  keysRef.current = keys;
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      const action = comicKeyAction(event, reading, layout, keysRef.current);
      if (!action) return;
      const current = latest.current;
      if (action === "next") current.go(1);
      else if (action === "prev") current.go(-1);
      else if (action === "first") current.jump(0);
      else if (action === "last") current.jump(pages.length - 1);
      else if (action === "zoomIn") current.onSettings({ zoom: Math.min(ZOOM_MAX, round(current.zoom + ZOOM_STEP)) });
      else if (action === "zoomOut") current.onSettings({ zoom: Math.max(ZOOM_MIN, round(current.zoom - ZOOM_STEP)) });
      else if (action === "zoomReset") current.onSettings({ zoom: 1 });
      else if (action === "fullscreen") current.toggleFullscreen();
      else if (action === "escape") setEnded(false);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reading, layout, pages.length]);

  // One page per wheel gesture; a page bigger than the window scrolls first (the full app's rule).
  const wheel = useRef({ lastAt: 0, fired: false });
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      const current = latest.current;
      if (event.ctrlKey) {
        event.preventDefault();
        current.onSettings({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, round(current.zoom * Math.exp(-event.deltaY * 0.0015)))) });
        return;
      }
      if (current.strip || event.defaultPrevented) return;
      if (Math.abs(event.deltaY) < 1 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const now = Date.now();
      const state = wheel.current;
      if (now - state.lastAt > WHEEL_GESTURE_GAP_MS) state.fired = false;
      state.lastAt = now;
      const down = event.deltaY > 0;
      const room = down ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0;
      if (room) { state.fired = true; return; }
      event.preventDefault();
      if (state.fired) return;
      state.fired = true;
      current.go(down ? 1 : -1);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const onFail = useCallback((pageId: string) => {
    if (!retried.current.has(pageId)) { retried.current.add(pageId); forget(pageId); setTick((value) => value + 1); return; }
    setFailed((current) => ({ ...current, [pageId]: true }));
  }, [forget]);
  const onRetry = useCallback((pageId: string) => {
    retried.current.delete(pageId);
    setFailed((current) => { const next = { ...current }; delete next[pageId]; return next; });
    forget(pageId);
    setTick((value) => value + 1);
  }, [forget]);

  const boxes = spread ? pageBoxes(settings.fit, spread.pages.map((index) => pages[index]!), viewport, zoom) : [];
  const visual = spread ? visualOrder(spread, reading) : [];
  const total = pages.length;
  const shownPages = strip ? [pageIndex] : (spread?.pages ?? []);
  const first = (shownPages[0] ?? 0) + 1;
  const last = (shownPages[shownPages.length - 1] ?? 0) + 1;
  const position = shownPages.length > 1 ? t("comic.positionPair", { from: first, to: last, total }) : t("comic.position", { page: first, total });
  const missingCount = pages.filter((page) => !page.ok).length;
  const atLast = pageIndex >= total - 1 || (!strip && spreadIndex >= spreads.length - 1);
  const rtl = reading === "rtl";
  const prevButton = <button type="button" className="icon-button" data-testid="comic-prev" aria-label={t("comic.prevPage")} title={t("comic.prevPage")} disabled={pageIndex <= 0} onClick={() => go(-1)}>{rtl ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}</button>;
  const nextButton = <button type="button" className="icon-button" data-testid="comic-next" aria-label={t("comic.nextPage")} title={t("comic.nextPage")} disabled={atLast} onClick={() => go(1)}>{rtl ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}</button>;
  const pageView = (index: number, size: Size) => (
    <ComicPageView key={pages[index]!.id} t={t} page={pages[index]!} source={sources[pages[index]!.id]} failed={failed[pages[index]!.id] === true} size={size} selecting={false} highlight={null} draft={null} onRegion={() => undefined} onFail={onFail} onRetry={onRetry} />
  );

  return (
    <section ref={root} className="reader comic-reader light-comic" data-testid="comic-reader" data-direction={reading} data-layout={layout} data-fit={settings.fit} data-page-index={pageIndex} data-fullscreen={fullscreen || undefined} data-window-full={(windowFull.active && !fullscreen) || undefined} data-immersive={fullscreen || windowFull.active || undefined} style={{ "--comic-footer-h": `${footerH}px` } as CSSProperties}>
      {missingCount > 0 ? <p className="reader-notice" role="status" data-testid="comic-warning">{t("comic.warnPages", { count: missingCount })}</p> : null}
      <div ref={frame} className="comic-frame" data-testid="comic-frame">
        <div ref={stage} className="comic-stage" data-testid="comic-stage" onScroll={strip ? onStripScroll : undefined} onClick={(event) => {
          if (strip || event.target instanceof HTMLButtonElement) return;
          const box = event.currentTarget.getBoundingClientRect();
          const action = tapAction(event.clientX - box.left, box.width, reading);
          if (action === "next") go(1); else if (action === "prev") go(-1);
        }}>
          {total === 0 ? <p className="detail-muted comic-empty" data-testid="comic-empty">{t("comic.empty")}</p> : null}
          {total > 0 && strip && stripBoxes ? (
            <div className="comic-strip" data-testid="comic-strip" style={{ height: stripBoxes.total, width: stripWidth }}>
              {(() => {
                const range = visibleStripRange(stripBoxes.tops, stripBoxes.heights, scrollTop, viewport.height, viewport.height);
                const out: ReactNode[] = [];
                for (let index = range.first; index <= range.last; index += 1) out.push(<div key={pages[index]!.id} className="comic-strip-slot" style={{ top: stripBoxes.tops[index], height: stripBoxes.heights[index] }}>{pageView(index, { width: stripWidth, height: stripBoxes.heights[index]! })}</div>);
                return out;
              })()}
            </div>
          ) : null}
          {total > 0 && !strip && spread ? (
            <div key={spreadIndex} className="comic-spread" data-testid="comic-spread" data-anim={animation} data-step={step > 0 ? "forward" : "back"} data-reading={reading}>
              {visual.map((index) => pageView(index, boxes[spread.pages.indexOf(index)] ?? { width: 200, height: 300 }))}
            </div>
          ) : null}
        </div>
        {resumedShown ? <span className="light-resumed light-resumed-comic" role="status" data-testid="light-resumed">{t("light.resumed")}</span> : null}
        {ended ? (
          <div className="comic-end" role="status" data-testid="comic-end">
            <p>{t("light.lastPage")}</p>
            {opened.siblings.next ? <button type="button" className="primary-button" data-testid="light-end-next" onClick={() => props.onSibling(1)}>{t("light.nextComic")}</button> : null}
          </div>
        ) : null}
      </div>
      <footer ref={footer} className="comic-footer" data-testid="comic-footer">
        <div className="reader-group comic-pager" role="group" aria-label={t("comic.pager")}>
          <button type="button" className="icon-button" data-testid="light-previous" aria-label={t("light.previousComic")} title={t("light.previousComic")} disabled={!opened.siblings.previous} onClick={() => props.onSibling(-1)}><SkipBack size={16} /></button>
          {rtl ? nextButton : prevButton}
          <EditableNumber testId="comic-position" inputTestId="comic-page-input" className="reader-position" display={position} value={first} max={Math.max(1, total)} disabled={total <= 0} label={t("comic.pageEdit", { position })} inputLabel={t("comic.pageInput")} onGo={(page) => jump(page - 1)} />
          {rtl ? prevButton : nextButton}
          <button type="button" className="icon-button" data-testid="light-next" aria-label={t("light.nextComic")} title={t("light.nextComic")} disabled={!opened.siblings.next} onClick={() => props.onSibling(1)}><SkipForward size={16} /></button>
        </div>
        <input type="range" className="comic-slider" data-testid="comic-slider" aria-label={t("comic.pageSlider")} min={1} max={Math.max(1, total)} value={Math.min(pageIndex + 1, Math.max(1, total))} dir={rtl ? "rtl" : "ltr"} disabled={total <= 1} onChange={(event) => jump(Number(event.target.value) - 1)} />
        <div className="reader-group comic-view" role="group" aria-label={t("comic.view")}>
          <label className="reader-group">
            <span className="sr-only">{t("comic.fit")}</span>
            <select data-testid="comic-fit" value={settings.fit} onChange={(event) => onSettings({ fit: event.target.value as ComicFit })}>
              <option value="page">{t("comic.fitPage")}</option>
              <option value="width">{t("comic.fitWidth")}</option>
              <option value="height">{t("comic.fitHeight")}</option>
              <option value="original">{t("comic.fitOriginal")}</option>
            </select>
          </label>
          <button type="button" className="icon-button" data-testid="comic-zoom-out" aria-label={t("comic.zoomOut")} title={t("comic.zoomOut")} disabled={zoom <= ZOOM_MIN} onClick={() => onSettings({ zoom: Math.max(ZOOM_MIN, round(zoom - ZOOM_STEP)) })}><Minus size={16} /></button>
          <button type="button" className="reader-size zoom-value" data-testid="comic-zoom-value" aria-label={t("comic.zoomReset")} title={t("comic.zoomReset")} onClick={() => onSettings({ zoom: 1 })}>{t("comic.zoomValue", { percent: Math.round(zoom * 100) })}</button>
          <button type="button" className="icon-button" data-testid="comic-zoom-in" aria-label={t("comic.zoomIn")} title={t("comic.zoomIn")} disabled={zoom >= ZOOM_MAX} onClick={() => onSettings({ zoom: Math.min(ZOOM_MAX, round(zoom + ZOOM_STEP)) })}><Plus size={16} /></button>
        </div>
        <div className="reader-group comic-tools" role="toolbar" aria-label={t("comic.toolbar")} data-testid="comic-toolbar">
          <button type="button" className="icon-button" data-testid="comic-window-fullscreen" aria-pressed={windowFull.active} aria-label={windowFull.active ? t("window.fullscreen.exit") : t("window.fullscreen")} title={windowFull.active ? t("window.fullscreen.exit") : t("window.fullscreen")} onClick={windowFull.toggle}>{windowFull.active ? <Shrink size={16} /> : <Fullscreen size={16} />}</button>
          <button type="button" className="icon-button" data-testid="comic-fullscreen" aria-pressed={fullscreen} aria-label={t("comic.fullscreen")} title={t("comic.fullscreen")} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          <button type="button" className="icon-button" data-testid="comic-more-settings" aria-expanded={more} aria-label={t("comic.settings")} title={t("comic.settings")} onClick={() => setMore((open) => !open)}><MoreHorizontal size={18} /></button>
        </div>
        {more ? (
          <div className="reader-more reader-more-pop reader-more-up" data-testid="comic-more-panel">
            <div className="reader-group" role="group" aria-label={t("comic.layout")}>
              <button type="button" className="icon-button" data-testid="comic-layout-single" aria-pressed={layout === "single"} aria-label={t("comic.layoutSingle")} title={t("comic.layoutSingle")} onClick={() => onSettings({ layout: "single" })}><Square size={16} /></button>
              <button type="button" className="icon-button" data-testid="comic-layout-double" aria-pressed={layout === "double"} aria-label={t("comic.layoutDouble")} title={t("comic.layoutDouble")} onClick={() => onSettings({ layout: "double" })}><Columns2 size={16} /></button>
              <button type="button" className="icon-button" data-testid="comic-layout-strip" aria-pressed={layout === "strip"} aria-label={t("comic.layoutStrip")} title={t("comic.layoutStrip")} onClick={() => onSettings({ layout: "strip" })}><ScrollText size={16} /></button>
            </div>
            <button type="button" className="secondary-button" data-testid="comic-direction" data-direction={reading} aria-label={t("comic.direction")} title={t("comic.direction")} onClick={() => { const next: ComicDirection = reading === "rtl" ? "ltr" : "rtl"; setDirectionOverride(next); onSettings({ direction: next }); }}>{reading === "rtl" ? t("comic.dirRtl") : t("comic.dirLtr")}</button>
            <label className="reader-range">
              <input type="checkbox" data-testid="comic-cover-alone" checked={settings.coverAlone} disabled={layout !== "double"} onChange={(event) => onSettings({ coverAlone: event.target.checked })} />
              {t("comic.coverAlone")}
            </label>
          </div>
        ) : null}
      </footer>
    </section>
  );
}
