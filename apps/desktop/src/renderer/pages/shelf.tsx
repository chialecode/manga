import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Filter, LayoutGrid, List, Search } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Menu, type MenuItem } from "../components/menu.tsx";
import { Popup } from "../components/popup.tsx";
import { VirtualGrid, type GridLayout } from "../components/virtual-grid.tsx";
import { useDebouncedSearch } from "../hooks/use-async-guard.ts";
import { portraitCoverRatio, useCovers } from "../lib/covers.ts";
import { shelfMemory } from "../lib/shelf-memory.ts";
import { usePagedWorks, WorksCacheContext, type WorksQuery } from "../lib/use-works.ts";
import { MEDIA_KINDS, SHELF_ORDER, type Facets, type ShelfState, type WorkMediaKind, type WorkSummary } from "../lib/works.ts";
import { DeleteEntryDialog } from "./delete-entry-dialog.tsx";
import { UnassignedGroup } from "./unassigned-group.tsx";
import { KIND_ICON, WorkCard, type CardActions } from "./work-card.tsx";

type T = Translator["t"];
type Sort = "recent" | "added" | "title" | "progress";
type Tab = "all" | ShelfState;
type Tri = "any" | "yes" | "no";

function formatsFor(t: T, kind: WorkMediaKind): Array<{ id: string; label: string }> {
  if (kind === "novel") return [{ id: "txt", label: "TXT" }, { id: "epub", label: "EPUB" }, { id: "mobi", label: "MOBI" }, { id: "pdf", label: "PDF" }];
  if (kind === "comic") return [{ id: "dir", label: t("shelf.format.dir") }, { id: "cbz", label: "CBZ" }, { id: "pdf", label: "PDF" }, { id: "epub", label: "EPUB" }, { id: "mobi", label: "MOBI" }];
  return [];
}

const PORTRAIT: Extract<GridLayout, { kind: "grid" }> = { kind: "grid", minCard: 148, gap: 18, coverRatio: 4 / 3, textHeight: 112 };
const LIST: GridLayout = { kind: "list", rowHeight: 76 };

const hasAvailableResource = (work: WorkSummary) => (work.resourceCount - (work.outsideCount ?? 0)) > (work.missingCount ?? 0);

function readView(): "grid" | "list" {
  try { return localStorage.getItem("manga.shelf.view") === "list" ? "list" : "grid"; } catch { return "grid"; }
}

export type ShelfProps = {
  t: T;
  /** One media kind for its own page; `null` for the overview with a row per kind. */
  kind: WorkMediaKind | null;
  refreshKey: number;
  facets: Facets;
  /** The card itself opens the work's page; `onContinue` is the explicit "keep reading/watching" in its menu. */
  onOpen: (work: WorkSummary) => void;
  onContinue: (work: WorkSummary) => void;
  onDetail: (workId: string, tab?: "cover") => void;
  /** Library paths are where works come from; an empty shelf points there instead of offering an import button. */
  onAddPath: () => void;
  onViewAll: (kind: WorkMediaKind) => void;
  onSetShelf: (workId: string, state: ShelfState) => void;
  /** A resource that is in no work, opened from the group at the end of the shelf. */
  onOpenResource?: (resourceId: string, kind: WorkMediaKind) => void;
  /** A work was made for a loose resource; its page opens on the match. */
  onMatchWork?: (workId: string, kind: WorkMediaKind) => void;
  /** The library changed (an entry was deleted, a resource was put in a work). */
  onChanged?: () => void;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
  /** The context the shelf is in (a project id, null for "最近"); cards note a position that comes from another one. */
  context?: string | null;
};

/** What the views need to list the resources that are in no work, or null when a filter is on that they do not answer. */
type Loose = { query: string } | null;

const KIND_FACET: Record<WorkMediaKind, string | null> = { novel: null, comic: "comic", video: "video" };
const kindName = (t: T, kind: WorkMediaKind) => t(`shelf.kind.${kind}` as "shelf.kind.novel");
/** What a page is about, in its words: the medium, or "works" for the overview that holds all three. */
const aboutName = (t: T, kind: WorkMediaKind | null) => t(`shelf.kind.${kind ?? "all"}` as "shelf.kind.all");

/** The library page: one row per media kind on the overview, a full grid or list on a kind's own page. */
export function Shelf(props: ShelfProps) {
  const { t, kind } = props;
  const memoryKey = kind ?? "all";
  const remembered = shelfMemory.get(memoryKey);
  const [tab, setTab] = useState<Tab>(remembered.tab as Tab);
  const [sort, setSort] = useState<Sort>(remembered.sort);
  const [view, setViewState] = useState<"grid" | "list">(readView);
  const search = useDebouncedSearch(remembered.text, 250);
  const [linked, setLinked] = useState<Tri>(remembered.linked);
  const [notes, setNotes] = useState<Tri>(remembered.notes);
  const [format, setFormat] = useState(remembered.format);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterAnchor = useRef<HTMLButtonElement>(null);
  const filterBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!filterOpen || !filterBox.current) return;
    filterBox.current.style.position = "fixed";
    filterBox.current.style.inset = "auto";
  }, [filterOpen]);
  const [deleting, setDeleting] = useState<WorkSummary | null>(null);
  const worksCache = useContext(WorksCacheContext);
  const seenRefreshKey = useRef(props.refreshKey);
  if (seenRefreshKey.current !== props.refreshKey) {
    seenRefreshKey.current = props.refreshKey;
    worksCache?.clear();
  }

  // If the shelf switches kind without remounting, restore the target shelf's memory instead of leaking old filters onto it.
  const activeKeyRef = useRef(memoryKey);
  useEffect(() => {
    if (activeKeyRef.current === memoryKey) return;
    const saved = shelfMemory.get(memoryKey);
    setTab(saved.tab as Tab);
    setSort(saved.sort);
    search.reset(saved.text);
    setLinked(saved.linked);
    setNotes(saved.notes);
    setFormat(saved.format);
    setFilterOpen(false);
    activeKeyRef.current = memoryKey;
  }, [memoryKey, search.reset]);

  const setView = (next: "grid" | "list") => {
    setViewState(next);
    try { localStorage.setItem("manga.shelf.view", next); } catch { /* the choice just is not remembered */ }
  };

  // Coming back from a work's page shows the shelf as it was left.
  useEffect(() => {
    if (activeKeyRef.current !== memoryKey) return;
    shelfMemory.patch(memoryKey, { tab, sort, text: search.text, linked, notes, format });
  }, [memoryKey, tab, sort, search.text, linked, notes, format]);

  const applied = search.query;
  const availableFormats = kind ? formatsFor(t, kind) : [];
  const effectiveFormat = availableFormats.some((item) => item.id === format) ? format : "";
  const base: WorksQuery = useMemo(() => ({
    ...(tab !== "all" ? { shelf: tab } : {}),
    ...(applied ? { query: applied } : {}),
    ...(linked !== "any" ? { linked: linked === "yes" } : {}),
    ...(notes !== "any" ? { hasNotes: notes === "yes" } : {}),
    ...(effectiveFormat ? { format: effectiveFormat } : {}),
    sort,
  }), [tab, applied, linked, notes, effectiveFormat, sort]);

  const actions: CardActions = useMemo(() => ({
    onOpen: props.onOpen,
    onContinue: props.onContinue,
    onDetail: (workId) => props.onDetail(workId),
    onCover: (workId) => props.onDetail(workId, "cover"),
    onShelf: props.onSetShelf,
    onDelete: setDeleting,
  }), [props.onOpen, props.onContinue, props.onDetail, props.onSetShelf]);

  const title = t(`shelf.title.${kind ?? "all"}` as "shelf.title.all");
  const filtersActive = linked !== "any" || notes !== "any" || Boolean(effectiveFormat);
  const sortItems: MenuItem[] = (["recent", "added", "title", "progress"] as Sort[]).map((id) => ({ id, label: t(`shelf.sort.${id}` as "shelf.sort.recent"), checked: sort === id, onSelect: () => setSort(id) }));
  const loose: Loose = tab === "all" && !filtersActive ? { query: applied } : null;
  const moduleOff = kind && KIND_FACET[kind] && !props.facets.has(KIND_FACET[kind]!) ? kind : null;

  return (
    <section className="shelf" data-testid={kind ? `shelf-${kind}` : "shelf-all"} data-kind={kind ?? "all"} aria-label={title}>
      <header className="shelf-head">
        <h1 data-testid="shelf-title">{title}</h1>
        <div className="shelf-tools">
          <label className="search-box">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              placeholder={t(`shelf.search.${kind ?? "all"}` as "shelf.search.all")}
              aria-label={t(`shelf.search.${kind ?? "all"}` as "shelf.search.all")}
              data-testid="shelf-search"
              {...search.inputProps}
            />
          </label>
        </div>
      </header>
      <div className="shelf-bar">
        <div role="tablist" aria-label={t(`shelf.tabs.${kind ?? "all"}` as "shelf.tabs.all")} className="shelf-tabs">
          {(["all", ...SHELF_ORDER] as Tab[]).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} data-testid={`shelf-tab-${id}`} onClick={() => setTab(id)}>{kind === "video" && (id === "reading" || id === "wishlist" || id === "finished") ? t(`shelf.tab.${id}.video` as "shelf.tab.reading.video") : t(`shelf.tab.${id}` as "shelf.tab.all")}</button>
          ))}
        </div>
        <div className="shelf-options">
          <div role="group" aria-label={t("shelf.view")} className="view-toggle">
            <button type="button" aria-pressed={view === "grid"} aria-label={t("shelf.view.grid")} title={t("shelf.view.grid")} data-testid="shelf-view-grid" onClick={() => setView("grid")}><LayoutGrid size={16} /></button>
            <button type="button" aria-pressed={view === "list"} aria-label={t("shelf.view.list")} title={t("shelf.view.list")} data-testid="shelf-view-list" onClick={() => setView("list")}><List size={16} /></button>
          </div>
          <Menu label={`${t("shelf.sort")}：${t(`shelf.sort.${sort}` as "shelf.sort.recent")}`} items={sortItems} align="end" testId="shelf-sort" trigger={<span className="menu-text">{t(`shelf.sort.${sort}` as "shelf.sort.recent")}</span>} />
          <span className="filter-root">
            <button ref={filterAnchor} type="button" className="menu-button" aria-expanded={filterOpen} aria-controls="shelf-filter-panel" data-active={filtersActive} data-testid="shelf-filter" onClick={() => setFilterOpen((open) => !open)}><Filter size={14} aria-hidden="true" /><span className="menu-text">{t("shelf.filter")}</span></button>
            {filterOpen ? (
              <Popup
                anchor={filterAnchor}
                boxRef={filterBox}
                onClose={() => setFilterOpen(false)}
                placement="below"
                align="end"
                id="shelf-filter-panel"
                role="group"
                label={t("shelf.filter")}
                className="filter-panel"
                onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setFilterOpen(false); filterAnchor.current?.focus(); } }}
              >
                <label>{t("shelf.filter.linked")}
                  <select value={linked} data-testid="shelf-filter-linked" onChange={(event) => setLinked(event.target.value as Tri)}>
                    <option value="any">{t("shelf.filter.any")}</option><option value="yes">{t("shelf.filter.linkedYes")}</option><option value="no">{t("shelf.filter.linkedNo")}</option>
                  </select>
                </label>
                <label>{t("shelf.filter.notes")}
                  <select value={notes} data-testid="shelf-filter-notes" onChange={(event) => setNotes(event.target.value as Tri)}>
                    <option value="any">{t("shelf.filter.any")}</option><option value="yes">{t("shelf.filter.notesYes")}</option><option value="no">{t("shelf.filter.notesNo")}</option>
                  </select>
                </label>
                {availableFormats.length ? (
                  <label>{t("shelf.filter.format")}
                    <select value={effectiveFormat} data-testid="shelf-filter-format" onChange={(event) => setFormat(event.target.value)}>
                      <option value="">{t("shelf.filter.any")}</option>
                      {availableFormats.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                ) : null}
                <button type="button" className="secondary-button" onClick={() => { setLinked("any"); setNotes("any"); setFormat(""); }}>{t("shelf.filter.reset")}</button>
              </Popup>
            ) : null}
          </span>
        </div>
      </div>
      {moduleOff ? <p role="status" className="shelf-note" data-testid="shelf-module-off">{t("shelf.moduleOff", { name: kindName(t, moduleOff) })}</p> : null}
      {kind ? (
        <KindView {...props} kind={kind} query={{ ...base, kind }} view={view} actions={actions} loose={loose} filtered={Boolean(applied) || tab !== "all" || filtersActive} />
      ) : (
        <OverviewView {...props} query={base} view={view} actions={actions} loose={loose} filtered={Boolean(applied) || tab !== "all" || filtersActive} />
      )}
      {deleting ? (
        <DeleteEntryDialog
          t={t}
          workId={deleting.id}
          title={deleting.title}
          onClose={() => setDeleting(null)}
          onError={(message) => props.onError?.(message)}
          onDeleted={(result) => { setDeleting(null); props.onNotice?.(t("entry.delete.done", { title: result.title, count: result.resourceCount })); props.onChanged?.(); }}
        />
      ) : null}
    </section>
  );
}

function StatusLine(props: { t: T; kind: WorkMediaKind | null; status: "loading" | "ready" | "error"; error?: string; onRetry: () => void }) {
  const name = aboutName(props.t, props.kind);
  if (props.status === "loading") return <p role="status" className="shelf-note" data-testid="shelf-loading">{props.t("shelf.loading", { name })}</p>;
  if (props.status === "error") {
    return (
      <p role="alert" className="shelf-note shelf-error" data-testid="shelf-error">
        {props.t("shelf.error", { name })}{props.error ? `：${props.error}` : ""}
        <button type="button" className="secondary-button" onClick={props.onRetry}>{props.t("shelf.retry")}</button>
      </p>
    );
  }
  return null;
}

function EmptyShelf(props: { t: T; filtered: boolean; kind: WorkMediaKind | null; onAddPath: () => void }) {
  return (
    <div className="shelf-empty" data-testid={props.filtered ? "shelf-empty-filtered" : "shelf-empty"}>
      <p className="empty-title">{props.filtered ? props.t("shelf.emptyFiltered") : props.kind ? props.t("shelf.emptyKind", { name: kindName(props.t, props.kind) }) : props.t("shelf.empty")}</p>
      {props.filtered ? null : <><p className="empty-hint">{props.t("shelf.emptyHint", { name: props.t(`shelf.kind.${props.kind ?? "every"}` as "shelf.kind.every") })}</p><button type="button" className="link-button" data-testid="shelf-add-path" onClick={props.onAddPath}>{props.t("shelf.addPath")}</button></>}
    </div>
  );
}

function LooseResources(props: ShelfProps & { kind: WorkMediaKind | null; loose: Loose }) {
  if (!props.loose) return null;
  return (
    <UnassignedGroup
      t={props.t}
      kind={props.kind}
      query={props.loose.query}
      refreshKey={props.refreshKey}
      onOpenResource={(resourceId, kind) => props.onOpenResource?.(resourceId, kind)}
      onMatch={(workId, kind) => props.onMatchWork?.(workId, kind)}
      onChanged={() => props.onChanged?.()}
      onError={(message) => props.onError?.(message)}
      onNotice={(message) => props.onNotice?.(message)}
    />
  );
}

function KindView(props: ShelfProps & { kind: WorkMediaKind; query: WorksQuery; view: "grid" | "list"; actions: CardActions; loose: Loose; filtered: boolean }) {
  const { t, kind } = props;
  const paged = usePagedWorks(props.query, props.refreshKey);
  const coverIds = paged.items.map((item) => item.coverId);
  const cover = useCovers(coverIds, "grid");
  const coverRatio = portraitCoverRatio(coverIds, "grid", PORTRAIT.coverRatio);
  const aspect = coverRatio !== PORTRAIT.coverRatio ? `1 / ${coverRatio}` : undefined;
  const layout: GridLayout = useMemo(() => (props.view === "list" ? LIST : { ...PORTRAIT, coverRatio }), [props.view, coverRatio]);
  const render = useCallback((work: WorkSummary, index: number, tabbable: boolean) => (
    <WorkCard t={t} work={work} coverUrl={cover(work.coverId)} actions={props.actions} index={index} tabbable={tabbable} layout={props.view === "list" ? "row" : "card"} coverAspectRatio={aspect} context={props.context} />
  ), [t, cover, props.actions, props.view, aspect, props.context]);
  return (
    <div className="shelf-body" data-status={paged.status}>
      <p className="shelf-count" data-testid="shelf-count">{t("shelf.count", { count: paged.total, unit: t(`shelf.unit.${kind}` as "shelf.unit.novel") })}</p>
      <StatusLine t={t} kind={kind} status={paged.status} error={paged.error} onRetry={paged.reload} />
      {paged.status === "ready" && paged.items.length === 0 ? <EmptyShelf t={t} filtered={props.filtered} kind={kind} onAddPath={props.onAddPath} /> : null}
      {paged.items.length ? (
        <VirtualGrid
          items={paged.items}
          total={paged.total}
          hasMore={Boolean(paged.nextCursor)}
          loading={paged.loadingMore || paged.status === "loading"}
          onLoadMore={paged.loadMore}
          layout={layout}
          label={t(`shelf.title.${kind}` as "shelf.title.novel")}
          testId="shelf-grid"
          getKey={(work) => work.id}
          renderItem={render}
          footer={<>{paged.loadingMore ? <p role="status" className="shelf-note">{t("shelf.loadingMore")}</p> : null}{paged.nextCursor ? null : <LooseResources {...props} kind={kind} />}</>}
          scrollMemory={{ top: shelfMemory.get(kind).scrollTop, save: (top) => shelfMemory.patch(kind, { scrollTop: top }) }}
        />
      ) : null}
      {paged.status === "ready" && paged.items.length === 0 ? <LooseResources {...props} kind={kind} /> : null}
    </div>
  );
}

function OverviewView(props: ShelfProps & { query: WorksQuery; view: "grid" | "list"; actions: CardActions; loose: Loose; filtered: boolean }) {
  const [counts, setCounts] = useState<Record<string, number | undefined>>({});
  const report = useCallback((kind: WorkMediaKind, total: number | undefined) => setCounts((current) => current[kind] === total ? current : { ...current, [kind]: total }), []);
  const settled = MEDIA_KINDS.every((kind) => counts[kind] !== undefined);
  const empty = settled && MEDIA_KINDS.every((kind) => counts[kind] === 0);
  const body = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  // The overview keeps its own scroll: once the rows are drawn the list goes back to where it was.
  useEffect(() => {
    if (restored.current || !settled || !body.current) return;
    restored.current = true;
    body.current.scrollTop = shelfMemory.get("all").scrollTop;
  }, [settled]);
  return (
    <div ref={body} className="shelf-body shelf-sections" onScroll={(event) => { if (restored.current) shelfMemory.patch("all", { scrollTop: event.currentTarget.scrollTop }); }}>
      {empty ? <EmptyShelf t={props.t} filtered={props.filtered} kind={null} onAddPath={props.onAddPath} /> : null}
      {MEDIA_KINDS.map((kind) => <ShelfSection key={kind} {...props} kind={kind} query={{ ...props.query, kind }} onCount={report} hideWhenEmpty={empty} />)}
      <LooseResources {...props} kind={null} />
    </div>
  );
}

function ShelfSection(props: ShelfProps & { kind: WorkMediaKind; query: WorksQuery; actions: CardActions; view: "grid" | "list"; onCount: (kind: WorkMediaKind, total: number | undefined) => void; hideWhenEmpty: boolean }) {
  const { t, kind } = props;
  const paged = usePagedWorks(props.query, props.refreshKey, 14);
  const shownItems = useMemo(() => paged.items.filter(hasAvailableResource), [paged.items]);
  const visibleItems = useMemo(() => shownItems.slice(0, 14), [shownItems]);
  const sectionTotal = Math.max(0, paged.total - (paged.items.length - shownItems.length));
  const coverIds = visibleItems.map((item) => item.coverId);
  const cover = useCovers(coverIds, "grid");
  const coverRatio = portraitCoverRatio(coverIds, "grid", PORTRAIT.coverRatio);
  const aspect = coverRatio !== PORTRAIT.coverRatio ? `1 / ${coverRatio}` : undefined;
  const row = useRef<HTMLDivElement>(null);
  const Icon = KIND_ICON[kind];
  useEffect(() => {
    if (paged.status === "ready" && shownItems.length < 14 && Boolean(paged.nextCursor) && !paged.loadingMore) {
      paged.loadMore();
    }
  }, [paged.status, shownItems.length, paged.nextCursor, paged.loadingMore, paged.loadMore]);
  const pendingNext = shownItems.length === 0 && Boolean(paged.nextCursor);
  useEffect(() => { props.onCount(kind, paged.status === "ready" && !pendingNext ? sectionTotal : undefined); }, [paged.status, pendingNext, sectionTotal, kind, props.onCount]);
  if (props.hideWhenEmpty) return null;
  const facet = KIND_FACET[kind];
  // The way to a medium's shelf stays while the medium has no works: what was taken out of a work (not in a work) is listed on that shelf and nowhere else.
  return (
    <section className="shelf-section" data-testid={`section-${kind}`} data-status={paged.status} aria-label={kindName(t, kind)}>
      <header>
        <h2><Icon size={18} aria-hidden="true" />{kindName(t, kind)}<span className="section-count" data-testid={`section-count-${kind}`}>{t("shelf.count", { count: sectionTotal, unit: t(`shelf.unit.${kind}` as "shelf.unit.novel") })}</span></h2>
        {sectionTotal > 0 || !(facet && !props.facets.has(facet)) ? <button type="button" className="link-button" data-testid={`section-all-${kind}`} onClick={() => props.onViewAll(kind)}>{t("shelf.viewAll")}<ChevronRight size={14} aria-hidden="true" /></button> : null}
      </header>
      <StatusLine t={t} kind={kind} status={paged.status} error={paged.error} onRetry={paged.reload} />
      {paged.status === "ready" && shownItems.length === 0 && !paged.nextCursor ? (
        <p className="shelf-note" data-testid={`section-empty-${kind}`}>{facet && !props.facets.has(facet) ? t("shelf.moduleOff", { name: kindName(t, kind) }) : t("shelf.sectionEmpty", { name: kindName(t, kind) })}</p>
      ) : null}
      {visibleItems.length ? (
        <div className="section-row" ref={row} data-kind={kind} role="list" aria-label={kindName(t, kind)}>
          {visibleItems.map((work, index) => (
            <div key={work.id} role="listitem" className="section-cell" data-kind={kind}>
              <WorkCard t={t} work={work} coverUrl={cover(work.coverId)} actions={props.actions} index={index} tabbable layout="card" coverAspectRatio={aspect} context={props.context} />
            </div>
          ))}
          {Boolean(paged.nextCursor) || shownItems.length > 14 ? <button type="button" className="section-more" onClick={() => props.onViewAll(kind)} aria-label={t("shelf.viewAll")}><ChevronRight size={20} /></button> : null}
        </div>
      ) : null}
    </section>
  );
}
