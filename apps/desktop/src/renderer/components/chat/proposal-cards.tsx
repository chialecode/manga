import { useState } from "react";
import type { Translator } from "@manga/i18n";
import type { ProposalCard, RoughcutExportView, RoughcutProblem } from "@manga/contracts";
import { attempt, messageOf } from "../../lib/api.ts";
import { Modal } from "../modal.tsx";
import { problemText, stepText } from "../../pages/projects/roughcut/roughcut-model.ts";

type T = Translator["t"];

function shortTime(iso: string | null, formatDate: (v: string) => string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function executeProposalApply(proposal: ProposalCard) {
  let pathHandle: string | undefined;
  if (proposal.kind === "exportProject") {
    const picked = await window.manga.pick?.({ mode: "directory" });
    if (!picked) return null;
    pathHandle = picked.pathHandle;
  }
  return attempt("proposal.apply", { proposalId: proposal.id, ...(pathHandle ? { pathHandle } : {}) });
}

function ProposalCardItem(props: { t: T; proposal: ProposalCard; formatDate: (v: string) => string; onChanged?: () => void; disabled?: boolean }) {
  const { t, proposal, formatDate } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { preview } = proposal;
  const status = busy && proposal.status === "pending" ? "applying" : proposal.status;

  async function apply() {
    if (busy || props.disabled || proposal.status !== "pending") return;
    setBusy(true);
    setError(null);
    try {
      const ran = await executeProposalApply(proposal);
      if (ran && !ran.ok) setError(ran.error.message);
      if (ran !== null) props.onChanged?.();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (busy || props.disabled || proposal.status !== "pending") return;
    setBusy(true);
    setError(null);
    try {
      const result = await attempt("proposal.reject", { proposalId: proposal.id });
      if (!result.ok) setError(result.error.message);
      props.onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  const exportView = (proposal.result?.output as { export?: RoughcutExportView } | undefined)?.export;
  async function cancelExport() {
    if (!exportView || busy) return;
    setBusy(true);
    try {
      const result = await attempt("roughcut.cancel", { exportId: exportView.id });
      if (!result.ok) setError(result.error.message);
      props.onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  const problems = (preview.meta?.problems ?? []) as RoughcutProblem[];
  const titles = (preview.meta?.clipTitles ?? {}) as Record<string, string>;
  const warnings = [...preview.warnings, ...problems.map((problem) => problemText(t, problem, (clipId) => titles[clipId ?? ""] ?? ""))];

  const time = shortTime(proposal.decidedAt, formatDate);
  const staleReason = String(proposal.result?.reason ?? t("proposal.staleDefault"));
  const failReason = String((proposal.result?.error as { message?: string } | undefined)?.message ?? proposal.result?.reason ?? t("proposal.failedDefault"));

  return (
    <section className="proposal-card" data-testid={`proposal-card-${proposal.id}`} data-status={status} data-kind={proposal.kind} aria-label={preview.title}>
      <header className="proposal-head">
        <strong className="proposal-title" data-testid={`proposal-title-${proposal.id}`}>{preview.title}</strong>
      </header>
      <p className="proposal-summary" data-testid={`proposal-summary-${proposal.id}`}>{preview.summary}</p>
      {proposal.reason ? <p className="proposal-reason detail-muted" data-testid={`proposal-reason-${proposal.id}`}>{t("proposal.reason", { reason: proposal.reason })}</p> : null}
      {preview.lines.length > 0 ? (
        <ul className="proposal-lines" data-testid={`proposal-lines-${proposal.id}`}>
          {preview.lines.map((line, idx) => <li key={idx}>{line}</li>)}
        </ul>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="proposal-warnings" data-testid={`proposal-warnings-${proposal.id}`}>
          {warnings.map((warning, idx) => <li key={idx}>{warning}</li>)}
        </ul>
      ) : null}
      <div className="proposal-actions">
        {status === "pending" ? (
          <>
            <button
              type="button"
              className={preview.irreversible ? "danger-button" : "primary-button"}
              data-testid={`proposal-apply-${proposal.id}`}
              disabled={busy || props.disabled}
              onClick={() => void apply()}
            >
              {t("proposal.apply")}
            </button>
            {preview.irreversible ? <span className="proposal-irreversible" data-testid={`proposal-irreversible-${proposal.id}`}>{t("proposal.irreversible")}</span> : null}
            <button
              type="button"
              className="secondary-button"
              data-testid={`proposal-reject-${proposal.id}`}
              disabled={busy || props.disabled}
              onClick={() => void reject()}
            >
              {t("proposal.reject")}
            </button>
          </>
        ) : status === "applying" ? (
          <>
            <span className="proposal-status" role="status" data-testid={`proposal-status-${proposal.id}`} data-status="applying">{exportView ? stepText(t, exportView) : t("proposal.applying")}</span>
            {exportView ? <button type="button" className="secondary-button" data-testid={`proposal-cancel-${proposal.id}`} disabled={busy || props.disabled} onClick={() => void cancelExport()}>{t("roughcut.export.cancel")}</button> : null}
          </>
        ) : status === "applied" ? (
          <span className="proposal-status proposal-status-applied" role="status" data-testid={`proposal-status-${proposal.id}`} data-status="applied">
            {time ? t("proposal.status.appliedAt", { time }) : t("proposal.status.applied")}
          </span>
        ) : status === "rejected" ? (
          <span className="proposal-status proposal-status-rejected" role="status" data-testid={`proposal-status-${proposal.id}`} data-status="rejected">
            {time ? t("proposal.status.rejectedAt", { time }) : t("proposal.status.rejected")}
          </span>
        ) : status === "stale" ? (
          <span className="proposal-status proposal-status-stale" role="status" data-testid={`proposal-status-${proposal.id}`} data-status="stale">
            {t("proposal.status.stale", { reason: staleReason })}
          </span>
        ) : (
          <span className="proposal-status proposal-status-failed" role="status" data-testid={`proposal-status-${proposal.id}`} data-status="failed">
            {t("proposal.status.failed", { reason: failReason })}
          </span>
        )}
      </div>
      {error ? <p role="alert" data-testid={`proposal-error-${proposal.id}`}>{error}</p> : null}
    </section>
  );
}

export function ProposalGroup(props: { t: T; runId: string; proposals: ProposalCard[]; formatDate: (v: string) => string; onChanged?: () => void }) {
  const { t, runId, proposals, formatDate } = props;
  const [confirmItems, setConfirmItems] = useState<ProposalCard[] | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchErrors, setBatchErrors] = useState<string[]>([]);
  const pending = proposals.filter((item) => item.status === "pending");
  const anyIrreversible = (confirmItems ?? []).some((item) => item.preview.irreversible);

  async function applyAll() {
    if (batchBusy) return;
    const confirmed = confirmItems ?? [];
    setConfirmItems(null);
    setBatchBusy(true);
    setBatchErrors([]);
    try {
      for (const item of confirmed) {
        try {
          const result = await executeProposalApply(item);
          if (result && !result.ok) setBatchErrors((errors) => [...errors, `${item.preview.title}：${result.error.message}`]);
        } catch (cause) {
          setBatchErrors((errors) => [...errors, `${item.preview.title}：${messageOf(cause)}`]);
        }
      }
      props.onChanged?.();
    } finally {
      setBatchBusy(false);
    }
  }

  async function rejectAll() {
    if (batchBusy) return;
    setBatchBusy(true);
    setBatchErrors([]);
    try {
      for (const item of pending) {
        const result = await attempt("proposal.reject", { proposalId: item.id });
        if (!result.ok) setBatchErrors((errors) => [...errors, `${item.preview.title}：${result.error.message}`]);
      }
      props.onChanged?.();
    } finally {
      setBatchBusy(false);
    }
  }

  return (
    <div className="proposal-group" data-testid={`proposal-group-${runId}`}>
      {pending.length >= 2 ? (
        <div className="proposal-batch" data-testid={`proposal-batch-${runId}`}>
          <button type="button" className="primary-button" data-testid={`proposal-batch-apply-${runId}`} disabled={batchBusy} onClick={() => { setBatchErrors([]); setConfirmItems(pending); }}>
            {t("proposal.batch.apply", { count: pending.length })}
          </button>
          <button type="button" className="secondary-button" data-testid={`proposal-batch-reject-${runId}`} disabled={batchBusy} onClick={() => void rejectAll()}>
            {t("proposal.batch.reject")}
          </button>
        </div>
      ) : null}
      {proposals.map((proposal) => (
        <ProposalCardItem key={proposal.id} t={t} proposal={proposal} formatDate={formatDate} onChanged={props.onChanged} disabled={batchBusy} />
      ))}
      {batchErrors.length ? <ul role="alert" data-testid={`proposal-batch-errors-${runId}`}>{batchErrors.map((message, index) => <li key={index}>{message}</li>)}</ul> : null}
      {confirmItems ? (
        <Modal
          testId="proposal-batch-modal"
          title={t("proposal.batch.title")}
          closeLabel={t("proposal.batch.cancel")}
          onClose={() => setConfirmItems(null)}
          footer={
            <>
              <button type="button" className="secondary-button" data-testid="proposal-batch-cancel" onClick={() => setConfirmItems(null)}>{t("proposal.batch.cancel")}</button>
              <button type="button" className={anyIrreversible ? "danger-button" : "primary-button"} data-testid="proposal-batch-confirm" disabled={batchBusy} onClick={() => void applyAll()}>
                {t("proposal.batch.confirm")}
              </button>
            </>
          }
        >
          <p>{t("proposal.batch.lead", { count: confirmItems.length })}</p>
          <ul className="proposal-batch-list" data-testid="proposal-batch-list">
            {confirmItems.map((item) => (
              <li key={item.id}>
                <strong>{item.preview.title}</strong> — <span>{item.preview.summary}</span>
                {item.preview.irreversible ? <span className="proposal-irreversible">（{t("proposal.irreversible")}）</span> : null}
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </div>
  );
}
