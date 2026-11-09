import type { Translator } from "@manga/i18n";
import type { HostState } from "../../lib/api.ts";
import type { UpdateHandle } from "../../hooks/use-update.ts";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

export function UpdatePage(props: {
  i18n: Translator;
  host: HostState;
  update: UpdateHandle;
}) {
  const { i18n, host, update } = props;
  const { t } = i18n;
  const status = update.status;
  const channel = status?.channel ?? host.buildInfo?.channel ?? host.layout.channel;
  const isRelease = channel === "release";
  const channelLabel = channel === "release"
    ? t("app.channel.release")
    : channel === "test"
      ? t("app.channel.test")
      : t("app.channel.development");

  const versionText = status?.version ?? host.buildInfo?.version ?? host.appVersion ?? "0.1.0";
  const commitText = status?.commit ?? host.buildInfo?.commit ?? "—";
  const builtAtRaw = status?.builtAt ?? host.buildInfo?.builtAt ?? "";
  const builtAtText = builtAtRaw ? i18n.formatDate(builtAtRaw) : "—";
  const lastCheckedText = status?.lastCheckedAt ? i18n.formatDate(status.lastCheckedAt) : t("update.neverChecked");

  const stateLabel = (() => {
    if (!isRelease) return t("update.state.unavailable");
    if (update.checking || status?.state === "checking") return t("update.state.checking");
    if (status?.state === "error") return status.error ?? t("status.error");
    if (status?.state === "ready") return t("update.state.ready", { version: status.availableVersion ?? "" });
    if (status?.state === "downloading") return t("update.state.downloading", { version: status.availableVersion ?? "" });
    if (status?.availableVersion) return t("update.state.available", { version: status.availableVersion });
    return t("update.state.idle");
  })();

  const autoCheck = status?.settings.autoCheck ?? true;
  const autoDownload = status?.settings.autoDownload ?? true;

  return (
    <SettingsPage id="update" title={t("settings.page.update")} hint={t("update.hint")}>
      <SettingsSection title={t("update.section.version")} testId="update-version-section">
        <SettingsRow label={t("update.currentVersion")}>
          <span data-testid="update-current-version">{versionText}</span>
        </SettingsRow>
        <SettingsRow label={t("update.currentChannel")}>
          <span data-testid="update-current-channel">{channelLabel}</span>
        </SettingsRow>
        <SettingsRow label={t("update.currentCommit")}>
          <span data-testid="update-current-commit">{commitText}</span>
        </SettingsRow>
        <SettingsRow label={t("update.builtAt")}>
          <span data-testid="update-built-at">{builtAtText}</span>
        </SettingsRow>
        <SettingsRow label={t("update.lastChecked")}>
          <span data-testid="update-last-checked">{lastCheckedText}</span>
        </SettingsRow>
        <SettingsRow label={t("update.state")}>
          <span
            data-testid="update-state-label"
            role="status"
            className={status?.state === "error" ? "review-error" : undefined}
          >
            {stateLabel}
          </span>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("update.section.policy")} testId="update-policy-section">
        {!isRelease ? (
          <p className="detail-muted settings-empty" data-testid="update-dev-mode">
            {t("update.devMode")}
          </p>
        ) : (
          <>
            <SettingsRow label={t("update.autoCheck")} hint={t("update.autoCheckHint")} htmlFor="update-auto-check">
              <input
                id="update-auto-check"
                type="checkbox"
                data-testid="update-auto-check"
                checked={autoCheck}
                onChange={(event) => void update.setSettings({ autoCheck: event.target.checked })}
              />
            </SettingsRow>
            <SettingsRow label={t("update.autoDownload")} hint={t("update.autoDownloadHint")} htmlFor="update-auto-download">
              <input
                id="update-auto-download"
                type="checkbox"
                data-testid="update-auto-download"
                checked={autoDownload}
                onChange={(event) => void update.setSettings({ autoDownload: event.target.checked })}
              />
            </SettingsRow>
            {status?.skippedVersion ? (
              <SettingsRow label={t("update.skipped", { version: status.skippedVersion })} hint={t("update.skippedHint")}>
                <button type="button" className="secondary-button" data-testid="update-unskip" onClick={() => void update.unskip()}>
                  {t("update.unskip")}
                </button>
              </SettingsRow>
            ) : null}
            <div className="settings-row">
              <div className="msettings-actions">
                <button
                  type="button"
                  className="secondary-button"
                  data-testid="update-check-now"
                  disabled={update.checking || status?.state === "checking" || status?.state === "downloading"}
                  onClick={() => void update.check()}
                >
                  {update.checking || status?.state === "checking" ? t("update.checkingNow") : t("update.checkNow")}
                </button>
                {status?.state === "idle" && status.availableVersion ? (
                  <button
                    type="button"
                    className="primary-button"
                    data-testid="update-download-now"
                    disabled={update.checking}
                    onClick={() => void update.check({ download: true })}
                  >
                    {t("update.downloadNow")}
                  </button>
                ) : null}
                {status?.state === "ready" ? (
                  <button
                    type="button"
                    className="primary-button"
                    data-testid="update-page-restart"
                    onClick={() => void update.requestRestart()}
                  >
                    {t("update.restart")}
                  </button>
                ) : null}
              </div>
            </div>
            {status?.state === "ready" ? (
              <div className="settings-row settings-row-stacked text-sm" data-testid="update-page-notes">
                <div>
                  <h4 className="settings-row-name font-medium">{t("update.notes")}</h4>
                  {status.willUpgradeSchema ? (
                    <p className="font-medium mt-1" data-testid="update-schema-notice">
                      {t("update.schemaNotice")}
                    </p>
                  ) : null}
                  <p className="detail-muted mt-1 whitespace-pre-wrap">
                    {status.releaseNotes || t("update.notesEmpty")}
                  </p>
                </div>
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
