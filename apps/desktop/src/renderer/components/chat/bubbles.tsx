import { useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageSquareQuote, Mic, Pause, Pencil, Play, RotateCcw, ScrollText, Sparkles, Square, Trash2, Volume2 } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { attempt } from "../../lib/api.ts";
import { noteSourceLabel, voiceSourceLabel } from "../../lib/chat-model.ts";
import { isImeEvent } from "../../lib/ime.ts";
import { formatClock } from "../../readers/video-model.ts";
import type { StreamAgent, StreamItem, StreamNote, StreamUser, StreamVoice } from "../../hooks/use-session-stream.ts";
import { readAloud, readAloudProblem, useReadAloud } from "../../voice/read-aloud.ts";
import { ProposalGroup } from "./proposal-cards.tsx";

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
  /** Whether a finished answer can be read aloud: a speech connection is configured and its plugin is on (计划 4.7). */
  readAloud?: boolean;
};

const siteOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const openLink = (url: string) => { if (/^https?:\/\//i.test(url)) void window.manga.openExternal?.(url); };

const REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) openLink(href);
      }}
    >
      {children}
    </a>
  ),
};

export function Bubble(props: { t: T; item: StreamItem; actions: BubbleActions; formatDate: (value: string) => string }) {
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
    try {
      const saved = await actions.onEditNote(item, draft);
      if (saved) setEditing(false);
    } finally {
      setBusy(false);
    }
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
              if (isImeEvent(event, composing)) return;
              if (event.key === "Escape") { event.stopPropagation(); setEditing(false); setDraft(item.text); }
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
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
  const mounted = useRef(true);
  const [playing, setPlaying] = useState(false);
  const stage = t(`review.stage.${item.stage}` as MessageKey);
  useEffect(() => {
    mounted.current = true;
    const element = audio.current;
    return () => {
      mounted.current = false;
      element?.pause();
    };
  }, []);

  async function toggle() {
    const element = audio.current;
    if (!element) return;
    if (playing) { element.pause(); return; }
    if (!element.src) {
      const handle = await attempt<{ url: string }>("capture.audioHandle", { sessionId: item.id });
      if (!handle.ok || !mounted.current || audio.current !== element) return;
      element.src = handle.value.url;
    }
    if (!mounted.current || audio.current !== element) return;
    try { await element.play(); } catch { if (mounted.current) setPlaying(false); }
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

/**
 * What came with an answer besides its words (计划 4.3/4.4): the thinking, folded; the searches the service ran and the pages it read, while it runs; the sources
 * the answer cites, opened in the system browser.
 */
function AnswerExtras(props: { t: T; item: StreamAgent; live: boolean }) {
  const { t, item } = props;
  const search = item.search ?? [];
  const sources = item.citations?.length ? item.citations : search.flatMap((step) => (step.kind === "done" ? step.sources : []));
  const unique = sources.filter((source, index) => sources.findIndex((other) => other.url === source.url) === index).slice(0, 12);
  const last = search[search.length - 1];
  return (
    <>
      {item.thinkingRaised ? <p className="detail-muted" data-testid={`bubble-thinking-raised-${item.id}`}>{t("chat.thinkingRaised")}</p> : null}
      {item.reasoning ? (
        <details className="bubble-thinking" data-testid={`bubble-thinking-${item.id}`}>
          <summary>{t("chat.thinking")}</summary>
          <p className="bubble-text detail-muted">{item.reasoning}</p>
        </details>
      ) : null}
      {props.live && last && last.kind !== "done" ? (
        <p className="detail-muted" role="status" data-testid={`bubble-search-${item.id}`}>
          {"queries" in last ? t("chat.searching", { query: last.queries.join("、") }) : t("chat.reading", { site: siteOf(last.url) })}
        </p>
      ) : null}
      {!props.live && unique.length ? (
        <div className="bubble-sources bubble-citations" data-testid={`bubble-sources-${item.id}`}>
          <span className="detail-muted">{t("chat.sources")}</span>
          <ol>
            {unique.map((source) => (
              <li key={source.url}>
                <button type="button" className="link-button" title={source.url} onClick={() => openLink(source.url)}>{source.title || siteOf(source.url)}</button>
                <span className="detail-muted"> · {siteOf(source.url)}{"publishedAt" in source && source.publishedAt ? ` · ${source.publishedAt}` : ""}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </>
  );
}

/**
 * Reads a finished answer aloud (计划 4.7): only the answer's text, not its thinking or its sources. One reading at a time; another answer's reading stops
 * this one. Paragraphs are asked for one after the other, so the first is heard before the rest has arrived.
 */
function ReadAloudButton(props: { t: T; id: string; text: string }) {
  const { t } = props;
  const state = useReadAloud();
  const owner = `answer:${props.id}`;
  const mine = state.owner === owner;
  const start = () => void readAloud.play({ owner, segments: props.text.split(/\n{2,}/), task: "read-aloud" });
  const problem = mine && state.status === "error" ? readAloudProblem(state.error) : null;
  if (problem) {
    return (
      <span className="read-aloud" data-testid={`bubble-read-error-${props.id}`}>
        <span className="bubble-error" role="alert">{t(problem.key as MessageKey)}</span>
        {problem.retry ? <button type="button" className="link-button" data-testid={`bubble-read-retry-${props.id}`} onClick={start}><RotateCcw size={13} />{t("readAloud.retry")}</button> : null}
      </span>
    );
  }
  if (!mine || state.status === "idle") {
    return <button type="button" className="link-button" data-testid={`bubble-read-${props.id}`} data-read-answer={props.id} onClick={start}><Volume2 size={13} />{t("readAloud.read")}</button>;
  }
  return (
    <span className="read-aloud" data-testid={`bubble-reading-${props.id}`} data-status={state.status}>
      {state.status === "paused"
        ? <button type="button" className="link-button" data-testid={`bubble-read-resume-${props.id}`} onClick={() => readAloud.resume()}><Play size={13} />{t("readAloud.resume")}</button>
        : <button type="button" className="link-button" data-testid={`bubble-read-pause-${props.id}`} onClick={() => readAloud.pause()}><Pause size={13} />{state.status === "loading" ? t("readAloud.loading") : t("readAloud.pause")}</button>}
      <button type="button" className="link-button" data-testid={`bubble-read-stop-${props.id}`} onClick={() => readAloud.stop()}><Square size={13} />{t("readAloud.stop")}</button>
    </span>
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
      <AnswerExtras t={t} item={item} live={live} />
      {item.text ? <div className="bubble-text bubble-markdown"><Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{item.text}</Markdown></div> : live ? <p className="bubble-text detail-muted" role="status">{t("chat.agent.working")}</p> : null}
      {proposals.length > 0 ? <ProposalGroup t={t} runId={item.runId} proposals={proposals} formatDate={props.formatDate} onChanged={props.actions.onProposalChanged} /> : null}
      {item.error ? <p className="bubble-error" role="alert" data-testid={`bubble-error-${item.id}`}>{item.error.code === "MODEL_CAPABILITY_MISSING" ? t("rp.missingVision", { reason: item.error.message }) : item.error.message}</p> : null}
      {item.status === "failed" || item.status === "interrupted" || (trace && !live) || (props.actions.readAloud && !live && item.text) ? (
        <div className="bubble-actions">
          {props.actions.readAloud && !live && item.text ? <ReadAloudButton t={t} id={item.id} text={item.text} /> : null}
          {item.status === "failed" || item.status === "interrupted" ? <button type="button" className="secondary-button" data-testid={`bubble-retry-${item.id}`} onClick={() => props.actions.onRetry(item.runId)}><RotateCcw size={13} />{t("agent.retry")}</button> : null}
          {trace && !live ? <button type="button" className="link-button" data-testid={`bubble-trace-${item.id}`} onClick={() => trace(item.runId)}><ScrollText size={13} />{t("trace.open")}</button> : null}
        </div>
      ) : null}
    </article>
  );
}
