import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Translator } from "@manga/i18n";
import { attempt } from "../../../lib/api.ts";
import { EXCERPT_TEXT_LIMIT, hostOf, segmentsOf, selectedRange, selectionTouches, type ExcerptItem, type PageDoc, type Range } from "./research-model.ts";

type T = Translator["t"];

/**
 * One version of a page: its text, drawn so that a selection can be turned back into offsets into that text, the excerpts of this project drawn
 * over it, and the form that keeps the selection as an excerpt. The page is only text here; nothing of the original page runs.
 */
export function PageReader(props: {
  t: T; formatDate: (iso: string) => string; projectId: string; doc: PageDoc;
  /** The excerpt to bring into view (one opened from the list). */
  focusExcerptId: string | null;
  onOpenVersion: (pageId: string) => void;
  onRefetch: () => void;
  refetching: boolean;
  onSaved: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t, doc } = props;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<Range | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const mine = useMemo(() => doc.excerpts.filter((item) => item.projectId === props.projectId), [doc.excerpts, props.projectId]);
  const segments = useMemo(() => segmentsOf(doc.text, mine.map((item) => ({ id: item.id, start: item.start, end: item.end, title: item.title }))), [doc.text, mine]);
  const newest = doc.versions[0];
  const outdated = newest && newest.id !== doc.page.id ? newest : null;

  // The selection is followed while it is inside the text, and kept while the person moves into the form to name it. The listener is in place
  // as soon as the text is on screen (a layout effect), so a selection made at once is not missed.
  useLayoutEffect(() => {
    const onSelection = () => {
      const root = bodyRef.current;
      if (!root) return;
      const selection = window.getSelection();
      if (!selectionTouches(root, selection)) return;
      setRange(selectedRange(root, selection));
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);

  useEffect(() => {
    if (!props.focusExcerptId) return;
    const mark = bodyRef.current?.querySelector<HTMLElement>(`[data-excerpt~="${props.focusExcerptId}"]`);
    mark?.scrollIntoView?.({ block: "center" });
  }, [props.focusExcerptId, doc.page.id, doc.text]);

  const chars = range ? range.end - range.start : 0;
  const tooLong = chars > EXCERPT_TEXT_LIMIT;

  async function save() {
    if (!range || tooLong || saving) return;
    setSaving(true);
    const result = await attempt<{ excerpt: ExcerptItem }>("excerpt.create", {
      pageId: doc.page.id, start: range.start, end: range.end, projectId: props.projectId,
      ...(title.trim() ? { title: title.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}),
    });
    setSaving(false);
    if (!result.ok) { props.onError(result.error.message); return; }
    window.getSelection()?.removeAllRanges();
    setRange(null); setTitle(""); setNote("");
    props.onNotice(t("research.reader.saved"));
    props.onSaved();
  }

  return (
    <section className="research-reader" data-testid="research-reader" data-page={doc.page.id} aria-label={doc.page.title}>
      <header className="research-reader-head">
        <h3 data-testid="research-page-title">{doc.page.title || hostOf(doc.page.url)}</h3>
        <p className="detail-muted">{hostOf(doc.page.url)} · {t("research.reader.meta", { version: doc.page.version, date: props.formatDate(doc.page.fetchedAt) })}</p>
        <div className="research-reader-actions">
          <button type="button" data-testid="research-refetch" disabled={props.refetching} onClick={props.onRefetch}>{t("research.reader.refetch")}</button>
          {doc.versions.length > 1 ? (
            <label className="research-versions">
              <span>{t("research.reader.versions")}</span>
              <select data-testid="research-versions" value={doc.page.id} onChange={(event) => props.onOpenVersion(event.target.value)}>
                {doc.versions.map((item) => <option key={item.id} value={item.id}>{t("research.reader.version", { version: item.version, date: props.formatDate(item.fetchedAt) })}</option>)}
              </select>
            </label>
          ) : null}
        </div>
      </header>
      {outdated ? (
        <p className="research-outdated" role="status" data-testid="research-outdated">
          {t("research.reader.newer", { version: outdated.version })}{" "}
          <button type="button" className="link-button" data-testid="research-to-newer" onClick={() => props.onOpenVersion(outdated.id)}>{t("research.reader.toNewer")}</button>
        </p>
      ) : null}
      <div className="research-body" ref={bodyRef} data-testid="research-body" role="document" aria-label={t("research.reader.body")} tabIndex={0}>
        {segments.map((segment) => segment.marks.length ? (
          <mark key={segment.start} data-start={segment.start} data-excerpt={segment.marks.map((mark) => mark.id).join(" ")} title={t("research.reader.mark", { title: segment.marks[0]!.title })}
            className={props.focusExcerptId && segment.marks.some((mark) => mark.id === props.focusExcerptId) ? "is-focused" : undefined}>{segment.text}</mark>
        ) : <span key={segment.start} data-start={segment.start}>{segment.text}</span>)}
      </div>
      <form className="research-keep" data-testid="research-keep" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {range ? (
          <>
            <p role="status" data-testid="research-selected">{t("research.reader.selected", { chars })}</p>
            {tooLong ? <p className="draft-warn-text" data-testid="research-too-long">{t("research.reader.tooLong", { limit: EXCERPT_TEXT_LIMIT })}</p> : null}
            <label><span>{t("research.reader.titleLabel")}</span><input type="text" data-testid="research-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
            <label><span>{t("research.reader.noteLabel")}</span><input type="text" data-testid="research-note" value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} /></label>
            <button type="submit" className="primary-button" data-testid="research-save" disabled={tooLong || saving}>{t("research.reader.save")}</button>
          </>
        ) : <p className="detail-muted" data-testid="research-select-hint">{t("research.reader.select")}</p>}
      </form>
    </section>
  );
}
