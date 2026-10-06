import { memo, useState } from "react";
import { BookOpen, Film, GalleryVertical, MoreHorizontal, Play } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Menu, type MenuItem } from "../components/menu.tsx";
import { forgetCover } from "../lib/covers.ts";
import { SHELF_ORDER, percentOf, type ShelfState, type WorkSummary } from "../lib/works.ts";

type T = Translator["t"];

export const KIND_ICON = { novel: BookOpen, comic: GalleryVertical, video: Film } as const;

/** A cover picture, or a local placeholder (never a blank box) when there is none or it cannot be loaded. */
export function CoverImage(props: { url: string | undefined; coverId: string | null; kind: WorkSummary["mediaKind"]; title: string; landscape?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const Icon = KIND_ICON[props.kind as keyof typeof KIND_ICON] ?? BookOpen;
  if (props.url && failed !== props.url) {
    return <img className="cover-img" src={props.url} alt="" loading="lazy" draggable={false} onError={() => { setFailed(props.url ?? null); if (props.coverId) forgetCover(props.coverId); }} />;
  }
  return (
    <span className="cover-placeholder" data-kind={props.kind} aria-hidden="true">
      <Icon size={props.landscape ? 30 : 34} />
      <span className="cover-initial">{[...props.title.trim()][0] ?? ""}</span>
    </span>
  );
}

/** "第 12 卷", "更新至第 28 集" and the like: where the reader is, in the words the work uses. */
export function progressLine(t: T, work: WorkSummary): string {
  const label = work.lastResource?.ordinalLabel ?? work.lastResource?.title ?? "";
  if (work.mediaKind === "video") {
    if (work.resourceCount > 1) return t("card.updatedTo", { label: label || String(work.resourceCount) });
    return label || t("card.episodes", { count: work.resourceCount });
  }
  return label;
}

export type CardActions = {
  /** The card opens the work's own page. */
  onOpen: (work: WorkSummary) => void;
  /** "Keep reading/watching": the file itself, from the card's menu. */
  onContinue: (work: WorkSummary) => void;
  onDetail: (workId: string) => void;
  onCover: (workId: string) => void;
  onShelf: (workId: string, state: ShelfState) => void;
};

export function shelfLabel(t: T, state: ShelfState): string {
  return t(`shelf.state.${state}` as "shelf.state.none");
}

function WorkMenu(props: { t: T; work: WorkSummary; actions: CardActions }) {
  const { t, work, actions } = props;
  const items: MenuItem[] = [
    { id: "open", label: work.mediaKind === "video" ? t("card.continueWatch") : t("card.continueRead"), disabled: !work.lastResource, onSelect: () => actions.onContinue(work) },
    { id: "detail", label: t("card.detail"), onSelect: () => actions.onDetail(work.id) },
    { id: "cover", label: t("card.cover"), onSelect: () => actions.onCover(work.id) },
    ...(["none", ...SHELF_ORDER] as ShelfState[]).map((state) => ({ id: `shelf-${state}`, label: `${t("card.setShelf")}：${shelfLabel(t, state)}`, checked: work.shelf === state, onSelect: () => actions.onShelf(work.id, state) })),
  ];
  return <Menu label={t("card.menu", { title: work.title })} items={items} align="end" testId={`work-menu-${work.id}`} trigger={<MoreHorizontal size={16} />} className="card-menu" />;
}

/** One work on the shelf: cover, title, author, where the reader is, and the shelf state or progress. */
export const WorkCard = memo(function WorkCard(props: {
  t: T;
  work: WorkSummary;
  coverUrl: string | undefined;
  actions: CardActions;
  index: number;
  tabbable: boolean;
  layout?: "card" | "row";
}) {
  const { t, work, actions } = props;
  const landscape = work.mediaKind === "video";
  const percent = percentOf(work.progress);
  const line = progressLine(t, work);
  const open = () => actions.onOpen(work);
  const state = work.shelf !== "none" ? shelfLabel(t, work.shelf) : null;
  return (
    <article
      className={props.layout === "row" ? "work-row" : "work-card"}
      data-testid={`work-${work.id}`}
      data-kind={work.mediaKind}
      data-index={props.index}
    >
      <button
        type="button"
        className="work-open"
        tabIndex={props.tabbable ? 0 : -1}
        data-testid={work.lastResource ? `open-${work.lastResource.id}` : `open-work-${work.id}`}
        data-work-open={work.id}
        data-index={props.index}
        aria-label={`${t("card.open")}：${work.title}`}
        onClick={open}
        onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); actions.onDetail(work.id); } }}
      >
        <span className={`work-cover ${landscape ? "is-landscape" : ""}`}>
          <CoverImage url={props.coverUrl} coverId={work.coverId} kind={work.mediaKind} title={work.title} landscape={landscape} />
          {landscape ? <span className="cover-play" aria-hidden="true"><Play size={18} fill="currentColor" /></span> : null}
        </span>
        <span className="work-text">
          <span className="work-title" title={work.title}>{work.title}</span>
          <span className="work-sub">{work.author ?? ""}</span>
          <span className="work-line">{line}</span>
          {percent > 0 ? (
            <span className="work-progress" data-testid={`work-progress-${work.id}`}>
              <span className="work-progress-label">{t("card.read", { percent })}</span>
              <span className="work-progress-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
            </span>
          ) : state ? <span className="work-tag" data-shelf={work.shelf}>{state}</span> : <span className="work-tag-space" />}
        </span>
      </button>
      <WorkMenu t={t} work={work} actions={actions} />
    </article>
  );
});
