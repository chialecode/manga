import { useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_MODEL_PROFILE, type ConnectionTestResult, type ModelProfile } from "@manga/contracts/models";
import type { MessageKey, Translator } from "@manga/i18n";
import { Menu } from "../../components/menu.tsx";
import { Modal } from "../../components/modal.tsx";
import { attempt, type MangaHost } from "../../lib/api.ts";
import { emptyForm, type ConnectionForm } from "../../lib/types.ts";
import { profileForm, seconds } from "../../lib/model-profile.ts";
import { ConnectionDialog, protocolName, purposeName, runtimeName, type PlainTestResult, type SaveConnectionResult } from "./connection-dialog.tsx";
import { ProviderDialog, type AddFromProviderInput, type DiscoverResult, type ProviderAccount, type ProviderInfo } from "./provider-dialog.tsx";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

/** What the models page does with provider plugins (计划 4.2). */
export type ProviderActions = {
  providers: { providers: ProviderInfo[]; accounts: ProviderAccount[]; offered: Array<{ pluginId: string; name: string; state: "not-installed" | "disabled" }> } | null;
  onDiscover: (input: { providerRef: string; accountId?: string; secret?: string }) => Promise<DiscoverResult>;
  onAddFromProvider: (input: AddFromProviderInput) => Promise<{ ok: true; count: number } | { ok: false; message: string }>;
  /** Null when the key was changed, or why not. */
  onSetAccountKey: (accountId: string, secret: string) => Promise<string | null>;
  onDeleteAccount: (accountId: string) => Promise<void>;
  onOpenPlugins: () => void;
  onOpenLink: (url: string) => void;
};

type AccountRef = { id: string; label: string; providerRef: string; available: boolean };

/** Provider-backed non-chat services (transcription, speech, search, fetch, ocr) persist their own service test result and cannot be edited manually. */
const SERVICE_PURPOSES = new Set(["transcription", "speech", "search", "fetch", "ocr"]);
const STANDARD_ADAPTERS = new Set(["", "openai-http", "openai-chat-completions", "openai-responses"]);
function isServiceConnection(connection: Connection): boolean {
  const purpose = String(connection.purpose ?? "");
  const adapter = String(connection.adapterId ?? "");
  return SERVICE_PURPOSES.has(purpose) && (Boolean(connection.account) || !STANDARD_ADAPTERS.has(adapter));
}

type Connection = Record<string, unknown>;
type T = Translator["t"];

const SOURCE_KEY = { default: "models.source.default", user: "models.source.user", detected: "models.source.detected" } as const;

const asProfile = (value: unknown): ModelProfile => (value && typeof value === "object" ? value as ModelProfile : DEFAULT_MODEL_PROFILE);

/** The profile of a connection in one line, with where its two numbers came from. */
function ProfileLine(props: { t: T; id: string; profile: ModelProfile; formatNumber: (value: number) => string }) {
  const { t, profile } = props;
  const inputs = profile.inputTypes.map((item) => t(`models.input.${item}` as MessageKey)).join("、");
  const caps = profile.capabilities.length ? profile.capabilities.map((item) => t(`models.cap.${item}` as MessageKey)).join("、") : t("models.noCaps");
  return (
    <div className="detail-muted" data-testid={`connection-profile-${props.id}`}>
      {t("models.profileLine", { window: props.formatNumber(profile.contextWindow), output: props.formatNumber(profile.maxOutput), inputs, caps })}
      <span className="connection-sources"> · {t(SOURCE_KEY[profile.source.contextWindow])} / {t(SOURCE_KEY[profile.source.maxOutput])}</span>
    </div>
  );
}

/** What the last test found, or why it failed and what to do about it. */
function TestResult(props: { t: T; id: string; result: ConnectionTestResult | null; profile: ModelProfile; formatDate: (value: string) => string; formatNumber: (value: number) => string }) {
  const { t, result } = props;
  if (!result) return <div className="detail-muted" data-testid={`connection-test-${props.id}`} data-state="never">{t("models.neverTested")}</div>;
  if (!result.ok) {
    const category = result.failure?.category ?? "other";
    return (
      <div className="connection-test connection-test-fail" role="status" data-testid={`connection-test-${props.id}`} data-state="fail" data-category={category}>
        <strong>{t("models.probeFail")}：{t(`models.fail.${category}` as MessageKey)}{result.failure?.status ? `（${t("models.status", { status: result.failure.status })}）` : ""}</strong>
        <div>{t(`models.fail.${category}.fix` as MessageKey)}</div>
        <div className="detail-muted">{t("models.testedAt", { time: props.formatDate(result.at) })}</div>
      </div>
    );
  }
  const found = (result.capabilities ?? []).map((item) => t(`models.found.${item}` as MessageKey)).join("、");
  const claimsImage = props.profile.inputTypes.includes("image");
  return (
    <div className="connection-test connection-test-ok" role="status" data-testid={`connection-test-${props.id}`} data-state="ok">
      <strong>{t("models.probeOk")} · {t("models.latency", { seconds: seconds(result.latencyMs) })}</strong>
      {result.reply ? <div className="detail-muted">{t("models.reply", { text: result.reply })}</div> : null}
      {found ? <div>{t("models.found", { list: found })}</div> : null}
      {result.service ? <div className="detail-muted" data-testid={`connection-test-${props.id}-service`}>{t(`models.serviceDetail.${result.service.kind}` as MessageKey, { detail: result.service.detail })}</div> : null}
      {result.detected ? <div className="detail-muted">{t("models.detected", { window: result.detected.contextWindow ? props.formatNumber(result.detected.contextWindow) : "—", output: result.detected.maxOutput ? props.formatNumber(result.detected.maxOutput) : "—" })}</div> : null}
      {claimsImage && !(result.capabilities ?? []).includes("vision") ? <div className="review-error" data-testid={`connection-test-${props.id}-image`}>{t("models.mismatchImage")}</div> : null}
      <div className="detail-muted">{t("models.testedAt", { time: props.formatDate(result.at) })}</div>
    </div>
  );
}

/**
 * Models: the Agent runtime, and the saved connections with the profile of each model and the result of its last test. Adding a model and changing
 * one open the same dialog (A-90); a secret is typed once and handed to the main process, which keeps it, and is never shown again.
 */
export function ModelsPage(props: {
  i18n: Translator;
  settings: Record<string, unknown> | null;
  onRuntime: (runtime: string) => Promise<void>;
  onSaveConnection: (fields: ConnectionForm) => Promise<SaveConnectionResult>;
  onDeleteConnection: (id: string) => Promise<void>;
  onTestConnection: (id: string, capability: string) => Promise<PlainTestResult>;
  onProbeConnection: (id: string) => Promise<void>;
  onSkip: () => void;
  /** On the first start (UI-04), where the data goes, so the person sees it before they begin. */
  firstRunLocations?: ReactNode;
} & Partial<ProviderActions>) {
  const { i18n } = props;
  const t = i18n.t;
  /** The dialog that is open: a new connection, or one being changed (the form it starts from). */
  const [editing, setEditing] = useState<{ form: ConnectionForm; secretStored: boolean } | null>(null);
  const [asking, setAsking] = useState<{ id: string; label: string } | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  /** What the last test of a connection that is not asked questions said; only for as long as the page is open. */
  const [plain, setPlain] = useState<Record<string, PlainTestResult>>({});
  const [liveSettings, setLiveSettings] = useState<{ base: Record<string, unknown> | null; value: Record<string, unknown> } | null>(null);
  const [liveProviders, setLiveProviders] = useState<{ base: ProviderActions["providers"] | undefined; value: NonNullable<ProviderActions["providers"]> } | null>(null);
  const refreshSeq = useRef(0);
  const propsRef = useRef({ settings: props.settings, providers: props.providers });
  propsRef.current = { settings: props.settings, providers: props.providers };
  useEffect(() => {
    const api = typeof window !== "undefined" ? (window as { manga?: Partial<MangaHost> }).manga : undefined;
    if (!api?.command) return undefined;
    const reload = () => {
      const seq = ++refreshSeq.current;
      void Promise.all([attempt<Record<string, unknown>>("settings.get", {}), attempt<NonNullable<ProviderActions["providers"]>>("providers.list", {})]).then(([nextSettings, nextProviders]) => {
        if (seq !== refreshSeq.current) return;
        if (nextSettings.ok) setLiveSettings({ base: propsRef.current.settings, value: nextSettings.value });
        if (nextProviders.ok) setLiveProviders({ base: propsRef.current.providers, value: nextProviders.value });
      }).catch(() => undefined);
    };
    reload();
    return api.onNotice?.((notice) => {
      if (notice.topic === "plugin.changed" || notice.topic === "settings.changed") reload();
    });
  }, []);
  const activeSettings = liveSettings && liveSettings.base === props.settings ? liveSettings.value : props.settings;
  const hasLiveProviders = Boolean(liveProviders && liveProviders.base === props.providers);
  const providerData = (hasLiveProviders ? liveProviders!.value : props.providers) ?? null;
  const connections = (activeSettings?.connections as Connection[] | undefined) ?? [];
  const runtime = String(activeSettings?.aiRuntime ?? "native");
  const needsSetup = activeSettings?.needsSetup === true;
  const [adding, setAdding] = useState<ProviderInfo | null>(null);
  const [rekey, setRekey] = useState<{ id: string; label: string; secret: string; problem: string | null; busy: boolean } | null>(null);
  const [dropping, setDropping] = useState<{ id: string; label: string } | null>(null);
  const providerName = (ref: string) => providerData?.providers.find((item) => item.ref === ref)?.name ?? ref.split("/").pop() ?? ref;
  const resolveAvailable = (account: AccountRef): boolean => {
    if (!hasLiveProviders || !providerData) return account.available;
    const fromProviders = providerData.accounts.find((item) => item.id === account.id);
    return fromProviders ? fromProviders.available : providerData.providers.some((item) => item.ref === account.providerRef);
  };
  const visibleTest = (fromProvider: boolean, available: boolean, value: unknown): ConnectionTestResult | null => {
    const rawTest = (value as ConnectionTestResult | null | undefined) ?? null;
    return fromProvider && available && rawTest && !rawTest.ok && rawTest.failure?.category === "provider" ? null : rawTest;
  };
  // Connections by account: those added by hand first, as before, then each account's under its heading (计划 4.2 列表).
  const manual = connections.filter((connection) => !connection.account);
  const accountRows = new Map<string, { account: AccountRef; items: Connection[] }>();
  for (const connection of connections) {
    const rawAccount = connection.account as AccountRef | null | undefined;
    if (!rawAccount) continue;
    const account = { ...rawAccount, available: resolveAvailable(rawAccount) };
    const group = accountRows.get(account.id) ?? { account, items: [] };
    group.account = account;
    group.items.push(connection);
    accountRows.set(account.id, group);
  }
  // An account with no connection left is still listed, so it can be removed.
  for (const account of providerData?.accounts ?? []) {
    if (!accountRows.has(account.id)) accountRows.set(account.id, { account: { id: account.id, label: account.label, providerRef: account.providerRef, available: account.available }, items: [] });
  }

  const probe = async (id: string) => {
    setProbing(id);
    try { await props.onProbeConnection(id); } finally { setProbing(null); }
  };
  const testPlain = async (id: string, purpose: string) => {
    setProbing(id);
    try {
      const outcome = await props.onTestConnection(id, purpose);
      setPlain((current) => ({ ...current, [id]: outcome }));
    } finally { setProbing(null); }
  };
  const edit = (connection: Connection) => {
    const profile = asProfile(connection.profile);
    const account = connection.account as AccountRef | null | undefined;
    setEditing({
      secretStored: connection.credentialConfigured === true,
      form: {
        id: String(connection.id),
        label: String(connection.label),
        protocol: String(connection.protocol),
        runtime: String(connection.runtime ?? "native"),
        baseUrl: String(connection.baseUrl),
        modelId: String(connection.modelId),
        purpose: String(connection.purpose),
        timeoutMs: String(connection.timeoutMs ?? 60_000),
        secret: "",
        profile: profileForm(profile),
        profileBefore: profileForm(profile),
        ...(account ? { provider: providerName(account.providerRef) } : {}),
      },
    });
  };

  const testService = async (id: string, purpose: string) => {
    setProbing(id);
    try { await props.onTestConnection(id, purpose); } finally { setProbing(null); }
  };

  /** One connection; one whose provider plugin is off can be deleted but not changed or tested (计划 4.2 列表). */
  const row = (connection: Connection, available: boolean) => {
    const id = String(connection.id);
    const purpose = String(connection.purpose);
    const asked = purpose === "text" || purpose === "vision";
    const service = isServiceConnection(connection);
    const profile = asProfile(connection.profile);
    const result = plain[id];
    const fromProvider = Boolean(connection.account);
    const shownTest = visibleTest(fromProvider, available, connection.lastTest);
    return (
      <li key={id} className="connection" data-testid={`connection-${id}`} data-available={available ? "yes" : "no"}>
        <div>
          <strong>{String(connection.label)}</strong>
          <span className="detail-muted"> · {purposeName(t, purpose)}{service ? "" : ` · ${protocolName(t, String(connection.protocol))} · ${runtimeName(t, String(connection.runtime ?? "native"))}`}</span>
        </div>
        <div className="detail-muted">{fromProvider ? String(connection.modelId) : `${String(connection.baseUrl)} · ${String(connection.modelId)}`}</div>
        {asked ? <ProfileLine t={t} id={id} profile={profile} formatNumber={i18n.formatNumber} /> : null}
        {asked || service ? <TestResult t={t} id={id} result={shownTest} profile={profile} formatDate={i18n.formatDate} formatNumber={i18n.formatNumber} /> : null}
        {!asked && !service && result ? <div className={result.ok ? "connection-test connection-test-ok" : "connection-test connection-test-fail"} role="status" data-testid={`connection-test-${id}`} data-state={result.ok ? "ok" : "fail"}>{result.message}</div> : null}
        <div className="msettings-actions">
          {service ? null : <button type="button" className="secondary-button" data-testid={`connection-edit-${id}`} disabled={!available} onClick={() => edit(connection)}>{t("settings.editConnection")}</button>}
          {asked ? (
            <button type="button" className="secondary-button" data-testid={`connection-probe-${id}`} disabled={!available || probing === id} onClick={() => void probe(id)}>{probing === id ? t("models.probing") : t("models.probe")}</button>
          ) : service ? (
            <button type="button" className="secondary-button" data-testid={`connection-test-run-${id}`} disabled={!available || probing === id} onClick={() => void testService(id, purpose)}>{probing === id ? t("models.probing") : t("settings.testConnection")}</button>
          ) : (
            <button type="button" className="secondary-button" data-testid={`connection-test-run-${id}`} disabled={!available || probing === id} onClick={() => void testPlain(id, purpose)}>{probing === id ? t("models.probing") : t("settings.testConnection")}</button>
          )}
          <button type="button" className="link-button" data-testid={`connection-delete-${id}`} onClick={() => setAsking({ id, label: String(connection.label) })}>{t("settings.deleteConnection")}</button>
        </div>
      </li>
    );
  };

  const enabledProviders = providerData?.providers ?? [];
  // With a provider on, "添加模型" is a menu; without one it opens the dialog it always opened.
  const addButton = enabledProviders.length ? (
    <Menu
      label={t("models.add")}
      testId="models-add"
      align="end"
      className="models-add-menu"
      trigger={<span className="menu-text">{t("models.add")}</span>}
      items={[
        { id: "manual", label: t("models.addManual"), testId: "models-add-manual", onSelect: () => setEditing({ form: emptyForm(), secretStored: false }) },
        ...enabledProviders.map((provider) => ({ id: provider.ref, label: t("models.addFrom", { name: provider.name }), testId: `models-add-provider-${provider.ref.split("/").pop()}`, onSelect: () => setAdding(provider) })),
      ]}
    />
  ) : <button type="button" className="primary-button" data-testid="models-add" onClick={() => setEditing({ form: emptyForm(), secretStored: false })}>{t("models.add")}</button>;
  const offered = (providerData?.offered ?? []).filter((item) => (
    !enabledProviders.some((provider) => provider.ref.startsWith(`${item.pluginId}/`))
    && !(item.state === "disabled" && [...accountRows.values()].some(({ account }) => account.available && account.providerRef.startsWith(`${item.pluginId}/`)))
  ));

  return (
    <SettingsPage id="models" title={t("settings.page.models")} hint={t("models.hint")}>
      <SettingsSection testId="models-runtime">
        <SettingsRow label={t("settings.runtime")} hint={t("models.runtimeHint")} htmlFor="settings-runtime">
          <select id="settings-runtime" aria-label={t("settings.runtime")} value={runtime} onChange={(event) => void props.onRuntime(event.target.value)}>
            <option value="native">{t("settings.runtimeNative")}</option>
            <option value="pi">{t("settings.runtimePi")}</option>
          </select>
        </SettingsRow>
        {needsSetup ? (
          <SettingsRow label={t("setup.skipAi")} hint={t("setup.aiOptional")}>
            <button type="button" className="secondary-button" data-testid="settings-skip-ai" onClick={props.onSkip}>{t("setup.skipAi")}</button>
          </SettingsRow>
        ) : null}
      </SettingsSection>
      {needsSetup && props.firstRunLocations ? (
        <SettingsSection title={t("setup.locations")} hint={t("setup.locationsHint")} testId="setup-locations">{props.firstRunLocations}</SettingsSection>
      ) : null}

      <SettingsSection
        title={t("settings.connections")}
        testId="models-connections"
        actions={addButton}
      >
        {offered.map((item) => (
          <p key={item.pluginId} className="detail-muted provider-offer" data-testid={`models-offer-${item.pluginId}`} data-state={item.state}>
            {t(item.state === "not-installed" ? "models.offer.notInstalled" : "models.offer.disabled", { name: item.name })}
            {" "}
            <button type="button" className="link-button" data-testid={`models-offer-open-${item.pluginId}`} onClick={() => props.onOpenPlugins?.()}>{t("models.offer.open")}</button>
          </p>
        ))}
        {connections.length === 0 && accountRows.size === 0 ? <p className="detail-muted settings-empty" data-testid="models-empty">{t("models.empty")}</p> : null}
        <ul className="connections">
          {manual.map((connection) => row(connection, true))}
        </ul>
        {[...accountRows.values()].map(({ account, items }) => (
          <div key={account.id} className="connection-account" data-testid={`account-${account.id}`} data-available={account.available ? "yes" : "no"}>
            <div className="connection-account-head">
              <strong>{t("models.account.group", { provider: providerName(account.providerRef), label: account.label })}</strong>
              <span className="detail-muted"> · {t("models.account.connections", { count: items.length })}</span>
              {account.available ? null : (
                <span className="review-error" data-testid={`account-disabled-${account.id}`}>
                  {" "}{t("models.account.disabled")}{" "}
                  <button type="button" className="link-button" onClick={() => props.onOpenPlugins?.()}>{t("models.offer.open")}</button>
                </span>
              )}
              <span className="msettings-actions">
                <button type="button" className="secondary-button" data-testid={`account-set-key-${account.id}`} onClick={() => setRekey({ id: account.id, label: account.label, secret: "", problem: null, busy: false })}>{t("models.account.setKey")}</button>
                <button type="button" className="link-button" data-testid={`account-delete-${account.id}`} disabled={items.length > 0} title={items.length ? t("models.account.deleteBlocked") : undefined} onClick={() => setDropping({ id: account.id, label: account.label })}>{t("models.account.delete")}</button>
              </span>
            </div>
            {items.length ? <ul className="connections">{items.map((connection) => row(connection, account.available))}</ul> : <p className="detail-muted">{t("models.account.empty")}</p>}
          </div>
        ))}
      </SettingsSection>

      {adding && props.onDiscover && props.onAddFromProvider ? (
        <ProviderDialog
          i18n={i18n}
          provider={adding}
          accounts={(providerData?.accounts ?? []).filter((account) => account.providerRef === adding.ref)}
          onDiscover={props.onDiscover}
          onAdd={props.onAddFromProvider}
          onOpenLink={(url) => props.onOpenLink?.(url)}
          onClose={() => setAdding(null)}
        />
      ) : null}

      {rekey ? (
        <Modal
          variant="dialog"
          testId="account-key-dialog"
          title={t("models.account.setKeyTitle", { label: rekey.label })}
          description={t("models.account.setKeyHint")}
          closeLabel={t("common.close")}
          onClose={() => { if (!rekey.busy) setRekey(null); }}
          footer={(
            <>
              <button type="button" className="secondary-button" data-testid="account-key-cancel" disabled={rekey.busy} onClick={() => setRekey(null)}>{t("common.cancel")}</button>
              <button type="button" className="primary-button" data-testid="account-key-save" disabled={rekey.busy || !rekey.secret.trim()} onClick={() => {
                const current = rekey;
                setRekey({ ...current, busy: true, problem: null });
                void props.onSetAccountKey?.(current.id, current.secret.trim()).then((problem) => { if (problem) setRekey({ ...current, busy: false, problem }); else setRekey(null); });
              }}>{t("settings.saveConnection")}</button>
            </>
          )}
        >
          <label className="msettings-field">
            <span>{t("provider.key")}</span>
            <input data-testid="account-key-input" type="password" autoComplete="off" value={rekey.secret} onChange={(event) => setRekey({ ...rekey, secret: event.target.value, problem: null })} />
            <span className="detail-muted">{t("provider.keyHint")}</span>
            {rekey.problem ? <span className="field-error" role="alert">{rekey.problem}</span> : null}
          </label>
        </Modal>
      ) : null}

      {dropping ? (
        <Modal
          variant="dialog"
          testId="account-delete-dialog"
          title={t("models.account.deleteTitle", { label: dropping.label })}
          description={t("models.account.deleteBody")}
          closeLabel={t("common.close")}
          onClose={() => setDropping(null)}
          footer={(
            <>
              <button type="button" className="secondary-button" data-testid="account-delete-cancel" onClick={() => setDropping(null)}>{t("common.cancel")}</button>
              <button type="button" className="danger-button" data-testid="account-delete-confirm" onClick={() => { const id = dropping.id; setDropping(null); void props.onDeleteAccount?.(id); }}>{t("models.account.delete")}</button>
            </>
          )}
        ><span /></Modal>
      ) : null}

      {editing ? (
        <ConnectionDialog
          key={editing.form.id ?? "new"}
          i18n={i18n}
          initial={editing.form}
          secretStored={editing.secretStored}
          saved={(id) => {
            const found = connections.find((item) => String(item.id) === id);
            if (!found) return undefined;
            const rawAccount = found.account as AccountRef | null | undefined;
            const available = rawAccount ? resolveAvailable(rawAccount) : true;
            return { lastTest: visibleTest(Boolean(rawAccount), available, found.lastTest), profile: asProfile(found.profile) };
          }}
          onSave={props.onSaveConnection}
          onProbe={async (id) => { await props.onProbeConnection(id); }}
          onTest={async (id, capability) => {
            const outcome = await props.onTestConnection(id, capability);
            setPlain((current) => ({ ...current, [id]: outcome }));
            return outcome;
          }}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {asking ? (
        <Modal
          variant="dialog"
          testId="connection-delete-dialog"
          title={t("models.delete.title", { label: asking.label })}
          description={t("models.delete.body")}
          closeLabel={t("common.close")}
          onClose={() => setAsking(null)}
          footer={(
            <>
              <button type="button" className="secondary-button" data-testid="connection-delete-cancel" onClick={() => setAsking(null)}>{t("common.cancel")}</button>
              <button type="button" className="danger-button" data-testid="connection-delete-confirm" onClick={() => { const id = asking.id; setAsking(null); void props.onDeleteConnection(id); }}>{t("models.delete.confirm")}</button>
            </>
          )}
        ><span /></Modal>
      ) : null}
    </SettingsPage>
  );
}
