import { useCallback, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_AGENT_LIMITS, DEFAULT_AGENT_TRACE_SETTINGS, type AgentLimits, type AgentTraceSettings } from "@manga/contracts/models";
import type { Translator } from "@manga/i18n";
import { attempt } from "../../lib/api.ts";
import { sizeLabel } from "../../lib/trace-model.ts";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];
type Loaded = { limits: AgentLimits; trace: AgentTraceSettings };

/** A whole number the person types; it is kept when the field is left, and a value outside the range is put back with the reason. */
function NumberField(props: { id: string; label: string; value: number; min: number; max: number; onSave: (value: number) => Promise<string | null> }) {
  const [draft, setDraft] = useState(String(props.value));
  const [problem, setProblem] = useState("");
  useEffect(() => { setDraft(String(props.value)); }, [props.value]);
  const commit = async () => {
    const next = Number(draft);
    if (!Number.isInteger(next) || next < props.min || next > props.max) { setProblem(`${props.min} – ${props.max}`); setDraft(String(props.value)); return; }
    setProblem("");
    if (next !== props.value) {
      const refused = await props.onSave(next);
      if (refused) { setProblem(refused); setDraft(String(props.value)); }
    }
  };
  return (
    <span className="settings-number">
      <input id={props.id} type="number" inputMode="numeric" data-testid={props.id} aria-label={props.label} min={props.min} max={props.max} value={draft} aria-invalid={problem ? true : undefined}
        onChange={(event) => setDraft(event.target.value)} onBlur={() => void commit()} onKeyDown={(event) => { if (event.key === "Enter") void commit(); }} />
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
  const [settings, setSettings] = useState<Loaded>({ limits: DEFAULT_AGENT_LIMITS, trace: DEFAULT_AGENT_TRACE_SETTINGS });
  const [stats, setStats] = useState<{ count: number; bytes: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const loadStats = useCallback(async () => {
    const result = await attempt<{ count: number; bytes: number }>("agent.trace.stats");
    if (result.ok) setStats(result.value);
  }, []);

  useEffect(() => {
    void attempt<Loaded>("settings.getAgent").then((result) => { if (result.ok) setSettings(result.value); else props.onError(result.error.message); });
    void loadStats();
  }, []);

  const save = useCallback(async (patch: { limits?: Partial<AgentLimits>; trace?: Partial<AgentTraceSettings> }): Promise<string | null> => {
    const result = await attempt<Loaded>("settings.setAgent", patch);
    if (!result.ok) return result.error.message;
    setSettings(result.value);
    props.onNotice(t("agent.saved"));
    // A shorter time or a smaller size cleans what is kept at once.
    if (patch.trace) void loadStats();
    return null;
  }, [props, t, loadStats]);

  const clear = useCallback(async () => {
    setConfirming(false);
    const result = await attempt<{ removed: number }>("agent.trace.clear");
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("agent.traceCleared", { count: result.value.removed }));
    void loadStats();
  }, [props, t, loadStats]);

  return (
    <SettingsPage id="agent" title={t("agent.title")} hint={t("agent.lead")}>
      <SettingsSection title={t("agent.limits")} testId="agent-limits">
        <SettingsRow label={t("agent.steps")} hint={t("agent.stepsHint")} htmlFor="agent-steps">
          <NumberField id="agent-steps" label={t("agent.steps")} min={1} max={64} value={settings.limits.maxSteps} onSave={(value) => save({ limits: { maxSteps: value } })} />
        </SettingsRow>
        <SettingsRow label={t("agent.minutes")} hint={t("agent.minutesHint")} htmlFor="agent-minutes">
          <NumberField id="agent-minutes" label={t("agent.minutes")} min={1} max={30} value={Math.round(settings.limits.maxDurationMs / 60_000)} onSave={(value) => save({ limits: { maxDurationMs: value * 60_000 } })} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("agent.trace")} hint={t("agent.traceLead")} testId="agent-trace">
        <SettingsRow label={t("agent.traceMode")} htmlFor="agent-trace-mode">
          <select id="agent-trace-mode" data-testid="agent-trace-mode" value={settings.trace.mode} onChange={(event) => { void save({ trace: { mode: event.target.value as AgentTraceSettings["mode"] } }).then((refused) => { if (refused) props.onError(refused); }); }}>
            <option value="full">{t("agent.traceMode.full")}</option>
            <option value="metadata">{t("agent.traceMode.metadata")}</option>
          </select>
        </SettingsRow>
        <SettingsRow label={t("agent.retention")} hint={t("agent.retentionHint")} htmlFor="agent-retention">
          <NumberField id="agent-retention" label={t("agent.retention")} min={1} max={365} value={settings.trace.retentionDays} onSave={(value) => save({ trace: { retentionDays: value } })} />
        </SettingsRow>
        <SettingsRow label={t("agent.maxMb")} htmlFor="agent-max-mb">
          <NumberField id="agent-max-mb" label={t("agent.maxMb")} min={10} max={5000} value={settings.trace.maxMegabytes} onSave={(value) => save({ trace: { maxMegabytes: value } })} />
        </SettingsRow>
        <SettingsRow label={stats ? (stats.count ? t("agent.traceUsage", { count: stats.count, size: sizeLabel(stats.bytes) }) : t("agent.traceEmpty")) : t("trace.loading")} testId="agent-trace-stats">
          {confirming ? (
            <span className="settings-confirm" role="alertdialog" aria-label={t("agent.traceClearAsk")} data-testid="agent-trace-confirm">
              <span>{t("agent.traceClearAsk")}</span>
              <button type="button" className="danger-button" data-testid="agent-trace-clear-confirm" onClick={() => void clear()}>{t("agent.traceClearConfirm")}</button>
              <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>{t("chat.cancel")}</button>
            </span>
          ) : (
            <button type="button" className="secondary-button" disabled={!stats?.count} data-testid="agent-trace-clear" onClick={() => setConfirming(true)}>{t("agent.traceClear")}</button>
          )}
        </SettingsRow>
      </SettingsSection>
      {props.children}
    </SettingsPage>
  );
}
