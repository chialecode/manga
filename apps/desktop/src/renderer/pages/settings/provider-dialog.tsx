import { useState } from "react";
import type { MessageKey, Translator } from "@manga/i18n";
import { Modal } from "../../components/modal.tsx";
import { useAsyncGuard } from "../../hooks/use-async-guard.ts";

/** A provider an enabled plugin declares, as `providers.list` gives it. */
export type ProviderInfo = {
  ref: string;
  name: string;
  keyUrl: string | null;
  pricesCheckedAt: string | null;
  models: DiscoveredModel[];
  services: Array<{ kind: "transcription" | "speech" | "search"; name: string; description: string; suggested: boolean }>;
};
export type ProviderAccount = { id: string; providerRef: string; label: string; credentialConfigured: boolean; connections: number; available: boolean };
export type DiscoveredModel = {
  id: string; name: string; description: string; contextWindow: number; maxOutput: number; inputTypes: string[];
  reasoningLevels: string[]; defaultLevel: string | null; inCatalog: boolean; listed: boolean; suggested: boolean;
};
export type DiscoverResult = { ok: true; verified: boolean; models: DiscoveredModel[] } | { ok: false; verified: false; failure?: { category: string }; models: DiscoveredModel[] } | { error: string };
export type AddFromProviderInput = { providerRef: string; accountId?: string; secret?: string; label?: string; models: string[]; services: string[]; verified: boolean };

type T = Translator["t"];

const levelsText = (t: T, levels: string[]) => levels.map((level) => t(`models.effort.${level}` as MessageKey)).join("、");

/**
 * Adding a provider's models (计划 4.2): an account or a new key, the models that key can use read from the service (or the plugin's catalogue, marked
 * as not checked online), and the services. One confirmation creates the account and every chosen connection together.
 */
export function ProviderDialog(props: {
  i18n: Translator;
  provider: ProviderInfo;
  accounts: ProviderAccount[];
  onDiscover: (input: { providerRef: string; accountId?: string; secret?: string }) => Promise<DiscoverResult>;
  onAdd: (input: AddFromProviderInput) => Promise<{ ok: true; count: number } | { ok: false; message: string }>;
  onOpenLink: (url: string) => void;
  onClose: () => void;
}) {
  const { i18n, provider } = props;
  const t = i18n.t;
  const [accountId, setAccountId] = useState<string>(props.accounts[0]?.id ?? "");
  const [secret, setSecret] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<"discover" | "add" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** What the dialog lists: null until the models were read (or the catalogue was chosen). */
  const [listing, setListing] = useState<{ verified: boolean; models: DiscoveredModel[] } | null>(null);
  const [failure, setFailure] = useState<{ category: string; models: DiscoveredModel[] } | null>(null);
  const [models, setModels] = useState<Set<string>>(new Set());
  const [services, setServices] = useState<Set<string>>(() => new Set(provider.services.filter((item) => item.suggested).map((item) => item.kind)));
  const discoverGuard = useAsyncGuard();

  const keyInput = accountId ? {} : { secret: secret.trim() };
  const changeKey = () => { discoverGuard.invalidate(); setListing(null); setFailure(null); setProblem(null); };

  const show = (verified: boolean, list: DiscoveredModel[]) => {
    setListing({ verified, models: list });
    setFailure(null);
    // The suggested models are ticked, as long as this key can use them (Q-41 第 3 项).
    setModels(new Set(list.filter((model) => model.suggested && (model.listed || !verified)).map((model) => model.id)));
  };

  async function discover() {
    if (busy !== null) return;
    if (!accountId && !secret.trim()) { setProblem(t("provider.needKey")); return; }
    const token = discoverGuard.next();
    setBusy("discover");
    setProblem(null);
    try {
      const result = await props.onDiscover({ providerRef: provider.ref, ...(accountId ? { accountId } : {}), ...keyInput });
      if (!discoverGuard.isCurrent(token)) return;
      if ("error" in result) { setProblem(result.error); return; }
      if (result.ok) show(result.verified, result.models);
      else { setListing(null); setFailure({ category: result.failure?.category ?? "other", models: result.models }); }
    } finally {
      if (discoverGuard.isCurrent(token)) setBusy(null);
    }
  }

  async function add() {
    if (!listing || busy !== null) return;
    if (!models.size && !services.size) { setProblem(t("provider.chooseOne")); return; }
    setBusy("add");
    setProblem(null);
    try {
      const outcome = await props.onAdd({
        providerRef: provider.ref, ...(accountId ? { accountId } : { secret: secret.trim(), label: label.trim() || undefined }),
        models: [...models], services: [...services], verified: listing.verified,
      });
      if (!discoverGuard.isAlive()) return;
      if (outcome.ok) props.onClose();
      else setProblem(outcome.message);
    } finally {
      if (discoverGuard.isAlive()) setBusy(null);
    }
  }

  const flip = (set: Set<string>, item: string, on: boolean) => { const next = new Set(set); if (on) next.add(item); else next.delete(item); return next; };

  return (
    <Modal
      variant="dialog"
      className="connection-dialog provider-dialog"
      testId="provider-dialog"
      title={t("provider.dialog.title", { name: provider.name })}
      description={t("provider.dialog.hint")}
      closeLabel={t("common.close")}
      onClose={() => { if (!busy) props.onClose(); }}
      footer={(
        <>
          <button type="button" className="secondary-button" data-testid="provider-cancel" onClick={props.onClose} disabled={busy !== null}>{t("common.cancel")}</button>
          <button type="button" className="primary-button" data-testid="provider-add" disabled={!listing || busy !== null} onClick={() => void add()}>{busy === "add" ? t("provider.adding") : t("provider.add")}</button>
        </>
      )}
    >
      <div className="connection-dialog-body">
        {problem ? <p className="review-error" role="alert" data-testid="provider-error">{problem}</p> : null}
        <fieldset className="connection-group">
          <legend>{t("provider.account")}</legend>
          {props.accounts.length ? (
            <label className="msettings-field">
              <span>{t("provider.account")}</span>
              <select data-testid="provider-account" disabled={busy !== null} value={accountId} onChange={(event) => { setAccountId(event.target.value); changeKey(); }}>
                {props.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
                <option value="">{t("provider.accountNew")}</option>
              </select>
            </label>
          ) : null}
          {accountId ? null : (
            <>
              <label className="msettings-field">
                <span>{t("provider.key")}</span>
                <input data-testid="provider-key" type="password" autoComplete="off" disabled={busy !== null} value={secret} onChange={(event) => { setSecret(event.target.value); changeKey(); }} />
                <span className="detail-muted">
                  {t("provider.keyHint")}
                  {provider.keyUrl ? <> <button type="button" className="link-button" data-testid="provider-key-link" onClick={() => props.onOpenLink(provider.keyUrl!)}>{t("provider.keyLink")}</button></> : null}
                </span>
              </label>
              <label className="msettings-field">
                <span>{t("provider.label")}</span>
                <input data-testid="provider-label" disabled={busy !== null} value={label} placeholder={provider.name} onChange={(event) => setLabel(event.target.value)} />
              </label>
            </>
          )}
          <div className="msettings-actions">
            <button type="button" className="secondary-button" data-testid="provider-discover" disabled={busy !== null} onClick={() => void discover()}>{busy === "discover" ? t("provider.discovering") : t("provider.discover")}</button>
          </div>
        </fieldset>

        {failure ? (
          <div className="connection-test connection-test-fail" role="status" data-testid="provider-discover-fail" data-category={failure.category}>
            <strong>{t("provider.discoverFail", { reason: t(`models.fail.${failure.category}` as MessageKey) })}</strong>
            <div>{t(`models.fail.${failure.category}.fix` as MessageKey)}</div>
            <button type="button" className="secondary-button" data-testid="provider-use-catalog" disabled={busy !== null} onClick={() => show(false, failure.models)}>{t("provider.useCatalog")}</button>
          </div>
        ) : null}

        {listing ? (
          <>
            <p className="detail-muted" data-testid="provider-verified" data-verified={listing.verified ? "yes" : "no"}>{listing.verified ? t("provider.verified") : t("provider.unverified")}</p>
            <fieldset className="connection-group" data-testid="provider-models">
              <legend>{t("provider.models")}</legend>
              {listing.models.map((model) => {
                const unusable = listing.verified && !model.listed;
                const inputs = model.inputTypes.map((item) => t(`models.input.${item}` as MessageKey)).join("、");
                return (
                  <label key={model.id} className="profile-check provider-choice" data-testid={`provider-model-${model.id}`}>
                    <input type="checkbox" disabled={unusable} checked={models.has(model.id)} onChange={(event) => setModels((current) => flip(current, model.id, event.target.checked))} />
                    <span>
                      <strong>{model.name}</strong>{model.suggested ? <span className="detail-muted"> · {t("provider.suggested")}</span> : null}
                      <span className="detail-muted"> · {model.id}</span>
                      <br />
                      <span className="detail-muted">
                        {t("provider.modelLine", { window: i18n.formatNumber(model.contextWindow), output: i18n.formatNumber(model.maxOutput), inputs })}
                        {model.reasoningLevels.length ? ` · ${t("provider.modelLevels", { levels: levelsText(t, model.reasoningLevels) })}` : ""}
                      </span>
                      {model.description ? <><br /><span className="detail-muted">{model.description}</span></> : null}
                      {unusable ? <><br /><span className="review-error">{t("provider.notListed")}</span></> : null}
                      {!model.inCatalog ? <><br /><span className="detail-muted">{t("provider.notInCatalog")}</span></> : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {provider.services.length ? (
              <fieldset className="connection-group" data-testid="provider-services">
                <legend>{t("provider.services")}</legend>
                {provider.services.map((service) => (
                  <label key={service.kind} className="profile-check provider-choice" data-testid={`provider-service-${service.kind}`}>
                    <input type="checkbox" checked={services.has(service.kind)} onChange={(event) => setServices((current) => flip(current, service.kind, event.target.checked))} />
                    <span><strong>{service.name}</strong>{service.description ? <span className="detail-muted"> · {service.description}</span> : null}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {provider.pricesCheckedAt ? <p className="detail-muted" data-testid="provider-price">{t("provider.price", { date: provider.pricesCheckedAt })}</p> : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
