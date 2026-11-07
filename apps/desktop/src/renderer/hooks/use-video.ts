import { useEffect, useRef, useState } from "react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";
import { relinkNotice, relinkResource } from "../lib/relink.ts";
import { autoAddMaterial } from "../lib/materials.ts";
import { mediaPrefs } from "../lib/media-prefs.ts";
import type { Elsewhere } from "../workspace/elsewhere.ts";
import type { SourceCard } from "../lib/types.ts";
import { nextResource, resourceLabel } from "../lib/works.ts";
import type { ProgressReport } from "../readers/use-video-playback.ts";

import type { AudioTrackInfo, EpisodeItem, VideoDoc, VideoFocus, VideoSettings } from "../readers/video-player.tsx";

export type VideoDeps = {
  i18n: Translator;
  setError: (message?: string) => void;
  setNotice: (message?: string, action?: { label: string; onClick: () => void }) => void;
  /** The context the video is watched in: its position and watched stretches are that context's (A-96). */
  contextId: string | null;
  tabId: string;
  openNote: (objectId: string, focusBlockId?: string) => void | Promise<void>;
  refresh: () => Promise<void>;
  /** The player knows more about what it shows than the tab was opened with. */
  onFacts?: (facts: { workId: string | null; heading: string }) => void;
};

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  rate: 1, rates: [0.5, 0.75, 1, 1.25, 1.5, 2, 3], customRate: 1.5, holdRate: 2, volume: 1, muted: false, seekStepSeconds: 5, autoNext: false,
  subtitlePlacement: "auto", subtitleSizePct: 5, subtitleFont: "sans", subtitleOutline: true, assStyle: "keep", shotSubtitles: true,
};

type OpenOptions = {
  revisionId?: string;
  workId?: string | null;
  focus?: { startMs: number; endMs?: number; play?: boolean };
  card?: SourceCard | null;
  returnTo?: { objectId: string; blockId: string | null } | null;
};

type ResourceRow = { id: string; title: string; kind: string; ordinalLabel: string | null; available: boolean };

/** The note-source facts a jump into a video needs. */
export type TemporalSource = {
  resourceId?: string;
  resourceRevisionId?: string;
  status?: string;
  locator?: { kind: "temporal"; startMs: number; endMs?: number };
  card?: SourceCard;
  returnTo?: { objectId: string; blockId: string | null };
};

/** Within this much of the end a saved position counts as finished, and the next viewing starts over. */
const FINISHED_WITHIN_MS = 5000;
const SAVE_DELAY_MS = 400;

/**
 * The video player's state in one tab: the open resource, the player settings, where to start, the episodes of its work and the
 * round trip to a note. Like the comic reader, every await re-checks the request counter so a late answer for a video the
 * user already left is dropped.
 */
export function useVideo(deps: VideoDeps) {
  const { i18n, setError, setNotice, contextId, openNote, refresh } = deps;
  const viewRequest = useRef(0);
  /** Where another context has been in this video when this one has not started, for the offer to jump there. */
  const [elsewhere, setElsewhere] = useState<Elsewhere | null>(null);
  const [doc, setDoc] = useState<VideoDoc | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [startMs, setStartMs] = useState(0);
  const [settings, setSettings] = useState<VideoSettings>(DEFAULT_VIDEO_SETTINGS);
  // The saved preferences are also shown in settings, before any video has been opened.
  useEffect(() => {
    let cancelled = false;
    void attempt<{ video?: Partial<VideoSettings> }>("settings.getMedia").then((saved) => {
      if (!cancelled && saved.ok && saved.value.video) setSettings({ ...DEFAULT_VIDEO_SETTINGS, ...saved.value.video });
    });
    return () => { cancelled = true; };
  }, []);
  // The settings page and the other video tabs change the same preferences; this player follows them.
  useEffect(() => mediaPrefs.subscribe((kind, patch) => { if (kind === "video") setSettings((current) => ({ ...current, ...patch })); }), []);
  const [next, setNext] = useState<{ resourceId: string; title: string } | null>(null);
  const [focus, setFocus] = useState<VideoFocus | null>(null);
  const [sourceCard, setSourceCard] = useState<SourceCard | null>(null);
  const [returnTo, setReturnTo] = useState<{ objectId: string; blockId: string | null } | null>(null);
  const workId = useRef<string | null>(null);
  const docRef = useRef<VideoDoc | null>(null);
  const nonce = useRef(0);
  const progressChain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef<Partial<VideoSettings>>({});
  const saveTimer = useRef<number | null>(null);
  /**
   * Where the viewer is, as the player last reported it. `startMs` is only where the video was opened at; a player that is
   * mounted again (the page was left and came back) must start from here, or it would start over and write that over the saved place.
   */
  const reached = useRef<{ resourceId: string; ms: number } | null>(null);

  function flushSettings() {
    if (saveTimer.current !== null) { window.clearTimeout(saveTimer.current); saveTimer.current = null; }
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    void attempt("settings.setMedia", { video: patch }).then((result) => { if (!result.ok) setError(result.error.message); });
  }
  useEffect(() => () => flushSettings(), []);

  async function open(resourceId: string, options: OpenOptions = {}) {
    const request = ++viewRequest.current;
    setStatus("loading");
    setError(undefined);
    const probed = await attempt<{ resourceId: string; revisionId: string; available: boolean; probe: { durationMs: number } }>("video.probe", { resourceId, revisionId: options.revisionId });
    if (request !== viewRequest.current) return;
    if (!probed.ok) {
      setStatus("error");
      setDoc(null);
      docRef.current = null;
      setError(probed.error.message);
      return;
    }
    const value = probed.value;
    const [tracks, saved, progress, touched] = await Promise.all([
      attempt<{ audio: AudioTrackInfo[] }>("video.audioTracks", { resourceId, revisionId: value.revisionId }),
      attempt<{ video?: Partial<VideoSettings> }>("settings.getMedia"),
      attempt<{ locator: { kind?: string; startMs?: number } | null; completion?: string; elsewhere?: Elsewhere | null }>("progress.get", { contextId, resourceId, resourceRevisionId: value.revisionId }),
      attempt<{ workId: string | null }>("works.open", { resourceId }),
    ]);
    if (request !== viewRequest.current) return;
    workId.current = options.workId ?? (touched.ok ? touched.value.workId : null) ?? null;
    const work = workId.current ? await attempt<{ title?: string; resources?: ResourceRow[] }>("works.get", { workId: workId.current }) : null;
    if (request !== viewRequest.current) return;
    const rows = work?.ok ? asArray<ResourceRow>(work.value.resources).filter((row) => row.kind === "video") : [];
    const mine = rows.find((row) => row.id === resourceId);
    const episodes: EpisodeItem[] = rows.map((row) => ({ resourceId: row.id, label: resourceLabel(row), available: row.available !== false }));
    const loaded: VideoDoc = {
      resourceId,
      revisionId: value.revisionId,
      workId: workId.current,
      title: (work?.ok ? work.value.title : undefined) ?? mine?.title ?? "",
      episodeLabel: rows.length > 1 && mine ? resourceLabel(mine) : null,
      durationMs: value.probe?.durationMs ?? 0,
      available: value.available !== false,
      audio: tracks.ok ? asArray<AudioTrackInfo>(tracks.value.audio) : [],
      episodes,
    };
    if (saved.ok && saved.value.video) setSettings({ ...DEFAULT_VIDEO_SETTINGS, ...saved.value.video });
    // A finished video starts again from its beginning; an unfinished one resumes where it was left.
    const locator = progress.ok ? progress.value.locator : null;
    const at = locator?.kind === "temporal" && typeof locator.startMs === "number" ? locator.startMs : 0;
    const finished = progress.ok && progress.value.completion === "completed" && loaded.durationMs > 0 && at >= loaded.durationMs - FINISHED_WITHIN_MS;
    setStartMs(options.focus ? options.focus.startMs : finished ? 0 : at);
    setElsewhere(progress.ok && !options.focus ? progress.value.elsewhere ?? null : null);
    reached.current = null;
    docRef.current = loaded;
    setDoc(loaded);
    setSourceCard(options.card ?? null);
    setReturnTo(options.returnTo ?? null);
    setFocus(options.focus ? { ...options.focus, nonce: ++nonce.current } : null);
    const following = nextResource(rows, resourceId);
    setNext(following ? { resourceId: following.id, title: resourceLabel(following) } : null);
    setStatus("ready");
    deps.onFacts?.({ workId: workId.current, heading: [loaded.title, loaded.episodeLabel].filter(Boolean).join(" ") });
    void autoAddMaterial(contextId, "resource", resourceId);
  }

  /** A note's source at a time: open that video there, with the interval it framed. */
  async function openFromNote(value: TemporalSource, objectId: string, blockId?: string) {
    if (!value.resourceId || value.locator?.kind !== "temporal") return;
    const locator = value.locator;
    await open(value.resourceId, {
      revisionId: value.resourceRevisionId,
      focus: { startMs: locator.startMs, ...(locator.endMs !== undefined ? { endMs: locator.endMs } : {}) },
      card: value.card ?? { status: value.status ?? "unresolved" },
      returnTo: value.returnTo ?? { objectId, blockId: blockId ?? null },
    });
  }

  /** Play a stretch again (a recorded interval, or a note's interval) and stop where it ends. */
  function playRange(range: { startMs: number; endMs: number }) {
    setFocus({ ...range, play: true, nonce: ++nonce.current });
  }

  function close() {
    flushSettings();
    viewRequest.current += 1;
    docRef.current = null;
    reached.current = null;
    setDoc(null);
    setStatus("idle");
    setSourceCard(null);
    setReturnTo(null);
    setFocus(null);
    setNext(null);
    setElsewhere(null);
  }

  /** The player went to the stretch a note pointed at; a player mounted again must not go there a second time. */
  function focusApplied(focusNonce: number) {
    setFocus((current) => (current && current.nonce === focusNonce && !current.applied ? { ...current, applied: true } : current));
  }

  async function backToNote() {
    if (returnTo?.objectId) await openNote(returnTo.objectId, returnTo.blockId ?? undefined);
    setSourceCard(null);
    setReturnTo(null);
    setFocus(null);
  }

  /** Re-point a stale source at the file the user picks; the resource identity, its notes and its recordings stay. */
  async function repair() {
    const current = docRef.current;
    if (!current) return;
    const outcome = await relinkResource(current.resourceId);
    if (outcome.kind === "cancelled") return;
    const shown = relinkNotice(i18n.t, outcome, () => void repair());
    if (shown.error) { setError(shown.error); return; }
    setNotice(shown.notice, shown.action);
    // A folder that is no library path yet: nothing was changed, and the notice offers adding it.
    if (outcome.kind !== "done") return;
    await open(current.resourceId, { revisionId: current.revisionId, card: sourceCard, returnTo, focus: focus ? { startMs: focus.startMs, endMs: focus.endMs } : undefined });
    await refresh();
  }

  /** The value changes at once; the saved copy follows a moment later, so dragging the volume is one write. */
  function changeSettings(patch: Partial<VideoSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
    mediaPrefs.publish("video", patch);
    pending.current = { ...pending.current, ...patch };
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushSettings, SAVE_DELAY_MS);
  }

  /** The position and the stretches watched since the last report. Writes go one after another so the last position wins. */
  function recordProgress(report: ProgressReport) {
    const { resourceId, revisionId } = report;
    reached.current = { resourceId, ms: report.ended ? 0 : Math.max(0, report.timeMs) };
    progressChain.current = progressChain.current.then(async () => {
      const result = await attempt("progress.setTime", { contextId, resourceId, resourceRevisionId: revisionId, timeMs: Math.max(0, report.timeMs), played: report.ranges });
      if (!result.ok) setError(result.error.message);
    });
  }

  /** Resolves once every position written so far is saved. */
  const settled = () => progressChain.current;

  const resumeMs = reached.current && doc && reached.current.resourceId === doc.resourceId ? reached.current.ms : startMs;

  return { doc, status, elsewhere, dismissElsewhere: () => setElsewhere(null), startMs: resumeMs, focusApplied, settings, next, focus, sourceCard, visible: doc !== null, open, openFromNote, playRange, close, backToNote, repair, changeSettings, recordProgress, settled };
}

export type VideoState = ReturnType<typeof useVideo>;
