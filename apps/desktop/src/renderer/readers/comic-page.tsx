import { useEffect, useRef, useState } from "react";
import type { Translator } from "@manga/i18n";
import { MAX_CANVAS_PIXELS, openPdfDocument, type PdfPageProxy } from "./pdf-doc.ts";
import { regionFromPoints, regionStyle, type ComicPageInfo, type Region, type Size } from "./comic-model.ts";
import type { PageSource } from "./use-page-sources.ts";

type T = Translator["t"];

/** One PDF page painted onto a canvas at the size it is shown, from the shared document. */
function PdfCanvas(props: { url: string; pageNumber: number; width: number; height: number; onError: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const onError = useRef(props.onError);
  onError.current = props.onError;
  useEffect(() => {
    let dead = false;
    let rendering: { cancel: () => void } | undefined;
    let page: PdfPageProxy | undefined;
    (async () => {
      try {
        const doc = await openPdfDocument(props.url);
        page = await doc.getPage(Math.min(Math.max(props.pageNumber, 1), doc.numPages));
        if (dead || !canvas.current) return;
        const base = page.getViewport({ scale: 1 });
        const ratio = window.devicePixelRatio || 1;
        let scale = (props.width / base.width) * ratio;
        const pixels = base.width * scale * base.height * scale;
        if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const viewport = page.getViewport({ scale });
        canvas.current.width = Math.ceil(viewport.width);
        canvas.current.height = Math.ceil(viewport.height);
        const task = page.render({ canvas: canvas.current, viewport });
        rendering = task;
        await task.promise;
      } catch (error) {
        // A cancelled render is the page leaving the screen, not a failure.
        const name = (error as { name?: string } | undefined)?.name;
        if (!dead && name !== "RenderingCancelledException") onError.current();
      }
    })();
    return () => {
      dead = true;
      rendering?.cancel();
      page?.cleanup();
    };
  }, [props.url, props.pageNumber, Math.round(props.width)]);
  return <canvas ref={canvas} className="comic-pdf" style={{ width: props.width, height: props.height }} />;
}

/**
 * One page of the reader: the image (or PDF canvas), a placeholder while it loads or when it cannot be shown, the stored
 * source region, a pending selection and, while selecting, the layer that turns a drag into a region of this page.
 */
export function ComicPageView(props: {
  t: T;
  page: ComicPageInfo;
  source: PageSource | undefined;
  failed: boolean;
  size: Size;
  selecting: boolean;
  /** The region a note points at, drawn on this page. */
  highlight: Region | null;
  /** The region the reader has framed and not yet turned into a note. */
  draft: Region | null;
  onRegion: (pageIndex: number, region: Region) => void;
  onFail: (pageId: string) => void;
  onRetry: (pageId: string) => void;
}) {
  const { t, page, source, size } = props;
  const [live, setLive] = useState<Region | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const point = (event: { clientX: number; clientY: number }) => {
    const box = layer.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0), box: { width: box?.width || size.width, height: box?.height || size.height } };
  };
  const finish = (event: { clientX: number; clientY: number }) => {
    const from = start.current;
    start.current = null;
    setLive(null);
    if (!from) return;
    const to = point(event);
    const region = regionFromPoints(from, to, to.box);
    if (region) props.onRegion(page.index, region);
  };

  const missing = !page.ok || props.failed || source?.state === "missing";
  const reason = !page.ok ? page.error : source?.state === "missing" ? source.reason : undefined;
  return (
    <div className="comic-page" data-testid={`comic-page-${page.index}`} data-page-id={page.id} data-state={missing ? "missing" : source ? "ready" : "loading"} style={{ width: size.width, height: size.height }}>
      {source?.state === "ready" && !props.failed && page.ok ? (
        source.kind === "pdf"
          ? <PdfCanvas url={source.url} pageNumber={source.pageNumber ?? page.index + 1} width={size.width} height={size.height} onError={() => props.onFail(page.id)} />
          : <img src={source.url} alt={t("comic.pageAlt", { page: page.index + 1 })} draggable={false} className="comic-image" onError={() => props.onFail(page.id)} />
      ) : null}
      {missing ? (
        <div className="comic-placeholder" role="status" data-testid={`comic-page-missing-${page.index}`}>
          <p>{t("comic.pageMissing")}</p>
          {reason ? <p className="detail-muted">{reason}</p> : null}
          {page.ok ? <button type="button" className="secondary-button" data-testid={`comic-page-retry-${page.index}`} onClick={() => props.onRetry(page.id)}>{t("comic.pageRetry")}</button> : null}
        </div>
      ) : null}
      {!missing && !source ? <div className="comic-placeholder comic-loading" aria-hidden="true"><span>{t("comic.pageLoading")}</span></div> : null}
      {props.highlight ? <div className="comic-region comic-region-source" data-testid="comic-source-highlight" title={t("comic.sourceRegion")} style={regionStyle(props.highlight)} /> : null}
      {props.draft ? <div className="comic-region comic-region-draft" data-testid="comic-region-rect" style={regionStyle(props.draft)} /> : null}
      {live ? <div className="comic-region comic-region-live" style={regionStyle(live)} /> : null}
      {props.selecting ? (
        <div
          ref={layer}
          className="comic-select-layer"
          data-testid={`comic-select-layer-${page.index}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const from = point(event);
            start.current = { x: from.x, y: from.y };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const from = start.current;
            if (!from) return;
            const to = point(event);
            setLive(regionFromPoints(from, to, to.box));
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            finish(event);
          }}
          onPointerCancel={() => { start.current = null; setLive(null); }}
        />
      ) : null}
    </div>
  );
}
