import { useCallback, useEffect, useState } from "react";
import type { Translator } from "@manga/i18n";
import { PROMPT_LIMIT_DEFAULT, PROMPT_LIMIT_MAX, PROMPT_LIMIT_MIN } from "@manga/contracts/creative";
import { attempt } from "../../lib/api.ts";
import type { RecordingPatch, RecordingSettings } from "../../voice/use-recorder.ts";
import { Recording } from "../settings-media.tsx";
import { DictionaryEditor } from "./dictionary-editor.tsx";
import { SettingsEmpty, SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];
type Connection = { id: string; label: string; modelId?: string; purpose: string };
type PromptView = { text: string; included: string[]; total: number; cut: number; limit: number; connectionId: string | null; language: string | null };

const LANGUAGES = ["", "zh", "ja", "en", "ko"] as const;

const clampLimit = (value: number) => Math.max(PROMPT_LIMIT_MIN, Math.min(PROMPT_LIMIT_MAX, Math.round(value)));

/**
 * Voice transcription (AT-76): which connection a recording goes to, the language, how long the dictionary hint may be, the dictionary
 * itself, how an organized text is made, and the recording preferences. Recordings only go to the transcription connection chosen here;
 * the text model sees a transcript only when the person asks to organize it.
 */
export function VoicePage(props: {
  t: T;
  settings: Record<string, unknown> | null;
  recording: { settings: RecordingSettings; save: (patch: RecordingPatch) => Promise<void> };
  onGoto: (page: "models") => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const settings = props.recording.settings;
  const connections = ((props.settings?.connections as Connection[] | undefined) ?? []).filter((connection) => connection.purpose === "transcription");
  const [prompt, setPrompt] = useState<PromptView | null>(null);
  const [previewWork, setPreviewWork] = useState<string | null>(null);

  const loadPrompt = useCallback(async () => {
    const result = await attempt<PromptView>("dictionary.prompt", previewWork ? { workId: previewWork } : {});
    if (result.ok) setPrompt(result.value);
  }, [previewWork]);
  useEffect(() => { void loadPrompt(); }, [loadPrompt, settings.promptChars, settings.promptCharsByConnection]);

  return (
    <SettingsPage id="recording" title={t("voice.title")} hint={t("voice.hint")}>
      <SettingsSection title={t("voice.connection")} testId="voice-connection">
        {connections.length === 0 ? (
          <SettingsRow label={t("voice.connectionNone")} testId="voice-connection-none">
            <button type="button" className="secondary-button" data-testid="voice-goto-models" onClick={() => props.onGoto("models")}>{t("voice.connectionOpen")}</button>
          </SettingsRow>
        ) : connections.map((connection, index) => {
          const own = settings.promptCharsByConnection[connection.id];
          return (
            <SettingsRow key={connection.id} label={connection.label} hint={`${connection.modelId ?? ""}${index === 0 ? ` · ${t("voice.connectionUsed")}` : ""}`} testId={`voice-connection-${connection.id}`} htmlFor={`voice-limit-${connection.id}`}>
              <input id={`voice-limit-${connection.id}`} type="number" min={PROMPT_LIMIT_MIN} max={PROMPT_LIMIT_MAX} step={50} data-testid={`voice-limit-${connection.id}`}
                aria-label={t("voice.promptCharsFor", { name: connection.label })} placeholder={String(settings.promptChars)} value={own ?? ""}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw === "") { void props.recording.save({ promptCharsByConnection: { [connection.id]: null } }); return; }
                  const value = Number(raw);
                  if (Number.isFinite(value)) void props.recording.save({ promptCharsByConnection: { [connection.id]: clampLimit(value) } });
                }} />
            </SettingsRow>
          );
        })}
      </SettingsSection>

      <SettingsSection title={t("voice.language")} testId="voice-language-section">
        <SettingsRow label={t("voice.language")} hint={t("voice.languageHint")} htmlFor="voice-language">
          <select id="voice-language" data-testid="voice-language" value={settings.language ?? ""} onChange={(event) => void props.recording.save({ language: event.target.value || null })}>
            {LANGUAGES.map((code) => <option key={code} value={code}>{t(`voice.language.${code || "auto"}` as "voice.language.auto")}</option>)}
          </select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("voice.dictionary")} hint={t("voice.dictionaryHint")} testId="voice-dictionary">
        <SettingsRow label={t("voice.promptChars")} hint={t("voice.promptCharsHint", { n: PROMPT_LIMIT_DEFAULT })} htmlFor="voice-prompt-chars">
          <input id="voice-prompt-chars" type="number" min={PROMPT_LIMIT_MIN} max={PROMPT_LIMIT_MAX} step={50} data-testid="voice-prompt-chars" value={settings.promptChars}
            onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && event.target.value !== "") void props.recording.save({ promptChars: clampLimit(value) }); }} />
        </SettingsRow>
        <div className="voice-prompt" data-testid="voice-prompt" data-cut={prompt?.cut ?? 0}>
          {prompt === null ? null : prompt.total === 0 ? <p className="detail-muted" data-testid="voice-prompt-empty">{t("voice.promptEmpty")}</p> : (
            <>
              <p className={prompt.cut > 0 ? "voice-prompt-cut" : "detail-muted"} role="status" data-testid="voice-prompt-status">
                {prompt.cut > 0 ? t("voice.promptCut", { cut: prompt.cut, total: prompt.total, used: prompt.included.length }) : t("voice.promptFits", { total: prompt.total })}
              </p>
              <p className="detail-muted">{t("voice.promptPreview")}（{prompt.text.length}/{prompt.limit}）</p>
              <pre className="voice-prompt-text" data-testid="voice-prompt-text">{prompt.text}</pre>
            </>
          )}
        </div>
        <DictionaryEditor t={t} onChanged={() => { void loadPrompt(); }} onError={props.onError} onNotice={props.onNotice} onWork={setPreviewWork} />
      </SettingsSection>

      <SettingsSection title={t("voice.organize")} testId="voice-organize">
        <SettingsRow label={t("voice.organizeGlossary")} hint={t("voice.organizeHint")} />
      </SettingsSection>

      <Recording t={t} settings={settings} save={props.recording.save} onNotice={props.onNotice} />
    </SettingsPage>
  );
}
