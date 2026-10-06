import { ArrowLeft } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { SETTINGS_GROUPS, type SettingsPageId } from "../../lib/shell-model.ts";

/**
 * The left column while settings is open (交互设计 3.5): "back" first, then the pages in their groups. A page that depends on a
 * module that is turned off is not listed; the rest are always reachable.
 */
export function SettingsNav(props: {
  t: Translator["t"];
  page: SettingsPageId;
  hidden?: ReadonlySet<SettingsPageId>;
  onPage: (page: SettingsPageId) => void;
  onBack: () => void;
}) {
  const { t } = props;
  return (
    <nav className="settings-nav" aria-label={t("settings.nav")} data-testid="settings-nav">
      <button type="button" className="settings-back" data-testid="settings-back" onClick={props.onBack}><ArrowLeft size={17} aria-hidden="true" /><span>{t("settings.back")}</span></button>
      {SETTINGS_GROUPS.map((group) => {
        const pages = group.pages.filter((page) => !props.hidden?.has(page));
        if (!pages.length) return null;
        return (
          <div key={group.id} className="settings-nav-group" data-testid={`settings-group-${group.id}`}>
            <h2 className="settings-nav-title">{t(`settings.group.${group.id}`)}</h2>
            <ul>
              {pages.map((page) => (
                <li key={page}>
                  <button type="button" data-testid={`settings-nav-${page}`} aria-current={props.page === page ? "page" : undefined} onClick={() => props.onPage(page)}>{t(`settings.page.${page}`)}</button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
