import { useState } from "react";
import type { Translator } from "@manga/i18n";
import { emptyForm, type ConnectionForm } from "../../lib/types.ts";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type Connection = Record<string, unknown>;

/**
 * Models: the Agent runtime, the saved connections with their capability tests, and the form that adds or changes one. A secret is
 * typed once and handed to the main process, which keeps it; it is never shown again.
 */
export function ModelsPage(props: {
  i18n: Translator;
  settings: Record<string, unknown> | null;
  onRuntime: (runtime: string) => Promise<void>;
  onSaveConnection: (fields: ConnectionForm) => Promise<void>;
  onDeleteConnection: (id: string) => Promise<void>;
  onTestConnection: (id: string, capability: string) => Promise<void>;
  onSkip: () => void;
}) {
  const { i18n } = props;
  const t = i18n.t;
  const [form, setForm] = useState<ConnectionForm>(emptyForm);
  const connections = (props.settings?.connections as Connection[] | undefined) ?? [];
  const runtime = String(props.settings?.aiRuntime ?? "native");
  const needsSetup = props.settings?.needsSetup === true;

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

      <SettingsSection title={t("settings.connections")} testId="models-connections">
        {connections.length === 0 ? <p className="detail-muted settings-empty" data-testid="models-empty">{t("models.empty")}</p> : null}
        <ul className="connections">
          {connections.map((connection) => {
            const id = String(connection.id);
            const purpose = String(connection.purpose);
            return (
              <li key={id} className="connection" data-testid={`connection-${id}`}>
                <div>
                  <strong>{String(connection.label)}</strong>
                  <span className="detail-muted"> · {purpose} · {String(connection.protocol)} · {String(connection.runtime ?? "native")}</span>
                </div>
                <div className="detail-muted">{String(connection.baseUrl)} · {String(connection.modelId)}</div>
                <div className="msettings-actions">
                  <button type="button" className="secondary-button" onClick={() => setForm({
                    id,
                    label: String(connection.label),
                    protocol: String(connection.protocol),
                    runtime: String(connection.runtime ?? "native"),
                    baseUrl: String(connection.baseUrl),
                    modelId: String(connection.modelId),
                    purpose,
                    timeoutMs: String(connection.timeoutMs ?? 60_000),
                    secret: "",
                  })}>{t("settings.editConnection")}</button>
                  <button type="button" className="secondary-button" onClick={() => void props.onTestConnection(id, purpose === "transcription" ? "transcription" : purpose === "embedding" ? "embedding" : purpose === "vision" ? "vision" : "text")}>{t("settings.testConnection")}</button>
                  {purpose === "text" ? (
                    <>
                      <button type="button" className="secondary-button" onClick={() => void props.onTestConnection(id, "tools")}>{t("settings.testTools")}</button>
                      <button type="button" className="secondary-button" onClick={() => void props.onTestConnection(id, "streaming")}>{t("settings.testStreaming")}</button>
                      <button type="button" className="secondary-button" data-testid={`test-vision-${id}`} onClick={() => void props.onTestConnection(id, "vision")}>{t("settings.testVision")}</button>
                    </>
                  ) : null}
                  <button type="button" className="link-button" onClick={() => void props.onDeleteConnection(id)}>{t("settings.deleteConnection")}</button>
                </div>
              </li>
            );
          })}
        </ul>
      </SettingsSection>

      <SettingsSection title={form.id ? t("settings.editConnection") : t("models.add")} testId="models-form">
        <form className="connection-form" onSubmit={(event) => { event.preventDefault(); void props.onSaveConnection(form).then(() => setForm(emptyForm())); }}>
          <label className="msettings-field"><span>{t("settings.baseUrl")}</span><input aria-label={t("settings.baseUrl")} value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label>
          <label className="msettings-field"><span>{t("settings.modelId")}</span><input aria-label={t("settings.modelId")} value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} /></label>
          <label className="msettings-field"><span>{t("settings.apiKey")}</span><input type="password" autoComplete="off" aria-label={t("settings.apiKey")} value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} /></label>
          <label className="msettings-field">
            <span>{t("settings.protocol")}</span>
            <select aria-label={t("settings.protocol")} value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value })}>
              <option value="openai-chat-completions">openai-chat-completions</option>
              <option value="openai-responses">openai-responses</option>
            </select>
          </label>
          <label className="msettings-field">
            <span>{t("settings.purpose")}</span>
            <select aria-label={t("settings.purposeText")} value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })}>
              <option value="text">{t("settings.purposeText")}</option>
              <option value="transcription">{t("settings.purposeTranscription")}</option>
              <option value="embedding">{t("settings.purposeEmbedding")}</option>
              <option value="vision">{t("settings.purposeVision")}</option>
            </select>
          </label>
          <label className="msettings-field">
            <span>{t("settings.connectionRuntime")}</span>
            <select aria-label={t("settings.runtime")} value={form.runtime} onChange={(event) => setForm({ ...form, runtime: event.target.value })}>
              <option value="native">{t("settings.runtimeNative")}</option>
              <option value="pi">{t("settings.runtimePi")}</option>
            </select>
          </label>
          <label className="msettings-field"><span>{t("settings.timeoutLabel")}</span><input aria-label={t("settings.timeout")} value={form.timeoutMs} onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })} /></label>
          <div className="msettings-actions">
            <button type="submit" className="primary-button">{t("settings.saveConnection")}</button>
            {form.id ? <button type="button" className="link-button" onClick={() => setForm(emptyForm())}>{t("common.cancel")}</button> : null}
          </div>
        </form>
      </SettingsSection>
    </SettingsPage>
  );
}
