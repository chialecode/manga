import { useId, useState } from "react";
import {
  Bot, Boxes, Cpu, Gauge, HardDrive, Keyboard, Library, MessageSquareText, Mic, Palette, Puzzle, ScrollText, Search, SlidersHorizontal, Sparkles, X, Zap, BookOpen, Globe,
  type LucideIcon,
} from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { SETTINGS_GROUPS, type SettingsPageId } from "../../lib/shell-model.ts";

/** The picture at the head of each page of the directory (交互设计 2.12). */
export const SETTINGS_ICON: Record<SettingsPageId, LucideIcon> = {
  general: SlidersHorizontal,
  appearance: Palette,
  reading: BookOpen,
  recording: Mic,
  library: Library,
  semantic: Sparkles,
  sources: Globe,
  danmaku: MessageSquareText,
  storage: HardDrive,
  plugins: Puzzle,
  modules: Boxes,
  shortcuts: Keyboard,
  models: Cpu,
  agent: Bot,
  quick: Zap,
  usage: Gauge,
  logs: ScrollText,
};

/** Whether a page answers to the text: its name, or one of its keywords (`settings.kw.<page>`), in any case. */
export function pageMatches(t: Translator["t"], page: SettingsPageId, text: string): boolean {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return true;
  const words = `${t(`settings.page.${page}` as MessageKey)} ${t(`settings.kw.${page}` as MessageKey)}`.toLowerCase();
  return wanted.split(/\s+/).every((part) => words.includes(part));
}

/**
 * The settings directory (交互设计 2.12): it takes the place of the sidebar while the settings are on. The head is "设置" and a filter box that narrows the pages
 * by name and keyword; the pages follow in their groups, each with its picture and its name, the current one marked. A page that depends on a module that is
 * turned off is not listed. In a window too narrow for the sidebar it is the card the sidebar's switch opens, and `onDone` closes it.
 */
export function SettingsNav(props: {
  t: Translator["t"];
  page: SettingsPageId;
  hidden?: ReadonlySet<SettingsPageId>;
  variant?: "dock" | "card";
  onPage: (page: SettingsPageId) => void;
  onDone?: () => void;
}) {
  const { t } = props;
  const [filter, setFilter] = useState("");
  const filterId = useId();
  const groups = SETTINGS_GROUPS
    .map((group) => ({ id: group.id, pages: group.pages.filter((page) => !props.hidden?.has(page) && pageMatches(t, page, filter)) }))
    .filter((group) => group.pages.length > 0);
  return (
    <nav className="sidebar settings-nav" aria-label={t("settings.nav")} data-testid="settings-nav" data-variant={props.variant ?? "dock"}>
      <div className="sidebar-head">
        <h1 className="sidebar-title" data-testid="settings-title">{t("settings.title")}</h1>
      </div>
      <div className="settings-filter">
        <Search size={15} aria-hidden="true" />
        <input
          id={filterId}
          type="search"
          data-testid="settings-filter"
          aria-label={t("settings.filter")}
          placeholder={t("settings.filter")}
          value={filter}
          maxLength={64}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.preventDefault(); event.stopPropagation(); setFilter(""); } }}
        />
        {filter ? <button type="button" className="settings-filter-clear" data-testid="settings-filter-clear" aria-label={t("settings.filter.clear")} onClick={() => setFilter("")}><X size={14} aria-hidden="true" /></button> : null}
      </div>
      <div className="sidebar-scroll">
        {groups.length === 0 ? <p className="sidebar-empty" role="status" data-testid="settings-filter-none">{t("settings.filter.none")}</p> : null}
        {groups.map((group) => (
          <section key={group.id} className="settings-nav-group sidebar-group" data-testid={`settings-group-${group.id}`}>
            <h2 className="sidebar-group-title">{t(`settings.group.${group.id}` as MessageKey)}</h2>
            <ul className="settings-nav-list">
              {group.pages.map((page) => {
                const Icon = SETTINGS_ICON[page];
                return (
                  <li key={page}>
                    <button
                      type="button"
                      className="settings-nav-item"
                      data-testid={`settings-nav-${page}`}
                      aria-current={props.page === page ? "page" : undefined}
                      onClick={() => { props.onPage(page); props.onDone?.(); }}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span className="truncate">{t(`settings.page.${page}` as MessageKey)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}
