import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryPath, ScanJob, ScanSchedule } from "../../../../../packages/app-core/src/library-scan/service.ts";
import { asArray, attempt } from "../lib/api.ts";

export type { LibraryPath, ScanJob, ScanSchedule };
export const DEFAULT_SCHEDULE: ScanSchedule = { onStartup: true, intervalMinutes: 60 };

type Status = { running: ScanJob | null; queued: ScanJob[]; recent: ScanJob[]; schedule: ScanSchedule };

/**
 * Library paths and the background scan, as the title bar and the settings page both show them: the paths with their last result,
 * the schedule, the scan that is running and the ones waiting. Progress arrives as notices, so the window never polls and a scan
 * that runs for minutes costs it nothing. Starting and cancelling are commands; what they did comes back as the next notice.
 */
export function useScan(enabled = true) {
  const [paths, setPaths] = useState<LibraryPath[]>([]);
  const [pathsLoaded, setPathsLoaded] = useState(false);
  const [status, setStatus] = useState<Status>({ running: null, queued: [], recent: [], schedule: DEFAULT_SCHEDULE });
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const reload = useCallback(async () => {
    const [list, state] = await Promise.all([attempt<{ paths: LibraryPath[]; schedule: ScanSchedule }>("library.paths.list"), attempt<Status>("library.scan.status")]);
    if (!alive.current) return;
    if (list.ok) { setPaths(asArray<LibraryPath>(list.value.paths)); setPathsLoaded(true); }
    else if (list.error.code !== "CAPABILITY_UNAVAILABLE") setError(list.error.message);
    if (state.ok) setStatus({ running: state.value.running ?? null, queued: asArray<ScanJob>(state.value.queued), recent: asArray<ScanJob>(state.value.recent), schedule: state.value.schedule ?? DEFAULT_SCHEDULE });
  }, []);

  useEffect(() => { if (enabled) void reload(); }, [enabled, reload]);

  useEffect(() => {
    if (!enabled) return;
    const off = window.manga.onNotice?.((notice) => {
      if (notice.topic === "scan.progress") {
        const job = notice.payload.job as ScanJob | undefined;
        if (job) setStatus((current) => ({ ...current, running: job.status === "running" || job.status === "queued" ? job : current.running?.id === job.id ? null : current.running }));
      } else if (notice.topic === "scan.finished") void reload();
    });
    return () => off?.();
  }, [enabled, reload]);

  const start = useCallback(async (pathId?: string) => {
    const result = await attempt("library.scan.start", pathId ? { pathId } : {});
    if (!result.ok) { setError(result.error.message); return false; }
    setError(undefined);
    await reload();
    return true;
  }, [reload]);

  const cancel = useCallback(async (jobId?: string) => {
    const result = await attempt("library.scan.cancel", jobId ? { jobId } : {});
    if (!result.ok) setError(result.error.message);
    await reload();
  }, [reload]);

  const setSchedule = useCallback(async (schedule: ScanSchedule) => {
    const result = await attempt<{ schedule: ScanSchedule }>("library.scan.setSchedule", schedule);
    if (!result.ok) { setError(result.error.message); return; }
    setStatus((current) => ({ ...current, schedule: result.value.schedule ?? schedule }));
  }, []);

  return { paths, pathsLoaded, ...status, error, reload, start, cancel, setSchedule, clearError: () => setError(undefined) };
}

export type ScanState = ReturnType<typeof useScan>;
