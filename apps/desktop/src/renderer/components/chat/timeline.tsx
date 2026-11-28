import { memo, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AlertCircle, Check, ChevronDown, ChevronRight, FileText, Globe, Image, Link2, Search, Sparkles, Wrench } from "lucide-react";
import type { AgentSearchStep, AgentServerToolStep, AgentToolStep, StreamAgent } from "@manga/contracts";
import type { Translator } from "@manga/i18n";
import { localizedToolName } from "../../lib/chat-tools.ts";
import { openExternalLink, siteOf, SourceFavicon } from "./citations.tsx";
import { ChatMarkdown } from "./markdown.tsx";

type T = Translator["t"];

/** Aggregates legacy `item.search` rows into normalized `AgentServerToolStep[]` when `serverToolSteps` is absent. */
export function normalizeServerSteps(
  explicit?: readonly AgentServerToolStep[],
  raw?: readonly AgentSearchStep[],
): AgentServerToolStep[] {
  if (explicit?.length) return [...explicit];
  if (!raw?.length) return [];

  const list: AgentServerToolStep[] = [];
  for (const step of raw) {
    if (step.kind === "done") {
      const idx = list.findIndex((entry) => entry.id === step.callId);
      if (idx >= 0) {
        const cur = list[idx]!;
        const pages = [
          ...(cur.pages ?? []),
          ...(step.sources ?? []).map((src) => ({
            url: src.url,
            title: src.title,
            site: src.site,
            siteIcon: src.siteIcon,
            snippet: src.snippet ?? src.summary,
            publishedAt: src.publishedAt,
          })),
          ...(step.page ? [{
            url: step.page.url,
            title: step.page.title,
            site: step.page.site,
            siteIcon: step.page.siteIcon,
            snippet: step.page.snippet ?? step.page.summary,
            publishedAt: step.page.publishedAt,
            failed: step.failed,
          }] : []),
        ];
        list[idx] = {
          ...cur,
          status: step.failed ? "error" : "done",
          ...(pages.length ? { pages } : {}),
          ...(cur.keywords?.length && step.found !== undefined
            ? { keywords: cur.keywords.map((kw) => ({ ...kw, found: step.found })) }
            : {}),
        };
      }
      continue;
    }

    const kind: AgentServerToolStep["kind"] = step.kind === "open" ? "open_page" : step.kind;
    const entry: AgentServerToolStep = {
      id: step.callId,
      kind,
      status: step.status ?? "wip",
      ...("queries" in step ? { queries: step.queries } : {}),
      ...("sources" in step && step.sources
        ? {
          pages: step.sources.map((src) => ({
            url: src.url,
            title: src.title,
            site: src.site,
            siteIcon: src.siteIcon,
            snippet: src.snippet ?? src.summary,
            publishedAt: src.publishedAt,
          })),
        }
        : {}),
      ...("url" in step && step.kind !== "find_in_page"
        ? {
          pages: [{
            url: step.url,
            title: "title" in step ? step.title : undefined,
            siteIcon: "siteIcon" in step ? step.siteIcon : undefined,
            failed: "failed" in step ? step.failed : undefined,
          }],
        }
        : {}),
      ...(step.kind === "find_in_page"
        ? { keywords: [{ pattern: step.pattern, url: step.url, found: step.found }] }
        : {}),
    };
    const existing = list.findIndex((item) => item.id === entry.id);
    if (existing >= 0) list[existing] = { ...list[existing]!, ...entry };
    else list.push(entry);
  }
  return list;
}

function QueryMarquee(props: { queries: readonly string[]; live: boolean }) {
  const { queries, live } = props;
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!live || queries.length <= 1) return;
    const timer = window.setInterval(() => setIndex((prev) => (prev + 1) % queries.length), 2200);
    return () => window.clearInterval(timer);
  }, [live, queries.length]);

  if (queries.length === 0) return null;
  if (live && queries.length > 1) {
    return (
      <span className="timeline-query-marquee" data-testid="timeline-query-marquee">
        {queries[index % queries.length]}
      </span>
    );
  }
  return (
    <span className="timeline-query-chips">
      {queries.map((query, idx) => (
        <span key={`${query}-${idx}`} className="timeline-query-chip">{query}</span>
      ))}
    </span>
  );
}

function ServerStepRow(props: { t: T; step: AgentServerToolStep; live: boolean }) {
  const { t, step } = props;
  const active = props.live && step.status === "wip";
  const failed = step.status === "error";
  const pages = step.pages ?? [];
  const queries = step.queries ?? [];
  const keywords = step.keywords ?? [];

  const icon = (() => {
    if (failed) return <AlertCircle size={13} className="timeline-icon-error" aria-hidden="true" />;
    switch (step.kind) {
      case "search": return <Search size={13} aria-hidden="true" />;
      case "open_page": return <Globe size={13} aria-hidden="true" />;
      case "find_in_page": return <FileText size={13} aria-hidden="true" />;
      case "read_link": return <Link2 size={13} aria-hidden="true" />;
      case "image_search":
      case "deep_image_search": return <Image size={13} aria-hidden="true" />;
    }
  })();

  const headline = (() => {
    switch (step.kind) {
      case "search":
        if (active) return queries.length ? t("chat.searching", { query: queries[0]! }) : t("chat.tool.searching");
        return pages.length ? t("chat.tool.searched", { count: pages.length }) : t("chat.tool.searching");
      case "open_page":
        if (active && pages[0]) return t("chat.reading", { site: pages[0].site || siteOf(pages[0].url) });
        if (active) return t("chat.tool.browsing");
        return t("chat.tool.browsed", { count: Math.max(1, pages.length) });
      case "read_link":
        if (active && pages[0]) return t("chat.reading", { site: pages[0].site || siteOf(pages[0].url) });
        return active ? t("chat.tool.readingLink") : t("chat.tool.readLink");
      case "find_in_page":
        return t("chat.tool.finding", { pattern: keywords[0]?.pattern ?? "" });
      case "image_search":
      case "deep_image_search":
        return t("chat.tool.imageSearching");
    }
  })();

  return (
    <div className="timeline-step" data-testid={`timeline-server-${step.kind}`} data-status={step.status}>
      <span className={`timeline-dot ${active ? "is-pulsing" : ""} ${failed ? "is-error" : ""}`} aria-hidden="true" />
      <div className="timeline-step-body">
        <div className={`timeline-step-head ${active ? "timeline-shimmer" : ""}`}>
          <span className="timeline-step-icon">{icon}</span>
          <span className="timeline-step-title">{headline}</span>
          {failed ? <span className="timeline-step-failed">{t("chat.tool.failed")}</span> : null}
        </div>
        {(step.kind === "search" || step.kind === "image_search" || step.kind === "deep_image_search") && queries.length > 0 ? (
          <QueryMarquee queries={queries} live={active} />
        ) : null}
        {step.kind === "find_in_page" && keywords.length > 0 ? (
          <div className="timeline-chips">
            {keywords.map((kw, idx) => (
              <span key={`${kw.pattern}-${idx}`} className="timeline-chip" data-found={kw.found === false ? "false" : "true"}>
                {kw.pattern}
              </span>
            ))}
          </div>
        ) : null}
        {pages.length > 0 ? (
          <div className="timeline-chips">
            {pages.slice(0, 6).map((page) => (
              <button
                key={page.url}
                type="button"
                className={`timeline-page-chip ${page.failed ? "is-failed" : ""}`}
                title={page.url}
                onClick={() => openExternalLink(page.url)}
              >
                <SourceFavicon icon={page.siteIcon} site={page.site || siteOf(page.url)} size={12} />
                <span className="truncate">{page.title || page.site || siteOf(page.url)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FunctionToolRow(props: { t: T; step: AgentToolStep; live: boolean }) {
  const { t, step } = props;
  const active = props.live && step.status === "wip";
  const failed = step.status === "error";
  const label = localizedToolName(t, step.name);
  return (
    <div className="timeline-step" data-testid={`timeline-tool-${step.id}`} data-status={step.status}>
      <span className={`timeline-dot ${active ? "is-pulsing" : ""} ${failed ? "is-error" : ""}`} aria-hidden="true" />
      <div className="timeline-step-body">
        <div className={`timeline-step-head ${active ? "timeline-shimmer" : ""}`}>
          <span className="timeline-step-icon">
            {failed ? <AlertCircle size={13} className="timeline-icon-error" aria-hidden="true" /> : active ? <Wrench size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          </span>
          <span className="timeline-step-title">{active ? t("chat.tool.calling", { name: label }) : label}</span>
          {step.elapsedMs !== undefined && !active ? (
            <span className="timeline-step-elapsed">{t("chat.thinking.elapsed", { seconds: Math.max(1, Math.round(step.elapsedMs / 1000)) })}</span>
          ) : null}
          {failed ? <span className="timeline-step-failed">{t("chat.tool.failed")}</span> : null}
        </div>
        {step.summary ? <p className="timeline-step-summary detail-muted">{step.summary}</p> : null}
      </div>
    </div>
  );
}

/**
 * Unified Thinking + Server Tool + MANGA Function Tool timeline (`data-testid="bubble-thinking-${item.id}"`).
 * Auto-opens while actively thinking/searching/tooling and auto-collapses when finished so clicking `<summary>` re-opens it.
 */
export const ThinkingTimeline = memo(function ThinkingTimeline(props: {
  t: T;
  item: StreamAgent;
  live: boolean;
}) {
  const { t, item, live } = props;
  const serverSteps = useMemo(() => normalizeServerSteps(item.serverToolSteps, item.search), [item.serverToolSteps, item.search]);
  const toolSteps = item.toolSteps ?? [];
  const hasReasoning = Boolean(item.reasoning?.trim());
  const hasSteps = serverSteps.length > 0 || toolSteps.length > 0;
  const hasTimeline = hasReasoning || hasSteps;
  const activeWorking = live && hasTimeline && !item.text;

  // Track user toggle override; auto-collapse when transitioning from live -> settled.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const prevLive = useRef(live);
  useEffect(() => {
    if (prevLive.current && !live) {
      setUserOpen(false);
    }
    prevLive.current = live;
  }, [live]);

  const isOpen = userOpen !== null ? userOpen : activeWorking;

  // Live 1s elapsed thinking timer.
  const startAtRef = useRef<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(() => (
    item.reasoningElapsedMs ? Math.max(1, Math.round(item.reasoningElapsedMs / 1000)) : 0
  ));

  useEffect(() => {
    if (item.reasoningElapsedMs && item.reasoningElapsedMs > 0) {
      setElapsedSec(Math.max(1, Math.round(item.reasoningElapsedMs / 1000)));
    }
  }, [item.reasoningElapsedMs]);

  useEffect(() => {
    if (!activeWorking) return;
    if (startAtRef.current === null) {
      const parsed = item.reasoningStartedAt ? Date.parse(item.reasoningStartedAt) : Number.NaN;
      startAtRef.current = Number.isFinite(parsed) ? parsed : Date.now();
    }
    const tick = () => {
      const ms = Date.now() - (startAtRef.current ?? Date.now());
      setElapsedSec(Math.max(1, Math.round(ms / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [activeWorking, item.reasoningStartedAt]);

  const activeServerStep = live ? [...serverSteps].reverse().find((step) => step.status === "wip") : undefined;
  const activeToolStep = live ? [...toolSteps].reverse().find((step) => step.status === "wip") : undefined;
  const lastRawSearch = item.search?.[item.search.length - 1];

  const summaryLabel = (() => {
    if (live && activeServerStep) {
      if (activeServerStep.kind === "search") {
        return activeServerStep.queries?.length
          ? t("chat.searching", { query: activeServerStep.queries.join(" / ") })
          : t("chat.tool.searching");
      }
      if ((activeServerStep.kind === "open_page" || activeServerStep.kind === "read_link") && activeServerStep.pages?.[0]) {
        return t("chat.reading", { site: activeServerStep.pages[0].site || siteOf(activeServerStep.pages[0].url) });
      }
      if (activeServerStep.kind === "find_in_page") {
        return t("chat.tool.finding", { pattern: activeServerStep.keywords?.[0]?.pattern ?? "" });
      }
      return t("chat.tool.browsing");
    }
    if (live && activeToolStep) {
      return t("chat.tool.calling", { name: localizedToolName(t, activeToolStep.name) });
    }
    if (activeWorking) return t("chat.thinking.live");
    if (item.status === "cancelled" && !item.text) return t("chat.thinking.stopped");
    if (elapsedSec > 0) return t("chat.thinking.done", { seconds: elapsedSec });
    return hasReasoning ? t("chat.thinking.doneSimple") : t("chat.thinking");
  })();

  const liveSearchHint = live && lastRawSearch && lastRawSearch.kind !== "done"
    ? ("queries" in lastRawSearch
      ? t("chat.searching", { query: lastRawSearch.queries.join(" / ") })
      : "url" in lastRawSearch
        ? t("chat.reading", { site: siteOf(lastRawSearch.url) })
        : null)
    : null;

  return (
    <>
      {item.thinkingRaised ? (
        <p className="detail-muted bubble-thinking-raised" data-testid={`bubble-thinking-raised-${item.id}`}>
          {t("chat.thinkingRaised")}
        </p>
      ) : null}

      {hasTimeline ? (
        <details
          className={`bubble-thinking ${activeWorking ? "is-live" : ""}`}
          data-testid={`bubble-thinking-${item.id}`}
          aria-label={t("chat.thinking")}
          open={isOpen}
        >
          <summary
            className={`bubble-thinking-summary ${activeWorking ? "timeline-shimmer" : ""}`}
            onClick={(event) => {
              event.preventDefault();
              flushSync(() => {
                setUserOpen(!isOpen);
              });
            }}
          >
            <Sparkles size={13} className="bubble-thinking-spark" aria-hidden="true" />
            <span className="bubble-thinking-label">{summaryLabel}</span>
            {activeWorking && elapsedSec > 0 ? (
              <span className="bubble-thinking-timer">{t("chat.thinking.elapsed", { seconds: elapsedSec })}</span>
            ) : null}
            <span className="bubble-thinking-chevron" aria-hidden="true">
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </summary>

          <div className="chat-timeline">
            {hasReasoning ? (
              <div className="timeline-step timeline-step-reasoning">
                <span className={`timeline-dot ${activeWorking && !activeServerStep && !activeToolStep ? "is-pulsing" : ""}`} aria-hidden="true" />
                <div className="timeline-step-body timeline-reasoning-body">
                  <ChatMarkdown t={t} text={item.reasoning ?? ""} streaming={activeWorking} compact />
                </div>
              </div>
            ) : null}

            {serverSteps.map((step) => (
              <ServerStepRow key={step.id} t={t} step={step} live={live} />
            ))}

            {toolSteps.map((step) => (
              <FunctionToolRow key={step.id} t={t} step={step} live={live} />
            ))}
          </div>
        </details>
      ) : liveSearchHint ? (
        <p className="detail-muted timeline-shimmer" role="status" data-testid={`bubble-search-${item.id}`}>
          {liveSearchHint}
        </p>
      ) : null}

      {hasTimeline && liveSearchHint ? (
        <span className="sr-only" role="status" data-testid={`bubble-search-${item.id}`}>{liveSearchHint}</span>
      ) : null}
    </>
  );
});
