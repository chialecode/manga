import { useCallback, useEffect, useState } from "react";
import type {
  UpdateBusyReason,
  UpdateRestartResult,
  UpdateSettings,
  UpdateSettingsPatch,
  UpdateStatus,
} from "@manga/contracts";
import { attempt } from "../lib/api.ts";
import { tabMarks } from "../workspace/marks.ts";

export type UpdateHandle = {
  status: UpdateStatus | null;
  checking: boolean;
  notesOpen: boolean;
  setNotesOpen: (open: boolean) => void;
  snoozed: boolean;
  snooze: () => void;
  busyDialog: UpdateBusyReason[] | null;
  cancelBusyRestart: () => void;
  reload: () => Promise<UpdateStatus | null>;
  check: (options?: { download?: boolean }) => Promise<UpdateStatus | null>;
  setSettings: (patch: UpdateSettingsPatch) => Promise<void>;
  unskip: () => Promise<void>;
  requestRestart: (extraBusyReasons?: UpdateBusyReason[]) => Promise<void>;
  confirmBusyRestart: () => Promise<void>;
  dismissJustUpdated: () => Promise<void>;
};

function detectRendererBusy(options: { recordingActive: boolean }): UpdateBusyReason[] {
  const reasons: UpdateBusyReason[] = [];
  if (options.recordingActive || tabMarks.hasMark("recording")) {
    reasons.push("recording");
  }
  const hasPlayingVideo = tabMarks.hasMark("playing") || Array.from(document.querySelectorAll("video")).some((video) => !video.paused && !video.ended);
  if (hasPlayingVideo) {
    reasons.push("playing");
  }
  if (tabMarks.hasMark("running")) {
    reasons.push("agent");
  }
  return reasons;
}

export function useUpdate(options: {
  enabled: boolean;
  recordingActive: boolean;
  setError: (message?: string) => void;
}): UpdateHandle {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [snoozedVersion, setSnoozedVersion] = useState<string | null>(null);
  const [busyDialog, setBusyDialog] = useState<UpdateBusyReason[] | null>(null);

  const reload = useCallback(async (): Promise<UpdateStatus | null> => {
    if (!options.enabled) return null;
    const res = await attempt<UpdateStatus>("update.status", {});
    if (res.ok && res.value && typeof res.value.version === "string") {
      setStatus(res.value);
      return res.value;
    }
    return null;
  }, [options.enabled]);

  useEffect(() => {
    if (!options.enabled) return;
    void reload();
  }, [options.enabled, reload]);

  useEffect(() => {
    if (!options.enabled) return;
    const off = window.manga.onNotice?.((item) => {
      if (item.topic === "update.changed") {
        const next = item.payload as unknown as UpdateStatus;
        if (next && typeof next.version === "string") {
          setStatus(next);
        } else {
          void reload();
        }
      }
    });
    return () => { off?.(); };
  }, [options.enabled, reload]);

  const check = useCallback(async (input: { download?: boolean } = {}): Promise<UpdateStatus | null> => {
    setChecking(true);
    try {
      const res = await attempt<UpdateStatus>("update.check", input);
      if (!res.ok) {
        options.setError(res.error.message);
        return null;
      }
      if (res.value && typeof res.value.version === "string") {
        setStatus(res.value);
        return res.value;
      }
      return await reload();
    } finally {
      setChecking(false);
    }
  }, [options, reload]);

  const setSettings = useCallback(async (patch: UpdateSettingsPatch): Promise<void> => {
    const res = await attempt<UpdateSettings>("update.settings.set", patch);
    if (!res.ok) {
      options.setError(res.error.message);
      return;
    }
    setStatus((current) => (current ? { ...current, settings: res.value } : current));
    await reload();
  }, [options, reload]);

  /** "取消跳过" (4.2): the version skipped after going back from it is offered again at the next check. */
  const unskip = useCallback(async (): Promise<void> => {
    const res = await attempt<UpdateStatus>("update.unskip", {});
    if (!res.ok) {
      options.setError(res.error.message);
      return;
    }
    if (res.value && typeof res.value.version === "string") setStatus(res.value);
    else await reload();
  }, [options, reload]);

  const requestRestart = useCallback(async (extraBusyReasons: UpdateBusyReason[] = []): Promise<void> => {
    const combined = [...new Set([...detectRendererBusy({ recordingActive: options.recordingActive }), ...extraBusyReasons])];
    const res = await attempt<UpdateRestartResult>("update.restartToUpdate", {
      force: false,
      busyReasons: combined,
    });
    if (!res.ok) {
      options.setError(res.error.message);
      await reload();
      return;
    }
    if (res.value.status === "busy" && Array.isArray(res.value.busyReasons) && res.value.busyReasons.length > 0) {
      setBusyDialog(res.value.busyReasons);
      return;
    }
    setBusyDialog(null);
  }, [options, reload]);

  const confirmBusyRestart = useCallback(async (): Promise<void> => {
    const currentBusy = busyDialog ?? [];
    setBusyDialog(null);
    const res = await attempt<UpdateRestartResult>("update.restartToUpdate", {
      force: true,
      busyReasons: currentBusy,
    });
    if (!res.ok) {
      options.setError(res.error.message);
      await reload();
    }
  }, [busyDialog, options, reload]);

  const cancelBusyRestart = useCallback(() => {
    setBusyDialog(null);
  }, []);

  const snooze = useCallback(() => {
    setSnoozedVersion(status?.availableVersion ?? "__snoozed__");
    setNotesOpen(false);
  }, [status?.availableVersion]);

  const dismissJustUpdated = useCallback(async () => {
    const res = await attempt<UpdateStatus>("update.status", { dismissJustUpdated: true });
    if (res.ok && res.value && typeof res.value.version === "string") {
      setStatus(res.value);
    } else {
      setStatus((current) => (current ? { ...current, justUpdated: null } : current));
    }
    setNotesOpen(false);
  }, []);

  const snoozed = Boolean(
    snoozedVersion !== null
    && (snoozedVersion === "__snoozed__" || snoozedVersion === status?.availableVersion),
  );

  return {
    status,
    checking,
    notesOpen,
    setNotesOpen,
    snoozed,
    snooze,
    busyDialog,
    cancelBusyRestart,
    reload,
    check,
    setSettings,
    unskip,
    requestRestart,
    confirmBusyRestart,
    dismissJustUpdated,
  };
}
