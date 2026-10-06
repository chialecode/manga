import { useRef, useState } from "react";
import type { NoteBlock } from "@manga/contracts/reading";
import type { Translator } from "@manga/i18n";
import { asArray, call, messageOf } from "../lib/api.ts";
import type { NoteDoc, NoteRevision } from "../lib/types.ts";

export type NotesDeps = {
  i18n: Translator;
  setError: (message?: string) => void;
  setNotice: (message?: string) => void;
  /** A note keeps its own session, so the Agent never inherits the reading target. */
  bindSession: (kind: "note", targetId: string) => Promise<unknown>;
};

/** The open note and the operations on it. A late answer for a note that is no longer open is dropped. Finding notes is the records page's job. */
export function useNotes(deps: NotesDeps) {
  const { i18n } = deps;
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const [history, setHistory] = useState<NoteRevision[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [focusBlock, setFocusBlock] = useState<string | null>(null);
  const request = useRef(0);

  async function open(objectId: string, focusBlockId?: string): Promise<void> {
    const mine = ++request.current;
    let value: { revision?: number; title?: string; tags?: string[]; document?: { blocks?: NoteBlock[] }; sourceStatus?: string; sources?: Array<{ resourceId?: string }> };
    try {
      value = await call("notes.get", { objectId });
    } catch (error) {
      if (mine === request.current) deps.setError(messageOf(error));
      return;
    }
    if (mine !== request.current) return;
    setDoc({
      objectId,
      revision: Number(value.revision ?? 1),
      title: String(value.title ?? ""),
      tags: value.tags ?? [],
      blocks: value.document?.blocks ?? [],
      sourceStatus: value.sourceStatus,
      resourceId: value.sources?.[0]?.resourceId ?? null,
    });
    setFocusBlock(focusBlockId ?? null);
    setShowHistory(false);
    setRenaming(false);
    await deps.bindSession("note", objectId);
  }

  async function save(blocks: NoteBlock[], expectedRevision: number, title: string, tags: string[]): Promise<number | void> {
    if (!doc) return;
    // A failed save throws: the editor keeps its draft and says so.
    const value = await call("notes.replace", { objectId: doc.objectId, expectedRevision, blocks, title, tags });
    const revision = Number(value.revision ?? expectedRevision + 1);
    setDoc((current) => current?.objectId === doc.objectId ? { ...current, revision, blocks, title, tags } : current);
    return revision;
  }

  async function rename(title: string, tags: string[]): Promise<void> {
    if (!doc) return;
    const parsedTags = tags.map((item) => item.trim()).filter(Boolean);
    try {
      const value = await call("notes.rename", { objectId: doc.objectId, expectedRevision: doc.revision, title, tags: parsedTags });
      setDoc({ ...doc, revision: Number(value.revision ?? doc.revision + 1), title, tags: parsedTags });
      setRenaming(false);
      deps.setNotice(i18n.t("notes.titleSaved"));
    } catch (error) {
      deps.setError(messageOf(error));
    }
  }

  async function loadHistory(): Promise<void> {
    if (!doc) return;
    try {
      setHistory(asArray<NoteRevision>(await call("notes.history", { objectId: doc.objectId })));
      setShowHistory(true);
    } catch (error) {
      deps.setError(messageOf(error));
    }
  }

  async function restore(revision: number): Promise<void> {
    if (!doc) return;
    try {
      await call("notes.restore", { objectId: doc.objectId, expectedRevision: doc.revision, revision });
    } catch (error) {
      deps.setError(messageOf(error));
      return;
    }
    // The editor is rebuilt from the restored revision, otherwise its stale buffer would overwrite it.
    setEpoch((current) => current + 1);
    await open(doc.objectId);
  }

  return {
    doc, history, showHistory, epoch, renaming, setRenaming, focusBlock, open, close: () => { request.current += 1; setDoc(null); setShowHistory(false); setRenaming(false); }, save, rename, loadHistory, restore,
  };
}

export type Notes = ReturnType<typeof useNotes>;
