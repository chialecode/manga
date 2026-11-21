import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NotebookPen, Send, X } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { isImeEvent } from "../../lib/ime.ts";
import { MicButton } from "./composer.tsx";

type T = Translator["t"];

/**
 * The header-docked capsule of the main panel while the right pane is folded away (focus, a narrow window): it sits in the 34 px tab
 * strip chrome at the top right of the main area, outside the content panel so neither the microphone nor the quick-note button ever
 * covers a video frame, comic page, or reading canvas. Writing a note here is the same as writing it in the pane; where a note has
 * nothing to belong to there is no note button. While recording, the microphone shows the time.
 */
export function Capsule(props: { t: T; mic: Parameters<typeof MicButton>[0] | null; tagLabel?: string; onNote?: (text: string) => Promise<boolean> }) {
  const { t } = props;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState(0);
  const hasMic = Boolean(props.mic && props.mic.enabled);
  const hasNote = Boolean(props.onNote);
  useEffect(() => { if (!hasNote) setOpen(false); }, [hasNote]);
  useEffect(() => { if (open && hasNote) area.current?.focus(); }, [open, hasNote]);

  // Reserve exact horizontal room in the top-right tab/column strip so the docked capsule bar never covers a tab title or tab action.
  useLayoutEffect(() => {
    const host = root.current?.parentElement;
    const bar = barRef.current;
    if (!host || !bar) return;
    const update = () => {
      const width = Math.ceil(bar.getBoundingClientRect().width || bar.offsetWidth);
      host.style.setProperty("--capsule-bar-w", `${Math.max(width + 10, 40)}px`);
    };
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      host.style.removeProperty("--capsule-bar-w");
    };
  }, [hasMic, hasNote, props.mic?.state.phase]);

  // When the note box opens downward from the tab strip, clear any top notice/region/source banner inside the visible panel instead of covering it.
  useLayoutEffect(() => {
    if (!open) { setDrop(0); return; }
    const place = () => {
      const capsule = root.current;
      const bar = barRef.current;
      const content = capsule?.parentElement;
      if (!capsule || !bar || !content) { setDrop(0); return; }
      const below = bar.getBoundingClientRect().bottom;
      let lowest = below;
      for (const strip of content.querySelectorAll<HTMLElement>(".elsewhere-bar, .reader-notice, .reader-source")) {
        if (strip.closest('[data-hidden-layer], [data-visible="false"]')) continue;
        const box = strip.getBoundingClientRect();
        if (box.height > 0 && getComputedStyle(strip).visibility !== "hidden") lowest = Math.max(lowest, box.bottom + 4);
      }
      setDrop(Math.max(0, Math.ceil(lowest - below)));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, props.tagLabel]);

  async function send() {
    if (busy || !props.onNote || (!text.trim() && !props.tagLabel)) return;
    setBusy(true);
    try {
      const saved = await props.onNote(text);
      if (saved) { setText(""); setOpen(false); }
    } finally {
      setBusy(false);
    }
  }

  if (!hasMic && !hasNote) return null;

  return (
    <div ref={root} className="chat-capsule" data-testid="chat-capsule" role="group" aria-label={t("chat.capsule")}>
      {open && hasNote ? (
        <div className="capsule-note" data-testid="capsule-note-box" style={drop > 0 ? { marginTop: drop } : undefined}>
          {props.tagLabel ? <span className="chat-tag" data-testid="capsule-tag"><span className="chat-tag-label">{props.tagLabel}</span></span> : null}
          <textarea
            ref={area}
            data-testid="capsule-note-input"
            aria-label={t("chat.placeholder.note")}
            placeholder={t("chat.placeholder.note")}
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              if (isImeEvent(event, composing)) return;
              if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
          />
          <div className="capsule-actions">
            <button type="button" className="icon-button" data-testid="capsule-note-close" aria-label={t("chat.cancel")} title={t("chat.cancel")} onClick={() => setOpen(false)}><X size={14} /></button>
            <button type="button" className="chat-send" data-testid="capsule-note-send" aria-label={t("chat.send.note")} title={t("chat.send.note")} disabled={busy || (!text.trim() && !props.tagLabel)} onClick={() => void send()}><Send size={14} /></button>
          </div>
        </div>
      ) : null}
      <div ref={barRef} className="capsule-bar">
        {props.mic ? <MicButton {...props.mic} className="capsule-mic" /> : null}
        {props.onNote ? <button type="button" className="icon-button capsule-note-open" data-testid="capsule-note" aria-expanded={open} aria-label={t("chat.capsule.note")} title={t("chat.capsule.note")} onClick={() => setOpen((value) => !value)}><NotebookPen size={15} /></button> : null}
      </div>
    </div>
  );
}
