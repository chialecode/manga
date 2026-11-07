import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Filter, LayoutGrid, List, Search } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Menu, type MenuItem } from "../components/menu.tsx";
import { VirtualGrid, type GridLayout } from "../components/virtual-grid.tsx";
import { useCovers } from "../lib/covers.ts";
import { shelfMemory } from "../lib/shelf-memory.ts";
import { usePagedWorks, type WorksQuery } from "../lib/use-works.ts";
import { MEDIA_KINDS, SHELF_ORDER, type Facets, type ShelfState, type WorkMediaKind, type WorkSummary } from "../lib/works.ts";
import { KIND_ICON, WorkCard, type CardActions } from "./work-card.tsx";

type T = Translator["t"];
type Sort = "recent" | "added" | "title" | "progress";
type Tab = "all" | ShelfState;
type Tri = "any" | "yes" | "no";

const FORMATS: Record<WorkMediaKind, Array<{ id: string; label: string }>> = {
  novel: [{ id: "txt", label: "TXT" }, { id: "epub", label: "EPUB" }, { id: "mobi", label: "MOBI" }, { id: "pdf", label: "PDF" }],
  comic: [{ id: "dir", label: "dir" }, { id: "cbz", label: "CBZ" }, { id: "pdf", label: "PDF" }, { id: "epub", label: "EPUB" }, { id: "mobi", label: "MOBI" }],
  video: [],
};

const PORTRAIT: GridLayout = { kind: "grid", minCard: 148, gap: 18, coverRatio: 4 / 3, textHeight: 112 };
const LANDSCAPE: GridLayout = { kind: "grid", minCard: 220, gap: 18, coverRatio: 10 / 16, textHeight: 96 };
const LIST: GridLayout = { kind: "list", rowHeight: 76 };

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
};

const KIND_FACET: Record<WorkMediaKind, string | null> = { novel: null, comic: "comic", video: "video" };
const kindName = (t: T, kind: WorkMediaKind) => t(`shelf.kind.${kind}` as "shelf.kind.novel");

/** The library page: one row per media kind on the overview, a full grid or list on a kind's own page. */
export function Shelf(props: ShelfProps) {
  const { t, kind } = props;
  const memoryKey = kind ?? "all";
  const remembered = shelfMemory.get(memoryKey);
  const [tab, setTab] = useState<Tab>(remembered.tab as Tab);
  const [sort, setSort] = useState<Sort>(remembered.sort);
  const [view, setViewState] = useState<"grid" | "list">(readView);
  const [text, setText] = useState(remembered.text);
  const [applied, setApplied] = useState(remembered.text.trim());
  const [linked, setLinked] = useState<Tri>(remembered.linked);
  const [notes, setNotes] = useState<Tri>(remembered.notes);
  const [format, setFormat] = useState(remembered.format);
  const [filterOpen, setFilterOpen] = useState(false);
  const composing = useRef(false);

  const setView = (next: "grid" | "list") => {
    setViewState(next);
    try { localStorage.setItem("manga.shelf.view", next); } catch { /* the choice just is not remembered */ }
  };

  // The search runs after the typing pauses, and never while an input method is still composing.
  useEffect(() => {
    if (composing.current) return;
    const timer = window.setTimeout(() => setApplied(text.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [text]);

  // Coming back from a work's page shows the shelf as it was left.
  useEffect(() => { shelfMemory.patch(memoryKey, { tab, sort, text, linked, notes, format }); }, [memoryKey, tab, sort, text, linked, notes, format]);

  const base: WorksQuery = useMemo(() => ({
    ...(tab !== "all" ? { shelf: tab } : {}),
    ...(applied ? { query: applied } : {}),
    ...(linked !== "any" ? { linked: linked === "yes" } : {}),
    ...(notes !== "any" ? { hasNotes: notes === "yes" } : {}),
    ...(format ? { format } : {}),
    sort,
  }), [tab, applied, linked, notes, format, sort]);

  const actions: CardActions = useMemo(() => ({
    onOpen: props.onOpen,
    onContinue: props.onContinue,
    onDetail: (workId) => props.onDetail(workId),
    onCover: (workId) => props.onDetail(workId, "cover"),
    onShelf: props.onSetShelf,
  }), [props.onOpen, props.onContinue, props.onDetail, props.onSetShelf]);

  const title = kind ? t(`shelf.title.${kind}` as "shelf.title.novel") : t("shelf.title.all");
  const filtersActive = linked !== "any" || notes !== "any" || Boolean(format);
  const sortItems: MenuItem[] = (["recent", "added", "title", "progress"] as Sort[]).map((id) => ({ id, label: t(`shelf.sort.${id}` as "shelf.sort.recent"), checked: sort === id, onSelect: () => setSort(id) }));
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
              value={text}
              placeholder={t("shelf.search")}
              aria-label={t("shelf.search")}
              data-testid="shelf-search"
              onChange={(event) => setText(event.target.value)}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={(event) => { composing.current = false; setText((event.target as HTMLInputElement).value); }}
            />
          </label>
        </div>
      </header>
      <div className="shelf-bar">
        <div role="tablist" aria-label={t("shelf.tabs")} className="shelf-tabs">
          {(["all", ...SHELF_ORDER] as Tab[]).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} data-testid={`shelf-tab-${id}`} onClick={() => setTab(id)}>{t(`shelf.tab.${id}` as "shelf.tab.all")}</button>
          ))}
        </div>
        <div className="shelf-options">
          <div role="group" aria-label={t("shelf.view")} className="view-toggle">
            <button type="button" aria-pressed={view === "grid"} aria-label={t("shelf.view.grid")} title={t("shelf.view.grid")} data-testid="shelf-view-grid" onClick={() => setView("grid")}><LayoutGrid size={16} /></button>
            <button type="button" aria-pressed={view === "list"} aria-label={t("shelf.view.list")} title={t("shelf.view.list")} data-testid="shelf-view-list" onClick={() => setView("list")}><List size={16} /></button>
          </div>
          <Menu label={`${t("shelf.sort")}：${t(`shelf.sort.${sort}` as "shelf.sort.recent")}`} items={sortItems} align="end" testId="shelf-sort" trigger={<span className="menu-text">{t(`shelf.sort.${sort}` as "shelf.sort.recent")}</span>} />
          <span className="filter-root">
            <button type="button" className="menu-button" aria-expanded={filterOpen} aria-controls="shelf-filter-panel" data-active={filtersActive} data-testid="shelf-filter" onClick={() => setFilterOpen((open) => !open)}><Filter size={14} aria-hidden="true" /><span className="menu-text">{t("shelf.filter")}</span></button>
            {filterOpen ? (
              <div id="shelf-filter-panel" role="group" aria-label={t("shelf.filter")} className="filter-panel" onKeyDown={(event) => { if (event.key === "Escape") setFilterOpen(false); }}>
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
                {kind && FORMATS[kind].length ? (
                  <label>{t("shelf.filter.format")}
                    <select value={format} data-testid="shelf-filter-format" onChange={(event) => setFormat(event.target.value)}>
                      <option value="">{t("shelf.filter.any")}</option>
                      {FORMATS[kind].map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                ) : null}
                <button type="button" className="secondary-button" onClick={() => { setLinked("any"); setNotes("any"); setFormat(""); }}>{t("shelf.filter.reset")}</button>
              </div>
            ) : null}
          </span>
        </div>
      </div>
      {moduleOff ? <p role="status" className="shelf-note" data-testid="shelf-module-off">{t("shelf.moduleOff", { name: kindName(t, moduleOff) })}</p> : null}
      {kind ? (
        <KindView {...props} kind={kind} query={{ ...base, kind }} view={view} actions={actions} filtered={Boolean(applied) || tab !== "all" || filtersActive} />
      ) : (
        <OverviewView {...props} query={base} view={view} actions={actions} filtered={Boolean(applied) || tab !== "all" || filtersActive} />
      )}
    </section>
  );
}

function StatusLine(props: { t: T; status: "loading" | "ready" | "error"; error?: string; onRetry: () => void }) {
  if (props.status === "loading") return <p role="status" className="shelf-note" data-testid="shelf-loading">{props.t("shelf.loading")}</p>;
  if (props.status === "error") {
    return (
      <p role="alert" className="shelf-note shelf-error" data-testid="shelf-error">
        {props.t("shelf.error")}{props.error ? `：${props.error}` : ""}
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
      {props.filtered ? null : <><p className="empty-hint">{props.t("shelf.emptyHint")}</p><button type="button" className="link-button" data-testid="shelf-add-path" onClick={props.onAddPath}>{props.t("shelf.addPath")}</button></>}
    </div>
  );
}

function KindView(props: ShelfProps & { kind: WorkMediaKind; query: WorksQuery; view: "grid" | "list"; actions: CardActions; filtered: boolean }) {
  const { t, kind } = props;
  const paged = usePagedWorks(props.query, props.refreshKey);
  const cover = useCovers(paged.items.map((item) => item.coverId), "grid");
  const layout = props.view === "list" ? LIST : kind === "video" ? LANDSCAPE : PORTRAIT;
  const render = useCallback((work: WorkSummary, index: number, tabbable: boolean) => (
    <WorkCard t={t} work={work} coverUrl={cover(work.coverId)} actions={props.actions} index={index} tabbable={tabbable} layout={props.view === "list" ? "row" : "card"} />
  ), [t, cover, props.actions, props.view]);
  return (
    <div className="shelf-body" data-status={paged.status}>
      <p className="shelf-count" data-testid="shelf-count">{t("shelf.count", { count: paged.total, unit: t(`shelf.unit.${kind}` as "shelf.unit.novel") })}</p>
      <StatusLine t={t} status={paged.status} error={paged.error} onRetry={paged.reload} />
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
          footer={paged.loadingMore ? <p role="status" className="shelf-note">{t("shelf.loadingMore")}</p> : null}
          scrollMemory={{ top: shelfMemory.get(kind).scrollTop, save: (top) => shelfMemory.patch(kind, { scrollTop: top }) }}
        />
      ) : null}
    </div>
  );
}

function OverviewView(props: ShelfProps & { query: WorksQuery; view: "grid" | "list"; actions: CardActions; filtered: boolean }) {
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
    </div>
  );
}

function ShelfSection(props: ShelfProps & { kind: WorkMediaKind; query: WorksQuery; actions: CardActions; view: "grid" | "list"; onCount: (kind: WorkMediaKind, total: number | undefined) => void; hideWhenEmpty: boolean }) {
  const { t, kind } = props;
  const paged = usePagedWorks(props.query, props.refreshKey, 14);
  const cover = useCovers(paged.items.map((item) => item.coverId), "grid");
  const row = useRef<HTMLDivElement>(null);
  const Icon = KIND_ICON[kind];
  useEffect(() => { props.onCount(kind, paged.status === "ready" ? paged.total : undefined); }, [paged.status, paged.total, kind, props.onCount]);
  if (props.hideWhenEmpty) return null;
  const facet = KIND_FACET[kind];
  return (
    <section className="shelf-section" data-testid={`section-${kind}`} data-status={paged.status} aria-label={kindName(t, kind)}>
      <header>
        <h2><Icon size={18} aria-hidden="true" />{kindName(t, kind)}<span className="section-count" data-testid={`section-count-${kind}`}>{t("shelf.count", { count: paged.total, unit: t(`shelf.unit.${kind}` as "shelf.unit.novel") })}</span></h2>
        {paged.total > 0 ? <button type="button" className="link-button" data-testid={`section-all-${kind}`} onClick={() => props.onViewAll(kind)}>{t("shelf.viewAll")}<ChevronRight size={14} aria-hidden="true" /></button> : null}
      </header>
      <StatusLine t={t} status={paged.status} error={paged.error} onRetry={paged.reload} />
      {paged.status === "ready" && paged.items.length === 0 ? (
        <p className="shelf-note" data-testid={`section-empty-${kind}`}>{facet && !props.facets.has(facet) ? t("shelf.moduleOff", { name: kindName(t, kind) }) : t("shelf.sectionEmpty", { name: kindName(t, kind) })}</p>
      ) : null}
      {paged.items.length ? (
        <div className="section-row" ref={row} data-kind={kind} role="list" aria-label={kindName(t, kind)}>
          {paged.items.map((work, index) => (
            <div key={work.id} role="listitem" className="section-cell" data-kind={kind}>
              <WorkCard t={t} work={work} coverUrl={cover(work.coverId)} actions={props.actions} index={index} tabbable layout="card" />
            </div>
          ))}
          {paged.nextCursor ? <button type="button" className="section-more" onClick={() => props.onViewAll(kind)} aria-label={t("shelf.viewAll")}><ChevronRight size={20} /></button> : null}
        </div>
      ) : null}
    </section>
  );
}
