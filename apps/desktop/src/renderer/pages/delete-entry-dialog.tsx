import { useEffect, useState } from "react";
import type { Translator } from "@manga/i18n";
import { Modal } from "../components/modal.tsx";
import { attempt } from "../lib/api.ts";

type T = Translator["t"];

type Counts<K extends string> = Record<K, number>;
type RemoveKey = "works" | "onlineLinks" | "snapshots" | "candidates" | "overrides" | "covers" | "characters" | "persons" | "derivedDanmaku";
type KeepKey = "resources" | "progress" | "bookmarks" | "notes" | "recordings" | "screenshots" | "conversations" | "confirmedDanmaku" | "terms" | "files";
type Preview = { workId: string; workIds: string[]; title: string; mediaKind: string; removes: Counts<RemoveKey>; keeps: Counts<KeepKey> };

const REMOVE_ORDER: RemoveKey[] = ["works", "onlineLinks", "snapshots", "candidates", "overrides", "covers", "characters", "persons", "derivedDanmaku"];
const KEEP_ORDER: KeepKey[] = ["resources", "progress", "bookmarks", "notes", "recordings", "screenshots", "conversations", "confirmedDanmaku", "terms", "files"];

/**
 * Deleting an entry (LIB-02, A-87): what goes and what stays are listed apart, each with its number, before anything is done. The files
 * are never touched; what was made from them stays, and the resources are listed as not yet in a work.
 */
export function DeleteEntryDialog(props: {
  t: T;
  workId: string;
  /** The title the card shows, until the preview says it. */
  title: string;
  onClose: () => void;
  onDeleted: (result: { title: string; resourceCount: number }) => void;
  onError: (message: string) => void;
}) {
  const { t } = props;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void attempt<Preview>("works.deletePreview", { workId: props.workId }).then((result) => {
      if (cancelled) return;
      if (result.ok) setPreview(result.value); else setFailure(result.error.message);
    });
    return () => { cancelled = true; };
  }, [props.workId]);

  async function remove() {
    setBusy(true);
    const result = await attempt<{ workIds: string[]; resourceIds: string[]; title: string }>("works.delete", { workId: props.workId });
    setBusy(false);
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onDeleted({ title: result.value.title || props.title, resourceCount: result.value.resourceIds?.length ?? 0 });
  }

  const removes = preview ? REMOVE_ORDER.filter((key) => preview.removes[key] > 0) : [];
  const keeps = preview ? KEEP_ORDER.filter((key) => preview.keeps[key] > 0) : [];
  return (
    <Modal
      variant="dialog"
      testId="delete-entry"
      title={t("entry.delete.title", { title: preview?.title ?? props.title })}
      description={t("entry.delete.intro")}
      closeLabel={t("common.close")}
      onClose={props.onClose}
      footer={(
        <>
          <button type="button" className="secondary-button" data-testid="delete-entry-cancel" onClick={props.onClose}>{t("common.cancel")}</button>
          <button type="button" className="danger-button" data-testid="delete-entry-confirm" disabled={!preview || busy} onClick={() => void remove()}>{busy ? t("entry.delete.working") : t("entry.delete.confirm")}</button>
        </>
      )}
    >
      {!preview && !failure ? <p role="status" className="detail-muted" data-testid="delete-entry-loading">{t("entry.delete.loading")}</p> : null}
      {failure ? <p role="alert" className="shelf-error" data-testid="delete-entry-error">{failure}</p> : null}
      {preview ? (
        <div className="delete-entry" data-testid="delete-entry-body">
          <section data-testid="delete-entry-removes">
            <h3>{t("entry.delete.removes")}</h3>
            <ul>
              {removes.map((key) => <li key={key} data-testid={`delete-removes-${key}`}>{t(`entry.delete.removes.${key}` as "entry.delete.removes.works", { count: preview.removes[key] })}</li>)}
              <li data-testid="delete-removes-shelf">{t("entry.delete.removes.shelf")}</li>
            </ul>
          </section>
          <section data-testid="delete-entry-keeps">
            <h3>{t("entry.delete.keeps")}</h3>
            {keeps.length ? (
              <ul>{keeps.map((key) => <li key={key} data-testid={`delete-keeps-${key}`}>{t(`entry.delete.keeps.${key}` as "entry.delete.keeps.resources", { count: preview.keeps[key] })}</li>)}</ul>
            ) : <p className="detail-muted">{t("entry.delete.none")}</p>}
          </section>
          <p data-testid="delete-entry-warning"><strong>{t("entry.delete.irreversible")}</strong></p>
          {preview.keeps.resources > 0 ? <p className="detail-muted">{t("entry.delete.after")}</p> : null}
        </div>
      ) : null}
    </Modal>
  );
}
