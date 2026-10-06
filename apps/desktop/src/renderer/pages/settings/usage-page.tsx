import { useCallback, useEffect, useRef, useState } from "react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../../lib/api.ts";
import { formatClock } from "../../readers/video-model.ts";
import { Pager, SettingsPage, SettingsSection } from "./rows.tsx";

type T = Translator["t"];
export type UsageRow = {
  kind: "run" | "transcription";
  id: string;
  at: string;
  status: string;
  recorded: boolean;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  audioMs: number | null;
  sessionId: string | null;
  errorCode: string | null;
};
export type UsageSummary = { key: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; audioMs: number };
type Found = { rows: UsageRow[]; total: number; byDay: UsageSummary[]; byModel: UsageSummary[]; models: string[] };

const PAGE = 30;
const dayStart = (value: string) => { const [y, m, d] = value.split("-").map(Number); return new Date(y!, (m ?? 1) - 1, d ?? 1).toISOString(); };
const dayEnd = (value: string) => { const [y, m, d] = value.split("-").map(Number); return new Date(y!, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999).toISOString(); };

/** A figure the service may not have given: "not provided" for a run that was recorded without it, "not recorded" for one saved before the field existed. */
function figure(t: T, row: UsageRow, value: number | null, format: (value: number) => string): string {
  if (value !== null) return format(value);
  return row.recorded ? t("usage.notProvided") : t("usage.notRecorded");
}

const cost = (value: number) => `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
const seconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

function SummaryTable(props: { t: T; title: string; rows: UsageSummary[]; testId: string; label: (key: string) => string; formatNumber: (value: number) => string }) {
  const { t } = props;
  if (!props.rows.length) return null;
  return (
    <SettingsSection title={props.title} testId={props.testId}>
      <div className="table-scroll">
        <table className="usage-table">
          <thead><tr><th scope="col">{t("usage.group")}</th><th scope="col">{t("usage.runs")}</th><th scope="col">{t("usage.input")}</th><th scope="col">{t("usage.output")}</th><th scope="col">{t("usage.cost")}</th><th scope="col">{t("usage.duration")}</th><th scope="col">{t("usage.audio")}</th></tr></thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.key} data-testid={`${props.testId}-${row.key}`}>
                <th scope="row">{props.label(row.key)}</th>
                <td>{props.formatNumber(row.runs)}</td>
                <td>{props.formatNumber(row.inputTokens)}</td>
                <td>{props.formatNumber(row.outputTokens)}</td>
                <td>{cost(row.costUsd)}</td>
                <td>{seconds(row.durationMs)}</td>
                <td>{row.audioMs ? formatClock(row.audioMs) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingsSection>
  );
}

/**
 * What each Agent run and transcription used (A-49): the model, the tokens and cost the service reported, how long it took and how it
 * ended, summarised by day and by model. A figure the service did not provide says so instead of showing zero.
 */
export function UsagePage(props: { t: T; formatDate: (value: string) => string; formatNumber: (value: number) => string; onError: (message: string) => void }) {
  const { t } = props;
  const [model, setModel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [found, setFound] = useState<Found | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    const result = await attempt<Found>("usage.query", {
      ...(model ? { modelId: model } : {}),
      ...(from ? { from: dayStart(from) } : {}),
      ...(to ? { to: dayEnd(to) } : {}),
      limit: PAGE,
      offset,
    });
    if (request !== latest.current) return;
    if (!result.ok) { setStatus("error"); props.onError(result.error.message); return; }
    setFound({ rows: asArray<UsageRow>(result.value.rows), total: Number(result.value.total ?? 0), byDay: asArray<UsageSummary>(result.value.byDay), byModel: asArray<UsageSummary>(result.value.byModel), models: asArray<string>(result.value.models) });
    setStatus("ready");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, from, to, offset]);

  useEffect(() => { void load(); }, [load]);

  const patch = (apply: () => void) => { apply(); setOffset(0); };
  const number = props.formatNumber;

  return (
    <SettingsPage id="usage" title={t("settings.page.usage")} hint={t("usage.hint")} wide>
      <div className="records-filters" role="search" data-testid="usage-filters">
        <select aria-label={t("usage.model")} data-testid="usage-model" value={model} onChange={(event) => patch(() => setModel(event.target.value))}>
          <option value="">{t("usage.modelAll")}</option>
          {(found?.models ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <label className="records-date"><span>{t("logs.from")}</span><input type="date" data-testid="usage-from" value={from} max={to || undefined} onChange={(event) => patch(() => setFrom(event.target.value))} /></label>
        <label className="records-date"><span>{t("logs.to")}</span><input type="date" data-testid="usage-to" value={to} min={from || undefined} onChange={(event) => patch(() => setTo(event.target.value))} /></label>
      </div>
      {status === "loading" && !found ? <p role="status" className="detail-muted">{t("status.loading")}</p> : null}
      {found && found.rows.length === 0 && offset === 0 ? <p className="detail-muted settings-empty" data-testid="usage-empty">{t("usage.empty")}</p> : null}
      {found ? <SummaryTable t={t} title={t("usage.byModel")} rows={found.byModel} testId="usage-by-model" label={(key) => key || t("usage.noModel")} formatNumber={number} /> : null}
      {found ? <SummaryTable t={t} title={t("usage.byDay")} rows={found.byDay} testId="usage-by-day" label={(key) => key} formatNumber={number} /> : null}
      {found && found.rows.length ? (
        <SettingsSection title={t("usage.details")} testId="usage-details">
          <div className="table-scroll">
            <table className="usage-table" data-testid="usage-rows">
              <thead><tr><th scope="col">{t("usage.time")}</th><th scope="col">{t("usage.kind")}</th><th scope="col">{t("usage.model")}</th><th scope="col">{t("usage.input")}</th><th scope="col">{t("usage.output")}</th><th scope="col">{t("usage.cost")}</th><th scope="col">{t("usage.duration")}</th><th scope="col">{t("usage.result")}</th></tr></thead>
              <tbody>
                {found.rows.map((row) => (
                  <tr key={`${row.kind}:${row.id}`} data-testid={`usage-row-${row.id}`} data-recorded={row.recorded ? "true" : "false"}>
                    <td>{props.formatDate(row.at)}</td>
                    <td>{row.kind === "run" ? t("usage.kindRun") : t("usage.kindTranscription")}</td>
                    <td>{row.modelId ?? (row.recorded ? t("usage.notProvided") : t("usage.notRecorded"))}</td>
                    <td>{figure(t, row, row.inputTokens, number)}</td>
                    <td>{figure(t, row, row.outputTokens, number)}</td>
                    <td>{figure(t, row, row.costUsd, cost)}</td>
                    <td>{row.kind === "transcription" && row.audioMs !== null ? t("usage.audioLength", { time: formatClock(row.audioMs) }) : figure(t, row, row.durationMs, seconds)}</td>
                    <td>{row.errorCode ? `${row.status} · ${row.errorCode}` : row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager testId="usage-pager" offset={offset} limit={PAGE} total={found.total} onPage={setOffset} previous={t("pager.previous")} next={t("pager.next")} label={(a, b, count) => t("pager.range", { from: a, to: b, total: count })} />
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
