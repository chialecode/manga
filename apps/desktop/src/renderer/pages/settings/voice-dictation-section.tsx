import { useEffect, useState } from "react";
import {
  CHINESE_VARIANTS,
  DICTATION_INSERT_MODES,
  POLISH_MODES,
  type ChineseVariant,
  type DictationInsertMode,
  type PolishMode,
} from "@manga/contracts";
import type { MessageKey, Translator } from "@manga/i18n";
import { readAloud, readAloudProblem, useReadAloud } from "../../voice/read-aloud.ts";
import type { RecordingPatch, RecordingSettings } from "../../voice/use-recorder.ts";
import { SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];

export type VoiceConnection = {
  id: string;
  label: string;
  modelId?: string;
  purpose: string;
  adapterId?: string;
  account?: unknown;
  profile?: { transcriptionInterface?: string };
};

function insertModeLabel(t: T, mode: DictationInsertMode): string {
  return t(`voice.dictation.insertMode.${mode}` as MessageKey);
}

export function polishModeLabel(t: T, mode: PolishMode): string {
  return t(`voice.dictation.polishMode.${mode}` as MessageKey);
}

function chineseVariantLabel(t: T, variant: ChineseVariant): string {
  return t(`voice.dictation.chineseVariant.${variant}` as MessageKey);
}

/** Section 1 of Settings › Voice: dictation shortcut, insert/polish/variant options, and custom polish prompts. */
export function DictationSection(props: {
  t: T;
  settings: RecordingSettings;
  shortcutDisplay: string;
  textConnections: VoiceConnection[];
  save: (patch: RecordingPatch) => Promise<boolean>;
  onGoto: (page: "models" | "shortcuts") => void;
  onNotice: (message: string) => void;
}) {
  const { t, settings } = props;
  const [lightPrompt, setLightPrompt] = useState(settings.polishPrompts?.light ?? "");
  const [formalPrompt, setFormalPrompt] = useState(settings.polishPrompts?.formal ?? "");
  const [savingPrompt, setSavingPrompt] = useState(false);

  useEffect(() => {
    setLightPrompt(settings.polishPrompts?.light ?? "");
    setFormalPrompt(settings.polishPrompts?.formal ?? "");
  }, [settings.polishPrompts?.light, settings.polishPrompts?.formal]);

  async function savePrompts(next: { light: string | null; formal: string | null }) {
    if (savingPrompt) return;
    setSavingPrompt(true);
    try {
      const ok = await props.save({ polishPrompts: next });
      if (ok) props.onNotice(t("voice.dictation.promptSaved"));
    } finally {
      setSavingPrompt(false);
    }
  }

  return (
    <SettingsSection title={t("voice.section.dictation")} hint={t("voice.section.dictationHint")} testId="voice-dictation-section">
      <SettingsRow label={t("voice.dictation.shortcut")}>
        <div className="msettings-actions">
          <kbd data-testid="voice-dictation-shortcut">{props.shortcutDisplay}</kbd>
          <button type="button" className="secondary-button" data-testid="voice-goto-shortcuts" onClick={() => props.onGoto("shortcuts")}>{t("voice.dictation.gotoShortcuts")}</button>
        </div>
      </SettingsRow>
      <SettingsRow label={t("voice.dictation.insertMode")} htmlFor="voice-insert-mode">
        <select
          id="voice-insert-mode"
          data-testid="voice-insert-mode"
          value={settings.dictationInsertMode}
          onChange={(event) => void props.save({ dictationInsertMode: event.target.value as DictationInsertMode })}
        >
          {DICTATION_INSERT_MODES.map((item) => <option key={item} value={item}>{insertModeLabel(t, item)}</option>)}
        </select>
      </SettingsRow>
      <SettingsRow label={t("voice.dictation.polishMode")} htmlFor="voice-polish-mode">
        <select
          id="voice-polish-mode"
          data-testid="voice-polish-mode"
          value={settings.polishMode}
          onChange={(event) => void props.save({ polishMode: event.target.value as PolishMode })}
        >
          {POLISH_MODES.map((item) => <option key={item} value={item}>{polishModeLabel(t, item)}</option>)}
        </select>
      </SettingsRow>
      <SettingsRow label={t("voice.dictation.polishConnection")} htmlFor="voice-polish-connection">
        <select
          id="voice-polish-connection"
          data-testid="voice-polish-connection"
          value={settings.polishConnectionId ?? ""}
          onChange={(event) => void props.save({ polishConnectionId: event.target.value || null })}
        >
          <option value="">{t("voice.dictation.polishConnectionDefault")}</option>
          {props.textConnections.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </SettingsRow>
      <SettingsRow label={t("voice.dictation.chineseVariant")} htmlFor="voice-chinese-variant">
        <select
          id="voice-chinese-variant"
          data-testid="voice-chinese-variant"
          value={settings.chineseVariant}
          onChange={(event) => void props.save({ chineseVariant: event.target.value as ChineseVariant })}
        >
          {CHINESE_VARIANTS.map((item) => <option key={item} value={item}>{chineseVariantLabel(t, item)}</option>)}
        </select>
      </SettingsRow>
      <div className="msettings-subgroup" data-testid="voice-organize">
        <h4>{t("voice.organize")}</h4>
        <p className="detail-muted">{`${t("voice.organizeGlossary")} - ${t("voice.organizeHint")}`}</p>
        <label className="review-edit">
          <span>{t("voice.dictation.promptLight")}</span>
          <textarea
            className="voice-prompt-textarea"
            data-testid="voice-polish-prompt-light"
            disabled={savingPrompt}
            value={lightPrompt}
            onChange={(event) => setLightPrompt(event.target.value)}
          />
        </label>
        <label className="review-edit">
          <span>{t("voice.dictation.promptFormal")}</span>
          <textarea
            className="voice-prompt-textarea"
            data-testid="voice-polish-prompt-formal"
            disabled={savingPrompt}
            value={formalPrompt}
            onChange={(event) => setFormalPrompt(event.target.value)}
          />
        </label>
        <div className="msettings-actions">
          <button
            type="button"
            className="secondary-button"
            data-testid="voice-polish-prompt-save"
            disabled={savingPrompt}
            onClick={() => void savePrompts({ light: lightPrompt.trim() || null, formal: formalPrompt.trim() || null })}
          >
            {t("voice.dictation.promptSave")}
          </button>
          <button
            type="button"
            className="link-button"
            data-testid="voice-polish-prompt-reset"
            disabled={savingPrompt}
            onClick={() => {
              setLightPrompt("");
              setFormalPrompt("");
              void savePrompts({ light: null, formal: null });
            }}
          >
            {t("voice.dictation.promptReset")}
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}

/** The speech connection, the voice, and a preview read with them. Stops its own preview when unmounted. */
export function ReadAloudSection(props: {
  t: T;
  settings: RecordingSettings;
  connections: VoiceConnection[];
  save: (patch: RecordingPatch) => Promise<boolean>;
  onGoto: (page: "models" | "shortcuts") => void;
}) {
  const { t, settings } = props;
  const state = useReadAloud();
  const previewing = state.owner === "preview:voice" && state.status !== "idle" && state.status !== "error";
  const problem = state.owner === "preview:voice" && state.status === "error" ? readAloudProblem(state.error) : null;

  useEffect(() => () => {
    if (readAloud.getState().owner === "preview:voice") readAloud.stop();
  }, []);

  return (
    <SettingsSection title={t("readAloud.section")} hint={t("readAloud.sectionHint")} testId="voice-read-aloud-section">
      {props.connections.length === 0 ? (
        <SettingsRow label={t("readAloud.connection")} hint={t("readAloud.noConnection")}>
          <button type="button" className="secondary-button" data-testid="voice-read-goto-models" onClick={() => props.onGoto("models")}>{t("voice.connectionOpen")}</button>
        </SettingsRow>
      ) : (
        <>
          <SettingsRow label={t("readAloud.connection")} htmlFor="voice-read-connection">
            <select id="voice-read-connection" data-testid="voice-read-connection" value={settings.speechConnectionId ?? ""} onChange={(event) => void props.save({ speechConnectionId: event.target.value || null })}>
              <option value="">{t("readAloud.connectionFirst")}</option>
              {props.connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.label}</option>)}
            </select>
          </SettingsRow>
          <SettingsRow label={t("readAloud.voice")} htmlFor="voice-read-voice">
            <select id="voice-read-voice" data-testid="voice-read-voice" value={settings.speechVoice} onChange={(event) => void props.save({ speechVoice: event.target.value as "stella" | "tide" })}>
              <option value="stella">{t("readAloud.voice.stella")}</option>
              <option value="tide">{t("readAloud.voice.tide")}</option>
            </select>
          </SettingsRow>
          <SettingsRow label={t("readAloud.preview")} hint={problem ? t(problem.key as MessageKey) : t("readAloud.previewHint")}>
            {previewing
              ? <button type="button" className="secondary-button" data-testid="voice-read-preview-stop" onClick={() => readAloud.stop()}>{t("readAloud.stop")}</button>
              : <button type="button" className="secondary-button" data-testid="voice-read-preview" onClick={() => void readAloud.play({ owner: "preview:voice", segments: [t("readAloud.previewText")], task: "test", voice: settings.speechVoice, ...(settings.speechConnectionId ? { connectionId: settings.speechConnectionId } : {}) })}>{t("readAloud.previewPlay")}</button>}
          </SettingsRow>
          <SettingsRow label={t("readAloud.novelHint")} htmlFor="voice-read-novel-hint">
            <input id="voice-read-novel-hint" type="checkbox" data-testid="voice-read-novel-hint" checked={settings.novelCostHint} onChange={(event) => void props.save({ novelCostHint: event.target.checked })} />
          </SettingsRow>
        </>
      )}
    </SettingsSection>
  );
}
