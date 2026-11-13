import { useCallback, useEffect, useState } from "react";
import {
  CHINESE_VARIANTS,
  DICTATION_INSERT_MODES,
  POLISH_MODES,
  PROMPT_LIMIT_DEFAULT,
  PROMPT_LIMIT_MAX,
  PROMPT_LIMIT_MIN,
  type AsrEngineSelection,
  type ChineseVariant,
  type DictationHistoryItem,
  type DictationInsertMode,
  type LocalAsrModelItem,
  type PolishMode,
} from "@manga/contracts";
import { chordLabel, type KeyTable } from "@manga/contracts/keys";
import type { MessageKey, Translator } from "@manga/i18n";
import { Modal } from "../../components/modal.tsx";
import { asArray, attempt } from "../../lib/api.ts";
import type { RecordingPatch, RecordingSettings } from "../../voice/use-recorder.ts";
import { Recording } from "../settings-media.tsx";
import { DictionaryEditor } from "./dictionary-editor.tsx";
import { SettingsEmpty, SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];
type Connection = { id: string; label: string; modelId?: string; purpose: string };
type PromptView = { text: string; included: string[]; total: number; cut: number; limit: number; connectionId: string | null; language: string | null };

const LANGUAGES = ["", "zh", "ja", "en", "ko"] as const;
const clampLimit = (value: number) => Math.max(PROMPT_LIMIT_MIN, Math.min(PROMPT_LIMIT_MAX, Math.round(value)));
const mibOf = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

function encodeEngine(selection: AsrEngineSelection | null | undefined): string {
  if (!selection) return "";
  return selection.kind === "local" ? `local:${selection.modelId}` : `connection:${selection.connectionId}`;
}

function decodeEngine(value: string): AsrEngineSelection | null {
  if (!value) return null;
  if (value.startsWith("local:")) return { kind: "local", modelId: value.slice("local:".length) };
  if (value.startsWith("connection:")) return { kind: "connection", connectionId: value.slice("connection:".length) };
  return null;
}

function modelStateLabel(t: T, state: LocalAsrModelItem["state"]): string {
  return t(`voice.model.state.${state}` as MessageKey);
}

function insertModeLabel(t: T, mode: DictationInsertMode): string {
  return t(`voice.dictation.insertMode.${mode}` as MessageKey);
}

function polishModeLabel(t: T, mode: PolishMode): string {
  return t(`voice.dictation.polishMode.${mode}` as MessageKey);
}

function chineseVariantLabel(t: T, variant: ChineseVariant): string {
  return t(`voice.dictation.chineseVariant.${variant}` as MessageKey);
}

function historyFallbackLabel(t: T, fallback: string | null): string | null {
  if (!fallback) return null;
  const lower = fallback.toLowerCase();
  if (lower.includes("timeout")) return t("dictation.fallback.timeout");
  if (lower.includes("length")) return t("dictation.fallback.length");
  if (lower.includes("entity") || lower.includes("proper")) return t("dictation.fallback.entity");
  if (lower.includes("unconfigured") || lower.includes("no_connection")) return t("dictation.fallback.unconfigured");
  return t("dictation.fallback.error");
}

/**
 * Settings › Voice Transcription: organized into Dictation, Recognition Engines (local offline models + external connections),
 * Audio & Recording, Dictionary, and Dictation History.
 */
export function VoicePage(props: {
  t: T;
  settings: Record<string, unknown> | null;
  recording: { settings: RecordingSettings; save: (patch: RecordingPatch) => Promise<void> };
  keyTable?: KeyTable;
  formatDate?: (value: string) => string;
  onGoto: (page: "models" | "shortcuts") => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const settings = props.recording.settings;
  const allConnections = (props.settings?.connections as Connection[] | undefined) ?? [];
  const connections = allConnections.filter((connection) => connection.purpose === "transcription");
  const textConnections = allConnections.filter((connection) => connection.purpose === "text" || connection.purpose === "vision");

  const [prompt, setPrompt] = useState<PromptView | null>(null);
  const [previewWork, setPreviewWork] = useState<string | null>(null);
  const [models, setModels] = useState<LocalAsrModelItem[]>([]);
  const [confirmingModel, setConfirmingModel] = useState<{ model: LocalAsrModelItem; sourceId: string } | null>(null);
  const [history, setHistory] = useState<DictationHistoryItem[]>([]);
  const [retranscribeEngine, setRetranscribeEngine] = useState<Record<string, string>>({});
  const [lightPrompt, setLightPrompt] = useState(settings.polishPrompts?.light ?? "");
  const [formalPrompt, setFormalPrompt] = useState(settings.polishPrompts?.formal ?? "");

  useEffect(() => {
    setLightPrompt(settings.polishPrompts?.light ?? "");
    setFormalPrompt(settings.polishPrompts?.formal ?? "");
  }, [settings.polishPrompts?.light, settings.polishPrompts?.formal]);

  const loadPrompt = useCallback(async () => {
    const result = await attempt<PromptView>("dictionary.prompt", previewWork ? { workId: previewWork } : {});
    if (result.ok) setPrompt(result.value);
  }, [previewWork]);

  const loadModels = useCallback(async () => {
    const result = await attempt<{ models?: LocalAsrModelItem[]; items?: LocalAsrModelItem[] } | LocalAsrModelItem[]>("asrModel.list", {});
    if (result.ok) {
      const list = Array.isArray(result.value) ? result.value : (result.value.models ?? result.value.items);
      setModels(asArray<LocalAsrModelItem>(list));
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const result = await attempt<{ items?: DictationHistoryItem[]; history?: DictationHistoryItem[] } | DictationHistoryItem[]>("dictation.history.list", { limit: 50 });
    if (result.ok) {
      const list = Array.isArray(result.value) ? result.value : (result.value.items ?? result.value.history);
      setHistory(asArray<DictationHistoryItem>(list));
    }
  }, []);

  useEffect(() => {
    void loadPrompt();
  }, [loadPrompt, settings.promptChars, settings.promptCharsByConnection]);

  useEffect(() => {
    void loadModels();
    void loadHistory();
  }, [loadModels, loadHistory]);

  useEffect(() => {
    const off = window.manga?.onNotice?.((notice) => {
      if (notice.topic === "asrModel.changed" || notice.topic === "job.changed") {
        void loadModels();
      }
      if (notice.topic === "dictation.changed") {
        void loadHistory();
      }
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

  async function confirmDownload() {
    if (!confirmingModel) return;
    const { model, sourceId } = confirmingModel;
    setConfirmingModel(null);
    const result = await attempt("asrModel.download", {
      modelId: model.modelId,
      confirmed: true,
      ...(sourceId ? { sourceId } : {}),
    });
    if (!result.ok) {
      props.onError(result.error.message);
      return;
    }
    await loadModels();
  }

  async function runModelAction(commandId: string, input: Record<string, unknown>, onSuccessNotice?: (val: Record<string, unknown>) => void) {
    const result = await attempt<Record<string, unknown>>(commandId, input);
    if (!result.ok) {
      props.onError(result.error.message);
      return;
    }
    onSuccessNotice?.(result.value);
    await loadModels();
  }

  async function importModel(model: LocalAsrModelItem, importKind: "archive" | "directory") {
    let pathHandle: string | null = null;
    if (window.manga?.pick) {
      const picked = await window.manga.pick({ mode: importKind === "directory" ? "directory" : "file", ...(importKind === "archive" ? { filter: "any" as const } : {}) });
      pathHandle = picked?.pathHandle ?? null;
    } else if (importKind === "directory" && window.manga?.chooseDirectory) {
      pathHandle = await window.manga.chooseDirectory();
    } else if (importKind === "archive" && window.manga?.choosePath) {
      pathHandle = await window.manga.choosePath();
    }
    if (!pathHandle) return;
    await runModelAction("asrModel.import", { modelId: model.modelId, pathHandle, kind: importKind }, () => {
      props.onNotice(t("voice.model.imported", { name: model.name }));
    });
  }

  async function copyHistoryText(text: string) {
    try {
      await navigator.clipboard?.writeText?.(text);
      props.onNotice(t("dictation.notice.copied"));
    } catch {
      // Clipboard may be unavailable in headless tests
    }
  }

  async function retranscribeItem(item: DictationHistoryItem) {
    const chosen = retranscribeEngine[item.id] ?? engineOptions[0]?.value ?? "";
    const engine = decodeEngine(chosen);
    if (!engine) return;
    const result = await attempt("dictation.history.retranscribe", { historyId: item.id, engine });
    if (!result.ok) {
      props.onError(result.error.message);
      return;
    }
    props.onNotice(t("voice.history.retranscribed"));
    await loadHistory();
  }

  return (
    <SettingsPage id="recording" title={t("voice.title")} hint={t("voice.hint")}>
      {/* 1. Dictation */}
      <SettingsSection title={t("voice.section.dictation")} hint={t("voice.section.dictationHint")} testId="voice-dictation-section">
        <SettingsRow label={t("voice.dictation.shortcut")}>
          <div className="msettings-actions">
            <kbd data-testid="voice-dictation-shortcut">{shortcutDisplay}</kbd>
            <button type="button" className="secondary-button" data-testid="voice-goto-shortcuts" onClick={() => props.onGoto("shortcuts")}>{t("voice.dictation.gotoShortcuts")}</button>
          </div>
        </SettingsRow>
        <SettingsRow label={t("voice.dictation.insertMode")} htmlFor="voice-insert-mode">
          <select
            id="voice-insert-mode"
            data-testid="voice-insert-mode"
            value={settings.dictationInsertMode}
            onChange={(event) => void props.recording.save({ dictationInsertMode: event.target.value as DictationInsertMode })}
          >
            {DICTATION_INSERT_MODES.map((item) => <option key={item} value={item}>{insertModeLabel(t, item)}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t("voice.dictation.polishMode")} htmlFor="voice-polish-mode">
          <select
            id="voice-polish-mode"
            data-testid="voice-polish-mode"
            value={settings.polishMode}
            onChange={(event) => void props.recording.save({ polishMode: event.target.value as PolishMode })}
          >
            {POLISH_MODES.map((item) => <option key={item} value={item}>{polishModeLabel(t, item)}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t("voice.dictation.polishConnection")} htmlFor="voice-polish-connection">
          <select
            id="voice-polish-connection"
            data-testid="voice-polish-connection"
            value={settings.polishConnectionId ?? ""}
            onChange={(event) => void props.recording.save({ polishConnectionId: event.target.value || null })}
          >
            <option value="">{t("voice.dictation.polishConnectionDefault")}</option>
            {textConnections.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t("voice.dictation.chineseVariant")} htmlFor="voice-chinese-variant">
          <select
            id="voice-chinese-variant"
            data-testid="voice-chinese-variant"
            value={settings.chineseVariant}
            onChange={(event) => void props.recording.save({ chineseVariant: event.target.value as ChineseVariant })}
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
              value={lightPrompt}
              onChange={(event) => setLightPrompt(event.target.value)}
            />
          </label>
          <label className="review-edit">
            <span>{t("voice.dictation.promptFormal")}</span>
            <textarea
              className="voice-prompt-textarea"
              data-testid="voice-polish-prompt-formal"
              value={formalPrompt}
              onChange={(event) => setFormalPrompt(event.target.value)}
            />
          </label>
          <div className="msettings-actions">
            <button
              type="button"
              className="secondary-button"
              data-testid="voice-polish-prompt-save"
              onClick={() => {
                void props.recording.save({
                  polishPrompts: {
                    light: lightPrompt.trim() || null,
                    formal: formalPrompt.trim() || null,
                  },
                }).then(() => props.onNotice(t("voice.dictation.promptSaved")));
              }}
            >
              {t("voice.dictation.promptSave")}
            </button>
            <button
              type="button"
              className="link-button"
              data-testid="voice-polish-prompt-reset"
              onClick={() => {
                setLightPrompt("");
                setFormalPrompt("");
                void props.recording.save({ polishPrompts: { light: null, formal: null } }).then(() => props.onNotice(t("voice.dictation.promptSaved")));
              }}
            >
              {t("voice.dictation.promptReset")}
            </button>
          </div>
        </div>
      </SettingsSection>

      {/* 2. Recognition Engines */}
      <SettingsSection title={t("voice.section.engines")} hint={t("voice.section.enginesHint")} testId="voice-engines-section">
        <SettingsRow label={t("voice.engine.dictation")} htmlFor="voice-dictation-engine">
          <select
            id="voice-dictation-engine"
            data-testid="voice-dictation-engine"
            value={encodeEngine(settings.dictationEngine)}
            onChange={(event) => void props.recording.save({ dictationEngine: decodeEngine(event.target.value) })}
          >
            <option value="">{t("voice.engine.auto")}</option>
            {engineOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t("voice.engine.capture")} htmlFor="voice-capture-engine">
          <select
            id="voice-capture-engine"
            data-testid="voice-capture-engine"
            value={encodeEngine(settings.captureEngine)}
            onChange={(event) => void props.recording.save({ captureEngine: decodeEngine(event.target.value) })}
          >
            <option value="">{t("voice.engine.auto")}</option>
            {engineOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t("voice.engine.idleMinutes")} htmlFor="voice-idle-minutes">
          <input
            id="voice-idle-minutes"
            type="number"
            min={1}
            max={120}
            data-testid="voice-idle-minutes"
            value={settings.localIdleMinutes}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && event.target.value !== "") {
                void props.recording.save({ localIdleMinutes: Math.max(1, Math.min(120, Math.round(value))) });
              }
            }}
          />
        </SettingsRow>

        <div className="msettings-subgroup" data-testid="voice-local-models">
          <h4>{t("voice.localModels")}</h4>
          {models.length === 0 ? (
            <SettingsEmpty text={t("voice.localModelsEmpty")} testId="voice-local-models-empty" />
          ) : (
            <ul className="voice-models">
              {models.map((model) => {
                const stateText = modelStateLabel(t, model.state);
                const bytes = model.installedBytes ?? model.archiveBytes;
                const sizeMb = mibOf(bytes);
                const total = model.totalBytes && model.totalBytes > 0 ? model.totalBytes : model.archiveBytes;
                const pct = model.downloadedBytes && total > 0 ? Math.min(100, Math.round((model.downloadedBytes / total) * 100)) : 0;
                const canInstall = model.state === "not_installed" || model.state === "failed" || model.state === "load_failed";
                const canDelete = model.state === "installed" || model.state === "ready" || model.state === "load_failed";
                return (
                  <li key={model.modelId} className="voice-model-card" data-testid={`voice-model-${model.modelId}`} data-state={model.state}>
                    <div className="voice-model-head">
                      <div>
                        <strong>{model.name}</strong>
                        <span className="detail-muted">{` · ${t("voice.model.size", { mb: sizeMb })} · ${model.languages.join(", ")}`}</span>
                      </div>
                      <span className="msettings-actions">
                        <span className="chip">{model.hotwords > 0 ? t("voice.model.hotwordYes") : t("voice.model.hotwordNo")}</span>
                        <span className="chip" data-testid={`voice-model-state-${model.modelId}`}>{stateText}</span>
                      </span>
                    </div>
                    <div className="detail-muted">{t("voice.model.license", { license: model.license })}</div>
                    {model.state === "downloading" || model.state === "paused" ? (
                      <div className="voice-model-progress" data-testid={`voice-model-progress-${model.modelId}`}>
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    ) : null}
                    {model.errorMessage ? <div className="review-error">{model.errorMessage}</div> : null}
                    <div className="msettings-actions">
                      {canInstall ? (
                        <>
                          <button
                            type="button"
                            className="primary-button"
                            data-testid={`voice-model-download-${model.modelId}`}
                            onClick={() => setConfirmingModel({ model, sourceId: model.sources?.[0]?.id ?? "" })}
                          >
                            {t("voice.model.download")}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            data-testid={`voice-model-import-archive-${model.modelId}`}
                            onClick={() => void importModel(model, "archive")}
                          >
                            {t("voice.model.importArchive")}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            data-testid={`voice-model-import-dir-${model.modelId}`}
                            onClick={() => void importModel(model, "directory")}
                          >
                            {t("voice.model.importDirectory")}
                          </button>
                        </>
                      ) : null}
                      {model.state === "downloading" ? (
                        <>
                          <button type="button" className="secondary-button" data-testid={`voice-model-pause-${model.modelId}`} onClick={() => void runModelAction("asrModel.pause", { modelId: model.modelId })}>{t("voice.model.pause")}</button>
                          <button type="button" className="link-button" data-testid={`voice-model-cancel-${model.modelId}`} onClick={() => void runModelAction("asrModel.cancel", { modelId: model.modelId })}>{t("voice.model.cancel")}</button>
                        </>
                      ) : null}
                      {model.state === "paused" ? (
                        <>
                          <button type="button" className="primary-button" data-testid={`voice-model-resume-${model.modelId}`} onClick={() => void runModelAction("asrModel.download", { modelId: model.modelId, confirmed: true })}>{t("voice.model.resume")}</button>
                          <button type="button" className="link-button" data-testid={`voice-model-cancel-${model.modelId}`} onClick={() => void runModelAction("asrModel.cancel", { modelId: model.modelId })}>{t("voice.model.cancel")}</button>
                        </>
                      ) : null}
                      {canDelete ? (
                        <button
                          type="button"
                          className="link-button"
                          data-testid={`voice-model-delete-${model.modelId}`}
                          onClick={() => void runModelAction("asrModel.delete", { modelId: model.modelId }, (val) => {
                            const freed = typeof val.freedBytes === "number" ? mibOf(val.freedBytes) : sizeMb;
                            props.onNotice(t("voice.model.deleted", { mb: freed }));
                          })}
                        >
                          {t("voice.model.delete")}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="msettings-subgroup" data-testid="voice-connection">
          <h4>{t("voice.connection")}</h4>
          {connections.length === 0 ? (
            <SettingsRow label={t("voice.connectionNone")} testId="voice-connection-none">
              <button type="button" className="secondary-button" data-testid="voice-goto-models" onClick={() => props.onGoto("models")}>{t("voice.connectionOpen")}</button>
            </SettingsRow>
          ) : connections.map((connection, index) => {
            const own = settings.promptCharsByConnection[connection.id];
            return (
              <SettingsRow key={connection.id} label={connection.label} hint={`${connection.modelId ?? ""}${index === 0 ? ` · ${t("voice.connectionUsed")}` : ""}`} testId={`voice-connection-${connection.id}`} htmlFor={`voice-limit-${connection.id}`}>
                <input
                  id={`voice-limit-${connection.id}`}
                  type="number"
                  min={PROMPT_LIMIT_MIN}
                  max={PROMPT_LIMIT_MAX}
                  step={50}
                  data-testid={`voice-limit-${connection.id}`}
                  aria-label={t("voice.promptCharsFor", { name: connection.label })}
                  placeholder={String(settings.promptChars)}
                  value={own ?? ""}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === "") { void props.recording.save({ promptCharsByConnection: { [connection.id]: null } }); return; }
                    const value = Number(raw);
                    if (Number.isFinite(value)) void props.recording.save({ promptCharsByConnection: { [connection.id]: clampLimit(value) } });
                  }}
                />
              </SettingsRow>
            );
          })}
        </div>

        <div className="msettings-subgroup" data-testid="voice-language-section">
          <SettingsRow label={t("voice.language")} hint={t("voice.languageHint")} htmlFor="voice-language">
            <select id="voice-language" data-testid="voice-language" value={settings.language ?? ""} onChange={(event) => void props.recording.save({ language: event.target.value || null })}>
              {LANGUAGES.map((code) => <option key={code} value={code}>{t(`voice.language.${code || "auto"}` as "voice.language.auto")}</option>)}
            </select>
          </SettingsRow>
        </div>
      </SettingsSection>

      {/* 3. Audio & Recording */}
      <SettingsSection title={t("voice.section.audio")} hint={t("voice.section.audioHint")} testId="voice-audio-section">
        <SettingsRow label={t("voice.audio.aec")} hint={t("voice.audio.aecHint")} htmlFor="voice-aec">
          <input
            id="voice-aec"
            type="checkbox"
            data-testid="voice-aec"
            checked={settings.echoCancellation}
            onChange={(event) => void props.recording.save({ echoCancellation: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow label={t("voice.audio.systemAec")} hint={t("voice.audio.systemAecHint")} htmlFor="voice-system-aec">
          <input
            id="voice-system-aec"
            type="checkbox"
            data-testid="voice-system-aec"
            checked={settings.systemLoopbackAec}
            onChange={(event) => void props.recording.save({ systemLoopbackAec: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow label={t("voice.audio.gtcrn")} hint={t("voice.audio.gtcrnHint")} htmlFor="voice-gtcrn">
          <input
            id="voice-gtcrn"
            type="checkbox"
            data-testid="voice-gtcrn"
            checked={settings.gtcrnDenoise}
            onChange={(event) => void props.recording.save({ gtcrnDenoise: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow label={t("voice.audio.browserNs")} hint={t("voice.audio.browserNsHint")} htmlFor="voice-browser-ns">
          <input
            id="voice-browser-ns"
            type="checkbox"
            data-testid="voice-browser-ns"
            checked={settings.browserNoiseSuppression}
            onChange={(event) => void props.recording.save({ browserNoiseSuppression: event.target.checked })}
          />
        </SettingsRow>
        <SettingsRow label={t("voice.audio.agc")} htmlFor="voice-agc">
          <input
            id="voice-agc"
            type="checkbox"
            data-testid="voice-agc"
            checked={settings.autoGainControl}
            onChange={(event) => void props.recording.save({ autoGainControl: event.target.checked })}
          />
        </SettingsRow>
        <Recording t={t} settings={settings} save={props.recording.save} onNotice={props.onNotice} keyTable={props.keyTable} />
      </SettingsSection>

      {/* 4. Dictionary */}
      <SettingsSection title={t("voice.dictionary")} hint={t("voice.dictionaryHint")} testId="voice-dictionary">
        <SettingsRow label={t("voice.promptChars")} hint={t("voice.promptCharsHint", { n: PROMPT_LIMIT_DEFAULT })} htmlFor="voice-prompt-chars">
          <input
            id="voice-prompt-chars"
            type="number"
            min={PROMPT_LIMIT_MIN}
            max={PROMPT_LIMIT_MAX}
            step={50}
            data-testid="voice-prompt-chars"
            value={settings.promptChars}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && event.target.value !== "") void props.recording.save({ promptChars: clampLimit(value) });
            }}
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

      {/* 5. Dictation History */}
      <SettingsSection
        title={t("voice.section.history")}
        hint={t("voice.section.historyHint")}
        testId="voice-history-section"
        actions={history.length > 0 ? (
          <button
            type="button"
            className="secondary-button"
            data-testid="voice-history-clear"
            onClick={() => {
              void attempt("dictation.history.clear", {}).then((res) => {
                if (!res.ok) { props.onError(res.error.message); return; }
                props.onNotice(t("voice.history.cleared"));
                void loadHistory();
              });
            }}
          >
            {t("voice.history.clear")}
          </button>
        ) : undefined}
      >
        <SettingsRow label={t("voice.history.retain24h")} htmlFor="voice-retain-audio-24h">
          <input
            id="voice-retain-audio-24h"
            type="checkbox"
            data-testid="voice-retain-audio-24h"
            checked={settings.retainDictationAudio24h}
            onChange={(event) => void props.recording.save({ retainDictationAudio24h: event.target.checked })}
          />
        </SettingsRow>
        {history.length === 0 ? (
          <SettingsEmpty text={t("voice.history.empty")} testId="voice-history-empty" />
        ) : (
          <ul className="voice-history-list" data-testid="voice-history-list">
            {history.map((item) => {
              const polishText = polishModeLabel(t, item.polishMode);
              const fallbackText = historyFallbackLabel(t, item.fallbackReason);
              const timeText = props.formatDate ? props.formatDate(item.createdAt) : item.createdAt;
              return (
                <li key={item.id} className="voice-history-card" data-testid={`voice-history-${item.id}`}>
                  <div className="voice-history-head">
                    <span className="detail-muted">{`${timeText} · ${item.modelId} · ${polishText}`}</span>
                    {fallbackText ? <span className="chip">{fallbackText}</span> : null}
                  </div>
                  <div>
                    <span className="detail-muted">{`${t("voice.history.finalLabel")}: `}</span>
                    <span data-testid={`voice-history-final-${item.id}`}>{item.finalText}</span>
                  </div>
                  {item.rawText !== item.finalText ? (
                    <div className="detail-muted">
                      <span>{`${t("voice.history.rawLabel")}: `}</span>
                      <span data-testid={`voice-history-raw-${item.id}`}>{item.rawText}</span>
                    </div>
                  ) : null}
                  <div className="msettings-actions">
                    <button type="button" className="secondary-button" data-testid={`voice-history-copy-final-${item.id}`} onClick={() => void copyHistoryText(item.finalText)}>{t("voice.history.copyFinal")}</button>
                    <button type="button" className="secondary-button" data-testid={`voice-history-copy-raw-${item.id}`} onClick={() => void copyHistoryText(item.rawText)}>{t("voice.history.copyRaw")}</button>
                    {item.audioAvailable && engineOptions.length > 0 ? (
                      <>
                        <select
                          aria-label={t("voice.history.retranscribe")}
                          data-testid={`voice-history-engine-${item.id}`}
                          value={retranscribeEngine[item.id] ?? engineOptions[0]!.value}
                          onChange={(event) => setRetranscribeEngine((current) => ({ ...current, [item.id]: event.target.value }))}
                        >
                          {engineOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                        </select>
                        <button type="button" className="secondary-button" data-testid={`voice-history-retranscribe-${item.id}`} onClick={() => void retranscribeItem(item)}>{t("voice.history.retranscribe")}</button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="link-button"
                      data-testid={`voice-history-delete-${item.id}`}
                      onClick={() => {
                        void attempt("dictation.history.delete", { historyId: item.id }).then((res) => {
                          if (!res.ok) { props.onError(res.error.message); return; }
                          void loadHistory();
                        });
                      }}
                    >
                      {t("voice.history.delete")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>

      {confirmingModel ? (
        <Modal
          variant="dialog"
          testId="voice-model-confirm-dialog"
          title={t("voice.model.confirmTitle", { name: confirmingModel.model.name })}
          description={t("voice.model.confirmBody", { mb: mibOf(confirmingModel.model.archiveBytes), license: confirmingModel.model.license })}
          closeLabel={t("common.close")}
          onClose={() => setConfirmingModel(null)}
          footer={(
            <>
              <button type="button" className="secondary-button" data-testid="voice-model-confirm-cancel" onClick={() => setConfirmingModel(null)}>{t("common.cancel")}</button>
              <button type="button" className="primary-button" data-testid="voice-model-confirm-do" onClick={() => void confirmDownload()}>{t("voice.model.confirmDo")}</button>
            </>
          )}
        >
          {confirmingModel.model.sources && confirmingModel.model.sources.length > 0 ? (
            <label className="msettings-field">
              <span>{t("voice.model.confirmSource")}</span>
              <select
                data-testid="voice-model-source"
                value={confirmingModel.sourceId}
                onChange={(event) => setConfirmingModel({ ...confirmingModel, sourceId: event.target.value })}
              >
                {confirmingModel.model.sources.map((src) => <option key={src.id} value={src.id}>{src.label}</option>)}
              </select>
            </label>
          ) : <span />}
        </Modal>
      ) : null}
    </SettingsPage>
  );
}
