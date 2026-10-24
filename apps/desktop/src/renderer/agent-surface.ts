import { contextKey } from "@manga/contracts";
import type { WorkspaceTab } from "@manga/contracts";
import { PROJECT_OBJECT_KINDS, str } from "./workspace/model.ts";

/**
 * Which conversation the dock follows, and what a send from it may freeze (A-94). The tab in front decides: a reader talks in its resource's conversation
 * of the context it is in, a work's page in the work's, a note in the note's, a project's tabs in the project's, and every other page in the context's
 * current conversation. A conversation tab has the dock folded away, because the conversation is already on screen. A note or a book left in memory from
 * another tab must not ride along, so everything here is read from the one tab and the context it is in.
 */

export type AgentSurface = {
  /** The context the conversation belongs to: a project id, null for "最近". */
  contextId: string | null;
  /** The session to open for the tab's own subject; absent for the context's current conversation or an exact session. */
  open?: { kind: "resource" | "note" | "work" | "project"; targetId: string };
  /** A conversation named exactly (a conversation tab). */
  sessionId?: string;
  /** What the pane's quick tasks and empty state are for: reading, comic, video, work, notes, projects, library or agent. */
  page: string;
  resourceId?: string;
  resourceRevisionId?: string;
  resourceTitle?: string;
  workId?: string;
  /** The author of the work the page is about, for the quick tasks' placeholders. */
  author?: string;
  noteObjectId?: string;
  /** The name shown at the top of the pane. */
  label?: string;
  /** Where the composer's text and chosen materials are kept: one per context and subject, so a switch never shows or sends another subject's text. */
  draftKey: string;
};

/** What the reader in a tab has said about its book, for the parts a tab's saved target does not hold. */
export type SurfaceFacts = {
  reading?: { resourceId: string; revisionId: string; title: string; workId?: string | null } | null;
  projectName?: string;
};

const PAGE_FOR_MEDIA: Record<string, string> = { novel: "reading", comic: "comic", video: "video" };

const draftKeyOf = (contextId: string | null, subject: string): string => `${contextKey(contextId)}:${subject}`;

/** The surface of the focused tab; null when the dock has nothing to show (a conversation tab, or no tab). */
export function surfaceOfTab(tab: WorkspaceTab | undefined, contextId: string | null, facts: SurfaceFacts = {}): AgentSurface | null {
  if (!tab) return null;
  if (tab.kind === "conversation") return null;
  const target = tab.target;
  if (tab.kind === "reader") {
    const resourceId = str(target.resourceId);
    if (!resourceId) return contextSurface(contextId);
    const live = facts.reading?.resourceId === resourceId ? facts.reading : null;
    const workId = str(target.workId) || live?.workId || undefined;
    return {
      contextId,
      open: { kind: "resource", targetId: resourceId },
      page: PAGE_FOR_MEDIA[str(target.mediaKind)] ?? "reading",
      resourceId,
      ...(live ? { resourceRevisionId: live.revisionId } : {}),
      resourceTitle: live?.title ?? tab.title,
      ...(workId ? { workId } : {}),
      label: live?.title ?? tab.title,
      draftKey: draftKeyOf(contextId, `resource:${resourceId}`),
    };
  }
  if (tab.kind === "library" && target.page === "work" && str(target.workId)) {
    const workId = str(target.workId);
    const author = str(target.author);
    return { contextId, open: { kind: "work", targetId: workId }, page: "work", workId, ...(author ? { author } : {}), label: tab.title, draftKey: draftKeyOf(contextId, `work:${workId}`) };
  }
  if (tab.kind === "note" && str(target.objectId)) {
    const objectId = str(target.objectId);
    const resourceId = str(target.resourceId);
    return {
      contextId,
      open: { kind: "note", targetId: objectId },
      page: "notes",
      noteObjectId: objectId,
      ...(resourceId ? { resourceId } : {}),
      label: tab.title,
      draftKey: draftKeyOf(contextId, `note:${objectId}`),
    };
  }
  const projectId = tab.kind === "project" || (PROJECT_OBJECT_KINDS as readonly string[]).includes(tab.kind) ? str(target.projectId) || contextId : null;
  if (projectId) {
    // A project's conversation belongs to the project itself, whichever context its tab was opened from.
    return { contextId: projectId, open: { kind: "project", targetId: projectId }, page: "projects", label: facts.projectName ?? (tab.kind === "project" ? tab.title : undefined), draftKey: draftKeyOf(projectId, `project:${projectId}`) };
  }
  return contextSurface(contextId);
}

/** The context's current conversation: where the library, search, records, downloads and settings talk. */
export function contextSurface(contextId: string | null, label?: string): AgentSurface {
  return { contextId, page: "library", ...(label ? { label } : {}), draftKey: draftKeyOf(contextId, "current") };
}

/** A conversation named exactly: what a conversation tab shows. */
export function sessionSurface(sessionId: string, contextId: string | null, label?: string): AgentSurface {
  return { contextId, sessionId, page: "agent", ...(label ? { label } : {}), draftKey: draftKeyOf(contextId, `session:${sessionId}`) };
}

/** Whether the surface is the same conversation as another: a change of surface that is not one keeps the pane's session and run. */
export function sameSurface(a: AgentSurface | null, b: AgentSurface | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.draftKey === b.draftKey && a.contextId === b.contextId;
}
