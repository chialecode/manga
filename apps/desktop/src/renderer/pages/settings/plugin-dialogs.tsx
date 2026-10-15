import { useState } from "react";
import type { MessageKey, Translator } from "@manga/i18n";
import { Modal } from "../../components/modal.tsx";
import { PLUGIN_PERMISSIONS, type PluginInspectionView, type PluginPermission, type PluginView, type TrustedKeyView } from "../../lib/plugin-model.ts";

type T = Translator["t"];

/** The words for one permission: what it is called and what it lets the plugin do. */
export function PermissionName(props: { t: T; permission: PluginPermission }) {
  return <>{props.t(`plugins.permission.${props.permission}` as MessageKey)}</>;
}

/**
 * What a package is, who signed it and what it asks for, read from the file without changing anything, and the confirmation the install
 * needs: every permission it declares is ticked by the person, and a permission an upgrade adds is marked as new. A package that would be
 * refused says why and cannot be installed.
 */
export function InstallDialog(props: {
  t: T;
  inspection: PluginInspectionView;
  busy: boolean;
  onCancel: () => void;
  onInstall: (grant: PluginPermission[], enable: boolean) => void;
}) {
  const { t, inspection } = props;
  const wanted = inspection.manifest.permissions;
  const [confirmed, setConfirmed] = useState<Set<PluginPermission>>(new Set());
  const [enable, setEnable] = useState(true);
  const refused = inspection.refusal;
  const upgrade = inspection.action === "upgrade";
  const complete = wanted.every((permission) => confirmed.has(permission));
  const refusalText = refused ? t(`plugins.reason.${refused.reason}` as MessageKey) : null;
  const untrustedProgram = refused?.reason === "untrusted" && inspection.executable;

  const toggle = (permission: PluginPermission, on: boolean) => setConfirmed((current) => { const next = new Set(current); if (on) next.add(permission); else next.delete(permission); return next; });

  return (
    <Modal testId="plugin-install" title={t(upgrade ? "plugins.dialog.upgrade" : "plugins.dialog.install")} closeLabel={t("common.close")} onClose={props.onCancel}
      footer={<>
        <button type="button" className="secondary-button" data-testid="plugin-install-cancel" onClick={props.onCancel}>{t("plugins.cancel")}</button>
        <button type="button" className="primary-button" data-testid="plugin-install-do" disabled={props.busy || Boolean(refused) || !complete} onClick={() => props.onInstall(wanted.filter((permission) => confirmed.has(permission)), enable)}>
          {t(upgrade ? "plugins.dialog.doUpgrade" : "plugins.dialog.doInstall")}
        </button>
      </>}>
      <div className="plugin-dialog" data-testid="plugin-install-body" data-action={inspection.action} data-trust={inspection.trust}>
        <h4 data-testid="plugin-install-name">{t("plugins.dialog.what", { name: inspection.manifest.name, version: inspection.manifest.version })}</h4>
        {inspection.manifest.description ? <p className="detail-muted">{inspection.manifest.description}</p> : null}
        <p data-testid="plugin-install-publisher">{t("plugins.dialog.publisher", { name: inspection.manifest.publisher.name, id: inspection.manifest.publisher.id })}</p>
        <p className="plugin-trust-line" data-testid="plugin-install-trust">
          <span className={`chip${inspection.trust === "unknown" ? " chip-warn" : ""}`}>{t(`plugins.trust.${inspection.trust}` as MessageKey)}</span>
          <span className="detail-muted">{t("plugins.dialog.signedBy", { keyId: inspection.keyId })}</span>
        </p>
        {inspection.fingerprint ? <p className="detail-muted plugin-fingerprint" data-testid="plugin-install-fingerprint">{t("plugins.dialog.fingerprint", { fingerprint: inspection.fingerprint })}</p> : null}
        <p className="detail-muted">{t(inspection.executable ? "plugins.runs" : "plugins.declaresOnly")}</p>
        {upgrade && inspection.installedVersion ? <p data-testid="plugin-install-from">{t("plugins.dialog.fromVersion", { version: inspection.installedVersion, next: inspection.manifest.version })}</p> : <p className="detail-muted">{t("plugins.dialog.fresh")}</p>}

        {refused ? (
          <div className="draft-warn" role="alert" data-testid="plugin-install-refused" data-reason={refused.reason}>
            <p className="draft-warn-text">{t("plugins.dialog.refused", { reason: refusalText ?? refused.message })}</p>
            {untrustedProgram ? <p className="detail-muted">{t("plugins.dialog.executableUntrusted")}</p> : null}
          </div>
        ) : (
          <>
            <h5>{t("plugins.dialog.confirmTitle")}</h5>
            {wanted.length === 0 ? <p className="detail-muted" data-testid="plugin-install-nopermissions">{t("plugins.dialog.confirmNone")}</p> : (
              <ul className="plugin-permissions" data-testid="plugin-install-permissions">
                {PLUGIN_PERMISSIONS.filter((permission) => wanted.includes(permission)).map((permission) => {
                  const added = upgrade && inspection.newPermissions.includes(permission);
                  return (
                    <li key={permission} data-permission={permission} data-new={added ? "yes" : "no"}>
                      <label>
                        <input type="checkbox" data-testid={`plugin-confirm-${permission}`} checked={confirmed.has(permission)} onChange={(event) => toggle(permission, event.target.checked)} />
                        <span>{t("plugins.dialog.confirm", { permission: t(`plugins.permission.${permission}` as MessageKey) })}</span>
                        {added ? <span className="chip chip-warn">{t("plugins.dialog.newPermission")}</span> : null}
                      </label>
                      <span className="detail-muted">{t(`plugins.permission.${permission}Hint` as MessageKey)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {inspection.manifest.facets.includes("acquisition") ? <p className="detail-muted">{t("plugins.opens.acquisition")}</p> : null}
            <label className="plugin-enable-after">
              <input type="checkbox" data-testid="plugin-install-enable" checked={enable} onChange={(event) => setEnable(event.target.checked)} />
              <span>{t("plugins.dialog.enableAfter")}</span>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Uninstalling asks what happens to what the plugin kept: it stays by default, and it can be deleted with the plugin. */
export function UninstallDialog(props: { t: T; plugin: PluginView; busy: boolean; hasData: boolean; onCancel: () => void; onUninstall: (deleteData: boolean) => void }) {
  const { t, plugin } = props;
  const [drop, setDrop] = useState(false);
  return (
    <Modal testId="plugin-uninstall" title={t("plugins.dialog.uninstall", { name: plugin.name })} closeLabel={t("common.close")} onClose={props.onCancel}
      footer={<>
        <button type="button" className="secondary-button" data-testid="plugin-uninstall-cancel" onClick={props.onCancel}>{t("plugins.cancel")}</button>
        <button type="button" className="primary-button danger-button" data-testid="plugin-uninstall-do" disabled={props.busy} onClick={() => props.onUninstall(drop)}>{t("plugins.dialog.doUninstall")}</button>
      </>}>
      <p>{t("plugins.dialog.uninstallBody")}</p>
      {props.hasData ? (
        <fieldset className="plugin-data-choice" data-testid="plugin-uninstall-data">
          <label><input type="radio" name="plugin-data" data-testid="plugin-uninstall-keep" checked={!drop} onChange={() => setDrop(false)} /> <span>{t("plugins.dialog.keepData")}</span></label>
          <label><input type="radio" name="plugin-data" data-testid="plugin-uninstall-drop" checked={drop} onChange={() => setDrop(true)} /> <span>{t("plugins.dialog.dropData")}</span></label>
        </fieldset>
      ) : null}
    </Modal>
  );
}

/** Deleting what an uninstalled plugin left: not undoable, so it asks. */
export function DeleteDataDialog(props: { t: T; name: string; busy: boolean; onCancel: () => void; onDelete: () => void }) {
  const { t } = props;
  return (
    <Modal testId="plugin-delete-data" title={t("plugins.dialog.deleteDataTitle", { name: props.name })} closeLabel={t("common.close")} onClose={props.onCancel}
      footer={<>
        <button type="button" className="secondary-button" data-testid="plugin-delete-data-cancel" onClick={props.onCancel}>{t("plugins.cancel")}</button>
        <button type="button" className="primary-button danger-button" data-testid="plugin-delete-data-do" disabled={props.busy} onClick={props.onDelete}>{t("plugins.dialog.doDelete")}</button>
      </>}>
      <p>{t("plugins.dialog.deleteDataBody")}</p>
    </Modal>
  );
}

/** Trusting a publisher: the key they handed out, a name to recognise it by, and the fingerprint to compare once it is read. */
export function AddKeyDialog(props: { t: T; busy: boolean; onCancel: () => void; onAdd: (publicKey: string, label: string) => void }) {
  const { t } = props;
  const [publicKey, setPublicKey] = useState("");
  const [label, setLabel] = useState("");
  const ready = publicKey.trim().length >= 40 && label.trim().length > 0;
  return (
    <Modal testId="plugin-key-add" title={t("plugins.keys.dialog")} closeLabel={t("common.close")} onClose={props.onCancel}
      footer={<>
        <button type="button" className="secondary-button" data-testid="plugin-key-add-cancel" onClick={props.onCancel}>{t("plugins.cancel")}</button>
        <button type="button" className="primary-button" data-testid="plugin-key-add-do" disabled={props.busy || !ready} onClick={() => props.onAdd(publicKey.trim(), label.trim())}>{t("plugins.keys.doAdd")}</button>
      </>}>
      <p className="detail-muted">{t("plugins.keys.dialogBody")}</p>
      <label className="msettings-field"><span>{t("plugins.keys.label")}</span><input data-testid="plugin-key-label" autoFocus value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} /></label>
      <p className="detail-muted">{t("plugins.keys.labelHint")}</p>
      <label className="msettings-field msettings-field-stack"><span>{t("plugins.keys.publicKey")}</span><textarea data-testid="plugin-key-public" rows={3} spellCheck={false} value={publicKey} onChange={(event) => setPublicKey(event.target.value)} /></label>
    </Modal>
  );
}

/** Taking trust away from a publisher: what it signed stops at once. */
export function RemoveKeyDialog(props: { t: T; trusted: TrustedKeyView; busy: boolean; onCancel: () => void; onRemove: () => void }) {
  const { t } = props;
  return (
    <Modal testId="plugin-key-remove" title={t("plugins.keys.remove")} closeLabel={t("common.close")} onClose={props.onCancel}
      footer={<>
        <button type="button" className="secondary-button" data-testid="plugin-key-remove-cancel" onClick={props.onCancel}>{t("plugins.cancel")}</button>
        <button type="button" className="primary-button danger-button" data-testid="plugin-key-remove-do" disabled={props.busy} onClick={props.onRemove}>{t("plugins.keys.doRemove")}</button>
      </>}>
      <p>{t("plugins.keys.removeBody", { label: props.trusted.label })}</p>
      <p className="detail-muted">{t("plugins.keys.fingerprint", { fingerprint: props.trusted.fingerprint })}</p>
    </Modal>
  );
}
