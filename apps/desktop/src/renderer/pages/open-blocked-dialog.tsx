import { useState } from "react";
import type { Translator } from "@manga/i18n";
import { Modal } from "../components/modal.tsx";
import { addLibraryFolder, relinkResource, type LibraryKind } from "../lib/relink.ts";
import { ResourceContent } from "./resource-content.tsx";

type T = Translator["t"];

/** What `library.openable` answered when the answer was no (A-86). */
export type OpenBlock = {
  resourceId: string;
  mediaKind: string;
  title: string;
  workId: string | null;
  state: "outside" | "missing";
  /** Outside: the folder to add as a library path, when it is known. */
  folder?: string | null;
  /** Missing: the library path the file was in, and where inside it. */
  libraryPath?: string;
  relativePath?: string;
  rootReachable?: boolean;
};

const kindOf = (value: string): LibraryKind => (value === "comic" || value === "video" ? value : "novel");

/**
 * The question asked before a resource is opened and cannot be (A-86). The reader is not opened and the page does not change. A file outside every
 * library path can have its folder added as one; a file that is not where its library path says can be located again; either way the notes and
 * records made on it can be looked at, because they were never in the file.
 */
export function OpenBlockedDialog(props: {
  t: T;
  block: OpenBlock;
  formatDate: (value: string | Date) => string;
  onClose: () => void;
  /** The file is reachable again: the caller opens it. */
  onReady: (block: OpenBlock) => void;
  onOpenNote: (objectId: string) => void;
  onOpenRecording?: (sessionId: string) => void;
  onOpenConversation?: (sessionId: string) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t, block } = props;
  const [viewing, setViewing] = useState(false);
  const [busy, setBusy] = useState(false);
  /** A file was chosen outside every library path: nothing changed, and its folder can be added. */
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  const label = block.title;

  async function addFolder(folder: string) {
    setBusy(true);
    const added = await addLibraryFolder(folder, kindOf(block.mediaKind));
    setBusy(false);
    if (added.kind === "failed") { props.onError(added.message); return; }
    if (added.kind === "added") { props.onNotice(t("open.folderAdded")); props.onClose(); }
  }

  async function relocate() {
    setBusy(true);
    const outcome = await relinkResource(block.resourceId);
    setBusy(false);
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "outside") { setPendingFolder(outcome.folder); return; }
    if (outcome.kind === "different") { props.onError(t("reading.relinkDifferent")); return; }
    if (outcome.kind === "failed") { props.onError(outcome.message); return; }
    props.onNotice(outcome.pointersKept > 0 ? t("reading.sourceRepairKept", { count: outcome.pointersKept }) : t("reading.sourceRepairDone"));
    props.onReady(block);
  }

  if (viewing) {
    return (
      <Modal variant="drawer" testId="open-blocked-content" title={label} closeLabel={t("common.close")} onClose={() => setViewing(false)}>
        <ResourceContent
          t={t}
          resourceId={block.resourceId}
          formatDate={props.formatDate}
          onBack={() => setViewing(false)}
          onOpenNote={(objectId) => { props.onClose(); props.onOpenNote(objectId); }}
          onOpenRecording={props.onOpenRecording ? (sessionId) => { props.onClose(); props.onOpenRecording!(sessionId); } : undefined}
          onOpenConversation={props.onOpenConversation ? (sessionId) => { props.onClose(); props.onOpenConversation!(sessionId); } : undefined}
          onOpenResource={() => { props.onClose(); props.onReady(block); }}
          onError={props.onError}
          onNotice={props.onNotice}
        />
      </Modal>
    );
  }

  const outside = block.state === "outside";
  return (
    <Modal
      variant="dialog"
      testId="open-blocked"
      title={t(outside ? "open.outside.title" : "open.missing.title", { title: label })}
      closeLabel={t("common.close")}
      onClose={props.onClose}
      footer={(
        <>
          {outside && block.folder ? <button type="button" className="primary-button" data-testid="open-blocked-add" disabled={busy} onClick={() => void addFolder(block.folder!)}>{t("open.addFolder")}</button> : null}
          {!outside || !block.folder ? <button type="button" className={outside ? "secondary-button" : "primary-button"} data-testid="open-blocked-relocate" disabled={busy} onClick={() => void relocate()}>{t("open.relocate")}</button> : null}
          <button type="button" className="secondary-button" data-testid="open-blocked-content-view" onClick={() => setViewing(true)}>{t("open.viewContent")}</button>
          <button type="button" className="secondary-button" data-testid="open-blocked-close" onClick={props.onClose}>{t("common.close")}</button>
        </>
      )}
    >
      <div className="open-blocked" data-state={block.state}>
        {outside ? (
          <>
            <p data-testid="open-blocked-reason">{t("open.outside.body")}</p>
            {block.folder ? <p className="detail-muted" data-testid="open-blocked-folder">{t("open.outside.folder", { folder: block.folder })}</p> : <p className="detail-muted">{t("open.outside.unknown")}</p>}
          </>
        ) : (
          <>
            <p data-testid="open-blocked-reason">{block.rootReachable === false ? t("open.missing.rootGone") : t("open.missing.body")}</p>
            <p className="detail-muted" data-testid="open-blocked-place">{t("open.missing.place", { library: block.libraryPath ?? "", file: block.relativePath ?? "" })}</p>
          </>
        )}
        <p className="detail-muted">{t("open.keeps")}</p>
        {pendingFolder ? (
          <p data-testid="open-blocked-pending" role="status">
            {t("reading.relinkOutside", { folder: pendingFolder })}{" "}
            <button type="button" className="link-button" data-testid="open-blocked-add-picked" disabled={busy} onClick={() => void addFolder(pendingFolder)}>{t("reading.relinkAddFolder")}</button>
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
