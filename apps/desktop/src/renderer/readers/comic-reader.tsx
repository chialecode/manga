import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Columns2, Crop, Maximize2, Minimize2, Minus, MoreHorizontal, Pause, Play, Plus, ScrollText, Square } from "lucide-react";
import type { Translator } from "@manga/i18n";
import type { SourceCard } from "../lib/types.ts";
import {
  buildSpreads, comicKeyAction, effectiveAnimation, pageBoxes, prefetchPages, spreadIndexOf, stepSpread, stripLayout, tapAction, topPageOfStrip, visibleStripRange, visualOrder,
  type ComicAnimation, type ComicDirection, type ComicFit, type ComicLayout, type ComicPageInfo, type Region, type Size,
} from "./comic-model.ts";
import { ComicPageView } from "./comic-page.tsx";
import { SourceBanner } from "./source-banner.tsx";
import { isTypingTarget, useFullscreen, usePrefersReducedMotion } from "./use-fullscreen.ts";
import { usePageSources } from "./use-page-sources.ts";
import { captureBus } from "../voice/capture-bus.ts";
import { readerContext } from "../lib/reader-context.ts";
import { quoteTags, useQuoteTags } from "../lib/quote-tags.ts";

type T = Translator["t"];

export type ComicDoc = {
  resourceId: string;
  revisionId: string;
  title: string;
  /** The book's own reading direction when it declares one (ComicInfo). */
  direction: ComicDirection | null;
  /** The work this book belongs to, when it has one; the Agent pane lists related works from it. */
  workId?: string | null;
  available: boolean;
  warnings: string[];
  pages: ComicPageInfo[];
};

export type ComicSettings = {
  direction: ComicDirection;
  layout: ComicLayout;
  coverAlone: boolean;
  fit: ComicFit;
  zoom: number;
  autoFlipSeconds: number;
  animation: ComicAnimation;
};

/** Where a note's source points: the page, and the region of it when the note framed one. `nonce` re-applies the same target. */
export type ComicFocus = { pageId: string; region?: Region; nonce: number };

const FALLBACK_VIEWPORT: Size = { width: 1000, height: 700 };
const STAGE_PADDING = 16;
const STRIP_GAP = 8;
const PROGRESS_DELAY_MS = 700;
const ZOOM_STEP = 0.25;

export function ComicReader(props: {
  t: T;
  doc: ComicDoc;
  settings: ComicSettings;
  onSettings: (patch: Partial<ComicSettings>) => void;
  startPageId?: string | null;
  focus?: ComicFocus | null;
  sourceCard?: SourceCard | null;
  next?: { resourceId: string; title: string } | null;
  onBack: () => void;
  onNext: () => void;
  /** The pages now on screen, in reading order. The host records them as read once the reader has stayed. */
  /** `consumed: false` keeps only the place, for leaving before the pages have counted as read; the book is named then because the host may already have let go of it. */
  onPage: (pageIds: string[], consumed?: boolean, book?: { resourceId: string; revisionId: string }) => void;
  onBackToNote: () => void;
  onRepair: () => void;
}) {
  const { t, doc, settings } = props;
  const pages = doc.pages;
  const direction: ComicDirection = doc.direction ?? settings.direction;
  const layout = settings.layout;
  const [directionOverride, setDirectionOverride] = useState<ComicDirection | null>(null);
  const reading = directionOverride ?? direction;
  const reduced = usePrefersReducedMotion();
  const animation = effectiveAnimation(settings.animation, reduced);

  const root = useRef<HTMLElement>(null);
  /** The frame is sized by the layout alone; it is what gets measured. The stage inside it scrolls and holds the pages. */
  const frame = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const { fullscreen, toggle: toggleFullscreen } = useFullscreen(root);
  const [viewport, setViewport] = useState<Size>(FALLBACK_VIEWPORT);
  const [scrollTop, setScrollTop] = useState(0);
  const [pageIndex, setPageIndex] = useState(() => {
    const found = props.startPageId ? pages.findIndex((page) => page.id === props.startPageId) : -1;
    return Math.max(0, found);
  });
  const [step, setStep] = useState<1 | -1>(1);
  const [selecting, setSelecting] = useState(false);
  // A framed region is a quote tag for the right pane (the reader only reads); the frame stays drawn while that tag is there.
  const [drawn, setDrawn] = useState<{ pageIndex: number; region: Region } | null>(null);
  const tags = useQuoteTags(doc.resourceId);
  const draft = drawn && tags.some((tag) => tag.kind === "region" && tag.pageId === pages[drawn.pageIndex]?.id) ? drawn : null;
  const [highlight, setHighlight] = useState<{ pageIndex: number; region: Region } | null>(null);
  const [autoOn, setAutoOn] = useState(false);
  const [ended, setEnded] = useState(false);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState<Record<string, true>>({});
  const retried = useRef(new Set<string>());
  // A page that was forgotten is asked for again on the next pass.
  const [tick, setTick] = useState(0);

  const spreads = useMemo(() => buildSpreads(pages, layout, settings.coverAlone), [pages, layout, settings.coverAlone]);
  const spreadIndex = Math.max(0, spreadIndexOf(spreads, pageIndex));
  const spread = spreads[spreadIndex];
  const strip = layout === "strip";

  const ids = useMemo(() => pages.map((page) => page.id), [pages]);
  const { sources, load, forget } = usePageSources({ resourceId: doc.resourceId, revisionId: doc.revisionId, pageIds: ids }, strip ? 40 : 24);

  // The frame's size drives every fit. It is not changed by what the stage holds, so a page that is bigger or smaller than the
  // frame (zoom) cannot change the size the next page is fitted to. Before it is measured (and in a test with no layout) a plain window is assumed.
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => {
      // The stage keeps the room of a classic scrollbar whether or not one is shown (scrollbar-gutter in the stylesheet), so what it takes
      // is the same for every page and is taken off here; the fit never depends on what the stage holds.
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

  const stripWidth = useMemo(() => {
    if (!strip) return 0;
    const natural = pages.find((page) => page.width > 0)?.width ?? 800;
    return Math.max(120, Math.round((settings.fit === "original" ? natural : Math.min(viewport.width, 960)) * settings.zoom));
  }, [strip, pages, settings.fit, settings.zoom, viewport.width]);
  const stripBoxes = useMemo(() => (strip ? stripLayout(pages, stripWidth, STRIP_GAP) : null), [strip, pages, stripWidth]);

  // ---- the recorder hears which page this is, as soon as it changes ----
  const announcedPage = useRef<string | null>(null);
  const currentPageId = pages[pageIndex]?.id ?? null;
  useEffect(() => {
    if (!currentPageId) return;
    const first = announcedPage.current === null;
    announcedPage.current = currentPageId;
    captureBus.emit({ reason: first ? "resource_change" : "page", resourceId: doc.resourceId, resourceRevisionId: doc.revisionId, locator: { kind: "image", pageId: currentPageId } });
  }, [currentPageId, doc.resourceId, doc.revisionId]);
  useEffect(() => () => captureBus.clear(doc.resourceId), [doc.resourceId]);

  // ---- the Agent's right pane hears the page too, to offer it as context ----
  useEffect(() => {
    if (!currentPageId) return;
    readerContext.set({ kind: "comic", resourceId: doc.resourceId, revisionId: doc.revisionId, title: doc.title, workId: doc.workId ?? null, pageId: currentPageId, pageNumber: pageIndex + 1, pageCount: pages.length });
  }, [currentPageId, pageIndex, pages.length, doc.resourceId, doc.revisionId, doc.title, doc.workId]);
  useEffect(() => () => { readerContext.clear(doc.resourceId); quoteTags.clearFor(doc.resourceId); }, [doc.resourceId]);

  // ---- loading: the shown pages first, then a few ahead and one behind ----
  useEffect(() => {
    if (!pages.length) return;
    if (strip && stripBoxes) {
      const range = visibleStripRange(stripBoxes.tops, stripBoxes.heights, scrollTop, viewport.height, viewport.height);
      const want = Array.from({ length: Math.max(0, range.last - range.first + 1) }, (_, offset) => range.first + offset);
      void load(want);
      return;
    }
    if (!spread) return;
    let stale = false;
    const shown = spread.pages;
    const ahead = prefetchPages(spreads, spreadIndex);
    void load(shown, [...shown, ...ahead]).then(() => { if (!stale) return load(ahead, [...shown, ...ahead]); });
    return () => { stale = true; };
  }, [pages.length, strip, stripBoxes, scrollTop, viewport.height, spread, spreads, spreadIndex, load, tick]);

  // ---- progress: record the pages on screen once the reader has stayed on them ----
  const onPage = useRef(props.onPage);
  onPage.current = props.onPage;
  const bookRef = useRef(props.doc);
  bookRef.current = props.doc;
  const lastShown = useRef<string[]>([]);
  const recordedKey = useRef("");
  useEffect(() => {
    if (!pages.length) return;
    const shown = (strip ? [pageIndex] : (spread ? visualOrder(spread, "ltr") : [])).map((index) => pages[index]!.id);
    lastShown.current = shown;
    const timer = window.setTimeout(() => { recordedKey.current = shown.join(); onPage.current(shown); }, PROGRESS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pageIndex, strip, spread, pages]);
  // Leaving before the delay is over still keeps the place, though the pages do not count as read.
  useEffect(() => () => {
    const shown = lastShown.current;
    if (shown.length && recordedKey.current !== shown.join()) onPage.current(shown, false, { resourceId: bookRef.current.resourceId, revisionId: bookRef.current.revisionId });
  }, []);

  // ---- navigation ----
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
      const target = Math.min(pages.length - 1, Math.max(0, pageIndex + delta));
      if (delta > 0 && pageIndex >= pages.length - 1) { setEnded(true); return; }
      jump(target);
      return;
    }
    const nextSpread = stepSpread(spreads, spreadIndex, delta);
    if (nextSpread === spreadIndex) {
      if (delta > 0) setEnded(true);
      return;
    }
    setEnded(false);
    setStep(delta);
    setPageIndex(spreads[nextSpread]!.pages[0]!);
    stage.current?.scrollTo?.(0, 0);
  }, [pages.length, strip, pageIndex, spreads, spreadIndex, jump]);

  // A key or a timer reads the latest navigation without re-binding.
  const latest = useRef({ go, jump, ended, next: props.next, onNext: props.onNext, settings, onSettings: props.onSettings, toggleFullscreen });
  latest.current = { go, jump, ended, next: props.next, onNext: props.onNext, settings, onSettings: props.onSettings, toggleFullscreen };

  useEffect(() => {
    // Leaving strip mode and coming back must land on the same page.
    if (strip && stage.current && stripBoxes) {
      stage.current.scrollTop = stripBoxes.tops[pageIndex] ?? 0;
      setScrollTop(stage.current.scrollTop);
    }
    // Only a layout change repositions; scrolling itself moves the page index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strip, stripWidth]);

  // Reaching a note's source: show the page, and the region when it framed one.
  useEffect(() => {
    const focus = props.focus;
    if (!focus) return;
    const index = pages.findIndex((page) => page.id === focus.pageId);
    if (index < 0) return;
    latest.current.jump(index);
    setHighlight(focus.region ? { pageIndex: index, region: focus.region } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.nonce, props.focus?.pageId, pages]);

  // The source highlight belongs to its page; turning away from it removes it.
  useEffect(() => {
    if (!highlight) return;
    const visible = strip ? Math.abs(highlight.pageIndex - pageIndex) <= 1 : spread?.pages.includes(highlight.pageIndex);
    if (!visible) setHighlight(null);
  }, [highlight, strip, pageIndex, spread]);

  const onStripScroll = (event: { currentTarget: HTMLDivElement }) => {
    if (!stripBoxes) return;
    const top = event.currentTarget.scrollTop;
    setScrollTop(top);
    const index = topPageOfStrip(stripBoxes.tops, stripBoxes.heights, top);
    setPageIndex((current) => (current === index ? current : index));
  };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      const action = comicKeyAction(event, reading, layout);
      if (!action) return;
      const current = latest.current;
      if (action === "next") {
        if (current.ended && current.next) current.onNext();
        else current.go(1);
      } else if (action === "prev") current.go(-1);
      else if (action === "first") current.jump(0);
      else if (action === "last") current.jump(pages.length - 1);
      else if (action === "zoomIn") current.onSettings({ zoom: Math.min(4, round(current.settings.zoom + ZOOM_STEP)) });
      else if (action === "zoomOut") current.onSettings({ zoom: Math.max(0.25, round(current.settings.zoom - ZOOM_STEP)) });
      else if (action === "zoomReset") current.onSettings({ zoom: 1 });
      else if (action === "fullscreen") current.toggleFullscreen();
      else if (action === "escape") { setSelecting(false); setDrawn(null); setEnded(false); }
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reading, layout, pages.length]);

  // ---- auto flip ----
  useEffect(() => {
    if (!autoOn || settings.autoFlipSeconds <= 0 || selecting || draft) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const current = latest.current;
      if (current.ended) { setAutoOn(false); return; }
      current.go(1);
    }, settings.autoFlipSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [autoOn, settings.autoFlipSeconds, selecting, draft]);
  useEffect(() => { if (ended) setAutoOn(false); }, [ended]);

  // ---- page sources that failed to show ----
  const onFail = useCallback((pageId: string) => {
    // One quiet retry with a fresh handle (an expired one is the usual cause); a second failure shows the placeholder.
    if (!retried.current.has(pageId)) {
      retried.current.add(pageId);
      forget(pageId);
      setTick((value) => value + 1);
      return;
    }
    setFailed((current) => ({ ...current, [pageId]: true }));
  }, [forget]);
  const onRetry = useCallback((pageId: string) => {
    retried.current.delete(pageId);
    setFailed((current) => {
      const next = { ...current };
      delete next[pageId];
      return next;
    });
    forget(pageId);
    setTick((value) => value + 1);
  }, [forget]);
  useEffect(() => { setFailed({}); retried.current.clear(); }, [doc.revisionId]);

  const onRegion = useCallback((index: number, region: Region) => {
    setDrawn({ pageIndex: index, region });
    quoteTags.put({ kind: "region", resourceId: doc.resourceId, revisionId: doc.revisionId, pageId: pages[index]!.id, pageNumber: index + 1, region, label: t("chat.tag.region", { page: index + 1 }) });
  }, [doc.resourceId, doc.revisionId, pages, t]);

  // ---- render ----
  const boxes = spread ? pageBoxes(settings.fit, spread.pages.map((index) => pages[index]!), viewport, settings.zoom) : [];
  const visual = spread ? visualOrder(spread, reading) : [];
  const total = pages.length;
  const shownPages = strip ? [pageIndex] : (spread?.pages ?? []);
  const first = (shownPages[0] ?? 0) + 1;
  const last = (shownPages[shownPages.length - 1] ?? 0) + 1;
  const position = shownPages.length > 1 ? t("comic.positionPair", { from: first, to: last, total }) : t("comic.position", { page: first, total });
  const missingCount = pages.filter((page) => !page.ok).length;
  const atLast = pageIndex >= total - 1 || (!strip && spreadIndex >= spreads.length - 1);
  const rtl = reading === "rtl";
  const prevButton = (
    <button type="button" className="icon-button" data-testid="comic-prev" aria-label={t("comic.prevPage")} title={t("comic.prevPage")} disabled={pageIndex <= 0} onClick={() => go(-1)}>
      {rtl ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
    </button>
  );
  const nextButton = (
    <button type="button" className="icon-button" data-testid="comic-next" aria-label={t("comic.nextPage")} title={t("comic.nextPage")} disabled={atLast && !props.next} onClick={() => (ended && props.next ? props.onNext() : go(1))}>
      {rtl ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
    </button>
  );
  const pageView = (index: number, size: Size) => (
    <ComicPageView
      key={pages[index]!.id}
      t={t}
      page={pages[index]!}
      source={sources[pages[index]!.id]}
      failed={failed[pages[index]!.id] === true}
      size={size}
      selecting={selecting}
      highlight={highlight?.pageIndex === index ? highlight.region : null}
      draft={draft?.pageIndex === index ? draft.region : null}
      onRegion={onRegion}
      onFail={onFail}
      onRetry={onRetry}
    />
  );

  return (
    <section ref={root} className="reader comic-reader" data-testid="comic-reader" data-direction={reading} data-layout={layout} data-fit={settings.fit} data-fullscreen={fullscreen || undefined}>
      <header className="reader-top">
        <button type="button" className="icon-button" data-testid="comic-back" aria-label={t("common.back")} title={t("common.back")} onClick={props.onBack}><ArrowLeft size={18} /></button>
        <div className="reader-heading">
          <h1 className="truncate" data-testid="comic-title">{doc.title}</h1>
          <span className="chip">{t("shelf.kind.comic")}</span>
          <span className="reader-chapter" data-testid="comic-position" aria-live="polite">{position}</span>
        </div>
        <span className="flex-1" />
        <div className="reader-tools" role="toolbar" aria-label={t("comic.toolbar")} data-testid="comic-toolbar">
          <form
            className="comic-jump"
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(new FormData(event.currentTarget).get("page"));
              if (Number.isFinite(value) && value >= 1) jump(Math.floor(value) - 1);
            }}
          >
            <input name="page" type="number" min={1} max={Math.max(1, total)} placeholder={String(first)} aria-label={t("comic.pageInput")} data-testid="comic-page-input" />
            <button type="submit" className="secondary-button" data-testid="comic-page-go">{t("comic.pages")}</button>
          </form>
          {rtl ? nextButton : prevButton}
          {rtl ? prevButton : nextButton}
          <button type="button" className="icon-button" data-testid="comic-region-tool" aria-pressed={selecting} aria-label={t("comic.regionTool")} title={t("comic.regionTool")} onClick={() => { setSelecting(!selecting); setDrawn(null); }}><Crop size={16} /></button>
          <button type="button" className="icon-button" data-testid="comic-fullscreen" aria-pressed={fullscreen} aria-label={t("comic.fullscreen")} title={t("comic.fullscreen")} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          <button type="button" className="icon-button" data-testid="comic-more-settings" aria-expanded={more} aria-label={t("comic.settings")} title={t("comic.settings")} onClick={() => setMore((open) => !open)}><MoreHorizontal size={18} /></button>
        </div>
        {more ? (
          <div className="reader-more reader-more-pop" data-testid="comic-more-panel">
            <div className="reader-group" role="group" aria-label={t("comic.layout")}>
              <button type="button" className="icon-button" data-testid="comic-layout-single" aria-pressed={layout === "single"} aria-label={t("comic.layoutSingle")} title={t("comic.layoutSingle")} onClick={() => props.onSettings({ layout: "single" })}><Square size={16} /></button>
              <button type="button" className="icon-button" data-testid="comic-layout-double" aria-pressed={layout === "double"} aria-label={t("comic.layoutDouble")} title={t("comic.layoutDouble")} onClick={() => props.onSettings({ layout: "double" })}><Columns2 size={16} /></button>
              <button type="button" className="icon-button" data-testid="comic-layout-strip" aria-pressed={layout === "strip"} aria-label={t("comic.layoutStrip")} title={t("comic.layoutStrip")} onClick={() => props.onSettings({ layout: "strip" })}><ScrollText size={16} /></button>
            </div>
            <button
              type="button"
              className="secondary-button"
              data-testid="comic-direction"
              data-direction={reading}
              aria-label={t("comic.direction")}
              title={t("comic.direction")}
              onClick={() => {
                const next: ComicDirection = reading === "rtl" ? "ltr" : "rtl";
                setDirectionOverride(next);
                props.onSettings({ direction: next });
              }}
            >{reading === "rtl" ? t("comic.dirRtl") : t("comic.dirLtr")}</button>
            <label className="reader-range">
              <input type="checkbox" data-testid="comic-cover-alone" checked={settings.coverAlone} disabled={layout !== "double"} onChange={(event) => props.onSettings({ coverAlone: event.target.checked })} />
              {t("comic.coverAlone")}
            </label>
            <div className="reader-group">
              <button type="button" className="icon-button" data-testid="comic-autoflip" aria-pressed={autoOn} aria-label={t("comic.autoFlip")} title={t("comic.autoFlip")} onClick={() => { if (!autoOn && settings.autoFlipSeconds <= 0) props.onSettings({ autoFlipSeconds: 5 }); setAutoOn(!autoOn); }}>{autoOn ? <Pause size={16} /> : <Play size={16} />}</button>
              <label className="reader-range">{t("comic.autoFlipSeconds")}
                <input type="number" min={0} max={120} step={1} data-testid="comic-autoflip-seconds" value={settings.autoFlipSeconds} onChange={(event) => props.onSettings({ autoFlipSeconds: Math.min(120, Math.max(0, Number(event.target.value) || 0)) })} />
              </label>
            </div>
            <label className="reader-range">{t("comic.animation")}
              <select data-testid="comic-animation" value={settings.animation} onChange={(event) => props.onSettings({ animation: event.target.value as ComicAnimation })}>
                <option value="fade">{t("comic.animFade")}</option>
                <option value="slide">{t("comic.animSlide")}</option>
                <option value="none">{t("comic.animNone")}</option>
              </select>
            </label>
          </div>
        ) : null}
      </header>

      {props.sourceCard ? <SourceBanner t={t} card={props.sourceCard} testPrefix="comic" onBackToNote={props.onBackToNote} onRepair={props.onRepair} /> : null}
      {!doc.available ? (
        <p className="reader-notice" role="status" data-testid="comic-original-missing">{t("comic.originalMissing")} <button type="button" className="link-button" data-testid="comic-original-repair" onClick={props.onRepair}>{t("reading.sourceRepair")}</button></p>
      ) : null}
      {missingCount > 0 ? <p className="reader-notice" role="status" data-testid="comic-warning">{t("comic.warnPages", { count: missingCount })}</p> : null}
      {selecting ? (
        <p className="reader-notice comic-region-bar" role="status" data-testid="comic-region-bar">
          <span data-testid="comic-region-hint">{draft ? t("comic.regionTagged") : t("comic.regionHint")}</span>
          <button type="button" className="secondary-button" data-testid="comic-region-cancel" onClick={() => { setSelecting(false); setDrawn(null); }}>{draft ? t("comic.regionDone") : t("comic.regionCancel")}</button>
        </p>
      ) : null}

      <div ref={frame} className="comic-frame" data-testid="comic-frame">
      <div
        ref={stage}
        className="comic-stage"
        data-testid="comic-stage"
        data-selecting={selecting || undefined}
        onScroll={strip ? onStripScroll : undefined}
        onClick={(event) => {
          if (strip || selecting || event.target instanceof HTMLButtonElement) return;
          const box = event.currentTarget.getBoundingClientRect();
          const action = tapAction(event.clientX - box.left, box.width, reading);
          if (action === "next") { if (ended && props.next) props.onNext(); else go(1); } else if (action === "prev") go(-1);
        }}
      >
        {total === 0 ? <p className="detail-muted comic-empty" data-testid="comic-empty">{t("comic.empty")}</p> : null}
        {total > 0 && strip && stripBoxes ? (
          <div className="comic-strip" data-testid="comic-strip" style={{ height: stripBoxes.total, width: stripWidth }}>
            {(() => {
              const range = visibleStripRange(stripBoxes.tops, stripBoxes.heights, scrollTop, viewport.height, viewport.height);
              const out: ReactNode[] = [];
              for (let index = range.first; index <= range.last; index += 1) {
                out.push(<div key={pages[index]!.id} className="comic-strip-slot" style={{ top: stripBoxes.tops[index], height: stripBoxes.heights[index] }}>{pageView(index, { width: stripWidth, height: stripBoxes.heights[index]! })}</div>);
              }
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
        {ended ? (
          <div className="comic-end" role="status" data-testid="comic-end">
            <p>{t("comic.lastPage")}</p>
            {props.next ? <button type="button" className="primary-button" data-testid="comic-end-next" onClick={props.onNext}>{t("comic.nextChapter", { title: props.next.title })}</button> : null}
            <button type="button" className="secondary-button" data-testid="comic-end-back" onClick={props.onBack}>{t("common.back")}</button>
          </div>
        ) : null}
      </div>

      <footer className="comic-footer" data-testid="comic-footer">
        <span className="comic-footer-title truncate" data-testid="comic-footer-title">{doc.title}</span>
        <span className="comic-footer-page" data-testid="comic-footer-page" aria-live="polite">{position}</span>
        <input
          type="range"
          className="comic-slider"
          data-testid="comic-slider"
          aria-label={t("comic.pageSlider")}
          min={1}
          max={Math.max(1, total)}
          value={Math.min(pageIndex + 1, Math.max(1, total))}
          dir={rtl ? "rtl" : "ltr"}
          disabled={total <= 1}
          onChange={(event) => jump(Number(event.target.value) - 1)}
        />
        <div className="reader-group comic-view" role="group" aria-label={t("comic.view")}>
          <label className="reader-group">
            <span className="sr-only">{t("comic.fit")}</span>
            <select data-testid="comic-fit" value={settings.fit} onChange={(event) => props.onSettings({ fit: event.target.value as ComicFit })}>
              <option value="page">{t("comic.fitPage")}</option>
              <option value="width">{t("comic.fitWidth")}</option>
              <option value="height">{t("comic.fitHeight")}</option>
              <option value="original">{t("comic.fitOriginal")}</option>
            </select>
          </label>
          <button type="button" className="icon-button" data-testid="comic-zoom-out" aria-label={t("comic.zoomOut")} title={t("comic.zoomOut")} disabled={settings.zoom <= 0.25} onClick={() => props.onSettings({ zoom: Math.max(0.25, round(settings.zoom - ZOOM_STEP)) })}><Minus size={16} /></button>
          <button type="button" className="reader-size zoom-value" data-testid="comic-zoom-value" aria-label={t("comic.zoomReset")} title={t("comic.zoomReset")} onClick={() => props.onSettings({ zoom: 1 })}>{t("comic.zoomValue", { percent: Math.round(settings.zoom * 100) })}</button>
          <button type="button" className="icon-button" data-testid="comic-zoom-in" aria-label={t("comic.zoomIn")} title={t("comic.zoomIn")} disabled={settings.zoom >= 4} onClick={() => props.onSettings({ zoom: Math.min(4, round(settings.zoom + ZOOM_STEP)) })}><Plus size={16} /></button>
        </div>
        {props.next ? <button type="button" className="secondary-button" data-testid="comic-next-chapter" onClick={props.onNext}>{t("comic.nextChapter", { title: props.next.title })}</button> : null}
      </footer>
    </section>
  );
}

const round = (value: number) => Math.round(value * 100) / 100;
