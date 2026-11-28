import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, ExternalLink, Globe, X } from "lucide-react";
import type { AgentCitation, AgentSearchStep, AgentServerToolStep } from "@manga/contracts";
import type { Translator } from "@manga/i18n";

type T = Translator["t"];

export type CitationSource = {
  index: number;
  url: string;
  title: string;
  site: string;
  siteIcon?: string;
  snippet?: string;
  publishedAt?: string;
};

export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function isSafeHref(url: string | undefined): url is string {
  if (!url) return false;
  return /^(https?:|mailto:)/i.test(url.trim());
}

export function openExternalLink(url: string): void {
  if (/^https?:\/\//i.test(url)) void window.manga?.openExternal?.(url);
}

/** Collects deduplicated 1-based citation sources from explicit `citations`, raw `search`, and aggregated `serverToolSteps`. */
export function collectSources(
  citations?: AgentCitation[],
  search?: AgentSearchStep[],
  serverToolSteps?: AgentServerToolStep[],
): CitationSource[] {
  const byUrl = new Map<string, CitationSource>();
  const add = (raw: {
    index?: number;
    url: string;
    title?: string;
    site?: string;
    siteIcon?: string;
    snippet?: string;
    publishedAt?: string;
  }) => {
    if (!raw.url) return;
    const existing = byUrl.get(raw.url);
    if (existing) {
      if (!existing.title && raw.title) existing.title = raw.title;
      if (!existing.siteIcon && raw.siteIcon) existing.siteIcon = raw.siteIcon;
      if (!existing.snippet && raw.snippet) existing.snippet = raw.snippet;
      if (!existing.publishedAt && raw.publishedAt) existing.publishedAt = raw.publishedAt;
      if (raw.index && raw.index > 0) existing.index = raw.index;
      return;
    }
    byUrl.set(raw.url, {
      index: raw.index && raw.index > 0 ? raw.index : byUrl.size + 1,
      url: raw.url,
      title: raw.title || siteOf(raw.url),
      site: raw.site || siteOf(raw.url),
      ...(raw.siteIcon ? { siteIcon: raw.siteIcon } : {}),
      ...(raw.snippet ? { snippet: raw.snippet } : {}),
      ...(raw.publishedAt ? { publishedAt: raw.publishedAt } : {}),
    });
  };

  for (const cite of citations ?? []) add(cite);
  for (const step of search ?? []) {
    if (step.kind === "done") {
      for (const item of step.sources ?? []) add({ url: item.url, title: item.title, site: item.site, siteIcon: item.siteIcon, snippet: item.snippet ?? item.summary, publishedAt: item.publishedAt });
      if (step.page) add({ url: step.page.url, title: step.page.title, site: step.page.site, siteIcon: step.page.siteIcon, snippet: step.page.snippet ?? step.page.summary, publishedAt: step.page.publishedAt });
    } else if ("sources" in step && step.sources) {
      for (const item of step.sources) add({ url: item.url, title: item.title, site: item.site, siteIcon: item.siteIcon, snippet: item.snippet ?? item.summary, publishedAt: item.publishedAt });
    } else if ("url" in step && step.url) {
      add({ url: step.url, title: "title" in step ? step.title : undefined, siteIcon: "siteIcon" in step ? step.siteIcon : undefined });
    }
  }
  for (const step of serverToolSteps ?? []) {
    for (const page of step.pages ?? []) {
      add({ url: page.url, title: page.title, site: page.site, siteIcon: page.siteIcon, snippet: page.snippet, publishedAt: page.publishedAt });
    }
  }

  return [...byUrl.values()].slice(0, 20).map((source, idx) => ({
    ...source,
    index: source.index > 0 ? source.index : idx + 1,
  }));
}

export function SourceFavicon(props: { icon?: string; site: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const size = props.size ?? 14;
  // Renderer CSP restricts `img-src` to local schemes (`data:`, `blob:`, `manga-media:`); never emit external `https:` img requests.
  if (!props.icon || broken || !/^(data:image\/|blob:|manga-media:)/i.test(props.icon)) {
    return <span className="cite-favicon-fallback" aria-hidden="true"><Globe size={Math.max(10, size - 2)} /></span>;
  }
  return (
    <img
      className="cite-favicon"
      src={props.icon}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

const ENTER_DELAY_MS = 250;
const LEAVE_DELAY_MS = 120;
const CARD_WIDTH = 320;
const CARD_MARGIN = 10;

/**
 * Tier 1 + Tier 2 citation pill: inline superscript `[n]` with a portal-rendered, viewport-clamped hover/focus preview card.
 */
export const CitationBadge = memo(function CitationBadge(props: {
  t: T;
  index: number;
  source?: CitationSource;
}) {
  const { t, index, source } = props;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const enterTimer = useRef<number | undefined>(undefined);
  const leaveTimer = useRef<number | undefined>(undefined);

  const clearTimers = useCallback(() => {
    window.clearTimeout(enterTimer.current);
    window.clearTimeout(leaveTimer.current);
    enterTimer.current = undefined;
    leaveTimer.current = undefined;
  }, []);

  const scheduleOpen = useCallback((immediate = false) => {
    clearTimers();
    if (!source) return;
    if (immediate) { setOpen(true); return; }
    enterTimer.current = window.setTimeout(() => setOpen(true), ENTER_DELAY_MS);
  }, [clearTimers, source]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    leaveTimer.current = window.setTimeout(() => setOpen(false), LEAVE_DELAY_MS);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const cardHeight = cardRef.current?.offsetHeight ?? 136;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const left = Math.max(CARD_MARGIN, Math.min(rect.left + rect.width / 2 - CARD_WIDTH / 2, vw - CARD_WIDTH - CARD_MARGIN));
    const spaceBelow = vh - rect.bottom - CARD_MARGIN;
    const above = spaceBelow < cardHeight && rect.top > cardHeight + CARD_MARGIN;
    const top = above ? Math.max(CARD_MARGIN, rect.top - cardHeight - 8) : Math.min(vh - cardHeight - CARD_MARGIN, rect.bottom + 8);
    setPos({ top, left, above });
  }, [open]);

  const activate = () => {
    if (source) openExternalLink(source.url);
  };

  return (
    <>
      <span
        ref={triggerRef}
        role="link"
        tabIndex={0}
        className="cite-badge"
        data-testid={`cite-badge-${index}`}
        aria-label={source ? `${source.title} (${source.site})` : String(index)}
        title={source ? source.title : undefined}
        onClick={(event) => { event.preventDefault(); activate(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activate();
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
        onMouseEnter={() => scheduleOpen(false)}
        onMouseLeave={scheduleClose}
        onFocus={() => scheduleOpen(true)}
        onBlur={scheduleClose}
      >
        {index}
      </span>
      {open && source && typeof document !== "undefined" ? createPortal(
        <div
          ref={cardRef}
          role="tooltip"
          className="cite-hover-card"
          data-testid={`cite-hover-${index}`}
          data-placement={pos?.above ? "above" : "below"}
          style={pos ? { top: pos.top, left: pos.left, width: CARD_WIDTH } : { visibility: "hidden", width: CARD_WIDTH }}
          onMouseEnter={clearTimers}
          onMouseLeave={scheduleClose}
        >
          <div className="cite-hover-head">
            <SourceFavicon icon={source.siteIcon} site={source.site} size={14} />
            <span className="cite-hover-site truncate">{source.site}</span>
            {source.publishedAt ? <span className="cite-hover-date">{source.publishedAt}</span> : null}
          </div>
          <button
            type="button"
            className="cite-hover-title"
            title={t("chat.sources.open")}
            onClick={() => { openExternalLink(source.url); setOpen(false); }}
          >
            <span>{source.title}</span>
            <ExternalLink size={12} aria-hidden="true" />
          </button>
          {source.snippet ? <p className="cite-hover-snippet">{source.snippet}</p> : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
});

/**
 * Tier 3 bottom-of-message sources bar & expandable panel.
 * Preserves `data-testid="bubble-sources-${id}"` and keeps source titles directly readable in DOM for end-to-end checks.
 */
export const SourcesFooter = memo(function SourcesFooter(props: {
  t: T;
  id: string;
  sources: readonly CitationSource[];
}) {
  const { t, id, sources } = props;
  const [expanded, setExpanded] = useState(false);
  if (sources.length === 0) return null;

  return (
    <section
      className="bubble-sources bubble-citations chat-sources"
      data-testid={`bubble-sources-${id}`}
      aria-label={t("chat.sources")}
    >
      <div className="chat-sources-bar">
        <button
          type="button"
          className="chat-sources-pill"
          data-testid={`bubble-sources-toggle-${id}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="chat-sources-favicons" aria-hidden="true">
            {sources.slice(0, 3).map((source) => (
              <span key={source.url} className="chat-sources-favicon-ring">
                <SourceFavicon icon={source.siteIcon} site={source.site} size={13} />
              </span>
            ))}
          </span>
          <span className="chat-sources-count">{t("chat.sources.count", { count: sources.length })}</span>
          {expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
        </button>

        {!expanded ? (
          <div className="chat-sources-preview">
            {sources.slice(0, 4).map((source) => (
              <button
                key={source.url}
                type="button"
                className="chat-source-chip"
                title={source.url}
                onClick={() => openExternalLink(source.url)}
              >
                <span className="chat-source-chip-index">{source.index}</span>
                <span className="truncate">{source.title}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {expanded ? (
        <div className="chat-sources-panel" data-testid={`bubble-sources-panel-${id}`}>
          <header className="chat-sources-panel-head">
            <span>{t("chat.sources.panel")}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={t("chat.sources.close")}
              title={t("chat.sources.close")}
              onClick={() => setExpanded(false)}
            >
              <X size={13} />
            </button>
          </header>
          <ol className="chat-sources-list">
            {sources.map((source) => (
              <li key={source.url} className="chat-sources-item">
                <button
                  type="button"
                  className="chat-sources-card"
                  title={source.url}
                  onClick={() => openExternalLink(source.url)}
                >
                  <span className="chat-sources-card-head">
                    <span className="chat-source-chip-index">{source.index}</span>
                    <SourceFavicon icon={source.siteIcon} site={source.site} size={14} />
                    <span className="chat-sources-card-site truncate">{source.site}</span>
                    {source.publishedAt ? <span className="chat-sources-card-date">{source.publishedAt}</span> : null}
                    <ExternalLink size={12} className="chat-sources-card-ext" aria-hidden="true" />
                  </span>
                  <span className="chat-sources-card-title">{source.title}</span>
                  {source.snippet ? <span className="chat-sources-card-snippet">{source.snippet}</span> : null}
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
});
