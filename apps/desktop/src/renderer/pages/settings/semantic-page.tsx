import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageKey, Translator } from "@manga/i18n";
import { attempt } from "../../lib/api.ts";
import { SEMANTIC_SEGMENTATIONS, type SemanticSegmentation, type SemanticStatusView } from "../../lib/semantic-model.ts";
import { Modal } from "../../components/modal.tsx";
import { SettingsEmpty, SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];

/**
 * The optional semantic index (SEARCH-02): whether it is on, which embedding connection and way of cutting it uses, how far the build is,
 * and what the person can do about a build that failed or an index that no longer matches the settings. Nothing is sent to a connection
 * until it is turned on, and what the index holds can be cleared at any time without touching the content it was made from.
 */
export function SemanticPage(props: {
  t: T;
  formatDate: (value: string) => string;
  formatNumber: (value: number) => string;
  onGoto: (page: "models") => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [status, setStatus] = useState<SemanticStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const alive = useRef(true);
  const latest = useRef(0);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    latest.current += 1;
    const mine = latest.current;
    const result = await attempt<SemanticStatusView>("semantic.status", {});
    if (!alive.current || mine !== latest.current) return;
    if (!result.ok) { props.onError(result.error.message); return; }
    setStatus(result.value);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const off = window.manga.onNotice?.((notice) => {
      if (notice.topic !== "semantic.progress") return;
      if (notice.payload.status === "active" && notice.payload.kind === "build") props.onNotice(t("semantic.notice.built"));
      void load();
    });
    return () => { off?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function run(commandId: string, input: Record<string, unknown> = {}, notice?: string) {
    if (busy) return false;
    setBusy(true);
    const result = await attempt(commandId, input);
    if (!alive.current) return false;
    setBusy(false);
    if (!result.ok) {
      const reason = (result.error as { details?: { reason?: string } }).details?.reason;
      props.onError(reason === "noConnection" ? t("semantic.error.noConnection") : result.error.message);
      await load();
      return false;
    }
    if (notice) props.onNotice(notice);
    await load();
    return true;
  }

  const configure = (patch: { enabled?: boolean; connectionId?: string; segmentation?: SemanticSegmentation }, notice?: string) => {
    if (!status) return Promise.resolve(false);
    const connectionId = patch.connectionId ?? status.connectionId ?? status.connections[0]?.id;
    return run("semantic.configure", { enabled: patch.enabled ?? status.enabled, ...(connectionId ? { connectionId } : {}), segmentation: patch.segmentation ?? status.segmentation }, notice);
  };

  if (!status) return <SettingsPage id="semantic" title={t("semantic.title")} hint={t("semantic.hint")}><SettingsEmpty text={t("status.loading")} testId="semantic-loading" /></SettingsPage>;

  const building = status.building;
  const connection = status.connectionId ?? status.connections[0]?.id ?? "";
  const known = status.connections.some((item) => item.id === connection);
  const active = status.active;

  return (
    <SettingsPage id="semantic" title={t("semantic.title")} hint={t("semantic.hint")}>
      <SettingsSection title={t("semantic.section.setup")} testId="semantic-setup">
        <SettingsRow label={t("semantic.enable")} hint={t("semantic.enableHint")} htmlFor="semantic-enabled">
          <input id="semantic-enabled" type="checkbox" role="switch" data-testid="semantic-enabled" checked={status.enabled} disabled={busy || (!status.enabled && status.connections.length === 0)}
            onChange={(event) => void configure({ enabled: event.target.checked }, event.target.checked ? t("semantic.notice.on") : t("semantic.notice.off"))} />
        </SettingsRow>
        {status.connections.length === 0 ? (
          <SettingsRow label={t("semantic.connectionNone")} testId="semantic-connection-none">
            <button type="button" className="secondary-button" data-testid="semantic-goto-models" onClick={() => props.onGoto("models")}>{t("semantic.connectionOpen")}</button>
          </SettingsRow>
        ) : (
          <SettingsRow label={t("semantic.connection")} hint={t("semantic.connectionHint")} htmlFor="semantic-connection">
            <select id="semantic-connection" data-testid="semantic-connection" value={known ? connection : ""} disabled={busy} onChange={(event) => void configure({ connectionId: event.target.value })}>
              {known ? null : <option value="" disabled>—</option>}
              {status.connections.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.model}</option>)}
            </select>
          </SettingsRow>
        )}
        <SettingsRow label={t("semantic.segmentation")} hint={t("semantic.segmentationHint")} htmlFor="semantic-segmentation">
          <select id="semantic-segmentation" data-testid="semantic-segmentation" value={status.segmentation} disabled={busy} onChange={(event) => void configure({ segmentation: event.target.value as SemanticSegmentation })}>
            {SEMANTIC_SEGMENTATIONS.map((id) => <option key={id} value={id}>{t(`semantic.segmentation.${id}` as MessageKey)}</option>)}
          </select>
        </SettingsRow>
        <p className="detail-muted" data-testid="semantic-estimate">
          {status.estimate.chunks > 0 ? t("semantic.estimate", { chunks: props.formatNumber(status.estimate.chunks), chars: props.formatNumber(status.estimate.chars) }) : t("semantic.estimateNone")}
        </p>
      </SettingsSection>

      <SettingsSection title={t("semantic.section.state")} testId="semantic-state">
        {building ? (
          <div className="scan-progress" data-testid="semantic-building" role="status">
            <div className="scan-progress-text">
              <span>{t(building.kind === "update" ? "semantic.state.updating" : "semantic.state.building", { done: props.formatNumber(building.done), total: props.formatNumber(building.total) })}</span>
              <span className="detail-muted">{building.model}</span>
            </div>
            <progress max={Math.max(1, building.total)} value={Math.min(building.done, Math.max(1, building.total))} aria-label={t("semantic.state.building", { done: building.done, total: building.total })} />
          </div>
        ) : null}
        {active ? (
          <p data-testid="semantic-active">
            {t("semantic.state.active", {
              model: active.model, dim: active.dim ?? "—", chunks: props.formatNumber(active.chunks),
              engine: t(`semantic.engine.${active.engine}` as MessageKey), at: props.formatDate(active.activatedAt ?? active.createdAt),
            })}
          </p>
        ) : !building ? <p className="detail-muted" data-testid="semantic-none">{t("semantic.state.none")}</p> : null}
        {status.failed ? (
          <div className="draft-warn" role="alert" data-testid="semantic-failed">
            <p className="draft-warn-text">{t("semantic.state.failed", { message: status.failed.error.message })}</p>
            <p className="detail-muted">{t(active ? "semantic.state.failedKeep" : "semantic.state.failedNone")}</p>
          </div>
        ) : null}
        {status.stale && !building ? (
          <p className="draft-warn-text" role="status" data-testid="semantic-stale">{t("semantic.state.stale", { model: active?.model ?? "", segmentation: active ? t(`semantic.segmentation.${active.segmentation}` as MessageKey) : "" })}</p>
        ) : null}
        {status.pending > 0 && active && !building ? <p className="detail-muted" data-testid="semantic-pending">{t("semantic.state.pending", { n: props.formatNumber(status.pending) })}</p> : null}
        <div className="settings-section-actions" data-testid="semantic-actions">
          {building ? <button type="button" className="secondary-button" data-testid="semantic-cancel" disabled={busy} onClick={() => void run("semantic.cancel")}>{t("semantic.cancel")}</button> : (
            <>
              <button type="button" className="secondary-button" data-testid="semantic-rebuild" disabled={busy || !status.enabled || !known} onClick={() => void run("semantic.rebuild")}>{t("semantic.rebuild")}</button>
              <button type="button" className="secondary-button" data-testid="semantic-update" disabled={busy || !status.enabled || !active || status.stale} onClick={() => void run("semantic.update")}>{t("semantic.update")}</button>
            </>
          )}
          <button type="button" className="secondary-button" data-testid="semantic-clear" disabled={busy || (!active && !status.failed && !building)} onClick={() => setConfirmClear(true)}>{t("semantic.clear")}</button>
        </div>
      </SettingsSection>

      {confirmClear ? (
        <Modal title={t("semantic.clear")} closeLabel={t("whiteboard.cancel")} onClose={() => setConfirmClear(false)} testId="semantic-clear-dialog"
          footer={<><button type="button" onClick={() => setConfirmClear(false)}>{t("whiteboard.cancel")}</button><button type="button" className="danger-button" data-testid="semantic-clear-confirm" onClick={() => { setConfirmClear(false); void run("semantic.clear", {}, t("semantic.notice.cleared")); }}>{t("semantic.clearDo")}</button></>}>
          <p>{t("semantic.clearConfirm")}</p>
        </Modal>
      ) : null}
    </SettingsPage>
  );
}
