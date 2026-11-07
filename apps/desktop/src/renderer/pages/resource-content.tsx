import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FolderPlus, FolderSearch, MessageSquare } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { attempt, messageOf } from "../lib/api.ts";
import { addLibraryFolder, relinkNotice, relinkResource, type LibraryKind } from "../lib/relink.ts";
import { percentOf } from "../lib/works.ts";
import type { CaptureRow } from "../lib/use-work-detail.ts";

type T = Translator["t"];

type Content = {
  resource: { id: string; title: string; kind: string; ordinalLabel: string | null; workId: string | null; workTitle: string | null; available: boolean; outside: boolean; path: string | null; libraryRoot: string | null; folderToAdd: string | null };
  progress: { percent: number; completion: string };
  notes: Array<{ objectId: string; title: string; preview: string; updatedAt: string }>;
  bookmarks: Array<{ id: string; label: string; createdAt: string }>;
  recordings: CaptureRow[];
  conversation: { sessionId: string; runs: number; updatedAt: string } | null;
};

/**
 * What the person made on one resource, in one place, and a way to point the resource at its file again (A-67). A file that is deleted,
 * moved, or sits on a library path that was removed takes none of this away: it is reached from the work's page, and the file is the
 * one thing missing. Opening it is "re-locate", which keeps the resource and everything bound to it.
 */
export function ResourceContent(props: {
  t: T;
  resourceId: string;
  formatDate: (value: string | Date) => string;
  onBack: () => void;
  onOpenNote: (objectId: string) => void;
  onOpenRecording?: (sessionId: string) => void;
  onOpenConversation?: (sessionId: string) => void;
  /** The file can be opened again (it was found, or it came back): the reader takes over. */
  onOpenResource: (resourceId: string) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t, formatDate } = props;
  const [content, setContent] = useState<Content | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** A file was picked outside every library path: nothing changed, and the folder it is in can be added. */
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await attempt<Content>("library.resourceContent", { resourceId: props.resourceId });
    if (result.ok) { setContent(result.value); setFailure(null); } else setFailure(messageOf(result.error));
  }, [props.resourceId]);
  useEffect(() => { setContent(null); void load(); }, [load]);

  async function relocate() {
    const outcome = await relinkResource(props.resourceId);
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "outside") { setPendingFolder(outcome.folder); return; }
    const shown = relinkNotice(t, outcome, () => void load());
    if (shown.error) { props.onError(shown.error); return; }
    setPendingFolder(null);
    props.onNotice(shown.notice ?? "");
    if (outcome.kind === "done") await load();
  }

  /** The folder the file was in becomes a library path; the scan that follows finds the same file and the resource is open again. */
  async function addFolder(picked?: string) {
    const folder = picked ?? content?.resource.folderToAdd;
    if (!folder) return;
    const added = await addLibraryFolder(folder, (content!.resource.kind === "comic" || content!.resource.kind === "video" ? content!.resource.kind : "novel") as LibraryKind);
    if (added.kind === "failed") { props.onError(added.message); return; }
    if (added.kind === "added") { setPendingFolder(null); props.onNotice(t("content.folderAdded")); await load(); }
  }

  const resource = content?.resource;
  const label = resource ? `${resource.ordinalLabel ? `${resource.ordinalLabel} · ` : ""}${resource.title}` : "";
  const empty = content && !content.notes.length && !content.bookmarks.length && !content.recordings.length && !content.conversation;
  return (
    <section className="detail-section resource-content" data-testid="resource-content" data-available={resource ? String(resource.available) : undefined}>
      <button type="button" className="link-button" data-testid="resource-content-back" onClick={props.onBack}><ArrowLeft size={14} />{t("content.back")}</button>
      {failure ? <p role="alert" className="shelf-error" data-testid="resource-content-error">{failure}</p> : null}
      {!content && !failure ? <p role="status">{t("status.loading")}</p> : null}
      {content && resource ? (
        <>
          <h2 data-testid="resource-content-title">{label}{!resource.available ? <span className="chip chip-muted">{t("detail.unavailable")}</span> : null}</h2>
          {resource.available ? (
            <p className="detail-muted" data-testid="resource-content-ready">{t("content.ready")} <button type="button" className="link-button" data-testid="resource-content-open" onClick={() => props.onOpenResource(resource.id)}>{t("content.openFile")}</button></p>
          ) : (
            <>
              <p className="detail-muted" data-testid="resource-content-hint">{resource.outside ? t("content.outsideHint") : t("content.unavailableHint")}</p>
              {resource.path ? <p className="detail-muted resource-path" data-testid="resource-content-path">{t("content.lastPath", { path: resource.path })}</p> : null}
              <div className="detail-actions">
                {resource.outside && resource.folderToAdd ? <button type="button" className="primary-button" data-testid="resource-content-add-folder" onClick={() => void addFolder()}><FolderPlus size={14} />{t("content.addFolder")}</button> : null}
                <button type="button" className={resource.outside && resource.folderToAdd ? "secondary-button" : "primary-button"} data-testid="resource-content-relocate" onClick={() => void relocate()}><FolderSearch size={14} />{t("content.relocate")}</button>
              </div>
              <p className="detail-muted">{t("content.relocateHint")}</p>
              {pendingFolder ? (
                <p className="detail-muted" role="status" data-testid="resource-content-outside-picked">
                  {t("reading.relinkOutside", { folder: pendingFolder })}{" "}
                  <button type="button" className="link-button" data-testid="resource-content-add-picked-folder" onClick={() => void addFolder(pendingFolder)}>{t("reading.relinkAddFolder")}</button>
                </p>
              ) : null}
            </>
          )}
          <p className="detail-muted" data-testid="resource-content-progress">{t("content.progress", { percent: percentOf(content.progress.percent) })}</p>

          <h3>{t("detail.notes")}</h3>
          {content.notes.length === 0 ? <p className="detail-muted">{t("detail.notesNone")}</p> : (
            <ul className="detail-list" data-testid="resource-content-notes">
              {content.notes.map((note) => <li key={note.objectId}><button type="button" className="link-button" data-testid={`resource-note-${note.objectId}`} onClick={() => props.onOpenNote(note.objectId)}>{note.title || note.preview || note.objectId}</button></li>)}
            </ul>
          )}

          <h3>{t("content.bookmarks")}</h3>
          {content.bookmarks.length === 0 ? <p className="detail-muted">{t("content.bookmarksNone")}</p> : (
            <ul className="detail-list" data-testid="resource-content-bookmarks">
              {content.bookmarks.map((mark) => <li key={mark.id} data-testid={`resource-bookmark-${mark.id}`}>{mark.label || t("content.bookmarkUntitled")} <span className="detail-muted">{formatDate(mark.createdAt)}</span></li>)}
            </ul>
          )}

          {props.onOpenRecording ? (
            <>
              <h3>{t("detail.recordings")}</h3>
              {content.recordings.length === 0 ? <p className="detail-muted">{t("detail.recordingsNone")}</p> : (
                <ul className="detail-list" data-testid="resource-content-recordings">
                  {content.recordings.map((capture) => (
                    <li key={capture.id} className="recording-row">
                      <span>{formatDate(capture.createdAt)} · {Math.round(capture.durationMs / 1000)}s</span>
                      <button type="button" className="link-button" data-testid={`resource-recording-${capture.id}`} onClick={() => props.onOpenRecording!(capture.id)}>{t("review.open")}</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}

          <h3>{t("content.conversation")}</h3>
          {content.conversation ? (
            <p data-testid="resource-content-conversation">
              {t("content.conversationLine", { runs: content.conversation.runs, time: formatDate(content.conversation.updatedAt) })}
              {props.onOpenConversation ? <> <button type="button" className="link-button" data-testid="resource-conversation-open" onClick={() => props.onOpenConversation!(content.conversation!.sessionId)}><MessageSquare size={13} />{t("content.conversationOpen")}</button></> : null}
            </p>
          ) : <p className="detail-muted">{t("content.conversationNone")}</p>}
          {empty ? <p className="detail-muted" data-testid="resource-content-empty">{t("content.empty")}</p> : null}
        </>
      ) : null}
    </section>
  );
}
