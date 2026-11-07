import { useState } from "react";
import type { Translator } from "@manga/i18n";
import { attempt } from "../../../lib/api.ts";
import { Modal } from "../../../components/modal.tsx";
import { hostOf, type ExcerptItem } from "./research-model.ts";

type T = Translator["t"];

/** The excerpts of the project: the words taken, where they came from and which version, with editing, deleting and following a page that changed. */
export function ExcerptList(props: {
  t: T; formatDate: (iso: string) => string; items: ExcerptItem[] | null; focusId: string | null;
  onShow: (excerpt: ExcerptItem) => void;
  onChanged: (select?: string) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState<ExcerptItem | null>(null);

  function edit(item: ExcerptItem) { setEditing(item.id); setTitle(item.title); setNote(item.note); }

  async function saveEdit(item: ExcerptItem) {
    const result = await attempt("excerpt.update", { excerptId: item.id, title, note });
    if (!result.ok) { props.onError(result.error.code === "NOT_FOUND" ? t("research.excerpt.gone") : result.error.message); return; }
    setEditing(null);
    props.onChanged();
  }

  async function remove(item: ExcerptItem) {
    setConfirming(null);
    const result = await attempt("excerpt.delete", { excerptId: item.id });
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onChanged();
  }

  async function follow(item: ExcerptItem) {
    const result = await attempt<{ status: "current" | "found" | "missing"; excerpt?: ExcerptItem }>("excerpt.follow", { excerptId: item.id });
    if (!result.ok) { props.onError(result.error.message); return; }
    const { status, excerpt } = result.value;
    props.onNotice(status === "found" ? t("research.excerpt.followed") : status === "missing" ? t("research.excerpt.missing") : t("research.excerpt.current"));
    props.onChanged(status === "found" ? excerpt?.id : undefined);
  }

  return (
    <section className="research-panel research-excerpts" data-testid="research-excerpts" aria-labelledby="research-excerpts-title">
      <h3 id="research-excerpts-title">{t("research.excerpts.title")}</h3>
      {props.items && !props.items.length ? <p className="detail-muted" data-testid="research-excerpts-empty">{t("research.excerpts.empty")}</p> : null}
      <ul data-testid="research-excerpt-list">
        {(props.items ?? []).map((item) => (
          <li key={item.id} className={item.id === props.focusId ? "is-current" : ""} data-testid={`research-excerpt-${item.id}`} data-id={item.id}>
            {editing === item.id ? (
              <form className="research-edit" onSubmit={(event) => { event.preventDefault(); void saveEdit(item); }}>
                <label><span>{t("research.reader.titleLabel")}</span><input type="text" data-testid="research-edit-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
                <label><span>{t("research.reader.noteLabel")}</span><input type="text" data-testid="research-edit-note" value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} /></label>
                <div className="research-result-actions">
                  <button type="submit" className="primary-button" data-testid="research-edit-save">{t("research.excerpt.editSave")}</button>
                  <button type="button" onClick={() => setEditing(null)}>{t("research.excerpt.editCancel")}</button>
                </div>
              </form>
            ) : (
              <>
                <strong data-testid="research-excerpt-title">{item.title}</strong>
                <blockquote className="research-quote" data-testid="research-excerpt-text">{item.text}</blockquote>
                {item.note ? <p className="research-note" data-testid="research-excerpt-note">{item.note}</p> : null}
                <p className="detail-muted" data-testid="research-excerpt-source">{t("research.excerpt.source", { host: hostOf(item.url), version: item.version, date: props.formatDate(item.fetchedAt) })}</p>
                {item.newerVersion ? <p className="research-outdated" data-testid="research-excerpt-newer">{t("research.excerpt.newer")}（{t("research.reader.version", { version: item.newerVersion.version, date: props.formatDate(item.newerVersion.fetchedAt) })}）</p> : null}
                <div className="research-result-actions">
                  <button type="button" className="link-button" data-testid="research-excerpt-show" onClick={() => props.onShow(item)}>{t("research.excerpt.show")}</button>
                  {item.newerVersion ? <button type="button" className="link-button" data-testid="research-excerpt-follow" onClick={() => void follow(item)}>{t("research.excerpt.follow")}</button> : null}
                  <button type="button" className="link-button" data-testid="research-excerpt-edit" onClick={() => edit(item)}>{t("research.excerpt.edit")}</button>
                  <button type="button" className="link-button" data-testid="research-excerpt-delete" onClick={() => setConfirming(item)}>{t("research.excerpt.delete")}</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {confirming ? (
        <Modal title={t("research.excerpt.delete")} closeLabel={t("whiteboard.cancel")} onClose={() => setConfirming(null)} testId="research-excerpt-delete-dialog"
          footer={<><button type="button" onClick={() => setConfirming(null)}>{t("whiteboard.cancel")}</button><button type="button" className="danger-button" data-testid="research-excerpt-delete-confirm" onClick={() => void remove(confirming)}>{t("whiteboard.deleteDo")}</button></>}>
          <p>{t("research.excerpt.deleteConfirm", { name: confirming.title })}</p>
        </Modal>
      ) : null}
    </section>
  );
}
