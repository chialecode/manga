import type { Translator } from "@manga/i18n";

/** The reader's own strings, resolved once per render so the pane stays a plain component. */
export function readingLabels(i18n: Translator) {
  const t = i18n.t;
  return {
    empty: t("status.empty"),
    search: t("reading.search"),
    progress: t("reading.progress"),
    note: t("reading.note"),
    missing: t("reading.missing"),
    scan: t("reading.scan"),
    more: t("reading.more"),
    image: t("reading.image"),
    imageFailed: t("reading.imageFailed"),
    bookmark: t("reading.bookmark"),
    bookmarkAdd: t("reading.bookmarkAdd"),
    bookmarkNone: t("reading.bookmarkNone"),
    bookmarkRemove: t("reading.bookmarkRemove"),
    part: t("reading.part"),
    hits: t("reading.hits"),
    hitNone: t("reading.hitNone"),
    jump: t("reading.jump"),
    toc: t("reading.toc"),
    source: t("reading.source"),
    sourceOpen: t("reading.sourceOpen"),
    quote: t("reading.quote"),
    images: t("reading.images"),
    selectForAgent: t("reading.selectForAgent"),
    viewPage: t("reading.viewPage"),
    viewText: t("reading.viewText"),
  };
}
