import type { ReadingStylePatch, ShellPreference } from "@manga/contracts/reading";
import type { Translator } from "@manga/i18n";
import type { HostState } from "../../lib/api.ts";
import type { ConnectionForm } from "../../lib/types.ts";
import type { SettingsPageId } from "../../lib/shell-model.ts";
import type { PackageFlow } from "../../hooks/use-package.ts";
import type { ScanState } from "../../hooks/use-scan.ts";
import type { ComicSettings } from "../../readers/comic-reader.tsx";
import type { VideoSettings } from "../../readers/video-player.tsx";
import type { useKeyBindings } from "../../hooks/use-key-bindings.ts";
import type { RecordingPatch, RecordingSettings } from "../../voice/use-recorder.ts";
import { MediaPrefs, Modules, Providers } from "../settings-media.tsx";
import { GeneralPage, type MigrationPlan } from "./general-page.tsx";
import { LibraryPage } from "./library-page.tsx";
import { LogsPage } from "./logs-page.tsx";
import { AgentPage } from "./agent-page.tsx";
import type { PlainTestResult, SaveConnectionResult } from "./connection-dialog.tsx";
import { ModelsPage } from "./models-page.tsx";
import { PluginsPage } from "./plugins-page.tsx";
import { QuickTasksPage } from "./quick-tasks-page.tsx";
import { SemanticPage } from "./semantic-page.tsx";
import { ShortcutsPage } from "./shortcuts-page.tsx";
import { DanmakuPage } from "./danmaku-page.tsx";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";
import { StoragePage } from "./storage-page.tsx";
import { UsagePage } from "./usage-page.tsx";
import { VoicePage } from "./voice-page.tsx";

/** Pages whose module is turned off are left out of the navigation; the rest are always reachable. */
export function hiddenSettingsPages(facets: ReadonlySet<string>): Set<SettingsPageId> {
  const hidden = new Set<SettingsPageId>();
  if (!facets.has("voice")) hidden.add("recording");
  if (!facets.has("metadata")) hidden.add("sources");
  if (!facets.has("danmaku")) hidden.add("danmaku");
  if (!facets.has("semantic")) hidden.add("semantic");
  if (!facets.has("plugins")) hidden.add("plugins");
  if (!facets.has("agent")) { hidden.add("models"); hidden.add("quick"); hidden.add("usage"); }
  return hidden;
}

export type SettingsViewProps = {
  i18n: Translator;
  page: SettingsPageId;
  host: HostState;
  settings: Record<string, unknown> | null;
  facets: Set<string>;
  scan: ScanState;
  pkg: PackageFlow;
  inventory: Record<string, unknown> | null;
  migration: MigrationPlan | null;
  shell: ShellPreference;
  onReading: (patch: ReadingStylePatch) => void;
  recording: { settings: RecordingSettings; save: (patch: RecordingPatch) => Promise<void> };
  comic: { settings: ComicSettings; change: (patch: Partial<ComicSettings>) => void };
  video: { settings: VideoSettings; change: (patch: Partial<VideoSettings>) => void };
  /** The reader keys: the table in use, the person's changes, and a way to save them. */
  keys: ReturnType<typeof useKeyBindings>;
  onGoto: (page: SettingsPageId) => void;
  onModulesChanged: () => Promise<void> | void;
  /** Something other pages show has changed: quick tasks, library paths, notes. */
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  general: {
    onChooseLocation: () => void;
    onPointerLocation: () => void;
    onIndexedRoot: () => void;
    onApplyMigration: () => void;
    onCancelMigration: () => void;
    onRollbackRecovery: () => void;
    onRecoverJobs: () => void;
  };
  models: {
    onRuntime: (runtime: string) => Promise<void>;
    onSaveConnection: (fields: ConnectionForm) => Promise<SaveConnectionResult>;
    onDeleteConnection: (id: string) => Promise<void>;
    onTestConnection: (id: string, capability: string) => Promise<PlainTestResult>;
    onProbeConnection: (id: string) => Promise<void>;
    onSkip: () => void;
  };
  storage: {
    onScan: () => void;
    onCancelScan: () => void;
    onReveal: (id: string) => void;
    onRepair: (id: string) => void;
    onOpenCategory: (category: "comic" | "video") => void;
  };
};

/**
 * The settings page the navigation names. Every page is its own component; this only picks one. Pages that hold unsaved input
 * unmount with it, so the ones with forms (connections, quick tasks) save on their own buttons and never hold a half-saved state.
 */
export function SettingsView(props: SettingsViewProps) {
  const { i18n } = props;
  const t = i18n.t;
  const body = (() => {
    switch (props.page) {
      case "general":
        return <GeneralPage i18n={i18n} host={props.host} settings={props.settings} migration={props.migration} onGoto={props.onGoto} {...props.general} />;
      case "appearance":
        return (
          <SettingsPage id="appearance" title={t("settings.page.appearance")}>
            <SettingsSection testId="appearance-rows">
              <SettingsRow label={t("appearance.theme")} hint={t("appearance.themeHint")} htmlFor="appearance-theme">
                <select id="appearance-theme" data-testid="appearance-theme" value="light" disabled><option value="light">{t("appearance.themeLight")}</option></select>
              </SettingsRow>
            </SettingsSection>
          </SettingsPage>
        );
      case "reading":
        return (
          <SettingsPage id="reading" title={t("settings.page.reading")} hint={t("reading.pageHint")}>
            <MediaPrefs t={t} facets={props.facets} reading={props.shell.reading} onReading={props.onReading} comic={props.comic.settings} onComic={props.comic.change} video={props.video.settings} onVideo={props.video.change} />
          </SettingsPage>
        );
      case "recording":
        return <VoicePage t={t} settings={props.settings} recording={props.recording} onGoto={props.onGoto} onError={props.onError} onNotice={props.onNotice} />;
      case "library":
        return <LibraryPage t={t} scan={props.scan} formatDate={i18n.formatDate} onChanged={props.onChanged} onError={props.onError} onNotice={props.onNotice} />;
      case "semantic":
        return <SemanticPage t={t} formatDate={i18n.formatDate} formatNumber={i18n.formatNumber} onGoto={props.onGoto} onError={props.onError} onNotice={props.onNotice} />;
      case "plugins":
        return <PluginsPage t={t} formatDate={i18n.formatDate} onModulesChanged={props.onModulesChanged} onError={props.onError} onNotice={props.onNotice} />;
      case "sources":
        return (
          <SettingsPage id="sources" title={t("settings.page.sources")}>
            <Providers t={t} onError={props.onError} onNotice={props.onNotice} />
          </SettingsPage>
        );
      case "danmaku":
        return <DanmakuPage t={t} moduleOn={props.facets.has("danmaku")} onError={props.onError} onNotice={props.onNotice} />;
      case "storage":
        return <StoragePage i18n={i18n} inventory={props.inventory} pkg={props.pkg} {...props.storage} />;
      case "modules":
        return (
          <SettingsPage id="modules" title={t("settings.page.modules")}>
            <Modules t={t} onChanged={props.onModulesChanged} />
          </SettingsPage>
        );
      case "shortcuts":
        return <ShortcutsPage t={t} keys={props.keys} recording={props.recording.settings} onGoto={() => props.onGoto("recording")} />;
      case "models":
        return <ModelsPage i18n={i18n} settings={props.settings} {...props.models} />;
      case "agent":
        return <AgentPage t={t} onError={props.onError} onNotice={props.onNotice} />;
      case "quick":
        return <QuickTasksPage t={t} onChanged={props.onChanged} onError={props.onError} onNotice={props.onNotice} />;
      case "usage":
        return <UsagePage t={t} formatDate={i18n.formatDate} formatNumber={i18n.formatNumber} onError={props.onError} onNotice={props.onNotice} />;
      case "logs":
        return <LogsPage t={t} formatDate={i18n.formatDate} onError={props.onError} />;
    }
  })();
  return <div className="settings-view" data-testid="page-settings" data-settings-page={props.page}>{body}</div>;
}
