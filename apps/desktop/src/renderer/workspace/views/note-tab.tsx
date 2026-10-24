import { useEffect, useRef } from "react";
import { AddToProject } from "../../components/add-to-project.tsx";
import { useNotes } from "../../hooks/use-notes.ts";
import { NotesPage } from "../../pages/notes-page.tsx";
import { str } from "../model.ts";
import { useServices } from "../services.tsx";
import { useTabEnv } from "../tab-env.tsx";

/**
 * A note in its own tab. The tab names itself after the note once it has loaded, and writes the note's source resource into its target so the
 * dock follows the note's conversation with the book it was written beside.
 */
export function NoteTab() {
  const env = useTabEnv();
  const s = useServices();
  const objectId = str(env.model?.target.objectId);
  const notes = useNotes({
    i18n: s.i18n,
    setError: s.setError,
    setNotice: s.setNotice,
    contextId: env.contextId,
    onTitle: (title) => env.controller.retitle(env.tabId, title),
  });
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    const launch = env.takeLaunch();
    const blockId = typeof launch?.blockId === "string" ? launch.blockId : undefined;
    if (openedFor.current === objectId && !blockId) return;
    openedFor.current = objectId;
    void notesRef.current.open(objectId, blockId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId, env.launchN]);

  const doc = notes.doc;
  useEffect(() => {
    if (!doc) return;
    env.controller.retarget(env.tabId, { resourceId: doc.resourceId ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.objectId, doc?.resourceId]);

  return (
    <NotesPage
      i18n={s.i18n}
      onOpenSource={(id, blockId) => void s.open.noteSource(id, blockId)}
      doc={notes.doc}
      renaming={notes.renaming}
      onRenaming={notes.setRenaming}
      onRename={(title, tags) => void notes.rename(title, tags)}
      history={notes.history}
      showHistory={notes.showHistory}
      onHistory={() => void notes.loadHistory()}
      onRestore={(revision) => void notes.restore(revision)}
      epoch={notes.epoch}
      focusBlock={notes.focusBlock}
      onSave={notes.save}
      embeds={s.facets.has("embeds") ? {
        formatDate: s.i18n.formatDate,
        onOpen: (item) => void s.open.embed(item),
        onEnable: () => s.open.settings("modules"),
        onError: s.setError,
      } : undefined}
      screenshots={{ onOpen: (screenshotId) => void s.open.screenshot(screenshotId) }}
      actions={s.facets.has("projects") && notes.doc ? <AddToProject t={s.t} kind="note" targetId={notes.doc.objectId} label={notes.doc.title} onError={s.setError} onNotice={s.setNotice} /> : undefined}
    />
  );
}
