import type { ReadingStylePatch, ShellPreference, WorkMode } from "@manga/contracts/reading";
import type { Translator } from "@manga/i18n";
import type { HostState } from "../../lib/api.ts";
import type { ConnectionForm } from "../../lib/types.ts";
import type { SettingsPageId } from "../../lib/shell-model.ts";
import type { PackageFlow } from "../../hooks/use-package.ts";
import type { ScanState } from "../../hooks/use-scan.ts";
import type { ComicSettings } from "../../readers/comic-reader.tsx";
import type { VideoSettings } from "../../readers/video-player.tsx";
import type { RecordingSettings } from "../../voice/use-recorder.ts";
import { MediaPrefs, Modules, Providers, Recording, keyLabel } from "../settings-media.tsx";
import { GeneralPage, type MigrationPlan } from "./general-page.tsx";
import { LibraryPage } from "./library-page.tsx";
import { LogsPage } from "./logs-page.tsx";
import { ModelsPage } from "./models-page.tsx";
import { QuickTasksPage } from "./quick-tasks-page.tsx";
import { RecordsPage } from "./records-page.tsx";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";
import { StoragePage } from "./storage-page.tsx";
import { UsagePage } from "./usage-page.tsx";

/** Pages whose module is turned off are left out of the navigation; the rest are always reachable. */
export function hiddenSettingsPages(facets: ReadonlySet<string>): Set<SettingsPageId> {
  const hidden = new Set<SettingsPageId>();
  if (!facets.has("voice")) hidden.add("recording");
  if (!facets.has("metadata")) hidden.add("sources");
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
  mode: WorkMode;
  onMode: (mode: WorkMode) => void;
  onReading: (patch: ReadingStylePatch) => void;
  recording: { settings: RecordingSettings; save: (patch: Partial<RecordingSettings>) => Promise<void> };
  comic: { settings: ComicSettings; change: (patch: Partial<ComicSettings>) => void };
  video: { settings: VideoSettings; change: (patch: Partial<VideoSettings>) => void };
  onGoto: (page: SettingsPageId) => void;
  onImport: () => void;
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
    onSaveConnection: (fields: ConnectionForm) => Promise<void>;
    onDeleteConnection: (id: string) => Promise<void>;
    onTestConnection: (id: string, capability: string) => Promise<void>;
    onSkip: () => void;
  };
  storage: {
    onScan: () => void;
    onCancelScan: () => void;
    onTranscribe: () => void;
    onReveal: (id: string) => void;
    onRepair: (id: string) => void;
    onOpenCategory: (category: "comic" | "video") => void;
  };
  records: {
    workId?: string | null;
    onOpenNote: (objectId: string) => void;
    onOpenNoteSource: (objectId: string) => void;
    onOpenRecording: (sessionId: string, workId: string | null) => void;
  };
};

/** The shortcuts the readers answer to (Q-13 defaults), listed so they can be found without trying keys. */
const SHORTCUTS: ReadonlyArray<{ group: "comic" | "video" | "global"; keys: string; action: string }> = [
  { group: "comic", keys: "← → / PageUp PageDown", action: "shortcuts.comicTurn" },
  { group: "comic", keys: "Home / End", action: "shortcuts.comicEnds" },
  { group: "comic", keys: "Ctrl + 滚轮 / + − 0", action: "shortcuts.comicZoom" },
  { group: "comic", keys: "F", action: "shortcuts.fullscreen" },
  { group: "video", keys: "Space / K", action: "shortcuts.videoToggle" },
  { group: "video", keys: "← →", action: "shortcuts.videoSeek" },
  { group: "video", keys: "↑ ↓", action: "shortcuts.videoVolume" },
  { group: "video", keys: ", .", action: "shortcuts.videoFrame" },
  { group: "video", keys: "[ ]", action: "shortcuts.videoRate" },
  { group: "video", keys: "I / O", action: "shortcuts.videoMark" },
  { group: "video", keys: "M / F", action: "shortcuts.videoMuteFull" },
  { group: "global", keys: "Ctrl + Shift + D", action: "shortcuts.debug" },
  { group: "global", keys: "Esc", action: "shortcuts.escape" },
];

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
              <SettingsRow label={t("appearance.mode")} hint={t("appearance.modeHint")} htmlFor="appearance-mode">
                <select id="appearance-mode" data-testid="appearance-mode" value={props.mode} onChange={(event) => props.onMode(event.target.value as WorkMode)}>
                  <option value="enthusiast">{t("mode.enthusiast")}</option>
                  <option value="creator">{t("mode.creator")}</option>
                </select>
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
        return (
          <SettingsPage id="recording" title={t("settings.page.recording")}>
            <Recording t={t} settings={props.recording.settings} save={props.recording.save} onNotice={props.onNotice} />
          </SettingsPage>
        );
      case "library":
        return <LibraryPage t={t} scan={props.scan} formatDate={i18n.formatDate} onImport={props.onImport} onChanged={props.onChanged} onError={props.onError} onNotice={props.onNotice} />;
      case "sources":
        return (
          <SettingsPage id="sources" title={t("settings.page.sources")}>
            <Providers t={t} onError={props.onError} onNotice={props.onNotice} />
          </SettingsPage>
        );
      case "storage":
        return <StoragePage i18n={i18n} inventory={props.inventory} pkg={props.pkg} {...props.storage} />;
      case "modules":
        return (
          <SettingsPage id="modules" title={t("settings.page.modules")}>
            <Modules t={t} onChanged={props.onModulesChanged} />
          </SettingsPage>
        );
      case "shortcuts":
        return (
          <SettingsPage id="shortcuts" title={t("settings.page.shortcuts")} hint={t("shortcuts.hint")}>
            <SettingsSection title={t("shortcuts.recording")} testId="shortcuts-recording">
              <SettingsRow label={t("msettings.holdKey")}><kbd data-testid="shortcut-hold">{keyLabel(props.recording.settings.holdKey)}</kbd></SettingsRow>
              <SettingsRow label={t("msettings.toggleKey")}><kbd data-testid="shortcut-toggle">{keyLabel(props.recording.settings.toggleKey)}</kbd></SettingsRow>
              <SettingsRow label={t("shortcuts.recordingChange")}>
                <button type="button" className="link-button" data-testid="shortcuts-goto-recording" onClick={() => props.onGoto("recording")}>{t("settings.page.recording")}</button>
              </SettingsRow>
            </SettingsSection>
            {(["global", "comic", "video"] as const).map((group) => (
              <SettingsSection key={group} title={t(`shortcuts.group.${group}`)} testId={`shortcuts-${group}`}>
                {SHORTCUTS.filter((item) => item.group === group).map((item) => (
                  <SettingsRow key={item.action} label={t(item.action as "shortcuts.debug")}><kbd>{item.keys}</kbd></SettingsRow>
                ))}
              </SettingsSection>
            ))}
          </SettingsPage>
        );
      case "models":
        return <ModelsPage i18n={i18n} settings={props.settings} {...props.models} />;
      case "quick":
        return <QuickTasksPage t={t} onChanged={props.onChanged} onError={props.onError} onNotice={props.onNotice} />;
      case "usage":
        return <UsagePage t={t} formatDate={i18n.formatDate} formatNumber={i18n.formatNumber} onError={props.onError} />;
      case "records":
        return <RecordsPage t={t} formatDate={i18n.formatDate} initialWorkId={props.records.workId ?? null} onOpenNote={props.records.onOpenNote} onOpenNoteSource={props.records.onOpenNoteSource} onOpenRecording={props.records.onOpenRecording} onError={props.onError} onNotice={props.onNotice} />;
      case "logs":
        return <LogsPage t={t} formatDate={i18n.formatDate} onError={props.onError} />;
    }
  })();
  return <div className="settings-view" data-testid="page-settings" data-settings-page={props.page}>{body}</div>;
}
