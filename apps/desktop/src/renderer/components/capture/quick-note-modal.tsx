import { useEffect, useRef, useState } from "react";
import { PanelRightOpen, Send, TextQuote, X } from "lucide-react";
import type { Translator } from "@manga/i18n";
import type { NoteAnchor } from "../../lib/chat-model.ts";
import { FullscreenPortal } from "../../lib/fullscreen-portal.tsx";
import { isImeEvent } from "../../lib/ime.ts";
import type { QuoteTag } from "../../lib/quote-tags.ts";

type T = Translator["t"];

export type FrozenQuickNoteItem = {
  id: string;
  kind: "selection" | "region" | "interval" | "position";
  label: string;
  title?: string;
  tag?: QuoteTag;
  anchor?: NoteAnchor;
};

export type QuickNoteModalProps = {
  t: T;
  open: boolean;
  /** Increments on every open so frozen items and draft hydrate cleanly for each session. */
  openNonce: number;
  targetKey: string;
  initialItems: readonly FrozenQuickNoteItem[];
  initialDraft: string;
  onDraftChange: (targetKey: string, text: string) => void;
  onSave: (text: string, items: readonly FrozenQuickNoteItem[]) => Promise<boolean>;
  onExpandToDock?: (text: string, items: readonly FrozenQuickNoteItem[]) => void;
  onClose: () => void;
  /** Portal into `document.fullscreenElement` when active (defaults to true). */
  portalToFullscreen?: boolean;
};

/**
 * Centered Spotlight-style Quick-Note Modal:
 * - No dark full-screen backdrop so video/subtitles remain legible while typing.
 * - Freezes the anchor/quote tags at the exact instant of opening.
 * - Preserves unsent drafts per target across Esc/close.
 * - Captures Esc at top priority so closing never exits window fullscreen (W) or screen fullscreen (F).
 */
export function QuickNoteModal(props: QuickNoteModalProps) {
  const { t, open, openNonce, targetKey } = props;
  const [text, setText] = useState(props.initialDraft);
  const [items, setItems] = useState<FrozenQuickNoteItem[]>(() => [...props.initialItems]);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  composingRef.current = composing;

  const callbacksRef = useRef({ onClose: props.onClose, onDraftChange: props.onDraftChange });
  callbacksRef.current = { onClose: props.onClose, onDraftChange: props.onDraftChange };

  // Re-hydrate frozen anchor items and target draft each time the modal opens or target switches while open.
  const initRef = useRef({ initialDraft: props.initialDraft, initialItems: props.initialItems });
  initRef.current = { initialDraft: props.initialDraft, initialItems: props.initialItems };
  useEffect(() => {
    if (!open) return;
    setText(initRef.current.initialDraft);
    setItems([...initRef.current.initialItems]);
    setBusy(false);
  }, [open, openNonce, targetKey]);

  // Auto-focus textarea on open and place caret at the end of any restored draft.
  useEffect(() => {
    if (!open) return;
    const node = areaRef.current;
    if (!node) return;
    node.focus();
    const len = node.value.length;
    try { node.setSelectionRange(len, len); } catch { /* ignore in environments without selection range */ }
  }, [open, openNonce, targetKey]);

  // Capture-phase Escape so closing this modal never leaks to window fullscreen (W), screen fullscreen (F), or reader Esc handlers.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      if (isImeEvent(event, composingRef.current)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      callbacksRef.current.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const hasQuoteTag = items.some((item) => item.tag !== undefined);
  const canSend = !busy && (text.trim().length > 0 || hasQuoteTag);

  const updateText = (next: string) => {
    setText(next);
    props.onDraftChange(targetKey, next);
  };

  const removeItem = (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
    areaRef.current?.focus();
  };

  async function save() {
    if (!canSend) return;
    setBusy(true);
    try {
      const saved = await props.onSave(text, items);
      if (saved) {
        setText("");
        props.onDraftChange(targetKey, "");
        props.onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  function expand() {
    if (!props.onExpandToDock) return;
    const currentText = text;
    const currentItems = items;
    setText("");
    props.onDraftChange(targetKey, "");
    props.onExpandToDock(currentText, currentItems);
  }

  const dialog = (
    <div
      className="quick-note-modal"
      data-testid="quick-note-modal"
      role="dialog"
      aria-modal="false"
      aria-label={t("quickNote.title")}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="quick-note-head">
        <span className="quick-note-title">{t("quickNote.title")}</span>
        <button
          type="button"
          className="icon-button quick-note-close"
          data-testid="quick-note-close"
          aria-label={t("chat.cancel")}
          title={t("chat.cancel")}
          onClick={props.onClose}
        >
          <X size={15} />
        </button>
      </div>

      {items.length > 0 ? (
        <ul className="chat-tags quick-note-tags" data-testid="quick-note-tags" aria-label={t("quickNote.anchor")}>
          {items.map((item) => (
            <li key={item.id} className="chat-tag" data-testid={`quick-note-tag-${item.kind}`}>
              <TextQuote size={12} aria-hidden="true" />
              <span className="chat-tag-label" title={item.title ?? item.label}>{item.label}</span>
              <button
                type="button"
                className="icon-button"
                data-testid={`quick-note-tag-remove-${item.kind}`}
                aria-label={t("chat.tag.remove")}
                title={t("chat.tag.remove")}
                onClick={() => removeItem(item.id)}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <textarea
        ref={areaRef}
        className="quick-note-input"
        data-testid="quick-note-input"
        aria-label={t("chat.placeholder.note")}
        placeholder={t("chat.placeholder.note")}
        rows={3}
        value={text}
        onChange={(event) => updateText(event.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(event) => {
          if (isImeEvent(event, composing)) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void save();
          }
        }}
      />

      <div className="quick-note-foot">
        {props.onExpandToDock ? (
          <button
            type="button"
            className="link-button quick-note-expand"
            data-testid="quick-note-expand"
            onClick={expand}
          >
            <PanelRightOpen size={14} aria-hidden="true" />
            <span>{t("quickNote.expand")}</span>
          </button>
        ) : <span className="quick-note-hint">{t("quickNote.hint")}</span>}
        <span className="flex-1" />
        <button
          type="button"
          className="chat-send"
          data-testid="quick-note-send"
          aria-label={t("chat.send.note")}
          title={t("chat.send.note")}
          disabled={!canSend}
          onClick={() => void save()}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );

  if (props.portalToFullscreen === false) return dialog;
  return <FullscreenPortal>{dialog}</FullscreenPortal>;
}
