import { useRef, useState } from "react";
import type { NoteBlock } from "@manga/contracts/reading";
import type { Translator } from "@manga/i18n";
import { asArray, call, messageOf } from "../lib/api.ts";
import type { NoteDoc, NoteRevision } from "../lib/types.ts";
import { autoAddMaterial } from "../lib/materials.ts";
import { localStorageDrafts } from "../note-schema.ts";

export type NotesDeps = {
  i18n: Translator;
  setError: (message?: string) => void;
  setNotice: (message?: string) => void;
  /** The context the note is opened in: opening it there makes it one of the project's materials. */
  contextId: string | null;
  /** The note knows its title once it has loaded. */
  onTitle?: (title: string) => void;
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

  async function open(objectId: string, focusBlockId?: string, options?: { remount?: boolean }): Promise<void> {
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
    if (options?.remount) setEpoch((current) => current + 1);
    setFocusBlock(focusBlockId ?? null);
    setShowHistory(false);
    setRenaming(false);
    deps.onTitle?.(String(value.title ?? ""));
    void autoAddMaterial(deps.contextId, "note", objectId);
  }

  async function save(blocks: NoteBlock[], expectedRevision: number, title: string, tags: string[]): Promise<number | void> {
    if (!doc) return;
    const targetId = doc.objectId;
    // A failed save throws: the editor keeps its draft and says so.
    const value = await call("notes.replace", { objectId: targetId, expectedRevision, blocks, title, tags });
    const revision = Number(value.revision ?? expectedRevision + 1);
    setDoc((current) => current?.objectId === targetId ? { ...current, revision, blocks, title, tags } : current);
    return revision;
  }

  async function rename(title: string, tags: string[]): Promise<void> {
    if (!doc) return;
    const targetId = doc.objectId;
    const targetRevision = doc.revision;
    const parsedTags = tags.map((item) => item.trim()).filter(Boolean);
    try {
      const value = await call("notes.rename", { objectId: targetId, expectedRevision: targetRevision, title, tags: parsedTags });
      const nextRevision = Number(value.revision ?? targetRevision + 1);
      setDoc((current) => current?.objectId === targetId ? { ...current, revision: nextRevision, title, tags: parsedTags } : current);
      deps.onTitle?.(title);
      setRenaming(false);
      deps.setNotice(i18n.t("notes.titleSaved"));
    } catch (error) {
      deps.setError(messageOf(error));
    }
  }

  async function loadHistory(): Promise<void> {
    if (!doc) return;
    const targetId = doc.objectId;
    const mine = request.current;
    try {
      const revisions = asArray<NoteRevision>(await call("notes.history", { objectId: targetId }));
      if (mine !== request.current) return;
      setHistory(revisions);
      setShowHistory(true);
    } catch (error) {
      if (mine === request.current) deps.setError(messageOf(error));
    }
  }

  async function restore(revision: number): Promise<void> {
    if (!doc) return;
    const targetId = doc.objectId;
    const targetRevision = doc.revision;
    try {
      await call("notes.restore", { objectId: targetId, expectedRevision: targetRevision, revision });
    } catch (error) {
      deps.setError(messageOf(error));
      return;
    }
    // Drop any pre-restore local draft, then fetch the restored document and remount the editor in the same batch.
    localStorageDrafts.clear(targetId);
    await open(targetId, undefined, { remount: true });
  }

  return {
    doc, history, showHistory, epoch, renaming, setRenaming, focusBlock, open, close: () => { request.current += 1; setDoc(null); setShowHistory(false); setRenaming(false); }, save, rename, loadHistory, restore,
  };
}
