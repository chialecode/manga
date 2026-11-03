import type { Translator } from "@manga/i18n";
import type { HostState } from "../../lib/api.ts";
import type { SettingsPageId } from "../../lib/shell-model.ts";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";
import { LocationGroups } from "./location-groups.tsx";
import { useState } from "react";

type Job = { id: string; kind: string; stage: string; status: string };
export type MigrationPlan = { handle: string; checkpointId: string; copies: Array<{ partition: string; bytes: number; target: string }> };

/**
 * General: where the data lives (and moving it, with the plan shown first), the jobs a crash left to recover, the language, and a pointer
 * to where start-up scanning is set. Moving data copies, then switches; nothing is deleted from the old place.
 */
export function GeneralPage(props: {
  i18n: Translator;
  host: HostState;
  settings: Record<string, unknown> | null;
  migration: MigrationPlan | null;
  onChooseLocation: () => void;
  onPointerLocation: () => void;
  onIndexedRoot: () => void;
  onApplyMigration: () => void;
  onCancelMigration: () => void;
  onRollbackRecovery: () => void;
  onRecoverJobs: () => void;
  /** Deletes the application data an upgrade left at the old place; resolves to an error message, or null. */
  onCleanLegacy?: () => Promise<string | null>;
  onGoto: (page: SettingsPageId) => void;
}) {
  const { i18n, host, migration } = props;
  const t = i18n.t;
  const jobs = (props.settings?.recoveryJobs as Job[] | undefined) ?? [];
  const legacy = props.settings?.legacyLocation as { root: string; bytes: number; cleaned: boolean } | null | undefined;
  const [confirming, setConfirming] = useState(false);
  const [cleanError, setCleanError] = useState("");
  return (
    <SettingsPage id="general" title={t("settings.page.general")}>
      <SettingsSection title={t("general.location")} hint={t("general.locationHint")} testId="general-location">
        <SettingsRow label={t("setup.channel")}><span data-testid="general-channel">{host.layout.channel}</span></SettingsRow>
        <SettingsRow label={t("setup.pointer")}><span className="settings-path" data-testid="general-pointer">{host.layout.pointerPath}</span></SettingsRow>
        <LocationGroups t={t} layout={host.layout} />
        {legacy && !legacy.cleaned ? (
          <SettingsRow label={t("general.legacy")} hint={t("general.legacyHint", { root: legacy.root, size: i18n.formatNumber(Math.round(legacy.bytes / 1024 / 1024)) })} testId="general-legacy">
            {confirming ? (
              <span className="settings-confirm" role="alertdialog" aria-label={t("general.legacyAsk")} data-testid="general-legacy-confirm">
                <span>{t("general.legacyAsk")}</span>
                <button type="button" className="danger-button" data-testid="general-legacy-clean-confirm" onClick={() => { setConfirming(false); void props.onCleanLegacy?.().then((error) => setCleanError(error ?? "")); }}>{t("general.legacyConfirm")}</button>
                <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>{t("chat.cancel")}</button>
              </span>
            ) : (
              <button type="button" className="secondary-button" data-testid="general-legacy-clean" onClick={() => setConfirming(true)}>{t("general.legacyClean")}</button>
            )}
            {cleanError ? <span className="review-error" role="alert">{cleanError}</span> : null}
          </SettingsRow>
        ) : null}
        <SettingsRow label={t("general.move")} hint={t("general.moveHint")}>
          <button type="button" className="secondary-button" data-testid="general-move" onClick={props.onChooseLocation}>{t("settings.chooseDirectory")}</button>
        </SettingsRow>
        <SettingsRow label={t("general.pointerChange")} hint={t("general.pointerHint")}>
          <button type="button" className="secondary-button" onClick={props.onPointerLocation}>{t("settings.choosePointer")}</button>
        </SettingsRow>
        <SettingsRow label={t("general.indexed")} hint={t("general.indexedHint")}>
          <button type="button" className="secondary-button" onClick={props.onIndexedRoot}>{t("settings.chooseIndexed")}</button>
        </SettingsRow>
        {migration ? (
          <section role="region" aria-label={t("settings.migrationPlan")} className="migration-plan" data-testid="migration-plan">
            <h4>{t("settings.migrationPlan")}</h4>
            <p>{t("settings.migrationSummary", { count: migration.copies.length, bytes: i18n.formatNumber(migration.copies.reduce((sum, copy) => sum + copy.bytes, 0)) })}</p>
            <ul className="detail-muted">
              {migration.copies.map((copy) => <li key={copy.partition}>{copy.partition} · {copy.target} · {t("library.bytes", { value: copy.bytes })}</li>)}
            </ul>
            <div className="msettings-actions">
              <button type="button" className="primary-button" onClick={props.onApplyMigration}>{t("settings.migrationApply")}</button>
              <button type="button" className="secondary-button" onClick={props.onCancelMigration}>{t("settings.migrationCancel")}</button>
            </div>
          </section>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("settings.recoveryJobs")} testId="general-recovery">
        {jobs.length === 0 ? <p className="detail-muted settings-empty">{t("settings.recoveryNone")}</p> : (
          <>
            <ul>
              {jobs.map((job) => <li key={job.id}>{job.kind} · {job.stage} · {job.status}</li>)}
            </ul>
            <div className="msettings-actions">
              <button type="button" className="secondary-button" onClick={props.onRecoverJobs}>{t("settings.recoveryResume")}</button>
              <button type="button" className="secondary-button" onClick={props.onRollbackRecovery}>{t("settings.recoveryRollback")}</button>
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection title={t("general.startup")} testId="general-startup">
        <SettingsRow label={t("general.startupScan")} hint={t("general.startupScanHint")}>
          <button type="button" className="link-button" data-testid="general-goto-library" onClick={() => props.onGoto("library")}>{t("settings.page.library")}</button>
        </SettingsRow>
        <SettingsRow label={t("general.language")} hint={t("general.languageHint")} htmlFor="general-language">
          <select id="general-language" data-testid="general-language" value={i18n.locale} disabled>
            <option value="zh-CN">{t("general.languageZh")}</option>
            <option value="qps-ploc">{t("general.languagePseudo")}</option>
          </select>
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
