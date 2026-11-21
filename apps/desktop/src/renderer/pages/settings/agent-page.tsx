import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_AGENT_LIMITS, DEFAULT_AGENT_MEDIA_SETTINGS, DEFAULT_AGENT_TRACE_SETTINGS, type AgentLimits, type AgentMediaSettings, type AgentTraceSettings } from "@manga/contracts/models";
import type { Translator } from "@manga/i18n";
import { useAsyncGuard } from "../../hooks/use-async-guard.ts";
import { attempt } from "../../lib/api.ts";
import { isImeEvent } from "../../lib/ime.ts";
import { sizeLabel } from "../../lib/trace-model.ts";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];
type Loaded = { limits: AgentLimits; trace: AgentTraceSettings; media: AgentMediaSettings };

/** A whole number the person types; it is kept when the field is left, and a value outside the range is put back with the reason. */
function AgentNumberField(props: { id: string; label: string; value: number; min: number; max: number; disabled?: boolean; onSave: (value: number) => Promise<string | null> }) {
  const [draft, setDraft] = useState(String(props.value));
  const [problem, setProblem] = useState("");
  const composingRef = useRef(false);
  const focusedRef = useRef(false);
  useEffect(() => { if (!focusedRef.current) setDraft(String(props.value)); }, [props.value]);
  const commit = async () => {
    const trimmed = draft.trim();
    const next = Number(trimmed);
    if (!trimmed || !Number.isInteger(next) || next < props.min || next > props.max) { setProblem(`${props.min} – ${props.max}`); setDraft(String(props.value)); return; }
    setProblem("");
    if (next !== props.value) {
      const refused = await props.onSave(next);
      if (refused) { setProblem(refused); setDraft(String(props.value)); }
    }
  };
  return (
    <span className="settings-number">
      <input
        id={props.id}
        type="number"
        inputMode="numeric"
        data-testid={props.id}
        aria-label={props.label}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        value={draft}
        aria-invalid={problem ? true : undefined}
        onFocus={() => { focusedRef.current = true; }}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onBlur={() => { focusedRef.current = false; void commit(); }}
        onKeyDown={(event) => {
          if (isImeEvent(event, composingRef.current)) return;
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          else if (event.key === "Escape") { event.preventDefault(); setProblem(""); setDraft(String(props.value)); event.currentTarget.blur(); }
        }}
      />
      {problem ? <span className="review-error" role="alert" data-testid={`${props.id}-error`}>{problem}</span> : null}
    </span>
  );
}

/**
 * The agent: how many steps and how long a task may take, and (with the record of what it sent) what is kept of every request. The limits apply to the
 * tasks sent after a change; a task that stopped at its steps goes on after they are raised and it is retried.
 */
export function AgentPage(props: { t: T; onError: (message: string) => void; onNotice: (message: string) => void; children?: ReactNode }) {
  const { t } = props;
  const [settings, setSettings] = useState<Loaded>({ limits: DEFAULT_AGENT_LIMITS, trace: DEFAULT_AGENT_TRACE_SETTINGS, media: DEFAULT_AGENT_MEDIA_SETTINGS });
  const [loaded, setLoaded] = useState(false);
  const [stats, setStats] = useState<{ count: number; bytes: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const guard = useAsyncGuard();
  const statsGuard = useAsyncGuard();
  const callbacksRef = useRef({ onError: props.onError, onNotice: props.onNotice });
  callbacksRef.current = { onError: props.onError, onNotice: props.onNotice };

  const loadStats = useCallback(async () => {
    const token = statsGuard.next();
    const result = await attempt<{ count: number; bytes: number }>("agent.trace.stats");
    if (!statsGuard.isCurrent(token)) return;
    if (result.ok) setStats(result.value);
  }, [statsGuard]);

  useEffect(() => {
    const token = guard.next();
    void attempt<Loaded>("settings.getAgent").then((result) => {
      if (!guard.isCurrent(token)) return;
      if (result.ok) setSettings({ ...result.value, media: result.value.media ?? DEFAULT_AGENT_MEDIA_SETTINGS });
      else callbacksRef.current.onError(result.error.message);
      setLoaded(true);
    });
    void loadStats();
  }, [guard, loadStats]);

  const save = useCallback(async (patch: { limits?: Partial<AgentLimits>; trace?: Partial<AgentTraceSettings>; media?: Partial<AgentMediaSettings> }): Promise<string | null> => {
    const result = await attempt<Loaded>("settings.setAgent", patch);
    if (!guard.isAlive()) return null;
    if (!result.ok) return result.error.message;
    setSettings({ ...result.value, media: result.value.media ?? DEFAULT_AGENT_MEDIA_SETTINGS });
    callbacksRef.current.onNotice(t("agent.saved"));
    // A shorter time or a smaller size cleans what is kept at once.
    if (patch.trace) void loadStats();
    return null;
  }, [guard, t, loadStats]);

  const clear = useCallback(async () => {
    if (clearing) return;
    setConfirming(false);
    setClearing(true);
    const result = await attempt<{ removed: number }>("agent.trace.clear");
    if (!guard.isAlive()) return;
    setClearing(false);
    if (!result.ok) { callbacksRef.current.onError(result.error.message); return; }
    callbacksRef.current.onNotice(t("agent.traceCleared", { count: result.value.removed }));
    void loadStats();
  }, [clearing, guard, t, loadStats]);

  return (
    <SettingsPage id="agent" title={t("agent.title")} hint={t("agent.lead")}>
      <SettingsSection title={t("agent.limits")} testId="agent-limits">
        <SettingsRow label={t("agent.steps")} hint={t("agent.stepsHint")} htmlFor="agent-steps">
          <AgentNumberField id="agent-steps" label={t("agent.steps")} min={1} max={64} disabled={!loaded} value={settings.limits.maxSteps} onSave={(value) => save({ limits: { maxSteps: value } })} />
        </SettingsRow>
        <SettingsRow label={t("agent.minutes")} hint={t("agent.minutesHint")} htmlFor="agent-minutes">
          <AgentNumberField id="agent-minutes" label={t("agent.minutes")} min={1} max={30} disabled={!loaded} value={Math.round(settings.limits.maxDurationMs / 60_000)} onSave={(value) => save({ limits: { maxDurationMs: value * 60_000 } })} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("agent.media")} hint={t("agent.mediaLead")} testId="agent-media">
        <SettingsRow label={t("agent.mediaForever")} htmlFor="agent-media-forever">
          <input id="agent-media-forever" type="checkbox" data-testid="agent-media-forever" disabled={!loaded} checked={settings.media.retentionDays === null}
            onChange={(event) => { void save({ media: { retentionDays: event.target.checked ? null : DEFAULT_AGENT_MEDIA_SETTINGS.retentionDays } }).then((refused) => { if (refused) callbacksRef.current.onError(refused); }); }} />
        </SettingsRow>
        {settings.media.retentionDays !== null ? (
          <SettingsRow label={t("agent.mediaDays")} hint={t("agent.mediaDaysHint")} htmlFor="agent-media-days">
            <AgentNumberField id="agent-media-days" label={t("agent.mediaDays")} min={1} max={365} disabled={!loaded} value={settings.media.retentionDays} onSave={(value) => save({ media: { retentionDays: value } })} />
          </SettingsRow>
        ) : null}
      </SettingsSection>
      <SettingsSection title={t("agent.trace")} hint={t("agent.traceLead")} testId="agent-trace">
        <SettingsRow label={t("agent.traceMode")} htmlFor="agent-trace-mode">
          <select id="agent-trace-mode" data-testid="agent-trace-mode" disabled={!loaded} value={settings.trace.mode} onChange={(event) => { void save({ trace: { mode: event.target.value as AgentTraceSettings["mode"] } }).then((refused) => { if (refused) callbacksRef.current.onError(refused); }); }}>
            <option value="full">{t("agent.traceMode.full")}</option>
            <option value="metadata">{t("agent.traceMode.metadata")}</option>
          </select>
        </SettingsRow>
        <SettingsRow label={t("agent.retention")} hint={t("agent.retentionHint")} htmlFor="agent-retention">
          <AgentNumberField id="agent-retention" label={t("agent.retention")} min={1} max={365} disabled={!loaded} value={settings.trace.retentionDays} onSave={(value) => save({ trace: { retentionDays: value } })} />
        </SettingsRow>
        <SettingsRow label={t("agent.maxMb")} htmlFor="agent-max-mb">
          <AgentNumberField id="agent-max-mb" label={t("agent.maxMb")} min={10} max={5000} disabled={!loaded} value={settings.trace.maxMegabytes} onSave={(value) => save({ trace: { maxMegabytes: value } })} />
        </SettingsRow>
        <SettingsRow label={stats ? (stats.count ? t("agent.traceUsage", { count: stats.count, size: sizeLabel(stats.bytes) }) : t("agent.traceEmpty")) : t("trace.loading")} testId="agent-trace-stats">
          {confirming ? (
            <span className="settings-confirm" role="alertdialog" aria-label={t("agent.traceClearAsk")} data-testid="agent-trace-confirm">
              <span>{t("agent.traceClearAsk")}</span>
              <button type="button" className="danger-button" data-testid="agent-trace-clear-confirm" disabled={clearing} onClick={() => void clear()}>{t("agent.traceClearConfirm")}</button>
              <button type="button" className="secondary-button" disabled={clearing} onClick={() => setConfirming(false)}>{t("chat.cancel")}</button>
            </span>
          ) : (
            <button type="button" className="secondary-button" disabled={!stats?.count || clearing} data-testid="agent-trace-clear" onClick={() => setConfirming(true)}>{t("agent.traceClear")}</button>
          )}
        </SettingsRow>
      </SettingsSection>
      {props.children}
    </SettingsPage>
  );
}
