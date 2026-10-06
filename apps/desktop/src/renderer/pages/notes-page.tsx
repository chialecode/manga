import type { NoteBlock } from "@manga/contracts/reading";
import type { Translator } from "@manga/i18n";
import { ArrowLeft } from "lucide-react";
import { Input } from "../components/ui/input.tsx";
import { NoteEditor } from "../note-editor.tsx";
import type { NoteDoc, NoteRevision } from "../lib/types.ts";

type I18n = Translator;

export type NotesPageProps = {
  i18n: I18n;
  /** Back to where the note was opened from: the records page in settings, or a reader. */
  onBack: () => void;
  onOpenSource: (objectId: string, blockId?: string) => void;
  doc: NoteDoc | null;
  renaming: boolean;
  onRenaming: (value: boolean) => void;
  onRename: (title: string, tags: string[]) => void;
  history: NoteRevision[];
  showHistory: boolean;
  onHistory: () => void;
  onRestore: (revision: number) => void;
  epoch: number;
  focusBlock: string | null;
  onSave: (blocks: NoteBlock[], expectedRevision: number, title: string, tags: string[]) => Promise<number | void>;
};

/**
 * One note with its editor, rename form, revision history and stale-source banner. Notes are listed and found in settings, under
 * "records"; this page is where a note opens for editing.
 */
export function NotesPage(props: NotesPageProps) {
  const { i18n, doc } = props;
  const stale = Boolean(doc?.sourceStatus && doc.sourceStatus !== "linked" && doc.sourceStatus !== "none");
  return (
    <section data-testid="notes-page" className="page-pad">
      <div className="note-page-head">
        <button type="button" className="link-button" data-testid="note-back" onClick={props.onBack}><ArrowLeft size={15} aria-hidden="true" />{i18n.t("notes.back")}</button>
      </div>
      {doc ? (
        <section data-testid="note-panel">
          <div className="flex gap-2 items-center mb-2 text-sm flex-wrap">
            <h2 className="font-medium" data-testid="note-title">{doc.title}</h2>
            <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-rename" onClick={() => props.onRenaming(!props.renaming)}>{i18n.t("notes.rename")}</button>
            <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-history" onClick={props.onHistory}>{i18n.t("notes.history")}</button>
            {doc.tags.length ? <span data-testid="note-tags">{doc.tags.join(",")}</span> : null}
          </div>
          {props.renaming ? (
            <form
              className="flex gap-2 items-end mb-2 text-sm flex-wrap"
              data-testid="note-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                props.onRename(String(data.get("title") ?? ""), String(data.get("tags") ?? "").split(","));
              }}
            >
              <label>{i18n.t("notes.title")}<Input name="title" className="ml-1 w-44" data-testid="note-title-input" defaultValue={doc.title} /></label>
              <label>{i18n.t("notes.tags")}<Input name="tags" className="ml-1 w-44" data-testid="note-tags-input" defaultValue={doc.tags.join(",")} placeholder={i18n.t("notes.tagsHint")} /></label>
              <button type="submit" className="border px-2 py-1 rounded" data-testid="note-rename-save">{i18n.t("notes.saveTitle")}</button>
              <button type="button" className="border px-2 py-1 rounded" data-testid="note-rename-cancel" onClick={() => props.onRenaming(false)}>{i18n.t("notes.cancelEdit")}</button>
            </form>
          ) : null}
          {stale ? (
            <p role="status" className="text-sm mb-2" data-testid="note-stale-banner">
              {i18n.t("notes.sourceStale")}
              <button type="button" className="border px-2 py-0.5 rounded ml-2" data-testid="note-stale-repair" onClick={() => props.onOpenSource(doc.objectId)}>{i18n.t("reading.sourceOpen")}</button>
            </p>
          ) : null}
          {props.showHistory ? (
            <ul className="text-sm mb-2" data-testid="note-history-list">
              {props.history.map((entry) => (
                <li key={entry.revision} className="flex gap-2 items-center">
                  <span>r{entry.revision} · {entry.blockCount} · {entry.preview.slice(0, 40)}</span>
                  <button type="button" className="border px-2 py-0.5 rounded" data-testid={`note-restore-${entry.revision}`} onClick={() => props.onRestore(entry.revision)}>{i18n.t("notes.restore")}</button>
                </li>
              ))}
            </ul>
          ) : null}
          <NoteEditor
            key={`${doc.objectId}:${props.epoch}`}
            objectId={doc.objectId}
            document={{ schemaVersion: 2, blocks: doc.blocks }}
            revision={doc.revision}
            title={doc.title}
            tags={doc.tags}
            focusBlockId={props.focusBlock ?? undefined}
            sourceStale={stale}
            onOpenSource={(blockId) => props.onOpenSource(doc.objectId, blockId)}
            saveLabel={i18n.t("notes.save")}
            savingLabel={i18n.t("notes.saving")}
            savedLabel={i18n.t("notes.saved")}
            failedLabel={i18n.t("notes.failed")}
            splitLabel={i18n.t("notes.split")}
            sourceLabel={i18n.t("notes.source")}
            labels={{
              blockInsert: i18n.t("notes.blockInsert"),
              blockRemove: i18n.t("notes.blockRemove"),
              blockMoveUp: i18n.t("notes.blockMoveUp"),
              blockMoveDown: i18n.t("notes.blockMoveDown"),
              blockCopy: i18n.t("notes.blockCopy"),
              blockMerge: i18n.t("notes.merge"),
              blockType: i18n.t("notes.blockType"),
              typeParagraph: i18n.t("notes.typeParagraph"),
              typeHeading: i18n.t("notes.typeHeading"),
              typeList: i18n.t("notes.typeList"),
              typeQuote: i18n.t("notes.typeQuote"),
              typeCode: i18n.t("notes.typeCode"),
              typePlain: i18n.t("notes.typePlain"),
              draftRestored: i18n.t("notes.draftRestored"),
              draftDiscard: i18n.t("notes.draftDiscard"),
              conflict: i18n.t("notes.conflict"),
              sourceStale: i18n.t("notes.sourceStale"),
              repairSource: i18n.t("notes.repairSource"),
              undo: i18n.t("notes.undo"),
              redo: i18n.t("notes.redo"),
              undoHint: i18n.t("notes.undoHint"),
              sourceEdit: i18n.t("notes.sourceEdit"),
              openSource: i18n.t("reading.sourceOpen"),
            }}
            onSourceStale={() => props.onOpenSource(doc.objectId)}
            onSave={(blocks, expectedRevision) => props.onSave(blocks, expectedRevision, doc.title, doc.tags)}
          />
        </section>
      ) : <p>{i18n.t("status.empty")}</p>}
    </section>
  );
}
