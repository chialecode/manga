import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  PROMPT_LIMIT_MAX,
  PROMPT_LIMIT_MIN,
  type AsrEngineSelection,
  type LocalAsrModelItem,
} from "@manga/contracts";
import type { MessageKey, Translator } from "@manga/i18n";
import { Modal } from "../../components/modal.tsx";
import { NumberField } from "../../components/number-field.tsx";
import { useAsyncGuard } from "../../hooks/use-async-guard.ts";
import { attempt } from "../../lib/api.ts";
import { isImeEvent } from "../../lib/ime.ts";
import type { RecordingPatch, RecordingSettings } from "../../voice/use-recorder.ts";
import { SettingsEmpty, SettingsRow, SettingsSection } from "./rows.tsx";
import type { VoiceConnection } from "./voice-dictation-section.tsx";

type T = Translator["t"];

const LANGUAGES = ["", "zh", "ja", "en", "ko"] as const;
const STANDARD_ADAPTERS = new Set(["", "openai-http", "openai-chat-completions", "openai-responses"]);
const clampLimit = (value: number) => Math.max(PROMPT_LIMIT_MIN, Math.min(PROMPT_LIMIT_MAX, Math.round(value)));
const mibOf = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

function encodeEngine(selection: AsrEngineSelection | null | undefined): string {
  if (!selection) return "";
  return selection.kind === "local" ? `local:${selection.modelId}` : `connection:${selection.connectionId}`;
}

export function decodeEngine(value: string): AsrEngineSelection | null {
  if (!value) return null;
  if (value.startsWith("local:")) return { kind: "local", modelId: value.slice("local:".length) };
  if (value.startsWith("connection:")) return { kind: "connection", connectionId: value.slice("connection:".length) };
  return null;
}

function modelStateLabel(t: T, state: LocalAsrModelItem["state"]): string {
  return t(`voice.model.state.${state}` as MessageKey);
}

/** Provider-backed transcription adapters (outside standard OpenAI-compatible HTTP) do not take a prompt hotword hint. */
function connectionSkipsHotwords(connection: VoiceConnection): boolean {
  if (connection.profile?.transcriptionInterface === "deepseek_asr") return true;
  if (connection.account) return true;
  const adapter = connection.adapterId ?? "";
  return adapter !== "" && !STANDARD_ADAPTERS.has(adapter);
}

/** Nullable draft-backed number input: blank commits `null` (inherit global default), non-blank clamps to [min, max] on blur/Enter. */
function OptionalLimitField(props: {
  id: string;
  testId: string;
  ariaLabel: string;
  placeholder: string;
  value: number | undefined;
  onCommit: (next: number | null) => void;
}) {
  const [draft, setDraft] = useState(() => (props.value === undefined ? "" : String(props.value)));
  const focusedRef = useRef(false);
  const composingRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(props.value === undefined ? "" : String(props.value));
  }, [props.value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft("");
      if (props.value !== undefined) props.onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(props.value === undefined ? "" : String(props.value));
      return;
    }
    const next = clampLimit(parsed);
    setDraft(String(next));
    if (next !== props.value) props.onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeEvent(event, composingRef.current)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(props.value === undefined ? "" : String(props.value));
      event.currentTarget.blur();
    }
  };

  return (
    <input
      id={props.id}
      type="number"
      min={PROMPT_LIMIT_MIN}
      max={PROMPT_LIMIT_MAX}
      step={50}
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      placeholder={props.placeholder}
      value={draft}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={() => { focusedRef.current = false; commit(); }}
      onChange={(event) => setDraft(event.target.value)}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
      onKeyDown={onKeyDown}
    />
  );
}

/** Section 2 of Settings › Voice: recognition engines, local offline ASR models, external transcription connections, and language. */
export function VoiceEnginesSection(props: {
  t: T;
  settings: RecordingSettings;
  models: LocalAsrModelItem[];
  connections: VoiceConnection[];
  engineOptions: Array<{ value: string; label: string }>;
  save: (patch: RecordingPatch) => Promise<boolean>;
  reloadModels: () => Promise<void>;
  onGoto: (page: "models" | "shortcuts") => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t, settings, models, connections, engineOptions } = props;
  const [confirmingModel, setConfirmingModel] = useState<{ model: LocalAsrModelItem; sourceId: string } | null>(null);
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [controlBusyModelId, setControlBusyModelId] = useState<string | null>(null);
  const guard = useAsyncGuard();

  async function runModelAction(
    modelId: string,
    commandId: string,
    input: Record<string, unknown>,
    onSuccessNotice?: (val: Record<string, unknown>) => void,
  ) {
    if (busyModelId !== null) return;
    setBusyModelId(modelId);
    try {
      const result = await attempt<Record<string, unknown>>(commandId, input);
      if (!guard.isAlive()) return;
      if (!result.ok) {
        props.onError(result.error.message);
        return;
      }
      onSuccessNotice?.(result.value);
      await props.reloadModels();
    } finally {
      if (guard.isAlive()) setBusyModelId(null);
    }
  }

  /** Pause/cancel must remain clickable while `asrModel.download` is still pending on the main process. */
  async function runModelControl(modelId: string, commandId: "asrModel.pause" | "asrModel.cancel") {
    if (controlBusyModelId === modelId) return;
    setControlBusyModelId(modelId);
    try {
      const result = await attempt<Record<string, unknown>>(commandId, { modelId });
      if (!guard.isAlive()) return;
      if (!result.ok) {
        props.onError(result.error.message);
        return;
      }
      await props.reloadModels();
    } finally {
      if (guard.isAlive()) setControlBusyModelId(null);
    }
  }

  async function confirmDownload() {
    if (!confirmingModel || busyModelId !== null) return;
    const { model, sourceId } = confirmingModel;
    setConfirmingModel(null);
    await runModelAction(model.modelId, "asrModel.download", {
      modelId: model.modelId,
      confirmed: true,
      ...(sourceId ? { sourceId } : {}),
    });
  }

  async function importModel(model: LocalAsrModelItem, importKind: "archive" | "directory") {
    if (busyModelId !== null) return;
    let pathHandle: string | null = null;
    if (window.manga?.pick) {
      const picked = await window.manga.pick({ mode: importKind === "directory" ? "directory" : "file", ...(importKind === "archive" ? { filter: "any" as const } : {}) });
      pathHandle = picked?.pathHandle ?? null;
    } else if (importKind === "directory" && window.manga?.chooseDirectory) {
      pathHandle = await window.manga.chooseDirectory();
    } else if (importKind === "archive" && window.manga?.choosePath) {
      pathHandle = await window.manga.choosePath();
    }
    if (!pathHandle || !guard.isAlive()) return;
    await runModelAction(model.modelId, "asrModel.import", { modelId: model.modelId, pathHandle, kind: importKind }, () => {
      props.onNotice(t("voice.model.imported", { name: model.name }));
    });
  }

  return (
    <>
      <SettingsSection title={t("voice.section.engines")} hint={t("voice.section.enginesHint")} testId="voice-engines-section">
        <SettingsRow label={t("voice.engine.dictation")} htmlFor="voice-dictation-engine">
          <select
            id="voice-dictation-engine"
            data-testid="voice-dictation-engine"
            value={encodeEngine(settings.dictationEngine)}
            onChange={(event) => void props.save({ dictationEngine: decodeEngine(event.target.value) })}
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
            onChange={(event) => void props.save({ captureEngine: decodeEngine(event.target.value) })}
          >
            <option value="">{t("voice.engine.auto")}</option>
            {engineOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow label={t("voice.engine.idleMinutes")} htmlFor="voice-idle-minutes">
          <NumberField
            id="voice-idle-minutes"
            min={1}
            max={120}
            integer
            testId="voice-idle-minutes"
            value={settings.localIdleMinutes}
            onCommit={(localIdleMinutes) => { void props.save({ localIdleMinutes }); }}
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
                const actionBusy = busyModelId !== null;
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
                            disabled={actionBusy}
                            onClick={() => setConfirmingModel({ model, sourceId: model.sources?.[0]?.id ?? "" })}
                          >
                            {t("voice.model.download")}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            data-testid={`voice-model-import-archive-${model.modelId}`}
                            disabled={actionBusy}
                            onClick={() => void importModel(model, "archive")}
                          >
                            {t("voice.model.importArchive")}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            data-testid={`voice-model-import-dir-${model.modelId}`}
                            disabled={actionBusy}
                            onClick={() => void importModel(model, "directory")}
                          >
                            {t("voice.model.importDirectory")}
                          </button>
                        </>
                      ) : null}
                      {model.state === "downloading" ? (
                        <>
                          <button type="button" className="secondary-button" data-testid={`voice-model-pause-${model.modelId}`} disabled={controlBusyModelId === model.modelId} onClick={() => void runModelControl(model.modelId, "asrModel.pause")}>{t("voice.model.pause")}</button>
                          <button type="button" className="link-button" data-testid={`voice-model-cancel-${model.modelId}`} disabled={controlBusyModelId === model.modelId} onClick={() => void runModelControl(model.modelId, "asrModel.cancel")}>{t("voice.model.cancel")}</button>
                        </>
                      ) : null}
                      {model.state === "paused" ? (
                        <>
                          <button type="button" className="primary-button" data-testid={`voice-model-resume-${model.modelId}`} disabled={actionBusy} onClick={() => void runModelAction(model.modelId, "asrModel.download", { modelId: model.modelId, confirmed: true })}>{t("voice.model.resume")}</button>
                          <button type="button" className="link-button" data-testid={`voice-model-cancel-${model.modelId}`} disabled={controlBusyModelId === model.modelId || actionBusy} onClick={() => void runModelControl(model.modelId, "asrModel.cancel")}>{t("voice.model.cancel")}</button>
                        </>
                      ) : null}
                      {canDelete ? (
                        <button
                          type="button"
                          className="link-button"
                          data-testid={`voice-model-delete-${model.modelId}`}
                          disabled={actionBusy}
                          onClick={() => void runModelAction(model.modelId, "asrModel.delete", { modelId: model.modelId }, (val) => {
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
            if (connectionSkipsHotwords(connection)) {
              return (
                <SettingsRow key={connection.id} label={connection.label} hint={`${connection.modelId ?? ""}${index === 0 ? ` · ${t("voice.connectionUsed")}` : ""}`} testId={`voice-connection-${connection.id}`}>
                  <span className="detail-muted" data-testid={`voice-no-hotwords-${connection.id}`}>{t("voice.connection.noHotwords")}</span>
                </SettingsRow>
              );
            }
            return (
              <SettingsRow key={connection.id} label={connection.label} hint={`${connection.modelId ?? ""}${index === 0 ? ` · ${t("voice.connectionUsed")}` : ""}`} testId={`voice-connection-${connection.id}`} htmlFor={`voice-limit-${connection.id}`}>
                <OptionalLimitField
                  id={`voice-limit-${connection.id}`}
                  testId={`voice-limit-${connection.id}`}
                  ariaLabel={t("voice.promptCharsFor", { name: connection.label })}
                  placeholder={String(settings.promptChars)}
                  value={own}
                  onCommit={(next) => { void props.save({ promptCharsByConnection: { [connection.id]: next } }); }}
                />
              </SettingsRow>
            );
          })}
        </div>

        <div className="msettings-subgroup" data-testid="voice-language-section">
          <SettingsRow label={t("voice.language")} hint={t("voice.languageHint")} htmlFor="voice-language">
            <select id="voice-language" data-testid="voice-language" value={settings.language ?? ""} onChange={(event) => void props.save({ language: event.target.value || null })}>
              {LANGUAGES.map((code) => <option key={code} value={code}>{t(`voice.language.${code || "auto"}` as "voice.language.auto")}</option>)}
            </select>
          </SettingsRow>
        </div>
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
    </>
  );
}
