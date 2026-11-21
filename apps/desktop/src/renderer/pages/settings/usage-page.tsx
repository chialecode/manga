import { useCallback, useEffect, useRef, useState } from "react";
import { CAPTURE_STAGES } from "@manga/contracts/media";
import type { MessageKey, Translator } from "@manga/i18n";
import { useAsyncGuard } from "../../hooks/use-async-guard.ts";
import { asArray, attempt } from "../../lib/api.ts";
import { dayBounds, formatClockMs } from "../../lib/format.ts";
import { TraceDialog } from "../../components/trace-dialog.tsx";
import { Pager, SettingsPage, SettingsSection } from "./rows.tsx";

type T = Translator["t"];
export type UsageRow = {
  kind: "run" | "transcription" | "service";
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
  estimated?: boolean;
  pricesCheckedAt?: string | null;
  problem?: "billing" | "busy" | null;
  service?: { name: string; task: string; unit: string; quantity: number };
};
export type UsageSummary = { key: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; audioMs: number };
type Found = { rows: UsageRow[]; total: number; byDay: UsageSummary[]; byModel: UsageSummary[]; models: string[] };

const PAGE = 30;
const RUN_STATUSES = new Set(["succeeded", "completed", "running", "queued", "waiting_input", "failed", "cancelled", "interrupted"]);

/** A figure the service may not have given: "not provided" for a run that was recorded without it, "not recorded" for one saved before the field existed. */
function figure(t: T, row: UsageRow, value: number | null, format: (value: number) => string): string {
  if (value !== null) return format(value);
  return row.recorded ? t("usage.notProvided") : t("usage.notRecorded");
}

const cost = (value: number) => `${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;

/** A cost from the provider's price list is an estimate (计划 4.9): it says so, and when its prices were checked. */
function costCell(t: T, row: UsageRow): string {
  if (row.costUsd === null) return figure(t, row, null, cost);
  return row.estimated ? t("usage.estimate", { cost: cost(row.costUsd) }) : cost(row.costUsd);
}

/** What a service use counted: seconds of audio, billed characters, or searches. */
function quantityOf(t: T, row: UsageRow, formatNumber: (value: number) => string): string {
  const use = row.service!;
  if (use.unit === "second") return t("usage.unit.seconds", { value: formatNumber(Math.round(use.quantity * 10) / 10) });
  if (use.unit === "char") return t("usage.unit.chars", { value: formatNumber(use.quantity) });
  return t("usage.unit.searches", { value: formatNumber(use.quantity) });
}

const SERVICE_KIND: Record<string, "usage.kindSpeech" | "usage.kindRecognition" | "usage.kindSearch"> = { speech: "usage.kindSpeech", transcription: "usage.kindRecognition", search: "usage.kindSearch", "chat-search": "usage.kindSearch" };

function statusLabel(t: T, row: UsageRow): string {
  if (row.kind === "service") return row.status === "ok" ? t("usage.serviceOk") : t("usage.serviceError");
  if (row.kind === "transcription") {
    return (CAPTURE_STAGES as readonly string[]).includes(row.status)
      ? t(`review.stage.${row.status}` as MessageKey)
      : t("usage.status.other");
  }
  return RUN_STATUSES.has(row.status)
    ? t(`usage.status.${row.status}` as MessageKey)
    : t("usage.status.other");
}

function resultOf(t: T, row: UsageRow): string {
  if (row.problem === "billing") return t("usage.problem.billing");
  if (row.problem === "busy") return t("usage.problem.busy");
  const status = statusLabel(t, row);
  return row.errorCode ? `${status} · ${row.errorCode}` : status;
}
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
                <td>{row.audioMs ? formatClockMs(row.audioMs) : "—"}</td>
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
export function UsagePage(props: { t: T; formatDate: (value: string) => string; formatNumber: (value: number) => string; onError: (message: string) => void; onNotice?: (message: string) => void }) {
  const { t } = props;
  const [model, setModel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [found, setFound] = useState<Found | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [traceRun, setTraceRun] = useState<string | null>(null);
  const guard = useAsyncGuard();
  const onErrorRef = useRef(props.onError);
  onErrorRef.current = props.onError;

  const load = useCallback(async () => {
    const request = guard.next();
    const fromIso = from ? dayBounds(from).from : undefined;
    const toIso = to ? dayBounds(to).to : undefined;
    const result = await attempt<Found>("usage.query", {
      ...(model ? { modelId: model } : {}),
      ...(fromIso ? { from: fromIso } : {}),
      ...(toIso ? { to: toIso } : {}),
      limit: PAGE,
      offset,
    });
    if (!guard.isCurrent(request)) return;
    if (!result.ok) { setStatus("error"); onErrorRef.current(result.error.message); return; }
    setFound({ rows: asArray<UsageRow>(result.value.rows), total: Number(result.value.total ?? 0), byDay: asArray<UsageSummary>(result.value.byDay), byModel: asArray<UsageSummary>(result.value.byModel), models: asArray<string>(result.value.models) });
    setStatus("ready");
  }, [model, from, to, offset, guard]);

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
      {found?.rows.some((row) => row.estimated) ? <p className="detail-muted" data-testid="usage-estimate-note">{t("usage.estimateNote", { date: found.rows.find((row) => row.pricesCheckedAt)?.pricesCheckedAt ?? "—" })}</p> : null}
      {found ? <SummaryTable t={t} title={t("usage.byModel")} rows={found.byModel} testId="usage-by-model" label={(key) => (key.startsWith("service:") ? t(SERVICE_KIND[key.slice(8)] ?? "usage.kindSearch") : key || t("usage.noModel"))} formatNumber={number} /> : null}
      {found ? <SummaryTable t={t} title={t("usage.byDay")} rows={found.byDay} testId="usage-by-day" label={(key) => key} formatNumber={number} /> : null}
      {found && found.rows.length ? (
        <SettingsSection title={t("usage.details")} testId="usage-details">
          <div className="table-scroll">
            <table className="usage-table" data-testid="usage-rows">
              <thead><tr><th scope="col">{t("usage.time")}</th><th scope="col">{t("usage.kind")}</th><th scope="col">{t("usage.model")}</th><th scope="col">{t("usage.input")}</th><th scope="col">{t("usage.output")}</th><th scope="col">{t("usage.cost")}</th><th scope="col">{t("usage.duration")}</th><th scope="col">{t("usage.result")}</th><th scope="col"><span className="sr-only">{t("usage.trace")}</span></th></tr></thead>
              <tbody>
                {found.rows.map((row) => (
                  <tr key={`${row.kind}:${row.id}`} data-testid={`usage-row-${row.id}`} data-recorded={row.recorded ? "true" : "false"} data-kind={row.kind} data-problem={row.problem ?? undefined}>
                    <td>{props.formatDate(row.at)}</td>
                    <td>{row.kind === "run" ? t("usage.kindRun") : row.kind === "service" ? t(SERVICE_KIND[row.service!.name] ?? "usage.kindSearch") : t("usage.kindTranscription")}</td>
                    <td>{row.kind === "service" ? quantityOf(t, row, number) : row.modelId ?? (row.recorded ? t("usage.notProvided") : t("usage.notRecorded"))}</td>
                    <td>{row.kind === "service" ? "—" : figure(t, row, row.inputTokens, number)}</td>
                    <td>{row.kind === "service" ? "—" : figure(t, row, row.outputTokens, number)}</td>
                    <td title={row.estimated && row.pricesCheckedAt ? t("usage.estimateTitle", { date: row.pricesCheckedAt }) : undefined} data-testid={`usage-cost-${row.id}`}>{costCell(t, row)}</td>
                    <td>{row.kind === "service" ? "—" : row.kind === "transcription" && row.audioMs !== null ? t("usage.audioLength", { time: formatClockMs(row.audioMs) }) : figure(t, row, row.durationMs, seconds)}</td>
                    <td>{resultOf(t, row)}</td>
                    <td>{row.kind === "run" ? <button type="button" className="link-button" data-testid={`usage-trace-${row.id}`} onClick={() => setTraceRun(row.id)}>{t("usage.trace")}</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager testId="usage-pager" offset={offset} limit={PAGE} total={found.total} onPage={setOffset} previous={t("pager.previous")} next={t("pager.next")} label={(a, b, count) => t("pager.range", { from: a, to: b, total: count })} />
        </SettingsSection>
      ) : null}
      {traceRun ? <TraceDialog t={t} runId={traceRun} formatNumber={number} onNotice={props.onNotice ?? (() => undefined)} onClose={() => setTraceRun(null)} /> : null}
    </SettingsPage>
  );
}
