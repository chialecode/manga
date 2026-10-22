import { describe, expect, it } from "vitest";
import type { WorkspaceTab } from "@manga/contracts";
import { contextSurface, sameSurface, sessionSurface, surfaceOfTab } from "../../apps/desktop/src/renderer/agent-surface.ts";
import { makeTab } from "../../apps/desktop/src/renderer/workspace/model.ts";

const tab = (kind: string, target: Record<string, unknown>, title = "标签", id = "t1"): WorkspaceTab => makeTab({ kind, target, title }, id);
const bookA = { resourceId: "book-a", revisionId: "rev-a", title: "甲" };
const bookB = { resourceId: "book-b", revisionId: "rev-b", title: "乙" };

describe("agent surface binding", () => {
  it("shares the draft across tabs of one target in one context, and not across another target or another context", () => {
    const first = surfaceOfTab(tab("reader", { resourceId: "book-a", mediaKind: "novel" }, "甲", "t1"), null, { reading: bookA })!;
    const second = surfaceOfTab(tab("reader", { resourceId: "book-a", mediaKind: "novel" }, "甲", "t2"), null, { reading: bookA })!;
    expect(first.draftKey).toBe(second.draftKey);
    expect(sameSurface(first, second)).toBe(true);
    const other = surfaceOfTab(tab("reader", { resourceId: "book-b", mediaKind: "novel" }, "乙"), null, { reading: bookA })!;
    expect(other.draftKey).not.toBe(first.draftKey);
    expect(sameSurface(first, other)).toBe(false);
    // The same book in a project is a conversation of the project's, with a draft of its own.
    const inProject = surfaceOfTab(tab("reader", { resourceId: "book-a", mediaKind: "novel" }, "甲"), "prj_1", { reading: bookA })!;
    expect(inProject.contextId).toBe("prj_1");
    expect(inProject.draftKey).not.toBe(first.draftKey);
    expect(sameSurface(first, inProject)).toBe(false);
  });

  it("keeps the book left in memory off a reader of another book: only the reader's own resource is frozen", () => {
    const surface = surfaceOfTab(tab("reader", { resourceId: "book-b", mediaKind: "novel" }, "乙"), null, { reading: bookA })!;
    expect(surface.open).toEqual({ kind: "resource", targetId: "book-b" });
    expect(surface.resourceId).toBe("book-b");
    expect(surface.resourceRevisionId).toBeUndefined();
    expect(surface.resourceTitle).toBe("乙");
    expect(surface.noteObjectId).toBeUndefined();
    const own = surfaceOfTab(tab("reader", { resourceId: "book-a", mediaKind: "novel" }, "甲"), null, { reading: bookA })!;
    expect(own.resourceRevisionId).toBe("rev-a");
    expect(own.resourceTitle).toBe("甲");
  });

  it("includes the note of a note tab and the book the note belongs to, and not a different book that is still open", () => {
    const surface = surfaceOfTab(tab("note", { objectId: "note-a", resourceId: "book-a" }, "笔记甲"), null, { reading: bookB })!;
    expect(surface.open).toEqual({ kind: "note", targetId: "note-a" });
    expect(surface.noteObjectId).toBe("note-a");
    expect(surface.resourceId).toBe("book-a");
    expect(surface.resourceRevisionId).toBeUndefined();
    expect(surface.page).toBe("notes");
    expect(surface.label).toBe("笔记甲");
  });

  it("follows the named conversation on a conversation tab, which has no dock", () => {
    expect(surfaceOfTab(tab("conversation", { sessionId: "ses-b" }, "对话"), null, { reading: bookA })).toBeNull();
    const surface = sessionSurface("ses-b", null, "对话 乙");
    expect(surface.sessionId).toBe("ses-b");
    expect(surface.open).toBeUndefined();
    expect(surface.resourceId).toBeUndefined();
    expect(surface.page).toBe("agent");
    expect(surface.label).toBe("对话 乙");
    expect(surface.draftKey).not.toBe(sessionSurface("ses-a", null).draftKey);
    expect(surfaceOfTab(undefined, null)).toBeNull();
  });

  it("binds the dock to the resource open in a comic or video reader, and to the context's own conversation on a page with no resource", () => {
    for (const mediaKind of ["comic", "video"]) {
      const surface = surfaceOfTab(tab("reader", { resourceId: "book-a", mediaKind }, "甲"), null, { reading: bookA })!;
      expect(surface.open).toEqual({ kind: "resource", targetId: "book-a" });
      expect(surface.page).toBe(mediaKind);
      expect(surface.resourceId).toBe("book-a");
      expect(surface.resourceRevisionId).toBe("rev-a");
      expect(surface.sessionId).toBeUndefined();
    }
    // The shelf pages have no open resource, so nothing is frozen from a book left in memory.
    const library = surfaceOfTab(tab("library", { page: "overview" }, "资源库"), null, { reading: bookA })!;
    expect(library.resourceId).toBeUndefined();
    expect(library.open).toBeUndefined();
    expect(library).toEqual(contextSurface(null));
    expect(surfaceOfTab(tab("settings", {}, "设置"), "prj_1")).toEqual(contextSurface("prj_1"));
  });

  it("opens a work's own conversation from the work's page, and a project's from any tab of the project", () => {
    const work = surfaceOfTab(tab("library", { page: "work", workId: "wv", author: "合成作者" }, "合成动画"), null)!;
    expect(work.open).toEqual({ kind: "work", targetId: "wv" });
    expect(work.page).toBe("work");
    expect(work.author).toBe("合成作者");
    for (const kind of ["project", "whiteboard", "mindmap", "draft", "roughcut"]) {
      const surface = surfaceOfTab(tab(kind, { projectId: "prj_1", objectId: "o1" }, "对象"), null, { projectName: "合集解说" })!;
      // A project's conversation belongs to the project itself, whichever context its tab was opened from.
      expect(surface.contextId, kind).toBe("prj_1");
      expect(surface.open, kind).toEqual({ kind: "project", targetId: "prj_1" });
      expect(surface.label, kind).toBe("合集解说");
    }
  });

  it("keeps the conversations of two contexts apart: no session or draft key is shared between 最近 and a project", () => {
    const recent = contextSurface(null);
    const project = contextSurface("prj_1");
    expect(recent.draftKey).not.toBe(project.draftKey);
    expect(sameSurface(recent, project)).toBe(false);
    expect(sameSurface(recent, contextSurface(null))).toBe(true);
    expect(sameSurface(null, recent)).toBe(false);
    expect(sameSurface(null, null)).toBe(true);
    expect(sessionSurface("ses-a", null).draftKey).not.toBe(sessionSurface("ses-a", "prj_1").draftKey);
  });
});
