import { useEffect, useRef, useState } from "react";
import { History, MessageSquarePlus } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";

type T = Translator["t"];
export type HistoryItem = { sessionId: string; title: string; excerpt: string; runCount: number; updatedAt: string };

/**
 * The top of the conversation page (AT-75): which conversation this is, "开启新对话" and "历史". The history lists the other conversations
 * of the mode, newest first, with the start of what was said; opening one shows it and makes it the current one, where it can be
 * continued. Nothing is deleted by starting a new conversation.
 */
export function ConversationBar(props: {
  t: T;
  mode: "enthusiast" | "creator";
  title: string;
  /** Changes whenever the conversations may have changed (a new one, a task that ended), so an open panel reads them again. */
  version: number;
  formatDate: (value: string) => string;
  onNew: () => void | Promise<void>;
  onResume: (sessionId: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = props;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void attempt<{ items: HistoryItem[] }>("conversation.history", { mode: props.mode, limit: 50 }).then((result) => {
      if (!live) return;
      if (result.ok) setItems(asArray<HistoryItem>(result.value.items));
      else props.onError(result.error.message);
    });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, props.mode, props.version]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    const onDown = (event: MouseEvent) => { if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("mousedown", onDown); };
  }, [open]);

  return (
    <div className="conversation-bar" ref={root} data-testid="conversation-bar">
      <strong className="conversation-title truncate" data-testid="conversation-title" title={props.title}>{props.title || t("conversation.current")}</strong>
      <span className="flex-1" />
      <button type="button" className="secondary-button conversation-button" data-testid="conversation-new" title={t("conversation.newHint")} onClick={() => { setOpen(false); void props.onNew(); }}>
        <MessageSquarePlus size={15} aria-hidden="true" /><span>{t("conversation.new")}</span>
      </button>
      <button type="button" className="secondary-button conversation-button" data-testid="conversation-history" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
        <History size={15} aria-hidden="true" /><span>{t("conversation.history")}</span>
      </button>
      {open ? (
        <section className="conversation-panel" role="dialog" aria-label={t("conversation.historyTitle")} data-testid="conversation-panel">
          <header><h3>{t("conversation.historyTitle")}</h3><button type="button" className="link-button" data-testid="conversation-panel-close" onClick={() => setOpen(false)}>{t("conversation.close")}</button></header>
          {items === null ? null : items.length === 0 ? <p className="detail-muted" data-testid="conversation-empty">{t("conversation.historyEmpty")}</p> : (
            <ul>
              {items.map((item) => (
                <li key={item.sessionId}>
                  <button type="button" data-testid={`conversation-item-${item.sessionId}`} title={t("conversation.continue")} onClick={() => { setOpen(false); void props.onResume(item.sessionId); }}>
                    <span className="conversation-item-head"><strong className="truncate">{item.title}</strong><time dateTime={item.updatedAt}>{props.formatDate(item.updatedAt)}</time></span>
                    <span className="conversation-item-excerpt detail-muted">{item.excerpt || t("conversation.untitled")}</span>
                    <span className="conversation-item-meta detail-muted">{t("conversation.messages", { n: item.runCount })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
