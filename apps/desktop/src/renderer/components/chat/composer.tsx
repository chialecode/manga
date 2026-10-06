import { useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, Plus, Sparkles, Square, TextQuote, X } from "lucide-react";
import type { Translator } from "@manga/i18n";
import type { QuickTask } from "@manga/contracts/quick-tasks";
import { Menu, type MenuItem } from "../menu.tsx";
import type { QuoteTag } from "../../lib/quote-tags.ts";
import type { AttachedImage } from "../../lib/types.ts";
import { formatClock } from "../../readers/video-model.ts";
import type { RecorderState } from "../../voice/recorder.ts";

type T = Translator["t"];

export type ChatMode = "note" | "ask";
export const SUBTITLE_AHEAD = [0, 1, 3, 10] as const;
const HOLD_AFTER_MS = 320;

/**
 * The microphone of the right pane: a short press starts and stops a recording, holding the button records while it is held and ends
 * when it is let go. Losing the pointer ends a hold, so a button that was never released cannot leave the microphone open.
 */
export function MicButton(props: { t: T; state: RecorderState; enabled: boolean; toggleKey: string; onToggle: () => void; onHoldStart: () => void; onHoldEnd: () => void; onStop: () => void; className?: string }) {
  const { t, state } = props;
  const timer = useRef<number | undefined>(undefined);
  const holding = useRef(false);
  const pressing = useRef(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!props.enabled) return null;
  const active = state.phase !== "idle";
  const label = active ? t("record.stop") : t("record.startKey", { key: props.toggleKey });

  const release = (cancelled: boolean) => {
    window.clearTimeout(timer.current);
    if (!pressing.current) return;
    pressing.current = false;
    if (holding.current) { holding.current = false; props.onHoldEnd(); return; }
    if (cancelled) return;
    if (state.phase === "idle") props.onToggle();
    else if (state.phase === "recording") props.onStop();
  };

  return (
    <button
      type="button"
      className={`icon-button chat-mic ${props.className ?? ""}`}
      data-testid="chat-mic"
      data-phase={state.phase}
      aria-pressed={active}
      aria-label={label}
      title={t("chat.mic.hint")}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        pressing.current = true;
        holding.current = false;
        if (state.phase === "idle") timer.current = window.setTimeout(() => { holding.current = true; props.onHoldStart(); }, HOLD_AFTER_MS);
      }}
      onPointerUp={() => release(false)}
      onPointerCancel={() => release(true)}
      onLostPointerCapture={() => release(true)}
      onClick={(event) => {
        // A keyboard press arrives as a click with no pointer; a mouse press was already handled on release.
        if (event.detail !== 0) return;
        if (state.phase === "idle") props.onToggle();
        else if (state.phase === "recording") props.onStop();
      }}
    >
      {state.phase === "recording" ? <Square size={15} /> : <Mic size={16} />}
      {active && state.phase !== "starting" ? <span className="chat-mic-time" data-testid="chat-mic-time">{formatClock(state.elapsedMs)}</span> : null}
    </button>
  );
}

export function QuoteTags(props: { t: T; tags: readonly QuoteTag[]; images: AttachedImage[]; onRemoveTag: (id: string) => void; onRemoveImage: (id: string) => void }) {
  const { t } = props;
  if (!props.tags.length && !props.images.length) return null;
  return (
    <ul className="chat-tags" data-testid="chat-tags" aria-label={t("chat.tags")}>
      {props.tags.map((tag) => (
        <li key={tag.id} className="chat-tag" data-testid={`chat-tag-${tag.kind}`}>
          <TextQuote size={12} aria-hidden="true" />
          <span className="chat-tag-label" title={tag.kind === "selection" ? tag.quote : tag.label}>{tag.label}</span>
          <button type="button" className="icon-button" data-testid={`chat-tag-remove-${tag.kind}`} aria-label={t("chat.tag.remove")} title={t("chat.tag.remove")} onClick={() => props.onRemoveTag(tag.id)}><X size={12} /></button>
        </li>
      ))}
      {props.images.map((image) => (
        <li key={image.materialId} className="chat-tag chat-tag-image" data-testid={`agent-image-${image.materialId}`}>
          <img src={image.preview} alt={image.extraction} width={22} height={22} />
          <span className="chat-tag-label">{image.extraction}</span>
          <button type="button" className="icon-button" data-testid={`agent-image-remove-${image.materialId}`} aria-label={t("rp.attach.remove")} title={t("rp.attach.remove")} onClick={() => props.onRemoveImage(image.materialId)}><X size={12} /></button>
        </li>
      ))}
    </ul>
  );
}

export function QuickChips(props: { t: T; tasks: Array<{ task: QuickTask; label: string }>; busy: boolean; onRun: (task: QuickTask) => void }) {
  if (!props.tasks.length) return null;
  return (
    <div className="chat-quick" data-testid="chat-quick" aria-label={props.t("chat.quick.label")}>
      {props.tasks.map(({ task, label }) => (
        <button key={task.id} type="button" className="chat-chip" data-testid={`quick-${task.builtinKey ?? task.id}`} disabled={props.busy && task.sendMode === "send"} title={task.template} onClick={() => props.onRun(task)}><Sparkles size={12} />{label}</button>
      ))}
    </div>
  );
}

export type ComposerProps = {
  t: T;
  value: string;
  onChange: (value: string) => void;
  mode: ChatMode;
  onMode: (mode: ChatMode) => void;
  /** False where a note has no resource or work to belong to: the input only asks the Agent there. */
  canNote?: boolean;
  tags: readonly QuoteTag[];
  images: AttachedImage[];
  onRemoveTag: (id: string) => void;
  onRemoveImage: (id: string) => void;
  quick: Array<{ task: QuickTask; label: string }>;
  onQuick: (task: QuickTask) => void;
  noModel: boolean;
  onSettings: () => void;
  running: boolean;
  onStop: () => void;
  onSend: () => void;
  sending: boolean;
  /** What the "+" menu can offer here: the attach buttons need an open reader, the others a module. */
  plus: { attach: "page" | "frame" | null; online: boolean; subtitle: boolean; allowOnline: boolean; subtitleAheadMin: number; materials: number };
  onAttach: (what: "page" | "frame") => void;
  onToggleOnline: () => void;
  onSubtitleAhead: (minutes: number) => void;
  onMaterials: () => void;
  mic: Parameters<typeof MicButton>[0] | null;
  placeholder?: string;
  inputTestId?: string;
};

/** Everything the user can do from the input: note or ask, the picked tags, quick tasks, the "+" menu, the microphone and send. */
export function Composer(props: ComposerProps) {
  const { t } = props;
  const [composing, setComposing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const can = props.value.trim().length > 0 || (props.mode === "note" && props.tags.length > 0);
  const plus: MenuItem[] = [];
  if (props.plus.attach) plus.push({ id: "attach", label: props.plus.attach === "page" ? t("rp.attach.page") : t("rp.attach.frame"), onSelect: () => props.onAttach(props.plus.attach!), disabled: props.images.length >= 4 });
  if (props.plus.online) plus.push({ id: "online", label: t("chat.plus.online"), checked: props.plus.allowOnline, onSelect: props.onToggleOnline });
  if (props.plus.subtitle) for (const minutes of SUBTITLE_AHEAD) plus.push({ id: `ahead-${minutes}`, label: minutes === 0 ? t("rp.subtitle.default") : t("rp.subtitle.ahead", { minutes }), checked: props.plus.subtitleAheadMin === minutes, onSelect: () => props.onSubtitleAhead(minutes) });
  plus.push({ id: "materials", label: props.plus.materials ? t("chat.plus.materialsCount", { count: props.plus.materials }) : t("chat.plus.materials"), onSelect: props.onMaterials });

  return (
    <div className="chat-composer" data-testid="chat-composer">
      {props.noModel ? (
        <p className="chat-nomodel" role="status" data-testid="chat-no-model">
          {t("chat.noModel")}
          <button type="button" className="link-button" data-testid="chat-no-model-settings" onClick={props.onSettings}>{t("chat.noModel.go")}</button>
        </p>
      ) : null}
      <QuickChips t={t} tasks={props.quick} busy={props.running} onRun={props.onQuick} />
      <div className="chat-box">
        <QuoteTags t={t} tags={props.tags} images={props.images} onRemoveTag={props.onRemoveTag} onRemoveImage={props.onRemoveImage} />
        <textarea
          ref={area}
          className="chat-input"
          data-testid={props.inputTestId ?? "agent-composer"}
          aria-label={props.mode === "note" ? t("chat.placeholder.note") : t("chat.placeholder.ask")}
          placeholder={props.placeholder ?? (props.mode === "note" ? t("chat.placeholder.note") : t("chat.placeholder.ask"))}
          rows={2}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            // Enter confirms a candidate in an input method; it only sends when nothing is being composed.
            if (event.key === "Enter" && !event.shiftKey && !composing && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (can) props.onSend();
            }
          }}
        />
        <div className="chat-bar">
          {props.canNote !== false ? (
            <div className="chat-switch" role="group" aria-label={t("chat.mode")}>
              <button type="button" aria-pressed={props.mode === "note"} data-testid="chat-mode-note" onClick={() => props.onMode("note")}>{t("chat.mode.note")}</button>
              <button type="button" aria-pressed={props.mode === "ask"} data-testid="chat-mode-ask" onClick={() => props.onMode("ask")}>{t("chat.mode.ask")}</button>
            </div>
          ) : null}
          <span className="flex-1" />
          <Menu label={t("chat.plus")} testId="chat-plus" align="end" trigger={<Plus size={16} />} items={plus} />
          {props.mic ? <MicButton {...props.mic} /> : null}
          {props.running ? (
            <button type="button" className="chat-send" data-testid="agent-stop" aria-label={t("agent.stop")} title={t("agent.stop")} onClick={props.onStop}><Square size={14} /></button>
          ) : (
            <button type="button" className="chat-send" data-testid="agent-send" aria-label={props.mode === "note" ? t("chat.send.note") : t("agent.send")} title={props.mode === "note" ? t("chat.send.note") : t("agent.send")} disabled={!can || props.sending} onClick={props.onSend}><ArrowUp size={16} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
