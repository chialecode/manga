import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Download, Play, Redo2, SkipBack, SkipForward, Square, Trash2, Undo2 } from "lucide-react";
import type { RoughcutActionInput } from "@manga/contracts/roughcut-inputs";
import { asArray, attempt } from "../../../lib/api.ts";
import { Modal } from "../../../components/modal.tsx";
import { useVideoSource } from "../../../readers/use-video-source.ts";
import { formatClockMs, parseClock } from "../../../readers/video-model.ts";
import { DocWorkspace, type DocKind } from "../canvas/doc-workspace.tsx";
import type { ProjectTabContext } from "../project-page.tsx";
import {
  DEFAULT_CHOICE, choiceSummary, exportSummary, lengthText, moveTarget, nextKeyframe, optionsOf, prevKeyframe, problemText, readRange, secondsText, snapToKeyframe, stepText, tickPath, toggleAudio, toggleSubtitle, trackLabel,
  type ClipView, type CutDoc, type CutSummary, type ExportChoice, type ExportView, type PlanView,
} from "./roughcut-model.ts";

type Action = RoughcutActionInput;
type EditResult = { doc: CutDoc; created: string[] };
type Patch = { inMs?: number; outMs?: number; label?: string };

const CUT_KIND: DocKind<CutSummary> = {
  prefix: "roughcut", item: "cut", focusKind: "roughcut",
  commands: { list: "roughcut.list", create: "roughcut.create", rename: "roughcut.rename", delete: "roughcut.delete" },
  idField: "cutId", listField: "cuts", createdField: "cut",
  meta: (cut, ctx) => ctx.t("roughcut.counts", { count: cut.clips, length: lengthText(cut.totalMs) }),
  defaultTitle: (n, ctx) => ctx.t("roughcut.defaultTitle", { n }),
  words: { list: "roughcut.cuts", empty: "roughcut.empty", create: "roughcut.new", rename: "roughcut.rename", remove: "roughcut.delete", confirm: "roughcut.deleteConfirm" },
};

/** How long after the last change the check runs again: edits come in runs (a clip trimmed and trimmed again), and each check reads the files. */
const PLAN_DELAY_MS = 350;
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const SNAP_KEY = "manga.roughcut.snap";

/** Whether a start typed or marked lands on the keyframe before it. On unless the person turned it off; kept per person, not per sequence. */
function readSnap(): boolean {
  try { return window.localStorage.getItem(SNAP_KEY) !== "off"; } catch { return true; }
}
function writeSnap(on: boolean): void {
  try { window.localStorage.setItem(SNAP_KEY, on ? "on" : "off"); } catch { /* no storage here: the choice lasts as long as the page */ }
}
const keyOf = (clip: { resourceId: string; revisionId: string }) => `${clip.resourceId}:${clip.revisionId}`;

/** The rough cuts of one project: the sequences on the left, and the one on show with its clips, the check before an export, and the export. */
export function RoughcutTab({ ctx }: { ctx: ProjectTabContext }) {
  return <DocWorkspace ctx={ctx} kind={CUT_KIND} render={(cutId, refresh) => <CutView key={cutId} ctx={ctx} cutId={cutId} onChanged={refresh} />} />;
}

function CutView({ ctx, cutId, onChanged }: { ctx: ProjectTabContext; cutId: string; onChanged: () => void }) {
  const { t } = ctx;
  const [doc, setDoc] = useState<CutDoc | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [planning, setPlanning] = useState(false);
  const [exports, setExports] = useState<ExportView[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [choice, setChoice] = useState<ExportChoice>(DEFAULT_CHOICE);
  const [snap, setSnapState] = useState(readSnap);
  const [keyframes, setKeyframes] = useState<Map<string, number[]>>(() => new Map());
  const onError = useRef(ctx.onError);
  onError.current = ctx.onError;
  const onNotice = useRef(ctx.onNotice);
  onNotice.current = ctx.onNotice;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const planSeq = useRef(0);
  const planTimer = useRef<number | null>(null);
  const choiceRef = useRef(choice);
  choiceRef.current = choice;
  const asked = useRef(new Set<string>());

  /** The keyframes of the videos in the sequence, once their frame tables exist (the check builds them). A video that is not ready is asked about again after the next check. */
  const loadKeyframes = useCallback(async (value: PlanView) => {
    for (const clip of value.clips) {
      const key = keyOf(clip);
      if (asked.current.has(key) || clip.problems.some((problem) => problem.code === "source-missing")) continue;
      asked.current.add(key);
      const result = await attempt<{ ready: boolean; keyframesMs?: number[] }>("video.keyframes", { resourceId: clip.resourceId, revisionId: clip.revisionId });
      if (result.ok && result.value.ready && result.value.keyframesMs) {
        const list = result.value.keyframesMs;
        setKeyframes((current) => new Map(current).set(key, list));
      } else asked.current.delete(key);
    }
  }, []);

  const runPlan = useCallback(async () => {
    const mine = ++planSeq.current;
    setPlanning(true);
    const result = await attempt<{ plan: PlanView }>("roughcut.plan", { cutId, options: optionsOf(choiceRef.current) });
    if (planSeq.current !== mine) return;
    setPlanning(false);
    if (!result.ok) { onError.current(result.error.message); return; }
    setPlan(result.value.plan);
    void loadKeyframes(result.value.plan);
  }, [cutId, loadKeyframes]);
  /** The check follows the sequence: after a change it runs once things have settled. */
  const schedulePlan = useCallback((delay = PLAN_DELAY_MS) => {
    if (planTimer.current !== null) window.clearTimeout(planTimer.current);
    setPlanning(true);
    planTimer.current = window.setTimeout(() => { planTimer.current = null; void runPlan(); }, delay);
  }, [runPlan]);
  useEffect(() => () => { if (planTimer.current !== null) window.clearTimeout(planTimer.current); planSeq.current += 1; }, []);

  // What the export is asked to be changes what the check says (tracks that are not there, a subtitle a file cannot hold), so the check follows it.
  const firstChoice = useRef(true);
  useEffect(() => {
    if (firstChoice.current) { firstChoice.current = false; return; }
    schedulePlan(120);
  }, [choice, schedulePlan]);

  const loadExports = useCallback(async () => {
    const result = await attempt<{ exports: ExportView[] }>("roughcut.exports", { cutId });
    if (result.ok) setExports(asArray<ExportView>(result.value.exports));
  }, [cutId]);
  const load = useCallback(async () => {
    const result = await attempt<CutDoc>("roughcut.get", { cutId });
    if (!result.ok) { onError.current(result.error.message); return; }
    setDoc(result.value);
  }, [cutId]);
  useEffect(() => { void load(); void loadExports(); void runPlan(); }, [load, loadExports, runPlan]);

  // The export reports each step as a notice; the list follows it, and when it ends the sequence is free again.
  useEffect(() => {
    const off = window.manga.onNotice?.((notice) => {
      if (notice.topic !== "roughcut.export") return;
      const view = notice.payload as unknown as ExportView;
      if (view.cutId !== cutId) return;
      setExports((current) => (current.some((item) => item.id === view.id) ? current.map((item) => (item.id === view.id ? view : item)) : [view, ...current]));
      if (TERMINAL.has(view.state)) { void load(); }
    });
    return () => { off?.(); };
  }, [cutId, load]);

  const commit = useCallback((actions: Action[], label?: string): Promise<EditResult | null> => {
    const run = async (): Promise<EditResult | null> => {
      const result = await attempt<EditResult>("roughcut.edit", { cutId, actions, ...(label ? { label } : {}) });
      if (!result.ok) {
        const reason = (result.error.details as { reason?: string } | undefined)?.reason;
        onError.current(reason === "busy" ? t("roughcut.busy") : reason === "range" ? t("roughcut.rangeInvalid") : result.error.message);
        await load();
        return null;
      }
      setDoc(result.value.doc);
      onChanged();
      schedulePlan();
      return result.value;
    };
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => undefined);
    return next;
  }, [cutId, load, onChanged, schedulePlan, t]);

  const step = useCallback(async (direction: "undo" | "redo") => {
    const run = async () => {
      const result = await attempt<{ doc: CutDoc }>(`roughcut.${direction}`, { cutId });
      if (!result.ok) { if (result.error.code !== "NOT_FOUND") onError.current(result.error.message); await load(); return; }
      setDoc(result.value.doc);
      onChanged();
      schedulePlan();
    };
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => undefined);
    await next;
  }, [cutId, load, onChanged, schedulePlan]);

  const titles = useMemo(() => new Map((doc?.clips ?? []).map((clip, i) => [clip.id, clip.title || `#${i + 1}`])), [doc?.clips]);
  const titleOf = useCallback((clipId?: string) => (clipId ? titles.get(clipId) ?? "" : ""), [titles]);
  const setSnap = useCallback((on: boolean) => { setSnapState(on); writeSnap(on); }, []);

  if (!doc) return <div className="rc-view" data-testid="rc-view" aria-busy="true" />;
  const busy = doc.exporting;
  const clips = doc.clips;
  const previewClip = clips.find((clip) => clip.id === previewId) ?? null;
  const latest = exports[0] ?? null;
  const running = latest && !TERMINAL.has(latest.state) ? latest : null;
  /** What the check allows: one file needs clips that can be joined, separate files only need each clip to be exportable. */
  const shown = plan && plan.options.mode === choice.mode ? plan : null;
  const ready = shown ? (choice.mode === "merge" ? shown.compatible : shown.separable) : false;

  return (
    <div className="rc-view" data-testid="rc-view" data-busy={busy ? "true" : "false"}>
      <div className="rc-head">
        <h3 data-testid="rc-title">{doc.cut.title}</h3>
        <div className="rc-tools">
          <button type="button" className="icon-button" data-testid="rc-undo" disabled={!doc.ops.canUndo || busy} aria-label={doc.ops.undoLabel ? t("roughcut.undoLabel", { label: doc.ops.undoLabel }) : t("roughcut.undo")} title={doc.ops.undoLabel ? t("roughcut.undoLabel", { label: doc.ops.undoLabel }) : t("roughcut.undo")} onClick={() => void step("undo")}><Undo2 size={16} aria-hidden="true" /></button>
          <button type="button" className="icon-button" data-testid="rc-redo" disabled={!doc.ops.canRedo || busy} aria-label={doc.ops.redoLabel ? t("roughcut.redoLabel", { label: doc.ops.redoLabel }) : t("roughcut.redo")} title={doc.ops.redoLabel ? t("roughcut.redoLabel", { label: doc.ops.redoLabel }) : t("roughcut.redo")} onClick={() => void step("redo")}><Redo2 size={16} aria-hidden="true" /></button>
          <button type="button" className="primary-button" data-testid="rc-export" disabled={busy || !ready || planning} onClick={() => setExporting(true)}><Download size={15} aria-hidden="true" /> {t("roughcut.export")}</button>
        </div>
      </div>
      <p className="detail-muted" data-testid="rc-total">{t("roughcut.total", { count: clips.length, length: lengthText(doc.totalMs) })}</p>
      {busy ? <p className="rc-busy" role="status" data-testid="rc-busy">{t("roughcut.busy")}</p> : null}

      <ol className="rc-clips" aria-label={t("roughcut.clips")} data-testid="rc-clips">
        {clips.map((clip, index) => (
          <ClipRow key={clip.id} ctx={ctx} clip={clip} index={index} count={clips.length} busy={busy} selected={clip.id === previewId}
            keyframes={keyframes.get(keyOf(clip)) ?? null} snap={snap}
            onPreview={() => setPreviewId((current) => (current === clip.id ? null : clip.id))}
            onUpdate={(patch, label) => void commit([{ type: "update", clipId: clip.id, ...patch }], label)}
            onMove={(direction) => { const to = moveTarget(index, direction, clips.length); if (to !== null) void commit([{ type: "move", clipId: clip.id, index: to }], t("roughcut.op.move")); }}
            onRemove={() => void commit([{ type: "remove", clipId: clip.id }], t("roughcut.op.remove"))} />
        ))}
      </ol>
      {clips.length === 0 ? <p className="detail-muted rc-empty" data-testid="rc-no-clips">{t("roughcut.noClips")}</p> : null}

      {previewClip ? (
        <ClipPreview key={previewClip.id} ctx={ctx} clip={previewClip} busy={busy} keyframes={keyframes.get(keyOf(previewClip)) ?? null} snap={snap} onSnap={setSnap}
          onUpdate={(patch) => void commit([{ type: "update", clipId: previewClip.id, ...patch }], t("roughcut.op.update"))} />
      ) : null}

      {plan ? <OptionsPanel ctx={ctx} cutId={cutId} plan={plan} choice={choice} busy={busy} clipCount={clips.length} onChoice={setChoice} /> : null}

      <section className="rc-plan" data-testid="rc-plan" data-compatible={ready ? "true" : "false"} data-planning={planning ? "true" : "false"} aria-busy={planning}>
        <header>
          <h4>{t("roughcut.plan.title")}</h4>
          <button type="button" className="link-button" data-testid="rc-plan-again" disabled={planning} onClick={() => schedulePlan(0)}>{t("roughcut.plan.recheck")}</button>
        </header>
        {planning && !shown ? <p className="detail-muted">{t("roughcut.plan.checking")}</p> : null}
        {shown ? <PlanDetails t={t} plan={shown} mode={choice.mode} titleOf={titleOf} stale={planning} /> : null}
      </section>

      <section className="rc-exports" data-testid="rc-exports" aria-label={t("roughcut.export.history")}>
        {running ? (
          <div className="rc-running" role="status" data-testid="rc-export-running" data-step={running.step ?? ""}>
            <progress max={Math.max(1, running.total)} value={running.done} aria-label={stepText(t, running)} />
            <span data-testid="rc-export-step">{stepText(t, running)}</span>
            <button type="button" className="secondary-button" data-testid="rc-export-cancel" onClick={() => void attempt("roughcut.cancel", { exportId: running.id }).then((result) => { if (!result.ok) onError.current(result.error.message); })}><Square size={13} aria-hidden="true" /> {t("roughcut.export.cancel")}</button>
          </div>
        ) : null}
        <h4>{t("roughcut.export.history")}</h4>
        {exports.length === 0 ? <p className="detail-muted" data-testid="rc-export-none">{t("roughcut.export.noHistory")}</p> : (
          <ul>
            {exports.slice(0, 6).map((item) => (
              <li key={item.id} data-testid={`rc-export-${item.id}`} data-state={item.state}>
                {exportSummary(t, item).map((line, i) => <p key={i} className={i === 0 && item.state !== "done" ? "rc-export-first" : undefined}>{line}</p>)}
                <ExportDetails t={t} view={item} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {exporting ? (
        <ExportDialog ctx={ctx} title={doc.cut.title} cutId={cutId} plan={plan} choice={choice} onClose={() => setExporting(false)}
          onStarted={(view) => { setExporting(false); setExports((current) => [view, ...current.filter((item) => item.id !== view.id)]); void load(); }} />
      ) : null}
    </div>
  );
}

/** One clip of the sequence: where it comes from, its two times (typed like the player's clock), its note, and what can be done with it. */
function ClipRow(props: {
  ctx: ProjectTabContext; clip: ClipView; index: number; count: number; busy: boolean; selected: boolean; keyframes: number[] | null; snap: boolean;
  onPreview: () => void; onUpdate: (patch: Patch, label: string) => void; onMove: (direction: "up" | "down") => void; onRemove: () => void;
}) {
  const { t } = props.ctx;
  const { clip } = props;
  const [problem, setProblem] = useState<"time" | "range" | null>(null);
  const [snapped, setSnapped] = useState<number | null>(null);
  const inField = useRef<HTMLInputElement>(null);
  const outField = useRef<HTMLInputElement>(null);

  function commitTimes() {
    const inText = inField.current?.value ?? "";
    const outText = outField.current?.value ?? "";
    const range = readRange(inText, outText, parseClock, clip.durationMs);
    if (typeof range === "string") { setProblem(range); return; }
    setProblem(null);
    // A start the person changed lands on the keyframe before it when that is asked for: it is where the copy begins anyway.
    let inMs = range.inMs;
    if (props.snap && props.keyframes && inMs !== clip.inMs) inMs = snapToKeyframe(props.keyframes, inMs);
    setSnapped(inMs !== range.inMs ? inMs : null);
    if (inMs !== clip.inMs || range.outMs !== clip.outMs) props.onUpdate({ inMs, outMs: range.outMs }, t("roughcut.op.update"));
  }
  const keys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); commitTimes(); }
    else if (event.key === "Escape") { event.preventDefault(); if (inField.current) inField.current.value = formatClockMs(clip.inMs); if (outField.current) outField.current.value = formatClockMs(clip.outMs); setProblem(null); setSnapped(null); }
  };
  return (
    <li className={`rc-clip${props.selected ? " is-selected" : ""}${clip.available ? "" : " is-missing"}`} data-testid={`rc-clip-${clip.id}`} data-missing={clip.available ? "false" : "true"}>
      <span className="rc-n" aria-hidden="true">{props.index + 1}</span>
      <div className="rc-clip-main">
        <strong className="rc-clip-title" title={clip.title}>{clip.title}</strong>
        {clip.available ? null : <small className="rc-clip-warn" data-testid={`rc-missing-${clip.id}`}>{t(clip.title ? "roughcut.clip.missing" : "roughcut.clip.gone")}</small>}
        <div className="rc-times">
          <label>{t("roughcut.clip.in")}
            <input ref={inField} key={`in:${clip.inMs}`} type="text" inputMode="decimal" spellCheck={false} data-testid={`rc-in-${clip.id}`} defaultValue={formatClockMs(clip.inMs)} disabled={props.busy} aria-invalid={problem ? true : undefined} onBlur={commitTimes} onKeyDown={keys} />
          </label>
          <label>{t("roughcut.clip.out")}
            <input ref={outField} key={`out:${clip.outMs}`} type="text" inputMode="decimal" spellCheck={false} data-testid={`rc-out-${clip.id}`} defaultValue={formatClockMs(clip.outMs)} disabled={props.busy} aria-invalid={problem ? true : undefined} onBlur={commitTimes} onKeyDown={keys} />
          </label>
          <span className="detail-muted" data-testid={`rc-length-${clip.id}`}>{t("roughcut.clip.length", { length: lengthText(clip.outMs - clip.inMs) })}</span>
        </div>
        {problem ? <small className="rc-clip-warn" role="alert" data-testid={`rc-time-error-${clip.id}`}>{t(problem === "time" ? "roughcut.timeInvalid" : "roughcut.rangeInvalid")}</small> : null}
        {snapped !== null && !problem ? <small className="detail-muted" role="status" data-testid={`rc-snapped-${clip.id}`}>{t("roughcut.timeline.snapped", { time: formatClockMs(snapped) })}</small> : null}
        <input className="rc-note" type="text" maxLength={200} data-testid={`rc-label-${clip.id}`} defaultValue={clip.label} key={`label:${clip.label}`} disabled={props.busy} aria-label={t("roughcut.clip.label")} placeholder={t("roughcut.clip.labelPlaceholder")}
          onBlur={(event) => { if (event.target.value !== clip.label) props.onUpdate({ label: event.target.value }, t("roughcut.op.update")); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      </div>
      <div className="rc-clip-actions">
        <button type="button" className="icon-button" data-testid={`rc-preview-${clip.id}`} aria-pressed={props.selected} aria-label={t("roughcut.clip.preview")} title={t("roughcut.clip.preview")} disabled={!clip.available} onClick={props.onPreview}><Play size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-button" data-testid={`rc-up-${clip.id}`} aria-label={t("roughcut.clip.up")} title={t("roughcut.clip.up")} disabled={props.busy || props.index === 0} onClick={() => props.onMove("up")}><ArrowUp size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-button" data-testid={`rc-down-${clip.id}`} aria-label={t("roughcut.clip.down")} title={t("roughcut.clip.down")} disabled={props.busy || props.index === props.count - 1} onClick={() => props.onMove("down")}><ArrowDown size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-button" data-testid={`rc-remove-${clip.id}`} aria-label={t("roughcut.clip.remove")} title={t("roughcut.clip.remove")} disabled={props.busy} onClick={props.onRemove}><Trash2 size={15} aria-hidden="true" /></button>
      </div>
    </li>
  );
}

/**
 * The requested stretch of one video played from the original (or the play copy the player made), stopping at its end, with the keyframes of the video
 * on a timeline: jump from keyframe to keyframe, and mark the start or end where the picture is.
 */
function ClipPreview({ ctx, clip, busy, keyframes, snap, onSnap, onUpdate }: { ctx: ProjectTabContext; clip: ClipView; busy: boolean; keyframes: number[] | null; snap: boolean; onSnap: (on: boolean) => void; onUpdate: (patch: Patch) => void }) {
  const { t } = ctx;
  const target = useMemo(() => ({ resourceId: clip.resourceId, revisionId: clip.revisionId }), [clip.resourceId, clip.revisionId]);
  const source = useVideoSource(target, undefined);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(clip.inMs);
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const state = source.state;
  const origin = state.phase === "ready" ? state.startMs : 0;
  const duration = clip.durationMs ?? Math.max(clip.outMs, 1);
  const seek = useCallback((ms: number) => {
    if (video.current) video.current.currentTime = (ms + origin) / 1000;
    setCurrentMs(ms);
  }, [origin]);
  const here = (element: HTMLVideoElement) => setCurrentMs(Math.max(0, Math.round(element.currentTime * 1000 - origin)));

  function play() {
    const element = video.current;
    if (!element) return;
    seek(clip.inMs);
    setPlaying(true);
    void element.play().catch(() => setPlaying(false));
  }
  function stop() { video.current?.pause(); setPlaying(false); }

  const previous = keyframes ? prevKeyframe(keyframes, currentMs) : null;
  const following = keyframes ? nextKeyframe(keyframes, currentMs) : null;
  const barClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width > 0) seek(Math.round(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * duration));
  };

  return (
    <section className="rc-preview" data-testid="rc-preview" aria-label={t("roughcut.preview.title")}>
      <h4>{t("roughcut.preview.title")}: {clip.title}</h4>
      {state.phase === "ready" ? (
        <>
          <video ref={video} src={state.url} controls preload="metadata" data-testid="rc-video"
            onLoadedMetadata={(event) => { if (video.current) video.current.currentTime = (clipRef.current.inMs + origin) / 1000; here(event.currentTarget); }}
            onTimeUpdate={(event) => { here(event.currentTarget); if (playing && (event.currentTarget.currentTime - origin / 1000) * 1000 >= clipRef.current.outMs) stop(); }}
            onSeeked={(event) => here(event.currentTarget)}
            onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} />
          <div className="rc-timeline" data-testid="rc-timeline" aria-label={t("roughcut.timeline.title")}>
            <div className="rc-bar" data-testid="rc-bar" role="presentation" title={t("roughcut.timeline.seek")} onClick={barClick}>
              <svg viewBox="0 0 1000 24" preserveAspectRatio="none" aria-hidden="true">
                <rect className="rc-range" x={(clip.inMs / duration) * 1000} y="0" width={Math.max(1, ((clip.outMs - clip.inMs) / duration) * 1000)} height="24" />
                {keyframes ? <path className="rc-ticks" d={tickPath(keyframes, duration)} data-testid="rc-ticks" /> : null}
                <rect className="rc-head" x={Math.min(998, (currentMs / duration) * 1000)} y="0" width="2" height="24" />
              </svg>
            </div>
            <div className="rc-timeline-tools">
              <button type="button" className="icon-button" data-testid="rc-key-prev" aria-label={t("roughcut.timeline.prev")} title={t("roughcut.timeline.prev")} disabled={previous === null} onClick={() => previous !== null && seek(previous)}><SkipBack size={15} aria-hidden="true" /></button>
              <button type="button" className="icon-button" data-testid="rc-key-next" aria-label={t("roughcut.timeline.next")} title={t("roughcut.timeline.next")} disabled={following === null} onClick={() => following !== null && seek(following)}><SkipForward size={15} aria-hidden="true" /></button>
              <button type="button" className="secondary-button" data-testid="rc-set-in" disabled={busy} onClick={() => onUpdate({ inMs: snap && keyframes ? snapToKeyframe(keyframes, currentMs) : currentMs })}>{t("roughcut.timeline.setIn")}</button>
              <button type="button" className="secondary-button" data-testid="rc-set-out" disabled={busy} onClick={() => onUpdate({ outMs: currentMs })}>{t("roughcut.timeline.setOut")}</button>
              <label className="rc-snap" title={t("roughcut.timeline.snapHint")}>
                <input type="checkbox" data-testid="rc-snap" checked={snap} onChange={(event) => onSnap(event.target.checked)} /> {t("roughcut.timeline.snap")}
              </label>
              <small className="detail-muted" data-testid="rc-current">{t("roughcut.timeline.current", { time: formatClockMs(currentMs) })}</small>
              <small className="detail-muted" data-testid="rc-key-count">{keyframes ? t("roughcut.timeline.count", { count: keyframes.length }) : t("roughcut.timeline.loading")}</small>
            </div>
          </div>
          <div className="rc-preview-actions">
            <button type="button" className="secondary-button" data-testid="rc-preview-play" onClick={playing ? stop : play}>{playing ? <><Square size={13} aria-hidden="true" /> {t("roughcut.preview.stop")}</> : <><Play size={13} aria-hidden="true" /> {t("roughcut.preview.play")}</>}</button>
            <small className="detail-muted">{t("roughcut.preview.hint")}</small>
          </div>
        </>
      ) : state.phase === "loading" || state.phase === "building" ? <p className="detail-muted" role="status">{t("status.loading")}</p>
        : state.phase === "needs_copy" ? <p className="detail-muted" data-testid="rc-preview-needs-copy">{t("roughcut.preview.needsCopy")}</p>
          : <p className="detail-muted" data-testid="rc-preview-unavailable">{t("roughcut.preview.unavailable")}</p>}
    </section>
  );
}

/** What an export is asked to be: one file or one for each clip, the audio and subtitle tracks to keep, chapters. The tracks are those of the first clip's source. */
function OptionsPanel({ ctx, cutId, plan, choice, busy, clipCount, onChoice }: { ctx: ProjectTabContext; cutId: string; plan: PlanView; choice: ExportChoice; busy: boolean; clipCount: number; onChoice: (choice: ExportChoice) => void }) {
  const { t } = ctx;
  const { audio, subtitle } = plan.tracks;
  const merged = choice.mode === "merge";
  return (
    <section className="rc-options" data-testid="rc-options" aria-label={t("roughcut.opt.title")}>
      <h4>{t("roughcut.opt.title")}</h4>
      <div className="rc-mode" role="radiogroup" aria-label={t("roughcut.opt.mode")}>
        <span>{t("roughcut.opt.mode")}</span>
        {(["merge", "separate"] as const).map((mode) => (
          <label key={mode}>
            <input type="radio" name={`rc-mode-${cutId}`} data-testid={`rc-mode-${mode}`} checked={choice.mode === mode} disabled={busy} onChange={() => onChoice({ ...choice, mode })} /> {t(`roughcut.opt.mode.${mode}` as "roughcut.opt.mode.merge")}
          </label>
        ))}
      </div>
      <fieldset className="rc-tracks" data-testid="rc-audio" disabled={busy}>
        <legend>{t("roughcut.opt.audio")}</legend>
        {audio.length ? audio.map((track, i) => (
          <label key={i}>
            <input type="checkbox" data-testid={`rc-audio-${i}`} checked={choice.audio === "all" || choice.audio.includes(i)} onChange={() => onChoice(toggleAudio(choice, i, audio.length))} /> {trackLabel(t, track, i)}
          </label>
        )) : <small className="detail-muted">{t("roughcut.opt.noAudio")}</small>}
      </fieldset>
      <fieldset className="rc-tracks" data-testid="rc-subtitle" disabled={busy}>
        <legend>{t("roughcut.opt.subtitle")}</legend>
        {subtitle.length ? subtitle.map((track, i) => (
          <label key={i}>
            <input type="checkbox" data-testid={`rc-subtitle-${i}`} checked={choice.subtitle.includes(i)} onChange={() => onChoice(toggleSubtitle(choice, i))} /> {trackLabel(t, track, i)}
          </label>
        )) : <small className="detail-muted">{t("roughcut.opt.noSubtitle")}</small>}
      </fieldset>
      <label className="rc-chapters">
        <input type="checkbox" data-testid="rc-chapters" checked={choice.chapters} disabled={busy || !merged || clipCount < 2} onChange={(event) => onChoice({ ...choice, chapters: event.target.checked })} /> {t("roughcut.opt.chapters")}
      </label>
      <small className="detail-muted">{t("roughcut.opt.hint")}</small>
      {merged && clipCount > 1 && choice.subtitle.length ? <small className="detail-muted" data-testid="rc-fonts-note">{t("roughcut.opt.fonts")}</small> : null}
    </section>
  );
}

/** What the check found: what will really be cut for each clip, and why the sequence cannot be exported when it cannot. */
function PlanDetails({ t, plan, mode, titleOf, stale }: { t: ProjectTabContext["t"]; plan: PlanView; mode: ExportChoice["mode"]; titleOf: (clipId?: string) => string; stale: boolean }) {
  const first = plan.problems.filter((problem) => problem.code === "empty");
  const rest = plan.problems.filter((problem) => problem.code !== "empty");
  const ok = mode === "merge" ? plan.compatible : plan.separable;
  return (
    <div className="rc-plan-body" data-stale={stale ? "true" : "false"}>
      <p className={ok ? "rc-ok" : "rc-bad"} data-testid="rc-plan-verdict" role="status">{t(ok ? (mode === "merge" ? "roughcut.plan.ok" : "roughcut.plan.okSeparate") : "roughcut.plan.bad")}</p>
      {mode === "merge" && !plan.compatible && plan.separable ? <p className="detail-muted" data-testid="rc-plan-separate-only">{t("roughcut.plan.separateOnly")}</p> : null}
      {plan.problems.length ? (
        <ul className="rc-problems" data-testid="rc-problems">
          {[...first, ...rest].map((problem, i) => <li key={`${problem.code}:${problem.clipId ?? ""}:${i}`} data-code={problem.code}>{problemText(t, problem, titleOf)}</li>)}
        </ul>
      ) : null}
      {plan.clips.length ? (
        <>
          <p className="detail-muted" data-testid="rc-plan-totals">
            {t("roughcut.plan.totals", { requested: lengthText(plan.requestedMs), actual: lengthText(plan.actualMs) })}
            {mode === "merge" && plan.extension && plan.container ? ` · ${t("roughcut.plan.container", { container: plan.container, extension: plan.extension })}` : ""}
          </p>
          <ol className="rc-plan-clips">
            {plan.clips.map((clip, i) => {
              const cut = clip.problems.length === 0;
              return (
                <li key={clip.clipId} data-testid={`rc-plan-clip-${clip.clipId}`} data-on-keyframe={clip.onKeyframe ? "true" : "false"}>
                  <span>{t("roughcut.plan.row", { n: i + 1, requested: `${formatClockMs(clip.requestedInMs)} – ${formatClockMs(clip.requestedOutMs)}`, actual: cut ? `${formatClockMs(clip.actualInMs)} – ${clip.toEnd ? t("roughcut.plan.toEnd") : formatClockMs(clip.actualOutMs)}` : "—" })}</span>
                  {cut ? (
                    <small className="detail-muted">
                      {clip.onKeyframe ? t("roughcut.plan.onKeyframe") : t("roughcut.plan.startShift", { seconds: secondsText(clip.startShiftMs) })}
                      {clip.endShiftMs > 0 && !clip.toEnd ? ` · ${t("roughcut.plan.endShift", { seconds: secondsText(clip.endShiftMs) })}` : ""}
                      {` · ${t("roughcut.plan.frames", { count: clip.frames })}`}
                      {mode === "separate" && clip.extension ? ` · ${t("roughcut.plan.file", { extension: clip.extension })}` : ""}
                    </small>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
      {!ok && plan.problems.some((problem) => problem.code !== "empty" && problem.code !== "source-missing") ? <p className="detail-muted">{t("roughcut.plan.why")}</p> : null}
    </div>
  );
}

/** The files an export wrote and the arguments it gave the media tool, step by step, with the places on this machine replaced by names. */
function ExportDetails({ t, view }: { t: ProjectTabContext["t"]; view: ExportView }) {
  const commands = view.commands ?? [];
  const files = view.files ?? [];
  if (!commands.length && !files.length) return null;
  return (
    <details className="rc-details" data-testid={`rc-export-details-${view.id}`}>
      <summary>{t("roughcut.export.details")}</summary>
      {files.length > 1 ? (
        <ul className="rc-detail-files" aria-label={t("roughcut.export.detailsFiles")}>
          {files.map((file) => <li key={file.fileName}>{file.fileName}</li>)}
        </ul>
      ) : null}
      {commands.length ? (
        <>
          <small className="detail-muted">{t("roughcut.export.detailsCommands")}</small>
          <pre className="rc-commands" data-testid={`rc-export-commands-${view.id}`}>{commands.map((command) => `${t(`roughcut.export.cmd.${command.step}` as "roughcut.export.cmd.cut")}${command.clip ? ` ${command.clip}` : ""}: ${command.tool} ${command.args.map(quoteArg).join(" ")}`).join("\n")}</pre>
        </>
      ) : null}
    </details>
  );
}

/** An argument as it would be typed: with quotes when it holds a space or a character a shell reads. */
const quoteArg = (arg: string): string => (/^[\w@%+=:,./<>-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`);

/** Where to put the export and what to call it. A folder of the person's own is chosen by the host's picker, so the page never sees its path. */
function ExportDialog(props: { ctx: ProjectTabContext; cutId: string; title: string; plan: PlanView | null; choice: ExportChoice; onClose: () => void; onStarted: (view: ExportView) => void }) {
  const { t } = props.ctx;
  const [name, setName] = useState("");
  const [destination, setDestination] = useState<"work" | "folder">("work");
  const [busy, setBusy] = useState(false);

  async function start() {
    let pathHandle: string | undefined;
    if (destination === "folder") {
      if (!window.manga.pick) { props.ctx.onError(t("roughcut.export.pickUnavailable")); return; }
      const picked = await window.manga.pick({ mode: "directory" });
      if (!picked) return;
      pathHandle = picked.pathHandle;
    }
    setBusy(true);
    const result = await attempt<{ export: ExportView }>("roughcut.export", { cutId: props.cutId, ...(pathHandle ? { pathHandle } : {}), ...(name.trim() ? { fileName: name.trim() } : {}), options: optionsOf(props.choice) });
    setBusy(false);
    if (!result.ok) {
      const reason = (result.error.details as { reason?: string } | undefined)?.reason;
      props.ctx.onError(reason === "no-work" ? t("roughcut.export.noWork") : result.error.message);
      if (reason === "no-work") setDestination("folder");
      return;
    }
    props.ctx.onNotice(t("roughcut.export.started"));
    props.onStarted(result.value.export);
  }

  return (
    <Modal testId="rc-export-dialog" title={t("roughcut.export.title")} description={t("roughcut.export.hint")} closeLabel={t("common.close")} onClose={props.onClose}
      footer={<>
        <button type="button" className="secondary-button" data-testid="rc-export-dialog-cancel" onClick={props.onClose}>{t("common.cancel")}</button>
        <button type="button" className="primary-button" data-testid="rc-export-pick" disabled={busy} onClick={() => void start()}><Download size={15} aria-hidden="true" /> {t(destination === "work" ? "roughcut.export.start" : "roughcut.export.pick")}</button>
      </>}>
      <p className="detail-muted" data-testid="rc-export-choice">{choiceSummary(t, props.choice, props.plan)}</p>
      <label className="rc-field">{t("roughcut.export.name")}
        <input type="text" maxLength={120} data-testid="rc-export-name" value={name} placeholder={props.title || t("roughcut.export.namePlaceholder")} onChange={(event) => setName(event.target.value)} />
      </label>
      <fieldset className="rc-dest" role="radiogroup" aria-label={t("roughcut.export.dest")}>
        <legend>{t("roughcut.export.dest")}</legend>
        <label>
          <input type="radio" name="rc-dest" data-testid="rc-export-dest-work" checked={destination === "work"} onChange={() => setDestination("work")} /> {t("roughcut.export.dest.work")}
          <small className="detail-muted">{t("roughcut.export.dest.workHint")}</small>
        </label>
        <label>
          <input type="radio" name="rc-dest" data-testid="rc-export-dest-folder" checked={destination === "folder"} onChange={() => setDestination("folder")} /> {t("roughcut.export.dest.folder")}
          <small className="detail-muted">{t("roughcut.export.dest.folderHint")}</small>
        </label>
      </fieldset>
    </Modal>
  );
}
