import { useState } from "react";
import { DEFAULT_MODEL_PROFILE, type ConnectionTestResult, type ModelProfile } from "@manga/contracts/models";
import type { MessageKey, Translator } from "@manga/i18n";
import { Modal } from "../../components/modal.tsx";
import { emptyForm, type ConnectionForm } from "../../lib/types.ts";
import { profileForm, seconds } from "../../lib/model-profile.ts";
import { ConnectionDialog, protocolName, purposeName, runtimeName, type PlainTestResult, type SaveConnectionResult } from "./connection-dialog.tsx";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

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
}) {
  const { i18n } = props;
  const t = i18n.t;
  /** The dialog that is open: a new connection, or one being changed (the form it starts from). */
  const [editing, setEditing] = useState<{ form: ConnectionForm; secretStored: boolean } | null>(null);
  const [asking, setAsking] = useState<{ id: string; label: string } | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  /** What the last test of a connection that is not asked questions said; only for as long as the page is open. */
  const [plain, setPlain] = useState<Record<string, PlainTestResult>>({});
  const connections = (props.settings?.connections as Connection[] | undefined) ?? [];
  const runtime = String(props.settings?.aiRuntime ?? "native");
  const needsSetup = props.settings?.needsSetup === true;

  const probe = async (id: string) => {
    setProbing(id);
    try { await props.onProbeConnection(id); } finally { setProbing(null); }
  };
  const testPlain = async (id: string, purpose: string) => {
    setProbing(id);
    try {
      const outcome = await props.onTestConnection(id, purpose === "transcription" ? "transcription" : "embedding");
      setPlain((current) => ({ ...current, [id]: outcome }));
    } finally { setProbing(null); }
  };
  const edit = (connection: Connection) => {
    const profile = asProfile(connection.profile);
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
      },
    });
  };

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

      <SettingsSection
        title={t("settings.connections")}
        testId="models-connections"
        actions={<button type="button" className="primary-button" data-testid="models-add" onClick={() => setEditing({ form: emptyForm(), secretStored: false })}>{t("models.add")}</button>}
      >
        {connections.length === 0 ? <p className="detail-muted settings-empty" data-testid="models-empty">{t("models.empty")}</p> : null}
        <ul className="connections">
          {connections.map((connection) => {
            const id = String(connection.id);
            const purpose = String(connection.purpose);
            const asked = purpose === "text" || purpose === "vision";
            const profile = asProfile(connection.profile);
            const result = plain[id];
            return (
              <li key={id} className="connection" data-testid={`connection-${id}`}>
                <div>
                  <strong>{String(connection.label)}</strong>
                  <span className="detail-muted"> · {purposeName(t, purpose)} · {protocolName(t, String(connection.protocol))} · {runtimeName(t, String(connection.runtime ?? "native"))}</span>
                </div>
                <div className="detail-muted">{String(connection.baseUrl)} · {String(connection.modelId)}</div>
                {asked ? <ProfileLine t={t} id={id} profile={profile} formatNumber={i18n.formatNumber} /> : null}
                {asked ? <TestResult t={t} id={id} result={(connection.lastTest as ConnectionTestResult | null | undefined) ?? null} profile={profile} formatDate={i18n.formatDate} formatNumber={i18n.formatNumber} /> : null}
                {!asked && result ? <div className={result.ok ? "connection-test connection-test-ok" : "connection-test connection-test-fail"} role="status" data-testid={`connection-test-${id}`} data-state={result.ok ? "ok" : "fail"}>{result.message}</div> : null}
                <div className="msettings-actions">
                  <button type="button" className="secondary-button" data-testid={`connection-edit-${id}`} onClick={() => edit(connection)}>{t("settings.editConnection")}</button>
                  {asked ? (
                    <button type="button" className="secondary-button" data-testid={`connection-probe-${id}`} disabled={probing === id} onClick={() => void probe(id)}>{probing === id ? t("models.probing") : t("models.probe")}</button>
                  ) : (
                    <button type="button" className="secondary-button" data-testid={`connection-test-run-${id}`} disabled={probing === id} onClick={() => void testPlain(id, purpose)}>{probing === id ? t("models.probing") : t("settings.testConnection")}</button>
                  )}
                  <button type="button" className="link-button" data-testid={`connection-delete-${id}`} onClick={() => setAsking({ id, label: String(connection.label) })}>{t("settings.deleteConnection")}</button>
                </div>
              </li>
            );
          })}
        </ul>
      </SettingsSection>

      {editing ? (
        <ConnectionDialog
          key={editing.form.id ?? "new"}
          i18n={i18n}
          initial={editing.form}
          secretStored={editing.secretStored}
          saved={(id) => {
            const found = connections.find((item) => String(item.id) === id);
            return found ? { lastTest: (found.lastTest as ConnectionTestResult | null | undefined) ?? null, profile: asProfile(found.profile) } : undefined;
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
