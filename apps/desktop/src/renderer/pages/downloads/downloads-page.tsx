import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, FileUp, Pause, Play, Share2, Square, Trash2, X } from "lucide-react";
import type { MessageKey, Translator } from "@manga/i18n";
import { asArray, attempt, type CommandError } from "../../lib/api.ts";
import {
  bytesLabel, canChoose, errorKey, folderName, mergeJob, progressOf, reasonKey, speedLabel,
  type DownloadEntry, type DownloadJob, type DownloadList, type LibraryPathOption,
} from "../../lib/download-model.ts";
import { Modal } from "../../components/modal.tsx";

type T = Translator["t"];

/**
 * The downloads page (ACQ-01—03): add a magnet link or a torrent file and say which library path it goes into; choose the files from the
 * list the torrent reports; watch the transfer; and see what became of each file, with the retry that fits the stage a job stopped in. The
 * source a download came from is never shown: a magnet link can carry a tracker key.
 */
export function DownloadsPage(props: {
  t: T;
  onOpenSettings: (page: "plugins" | "library") => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  /** Called when something was added to the library, so shelves show it. */
  onLibraryChanged?: () => void;
}) {
  const { t } = props;
  const [list, setList] = useState<DownloadList | null>(null);
  const [paths, setPaths] = useState<LibraryPathOption[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Record<string, Set<number>>>({});
  const [cancelling, setCancelling] = useState<DownloadJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  const known = useRef<DownloadList | null>(null);
  const changed = useRef(props.onLibraryChanged);
  changed.current = props.onLibraryChanged;
  useEffect(() => () => { alive.current = false; }, []);

  const failure = useCallback((error: CommandError): string => {
    const key = reasonKey(error);
    return key ? t(key) : error.message;
  }, [t]);

  const put = useCallback((next: DownloadList | ((current: DownloadList | null) => DownloadList | null)) => {
    const value = typeof next === "function" ? next(known.current) : next;
    known.current = value;
    setList(value);
  }, []);

  /** A job with its files, for the cards that show them. */
  const refreshJob = useCallback(async (jobId: string) => {
    const result = await attempt<{ job: DownloadJob }>("acquisition.get", { jobId });
    if (!alive.current || !result.ok) return;
    put((current) => (current ? { ...current, jobs: mergeJob(current.jobs, result.value.job) } : current));
    const job = result.value.job;
    if (job.state === "choosing" && job.entries) {
      // What the person chooses starts as every file, or as what was chosen before.
      const before = job.entries.filter((entry) => entry.selected).map((entry) => entry.index);
      setPicked((all) => (all[jobId] ? all : { ...all, [jobId]: new Set(before.length ? before : job.entries!.map((entry) => entry.index)) }));
    }
  }, [put]);

  const load = useCallback(async () => {
    const [downloads, library] = await Promise.all([attempt<DownloadList>("acquisition.list", {}), attempt<{ paths: LibraryPathOption[] }>("library.paths.list", {})]);
    if (!alive.current) return;
    if (!downloads.ok) { props.onError(failure(downloads.error)); return; }
    put({ engine: downloads.value.engine, jobs: asArray<DownloadJob>(downloads.value.jobs) });
    if (library.ok) setPaths(asArray<LibraryPathOption>(library.value.paths));
    for (const job of asArray<DownloadJob>(downloads.value.jobs)) if (job.state === "choosing") void refreshJob(job.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const off = window.manga.onNotice?.((notice) => {
      const payload = notice.payload as { jobId?: string; job?: DownloadJob; removed?: boolean; name?: string };
      if (notice.topic === "plugin.changed") { void load(); return; }
      if (notice.topic === "acquisition.done") { props.onNotice(t("downloads.notice.done", { name: payload.name ?? "" })); changed.current?.(); return; }
      if (notice.topic === "acquisition.seedStopped") { props.onNotice(t((payload as { reason?: string }).reason === "error" ? "downloads.notice.seedFailed" : "downloads.notice.seedStopped", { name: "" })); void load(); return; }
      if (notice.topic !== "acquisition.changed" || !payload.jobId) return;
      if (payload.removed) { put((current) => (current ? { ...current, jobs: current.jobs.filter((job) => job.id !== payload.jobId) } : current)); return; }
      const job = payload.job;
      if (!job) return;
      const before = known.current?.jobs.find((item) => item.id === job.id);
      put((current) => (current ? { ...current, jobs: mergeJob(current.jobs, job) } : current));
      // The files of a job are fetched when the page first needs them: when it has to choose, finishes, or stops with something to show.
      const needsFiles = job.state === "choosing" || job.state === "done" || job.state === "failed" || open.has(job.id);
      if (needsFiles && (before?.state !== job.state || !before?.entries)) void refreshJob(job.id);
    });
    return () => { off?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, open]);

  /** The default download folder as a library path of one medium (A-69): made on first use, found again after. Returns its id. */
  async function ensureDefault(mediaKind: string): Promise<string | null> {
    const result = await attempt<{ path: LibraryPathOption; created: boolean }>("library.paths.ensureDownloads", { mediaKind });
    if (!alive.current) return null;
    if (!result.ok) { props.onError(failure(result.error)); return null; }
    const library = await attempt<{ paths: LibraryPathOption[] }>("library.paths.list", {});
    if (alive.current && library.ok) setPaths(asArray<LibraryPathOption>(library.value.paths));
    return result.value.path.id;
  }

  async function run<R>(jobId: string, commandId: string, input: Record<string, unknown>): Promise<{ ok: true; value: R } | { ok: false }> {
    if (busy) return { ok: false };
    setBusy(jobId);
    const result = await attempt<R>(commandId, { jobId, ...input });
    if (!alive.current) return { ok: false };
    setBusy(null);
    if (!result.ok) { props.onError(failure(result.error)); void refreshJob(jobId); return { ok: false }; }
    const value = result.value as { job?: DownloadJob };
    if (value.job) put((current) => (current ? { ...current, jobs: mergeJob(current.jobs, value.job!) } : current));
    return { ok: true, value: result.value };
  }

  const toggle = (jobId: string) => {
    setOpen((current) => { const next = new Set(current); if (next.has(jobId)) next.delete(jobId); else { next.add(jobId); void refreshJob(jobId); } return next; });
  };

  const jobs = list?.jobs ?? [];
  const engine = list?.engine;
  return (
    <section className="downloads-page" data-testid="page-downloads" aria-labelledby="downloads-title">
      <header className="downloads-head">
        <h2 id="downloads-title">{t("downloads.title")}</h2>
        <span className={`chip${engine?.running ? "" : " chip-warn"}`} data-testid="downloads-engine" data-running={engine?.running ? "yes" : "no"}>
          {t(engine?.running ? "downloads.engine.running" : engine?.reason === "not-running" ? "downloads.engine.notRunning" : "downloads.engine.none")}
        </span>
        {engine && !engine.running ? <button type="button" className="secondary-button" data-testid="downloads-open-plugins" onClick={() => props.onOpenSettings("plugins")}>{t("downloads.openPlugins")}</button> : null}
      </header>
      <p className="detail-muted">{t("downloads.hint")}</p>
      <p className="detail-muted" data-testid="downloads-legal">{t("downloads.legal")}</p>

      <AddDownload t={t} paths={paths} enabled={Boolean(engine?.running)} onOpenSettings={props.onOpenSettings} onError={props.onError} onEnsureDefault={ensureDefault}
        onAdded={(job) => { put((current) => (current ? { ...current, jobs: mergeJob(current.jobs, job) } : current)); props.onNotice(t("downloads.notice.added")); }} failure={failure} />

      <h3 className="downloads-list-title">{t("downloads.list")}</h3>
      {list === null ? <p className="detail-muted" role="status">{t("status.loading")}</p> : jobs.length === 0 ? <p className="detail-muted" data-testid="downloads-empty">{t("downloads.empty")}</p> : (
        <ul className="downloads-list" data-testid="downloads-list">
          {jobs.map((job) => (
            <li key={job.id}>
              <JobCard t={t} job={job} paths={paths} engineRunning={Boolean(engine?.running)} busy={busy === job.id} expanded={open.has(job.id)} picked={picked[job.id]}
                onToggle={() => toggle(job.id)}
                onPick={(next) => setPicked((all) => ({ ...all, [job.id]: next }))}
                onRun={(commandId, input) => run(job.id, commandId, input)}
                onCancel={() => setCancelling(job)}
                onRemoved={() => { props.onNotice(t("downloads.notice.removed")); void load(); }} />
            </li>
          ))}
        </ul>
      )}

      {cancelling ? (
        <Modal testId="download-cancel-confirm" title={t("downloads.cancel.title")} closeLabel={t("common.close")} onClose={() => setCancelling(null)}
          footer={<>
            <button type="button" className="secondary-button" data-testid="download-cancel-keep" onClick={() => setCancelling(null)}>{t("downloads.cancel.keep")}</button>
            <button type="button" className="primary-button danger-button" data-testid="download-cancel-do" disabled={busy !== null}
              onClick={() => { const job = cancelling; setCancelling(null); void run(job.id, "acquisition.cancel", {}).then((result) => { if (result.ok) { props.onNotice(t("downloads.notice.cancelled")); void load(); } }); }}>{t("downloads.cancel.do")}</button>
          </>}>
          <p data-testid="download-cancel-text">{t("downloads.cancel.text")}</p>
        </Modal>
      ) : null}
    </section>
  );
}

function AddDownload(props: { t: T; paths: LibraryPathOption[]; enabled: boolean; onEnsureDefault: (mediaKind: string) => Promise<string | null>; failure: (error: CommandError) => string; onOpenSettings: (page: "plugins" | "library") => void; onError: (message: string) => void; onAdded: (job: DownloadJob) => void }) {
  const { t } = props;
  const [magnet, setMagnet] = useState("");
  const [file, setFile] = useState<{ pathHandle: string; name: string } | null>(null);
  const [pathId, setPathId] = useState("");
  const [defaultKind, setDefaultKind] = useState("video");
  const [subdir, setSubdir] = useState("");
  const [maxGb, setMaxGb] = useState("");
  const [down, setDown] = useState("");
  const [up, setUp] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const chosenPath = props.paths.find((item) => item.id === pathId)?.id ?? props.paths.find((item) => item.reachable)?.id ?? "";

  async function chooseFile() {
    if (!window.manga.pick) return;
    const result = await window.manga.pick({ mode: "file", filter: "torrent" });
    if (result) setFile({ pathHandle: result.pathHandle, name: result.name });
  }

  async function useDefaultFolder() {
    const id = await props.onEnsureDefault(defaultKind);
    if (id && alive.current) setPathId(id);
  }

  async function submit() {
    if (!file && !magnet.trim()) { props.onError(t("downloads.add.needSource")); return; }
    const number = (value: string) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; };
    const budget = { ...(number(maxGb) ? { maxBytes: Math.round(number(maxGb) * 1024 ** 3) } : {}), ...(number(down) ? { downKbps: Math.round(number(down)) } : {}), ...(number(up) ? { upKbps: Math.round(number(up)) } : {}) };
    setBusy(true);
    const result = await attempt<{ job: DownloadJob }>("acquisition.add", { ...(file ? { pathHandle: file.pathHandle } : { magnet: magnet.trim() }), pathId: chosenPath, ...(subdir.trim() ? { subdir: subdir.trim() } : {}), ...(Object.keys(budget).length ? { budget } : {}) });
    if (!alive.current) return;
    setBusy(false);
    if (!result.ok) { props.onError(props.failure(result.error)); return; }
    setMagnet(""); setFile(null);
    props.onAdded(result.value.job);
  }

  return (
    <form className="downloads-add" data-testid="downloads-add" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h3>{t("downloads.add.title")}</h3>
      {props.paths.length === 0 ? (
        <p className="detail-muted" data-testid="downloads-add-no-path">{t("downloads.add.pathNone")} <button type="button" className="secondary-button" data-testid="downloads-open-library" onClick={() => props.onOpenSettings("library")}>{t("downloads.openLibrary")}</button></p>
      ) : null}
      <div className="downloads-row" data-testid="downloads-default-folder">
        <span className="detail-muted">{t("downloads.add.defaultHint")}</span>
        <select aria-label={t("library.path.kind")} data-testid="downloads-default-kind" value={defaultKind} onChange={(event) => setDefaultKind(event.target.value)}>
          {(["video", "comic", "novel"] as const).map((kind) => <option key={kind} value={kind}>{t(`shelf.kind.${kind}`)}</option>)}
        </select>
        <button type="button" className="secondary-button" data-testid="downloads-default-use" onClick={() => void useDefaultFolder()}>{t("downloads.add.defaultUse")}</button>
      </div>
      <label className="msettings-field msettings-field-stack"><span>{t("downloads.add.magnet")}</span>
        <textarea data-testid="downloads-add-magnet" rows={2} spellCheck={false} placeholder={t("downloads.add.magnetHint")} value={magnet} disabled={Boolean(file)} onChange={(event) => setMagnet(event.target.value)} /></label>
      <div className="downloads-row">
        <span className="detail-muted">{t("downloads.add.orFile")}</span>
        <button type="button" className="secondary-button" data-testid="downloads-add-pick" onClick={() => void chooseFile()}><FileUp size={15} aria-hidden="true" /> {t("downloads.add.pickFile")}</button>
        {file ? <><span data-testid="downloads-add-file">{t("downloads.add.fileChosen", { name: file.name })}</span><button type="button" className="icon-button" aria-label={t("downloads.add.clearFile")} title={t("downloads.add.clearFile")} data-testid="downloads-add-clear" onClick={() => setFile(null)}><X size={14} /></button></> : null}
      </div>
      <label className="msettings-field"><span>{t("downloads.add.path")}</span>
        <select data-testid="downloads-add-path" value={chosenPath} onChange={(event) => setPathId(event.target.value)}>
          {props.paths.map((item) => <option key={item.id} value={item.id} disabled={!item.reachable}>{folderName(item.path)} · {t(`shelf.kind.${item.mediaKind}` as "shelf.kind.novel")}</option>)}
        </select></label>
      <label className="msettings-field"><span>{t("downloads.add.subdir")}</span>
        <input data-testid="downloads-add-subdir" maxLength={200} placeholder={t("downloads.add.subdirHint")} value={subdir} onChange={(event) => setSubdir(event.target.value)} /></label>
      <details className="downloads-limits">
        <summary>{t("downloads.add.advanced")}</summary>
        <label className="msettings-field"><span>{t("downloads.add.maxGb")}</span><input data-testid="downloads-add-maxgb" inputMode="decimal" value={maxGb} onChange={(event) => setMaxGb(event.target.value)} /></label>
        <label className="msettings-field"><span>{t("downloads.add.downKbps")}</span><input data-testid="downloads-add-down" inputMode="numeric" value={down} onChange={(event) => setDown(event.target.value)} /></label>
        <label className="msettings-field"><span>{t("downloads.add.upKbps")}</span><input data-testid="downloads-add-up" inputMode="numeric" value={up} onChange={(event) => setUp(event.target.value)} /></label>
      </details>
      <div className="downloads-row">
        <button type="submit" className="primary-button" data-testid="downloads-add-submit" disabled={busy || !props.enabled || !chosenPath}><Download size={15} aria-hidden="true" /> {t("downloads.add.submit")}</button>
      </div>
    </form>
  );
}

function JobCard(props: {
  t: T; job: DownloadJob; paths: LibraryPathOption[]; engineRunning: boolean; busy: boolean; expanded: boolean; picked: Set<number> | undefined;
  onToggle: () => void; onPick: (next: Set<number>) => void; onRun: (commandId: string, input: Record<string, unknown>) => Promise<{ ok: boolean }>; onCancel: () => void; onRemoved: () => void;
}) {
  const { t, job } = props;
  const progress = progressOf(job);
  const problem = job.state === "failed";
  const moving = job.state === "downloading" || job.state === "metadata" || job.state === "verifying";
  const entries = job.entries ?? [];
  const chosen = props.picked ?? new Set(entries.filter((entry) => entry.selected).map((entry) => entry.index));
  const chosenBytes = entries.filter((entry) => chosen.has(entry.index)).reduce((sum, entry) => sum + entry.length, 0);
  const files = props.expanded || canChoose(job) && entries.length > 0 || job.state === "done" || job.state === "failed";

  return (
    <article className="download-card" data-testid={`download-${job.id}`} data-state={job.state}>
      <header className="download-head">
        <h4 className="truncate" data-testid={`download-${job.id}-name`}>{job.name || t("downloads.waitingName")}</h4>
        <span className={`chip${problem ? " chip-warn" : ""}`} data-testid={`download-${job.id}-state`}>{t(`downloads.state.${job.state}` as MessageKey)}</span>
      </header>

      {progress !== null || moving ? (
        <progress className="download-bar" aria-label={t(`downloads.state.${job.state}` as MessageKey)} data-testid={`download-${job.id}-bar`} max={1} value={progress ?? undefined} />
      ) : null}
      {job.selectedBytes > 0 && job.state !== "done" ? <p className="detail-muted" data-testid={`download-${job.id}-progress`}>{t("downloads.progress", { done: bytesLabel(Math.min(job.downloadedBytes, job.selectedBytes)), total: bytesLabel(job.selectedBytes) })}</p> : null}
      {job.state === "downloading" ? <p className="detail-muted" data-testid={`download-${job.id}-speed`}>{t("downloads.speed", { down: speedLabel(job.speeds.down), up: speedLabel(job.speeds.up), peers: job.speeds.peers })}</p> : null}
      {job.state === "paused" ? <p className="detail-muted" data-testid={`download-${job.id}-paused`}>{t(job.pausedReason === "engine" ? "downloads.paused.engine" : "downloads.paused.user")}</p> : null}
      {problem && job.error ? (
        <p className="draft-warn-text" role="alert" data-testid={`download-${job.id}-error`}>
          {job.stage ? `${t(`downloads.stage.${job.stage}` as MessageKey)}：` : ""}{t(errorKey(job.error.code), { message: job.error.message })}
        </p>
      ) : null}
      {job.state === "done" ? <p className="detail-muted" data-testid={`download-${job.id}-result`}>{t("downloads.result", { imported: job.counts.imported, skipped: job.counts.skipped })}</p> : null}

      {job.state === "choosing" ? <p className="detail-muted">{t("downloads.choose.hint")}</p> : null}
      {files && entries.length ? (
        <FileList t={t} job={job} entries={entries} chosen={chosen} editable={canChoose(job)} onPick={props.onPick} />
      ) : job.counts.files > 0 ? <p className="detail-muted">{t("downloads.files", { count: job.counts.files, size: bytesLabel(job.totalBytes) })}</p> : null}

      {job.state === "choosing" || job.state === "downloading" ? (
        <div className="download-actions">
          {entries.length ? <>
            <button type="button" className="secondary-button" data-testid={`download-${job.id}-all`} onClick={() => props.onPick(new Set(entries.map((entry) => entry.index)))}>{t("downloads.choose.all")}</button>
            <button type="button" className="secondary-button" data-testid={`download-${job.id}-none`} onClick={() => props.onPick(new Set())}>{t("downloads.choose.none")}</button>
            <button type="button" className="primary-button" data-testid={`download-${job.id}-start`} disabled={props.busy || chosen.size === 0 || !props.engineRunning}
              onClick={() => void props.onRun("acquisition.select", { indexes: [...chosen].sort((a, b) => a - b) })}>
              {chosen.size ? t("downloads.choose.start", { count: chosen.size, size: bytesLabel(chosenBytes) }) : t("downloads.choose.startNone")}
            </button>
          </> : null}
        </div>
      ) : null}

      {job.state === "done" ? <SeedPanel t={t} job={job} busy={props.busy} onRun={props.onRun} /> : null}

      <div className="download-actions">
        {moving || job.state === "choosing" ? <button type="button" className="secondary-button" data-testid={`download-${job.id}-pause`} disabled={props.busy} onClick={() => void props.onRun("acquisition.pause", {})}><Pause size={15} aria-hidden="true" /> {t("downloads.action.pause")}</button> : null}
        {job.state === "paused" || (job.state === "failed" && job.stage === "transfer" && job.error?.code !== "RESUME_INCOMPATIBLE") ? <button type="button" className="secondary-button" data-testid={`download-${job.id}-resume`} disabled={props.busy || !props.engineRunning} onClick={() => void props.onRun("acquisition.resume", {})}><Play size={15} aria-hidden="true" /> {t("downloads.action.resume")}</button> : null}
        {job.state === "failed" && job.stage === "publish" ? <button type="button" className="secondary-button" data-testid={`download-${job.id}-retry-publish`} disabled={props.busy} onClick={() => void props.onRun("acquisition.retryPublish", {})}>{t("downloads.action.retryPublish")}</button> : null}
        {job.state === "failed" && job.stage === "import" ? <button type="button" className="secondary-button" data-testid={`download-${job.id}-retry-import`} disabled={props.busy} onClick={() => void props.onRun("acquisition.retryImport", {})}>{t("downloads.action.retryImport")}</button> : null}
        {job.state === "failed" && job.stage === "transfer" ? <button type="button" className="secondary-button" data-testid={`download-${job.id}-restart`} disabled={props.busy || !props.engineRunning} onClick={() => void props.onRun("acquisition.restart", {})}>{t("downloads.action.restart")}</button> : null}
        {job.state !== "done" && job.state !== "cancelled" && job.state !== "publishing" && job.state !== "importing" ? <button type="button" className="secondary-button" data-testid={`download-${job.id}-cancel`} disabled={props.busy} onClick={props.onCancel}><Square size={14} aria-hidden="true" /> {t("downloads.action.cancel")}</button> : null}
        {job.state === "done" || job.state === "failed" || job.state === "cancelled" ? (
          <button type="button" className="secondary-button" data-testid={`download-${job.id}-remove`} title={t("downloads.remove.hint")} disabled={props.busy}
            onClick={() => void props.onRun("acquisition.remove", {}).then((result) => { if (result.ok) props.onRemoved(); })}><Trash2 size={14} aria-hidden="true" /> {t("downloads.action.remove")}</button>
        ) : null}
        {entries.length && !canChoose(job) ? (
          <button type="button" className="icon-button" data-testid={`download-${job.id}-files-toggle`} aria-expanded={props.expanded} aria-label={t(props.expanded ? "downloads.filesHide" : "downloads.filesToggle")} title={t(props.expanded ? "downloads.filesHide" : "downloads.filesToggle")} onClick={props.onToggle}>{props.expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
        ) : null}
      </div>
    </article>
  );
}

function FileList(props: { t: T; job: DownloadJob; entries: DownloadEntry[]; chosen: Set<number>; editable: boolean; onPick: (next: Set<number>) => void }) {
  const { t, job } = props;
  const flip = (index: number) => { const next = new Set(props.chosen); if (next.has(index)) next.delete(index); else next.add(index); props.onPick(next); };
  return (
    <ul className="download-files" data-testid={`download-${job.id}-files`}>
      {props.entries.map((entry) => {
        const status = entry.selected ? (entry.importState === "pending" ? (entry.publishState === "published" ? "published" : "unpublished") : entry.importState) : "notSelected";
        return (
          <li key={entry.index} data-testid={`download-${job.id}-file-row-${entry.index}`} data-import={entry.importState}>
            {props.editable ? (
              <label><input type="checkbox" data-testid={`download-${job.id}-file-${entry.index}`} checked={props.chosen.has(entry.index)} onChange={() => flip(entry.index)} /> <span className="download-file-name">{entry.path}</span></label>
            ) : <span className="download-file-name">{entry.path}</span>}
            <span className="detail-muted">{bytesLabel(entry.length)}</span>
            {!props.editable ? <span className="chip" data-testid={`download-${job.id}-file-${entry.index}-status`}>{t(`downloads.entry.${status}` as MessageKey)}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Sharing a finished download is off until the person turns it on, and bounded when they do. */
function SeedPanel(props: { t: T; job: DownloadJob; busy: boolean; onRun: (commandId: string, input: Record<string, unknown>) => Promise<{ ok: boolean }> }) {
  const { t, job } = props;
  const [ratio, setRatio] = useState(String(job.seeding.ratio || 1));
  const [up, setUp] = useState(String(job.seeding.upKbps || 0));
  const number = (value: string) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; };
  return (
    <div className="download-share" data-testid={`download-${job.id}-share`}>
      <h5><Share2 size={14} aria-hidden="true" /> {t("downloads.share.title")}</h5>
      {job.seeding.enabled ? (
        <>
          <p className="detail-muted" data-testid={`download-${job.id}-share-state`}>{job.seeding.active ? t("downloads.share.active", { uploaded: bytesLabel(job.uploadedBytes) }) : t("downloads.share.enabledIdle")}</p>
          <button type="button" className="secondary-button" data-testid={`download-${job.id}-share-stop`} disabled={props.busy} onClick={() => void props.onRun("acquisition.setSeeding", { enabled: false })}>{t("downloads.share.stop")}</button>
        </>
      ) : job.seeding.possible ? (
        <>
          <p className="detail-muted">{t("downloads.share.off")}</p>
          <label className="msettings-field"><span>{t("downloads.share.ratio")}</span><input data-testid={`download-${job.id}-share-ratio`} inputMode="decimal" value={ratio} onChange={(event) => setRatio(event.target.value)} /></label>
          <label className="msettings-field"><span>{t("downloads.share.upKbps")}</span><input data-testid={`download-${job.id}-share-up`} inputMode="numeric" value={up} onChange={(event) => setUp(event.target.value)} /></label>
          <button type="button" className="secondary-button" data-testid={`download-${job.id}-share-start`} disabled={props.busy} onClick={() => void props.onRun("acquisition.setSeeding", { enabled: true, ratio: number(ratio), upKbps: Math.round(number(up)) })}>{t("downloads.share.start")}</button>
        </>
      ) : <p className="detail-muted" data-testid={`download-${job.id}-share-impossible`}>{t("downloads.share.impossible")}</p>}
    </div>
  );
}
