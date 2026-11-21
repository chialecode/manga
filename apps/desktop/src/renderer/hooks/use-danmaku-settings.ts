import { useCallback, useEffect, useSyncExternalStore } from "react";
import { DEFAULT_DANMAKU_SETTINGS, type DanmakuSettings, type DanmakuSettingsPatch } from "@manga/contracts/danmaku";
import { attempt } from "../lib/api.ts";
import { createPatchQueue } from "../lib/patch-queue.ts";

export type CredentialSource = "custom" | "built-in" | "none";
export type DanmakuSourceCount = { source: string; count: number };
type Snapshot = { settings: DanmakuSettings; credentials: CredentialSource; loaded: boolean; sources: readonly DanmakuSourceCount[] };

/**
 * The danmaku settings are kept in one place for the whole window: the player reads them while it plays, the settings page changes them, and a change
 * made in one is seen in the other at once, whichever is showing (the reader stays mounted behind the settings).
 */
let snapshot: Snapshot = { settings: DEFAULT_DANMAKU_SETTINGS, credentials: "none", loaded: false, sources: [] };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let lastSaveError: string | undefined;

const publish = (next: Snapshot) => { snapshot = next; for (const listener of [...listeners]) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

type Reply = { settings: DanmakuSettings; credentials: CredentialSource };

const settingsQueue = createPatchQueue<DanmakuSettings, DanmakuSettingsPatch>({
  initial: DEFAULT_DANMAKU_SETTINGS,
  apply: (state, patch) => ({ ...state, ...patch }) as DanmakuSettings,
  send: async (patch) => {
    const result = await attempt<Reply>("danmaku.setSettings", patch);
    if (!result.ok) return { ok: false, error: result.error.message };
    snapshot = { ...snapshot, credentials: result.value.credentials, loaded: true };
    return { ok: true, state: result.value.settings };
  },
  onState: (settings) => publish({ ...snapshot, settings }),
  onError: (message) => { lastSaveError = message; },
});

/** Read the settings from the main process (once, and again when asked). */
export function loadDanmakuSettings(force = false): Promise<void> {
  if (snapshot.loaded && !force) return Promise.resolve();
  if (loading) return loading;
  loading = attempt<Reply>("danmaku.getSettings").then((result) => {
    if (result.ok) {
      snapshot = { ...snapshot, credentials: result.value.credentials, loaded: true };
      settingsQueue.hydrate(result.value.settings);
    }
  }).finally(() => { loading = null; });
  return loading;
}

/** Change some settings. Serialized optimistically; a rejected patch rolls back only itself and returns the refusal reason. */
export async function saveDanmakuSettings(patch: DanmakuSettingsPatch): Promise<string | null> {
  lastSaveError = undefined;
  const ok = await settingsQueue.enqueue(patch);
  return ok ? null : (lastSaveError ?? "failed to save danmaku settings");
}

/** The credentials in use changed (the person saved or cleared their own). */
export function setDanmakuCredentialSource(credentials: CredentialSource): void {
  publish({ ...snapshot, credentials });
}

/** The sources of the comments the player has loaded, for the page that switches them on and off. */
export function setDanmakuSources(sources: readonly DanmakuSourceCount[]): void {
  const same = sources.length === snapshot.sources.length && sources.every((entry, index) => entry.source === snapshot.sources[index]!.source && entry.count === snapshot.sources[index]!.count);
  if (!same) publish({ ...snapshot, sources });
}

/** For tests: forget what was loaded. */
export function resetDanmakuSettings(): void {
  snapshot = { settings: DEFAULT_DANMAKU_SETTINGS, credentials: "none", loaded: false, sources: [] };
  settingsQueue.reset(DEFAULT_DANMAKU_SETTINGS);
  loading = null;
}

/** The settings, loaded when the module is on. */
export function useDanmakuSettings(moduleOn: boolean) {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => { if (moduleOn) void loadDanmakuSettings(); }, [moduleOn]);
  const save = useCallback((patch: DanmakuSettingsPatch) => saveDanmakuSettings(patch), []);
  return { ...current, save };
}
