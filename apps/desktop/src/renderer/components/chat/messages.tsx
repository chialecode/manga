import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { measureElement as measureRow, observeElementRect, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ArrowDown, MessageSquareQuote, Mic, Pause, Pencil, Play, RotateCcw, ScrollText, Sparkles, Trash2 } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import type { ProposalCard, RoughcutExportView, RoughcutProblem } from "@manga/contracts";
import { attempt, messageOf } from "../../lib/api.ts";
import { Modal } from "../modal.tsx";
import { noteSourceLabel, voiceSourceLabel } from "../../lib/chat-model.ts";
import { formatClock } from "../../readers/video-model.ts";
import type { StreamAgent, StreamItem, StreamNote, StreamUser, StreamVoice } from "../../hooks/use-session-stream.ts";
import { problemText, stepText } from "../../pages/projects/roughcut/roughcut-model.ts";

/*
 * The structure of this list (a log region that sticks to the bottom while an answer streams, a scroll-down button, bubbles by
 * kind) follows the conversation and message components of Vercel ai-elements (Apache-2.0, https://github.com/vercel/ai-elements).
 * The code is written for MANGA's own message kinds and styles; nothing is imported from the `ai` package. The scroll behaviour
 * is `use-stick-to-bottom` (MIT, https://github.com/stackblitz-labs/use-stick-to-bottom); only the rows near the viewport are rendered,
 * by `@tanstack/react-virtual` (MIT, https://github.com/TanStack/virtual) over the same scroll container (LOOP-07).
 */

type T = Translator["t"];

export type BubbleActions = {
  onJumpNote: (note: StreamNote) => void;
  onJumpVoice: (voice: StreamVoice, source?: StreamVoice["sources"][number]) => void;
  onEditNote: (note: StreamNote, text: string) => Promise<boolean>;
  onDeleteNote: (note: StreamNote) => Promise<void>;
  onQuoteNote: (note: StreamNote) => void;
  onOpenRecording: (voice: StreamVoice) => void;
  onRetry: (runId: string) => void;
  /** Open the trace of the task that made a reply (what it sent, what came back, in order). */
  onOpenTrace?: (runId: string) => void;
  /** Called after a proposal is applied or rejected so the stream and workspace refresh. */
  onProposalChanged?: () => void;
};

function ScrollButton(props: { label: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return <button type="button" className="chat-scroll-bottom" data-testid="chat-scroll-bottom" aria-label={props.label} title={props.label} onClick={() => { void scrollToBottom(); }}><ArrowDown size={16} /></button>;
}

/** Where each conversation was scrolled to, kept while another one is shown (the other mode's, a settings round trip) and put back when it returns. */
const scrollMemory = new Map<string, { top: number; atBottom: boolean }>();
const NEAR_BOTTOM_PX = 8;
export const resetScrollMemory = (): void => scrollMemory.clear();

/**
 * Remembers where the conversation was scrolled to and puts it back when it is shown again. A conversation read from its newest message
 * stays at the newest; one that was scrolled up to an old message comes back to that message and is not pulled to the bottom.
 */
function ScrollMemory(props: { memoryKey: string | undefined; ready: boolean }) {
  const { scrollRef } = useStickToBottomContext();
  const { memoryKey, ready } = props;
  const readyNow = useRef(ready);
  readyNow.current = ready;
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !memoryKey) return;
    const onScroll = () => {
      // The messages of another conversation sliding in or out are not this one's place; nor is the 0 a hidden pane reports.
      if (!readyNow.current || (node.clientHeight === 0 && node.scrollHeight === 0)) return;
      scrollMemory.set(memoryKey, { top: node.scrollTop, atBottom: node.scrollHeight - node.scrollTop - node.clientHeight <= NEAR_BOTTOM_PX });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [memoryKey, scrollRef]);
  const restoredFor = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    // The messages of another conversation (or none yet) are not the place the saved position belongs to.
    if (!memoryKey || !ready) { restoredFor.current = undefined; return; }
    if (restoredFor.current === memoryKey) return;
    restoredFor.current = memoryKey;
    const saved = scrollMemory.get(memoryKey);
    const node = scrollRef.current;
    if (saved && !saved.atBottom && node) node.scrollTop = saved.top;
  }, [memoryKey, ready, scrollRef]);
  return null;
}

/**
 * Open a bound resource and the pane is at the newest message; an old message is read by scrolling up and is not pulled away from.
 * Growth at the bottom (a reply being written, rows measured after their estimate) is followed at once, not by an animation that trails it.
 */
export function MessageList(props: ListProps) {
  const { t } = props;
  return (
    <StickToBottom className="chat-log" initial="instant" resize="instant" role="log" aria-label={t("chat.log")} data-testid="chat-log">
      <StickToBottom.Content className={`chat-log-content ${props.limited ? "chat-log-wide" : ""}`}>
        {props.hasMore ? <button type="button" className="link-button chat-older" data-testid="chat-older" disabled={props.loadingOlder} onClick={() => { void props.onOlder(); }}>{t("chat.older")}</button> : null}
        {props.items.length === 0 ? <div className="chat-empty" data-testid="chat-empty">{props.empty}</div> : null}
        <VirtualRows {...props} />
      </StickToBottom.Content>
      <ScrollButton label={t("chat.toBottom")} />
      <ScrollMemory memoryKey={props.memoryKey} ready={props.ready ?? props.items.length > 0} />
    </StickToBottom>
  );
}

/** A message to bring into view (from a note or a quote): found by its id, the older pages loaded first when it is not among the loaded ones. */
export type RevealRequest = { id: string; token: number };

type ListProps = {
  t: T; items: StreamItem[]; hasMore: boolean; onOlder: () => void | Promise<unknown>; actions: BubbleActions; empty: ReactNode; formatDate: (value: string) => string;
  limited?: boolean; memoryKey?: string; ready?: boolean;
  /** An older page is being read: the top of the list does not ask again. */
  loadingOlder?: boolean;
  reveal?: RevealRequest | null;
  /** The message was shown (true) or is not in the conversation (false). */
  onRevealed?: (found: boolean) => void;
};

/** A row's height before it is measured; also what a row counts as while the pane is hidden (it measures 0 then). */
export const ROW_ESTIMATE = 96;
/** The height the list assumes while its pane is hidden or not laid out, so a few screens of rows are ready when it is shown. */
const UNLAID_HEIGHT = 2400;
const OVERSCAN = 6;
/** Within this distance of the top the next older page is read on its own. */
const OLDER_PX = 240;
const HIGHLIGHT_MS = 2000;

type Anchor = { id: string; offset: number; neighbours: string[] };

function VirtualRows(props: ListProps) {
  const { items } = props;
  const { scrollRef, isAtBottom, stopScroll, state } = useStickToBottomContext();
  const rows = useRef<HTMLDivElement>(null);
  // Whether the last scroll left the list at its very bottom: a row measured after its estimate, or a reply growing, keeps it there.
  const pinned = useRef(true);
  const leftAt = useRef<{ top: number; height: number } | null>(null);
  // Another conversation in the same list starts at its newest message (or where the scroll memory puts it back, which is a scroll of its own).
  const shownKey = useRef(props.memoryKey);
  if (shownKey.current !== props.memoryKey) { shownKey.current = props.memoryKey; pinned.current = true; leftAt.current = null; }
  const atBottom = useRef(isAtBottom);
  atBottom.current = isAtBottom;
  const [margin, setMargin] = useState(0);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => items[index]?.id ?? index,
    overscan: OVERSCAN,
    scrollMargin: margin,
    initialRect: { width: 0, height: UNLAID_HEIGHT },
    // A hidden pane (or one not laid out yet) has no height and its rows none either: assume a few screens instead of none or all.
    observeElementRect: (instance, cb) => observeElementRect(instance, (rect) => cb(rect.height > 0 ? rect : { width: rect.width, height: UNLAID_HEIGHT })),
    measureElement: (element, entry, instance) => { const size = measureRow(element, entry, instance); return size > 0 ? size : ROW_ESTIMATE; },
  });
  // A row that grows (an answer being written, a recording being transcribed): at the bottom the list follows it (use-stick-to-bottom);
  // scrolled up, only a row above the viewport moves the position, so what is being read stays put.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance: Virtualizer<HTMLElement, Element>) => !atBottom.current && item.start < (instance.scrollOffset ?? 0);

  // The rows start below the "older messages" button and the padding; the virtualizer counts from the top of the scroll container.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const box = rows.current;
    if (!node || !box) return;
    const outer = node.getBoundingClientRect();
    // A hidden pane (or one not laid out) has no box to measure from: the last margin stays.
    if (outer.height === 0) return;
    const next = Math.round(box.getBoundingClientRect().top - outer.top + node.scrollTop);
    if (next !== margin) setMargin(next);
  });

  // The message at the top of the viewport, and the ones after it in case it is deleted before the next refresh.
  const anchor = useRef<Anchor | null>(null);
  const keepAnchor = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const top = node.scrollTop;
    const row = virtualizer.getVirtualItemForOffset(top);
    if (!row) { anchor.current = null; return; }
    anchor.current = { id: String(row.key), offset: top - row.start, neighbours: items.slice(row.index + 1, row.index + 8).map((item) => item.id) };
  }, [scrollRef, virtualizer, items]);

  // A page loaded above, or a refresh, leaves the message at the top of the viewport where it was; at the bottom the list stays at the bottom.
  const shown = useRef(items);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = items;
    const node = scrollRef.current;
    const kept = anchor.current;
    if (!node || before === items || before.length === 0 || atBottom.current || !kept) return;
    // Only appended or changed in place: nothing above the viewport moved.
    if (before.length <= items.length && before.every((item, index) => items[index]?.id === item.id)) return;
    const index = new Map(items.map((item, at) => [item.id, at]));
    const target = [kept.id, ...kept.neighbours].find((id) => index.has(id));
    if (target === undefined) return;
    // The layout position of the row (getOffsetForIndex answers where a scroll would go, which counts a correction still pending).
    virtualizer.getTotalSize();
    const start = virtualizer.measurementsCache[index.get(target)!]?.start;
    if (start === undefined) return;
    const next = Math.max(0, start + (target === kept.id ? kept.offset : 0));
    if (Math.abs(node.scrollTop - next) > 0.5) node.scrollTop = next;
    keepAnchor();
  }, [items, scrollRef, virtualizer, keepAnchor]);

  // use-stick-to-bottom follows growth a frame later (its resize observer sits on an ancestor of the measured rows and waits a frame):
  // a list that was at the bottom is put back there before this commit is painted, so it never shows a frame off the bottom.
  // A scroll position above where the last commit left it is the person scrolling up (the scroll event may not have reached this list yet:
  // the virtualizer re-renders inside it), never something to undo; the browser lowering it by no more than the content got shorter is not.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || node.clientHeight === 0) return;
    const was = leftAt.current;
    if (was !== null && was.top - node.scrollTop > Math.max(0, was.height - node.scrollHeight) + 1) pinned.current = false;
    if (pinned.current && !state.escapedFromLock && state.isAtBottom) {
      const bottom = node.scrollHeight - node.clientHeight;
      if (bottom - node.scrollTop > 1) node.scrollTop = bottom;
    }
    leftAt.current = { top: node.scrollTop, height: node.scrollHeight };
  });

  // Near the top the next older page is read on its own; the button stays for the keyboard.
  const older = useRef({ hasMore: props.hasMore, loading: props.loadingOlder, onOlder: props.onOlder });
  older.current = { hasMore: props.hasMore, loading: props.loadingOlder, onOlder: props.onOlder };
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 1;
      keepAnchor();
      const now = older.current;
      if (now.hasMore && !now.loading && node.clientHeight > 0 && node.scrollTop < OLDER_PX && node.scrollHeight > node.clientHeight) void now.onOlder();
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [scrollRef, keepAnchor]);

  // Bring a message into view: by its index once it is loaded, the older pages read until it is or there are none.
  const [highlight, setHighlight] = useState<string | null>(null);
  const handled = useRef<number | null>(null);
  const { reveal, onRevealed, hasMore, loadingOlder, onOlder } = props;
  useEffect(() => {
    if (!reveal || handled.current === reveal.token) return;
    const index = items.findIndex((item) => item.id === reveal.id);
    if (index < 0) {
      if (loadingOlder) return;
      if (hasMore) { void onOlder(); return; }
      handled.current = reveal.token;
      onRevealed?.(false);
      return;
    }
    handled.current = reveal.token;
    stopScroll();
    virtualizer.scrollToIndex(index, { align: "center" });
    setHighlight(reveal.id);
    onRevealed?.(true);
  }, [reveal, items, hasMore, loadingOlder, onOlder, onRevealed, stopScroll, virtualizer]);
  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  return (
    <div ref={rows} className="chat-rows" data-testid="chat-rows" data-count={items.length} style={{ height: Math.max(0, virtualizer.getTotalSize() - margin) }}>
      {virtualizer.getVirtualItems().map((row) => {
        const item = items[row.index];
        if (!item) return null;
        return (
          <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} className="chat-row" data-highlight={highlight === item.id ? "true" : undefined} style={{ transform: `translateY(${row.start - margin}px)` }}>
            <Bubble t={props.t} item={item} actions={props.actions} formatDate={props.formatDate} />
          </div>
        );
      })}
    </div>
  );
}

function Bubble(props: { t: T; item: StreamItem; actions: BubbleActions; formatDate: (value: string) => string }) {
  const { item } = props;
  if (item.kind === "note") return <NoteBubble t={props.t} item={item} actions={props.actions} formatDate={props.formatDate} />;
  if (item.kind === "voice") return <VoiceBubble t={props.t} item={item} actions={props.actions} formatDate={props.formatDate} />;
  if (item.kind === "user") return <UserBubble t={props.t} item={item} />;
  return <AgentBubble t={props.t} item={item} actions={props.actions} formatDate={props.formatDate} />;
}

function NoteBubble(props: { t: T; item: StreamNote; actions: BubbleActions; formatDate: (value: string) => string }) {
  const { t, item, actions } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const source = noteSourceLabel(t, item);
  const jumpable = item.locator !== null && item.resourceId !== null;

  async function save() {
    if (busy) return;
    setBusy(true);
    const saved = await actions.onEditNote(item, draft);
    setBusy(false);
    if (saved) setEditing(false);
  }

  return (
    <article className="bubble bubble-note" data-testid={`bubble-note-${item.id}`} data-kind="note">
      <header className="bubble-head">
        <span className="bubble-kind"><Pencil size={12} />{t("chat.kind.note")}</span>
        {jumpable
          ? <button type="button" className="bubble-source" data-testid={`bubble-source-${item.id}`} title={t("chat.source.jump")} onClick={() => actions.onJumpNote(item)}>{source}</button>
          : <span className="bubble-source" data-testid={`bubble-source-${item.id}`}>{source}</span>}
        <time className="bubble-time" dateTime={item.at}>{props.formatDate(item.at)}</time>
      </header>
      {item.quote ? <blockquote className="bubble-quote" data-testid={`bubble-quote-${item.id}`}>{item.quote}</blockquote> : null}
      {editing ? (
        <div className="bubble-edit">
          <textarea
            data-testid={`bubble-edit-${item.id}`}
            value={draft}
            rows={3}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !composing) { event.stopPropagation(); setEditing(false); setDraft(item.text); }
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !composing) { event.preventDefault(); void save(); }
            }}
          />
          <div className="bubble-actions">
            <button type="button" className="primary-button" data-testid={`bubble-save-${item.id}`} disabled={busy} onClick={() => void save()}>{t("chat.save")}</button>
            <button type="button" className="secondary-button" onClick={() => { setEditing(false); setDraft(item.text); }}>{t("chat.cancel")}</button>
          </div>
        </div>
      ) : item.text ? <p className="bubble-text" data-testid={`bubble-text-${item.id}`}>{item.text}</p> : null}
      {!editing ? (
        confirming ? (
          <div className="bubble-actions" role="alertdialog" aria-label={t("chat.note.deleteAsk")} data-testid={`bubble-confirm-${item.id}`}>
            <span>{t("chat.note.deleteAsk")}</span>
            <button type="button" className="danger-button" data-testid={`bubble-delete-confirm-${item.id}`} onClick={() => { setConfirming(false); void actions.onDeleteNote(item); }}>{t("chat.note.delete")}</button>
            <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>{t("chat.cancel")}</button>
          </div>
        ) : (
          <div className="bubble-actions bubble-tools">
            <button type="button" className="icon-button" data-testid={`bubble-edit-open-${item.id}`} aria-label={t("chat.note.edit")} title={t("chat.note.edit")} onClick={() => { setDraft(item.text); setEditing(true); }}><Pencil size={14} /></button>
            <button type="button" className="icon-button" data-testid={`bubble-quote-ask-${item.id}`} aria-label={t("chat.note.quote")} title={t("chat.note.quote")} onClick={() => actions.onQuoteNote(item)}><MessageSquareQuote size={14} /></button>
            <button type="button" className="icon-button" data-testid={`bubble-delete-${item.id}`} aria-label={t("chat.note.delete")} title={t("chat.note.delete")} onClick={() => setConfirming(true)}><Trash2 size={14} /></button>
          </div>
        )
      ) : null}
    </article>
  );
}

const LIVE_STAGES = new Set(["recording", "recorded", "filtering", "awaiting_asr", "transcribing", "pending"]);

function VoiceBubble(props: { t: T; item: StreamVoice; actions: BubbleActions; formatDate: (value: string) => string }) {
  const { t, item, actions } = props;
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const stage = t(`review.stage.${item.stage}` as MessageKey);
  useEffect(() => () => audio.current?.pause(), []);

  async function toggle() {
    const element = audio.current;
    if (!element) return;
    if (playing) { element.pause(); return; }
    if (!element.src) {
      const handle = await attempt<{ url: string }>("capture.audioHandle", { sessionId: item.id });
      if (!handle.ok) return;
      element.src = handle.value.url;
    }
    try { await element.play(); } catch { setPlaying(false); }
  }

  return (
    <article className="bubble bubble-voice" data-testid={`bubble-voice-${item.id}`} data-stage={item.stage} data-kind="voice">
      <header className="bubble-head">
        <span className="bubble-kind"><Mic size={12} />{t("chat.kind.voice")}</span>
        <span className="chip" data-testid={`bubble-voice-stage-${item.id}`} data-live={LIVE_STAGES.has(item.stage) ? "true" : "false"}>{stage}</span>
        <span className="bubble-time">{formatClock(item.durationMs)}</span>
        <time className="bubble-time" dateTime={item.at}>{props.formatDate(item.at)}</time>
      </header>
      {item.text ? <p className="bubble-text" data-testid={`bubble-voice-text-${item.id}`}>{item.text}</p> : item.stage === "done" || item.stage === "no_speech" || item.stage === "failed" ? <p className="bubble-text detail-muted">{stage}</p> : null}
      {item.sources.length ? (
        <ul className="bubble-sources" data-testid={`bubble-voice-sources-${item.id}`}>
          {item.sources.slice(0, 6).map((source, index) => (
            <li key={`${source.startMs}:${index}`}>
              <button type="button" className="bubble-source" disabled={!source.locator} onClick={() => actions.onJumpVoice(item, source)}>{voiceSourceLabel(t, source)}</button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="bubble-actions">
        {item.playable ? (
          <button type="button" className="secondary-button" data-testid={`bubble-voice-play-${item.id}`} onClick={() => void toggle()}>{playing ? <Pause size={13} /> : <Play size={13} />}{playing ? t("chat.voice.pause") : t("chat.voice.play")}</button>
        ) : null}
        <button type="button" className="link-button" data-testid={`bubble-voice-open-${item.id}`} onClick={() => actions.onOpenRecording(item)}>{t("chat.voice.review")}</button>
      </div>
      <audio ref={audio} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    </article>
  );
}

function UserBubble(props: { t: T; item: StreamUser }) {
  const { t, item } = props;
  const [open, setOpen] = useState(false);
  return (
    <article className="bubble bubble-user" data-testid={`bubble-user-${item.id}`} data-kind="user">
      {item.quickTask ? (
        <header className="bubble-head">
          <span className="chip chip-accent" data-testid={`bubble-quick-${item.id}`}><Sparkles size={11} />{t("chat.quick.tag")} · {item.quickTask.name}</span>
          <button type="button" className="link-button" aria-expanded={open} data-testid={`bubble-quick-toggle-${item.id}`} onClick={() => setOpen((value) => !value)}>{open ? t("chat.quick.hide") : t("chat.quick.show")}</button>
        </header>
      ) : null}
      {!item.quickTask || open ? <p className="bubble-text">{item.text}</p> : null}
    </article>
  );
}

function shortTime(iso: string | null, formatDate: (v: string) => string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function executeProposalApply(proposal: ProposalCard) {
  let pathHandle: string | undefined;
  if (proposal.kind === "exportProject") {
    const picked = await window.manga.pick?.({ mode: "directory" });
    if (!picked) return null;
    pathHandle = picked.pathHandle;
  }
  return attempt("proposal.apply", { proposalId: proposal.id, ...(pathHandle ? { pathHandle } : {}) });
}

function ProposalCardItem(props: { t: T; proposal: ProposalCard; formatDate: (v: string) => string; onChanged?: () => void; disabled?: boolean }) {
  const { t, proposal, formatDate } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { preview } = proposal;
  const status = busy && proposal.status === "pending" ? "applying" : proposal.status;

  async function apply() {
    if (busy || props.disabled || proposal.status !== "pending") return;
    setBusy(true);
    setError(null);
    try {
      const ran = await executeProposalApply(proposal);
      if (ran && !ran.ok) setError(ran.error.message);
      if (ran !== null) props.onChanged?.();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (busy || props.disabled || proposal.status !== "pending") return;
    setBusy(true);
    setError(null);
    try {
      const result = await attempt("proposal.reject", { proposalId: proposal.id });
      if (!result.ok) setError(result.error.message);
      props.onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  const exportView = (proposal.result?.output as { export?: RoughcutExportView } | undefined)?.export;
  async function cancelExport() {
    if (!exportView || busy) return;
    setBusy(true);
    const result = await attempt("roughcut.cancel", { exportId: exportView.id });
    if (!result.ok) setError(result.error.message);
    props.onChanged?.();
    setBusy(false);
  }

  const problems = (preview.meta?.problems ?? []) as RoughcutProblem[];
  const titles = (preview.meta?.clipTitles ?? {}) as Record<string, string>;
  const warnings = [...preview.warnings, ...problems.map((problem) => problemText(t, problem, (clipId) => titles[clipId ?? ""] ?? ""))];

  const time = shortTime(proposal.decidedAt, formatDate);
  const staleReason = String(proposal.result?.reason ?? t("proposal.staleDefault"));
  const failReason = String((proposal.result?.error as { message?: string } | undefined)?.message ?? proposal.result?.reason ?? t("proposal.failedDefault"));

  return (
    <section className="proposal-card" data-testid={`proposal-card-${proposal.id}`} data-status={status} data-kind={proposal.kind} aria-label={preview.title}>
      <header className="proposal-head">
        <strong className="proposal-title" data-testid={`proposal-title-${proposal.id}`}>{preview.title}</strong>
      </header>
      <p className="proposal-summary" data-testid={`proposal-summary-${proposal.id}`}>{preview.summary}</p>
      {proposal.reason ? <p className="proposal-reason detail-muted" data-testid={`proposal-reason-${proposal.id}`}>{t("proposal.reason", { reason: proposal.reason })}</p> : null}
      {preview.lines.length > 0 ? (
        <ul className="proposal-lines" data-testid={`proposal-lines-${proposal.id}`}>
          {preview.lines.map((line, idx) => <li key={idx}>{line}</li>)}
        </ul>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="proposal-warnings" data-testid={`proposal-warnings-${proposal.id}`}>
          {warnings.map((warning, idx) => <li key={idx}>{warning}</li>)}
        </ul>
      ) : null}
      <div className="proposal-actions">
        {status === "pending" ? (
          <>
            <button
              type="button"
              className={preview.irreversible ? "danger-button" : "primary-button"}
              data-testid={`proposal-apply-${proposal.id}`}
              disabled={busy || props.disabled}
              onClick={() => void apply()}
            >
              {t("proposal.apply")}
            </button>
            {preview.irreversible ? <span className="proposal-irreversible" data-testid={`proposal-irreversible-${proposal.id}`}>{t("proposal.irreversible")}</span> : null}
            <button
              type="button"
              className="secondary-button"
              data-testid={`proposal-reject-${proposal.id}`}
              disabled={busy || props.disabled}
              onClick={() => void reject()}
            >
              {t("proposal.reject")}
            </button>
          </>
        ) : status === "applying" ? (
          <>
            <span className="proposal-status" role="status" data-testid={`proposal-status-${proposal.id}`} data-status="applying">{exportView ? stepText(t, exportView) : t("proposal.applying")}</span>
            {exportView ? <button type="button" className="secondary-button" data-testid={`proposal-cancel-${proposal.id}`} disabled={busy || props.disabled} onClick={() => void cancelExport()}>{t("roughcut.export.cancel")}</button> : null}
          </>
        ) : status === "applied" ? (
          <span className="proposal-status proposal-status-applied" role="status" data-testid={`proposal-status-${proposal.id}`} data-status="applied">
            {time ? t("proposal.status.appliedAt", { time }) : t("proposal.status.applied")}
          </span>
        ) : status === "rejected" ? (
          <span className="proposal-status proposal-status-rejected" role="status" data-testid={`proposal-status-${proposal.id}`} data-status="rejected">
            {time ? t("proposal.status.rejectedAt", { time }) : t("proposal.status.rejected")}
          </span>
        ) : status === "stale" ? (
          <span className="proposal-status proposal-status-stale" role="status" data-testid={`proposal-status-${proposal.id}`} data-status="stale">
            {t("proposal.status.stale", { reason: staleReason })}
          </span>
        ) : (
          <span className="proposal-status proposal-status-failed" role="status" data-testid={`proposal-status-${proposal.id}`} data-status="failed">
            {t("proposal.status.failed", { reason: failReason })}
          </span>
        )}
      </div>
      {error ? <p role="alert" data-testid={`proposal-error-${proposal.id}`}>{error}</p> : null}
    </section>
  );
}

function ProposalGroup(props: { t: T; runId: string; proposals: ProposalCard[]; formatDate: (v: string) => string; onChanged?: () => void }) {
  const { t, runId, proposals, formatDate } = props;
  const [confirmItems, setConfirmItems] = useState<ProposalCard[] | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchErrors, setBatchErrors] = useState<string[]>([]);
  const pending = proposals.filter((item) => item.status === "pending");
  const anyIrreversible = (confirmItems ?? []).some((item) => item.preview.irreversible);

  async function applyAll() {
    if (batchBusy) return;
    const confirmed = confirmItems ?? [];
    setConfirmItems(null);
    setBatchBusy(true);
    setBatchErrors([]);
    try {
      for (const item of confirmed) {
        try {
          const result = await executeProposalApply(item);
          if (result && !result.ok) setBatchErrors((errors) => [...errors, `${item.preview.title}：${result.error.message}`]);
        } catch (cause) {
          setBatchErrors((errors) => [...errors, `${item.preview.title}：${messageOf(cause)}`]);
        }
      }
      props.onChanged?.();
    } finally {
      setBatchBusy(false);
    }
  }

  async function rejectAll() {
    if (batchBusy) return;
    setBatchBusy(true);
    setBatchErrors([]);
    try {
      for (const item of pending) {
        const result = await attempt("proposal.reject", { proposalId: item.id });
        if (!result.ok) setBatchErrors((errors) => [...errors, `${item.preview.title}：${result.error.message}`]);
      }
      props.onChanged?.();
    } finally {
      setBatchBusy(false);
    }
  }

  return (
    <div className="proposal-group" data-testid={`proposal-group-${runId}`}>
      {pending.length >= 2 ? (
        <div className="proposal-batch" data-testid={`proposal-batch-${runId}`}>
          <button type="button" className="primary-button" data-testid={`proposal-batch-apply-${runId}`} disabled={batchBusy} onClick={() => { setBatchErrors([]); setConfirmItems(pending); }}>
            {t("proposal.batch.apply", { count: pending.length })}
          </button>
          <button type="button" className="secondary-button" data-testid={`proposal-batch-reject-${runId}`} disabled={batchBusy} onClick={() => void rejectAll()}>
            {t("proposal.batch.reject")}
          </button>
        </div>
      ) : null}
      {proposals.map((proposal) => (
        <ProposalCardItem key={proposal.id} t={t} proposal={proposal} formatDate={formatDate} onChanged={props.onChanged} disabled={batchBusy} />
      ))}
      {batchErrors.length ? <ul role="alert" data-testid={`proposal-batch-errors-${runId}`}>{batchErrors.map((message, index) => <li key={index}>{message}</li>)}</ul> : null}
      {confirmItems ? (
        <Modal
          testId="proposal-batch-modal"
          title={t("proposal.batch.title")}
          closeLabel={t("proposal.batch.cancel")}
          onClose={() => setConfirmItems(null)}
          footer={
            <>
              <button type="button" className="secondary-button" data-testid="proposal-batch-cancel" onClick={() => setConfirmItems(null)}>{t("proposal.batch.cancel")}</button>
              <button type="button" className={anyIrreversible ? "danger-button" : "primary-button"} data-testid="proposal-batch-confirm" disabled={batchBusy} onClick={() => void applyAll()}>
                {t("proposal.batch.confirm")}
              </button>
            </>
          }
        >
          <p>{t("proposal.batch.lead", { count: confirmItems.length })}</p>
          <ul className="proposal-batch-list" data-testid="proposal-batch-list">
            {confirmItems.map((item) => (
              <li key={item.id}>
                <strong>{item.preview.title}</strong> — <span>{item.preview.summary}</span>
                {item.preview.irreversible ? <span className="proposal-irreversible">（{t("proposal.irreversible")}）</span> : null}
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </div>
  );
}

function AgentBubble(props: { t: T; item: StreamAgent; actions: BubbleActions; formatDate: (value: string) => string }) {
  const { t, item } = props;
  const live = item.status === "running" || item.status === "queued" || item.status === "waiting_input";
  const trace = props.actions.onOpenTrace;
  const proposals = item.proposals ?? [];
  return (
    <article className="bubble bubble-agent" data-testid={`bubble-agent-${item.id}`} data-status={item.status} data-kind="agent">
      <header className="bubble-head"><span className="bubble-kind"><Sparkles size={12} />MANGA Agent</span></header>
      {item.text ? <div className="bubble-text bubble-markdown"><Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown></div> : live ? <p className="bubble-text detail-muted" role="status">{t("chat.agent.working")}</p> : null}
      {proposals.length > 0 ? <ProposalGroup t={t} runId={item.runId} proposals={proposals} formatDate={props.formatDate} onChanged={props.actions.onProposalChanged} /> : null}
      {item.error ? <p className="bubble-error" role="alert" data-testid={`bubble-error-${item.id}`}>{item.error.code === "MODEL_CAPABILITY_MISSING" ? t("rp.missingVision", { reason: item.error.message }) : item.error.message}</p> : null}
      {item.status === "failed" || item.status === "interrupted" || (trace && !live) ? (
        <div className="bubble-actions">
          {item.status === "failed" || item.status === "interrupted" ? <button type="button" className="secondary-button" data-testid={`bubble-retry-${item.id}`} onClick={() => props.actions.onRetry(item.runId)}><RotateCcw size={13} />{t("agent.retry")}</button> : null}
          {trace && !live ? <button type="button" className="link-button" data-testid={`bubble-trace-${item.id}`} onClick={() => trace(item.runId)}><ScrollText size={13} />{t("trace.open")}</button> : null}
        </div>
      ) : null}
    </article>
  );
}
