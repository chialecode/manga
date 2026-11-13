import { useState } from "react";
import type { DictationHistoryItem } from "@manga/contracts";
import type { Translator } from "@manga/i18n";
import { useAsyncGuard } from "../../hooks/use-async-guard.ts";
import { attempt } from "../../lib/api.ts";
import type { RecordingPatch, RecordingSettings } from "../../voice/use-recorder.ts";
import { SettingsEmpty, SettingsRow, SettingsSection } from "./rows.tsx";
import { polishModeLabel } from "./voice-dictation-section.tsx";
import { decodeEngine } from "./voice-engines-section.tsx";

type T = Translator["t"];

function historyFallbackLabel(t: T, fallback: string | null): string | null {
  if (!fallback) return null;
  const lower = fallback.toLowerCase();
  if (lower.includes("timeout")) return t("dictation.fallback.timeout");
  if (lower.includes("length")) return t("dictation.fallback.length");
  if (lower.includes("entity") || lower.includes("proper")) return t("dictation.fallback.entity");
  if (lower.includes("unconfigured") || lower.includes("no_connection")) return t("dictation.fallback.unconfigured");
  return t("dictation.fallback.error");
}

/** Section 5 of Settings › Voice: dictation history retention, copy, re-transcribe, delete, and clear. */
export function VoiceHistorySection(props: {
  t: T;
  settings: RecordingSettings;
  history: DictationHistoryItem[];
  engineOptions: Array<{ value: string; label: string }>;
  formatDate?: (value: string) => string;
  save: (patch: RecordingPatch) => Promise<boolean>;
  reloadHistory: () => Promise<void>;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t, settings, history, engineOptions } = props;
  const [retranscribeEngine, setRetranscribeEngine] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const guard = useAsyncGuard();

  async function copyHistoryText(text: string) {
    try {
      await navigator.clipboard?.writeText?.(text);
      props.onNotice(t("dictation.notice.copied"));
    } catch {
      // Clipboard may be unavailable in headless tests
    }
  }

  async function retranscribeItem(item: DictationHistoryItem) {
    if (busyId !== null) return;
    const chosen = retranscribeEngine[item.id] ?? engineOptions[0]?.value ?? "";
    const engine = decodeEngine(chosen);
    if (!engine) return;
    setBusyId(item.id);
    try {
      const result = await attempt("dictation.history.retranscribe", { historyId: item.id, engine });
      if (!guard.isAlive()) return;
      if (!result.ok) {
        props.onError(result.error.message);
        return;
      }
      props.onNotice(t("voice.history.retranscribed"));
      await props.reloadHistory();
    } finally {
      if (guard.isAlive()) setBusyId(null);
    }
  }

  async function deleteItem(historyId: string) {
    if (busyId !== null) return;
    setBusyId(historyId);
    try {
      const result = await attempt("dictation.history.delete", { historyId });
      if (!guard.isAlive()) return;
      if (!result.ok) {
        props.onError(result.error.message);
        return;
      }
      await props.reloadHistory();
    } finally {
      if (guard.isAlive()) setBusyId(null);
    }
  }

  async function clearAll() {
    if (busyId !== null) return;
    setBusyId("__clear__");
    try {
      const result = await attempt("dictation.history.clear", {});
      if (!guard.isAlive()) return;
      if (!result.ok) {
        props.onError(result.error.message);
        return;
      }
      props.onNotice(t("voice.history.cleared"));
      await props.reloadHistory();
    } finally {
      if (guard.isAlive()) setBusyId(null);
    }
  }

  return (
    <SettingsSection
      title={t("voice.section.history")}
      hint={t("voice.section.historyHint")}
      testId="voice-history-section"
      actions={history.length > 0 ? (
        <button
          type="button"
          className="secondary-button"
          data-testid="voice-history-clear"
          disabled={busyId !== null}
          onClick={() => void clearAll()}
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
          onChange={(event) => void props.save({ retainDictationAudio24h: event.target.checked })}
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
                        disabled={busyId !== null}
                        value={retranscribeEngine[item.id] ?? engineOptions[0]!.value}
                        onChange={(event) => setRetranscribeEngine((current) => ({ ...current, [item.id]: event.target.value }))}
                      >
                        {engineOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                      <button type="button" className="secondary-button" data-testid={`voice-history-retranscribe-${item.id}`} disabled={busyId !== null} onClick={() => void retranscribeItem(item)}>{t("voice.history.retranscribe")}</button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="link-button"
                    data-testid={`voice-history-delete-${item.id}`}
                    disabled={busyId !== null}
                    onClick={() => void deleteItem(item.id)}
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
  );
}
