import type { ReactNode } from "react";
import type { Translator } from "@manga/i18n";
import { Composer, type ComposerProps } from "./composer.tsx";
import { MessageList, type BubbleActions } from "./messages.tsx";
import type { StreamState } from "../../hooks/use-session-stream.ts";

type T = Translator["t"];

/**
 * The conversation of one session: messages above, input below. The right pane and the chat page are the same thing at two widths;
 * the page limits the line length so a long answer stays readable.
 */
export function ChatPane(props: { t: T; stream: StreamState; actions: BubbleActions; composer: ComposerProps; empty: ReactNode; formatDate: (value: string) => string; wide?: boolean; header?: ReactNode }) {
  return (
    <div className={`chat-pane ${props.wide ? "chat-pane-page" : ""}`} data-testid={props.wide ? "chat-page-pane" : "chat-pane"}>
      {props.header}
      {props.stream.status === "error" ? <p className="chat-error" role="alert" data-testid="chat-stream-error">{props.stream.error}</p> : null}
      <MessageList t={props.t} items={props.stream.items} hasMore={props.stream.hasMore} onOlder={() => { void props.stream.loadOlder(); }} actions={props.actions} empty={props.empty} formatDate={props.formatDate} limited={props.wide} />
      <Composer {...props.composer} />
    </div>
  );
}
