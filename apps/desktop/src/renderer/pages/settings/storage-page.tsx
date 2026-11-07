import type { Translator } from "@manga/i18n";
import type { PackageFlow, PackageStrategy } from "../../hooks/use-package.ts";
import { InventoryPane } from "../inventory-pane.tsx";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];

function PackagePreviewPanel(props: { t: T; pkg: PackageFlow }) {
  const { t, pkg } = props;
  const preview = pkg.preview;
  if (!preview) return null;
  return (
    <section className="package-preview" data-testid="package-preview-panel" data-empty={preview.empty ? "true" : "false"}>
      <h4>{t("settings.packagePreview")}</h4>
      <p data-testid="package-summary">{t("settings.packageSummary", { works: preview.counts.works ?? 0, objects: preview.counts.objects ?? 0, attachments: preview.counts.attachments ?? 0 })}</p>
      <p>{preview.empty ? t("settings.packageEmpty") : t("settings.packageConflicts", { count: preview.conflicts.length })}</p>
      {preview.conflicts.length ? (
        <ul className="package-conflicts" data-testid="package-conflicts">
          {preview.conflicts.map((conflict) => (
            <li key={`${conflict.kind}-${conflict.id}`}>
              <span>{conflict.kind} · {conflict.label} · {conflict.reason}</span>
              <select
                aria-label={`${conflict.label} · ${t("package.decisions")}`}
                data-testid={`package-decision-${conflict.kind}-${conflict.id}`}
                value={pkg.decisions[`${conflict.kind}:${conflict.id}`] ?? ""}
                onChange={(event) => pkg.decide(conflict.kind, conflict.id, (event.target.value || null) as PackageStrategy | null)}
              >
                <option value="">{t("package.rowDefault")}</option>
                <option value="skip">{t("settings.strategySkip")}</option>
                <option value="replace">{t("settings.strategyReplace")}</option>
                <option value="duplicate">{t("settings.strategyDuplicate")}</option>
              </select>
            </li>
          ))}
        </ul>
      ) : null}
      {preview.missingAttachments.length ? <p data-testid="package-missing">{t("settings.packageMissing", { count: preview.missingAttachments.length })}</p> : null}
      <label className="msettings-field">
        <span>{t("settings.packageStrategy")}</span>
        <select data-testid="package-strategy" value={pkg.strategy} onChange={(event) => pkg.setStrategy(event.target.value as PackageStrategy)}>
          <option value="skip">{t("settings.strategySkip")}</option>
          <option value="replace">{t("settings.strategyReplace")}</option>
          <option value="duplicate">{t("settings.strategyDuplicate")}</option>
        </select>
      </label>
      <div className="msettings-actions">
        <button type="button" className="primary-button" data-testid="package-apply" onClick={() => void pkg.applyImport()}>{t("settings.packageApply")}</button>
        <button type="button" className="secondary-button" data-testid="package-cancel" onClick={pkg.cancel}>{t("settings.migrationCancel")}</button>
      </div>
    </section>
  );
}

/**
 * Storage and backup: what the library holds (the overview with its checks), and the data package that carries all of it to another
 * place. Covers go into a package by default, and a running export can be stopped.
 */
export function StoragePage(props: {
  i18n: Translator;
  inventory: Record<string, unknown> | null;
  pkg: PackageFlow;
  onScan: () => void;
  onCancelScan: () => void;
  onTranscribe: () => void;
  onReveal: (id: string) => void;
  onRepair: (id: string) => void;
  onOpenCategory: (category: "comic" | "video") => void;
}) {
  const { pkg } = props;
  const t = props.i18n.t;
  return (
    <SettingsPage id="storage" title={t("settings.page.storage")} hint={t("storage.hint")} wide>
      <SettingsSection title={t("storage.backup")} hint={t("storage.backupHint")} testId="storage-backup">
        <SettingsRow label={t("storage.includeCovers")} hint={t("storage.includeCoversHint")} htmlFor="package-covers">
          <input id="package-covers" type="checkbox" role="switch" data-testid="package-covers" checked={pkg.includeCovers} disabled={pkg.exporting} onChange={(event) => pkg.setIncludeCovers(event.target.checked)} />
        </SettingsRow>
        <SettingsRow label={t("storage.export")} hint={t("storage.exportHint")}>
          {pkg.exporting ? (
            <>
              <span role="status" className="detail-muted" data-testid="package-exporting">{t("storage.exporting")}</span>
              <button type="button" className="secondary-button" data-testid="package-export-cancel" onClick={() => void pkg.cancelExport()}>{t("storage.exportCancel")}</button>
            </>
          ) : (
            <button type="button" className="secondary-button" data-testid="package-export" onClick={() => void pkg.exportPackage()}>{t("settings.packageExport")}</button>
          )}
        </SettingsRow>
        <SettingsRow label={t("storage.import")} hint={t("storage.importHint")}>
          <button type="button" className="secondary-button" data-testid="package-preview" onClick={() => void pkg.previewPackage()}>{t("settings.packagePreview")}</button>
        </SettingsRow>
        <PackagePreviewPanel t={t} pkg={pkg} />
      </SettingsSection>
      <SettingsSection title={t("storage.overview")} testId="storage-overview">
        <InventoryPane
          i18n={props.i18n}
          inventory={props.inventory}
          onScan={props.onScan}
          onCancel={props.onCancelScan}
          onTranscribe={props.onTranscribe}
          onReveal={props.onReveal}
          onRepair={props.onRepair}
          onOpenCategory={props.onOpenCategory}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
