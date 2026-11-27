import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { ArrowUp, Brain, FileText, Globe, Mic, Paperclip, Plus, Sparkles, Square, TextQuote, X } from "lucide-react";
import type { Translator } from "@manga/i18n";
import type { QuickTask } from "@manga/contracts/quick-tasks";
import { Menu, type MenuItem } from "../menu.tsx";
import { isImeEvent } from "../../lib/ime.ts";
import type { QuoteTag } from "../../lib/quote-tags.ts";
import type { AttachedImage, ComposerFileAttachment } from "../../lib/types.ts";
import { formatClock } from "../../readers/video-model.ts";
import type { RecorderState } from "../../voice/recorder.ts";
import { useDraftText } from "../../workspace/drafts.ts";

type T = Translator["t"];

export type ChatMode = "note" | "ask";
export const SUBTITLE_AHEAD = [0, 1, 3, 10] as const;
const HOLD_AFTER_MS = 320;
const NARROW_WIDTH_PX = 390;

/**
 * The microphone of the right pane: a short press starts and stops a recording, holding the button records while it is held and ends
 * when it is let go. Losing the pointer ends a hold, so a button that was never released cannot leave the microphone open.
 */
export function MicButton(props: { t: T; state: RecorderState; enabled: boolean; toggleKey: string; onToggle: () => void; onHoldStart: () => void; onHoldEnd: () => void; onStop: () => void; className?: string }) {
  const { t, state } = props;
  const timer = useRef<number | undefined>(undefined);
  const holding = useRef(false);
  const pressing = useRef(false);
  const onHoldEndRef = useRef(props.onHoldEnd);
  onHoldEndRef.current = props.onHoldEnd;
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (holding.current) {
      holding.current = false;
      onHoldEndRef.current();
    }
  }, []);
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
      onDragStart={(event) => event.preventDefault()}
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

export function QuoteTags(props: {
  t: T;
  tags: readonly QuoteTag[];
  images: AttachedImage[];
  files?: readonly ComposerFileAttachment[];
  onRemoveTag: (id: string) => void;
  onRemoveImage: (id: string) => void;
  onRemoveFile?: (id: string) => void;
}) {
  const { t, files = [] } = props;
  if (!props.tags.length && !props.images.length && !files.length) return null;
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
      {files.map((file) => (
        <li key={file.id} className={`chat-tag ${file.preview ? "chat-tag-image" : "chat-tag-file"}`} data-testid={`agent-file-${file.id}`}>
          {file.preview ? <img src={file.preview} alt={file.name} width={22} height={22} /> : <FileText size={12} aria-hidden="true" />}
          <span className="chat-tag-label" title={file.name}>{file.name}</span>
          {props.onRemoveFile ? (
            <button type="button" className="icon-button" data-testid={`agent-file-remove-${file.id}`} aria-label={t("chat.attach.remove")} title={t("chat.attach.remove")} onClick={() => props.onRemoveFile!(file.id)}><X size={12} /></button>
          ) : null}
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

export type ComposerThinkingControl = {
  /** Whether the active model supports reasoning. */
  supported: boolean;
  /** True when reasoning effort is currently on (not `"off"`). */
  enabled: boolean;
  /** Localized short level label (e.g., "高"), or empty when off. */
  levelLabel: string;
  /** Toggles or cycles reasoning effort cleanly. */
  onToggle: () => void;
};

export type ComposerProps = {
  t: T;
  /** Controlled draft value; omit or pass empty when `draftKey` isolates typing state inside `Composer`. */
  value?: string;
  onChange?: (value: string) => void;
  /** When set, `Composer` subscribes directly to `Drafts` for text keystrokes so `MessageList` never re-renders while typing. */
  draftKey?: string;
  mode: ChatMode;
  onMode: (mode: ChatMode) => void;
  /** False where a note has no resource or work to belong to: the input only asks the Agent there. */
  canNote?: boolean;
  tags: readonly QuoteTag[];
  images: AttachedImage[];
  files?: readonly ComposerFileAttachment[];
  onRemoveTag: (id: string) => void;
  onRemoveImage: (id: string) => void;
  onRemoveFile?: (id: string) => void;
  onPickFile?: () => void;
  onDropFiles?: (files: File[]) => void;
  quick: Array<{ task: QuickTask; label: string }>;
  onQuick: (task: QuickTask) => void;
  noModel: boolean;
  onSettings: () => void;
  /** The model, thinking and window the next question goes with (A-137), beside the note/ask switch. */
  modelPicker?: ReactNode;
  /** Quick DeepSeek reasoning effort pill shown directly in the composer toolbar. */
  thinking?: ComposerThinkingControl | null;
  running: boolean;
  onStop: () => void;
  onSend: () => void;
  sending: boolean;
  /** What the "+" menu can offer here: the attach buttons need an open reader, the others a module. */
  plus: {
    attach: "page" | "frame" | null;
    online: boolean;
    semantic?: boolean;
    webpage?: boolean;
    /** "联网搜索": offered when true, shown as unavailable when false, not shown when not given. */
    webSearch?: boolean;
    subtitle: boolean;
    allowOnline: boolean;
    allowSemantic?: boolean;
    allowWebpage?: boolean;
    allowWebSearch?: boolean;
    subtitleAheadMin: number;
    materials: number;
  };
  onAttach: (what: "page" | "frame") => void;
  onToggleOnline: () => void;
  onToggleSemantic?: () => void;
  onToggleWebpage?: () => void;
  onToggleWebSearch?: () => void;
  onSubtitleAhead: (minutes: number) => void;
  onMaterials: () => void;
  mic: Parameters<typeof MicButton>[0] | null;
  dictation?: { active: boolean; onToggle: (target: HTMLTextAreaElement | null) => void } | null;
  placeholder?: string;
  inputTestId?: string;
};

/** Everything the user can do from the input: note or ask, quick toggles, picked tags, attachments, quick tasks, "+" menu, microphone and send. */
export function Composer(props: ComposerProps) {
  const { t } = props;
  const [storeText, setStoreText] = useDraftText(props.draftKey);
  const value = props.draftKey !== undefined ? storeText : (props.value ?? "");
  const setValue = (next: string) => {
    if (props.draftKey !== undefined) setStoreText(next);
    props.onChange?.(next);
  };

  const [composing, setComposing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const dragDepth = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const check = (width: number) => {
      if (width > 0) setNarrow(width < NARROW_WIDTH_PX);
    };
    check(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) check(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const files = props.files ?? [];
  const can = value.trim().length > 0 || (props.mode === "note" && props.tags.length > 0) || (props.mode === "ask" && files.length > 0);
  const plus: MenuItem[] = [];
  if (props.plus.attach) plus.push({ id: "attach", label: props.plus.attach === "page" ? t("rp.attach.page") : t("rp.attach.frame"), onSelect: () => props.onAttach(props.plus.attach!), disabled: props.images.length >= 4 });
  if (props.onPickFile) plus.push({ id: "file", label: t("chat.attach.file"), onSelect: props.onPickFile, disabled: files.length >= 10 });
  if (props.plus.online) plus.push({ id: "online", label: t("chat.plus.online"), checked: props.plus.allowOnline, onSelect: props.onToggleOnline });
  if (props.plus.semantic && props.onToggleSemantic) plus.push({ id: "semantic", label: t("chat.plus.semantic"), checked: Boolean(props.plus.allowSemantic), onSelect: props.onToggleSemantic });
  if (props.plus.webpage && props.onToggleWebpage) plus.push({ id: "webpage", label: t("chat.plus.webpage"), checked: Boolean(props.plus.allowWebpage), onSelect: props.onToggleWebpage });
  // The model makes the search words from the conversation; nothing of the library is put in them by itself (计划 4.4).
  if (props.plus.webSearch !== undefined && props.onToggleWebSearch) plus.push({ id: "websearch", label: props.plus.webSearch ? t("chat.plus.webSearch") : t("chat.plus.webSearchMissing"), checked: Boolean(props.plus.allowWebSearch), disabled: !props.plus.webSearch, onSelect: props.onToggleWebSearch });
  if (props.plus.subtitle) for (const minutes of SUBTITLE_AHEAD) plus.push({ id: `ahead-${minutes}`, label: minutes === 0 ? t("rp.subtitle.default") : t("rp.subtitle.ahead", { minutes }), checked: props.plus.subtitleAheadMin === minutes, onSelect: () => props.onSubtitleAhead(minutes) });
  plus.push({ id: "materials", label: props.plus.materials ? t("chat.plus.materialsCount", { count: props.plus.materials }) : t("chat.plus.materials"), onSelect: props.onMaterials });

  const canDrop = Boolean(props.onDropFiles);
  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!canDrop) return;
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canDrop) return;
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
  };
  const onDragLeave = () => {
    if (!canDrop) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!canDrop) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length > 0) props.onDropFiles?.(dropped);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!props.onDropFiles) return;
    const pasted = Array.from(event.clipboardData?.files ?? []);
    if (pasted.length > 0) {
      event.preventDefault();
      props.onDropFiles(pasted);
    }
  };

  const showThinkPill = props.mode === "ask" && Boolean(props.thinking?.supported);
  const showSearchPill = props.mode === "ask" && props.plus.webSearch !== undefined && Boolean(props.onToggleWebSearch);
  const searchRaisesThink = Boolean(props.plus.allowWebSearch && props.thinking?.supported && !props.thinking.enabled);

  return (
    <div ref={rootRef} className="chat-composer" data-testid="chat-composer" data-narrow={narrow ? "true" : "false"}>
      {props.noModel ? (
        <p className="chat-nomodel" role="status" data-testid="chat-no-model">
          {t("chat.noModel")}
          <button type="button" className="link-button" data-testid="chat-no-model-settings" onClick={props.onSettings}>{t("chat.noModel.go")}</button>
        </p>
      ) : null}
      <QuickChips t={t} tasks={props.quick} busy={props.running} onRun={props.onQuick} />
      <div
        className={`chat-box ${dragging ? "is-dragging" : ""}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragging ? (
          <div className="chat-drop-mask" data-testid="chat-drop-mask" aria-hidden="true">
            <Paperclip size={18} />
            <span>{t("chat.drop.hint")}</span>
          </div>
        ) : null}
        <QuoteTags
          t={t}
          tags={props.tags}
          images={props.images}
          files={files}
          onRemoveTag={props.onRemoveTag}
          onRemoveImage={props.onRemoveImage}
          onRemoveFile={props.onRemoveFile}
        />
        <div className="chat-input-mirror-wrap">
          <div className="chat-input-mirror" aria-hidden="true">{`${value || " "}\n`}</div>
          <textarea
            ref={area}
            className="chat-input"
            data-testid={props.inputTestId ?? "agent-composer"}
            aria-label={props.mode === "note" ? t("chat.placeholder.note") : t("chat.placeholder.ask")}
            placeholder={props.placeholder ?? (props.mode === "note" ? t("chat.placeholder.note") : t("chat.placeholder.ask"))}
            rows={2}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onPaste={onPaste}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              // Enter confirms a candidate in an input method; it only sends when nothing is being composed.
              if (event.key === "Enter" && !event.shiftKey && !isImeEvent(event, composing)) {
                event.preventDefault();
                if (can && !props.sending && !(props.mode === "ask" && props.running)) props.onSend();
              }
            }}
          />
        </div>
        {(props.plus.allowOnline || props.plus.allowSemantic || props.plus.allowWebpage || props.plus.allowWebSearch) ? (
          <ul className="chat-tags" data-testid="chat-opt-in-tags" aria-label={t("chat.optIn")}>
            {props.plus.allowOnline ? (
              <li className="chat-tag" data-testid="chat-opt-in-online">
                <span className="chat-tag-label">{t("chat.optIn.online")}</span>
                <button type="button" className="icon-button" data-testid="chat-opt-in-remove-online" aria-label={t("chat.optIn.remove", { label: t("chat.optIn.online") })} onClick={props.onToggleOnline}><X size={12} /></button>
              </li>
            ) : null}
            {props.plus.allowSemantic && props.onToggleSemantic ? (
              <li className="chat-tag" data-testid="chat-opt-in-semantic">
                <span className="chat-tag-label">{t("chat.optIn.semantic")}</span>
                <button type="button" className="icon-button" data-testid="chat-opt-in-remove-semantic" aria-label={t("chat.optIn.remove", { label: t("chat.optIn.semantic") })} onClick={props.onToggleSemantic}><X size={12} /></button>
              </li>
            ) : null}
            {props.plus.allowWebSearch && props.onToggleWebSearch ? (
              <li className="chat-tag" data-testid="chat-opt-in-websearch" title={searchRaisesThink ? t("chat.pill.searchRaisesThink") : t("chat.optIn.webSearchHint")}>
                <span className="chat-tag-label">{t("chat.optIn.webSearch")}</span>
                <button type="button" className="icon-button" data-testid="chat-opt-in-remove-websearch" aria-label={t("chat.optIn.remove", { label: t("chat.optIn.webSearch") })} onClick={props.onToggleWebSearch}><X size={12} /></button>
              </li>
            ) : null}
            {props.plus.allowWebpage && props.onToggleWebpage ? (
              <li className="chat-tag" data-testid="chat-opt-in-webpage">
                <span className="chat-tag-label">{t("chat.optIn.webpage")}</span>
                <button type="button" className="icon-button" data-testid="chat-opt-in-remove-webpage" aria-label={t("chat.optIn.remove", { label: t("chat.optIn.webpage") })} onClick={props.onToggleWebpage}><X size={12} /></button>
              </li>
            ) : null}
          </ul>
        ) : null}
        <div className="chat-bar">
          {props.canNote !== false ? (
            <div className="chat-switch" role="group" aria-label={t("chat.mode")}>
              <button type="button" aria-pressed={props.mode === "note"} data-testid="chat-mode-note" onClick={() => props.onMode("note")}>{t("chat.mode.note")}</button>
              <button type="button" aria-pressed={props.mode === "ask"} data-testid="chat-mode-ask" onClick={() => props.onMode("ask")}>{t("chat.mode.ask")}</button>
            </div>
          ) : null}
          {props.mode === "ask" && props.modelPicker ? props.modelPicker : null}
          {showThinkPill && props.thinking ? (
            <button
              type="button"
              className={`chat-pill ${props.thinking.enabled ? "is-active" : ""}`}
              data-testid="chat-pill-think"
              aria-pressed={props.thinking.enabled}
              aria-label={props.thinking.enabled && props.thinking.levelLabel ? t("chat.pill.thinkLevel", { level: props.thinking.levelLabel }) : t("chat.pill.think")}
              title={props.thinking.enabled && props.thinking.levelLabel ? t("chat.pill.thinkLevel", { level: props.thinking.levelLabel }) : t("chat.pill.thinkOff")}
              onClick={props.thinking.onToggle}
            >
              <Brain size={14} aria-hidden="true" />
              {!narrow ? (
                <span className="chat-pill-label">
                  {props.thinking.enabled && props.thinking.levelLabel
                    ? t("chat.pill.thinkLevel", { level: props.thinking.levelLabel })
                    : t("chat.pill.think")}
                </span>
              ) : null}
            </button>
          ) : null}
          {showSearchPill ? (
            <button
              type="button"
              className={`chat-pill ${props.plus.allowWebSearch ? "is-active" : ""}`}
              data-testid="chat-pill-search"
              aria-pressed={Boolean(props.plus.allowWebSearch)}
              disabled={!props.plus.webSearch}
              aria-label={t("chat.pill.search")}
              title={!props.plus.webSearch ? t("chat.plus.webSearchMissing") : searchRaisesThink ? t("chat.pill.searchRaisesThink") : t("chat.optIn.webSearchHint")}
              onClick={props.onToggleWebSearch}
            >
              <Globe size={14} aria-hidden="true" />
              {!narrow ? <span className="chat-pill-label">{t("chat.pill.search")}</span> : null}
            </button>
          ) : null}
          <span className="flex-1" />
          <Menu label={t("chat.plus")} testId="chat-plus" align="end" trigger={<Plus size={16} />} items={plus} />
          {props.mode === "ask" && props.dictation ? (
            <button
              type="button"
              className="icon-button chat-mic"
              data-testid="chat-mic"
              data-mode="dictation"
              aria-pressed={props.dictation.active}
              aria-label={props.dictation.active ? t("dictation.micAskStop") : t("dictation.micAskStart")}
              title={props.dictation.active ? t("dictation.micAskStop") : t("dictation.micAskStart")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.dictation!.onToggle(area.current)}
            >
              {props.dictation.active ? <Square size={15} /> : <Mic size={16} />}
            </button>
          ) : props.mic ? <MicButton {...props.mic} /> : null}
          {props.running && props.mode === "note" ? (
            <>
              <button type="button" className="icon-button chat-stop-inline" data-testid="agent-stop" aria-label={t("agent.stop")} title={t("agent.stop")} onClick={props.onStop}><Square size={13} /></button>
              <button type="button" className="chat-send" data-testid="agent-send" aria-label={t("chat.send.note")} title={t("chat.send.note")} disabled={!can || props.sending} onClick={props.onSend}><ArrowUp size={16} /></button>
            </>
          ) : props.running ? (
            <button type="button" className="chat-send" data-testid="agent-stop" aria-label={t("agent.stop")} title={t("agent.stop")} onClick={props.onStop}><Square size={14} /></button>
          ) : (
            <button type="button" className="chat-send" data-testid="agent-send" aria-label={props.mode === "note" ? t("chat.send.note") : t("agent.send")} title={props.mode === "note" ? t("chat.send.note") : t("agent.send")} disabled={!can || props.sending} onClick={props.onSend}><ArrowUp size={16} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
