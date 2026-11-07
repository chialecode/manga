import { useEffect, useState } from "react";
import { sessionSurface } from "../../agent-surface.ts";
import { asArray, attempt } from "../../lib/api.ts";
import { str } from "../model.ts";
import { useAgent } from "../agent.tsx";
import { tabMarks } from "../marks.ts";
import { useServices } from "../services.tsx";
import { useTabEnv } from "../tab-env.tsx";

/** The name of a conversation, read again when the conversations may have changed (a rename, a new message). */
function useSessionTitle(contextId: string | null, sessionId: string, version: number): string {
  const [title, setTitle] = useState("");
  useEffect(() => {
    let live = true;
    void attempt<unknown>("workspace.sessions", { contextId }).then((result) => {
      if (!live || !result.ok) return;
      const row = asArray<{ sessionId: string; title: string }>(result.value).find((item) => item.sessionId === sessionId);
      if (row) setTitle(row.title);
    });
    return () => { live = false; };
  }, [contextId, sessionId, version]);
  return title;
}

/**
 * A conversation as a tab (AGENT-06): the whole width for reading a long exchange, or one conversation beside a book. The dock folds away while this
 * tab is in front, so the same conversation is not shown twice.
 */
export function ConversationTab() {
  const env = useTabEnv();
  const s = useServices();
  const sessionId = str(env.model?.target.sessionId);
  const title = useSessionTitle(env.contextId, sessionId, s.conversationVersion);
  useEffect(() => { if (title) env.controller.retitle(env.tabId, title); }, [title, env.controller, env.tabId]);
  const agent = useAgent(sessionId ? sessionSurface(sessionId, env.contextId, title || undefined) : null, { wide: true });
  // An Agent task that is running shows on the tab's title (A-95).
  useEffect(() => {
    tabMarks.set(env.tabId, "running", agent.running);
    return () => tabMarks.set(env.tabId, "running", false);
  }, [agent.running, env.tabId]);
  if (!sessionId) return null;
  return <div className="page-host chat-page" data-testid="page-agent" data-session={sessionId}>{agent.pane}</div>;
}
