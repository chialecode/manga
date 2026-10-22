import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Clock, FolderKanban, FolderPlus, Library, MessageSquarePlus, Plus, Search, SquareStack } from "lucide-react";
import { contextKey, itemTypeOfView, type ContextId, type ObjectListKind, type RailView, type SidebarGroup, type SidebarItem, type SidebarItemType, type SidebarSection } from "@manga/contracts";
import type { MessageKey } from "@manga/i18n";
import { Modal } from "./components/modal.tsx";
import { attempt } from "./lib/api.ts";
import { OBJECT_SPEC } from "./lib/object-kinds.ts";
import { RAIL_ICON } from "./rail.tsx";
import { sectionKey, shownOf, useRail, useSidebarData, openKeysOf } from "./sidebar-data.ts";
import { ContextMenu, type ContextItem } from "./workspace/context-menu.tsx";
import { useServices } from "./workspace/services.tsx";

/** The words for a kind of thing and for a view (the rail's own labels). */
export const VIEW_LABEL: Record<RailView, MessageKey> = {
  home: "nav.home",
  conversation: "nav.conversation",
  novel: "nav.novel",
  comic: "nav.comic",
  video: "nav.video",
  note: "nav.note",
  whiteboard: "nav.whiteboard",
  mindmap: "nav.mindmap",
  draft: "nav.draft",
  roughcut: "nav.roughcut",
  downloads: "nav.downloads",
};
const EMPTY_KEY: Record<SidebarItemType | "download", MessageKey> = {
  conversation: "sidebar.empty.conversation",
  novel: "sidebar.empty.novel",
  comic: "sidebar.empty.comic",
  video: "sidebar.empty.video",
  note: "sidebar.empty.note",
  whiteboard: "sidebar.empty.whiteboard",
  mindmap: "sidebar.empty.mindmap",
  draft: "sidebar.empty.draft",
  roughcut: "sidebar.empty.roughcut",
  download: "sidebar.empty.download",
};
const OBJECT_VIEWS: readonly RailView[] = ["whiteboard", "mindmap", "draft", "roughcut"];
const isObjectView = (view: RailView): view is ObjectListKind => (OBJECT_VIEWS as readonly string[]).includes(view);
const TIP_MS = 450;

type Target = { kind: "project"; group: SidebarGroup } | { kind: "item"; item: SidebarItem };
type Renaming = { type: "project" | "conversation" | "object"; id: string; objectKind?: ObjectListKind; text: string };
type Tip = { item: SidebarItem; left: number; top: number };

/**
 * One view of the sidebar (A-99, 交互设计 2.10): the view's name and the search button, its own entries (the management tab, a new one), then the projects
 * and "最近" with the things of the view's kind — or, on the home, with every kind in small groups. The same component fills the docked sidebar and the card
 * that comes out of the rail when the sidebar is folded away (`variant`); a card is told (`onDone`) when something opened, so it can go.
 */
export function Sidebar(props: { view: RailView; variant: "dock" | "card"; onDone?: () => void }) {
  const s = useServices();
  const { t } = s;
  const { view } = props;
  const { rail, change } = useRail();
  const { data, status, more, loadMore, reload } = useSidebarData(view);
  const current = s.currentContext;
  const currentKey = contextKey(current);
  const own = itemTypeOfView(view);
  const [menu, setMenu] = useState<{ x: number; y: number; target: Target } | null>(null);
  const [chooser, setChooser] = useState<{ x: number; y: number; kind: ObjectListKind } | null>(null);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [asking, setAsking] = useState<SidebarItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const tipTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(tipTimer.current), []);

  const opened = openKeysOf(rail, view, current);
  const isOpen = (key: string) => opened.includes(key);
  const toggle = (key: string) => {
    const next = new Set(opened);
    if (next.has(key)) next.delete(key); else next.add(key);
    change({ open: { [view]: [...next] } });
  };

  const done = () => props.onDone?.();
  /** Opens a thing in the context it belongs to; a card goes first, so it is not left standing over what opens. */
  const open = (item: SidebarItem, options?: { background?: boolean }) => {
    done();
    void s.open.item({ open: item.open, contextId: item.contextId, title: item.title }, options);
  };

  // ---------------------------------------------------------------------------------------------------------------------- the entries
  type Entry = { id: string; testId: string; label: string; icon: ReactNode; run: (event: ReactMouseEvent<HTMLButtonElement>) => void };
  const entries: Entry[] = [];
  const entry = (id: string, testId: string, label: string, icon: ReactNode, run: Entry["run"]) => entries.push({ id, testId, label, icon, run });
  const newConversation = () => { done(); void s.open.newConversation(); };
  if (view === "home" || view === "conversation") {
    if (s.facets.has("agent")) entry("new-conversation", "sidebar-new-conversation", t("sidebar.newConversation"), <MessageSquarePlus size={16} aria-hidden="true" />, newConversation);
  }
  if (view === "home") {
    if (s.facets.has("projects")) entry("new-project", "sidebar-new-project", t("sidebar.newProject"), <FolderPlus size={16} aria-hidden="true" />, () => { done(); s.open.newProject(); });
    if (s.facets.has("library") || s.facets.has("inventory")) entry("library", "sidebar-entry-library", t("sidebar.entry.library"), <Library size={16} aria-hidden="true" />, () => { done(); s.open.library("overview"); });
    if (s.facets.has("projects")) entry("projects", "sidebar-entry-projects", t("sidebar.entry.projects"), <FolderKanban size={16} aria-hidden="true" />, () => { done(); void s.open.project(null); });
  } else {
    if (isObjectView(view)) {
      entry("new-object", "sidebar-new-object", t(`sidebar.new.${view}` as MessageKey), <Plus size={16} aria-hidden="true" />, (event) => void createObject(view, event.currentTarget));
    }
    const manage = (() => {
      if (view === "conversation") return () => s.open.records({ type: "conversation" });
      if (view === "note") return () => s.open.records({ type: "note" });
      if (view === "novel" || view === "comic" || view === "video") return () => s.open.library(view);
      if (isObjectView(view)) return () => s.open.objects(view);
      if (view === "downloads") return () => s.open.downloads();
      return null;
    })();
    if (manage) entry("manage", "sidebar-manage", t(`sidebar.manage.${view}` as MessageKey), <SquareStack size={16} aria-hidden="true" />, () => { done(); manage(); });
  }

  async function createObject(kind: ObjectListKind, anchor: HTMLElement) {
    if (current) { done(); await s.open.createObject(kind, current); return; }
    // In "最近" there is no project to make it in: the person says which.
    const rect = anchor.getBoundingClientRect();
    if (!data?.groups.some((group) => group.kind === "project")) { s.setNotice(t("sidebar.noProjects")); return; }
    setChooser({ x: rect.left, y: rect.bottom + 2, kind });
  }

  // ------------------------------------------------------------------------------------------------------------------------- changes
  const projects = (data?.groups ?? []).filter((group) => group.kind === "project");

  async function commitRename(event: FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    const text = renaming.text.replace(/\s+/g, " ").trim();
    const done = renaming;
    setRenaming(null);
    if (!text) return;
    const result = done.type === "project"
      ? await attempt("project.update", { projectId: done.id, name: text })
      : done.type === "conversation"
        ? await attempt("conversation.rename", { sessionId: done.id, title: text })
        : await attempt(OBJECT_SPEC[done.objectKind!].rename, { [OBJECT_SPEC[done.objectKind!].idField]: done.id, title: text });
    if (!result.ok) { s.setError(result.error.message); return; }
    if (done.type === "conversation") s.conversationsChanged(); else s.changedProjects();
  }

  async function archive(group: SidebarGroup) {
    if (!group.contextId) return;
    const result = await attempt("project.update", { projectId: group.contextId, status: "archived" });
    if (!result.ok) { s.setError(result.error.message); return; }
    s.changedProjects();
    if (group.contextId === current) await s.open.switchContext(null);
    s.setNotice(t("sidebar.archived", { name: group.name }));
  }

  async function move(item: SidebarItem, contextId: ContextId) {
    const result = await attempt("conversation.move", { sessionId: item.open.id, contextId });
    if (!result.ok) { s.setError(result.error.message); return; }
    s.conversationsChanged();
  }

  async function removeFromProject(item: SidebarItem) {
    if (!item.contextId || !item.materialId) return;
    const result = await attempt("project.removeMaterial", { projectId: item.contextId, materialId: item.materialId });
    if (!result.ok) { s.setError(result.error.message); return; }
    s.changedProjects();
    s.setNotice(t("sidebar.removed", { name: item.contextName ?? "", title: item.title }));
  }

  async function remove() {
    if (!asking) return;
    setBusy(true);
    const item = asking;
    const objectKind = (OBJECT_VIEWS as readonly string[]).includes(item.open.kind) ? (item.open.kind as ObjectListKind) : null;
    const result = objectKind
      ? await attempt(OBJECT_SPEC[objectKind].delete, { [OBJECT_SPEC[objectKind].idField]: item.open.id })
      : await attempt<{ removed: string[]; skipped: Array<{ reason?: string }> }>("conversation.delete", { sessionIds: [item.open.id] });
    setBusy(false);
    setAsking(null);
    if (!result.ok) { s.setError(result.error.message); return; }
    if (objectKind) { s.changedProjects(); return; }
    const value = result.value as { removed: string[] };
    s.setNotice(value.removed.length ? t("records.conv.done", { count: value.removed.length }) : t("records.conv.skipped", { count: 1 }));
    s.conversationsChanged();
  }

  function menuItems(target: Target): ContextItem[] {
    if (target.kind === "project") {
      const group = target.group;
      return [
        { id: "open", label: t("sidebar.menu.home"), onSelect: () => { done(); void s.open.project(group.contextId); } },
        { id: "rename", label: t("sidebar.menu.rename"), onSelect: () => setRenaming({ type: "project", id: group.contextId ?? "", text: group.name }) },
        { id: "archive", label: t("sidebar.menu.archive"), onSelect: () => void archive(group) },
      ];
    }
    const item = target.item;
    if (item.type === "conversation") {
      const items: ContextItem[] = [
        { id: "open", label: t("sidebar.menu.open"), onSelect: () => open(item) },
        { id: "rename", label: t("sidebar.menu.rename"), onSelect: () => setRenaming({ type: "conversation", id: item.open.id, text: item.title }) },
      ];
      if (item.open.general) {
        const targets: Array<{ id: ContextId; name: string }> = [{ id: null, name: t("sidebar.recent") }, ...projects.map((group) => ({ id: group.contextId, name: group.name }))];
        targets.filter((place) => place.id !== item.contextId).slice(0, 12).forEach((place, index) => {
          items.push({ id: `move-${index}`, label: t("sidebar.menu.moveTo", { name: place.name }), separatorBefore: index === 0, onSelect: () => void move(item, place.id) });
        });
      }
      items.push({ id: "delete", label: t("sidebar.menu.delete"), danger: true, separatorBefore: true, onSelect: () => setAsking(item) });
      return items;
    }
    const items: ContextItem[] = [
      { id: "open", label: t("sidebar.menu.openItem"), onSelect: () => open(item) },
      { id: "background", label: t("sidebar.menu.openBehind"), onSelect: () => open(item, { background: true }) },
    ];
    if (isObjectView(item.type as RailView)) {
      items.push({ id: "rename", label: t("sidebar.menu.rename"), separatorBefore: true, onSelect: () => setRenaming({ type: "object", id: item.open.id, objectKind: item.type as ObjectListKind, text: item.title }) });
      items.push({ id: "delete", label: t("sidebar.menu.deleteObject"), danger: true, onSelect: () => setAsking(item) });
    } else if (item.materialId && item.contextId) {
      items.push({ id: "remove", label: t("sidebar.menu.removeFromProject"), separatorBefore: true, onSelect: () => void removeFromProject(item) });
    }
    return items;
  }

  const onMenu = (event: ReactMouseEvent, target: Target) => { event.preventDefault(); setTip(null); setMenu({ x: event.clientX, y: event.clientY, target }); };
  const closeMenu = useCallback(() => setMenu(null), []);

  // ------------------------------------------------------------------------------------------------------------------- the info card
  const tipOn = (item: SidebarItem, element: HTMLElement) => {
    window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => {
      const rect = element.getBoundingClientRect();
      const left = rect.right + 8 + 280 > window.innerWidth ? Math.max(8, rect.left - 288) : rect.right + 8;
      setTip({ item, left, top: Math.max(8, Math.min(rect.top, window.innerHeight - 120)) });
    }, TIP_MS);
  };
  const tipOff = () => { window.clearTimeout(tipTimer.current); setTip(null); };

  // ------------------------------------------------------------------------------------------------------------------------ the rows
  function renderItem(item: SidebarItem) {
    const Icon = RAIL_ICON[(item.type === "download" ? "downloads" : item.type) as RailView];
    const isRenaming = renaming && ((renaming.type === "conversation" && item.type === "conversation") || (renaming.type === "object" && renaming.objectKind === item.type)) && renaming.id === item.open.id;
    return (
      <li key={item.key}>
        {isRenaming ? (
          <form className="sidebar-rename" onSubmit={(event) => void commitRename(event)}>
            <input autoFocus aria-label={t(item.type === "conversation" ? "sidebar.rename.conversation" : "objects.name")} data-testid="sidebar-rename" value={renaming.text} maxLength={200} onChange={(event) => setRenaming({ ...renaming, text: event.target.value })} onBlur={() => setRenaming(null)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setRenaming(null); } }} />
          </form>
        ) : (
          <button
            type="button"
            className="sidebar-row"
            data-testid={item.type === "conversation" ? `session-open-${item.open.id}` : `sidebar-item-${item.open.kind}-${item.open.id}`}
            data-opens
            data-active={item.running}
            data-type={item.type}
            onClick={() => open(item)}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); open(item, { background: true }); } }}
            onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
            onContextMenu={(event) => onMenu(event, { kind: "item", item })}
            onMouseEnter={(event) => tipOn(item, event.currentTarget)}
            onMouseLeave={tipOff}
            onFocus={tipOff}
          >
            <Icon size={14} aria-hidden="true" />
            <span className="truncate">{item.title}</span>
            {item.running ? <span className="tab-mark" data-mark="running" role="img" aria-label={t("tab.mark.running")} /> : null}
          </button>
        )}
      </li>
    );
  }

  function renderSection(group: SidebarGroup, section: SidebarSection) {
    const key = contextKey(group.contextId);
    const name = key || "recent";
    const added = more[sectionKey(view, group.contextId, section.type)];
    const shown = shownOf(section, added);
    const rest = section.total - shown.items.length;
    const typeId = section.type === "download" ? "downloads" : section.type;
    return (
      <div key={section.type} className="sidebar-section" data-testid={`sidebar-section-${name}-${section.type}`}>
        {own ? null : <h3 className="sidebar-type" data-testid={`sidebar-type-${name}-${section.type}`}>{t(VIEW_LABEL[typeId as RailView])}<span className="sidebar-type-count">{section.total}</span></h3>}
        {section.loaded && section.total === 0 ? <p className="sidebar-empty" data-testid={`sidebar-empty-${name}`}>{t(EMPTY_KEY[section.type])}</p> : null}
        {section.loaded ? (
          <ul className="sidebar-rows">
            {shown.items.map(renderItem)}
            {shown.next !== null && rest > 0 ? (
              <li>
                <button type="button" className="sidebar-more" data-testid={own ? `sidebar-more-${name}` : `sidebar-more-${name}-${section.type}`} onClick={() => void loadMore(group.contextId, section.type, shown.next)}>{t("sidebar.more", { n: rest })}</button>
              </li>
            ) : null}
          </ul>
        ) : <p className="sidebar-empty">{section.total} · {t("sidebar.loading")}</p>}
      </div>
    );
  }

  function renderGroup(group: SidebarGroup) {
    const key = contextKey(group.contextId);
    const opened = isOpen(key);
    const Chevron = opened ? ChevronDown : ChevronRight;
    const isCurrent = key === currentKey;
    const project = group.kind === "project";
    const name = key || "recent";
    const label = project ? group.name : t("sidebar.recent");
    return (
      <div key={name} className="sidebar-context" data-testid={`context-${name}`} data-current={isCurrent ? "true" : "false"}>
        <div className="sidebar-context-head" onContextMenu={project ? (event) => onMenu(event, { kind: "project", group }) : undefined}>
          <button type="button" className="sidebar-chevron" data-testid={`context-toggle-${name}`} aria-expanded={opened} aria-label={t(opened ? "sidebar.collapse" : "sidebar.expand", { name: label })} disabled={isCurrent} onClick={() => toggle(key)}><Chevron size={14} aria-hidden="true" /></button>
          {renaming?.type === "project" && renaming.id === group.contextId ? (
            <form className="sidebar-rename" onSubmit={(event) => void commitRename(event)}>
              <input autoFocus aria-label={t("sidebar.rename.project")} data-testid="sidebar-rename" value={renaming.text} maxLength={120} onChange={(event) => setRenaming({ ...renaming, text: event.target.value })} onBlur={() => setRenaming(null)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setRenaming(null); } }} />
            </form>
          ) : (
            <button type="button" className="sidebar-context-name" data-testid={`context-open-${name}`} aria-current={isCurrent ? "true" : undefined} title={label} onClick={() => { done(); void s.open.switchContext(group.contextId); }}>
              {project ? <FolderKanban size={15} aria-hidden="true" /> : <Clock size={15} aria-hidden="true" />}
              <span className="truncate">{label}</span>
            </button>
          )}
        </div>
        {opened ? (
          group.sections.length === 0 ? <p className="sidebar-empty" data-testid={`sidebar-empty-${name}`}>{t("sidebar.empty.all")}</p> : group.sections.map((section) => renderSection(group, section))
        ) : null}
      </div>
    );
  }

  const recent = data?.groups.find((group) => group.kind === "recent");
  const body = (() => {
    if (!data) {
      return status === "error"
        ? <button type="button" className="sidebar-retry" data-testid="sidebar-retry" onClick={reload}>{t("sidebar.failed")}</button>
        : <p className="sidebar-empty" role="status" data-testid="sidebar-loading">{t("sidebar.loading")}</p>;
    }
    if (view === "downloads") {
      const downloads = data.downloads;
      const shown = downloads ? shownOf(downloads, more[sectionKey(view, null, "download")]) : { items: [], next: null };
      return (
        <section className="sidebar-group" data-testid="sidebar-downloads">
          {downloads && downloads.total === 0 ? <p className="sidebar-empty" data-testid="sidebar-empty-downloads">{t("sidebar.empty.download")}</p> : null}
          <ul className="sidebar-rows sidebar-rows-flat">
            {shown.items.map(renderItem)}
            {downloads && shown.next !== null && downloads.total > shown.items.length ? <li><button type="button" className="sidebar-more" data-testid="sidebar-more-downloads" onClick={() => void loadMore(null, "download", shown.next)}>{t("sidebar.more", { n: downloads.total - shown.items.length })}</button></li> : null}
          </ul>
        </section>
      );
    }
    return (
      <>
        {s.facets.has("projects") ? (
          <section className="sidebar-group" aria-label={t("sidebar.projects")} data-testid="sidebar-projects">
            <h2 className="sidebar-group-title">{t("sidebar.projects")}</h2>
            {projects.length === 0 ? <p className="sidebar-empty" data-testid="sidebar-no-projects">{t("sidebar.noProjects")}</p> : projects.map(renderGroup)}
          </section>
        ) : null}
        {recent ? (
          <section className="sidebar-group" aria-label={t("sidebar.recent")} data-testid="sidebar-recent">
            <h2 className="sidebar-group-title">{t("sidebar.recent")}</h2>
            {renderGroup(recent)}
          </section>
        ) : null}
      </>
    );
  })();

  const viewName = t(VIEW_LABEL[view]);
  return (
    <div className="sidebar" data-testid="sidebar" data-view={view} data-variant={props.variant} onScroll={tipOff}>
      <div className="sidebar-head">
        <h1 className="sidebar-title" data-testid="sidebar-title">{viewName}</h1>
        <span className="flex-1" />
        <button type="button" className="shell-icon" data-testid="sidebar-search" aria-label={t("sidebar.search")} title={t("sidebar.search")} onClick={() => { done(); s.open.search(undefined, view === "home" || view === "downloads" ? null : view); }}><Search size={17} aria-hidden="true" /></button>
      </div>
      {entries.length ? (
        <div className="sidebar-actions" data-testid="sidebar-entries">
          {entries.map((item) => <button key={item.id} type="button" className="sidebar-action" data-testid={item.testId} onClick={item.run}>{item.icon}{item.label}</button>)}
        </div>
      ) : null}
      <div className="sidebar-scroll" data-testid="sidebar-scroll" onScroll={tipOff}>{body}</div>
      {tip ? (
        <div className="sidebar-tip" role="tooltip" data-testid="sidebar-tip" style={{ left: tip.left, top: tip.top }}>
          <strong>{tip.item.title}</strong>
          {tip.item.detail && tip.item.type !== "download" ? <span>{tip.item.detail}</span> : null}
          {tip.item.type === "download" ? <span>{t("sidebar.card.download", { state: tip.item.detail ?? "" })}</span> : <span>{tip.item.contextId ? t("sidebar.card.project", { name: tip.item.contextName ?? "" }) : t("sidebar.card.recent")}</span>}
          {tip.item.updatedAt ? <span>{t("sidebar.card.updated", { time: s.i18n.formatDate(tip.item.updatedAt) })}</span> : null}
          {tip.item.running ? <span>{t("sidebar.card.running")}</span> : null}
        </div>
      ) : null}
      {menu ? <ContextMenu x={menu.x} y={menu.y} label={menu.target.kind === "project" ? menu.target.group.name : menu.target.item.title} items={menuItems(menu.target)} onClose={closeMenu} testId="sidebar-menu" /> : null}
      {chooser ? (
        <ContextMenu
          x={chooser.x}
          y={chooser.y}
          label={t("sidebar.newWhere")}
          items={projects.slice(0, 20).map((group, index) => ({ id: `project-${index}`, label: group.name, onSelect: () => { done(); void s.open.createObject(chooser.kind, group.contextId!); } }))}
          onClose={() => setChooser(null)}
          testId="sidebar-choose-project"
        />
      ) : null}
      {asking ? (
        <Modal
          variant="dialog"
          testId="sidebar-delete-confirm"
          title={asking.type === "conversation" ? t("records.conv.confirm.title", { count: 1 }) : t("sidebar.deleteObject.title", { name: asking.title })}
          closeLabel={t("common.close")}
          onClose={() => { if (!busy) setAsking(null); }}
          footer={(
            <>
              <button type="button" className="secondary-button" data-testid="sidebar-delete-cancel" disabled={busy} onClick={() => setAsking(null)}>{t("common.cancel")}</button>
              <button type="button" className="danger-button" data-testid="sidebar-delete-ok" disabled={busy} onClick={() => void remove()}>{busy ? t("records.conv.confirm.working") : asking.type === "conversation" ? t("records.conv.confirm.ok") : t("whiteboard.deleteDo")}</button>
            </>
          )}
        >
          {asking.type === "conversation" ? (
            <div className="delete-entry">
              <p><strong>{asking.title}</strong></p>
              <section><h3>{t("records.conv.confirm.removesTitle")}</h3><p>{t("records.conv.confirm.removes")}</p><p>{t("records.conv.confirm.usage")}</p></section>
              <section><h3>{t("records.conv.confirm.keepsTitle")}</h3><p>{t("records.conv.confirm.keeps")}</p></section>
              <p><strong>{t("records.conv.confirm.irreversible")}</strong></p>
            </div>
          ) : <p>{t(OBJECT_SPEC[asking.type as ObjectListKind].confirm, { name: asking.title })}</p>}
        </Modal>
      ) : null}
    </div>
  );
}
