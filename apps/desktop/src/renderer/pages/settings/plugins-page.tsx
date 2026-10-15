import { useCallback, useEffect, useRef, useState } from "react";
import { Download, PackagePlus, Puzzle } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { attempt, type CommandError } from "../../lib/api.ts";
import {
  bytesLabel, canEnable, pluginReasonKey,
  type BundledPluginView, type PluginInspectionView, type PluginLeftoverView, type PluginListView, type PluginPermission, type PluginView, type TrustedKeyView,
} from "../../lib/plugin-model.ts";
import { AddKeyDialog, DeleteDataDialog, InstallDialog, PermissionName, RemoveKeyDialog, UninstallDialog } from "./plugin-dialogs.tsx";
import { SettingsEmpty, SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];
type Source = { pathHandle: string } | { bundledId: string };
type Install = { source: Source; inspection: PluginInspectionView };

/**
 * The plugin page (PLUG-04): what is installed with who made it, which version, what it may do and whether it is running; installing from a file
 * or from what the application carries, after the signature is checked and the permissions are confirmed; upgrading, going back, turning off and
 * uninstalling; what an uninstalled plugin left; and the publishers whose signatures are trusted.
 */
export function PluginsPage(props: {
  t: T;
  formatDate: (value: string) => string;
  /** Called when what is installed or enabled changed, so the parts of the interface a plugin turns on follow. */
  onModulesChanged: () => Promise<void> | void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [list, setList] = useState<PluginListView | null>(null);
  const [bundled, setBundled] = useState<BundledPluginView[]>([]);
  const [keys, setKeys] = useState<TrustedKeyView[]>([]);
  const [busy, setBusy] = useState(false);
  const [install, setInstall] = useState<Install | null>(null);
  const [uninstall, setUninstall] = useState<PluginView | null>(null);
  const [dropData, setDropData] = useState<PluginLeftoverView | null>(null);
  const [addKey, setAddKey] = useState(false);
  const [removeKey, setRemoveKey] = useState<TrustedKeyView | null>(null);
  const alive = useRef(true);
  const latest = useRef(0);
  const changed = useRef(props.onModulesChanged);
  changed.current = props.onModulesChanged;
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    latest.current += 1;
    const mine = latest.current;
    const [plugins, offered, trusted] = await Promise.all([
      attempt<PluginListView>("plugin.list", {}),
      attempt<{ bundled: BundledPluginView[] }>("plugin.bundled", {}),
      attempt<{ keys: TrustedKeyView[] }>("plugin.trust.list", {}),
    ]);
    if (!alive.current || mine !== latest.current) return;
    if (!plugins.ok) { props.onError(plugins.error.message); return; }
    setList(plugins.value);
    if (offered.ok) setBundled(offered.value.bundled);
    if (trusted.ok) setKeys(trusted.value.keys);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const off = window.manga.onNotice?.((notice) => {
      if (notice.topic !== "plugin.changed") return;
      void load();
      void changed.current();
    });
    return () => { off?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const failure = (error: CommandError): string => {
    const key = pluginReasonKey(error);
    return key ? t(key) : error.message;
  };

  async function run<R>(commandId: string, input: Record<string, unknown>): Promise<{ ok: true; value: R } | { ok: false }> {
    if (busy) return { ok: false };
    setBusy(true);
    const result = await attempt<R>(commandId, input);
    if (!alive.current) return { ok: false };
    setBusy(false);
    if (!result.ok) { props.onError(failure(result.error)); await load(); return { ok: false }; }
    await load();
    await changed.current();
    return { ok: true, value: result.value };
  }

  async function chooseFile() {
    if (!window.manga.pick) { props.onError(t("plugins.unavailable")); return; }
    const picked = await window.manga.pick({ mode: "file", filter: "plugin" });
    if (!picked) return;
    await inspect({ pathHandle: picked.pathHandle });
  }

  async function inspect(source: Source) {
    setBusy(true);
    const result = await attempt<PluginInspectionView>("plugin.inspect", source);
    if (!alive.current) return;
    setBusy(false);
    if (!result.ok) { props.onError(failure(result.error)); return; }
    setInstall({ source, inspection: result.value });
  }

  async function doInstall(grant: PluginPermission[], enable: boolean) {
    if (!install) return;
    const upgrade = install.inspection.action === "upgrade";
    const name = install.inspection.manifest.name;
    const result = await run<{ enabled: boolean; error: string | null; rolledBack: boolean }>("plugin.install", { ...install.source, grant, enable });
    if (!result.ok) { setInstall(null); return; }
    setInstall(null);
    const value = result.value;
    if (value.rolledBack) props.onNotice(t("plugins.notice.rolledBack"));
    else if (value.error) props.onNotice(t("plugins.notice.installedFailed", { message: value.error }));
    else props.onNotice(t(upgrade ? "plugins.notice.upgraded" : value.enabled ? "plugins.notice.installedRunning" : "plugins.notice.installed", { name }));
  }

  async function toggle(plugin: PluginView) {
    const result = await run(plugin.enabled ? "plugin.disable" : "plugin.enable", { pluginId: plugin.id });
    if (result.ok) props.onNotice(t(plugin.enabled ? "plugins.notice.disabled" : "plugins.notice.enabled", { name: plugin.name }));
  }

  async function rollback(plugin: PluginView) {
    const result = await run("plugin.rollback", { pluginId: plugin.id });
    if (result.ok) props.onNotice(t("plugins.notice.rollback", { name: plugin.name, version: plugin.previousVersion ?? "" }));
  }

  async function doUninstall(plugin: PluginView, deleteData: boolean) {
    const result = await run<{ keptData: boolean }>("plugin.uninstall", { pluginId: plugin.id, deleteData });
    setUninstall(null);
    if (result.ok) props.onNotice(t(result.value.keptData ? "plugins.notice.uninstalledKept" : "plugins.notice.uninstalled", { name: plugin.name }));
  }

  async function exportData(pluginId: string) {
    if (!window.manga.pick) { props.onError(t("plugins.unavailable")); return; }
    const folder = await window.manga.pick({ mode: "directory" });
    if (!folder) return;
    const result = await run<{ fileName: string }>("plugin.exportData", { pluginId, pathHandle: folder.pathHandle });
    if (result.ok) props.onNotice(t("plugins.notice.exported", { file: result.value.fileName }));
  }

  async function doDeleteData(item: PluginLeftoverView) {
    const result = await run("plugin.deleteData", { pluginId: item.pluginId });
    setDropData(null);
    if (result.ok) props.onNotice(t("plugins.notice.dataDeleted"));
  }

  async function doAddKey(publicKey: string, label: string) {
    const result = await run("plugin.trust.add", { publicKey, label });
    if (result.ok) { setAddKey(false); props.onNotice(t("plugins.notice.keyAdded", { label })); }
  }

  async function doRemoveKey(key: TrustedKeyView) {
    const result = await run("plugin.trust.remove", { keyId: key.keyId });
    setRemoveKey(null);
    if (result.ok) props.onNotice(t("plugins.notice.keyRemoved", { label: key.label }));
  }

  const plugins = list?.plugins ?? [];
  const leftovers = list?.leftovers ?? [];
  const title = t("plugins.title");
  if (!list) return <SettingsPage id="plugins" title={title} hint={t("plugins.hint")}><SettingsEmpty text={t("status.loading")} testId="plugins-loading" /></SettingsPage>;

  return (
    <SettingsPage id="plugins" title={title} hint={t("plugins.hint")}>
      <p className="detail-muted plugin-note" data-testid="plugins-trust-note">{t("plugins.trustNote")}</p>

      <SettingsSection title={t("plugins.section.installed")} testId="plugins-installed">
        {plugins.length === 0 ? <SettingsEmpty text={t("plugins.none")} testId="plugins-none" /> : plugins.map((plugin) => (
          <PluginRow key={plugin.id} t={t} plugin={plugin} busy={busy}
            onToggle={() => void toggle(plugin)} onUpgrade={() => void chooseFile()} onRollback={() => void rollback(plugin)} onUninstall={() => setUninstall(plugin)} />
        ))}
      </SettingsSection>

      <SettingsSection title={t("plugins.section.install")} testId="plugins-install">
        <SettingsRow label={t("plugins.fromFile")} hint={t("plugins.fromFileHint")}>
          <button type="button" className="secondary-button" data-testid="plugins-from-file" disabled={busy} onClick={() => void chooseFile()}><PackagePlus size={15} aria-hidden="true" /> {t("plugins.fromFile")}</button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("plugins.section.bundled")} hint={t("plugins.section.bundledHint")} testId="plugins-bundled">
        {bundled.length === 0 ? <SettingsEmpty text={t("plugins.bundledNone")} testId="plugins-bundled-none" /> : bundled.map((item) => (
          <SettingsRow key={item.id} label={item.name} hint={item.description} testId={`plugin-bundled-${item.id}`}>
            <span className="detail-muted">{t("plugins.meta", { version: item.version, publisher: item.publisher.name })}</span>
            {item.installed && item.installedVersion === item.version ? <span className="chip" data-testid={`plugin-bundled-${item.id}-installed`}>{t("plugins.installedChip")}</span> : null}
            <button type="button" className="secondary-button" data-testid={`plugin-bundled-${item.id}-install`} disabled={busy || (item.installed && item.installedVersion === item.version)} onClick={() => void inspect({ bundledId: item.id })}>
              <Download size={15} aria-hidden="true" /> {t("plugins.install")}
            </button>
          </SettingsRow>
        ))}
      </SettingsSection>

      {leftovers.length ? (
        <SettingsSection title={t("plugins.section.leftovers")} hint={t("plugins.section.leftoversHint")} testId="plugins-leftovers">
          {leftovers.map((item) => (
            <SettingsRow key={item.pluginId} label={item.name} hint={`${bytesLabel(item.bytes)} · ${props.formatDate(item.uninstalledAt)}`} testId={`plugin-left-${item.pluginId}`}>
              <button type="button" className="secondary-button" data-testid={`plugin-left-${item.pluginId}-export`} disabled={busy || item.bytes === 0} onClick={() => void exportData(item.pluginId)}>{t("plugins.export")}</button>
              <button type="button" className="secondary-button" data-testid={`plugin-left-${item.pluginId}-delete`} disabled={busy} onClick={() => setDropData(item)}>{t("plugins.deleteData")}</button>
            </SettingsRow>
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection title={t("plugins.section.keys")} hint={t("plugins.section.keysHint")} testId="plugins-keys"
        actions={<button type="button" className="secondary-button" data-testid="plugins-key-add" disabled={busy} onClick={() => setAddKey(true)}>{t("plugins.keys.add")}</button>}>
        {keys.map((key) => (
          <SettingsRow key={key.keyId} label={key.label} hint={t("plugins.keys.fingerprint", { fingerprint: key.fingerprint })} testId={`plugin-key-${key.keyId}`}>
            <span className={`chip${key.trust === "user" ? "" : " chip-accent"}`}>{t(key.trust === "user" ? "plugins.keys.user" : "plugins.keys.firstParty")}</span>
            {key.addedAt ? <span className="detail-muted">{t("plugins.keys.addedAt", { date: props.formatDate(key.addedAt) })}</span> : null}
            {key.trust === "user" ? <button type="button" className="secondary-button" data-testid={`plugin-key-${key.keyId}-remove`} disabled={busy} onClick={() => setRemoveKey(key)}>{t("plugins.keys.remove")}</button> : null}
          </SettingsRow>
        ))}
      </SettingsSection>

      {install ? <InstallDialog t={t} inspection={install.inspection} busy={busy} onCancel={() => setInstall(null)} onInstall={(grant, enable) => void doInstall(grant, enable)} /> : null}
      {uninstall ? <UninstallDialog t={t} plugin={uninstall} busy={busy} hasData={uninstall.dataBytes > 0} onCancel={() => setUninstall(null)} onUninstall={(drop) => void doUninstall(uninstall, drop)} /> : null}
      {dropData ? <DeleteDataDialog t={t} name={dropData.name} busy={busy} onCancel={() => setDropData(null)} onDelete={() => void doDeleteData(dropData)} /> : null}
      {addKey ? <AddKeyDialog t={t} busy={busy} onCancel={() => setAddKey(false)} onAdd={(publicKey, label) => void doAddKey(publicKey, label)} /> : null}
      {removeKey ? <RemoveKeyDialog t={t} trusted={removeKey} busy={busy} onCancel={() => setRemoveKey(null)} onRemove={() => void doRemoveKey(removeKey)} /> : null}
    </SettingsPage>
  );
}

/** One installed plugin: who made it, which version, what it may do, and what state it is in; and what can be done to it. */
function PluginRow(props: { t: T; plugin: PluginView; busy: boolean; onToggle: () => void; onUpgrade: () => void; onRollback: () => void; onUninstall: () => void }) {
  const { t, plugin } = props;
  const problem = plugin.state === "failed" || plugin.state === "untrusted" || plugin.state === "incompatible";
  return (
    <article className="plugin-row" data-testid={`plugin-${plugin.id}`} data-state={plugin.state} data-trust={plugin.trust}>
      <header className="plugin-row-head">
        <Puzzle size={16} aria-hidden="true" />
        <h4 data-testid={`plugin-${plugin.id}-name`}>{plugin.name}</h4>
        <span className={`chip${problem ? " chip-warn" : ""}`} data-testid={`plugin-${plugin.id}-state`}>{t(`plugins.state.${plugin.state}` as MessageKey)}</span>
        <span className={`chip${plugin.trust === "unknown" ? " chip-warn" : ""}`} data-testid={`plugin-${plugin.id}-trust`}>{t(`plugins.trust.${plugin.trust}` as MessageKey)}</span>
      </header>
      <p className="detail-muted" data-testid={`plugin-${plugin.id}-meta`}>{t("plugins.meta", { version: plugin.version, publisher: plugin.publisher.name })}</p>
      {plugin.description ? <p>{plugin.description}</p> : null}
      <p className="detail-muted" data-testid={`plugin-${plugin.id}-permissions`}>
        {t("plugins.permissions")}：{plugin.permissions.length ? plugin.permissions.map((permission, index) => (
          <span key={permission} data-granted={plugin.granted.includes(permission) ? "yes" : "no"}>{index ? "、" : ""}<PermissionName t={t} permission={permission} /></span>
        )) : t("plugins.noPermissions")}
        {" · "}{t(plugin.executable ? "plugins.runs" : "plugins.declaresOnly")}
        {plugin.dataBytes > 0 ? ` · ${t("plugins.dataSize", { size: bytesLabel(plugin.dataBytes) })}` : ""}
      </p>
      {plugin.error ? <p className="draft-warn-text" role="alert" data-testid={`plugin-${plugin.id}-error`}>{t("plugins.error", { message: plugin.error })}</p> : null}
      <div className="plugin-row-actions">
        <button type="button" className="secondary-button" data-testid={`plugin-${plugin.id}-toggle`} disabled={props.busy || (!plugin.enabled && !canEnable(plugin))} onClick={props.onToggle}>{t(plugin.enabled ? "plugins.disable" : "plugins.enable")}</button>
        <button type="button" className="secondary-button" data-testid={`plugin-${plugin.id}-upgrade`} disabled={props.busy} onClick={props.onUpgrade}>{t("plugins.upgrade")}</button>
        {plugin.previousVersion ? <button type="button" className="secondary-button" data-testid={`plugin-${plugin.id}-rollback`} disabled={props.busy} onClick={props.onRollback}>{t("plugins.rollback", { version: plugin.previousVersion })}</button> : null}
        <button type="button" className="secondary-button" data-testid={`plugin-${plugin.id}-uninstall`} disabled={props.busy} onClick={props.onUninstall}>{t("plugins.uninstall")}</button>
      </div>
    </article>
  );
}
