/**
 * Which resource, note and selection a send is allowed to freeze.
 * The open page decides the target. A note or book left in memory from another page
 * must not ride along, and a switched session must not be replaced on send.
 */
export type SurfaceSession = {
  sessionId: string;
  kind: string;
  targetId: string | null;
  title: string;
  /** Work mode that owns this session. Absent only for a list that has not been loaded yet. */
  mode?: string | null;
};

export type SurfaceSelection = {
  resourceId: string;
  resourceRevisionId: string;
  partId?: string;
  start: number;
  end: number;
  quote: string;
};

export type SurfaceReading = { resourceId: string; revisionId: string; title: string };
export type SurfaceNote = { objectId: string; revision: number; title: string; resourceId?: string | null };

export type AgentSurfaceInput = {
  page: string;
  sessionId?: string;
  /** The mode the user is looking at, including a switch that has not finished refreshing. */
  mode?: string;
  sessions: SurfaceSession[];
  reading?: SurfaceReading | null;
  note?: SurfaceNote | null;
  selection?: SurfaceSelection | null;
};

export type AgentSurface = {
  /** Set when the user is already on a chosen session and send must not open a different one. */
  sessionId?: string;
  /** Mode this surface's draft, run and session must belong to. */
  mode?: string;
  open?: { kind: "resource" | "note"; targetId: string };
  resourceId?: string;
  resourceRevisionId?: string;
  resourceTitle?: string;
  noteObjectId?: string;
  noteRevision?: number;
  noteTitle?: string;
  selection: SurfaceSelection | null;
  label?: string;
};

function selectionFor(input: AgentSurfaceInput, resourceId: string | undefined): SurfaceSelection | null {
  const selection = input.selection;
  if (!selection || !resourceId || selection.resourceId !== resourceId) return null;
  if (input.reading && input.reading.resourceId !== resourceId) return null;
  return selection;
}

function noteForResource(note: SurfaceNote | null | undefined, resourceId: string | undefined): SurfaceNote | null {
  if (!note || !resourceId || note.resourceId !== resourceId) return null;
  return note;
}

export function resolveAgentSurface(input: AgentSurfaceInput): AgentSurface {
  return { ...resolveAgentSurfaceBody(input), mode: input.mode };
}

function resolveAgentSurfaceBody(input: AgentSurfaceInput): AgentSurface {
  const reading = input.reading ?? null;
  const note = input.note ?? null;

  if (input.page === "notes" && note) {
    const linked = note.resourceId && reading?.resourceId === note.resourceId ? reading : null;
    return {
      open: { kind: "note", targetId: note.objectId },
      noteObjectId: note.objectId,
      noteRevision: note.revision,
      noteTitle: note.title,
      resourceId: note.resourceId ?? undefined,
      resourceRevisionId: linked?.revisionId,
      resourceTitle: linked?.title,
      selection: selectionFor(input, note.resourceId ?? undefined),
      label: note.title,
    };
  }

  if (input.page === "agent" || input.page === "copilot") {
    const session = input.sessions.find((item) => item.sessionId === input.sessionId && (!input.mode || !item.mode || item.mode === input.mode));
    if (session?.kind === "note" && session.targetId) {
      const same = note?.objectId === session.targetId ? note : null;
      const resourceId = same?.resourceId ?? undefined;
      const linked = resourceId && reading?.resourceId === resourceId ? reading : null;
      return {
        sessionId: session.sessionId,
        noteObjectId: session.targetId,
        noteRevision: same?.revision,
        noteTitle: same?.title ?? session.title,
        resourceId,
        resourceRevisionId: linked?.revisionId,
        resourceTitle: linked?.title,
        selection: selectionFor(input, resourceId),
        label: same?.title ?? session.title,
      };
    }
    if (session?.kind === "resource" && session.targetId) {
      const sameBook = reading?.resourceId === session.targetId ? reading : null;
      const owned = noteForResource(note, session.targetId);
      return {
        sessionId: session.sessionId,
        resourceId: session.targetId,
        resourceRevisionId: sameBook?.revisionId,
        resourceTitle: sameBook?.title ?? session.title,
        noteObjectId: owned?.objectId,
        noteRevision: owned?.revision,
        noteTitle: owned?.title,
        selection: sameBook ? selectionFor(input, session.targetId) : null,
        label: sameBook?.title ?? session.title,
      };
    }
    return { sessionId: input.sessionId, selection: null, label: session?.title };
  }

  if (input.page === "reading" && reading) {
    const owned = noteForResource(note, reading.resourceId);
    return {
      open: { kind: "resource", targetId: reading.resourceId },
      resourceId: reading.resourceId,
      resourceRevisionId: reading.revisionId,
      resourceTitle: reading.title,
      noteObjectId: owned?.objectId,
      noteRevision: owned?.revision,
      noteTitle: owned?.title,
      selection: selectionFor(input, reading.resourceId),
      label: reading.title,
    };
  }

  return { sessionId: input.sessionId, selection: null };
}

function sameMode(surface: AgentSurface, session: SurfaceSession): boolean {
  // A session row without a mode cannot be told apart; a known other mode never owns this composer.
  return !surface.mode || !session.mode || session.mode === surface.mode;
}

/**
 * The composer follows the surface's session in the current mode.
 * Once the mode's session list is loaded, an id from another mode is not a fallback.
 */
export function composerKeyFor(surface: AgentSurface, sessions: SurfaceSession[], fallbackSessionId?: string, sessionsLoaded = false): string {
  if (surface.sessionId) {
    const bound = sessions.find((item) => item.sessionId === surface.sessionId);
    if (bound && sameMode(surface, bound)) return bound.sessionId;
  }
  if (surface.open) {
    const match = sessions.find((item) => item.kind === surface.open?.kind && item.targetId === surface.open.targetId && sameMode(surface, item));
    return match?.sessionId ?? "";
  }
  const fallback = sessions.find((item) => item.sessionId === fallbackSessionId);
  if (fallback && sameMode(surface, fallback)) return fallback.sessionId;
  // Before the first list arrives, keep the session the shell already restored.
  if (!sessionsLoaded && sessions.length === 0 && fallbackSessionId) return fallbackSessionId;
  return "";
}

/** Reading, note and Agent views of one mode/target share the same in-memory composer. */
export function draftKeyFor(surface: AgentSurface, sessions: SurfaceSession[], boundSessionKey: string): string {
  const bound = sessions.find((session) => session.sessionId === boundSessionKey && sameMode(surface, session));
  const target = surface.open ?? (bound?.targetId ? { kind: bound.kind, targetId: bound.targetId } : undefined);
  if (target) return `${surface.mode ?? "enthusiast"}:${target.kind}:${target.targetId}`;
  return boundSessionKey ? `${surface.mode ?? "enthusiast"}:session:${boundSessionKey}` : "";
}

/** Checked materials belong to one session in the current mode. They are not copied onto a different target. */
export function manualMaterialsApply(surface: AgentSurface, sessions: SurfaceSession[], key: string): boolean {
  if (!key) return false;
  const bound = sessions.find((item) => item.sessionId === key);
  if (bound && !sameMode(surface, bound)) return false;
  if (surface.sessionId) return surface.sessionId === key;
  if (!surface.open) return true;
  return sessions.some((item) => item.sessionId === key && item.kind === surface.open?.kind && item.targetId === surface.open.targetId && sameMode(surface, item));
}
