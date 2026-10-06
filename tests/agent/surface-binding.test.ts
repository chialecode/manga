import { describe, expect, it } from "vitest";
import { composerKeyFor, draftKeyFor, manualMaterialsApply, resolveAgentSurface, type SurfaceSession } from "../../apps/desktop/src/renderer/agent-surface.ts";

const sessions: SurfaceSession[] = [
  { sessionId: "ses-a", kind: "resource", targetId: "book-a", title: "甲" },
  { sessionId: "ses-b", kind: "resource", targetId: "book-b", title: "乙" },
  { sessionId: "ses-note-b", kind: "note", targetId: "note-b", title: "笔记乙" },
];
const bookA = { resourceId: "book-a", revisionId: "rev-a", title: "甲" };
const bookB = { resourceId: "book-b", revisionId: "rev-b", title: "乙" };
const noteA = { objectId: "note-a", revision: 2, title: "笔记甲", resourceId: "book-a" };
const noteB = { objectId: "note-b", revision: 1, title: "笔记乙", resourceId: "book-b" };
const selectionA = { resourceId: "book-a", resourceRevisionId: "rev-a", partId: "body", start: 1, end: 3, quote: "甲乙" };

describe("agent surface binding", () => {
  it("shares drafts across views of one target without inheriting an unrelated running session", () => {
    const reading = resolveAgentSurface({ page: "reading", mode: "enthusiast", sessionId: "ses-a", sessions, reading: bookA });
    const agent = resolveAgentSurface({ page: "agent", mode: "enthusiast", sessionId: "ses-a", sessions, reading: bookA });
    expect(draftKeyFor(reading, sessions, "ses-a")).toBe(draftKeyFor(agent, sessions, "ses-a"));
    const other = resolveAgentSurface({ page: "reading", mode: "enthusiast", sessionId: "ses-a", sessions, reading: { ...bookB, resourceId: "new-book" } });
    expect(composerKeyFor(other, sessions, "ses-a", true)).toBe("");
    expect(draftKeyFor(other, sessions, "")).not.toBe(draftKeyFor(agent, sessions, "ses-a"));
  });
  it("keeps a leftover note off the book the user is reading", () => {
    const surface = resolveAgentSurface({ page: "reading", sessionId: "ses-note-b", sessions, reading: bookA, note: noteB, selection: selectionA });
    expect(surface.open).toEqual({ kind: "resource", targetId: "book-a" });
    expect(surface.resourceId).toBe("book-a");
    expect(surface.noteObjectId).toBeUndefined();
    expect(surface.selection?.quote).toBe("甲乙");
    expect(composerKeyFor(surface, sessions, "ses-note-b")).toBe("ses-a");
    expect(manualMaterialsApply(surface, sessions, "ses-note-b")).toBe(false);
    expect(manualMaterialsApply(surface, sessions, "ses-a")).toBe(true);
  });

  it("includes the note that belongs to the open book", () => {
    const surface = resolveAgentSurface({ page: "reading", sessionId: "ses-a", sessions, reading: bookA, note: noteA, selection: selectionA });
    expect(surface.noteObjectId).toBe("note-a");
    expect(surface.noteRevision).toBe(2);
    expect(surface.resourceRevisionId).toBe("rev-a");
  });

  it("follows the selected session on the Agent page", () => {
    const surface = resolveAgentSurface({ page: "agent", sessionId: "ses-b", sessions, reading: bookA, note: noteA, selection: selectionA });
    expect(surface.sessionId).toBe("ses-b");
    expect(surface.resourceId).toBe("book-b");
    expect(surface.noteObjectId).toBeUndefined();
    expect(surface.selection).toBeNull();
    expect(surface.open).toBeUndefined();
  });

  it("binds the Agent to the resource open in a comic or video reader", () => {
    for (const page of ["comic", "video"]) {
      const surface = resolveAgentSurface({ page, sessionId: "ses-b", sessions, reading: bookA, note: null, selection: null });
      expect(surface.open).toEqual({ kind: "resource", targetId: "book-a" });
      expect(surface.resourceId).toBe("book-a");
      expect(surface.resourceRevisionId).toBe("rev-a");
      expect(surface.sessionId).toBeUndefined();
    }
    // The shelf pages have no open resource, so nothing is frozen from a book left in memory.
    expect(resolveAgentSurface({ page: "library", sessionId: "ses-a", sessions, reading: bookA, note: null, selection: null }).resourceId).toBeUndefined();
  });

  it("uses the note session's own source and not the other open book", () => {
    const surface = resolveAgentSurface({ page: "agent", sessionId: "ses-note-b", sessions, reading: bookA, note: noteB, selection: selectionA });
    expect(surface.noteObjectId).toBe("note-b");
    expect(surface.resourceId).toBe("book-b");
    expect(surface.selection).toBeNull();
    expect(composerKeyFor(surface, sessions, "ses-a")).toBe("ses-note-b");
  });

  it("does not reuse another mode's session or draft key", () => {
    const mixed: SurfaceSession[] = [
      { sessionId: "ses-ent", kind: "resource", targetId: "book-a", title: "甲", mode: "enthusiast" },
      { sessionId: "ses-cre", kind: "resource", targetId: "book-a", title: "甲", mode: "creator" },
    ];
    const enthusiast = resolveAgentSurface({ page: "reading", mode: "enthusiast", sessionId: "ses-ent", sessions: mixed, reading: bookA, selection: selectionA });
    const creator = resolveAgentSurface({ page: "reading", mode: "creator", sessionId: "ses-ent", sessions: mixed, reading: bookA, selection: selectionA });
    expect(composerKeyFor(enthusiast, mixed, "ses-ent", true)).toBe("ses-ent");
    expect(composerKeyFor(creator, mixed, "ses-ent", true)).toBe("ses-cre");
    expect(manualMaterialsApply(creator, mixed, "ses-ent")).toBe(false);
    expect(manualMaterialsApply(creator, mixed, "ses-cre")).toBe(true);
    const creatorOnly = mixed.filter((item) => item.mode === "creator");
    expect(composerKeyFor(creator, creatorOnly, "ses-ent", true)).toBe("ses-cre");
    expect(composerKeyFor(resolveAgentSurface({ page: "reading", mode: "creator", sessions: [], reading: bookA }), [], "ses-ent", true)).toBe("");
  });

  it("on the notes page does not attach a different book that is still open", () => {
    const surface = resolveAgentSurface({ page: "notes", sessionId: "ses-b", sessions, reading: bookB, note: noteA, selection: selectionA });
    expect(surface.open).toEqual({ kind: "note", targetId: "note-a" });
    expect(surface.resourceId).toBe("book-a");
    expect(surface.resourceRevisionId).toBeUndefined();
    expect(surface.selection).toBeNull();
  });
});
