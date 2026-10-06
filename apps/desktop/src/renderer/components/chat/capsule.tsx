import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NotebookPen, Send, X } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { MicButton } from "./composer.tsx";

type T = Translator["t"];

/**
 * The floating capsule of the main panel while the right pane is folded away (focus, a narrow window): bottom right, or top right
 * on a page with its own bottom bar (the player, the comic reader). It holds the microphone and a quick note. Writing a note here is
 * the same as writing it in the pane, so the way a reader records does not depend on whether the pane happens to be open; where a
 * note has nothing to belong to there is no note button. While recording, the microphone shows the time.
 */
export function Capsule(props: { t: T; mic: Parameters<typeof MicButton>[0] | null; tagLabel?: string; onNote?: (text: string) => Promise<boolean> }) {
  const { t } = props;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState(0);
  useEffect(() => { if (open) area.current?.focus(); }, [open]);

  // Up at the top right, the capsule sits beside the strips under the reader header (the region tool's hint, warnings, a note's source
  // card), which keep clear of its corner. The note box is wider than that corner, so it opens below the lowest strip instead of over it.
  useLayoutEffect(() => {
    if (!open) { setDrop(0); return; }
    const place = () => {
      const capsule = root.current;
      const bar = capsule?.querySelector<HTMLElement>(".capsule-bar");
      const content = capsule?.parentElement;
      if (!capsule || !bar || !content || getComputedStyle(capsule).flexDirection !== "column-reverse") { setDrop(0); return; }
      const below = bar.getBoundingClientRect().bottom;
      let lowest = below;
      for (const strip of content.querySelectorAll<HTMLElement>(".reader-notice, .reader-source")) {
        const box = strip.getBoundingClientRect();
        if (box.height > 0) lowest = Math.max(lowest, box.bottom);
      }
      setDrop(Math.ceil(lowest - below));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, props.tagLabel]);

  async function send() {
    if (busy || !props.onNote || (!text.trim() && !props.tagLabel)) return;
    setBusy(true);
    const saved = await props.onNote(text);
    setBusy(false);
    if (saved) { setText(""); setOpen(false); }
  }

  return (
    <div ref={root} className="chat-capsule" data-testid="chat-capsule" role="group" aria-label={t("chat.capsule")}>
      {open ? (
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
              if (event.key === "Escape" && !composing) { event.stopPropagation(); setOpen(false); }
              if (event.key === "Enter" && !event.shiftKey && !composing && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
            }}
          />
          <div className="capsule-actions">
            <button type="button" className="icon-button" data-testid="capsule-note-close" aria-label={t("chat.cancel")} title={t("chat.cancel")} onClick={() => setOpen(false)}><X size={14} /></button>
            <button type="button" className="chat-send" data-testid="capsule-note-send" aria-label={t("chat.send.note")} title={t("chat.send.note")} disabled={busy || (!text.trim() && !props.tagLabel)} onClick={() => void send()}><Send size={14} /></button>
          </div>
        </div>
      ) : null}
      <div className="capsule-bar">
        {props.mic ? <MicButton {...props.mic} className="capsule-mic" /> : null}
        {props.onNote ? <button type="button" className="icon-button capsule-note-open" data-testid="capsule-note" aria-expanded={open} aria-label={t("chat.capsule.note")} title={t("chat.capsule.note")} onClick={() => setOpen((value) => !value)}><NotebookPen size={16} /></button> : null}
      </div>
    </div>
  );
}
