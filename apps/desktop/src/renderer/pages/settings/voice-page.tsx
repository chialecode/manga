import { useCallback, useEffect, useState } from "react";
import {
  PROMPT_LIMIT_DEFAULT,
  PROMPT_LIMIT_MAX,
  PROMPT_LIMIT_MIN,
  type DictationHistoryItem,
  type LocalAsrModelItem,
} from "@manga/contracts";
import { chordLabel, type KeyTable } from "@manga/contracts/keys";
import type { Translator } from "@manga/i18n";
import { NumberField } from "../../components/number-field.tsx";
import { useAsyncGuard } from "../../hooks/use-async-guard.ts";
import { asArray, attempt } from "../../lib/api.ts";
import type { RecordingPatch, RecordingSettings } from "../../voice/use-recorder.ts";
import { Recording } from "../settings-media.tsx";
import { DictionaryEditor } from "./dictionary-editor.tsx";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";
import { DictationSection, ReadAloudSection, type VoiceConnection } from "./voice-dictation-section.tsx";
import { VoiceEnginesSection } from "./voice-engines-section.tsx";
import { VoiceHistorySection } from "./voice-history-section.tsx";

type T = Translator["t"];
type PromptView = { text: string; included: string[]; total: number; cut: number; limit: number; connectionId: string | null; language: string | null };

/**
 * Settings › Voice Transcription: organized into Dictation, Recognition Engines (local offline models + external connections),
 * Read Aloud, Audio & Recording, Dictionary, and Dictation History.
 */
export function VoicePage(props: {
  t: T;
  settings: Record<string, unknown> | null;
  recording: { settings: RecordingSettings; save: (patch: RecordingPatch) => Promise<boolean> };
  keyTable?: KeyTable;
  formatDate?: (value: string) => string;
  onGoto: (page: "models" | "shortcuts") => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const settings = props.recording.settings;
  const allConnections = (props.settings?.connections as VoiceConnection[] | undefined) ?? [];
  const connections = allConnections.filter((connection) => connection.purpose === "transcription");
  const textConnections = allConnections.filter((connection) => connection.purpose === "text" || connection.purpose === "vision");
  const speechConnections = allConnections.filter((connection) => connection.purpose === "speech");

  const [prompt, setPrompt] = useState<PromptView | null>(null);
  const [previewWork, setPreviewWork] = useState<string | null>(null);
  const [models, setModels] = useState<LocalAsrModelItem[]>([]);
  const [history, setHistory] = useState<DictationHistoryItem[]>([]);

  const promptGuard = useAsyncGuard();
  const modelsGuard = useAsyncGuard();
  const historyGuard = useAsyncGuard();

  const loadPrompt = useCallback(async () => {
    const token = promptGuard.next();
    const result = await attempt<PromptView>("dictionary.prompt", previewWork ? { workId: previewWork } : {});
    if (promptGuard.isCurrent(token) && result.ok) setPrompt(result.value);
  }, [previewWork, promptGuard]);

  const loadModels = useCallback(async () => {
    const token = modelsGuard.next();
    const result = await attempt<{ models?: LocalAsrModelItem[]; items?: LocalAsrModelItem[] } | LocalAsrModelItem[]>("asrModel.list", {});
    if (!modelsGuard.isCurrent(token) || !result.ok) return;
    const list = Array.isArray(result.value) ? result.value : (result.value.models ?? result.value.items);
    setModels(asArray<LocalAsrModelItem>(list));
  }, [modelsGuard]);

  const loadHistory = useCallback(async () => {
    const token = historyGuard.next();
    const result = await attempt<{ items?: DictationHistoryItem[]; history?: DictationHistoryItem[] } | DictationHistoryItem[]>("dictation.history.list", { limit: 50 });
    if (!historyGuard.isCurrent(token) || !result.ok) return;
    const list = Array.isArray(result.value) ? result.value : (result.value.items ?? result.value.history);
    setHistory(asArray<DictationHistoryItem>(list));
  }, [historyGuard]);

  useEffect(() => {
    void loadPrompt();
  }, [loadPrompt, settings.promptChars, settings.promptCharsByConnection]);

  useEffect(() => {
    void loadModels();
    void loadHistory();
  }, [loadModels, loadHistory]);

  useEffect(() => {
    const off = window.manga?.onNotice?.((notice) => {
      if (notice.topic === "asrModel.changed" || notice.topic === "job.changed") void loadModels();
      if (notice.topic === "dictation.changed") void loadHistory();
    });
    return () => { off?.(); };
  }, [loadHistory, loadModels]);

  const installedModels = models.filter((item) => item.state === "installed" || item.state === "loading" || item.state === "ready");
  const engineOptions: Array<{ value: string; label: string }> = [
    ...installedModels.map((item) => ({ value: `local:${item.modelId}`, label: t("voice.engine.localPrefix", { name: item.name }) })),
    ...connections.map((item) => ({ value: `connection:${item.id}`, label: t("voice.engine.connectionPrefix", { name: item.label }) })),
  ];

  const shortcutChords = props.keyTable?.["global.dictationHold"] ?? [settings.dictationHoldKey || "RightAlt"];
  const shortcutDisplay = shortcutChords.map((chord) => chordLabel(chord)).join(" / ");

  return (
    <SettingsPage id="recording" title={t("voice.title")} hint={t("voice.hint")}>
      <DictationSection
        t={t}
        settings={settings}
        shortcutDisplay={shortcutDisplay}
        textConnections={textConnections}
        save={props.recording.save}
        onGoto={props.onGoto}
        onNotice={props.onNotice}
      />

      <VoiceEnginesSection
        t={t}
        settings={settings}
        models={models}
        connections={connections}
        engineOptions={engineOptions}
        save={props.recording.save}
        reloadModels={loadModels}
        onGoto={props.onGoto}
        onError={props.onError}
        onNotice={props.onNotice}
      />

      <ReadAloudSection
        t={t}
        settings={settings}
        connections={speechConnections}
        save={props.recording.save}
        onGoto={props.onGoto}
      />

      <SettingsSection title={t("voice.section.audio")} hint={t("voice.section.audioHint")} testId="voice-audio-section">
        <SettingsRow label={t("voice.audio.aec")} hint={t("voice.audio.aecHint")} htmlFor="voice-aec">
          <input id="voice-aec" type="checkbox" data-testid="voice-aec" checked={settings.echoCancellation} onChange={(event) => void props.recording.save({ echoCancellation: event.target.checked })} />
        </SettingsRow>
        <SettingsRow label={t("voice.audio.systemAec")} hint={t("voice.audio.systemAecHint")} htmlFor="voice-system-aec">
          <input id="voice-system-aec" type="checkbox" data-testid="voice-system-aec" checked={settings.systemLoopbackAec} onChange={(event) => void props.recording.save({ systemLoopbackAec: event.target.checked })} />
        </SettingsRow>
        <SettingsRow label={t("voice.audio.gtcrn")} hint={t("voice.audio.gtcrnHint")} htmlFor="voice-gtcrn">
          <input id="voice-gtcrn" type="checkbox" data-testid="voice-gtcrn" checked={settings.gtcrnDenoise} onChange={(event) => void props.recording.save({ gtcrnDenoise: event.target.checked })} />
        </SettingsRow>
        <SettingsRow label={t("voice.audio.browserNs")} hint={t("voice.audio.browserNsHint")} htmlFor="voice-browser-ns">
          <input id="voice-browser-ns" type="checkbox" data-testid="voice-browser-ns" checked={settings.browserNoiseSuppression} onChange={(event) => void props.recording.save({ browserNoiseSuppression: event.target.checked })} />
        </SettingsRow>
        <SettingsRow label={t("voice.audio.agc")} htmlFor="voice-agc">
          <input id="voice-agc" type="checkbox" data-testid="voice-agc" checked={settings.autoGainControl} onChange={(event) => void props.recording.save({ autoGainControl: event.target.checked })} />
        </SettingsRow>
        <Recording t={t} settings={settings} save={props.recording.save} onNotice={props.onNotice} keyTable={props.keyTable} />
      </SettingsSection>

      <SettingsSection title={t("voice.dictionary")} hint={t("voice.dictionaryHint")} testId="voice-dictionary">
        <SettingsRow label={t("voice.promptChars")} hint={t("voice.promptCharsHint", { n: PROMPT_LIMIT_DEFAULT })} htmlFor="voice-prompt-chars">
          <NumberField
            id="voice-prompt-chars"
            min={PROMPT_LIMIT_MIN}
            max={PROMPT_LIMIT_MAX}
            step={50}
            integer
            testId="voice-prompt-chars"
            value={settings.promptChars}
            onCommit={(promptChars) => { void props.recording.save({ promptChars }); }}
          />
        </SettingsRow>
        <div className="voice-prompt" data-testid="voice-prompt" data-cut={prompt?.cut ?? 0}>
          {prompt === null ? null : prompt.total === 0 ? <p className="detail-muted" data-testid="voice-prompt-empty">{t("voice.promptEmpty")}</p> : (
            <>
              <p className={prompt.cut > 0 ? "voice-prompt-cut" : "detail-muted"} role="status" data-testid="voice-prompt-status">
                {prompt.cut > 0 ? t("voice.promptCut", { cut: prompt.cut, total: prompt.total, used: prompt.included.length }) : t("voice.promptFits", { total: prompt.total })}
              </p>
              <p className="detail-muted">{`${t("voice.promptPreview")} (${prompt.text.length}/${prompt.limit})`}</p>
              <pre className="voice-prompt-text" data-testid="voice-prompt-text">{prompt.text}</pre>
            </>
          )}
        </div>
        <DictionaryEditor t={t} onChanged={() => { void loadPrompt(); }} onError={props.onError} onNotice={props.onNotice} onWork={setPreviewWork} />
      </SettingsSection>

      <VoiceHistorySection
        t={t}
        settings={settings}
        history={history}
        engineOptions={engineOptions}
        formatDate={props.formatDate}
        save={props.recording.save}
        reloadHistory={loadHistory}
        onError={props.onError}
        onNotice={props.onNotice}
      />
    </SettingsPage>
  );
}
