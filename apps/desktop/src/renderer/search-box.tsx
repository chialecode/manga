import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FolderKanban, Search, Sparkles, TextSearch, X } from "lucide-react";
import { FIND_QUERY_MAX, type FindGroup, type FindItem, type FindType, type RailView } from "@manga/contracts";
import type { MessageKey } from "@manga/i18n";
import { asArray, attempt } from "./lib/api.ts";
import { searchStateKey, type SemanticHitView, type SemanticSearchView } from "./lib/semantic-model.ts";
import { RAIL_ICON } from "./rail.tsx";
import { VIEW_LABEL } from "./sidebar.tsx";
import { useServices } from "./workspace/services.tsx";

type Hit = { fragmentId?: string; kind?: string; resourceId?: string; revisionId?: string; objectId?: string | null; text: string; locator?: { kind?: string } | null };

/** A row of the list the keys move over: a thing found by name, the line that searches the texts, a hit in a text, or a passage found by meaning. */
type Row =
  | { id: string; kind: "name"; item: FindItem }
  | { id: string; kind: "body-run" }
  | { id: string; kind: "body"; hit: Hit }
  | { id: string; kind: "semantic"; hit: SemanticHitView };

const FIND_DEBOUNCE_MS = 60;
/** The views whose scope has texts to search: the readers' (a book, a comic, a video's subtitles) and the notes'. */
const TEXT_SCOPES: readonly string[] = ["novel", "comic", "video", "note"];

/**
 * The search box (A-100, 交互设计 2.11): a floating box over the window, not a tab. What is typed lists, at once, the projects, conversations, works, notes and
 * objects whose name matches, by kind; Enter (or the line "在正文里搜索") searches the texts of resources and notes, and the semantic index when it is on.
 * It is opened from a view of the rail with that view as its scope, which Backspace or its close button takes off. Up and down choose, Enter opens, Ctrl + Enter
 * opens behind; Esc closes it, and the focus goes back to where it was.
 */
export function SearchBox(props: { initialQuery: string; initialScope: string | null; onClose: () => void }) {
  const s = useServices();
  const { t } = s;
  const [text, setText] = useState(props.initialQuery);
  const [scope, setScope] = useState<RailView | null>((props.initialScope as RailView | null) ?? null);
  const [groups, setGroups] = useState<FindGroup[]>([]);
  const [found, setFound] = useState<string>("");
  const [body, setBody] = useState<{ text: string; hits: Hit[] } | null>(null);
  const [semantic, setSemantic] = useState<{ text: string; search: SemanticSearchView } | null>(null);
  const [busy, setBusy] = useState(false);
  /** -1: nothing is chosen, Enter searches the texts. */
  const [active, setActive] = useState(-1);
  const listId = useId();
  const latestFind = useRef(0);
  const latestBody = useRef(0);
  const opened = useRef(false);
  /** Where the focus was when the box came up, to give it back when the box goes without having opened anything. */
  const returnTo = useRef<HTMLElement | null>(typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
  const list = useRef<HTMLDivElement>(null);
  const query = text.trim();
  const titles = useMemo(() => new Map(((s.workspace?.resources as Array<{ id: string; title: string }> | undefined) ?? []).map((item) => [item.id, item.title])), [s.workspace]);
  const textScope = scope === null || TEXT_SCOPES.includes(scope);

  // The names that match come as the text is typed; an answer that arrives after a newer question is dropped.
  useEffect(() => {
    if (!query) { latestFind.current += 1; setGroups([]); setFound(""); setBody(null); setSemantic(null); return; }
    const mine = ++latestFind.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await attempt<{ groups: FindGroup[] }>("workspace.find", { q: query.slice(0, FIND_QUERY_MAX), ...(scope ? { view: scope } : {}), perType: 4 });
        if (mine !== latestFind.current) return;
        if (!result.ok) { s.setError(result.error.message); return; }
        setGroups(result.value.groups);
        setFound(query);
        setActive(-1);
      })();
    }, FIND_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope]);

  // The texts and the semantic index are asked when Enter says so; what was shown for another text goes.
  useEffect(() => { setBody((current) => (current && current.text !== query ? null : current)); setSemantic((current) => (current && current.text !== query ? null : current)); }, [query]);

  async function runBody() {
    if (!query || busy || !textScope) return;
    const mine = ++latestBody.current;
    setBusy(true);
    const [library, meaning] = await Promise.all([
      attempt<unknown>("library.find", { text: query }),
      s.facets.has("semantic") ? attempt<SemanticSearchView>("semantic.search", { text: query }) : Promise.resolve(null),
    ]);
    if (mine !== latestBody.current) return;
    setBusy(false);
    if (!library.ok) s.setError(library.error.message);
    else {
      const hits = asArray<Hit>(library.value).filter((hit) => (scope === "note" ? Boolean(hit.objectId) : scope ? !hit.objectId : true));
      setBody({ text: query, hits });
    }
    if (meaning && meaning.ok) setSemantic({ text: query, search: meaning.value });
    else if (meaning && !meaning.ok) s.setError(meaning.error.message);
    setActive(-1);
  }

  const rows: Row[] = [];
  for (const group of groups) for (const item of group.items) rows.push({ id: `${listId}-name-${rows.length}`, kind: "name", item });
  if (query && textScope) rows.push({ id: `${listId}-run`, kind: "body-run" });
  if (body && body.text === query) for (const hit of body.hits) rows.push({ id: `${listId}-body-${rows.length}`, kind: "body", hit });
  if (semantic && semantic.text === query && !searchStateKey(semantic.search.state)) for (const hit of semantic.search.results) rows.push({ id: `${listId}-semantic-${rows.length}`, kind: "semantic", hit });

  function done(focusTab: boolean) {
    opened.current = focusTab;
    props.onClose();
    if (focusTab) requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="tab-panel"][data-focused="true"]')?.focus({ preventScroll: true })));
  }

  function openRow(row: Row, behind: boolean) {
    if (row.kind === "body-run") { void runBody(); return; }
    if (row.kind === "name") {
      const item = row.item;
      done(!behind);
      void s.open.item({ open: item.open, ...(item.contextId !== undefined ? { contextId: item.contextId } : {}), title: item.title }, behind ? { background: true } : undefined);
      return;
    }
    if (row.kind === "semantic") { done(!behind); s.open.semanticHit(row.hit); return; }
    const hit = row.hit;
    done(!behind);
    if (hit.objectId) s.open.note(hit.objectId, undefined, behind ? { background: true } : undefined);
    else if (hit.resourceId && hit.locator) void s.open.anchor({ resourceId: hit.resourceId, resourceRevisionId: hit.revisionId, locator: hit.locator } as never);
    else if (hit.resourceId) void s.open.resource({ resourceId: hit.resourceId }, behind ? { background: true } : undefined);
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) return;
      event.preventDefault();
      setActive((current) => {
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        return next >= rows.length ? 0 : next < 0 ? rows.length - 1 : next;
      });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row) openRow(row, event.ctrlKey || event.metaKey);
      else void runBody();
    } else if (event.key === "Backspace" && text === "" && scope) {
      event.preventDefault();
      setScope(null);
    }
  }

  useEffect(() => {
    if (active < 0) return;
    list.current?.querySelector<HTMLElement>(`[id="${rows[active]?.id}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const typeLabel = (type: FindType): string => (type === "project" ? t("sidebar.projects") : t(VIEW_LABEL[type as RailView]));
  const iconOf = (type: string, size: number): ReactNode => {
    if (type === "project") return <FolderKanban size={size} aria-hidden="true" />;
    const Icon = RAIL_ICON[type as RailView] ?? Search;
    return <Icon size={size} aria-hidden="true" />;
  };
  const stateKey = semantic && semantic.text === query ? searchStateKey(semantic.search.state) : null;
  const option = (row: Row, content: ReactNode, testId: string) => (
    <div key={row.id} id={row.id} role="option" aria-selected={rows[active]?.id === row.id} className="search-row" data-active={rows[active]?.id === row.id ? "true" : "false"} data-testid={testId} data-opens={row.kind === "body-run" ? undefined : ""} onMouseMove={() => { const at = rows.findIndex((item) => item.id === row.id); if (at !== active) setActive(at); }} onClick={(event) => openRow(row, event.ctrlKey || event.metaKey)} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); openRow(row, true); } }}>{content}</div>
  );

  let at = 0;
  const nameRows = groups.map((group) => (
    <div key={group.type} role="group" aria-label={typeLabel(group.type)} className="search-group" data-testid={`search-group-${group.type}`}>
      <h3 className="search-group-title">{typeLabel(group.type)}</h3>
      {group.items.map((item) => {
        const row = rows[at]!;
        at += 1;
        return option(row, (
          <>
            <span className="search-row-icon">{iconOf(item.type, 15)}</span>
            <span className="search-row-title truncate">{item.title}</span>
            <span className="search-row-place truncate">{item.type === "project" ? "" : item.contextName ?? (item.contextId === null ? t("sidebar.recent") : "")}</span>
          </>
        ), `search-result-${item.type}`);
      })}
    </div>
  ));

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) done(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="search-overlay" data-testid="search-overlay" />
        <Dialog.Content
          className="search-popup"
          data-testid="search-box"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => { if ((event as KeyboardEvent).isComposing) event.preventDefault(); }}
          // The dialog would focus a trigger it does not have: the focus goes back to where it was, or, after something was opened, to that tab (`done`).
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!opened.current && returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true });
          }}
        >
          <Dialog.Title className="sr-only">{t("search.box.label")}</Dialog.Title>
          <div className="search-input-row">
            <Search size={17} aria-hidden="true" className="search-input-icon" />
            {scope ? (
              <span className="search-scope" data-testid="search-scope">
                <span>{t(VIEW_LABEL[scope])}</span>
                <button type="button" aria-label={t("search.scope.remove", { name: t(VIEW_LABEL[scope]) })} data-testid="search-scope-remove" onClick={() => setScope(null)}><X size={12} aria-hidden="true" /></button>
              </span>
            ) : null}
            <input
              autoFocus
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls={listId}
              aria-activedescendant={rows[active]?.id}
              aria-autocomplete="list"
              aria-label={t("search.box.label")}
              placeholder={scope ? t("search.box.placeholderScoped", { name: t(VIEW_LABEL[scope]) }) : t("search.box.placeholder")}
              data-testid="search-input"
              value={text}
              maxLength={512}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
            />
            <Dialog.Close className="icon-button search-close" aria-label={t("common.close")} data-testid="search-box-close"><X size={16} aria-hidden="true" /></Dialog.Close>
          </div>
          <div ref={list} id={listId} role="listbox" aria-label={t("search.box.results")} className="search-results" data-testid="search-results" aria-busy={busy}>
            {!query ? <p className="search-hint" data-testid="search-hint">{t("search.box.hint")}</p> : null}
            {query && found === query && groups.length === 0 ? <p className="search-hint" role="status" data-testid="search-names-none">{t("search.box.noNames")}</p> : null}
            {nameRows}
            {query && textScope ? (
              <div role="group" aria-label={t("search.group.texts")} className="search-group" data-testid="search-group-texts">
                {(() => {
                  const row = rows.find((item) => item.kind === "body-run")!;
                  return option(row, (<><span className="search-row-icon"><TextSearch size={15} aria-hidden="true" /></span><span className="search-row-title truncate">{t("search.box.inTexts", { q: query })}</span><kbd className="search-row-key">Enter</kbd></>), "search-run-body");
                })()}
                {busy ? <p className="search-hint" role="status">{t("status.loading")}</p> : null}
                {body && body.text === query ? (
                  body.hits.length ? (
                    <>
                      <p className="search-hint" role="status" data-testid="search-count">{t("search.count", { n: body.hits.length })}</p>
                      {body.hits.map((hit, index) => {
                        const row = rows.find((item) => item.kind === "body" && item.hit === hit)!;
                        return option(row, (
                          <>
                            <span className="search-row-icon"><Search size={15} aria-hidden="true" /></span>
                            <span className="search-row-body">
                              <span className="search-row-meta"><span className="chip">{hit.objectId ? t("search.kind.note") : t("search.kind.body")}</span>{hit.resourceId && titles.get(hit.resourceId) ? <strong className="truncate">{titles.get(hit.resourceId)}</strong> : null}</span>
                              <span className="search-snippet">{hit.text}</span>
                            </span>
                          </>
                        ), `search-hit-${hit.objectId ? "note" : "body"}-${index}`);
                      })}
                    </>
                  ) : <p className="search-hint" role="status" data-testid="search-none">{t("search.none")}</p>
                ) : null}
              </div>
            ) : null}
            {semantic && semantic.text === query && textScope ? (
              <div role="group" aria-label={t("search.group.semantic")} className="search-group" data-testid="search-group-semantic">
                <h3 className="search-group-title"><Sparkles size={12} aria-hidden="true" /> {t("search.group.semantic")}</h3>
                {stateKey ? (
                  <p className="search-hint" role="status" data-testid="semantic-state" data-state={semantic.search.state}>{t(stateKey)} <button type="button" className="link-button" data-testid="semantic-open-settings" onClick={() => { done(false); s.open.settings("semantic"); }}>{t("semantic.search.openSettings")}</button></p>
                ) : semantic.search.results.length === 0 ? <p className="search-hint" role="status" data-testid="semantic-none">{t("semantic.search.none")}</p> : semantic.search.results.map((hit, index) => {
                  const row = rows.find((item) => item.kind === "semantic" && item.hit === hit)!;
                  return option(row, (
                    <>
                      <span className="search-row-icon"><Sparkles size={15} aria-hidden="true" /></span>
                      <span className="search-row-body">
                        <span className="search-row-meta"><span className="chip">{t(`semantic.kind.${hit.kind}` as MessageKey)}</span><strong className="truncate">{hit.title}</strong></span>
                        <span className="search-snippet">{hit.text}</span>
                      </span>
                    </>
                  ), `search-semantic-${index}`);
                })}
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
