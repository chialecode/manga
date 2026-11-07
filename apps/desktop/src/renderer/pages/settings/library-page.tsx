import { useState } from "react";
import { FolderPlus, Play, Square, Trash2 } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { attempt } from "../../lib/api.ts";
import type { LibraryPath, ScanJob, ScanSchedule, ScanState } from "../../hooks/use-scan.ts";
import { SettingsPage, SettingsRow, SettingsSection } from "./rows.tsx";

type T = Translator["t"];
type Kind = "novel" | "comic" | "video";
const KINDS: Kind[] = ["novel", "comic", "video"];
const INTERVALS: ScanSchedule["intervalMinutes"][] = [0, 30, 60, 360, 1440];

/** The scan job's progress line: the stage, how far it is, and what it is looking at. */
export function scanProgressText(t: T, job: ScanJob): string {
  const parts = [t(`scan.stage.${job.stage}`)];
  if (job.total > 0) parts.push(`${job.processed}/${job.total}`);
  else if (job.processed > 0) parts.push(String(job.processed));
  return parts.join(" · ");
}

function lastScanText(t: T, path: LibraryPath, formatDate: (value: string) => string): string {
  if (!path.lastScanAt || !path.lastScan) return t("library.path.neverScanned");
  const last = path.lastScan;
  const counts = t("library.path.lastCounts", { added: last.added, changed: last.changed, unavailable: last.unavailable, failed: last.failed });
  const status = last.status === "done" ? "" : ` · ${t(`scan.status.${last.status}`)}`;
  return `${t("library.path.lastScan", { time: formatDate(path.lastScanAt) })} · ${counts}${status}`;
}

function PathRow(props: { t: T; path: LibraryPath; scan: ScanState; busy: boolean; formatDate: (value: string) => string; onRemove: (path: LibraryPath) => void; onChange: (path: LibraryPath, patch: { mediaKind?: Kind; autoScan?: boolean }) => void }) {
  const { t, path, scan } = props;
  const [confirming, setConfirming] = useState(false);
  const scanning = scan.running?.pathId === path.id || scan.queued.some((job) => job.pathId === path.id);
  const note = !path.reachable ? t("library.path.unreachable") : lastScanText(t, path, props.formatDate);
  return (
    <li className="library-path" data-testid={`library-path-${path.id}`} data-reachable={path.reachable ? "true" : "false"}>
      <div className="library-path-main">
        <span className="library-path-name" title={path.path} data-testid={`library-path-text-${path.id}`}>{path.path}</span>
        <span className="detail-muted" data-testid={`library-path-last-${path.id}`}>{note}</span>
        <span className="detail-muted" data-testid={`library-path-files-${path.id}`}>{t("library.path.files", { present: path.files.present, unavailable: path.files.unavailable })}</span>
      </div>
      <div className="library-path-controls">
        <select aria-label={t("library.path.kind")} data-testid={`library-path-kind-${path.id}`} value={path.mediaKind} disabled={props.busy} onChange={(event) => props.onChange(path, { mediaKind: event.target.value as Kind })}>
          {KINDS.map((kind) => <option key={kind} value={kind}>{t(`shelf.kind.${kind}`)}</option>)}
        </select>
        <label className="msettings-check"><input type="checkbox" data-testid={`library-path-auto-${path.id}`} checked={path.autoScan} onChange={(event) => props.onChange(path, { autoScan: event.target.checked })} />{t("library.path.auto")}</label>
        <button type="button" className="secondary-button" data-testid={`library-path-scan-${path.id}`} disabled={scanning} onClick={() => void scan.start(path.id)}><Play size={14} aria-hidden="true" />{scanning ? t("library.scanning") : t("library.scanNow")}</button>
        {confirming ? (
          <span className="library-path-confirm" role="group" aria-label={t("library.path.removeConfirm")}>
            <span className="detail-muted">{t("library.path.removeHint")}</span>
            <button type="button" className="danger-button" data-testid={`library-path-remove-confirm-${path.id}`} onClick={() => { setConfirming(false); props.onRemove(path); }}>{t("library.path.remove")}</button>
            <button type="button" className="link-button" onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
          </span>
        ) : (
          <button type="button" className="link-button" data-testid={`library-path-remove-${path.id}`} onClick={() => setConfirming(true)}><Trash2 size={14} aria-hidden="true" />{t("library.path.remove")}</button>
        )}
      </div>
    </li>
  );
}

/**
 * Library paths and the background scan (A-50): the paths with their medium and last result, the schedule, the running scan with
 * its progress and a way to stop it, and the one-off import of a file or folder. Removing a path only stops scanning it.
 */
export function LibraryPage(props: {
  t: T;
  scan: ScanState;
  formatDate: (value: string) => string;
  onImport: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t, scan } = props;
  const [kind, setKind] = useState<Kind>("novel");
  const [busy, setBusy] = useState(false);

  async function addPath() {
    const handle = await window.manga.chooseDirectory();
    if (!handle) return;
    setBusy(true);
    const result = await attempt("library.paths.add", { pathHandle: handle, mediaKind: kind, autoScan: true });
    setBusy(false);
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("library.path.added"));
    await scan.reload();
    props.onChanged();
  }

  async function change(path: LibraryPath, patch: { mediaKind?: Kind; autoScan?: boolean }) {
    setBusy(true);
    const result = await attempt("library.paths.update", { pathId: path.id, ...patch });
    setBusy(false);
    if (!result.ok) { props.onError(result.error.message); return; }
    await scan.reload();
  }

  async function remove(path: LibraryPath) {
    const result = await attempt("library.paths.remove", { pathId: path.id });
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("library.path.removed"));
    await scan.reload();
    props.onChanged();
  }

  const running = scan.running;
  return (
    <SettingsPage id="library" title={t("settings.page.library")} hint={t("library.hint")}>
      <SettingsSection title={t("library.schedule")} testId="library-schedule">
        <SettingsRow label={t("library.onStartup")} hint={t("library.onStartupHint")} htmlFor="library-on-startup">
          <input id="library-on-startup" type="checkbox" role="switch" data-testid="library-on-startup" checked={scan.schedule.onStartup} onChange={(event) => void scan.setSchedule({ ...scan.schedule, onStartup: event.target.checked })} />
        </SettingsRow>
        <SettingsRow label={t("library.interval")} hint={t("library.intervalHint")} htmlFor="library-interval">
          <select id="library-interval" data-testid="library-interval" value={String(scan.schedule.intervalMinutes)} onChange={(event) => void scan.setSchedule({ ...scan.schedule, intervalMinutes: Number(event.target.value) as ScanSchedule["intervalMinutes"] })}>
            {INTERVALS.map((minutes) => <option key={minutes} value={String(minutes)}>{t(`library.interval.${minutes}` as "library.interval.0")}</option>)}
          </select>
        </SettingsRow>
        {running ? (
          <div className="scan-progress" role="status" data-testid="scan-progress" data-stage={running.stage}>
            <div className="scan-progress-text">
              <strong>{scanProgressText(t, running)}</strong>
              {running.current ? <span className="detail-muted scan-current" data-testid="scan-current" title={running.current}>{running.current}</span> : null}
              <span className="detail-muted">{t("library.scan.found", { added: running.added, changed: running.changed, unavailable: running.unavailable })}</span>
            </div>
            <progress max={running.total || undefined} value={running.total ? running.processed : undefined} aria-label={t("library.scanning")} />
            <button type="button" className="secondary-button" data-testid="scan-cancel" onClick={() => void scan.cancel(running.id)}><Square size={14} aria-hidden="true" />{t("library.cancelScan")}</button>
          </div>
        ) : null}
        {scan.queued.length ? <p className="detail-muted" data-testid="scan-queued">{t("library.scan.queued", { count: scan.queued.length })}</p> : null}
        {scan.error ? <p role="alert" className="review-error" data-testid="scan-error">{scan.error}</p> : null}
      </SettingsSection>

      <SettingsSection
        title={t("library.paths")}
        hint={t("library.pathsHint")}
        testId="library-paths"
        actions={
          <>
            <select aria-label={t("library.path.kind")} data-testid="library-path-new-kind" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
              {KINDS.map((item) => <option key={item} value={item}>{t(`shelf.kind.${item}`)}</option>)}
            </select>
            <button type="button" className="primary-button" data-testid="library-path-add" disabled={busy} onClick={() => void addPath()}><FolderPlus size={16} aria-hidden="true" />{t("library.path.add")}</button>
            <button type="button" className="secondary-button" data-testid="library-scan-all" disabled={!scan.paths.length || Boolean(running)} onClick={() => void scan.start()}><Play size={14} aria-hidden="true" />{t("library.scanAll")}</button>
          </>
        }
      >
        {scan.pathsLoaded && scan.paths.length === 0 ? <p className="detail-muted settings-empty" data-testid="library-paths-empty">{t("library.paths.empty")}</p> : null}
        <ul className="library-paths">
          {scan.paths.map((path) => <PathRow key={path.id} t={t} path={path} scan={scan} busy={busy} formatDate={props.formatDate} onRemove={(item) => void remove(item)} onChange={(item, patch) => void change(item, patch)} />)}
        </ul>
      </SettingsSection>

      <SettingsSection title={t("library.once")} hint={t("library.onceHint")} testId="library-once">
        <SettingsRow label={t("library.onceRow")}>
          <button type="button" className="secondary-button" data-testid="settings-import" onClick={props.onImport}>{t("library.onceButton")}</button>
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
