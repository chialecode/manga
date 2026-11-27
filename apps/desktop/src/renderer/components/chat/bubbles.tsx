import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  Check,
  Copy,
  FileText,
  Image as ImageIcon,
  MessageSquareQuote,
  Mic,
  Pause,
  Pencil,
  Play,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import { SPEECH_VOICES, type SpeechVoice } from "@manga/contracts";
import type { MessageKey, Translator } from "@manga/i18n";
import { attempt } from "../../lib/api.ts";
import { localizeChatError } from "../../lib/chat-errors.ts";
import { noteSourceLabel, voiceSourceLabel } from "../../lib/chat-model.ts";
import { isImeEvent } from "../../lib/ime.ts";
import { formatClock } from "../../readers/video-model.ts";
import type { StreamAgent, StreamItem, StreamNote, StreamUser, StreamVoice } from "../../hooks/use-session-stream.ts";
import {
  readAloud,
  readAloudProblem,
  setReadAloudVoice,
  stripMarkdownForSpeech,
  useReadAloud,
  useReadAloudVoice,
} from "../../voice/read-aloud.ts";
import { collectSources, SourcesFooter } from "./citations.tsx";
import { ChatMarkdown } from "./markdown.tsx";
import { ProposalGroup } from "./proposal-cards.tsx";
import { ThinkingTimeline } from "./timeline.tsx";

type T = Translator["t"];

export type BubbleActions = {
  onJumpNote: (note: StreamNote) => void;
  onJumpVoice: (voice: StreamVoice, source?: StreamVoice["sources"][number]) => void;
  onEditNote: (note: StreamNote, text: string) => Promise<boolean>;
  onDeleteNote: (note: StreamNote) => Promise<void>;
  onQuoteNote: (note: StreamNote) => void;
  onOpenRecording: (voice: StreamVoice) => void;
  onRetry: (runId: string) => void;
  /** Regenerate an assistant reply as a fresh run. */
  onRegenerate?: (runId: string) => void;
  /** Continue a cancelled or max_tokens assistant reply. */
  onContinue?: (runId: string) => void;
  /** Save a finished assistant reply (with formatted citations) as a note. */
  onSaveNote?: (item: StreamAgent) => Promise<boolean>;
  /** Edit an earlier user prompt and resend in the same session. */
  onEditUser?: (runId: string, text: string) => Promise<boolean>;
  /** Jump directly to model settings from an auth/balance/plugin error. */
  onOpenSettings?: () => void;
  /** Open the trace of the task that made a reply (what it sent, what came back, in order). */
  onOpenTrace?: (runId: string) => void;
  /** Called after a proposal is applied or rejected so the stream and workspace refresh. */
  onProposalChanged?: () => void;
  /** Whether a finished answer can be read aloud: a speech connection is configured and its plugin is on (计划 4.7). */
  readAloud?: boolean;
  /** Whether WebSocket streaming TTS is available on the active speech service. */
  streamingTts?: boolean;
  /** Whether this conversation surface has a resource/work anchor that supports saving notes. */
  canSaveNote?: boolean;
};

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export const Bubble = memo(function Bubble(props: { t: T; item: StreamItem; actions: BubbleActions; formatDate: (value: string) => string }) {
  const { item } = props;
  if (item.kind === "note") return <NoteBubble t={props.t} item={item} actions={props.actions} formatDate={props.formatDate} />;
  if (item.kind === "voice") return <VoiceBubble t={props.t} item={item} actions={props.actions} formatDate={props.formatDate} />;
  if (item.kind === "user") return <UserBubble t={props.t} item={item} actions={props.actions} />;
  return <AgentBubble t={props.t} item={item} actions={props.actions} formatDate={props.formatDate} />;
});

const NoteBubble = memo(function NoteBubble(props: { t: T; item: StreamNote; actions: BubbleActions; formatDate: (value: string) => string }) {
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
});

const LIVE_STAGES = new Set(["recording", "recorded", "filtering", "awaiting_asr", "transcribing", "pending"]);

const VoiceBubble = memo(function VoiceBubble(props: { t: T; item: StreamVoice; actions: BubbleActions; formatDate: (value: string) => string }) {
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
});

const UserBubble = memo(function UserBubble(props: { t: T; item: StreamUser; actions: BubbleActions }) {
  const { t, item, actions } = props;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  async function submitEdit() {
    if (busy || !actions.onEditUser) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const ok = await actions.onEditUser(item.runId, trimmed);
      if (ok) setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="bubble bubble-user" data-testid={`bubble-user-${item.id}`} data-kind="user">
      {item.quickTask ? (
        <header className="bubble-head">
          <span className="chip chip-accent" data-testid={`bubble-quick-${item.id}`}><Sparkles size={11} />{t("chat.quick.tag")} · {item.quickTask.name}</span>
          <button type="button" className="link-button" aria-expanded={open} data-testid={`bubble-quick-toggle-${item.id}`} onClick={() => setOpen((value) => !value)}>{open ? t("chat.quick.hide") : t("chat.quick.show")}</button>
        </header>
      ) : null}
      {item.attachments?.length ? (
        <ul className="bubble-attachments" data-testid={`bubble-attachments-${item.id}`}>
          {item.attachments.map((att) => (
            <li key={att.id} className="bubble-attachment-chip">
              {att.kind === "image" ? <ImageIcon size={12} aria-hidden="true" /> : <FileText size={12} aria-hidden="true" />}
              <span className="truncate">{att.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {editing ? (
        <div className="bubble-edit bubble-user-edit">
          <textarea
            data-testid={`bubble-user-edit-input-${item.id}`}
            value={draft}
            rows={3}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              if (isImeEvent(event, composing)) return;
              if (event.key === "Escape") { event.stopPropagation(); setEditing(false); setDraft(item.text); }
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey || !event.shiftKey)) {
                event.preventDefault();
                void submitEdit();
              }
            }}
          />
          <div className="bubble-actions">
            <button type="button" className="primary-button" data-testid={`bubble-user-edit-send-${item.id}`} disabled={busy || !draft.trim()} onClick={() => void submitEdit()}>{t("chat.action.editSend")}</button>
            <button type="button" className="secondary-button" onClick={() => { setEditing(false); setDraft(item.text); }}>{t("chat.cancel")}</button>
          </div>
        </div>
      ) : (!item.quickTask || open ? <p className="bubble-text">{item.text}</p> : null)}
      {!editing ? (
        <div className="bubble-actions bubble-tools bubble-user-tools">
          <button
            type="button"
            className="icon-button"
            data-testid={`bubble-user-copy-${item.id}`}
            aria-label={copied ? t("chat.action.copied") : t("chat.action.copy")}
            title={copied ? t("chat.action.copied") : t("chat.action.copy")}
            onClick={() => {
              void copyToClipboard(item.text).then((ok) => {
                if (!ok) return;
                setCopied(true);
                window.clearTimeout(copyTimer.current);
                copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          {actions.onEditUser && !item.quickTask ? (
            <button
              type="button"
              className="icon-button"
              data-testid={`bubble-user-edit-${item.id}`}
              aria-label={t("chat.action.edit")}
              title={t("chat.action.edit")}
              onClick={() => { setDraft(item.text); setEditing(true); }}
            >
              <Pencil size={13} />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

/** 4-bar animated equalizer icon shown while an assistant reply is being read aloud. */
function ReadingBars(props: { active: boolean }) {
  return (
    <svg className={`read-bars ${props.active ? "is-playing" : ""}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect className="read-bar read-bar-1" x="1" y="4" width="2" height="6" rx="1" fill="currentColor" />
      <rect className="read-bar read-bar-2" x="4.5" y="2" width="2" height="10" rx="1" fill="currentColor" />
      <rect className="read-bar read-bar-3" x="8" y="5" width="2" height="5" rx="1" fill="currentColor" />
      <rect className="read-bar read-bar-4" x="11.5" y="3" width="2" height="8" rx="1" fill="currentColor" />
    </svg>
  );
}

/**
 * Reads a finished answer aloud (计划 4.7): only the answer's cleaned text (without Markdown syntax, code blocks, or URLs),
 * never its thinking or sources. Supports voice switching (`stella`/`tide`) and WebSocket streaming TTS when available.
 */
function ReadAloudButton(props: { t: T; id: string; text: string; streamingTts?: boolean }) {
  const { t } = props;
  const state = useReadAloud();
  const voice = useReadAloudVoice();
  const owner = `answer:${props.id}`;
  const mine = state.owner === owner;
  const start = (overrideVoice?: SpeechVoice) => {
    const cleaned = stripMarkdownForSpeech(props.text) || props.text;
    const segments = cleaned.split(/\n{2,}/).filter((seg) => seg.trim().length > 0);
    void readAloud.play({
      owner,
      segments: segments.length ? segments : [props.text],
      task: "read-aloud",
      voice: overrideVoice ?? voice,
      streaming: props.streamingTts,
    });
  };
  const cycleVoice = () => {
    const nextIdx = (SPEECH_VOICES.indexOf(voice) + 1) % SPEECH_VOICES.length;
    const nextVoice = SPEECH_VOICES[nextIdx]!;
    setReadAloudVoice(nextVoice);
    if (mine && (state.status === "playing" || state.status === "loading")) {
      start(nextVoice);
    }
  };
  const problem = mine && state.status === "error" ? readAloudProblem(state.error) : null;
  if (problem) {
    return (
      <span className="read-aloud" data-testid={`bubble-read-error-${props.id}`}>
        <span className="bubble-error" role="alert">{t(problem.key as MessageKey)}</span>
        {problem.retry ? <button type="button" className="link-button" data-testid={`bubble-read-retry-${props.id}`} onClick={() => start()}><RotateCcw size={13} />{t("readAloud.retry")}</button> : null}
      </span>
    );
  }
  if (!mine || state.status === "idle") {
    return (
      <span className="read-aloud">
        <button type="button" className="bubble-action-btn" data-testid={`bubble-read-${props.id}`} data-read-answer={props.id} title={t("readAloud.read")} onClick={() => start()}>
          <Volume2 size={13} aria-hidden="true" />
          <span>{t("readAloud.read")}</span>
        </button>
      </span>
    );
  }
  const voiceLabel = t(`readAloud.voice.${voice}` as MessageKey);
  return (
    <span className="read-aloud" data-testid={`bubble-reading-${props.id}`} data-status={state.status}>
      {state.status === "paused"
        ? <button type="button" className="bubble-action-btn" data-testid={`bubble-read-resume-${props.id}`} onClick={() => readAloud.resume()}><Play size={13} aria-hidden="true" /><span>{t("readAloud.resume")}</span></button>
        : <button type="button" className="bubble-action-btn is-active" data-testid={`bubble-read-pause-${props.id}`} onClick={() => readAloud.pause()}><ReadingBars active={state.status === "playing"} /><span>{state.status === "loading" ? t("readAloud.loading") : t("readAloud.pause")}</span></button>}
      <button type="button" className="bubble-action-btn" data-testid={`bubble-read-voice-${props.id}`} aria-label={t("chat.action.voice")} title={`${t("chat.action.voice")} · ${voiceLabel}`} onClick={cycleVoice}>
        <span>{voiceLabel}</span>
      </button>
      <button type="button" className="bubble-action-btn" data-testid={`bubble-read-stop-${props.id}`} onClick={() => readAloud.stop()}><Square size={12} aria-hidden="true" /><span>{t("readAloud.stop")}</span></button>
    </span>
  );
}

function formatCompactCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

const AgentBubble = memo(function AgentBubble(props: { t: T; item: StreamAgent; actions: BubbleActions; formatDate: (value: string) => string }) {
  const { t, item, actions } = props;
  const live = item.status === "running" || item.status === "queued" || item.status === "waiting_input";
  const trace = actions.onOpenTrace;
  const proposals = item.proposals ?? [];
  const sources = useMemo(() => collectSources(item.citations, item.search, item.serverToolSteps), [item.citations, item.search, item.serverToolSteps]);
  const localizedError = useMemo(() => (
    item.error || item.errorCode || item.refusal || item.stopReason === "refusal"
      ? localizeChatError(t, item)
      : null
  ), [t, item]);

  const [copied, setCopied] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const noteTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    window.clearTimeout(copyTimer.current);
    window.clearTimeout(noteTimer.current);
  }, []);

  const canContinue = Boolean(!live && actions.onContinue && (item.canContinue || item.status === "cancelled" || item.stopReason === "max_tokens"));
  const canRegenerate = Boolean(!live && (actions.onRegenerate || item.status === "succeeded" || item.status === "cancelled"));
  const canSaveAsNote = Boolean(!live && actions.canSaveNote && actions.onSaveNote && item.text.trim());
  const showRetry = item.status === "failed" || item.status === "interrupted";
  const showActions = !live || showRetry;

  const usageParts = useMemo(() => {
    const u = item.usage;
    if (!u) return [];
    const parts: string[] = [];
    if (typeof u.inputTokens === "number" || typeof u.outputTokens === "number") {
      parts.push(t("chat.usage.tokens", { input: formatCompactCount(u.inputTokens ?? 0), output: formatCompactCount(u.outputTokens ?? 0) }));
    }
    if (typeof u.cachedInputTokens === "number" && u.cachedInputTokens > 0) {
      parts.push(t("chat.usage.cached", { count: formatCompactCount(u.cachedInputTokens) }));
    }
    if (typeof u.searches === "number" && u.searches > 0) {
      parts.push(t("chat.usage.searches", { count: u.searches }));
    }
    if (typeof u.estimatedCost === "number" && u.estimatedCost > 0) {
      const symbol = u.currency === "CNY" ? "¥" : "$";
      parts.push(t("chat.usage.cost", { cost: `${symbol}${u.estimatedCost.toFixed(4)}` }));
    }
    return parts;
  }, [item.usage, t]);

  return (
    <article className="bubble bubble-agent" data-testid={`bubble-agent-${item.id}`} data-status={item.status} data-kind="agent">
      <header className="bubble-head">
        <span className="bubble-kind"><Sparkles size={12} aria-hidden="true" />{t("chat.kind.agent")}</span>
        {item.modelId ? <span className="bubble-model-tag">{item.modelId}</span> : null}
        {live ? <span className="bubble-live-pill timeline-shimmer">{t("chat.streaming")}</span> : null}
      </header>

      <ThinkingTimeline t={t} item={item} live={live} />

      {item.text ? (
        <ChatMarkdown t={t} text={item.text} streaming={live} citations={item.citations} sources={sources} />
      ) : live ? (
        <p className="bubble-text detail-muted timeline-shimmer" role="status">{t("chat.agent.working")}</p>
      ) : null}

      {!live && sources.length > 0 ? <SourcesFooter t={t} id={item.id} sources={sources} /> : null}

      {proposals.length > 0 ? <ProposalGroup t={t} runId={item.runId} proposals={proposals} formatDate={props.formatDate} onChanged={actions.onProposalChanged} /> : null}

      {localizedError ? (
        <div className="bubble-error-box" role="alert" data-testid={`bubble-error-${item.id}`} data-error-code={localizedError.code}>
          <p className="bubble-error">{localizedError.message}</p>
          {localizedError.action === "settings" && actions.onOpenSettings ? (
            <button type="button" className="link-button bubble-error-action" data-testid={`bubble-error-settings-${item.id}`} onClick={actions.onOpenSettings}>
              <Settings size={12} aria-hidden="true" />
              <span>{t("chat.error.openSettings")}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {showActions ? (
        <div className="bubble-actions bubble-agent-actions">
          {!live && item.text ? (
            <button
              type="button"
              className="bubble-action-btn"
              data-testid={`bubble-copy-${item.id}`}
              aria-label={copied ? t("chat.action.copied") : t("chat.action.copy")}
              title={copied ? t("chat.action.copied") : t("chat.action.copy")}
              onClick={() => {
                void copyToClipboard(item.text).then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  window.clearTimeout(copyTimer.current);
                  copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              <span>{copied ? t("chat.action.copied") : t("chat.action.copy")}</span>
            </button>
          ) : null}

          {actions.readAloud && !live && item.text ? (
            <ReadAloudButton t={t} id={item.id} text={item.text} streamingTts={actions.streamingTts} />
          ) : null}

          {canContinue ? (
            <button
              type="button"
              className="bubble-action-btn bubble-action-accent"
              data-testid={`bubble-continue-${item.id}`}
              onClick={() => actions.onContinue?.(item.runId)}
            >
              <PlayCircle size={13} aria-hidden="true" />
              <span>{t("chat.action.continue")}</span>
            </button>
          ) : null}

          {canRegenerate && actions.onRegenerate ? (
            <button
              type="button"
              className="bubble-action-btn"
              data-testid={`bubble-regenerate-${item.id}`}
              title={t("chat.action.regenerate")}
              onClick={() => actions.onRegenerate!(item.runId)}
            >
              <RefreshCw size={13} aria-hidden="true" />
              <span>{t("chat.action.regenerate")}</span>
            </button>
          ) : null}

          {canSaveAsNote ? (
            <button
              type="button"
              className="bubble-action-btn"
              data-testid={`bubble-save-note-${item.id}`}
              disabled={savingNote}
              onClick={() => {
                if (savingNote || !actions.onSaveNote) return;
                setSavingNote(true);
                void actions.onSaveNote(item).then((ok) => {
                  if (ok) {
                    setSavedNote(true);
                    window.clearTimeout(noteTimer.current);
                    noteTimer.current = window.setTimeout(() => setSavedNote(false), 1500);
                  }
                }).finally(() => setSavingNote(false));
              }}
            >
              {savedNote ? <Check size={13} aria-hidden="true" /> : <BookmarkPlus size={13} aria-hidden="true" />}
              <span>{savedNote ? t("chat.action.savedNote") : t("chat.action.saveNote")}</span>
            </button>
          ) : null}

          {showRetry ? (
            <button type="button" className="secondary-button" data-testid={`bubble-retry-${item.id}`} onClick={() => actions.onRetry(item.runId)}>
              <RotateCcw size={13} aria-hidden="true" />
              <span>{t("agent.retry")}</span>
            </button>
          ) : null}

          {trace && !live ? (
            <button
              type="button"
              className="bubble-action-btn bubble-action-subtle"
              data-testid={`bubble-trace-${item.id}`}
              title={t("trace.open")}
              onClick={() => trace(item.runId)}
            >
              <ScrollText size={13} aria-hidden="true" />
              <span>{t("trace.open")}</span>
            </button>
          ) : null}

          {!live && usageParts.length > 0 ? (
            <span className="bubble-usage" data-testid={`bubble-usage-${item.id}`}>
              {usageParts.join(" · ")}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});
