import { useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ArrowDown, MessageSquareQuote, Mic, Pause, Pencil, Play, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { attempt } from "../../lib/api.ts";
import { noteSourceLabel, voiceSourceLabel } from "../../lib/chat-model.ts";
import { formatClock } from "../../readers/video-model.ts";
import type { StreamAgent, StreamItem, StreamNote, StreamUser, StreamVoice } from "../../hooks/use-session-stream.ts";

/*
 * The structure of this list (a log region that sticks to the bottom while an answer streams, a scroll-down button, bubbles by
 * kind) follows the conversation and message components of Vercel ai-elements (Apache-2.0, https://github.com/vercel/ai-elements).
 * The code is written for MANGA's own message kinds and styles; nothing is imported from the `ai` package. The scroll behaviour
 * is `use-stick-to-bottom` (MIT, https://github.com/stackblitz-labs/use-stick-to-bottom).
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
};

function ScrollButton(props: { label: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return <button type="button" className="chat-scroll-bottom" data-testid="chat-scroll-bottom" aria-label={props.label} title={props.label} onClick={() => { void scrollToBottom(); }}><ArrowDown size={16} /></button>;
}

/** Open a bound resource and the pane is at the newest message; an old message is read by scrolling up and is not pulled away from. */
export function MessageList(props: { t: T; items: StreamItem[]; hasMore: boolean; onOlder: () => void; actions: BubbleActions; empty: ReactNode; formatDate: (value: string) => string; limited?: boolean }) {
  const { t } = props;
  return (
    <StickToBottom className="chat-log" initial="instant" resize="smooth" role="log" aria-label={t("chat.log")} data-testid="chat-log">
      <StickToBottom.Content className={`chat-log-content ${props.limited ? "chat-log-wide" : ""}`}>
        {props.hasMore ? <button type="button" className="link-button chat-older" data-testid="chat-older" onClick={props.onOlder}>{t("chat.older")}</button> : null}
        {props.items.length === 0 ? <div className="chat-empty" data-testid="chat-empty">{props.empty}</div> : null}
        {props.items.map((item) => <Bubble key={item.id} t={t} item={item} actions={props.actions} formatDate={props.formatDate} />)}
      </StickToBottom.Content>
      <ScrollButton label={t("chat.toBottom")} />
    </StickToBottom>
  );
}

function Bubble(props: { t: T; item: StreamItem; actions: BubbleActions; formatDate: (value: string) => string }) {
  const { item } = props;
  if (item.kind === "note") return <NoteBubble t={props.t} item={item} actions={props.actions} formatDate={props.formatDate} />;
  if (item.kind === "voice") return <VoiceBubble t={props.t} item={item} actions={props.actions} formatDate={props.formatDate} />;
  if (item.kind === "user") return <UserBubble t={props.t} item={item} />;
  return <AgentBubble t={props.t} item={item} actions={props.actions} />;
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

function AgentBubble(props: { t: T; item: StreamAgent; actions: BubbleActions }) {
  const { t, item } = props;
  const live = item.status === "running" || item.status === "queued" || item.status === "waiting_input";
  return (
    <article className="bubble bubble-agent" data-testid={`bubble-agent-${item.id}`} data-status={item.status} data-kind="agent">
      <header className="bubble-head"><span className="bubble-kind"><Sparkles size={12} />MANGA Agent</span></header>
      {item.text ? <div className="bubble-text bubble-markdown"><Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown></div> : live ? <p className="bubble-text detail-muted" role="status">{t("chat.agent.working")}</p> : null}
      {item.error ? <p className="bubble-error" role="alert" data-testid={`bubble-error-${item.id}`}>{item.error.code === "MODEL_CAPABILITY_MISSING" ? t("rp.missingVision", { reason: item.error.message }) : item.error.message}</p> : null}
      {item.status === "failed" || item.status === "interrupted" ? (
        <div className="bubble-actions"><button type="button" className="secondary-button" data-testid={`bubble-retry-${item.id}`} onClick={() => props.actions.onRetry(item.runId)}><RotateCcw size={13} />{t("agent.retry")}</button></div>
      ) : null}
    </article>
  );
}
