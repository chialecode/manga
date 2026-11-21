import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Redo2, Square, Undo2 } from "lucide-react";
import type { MessageKey } from "@manga/i18n";
import type { RoughcutActionInput } from "@manga/contracts/roughcut-inputs";
import { asArray, attempt } from "../../../lib/api.ts";
import { useAsyncGuard } from "../../../hooks/use-async-guard.ts";
import { DocWorkspace, type DocKind } from "../canvas/doc-workspace.tsx";
import { useCanvasOpQueue } from "../canvas/use-canvas-op-queue.ts";
import type { ProjectTabContext } from "../project-page.tsx";
import { ClipPreview, ClipRow } from "./roughcut-clip.tsx";
import { ExportDetails, ExportDialog, OptionsPanel, PlanDetails } from "./roughcut-export.tsx";
import {
  DEFAULT_CHOICE, exportSummary, lengthText, moveTarget, optionsOf, stepText,
  type CutDoc, type CutSummary, type ExportChoice, type ExportView, type PlanView,
} from "./roughcut-model.ts";

type Action = RoughcutActionInput;
type EditResult = { doc: CutDoc; created: string[] };

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
const ROUGHCUT_OPS = new Set(["add", "update", "move", "remove"]);
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
  const { enqueue } = useCanvasOpQueue();
  const docGuard = useAsyncGuard();
  const exportsGuard = useAsyncGuard();
  const planGuard = useAsyncGuard();
  const planTimer = useRef<number | null>(null);
  const choiceRef = useRef(choice);
  choiceRef.current = choice;
  const asked = useRef(new Set<string>());

  /** The keyframes of the videos in the sequence, once their frame tables exist (the check builds them). A video that is not ready is asked about again after the next check. */
  const loadKeyframes = useCallback(async (value: PlanView) => {
    for (const clip of value.clips) {
      if (!planGuard.isAlive()) return;
      const key = keyOf(clip);
      if (asked.current.has(key) || clip.problems.some((problem) => problem.code === "source-missing")) continue;
      asked.current.add(key);
      const result = await attempt<{ ready: boolean; keyframesMs?: number[] }>("video.keyframes", { resourceId: clip.resourceId, revisionId: clip.revisionId });
      if (!planGuard.isAlive()) return;
      if (result.ok && result.value.ready && result.value.keyframesMs) {
        const list = result.value.keyframesMs;
        setKeyframes((current) => new Map(current).set(key, list));
      } else asked.current.delete(key);
    }
  }, [planGuard]);

  const runPlan = useCallback(async () => {
    const token = planGuard.next();
    setPlanning(true);
    const result = await attempt<{ plan: PlanView }>("roughcut.plan", { cutId, options: optionsOf(choiceRef.current) });
    if (!planGuard.isCurrent(token)) return;
    setPlanning(false);
    if (!result.ok) { onError.current(result.error.message); return; }
    setPlan(result.value.plan);
    void loadKeyframes(result.value.plan);
  }, [cutId, loadKeyframes, planGuard]);
  /** The check follows the sequence: after a change it runs once things have settled. */
  const schedulePlan = useCallback((delay = PLAN_DELAY_MS) => {
    if (planTimer.current !== null) window.clearTimeout(planTimer.current);
    setPlanning(true);
    planTimer.current = window.setTimeout(() => { planTimer.current = null; void runPlan(); }, delay);
  }, [runPlan]);
  useEffect(() => () => { if (planTimer.current !== null) window.clearTimeout(planTimer.current); }, []);

  // What the export is asked to be changes what the check says (tracks that are not there, a subtitle a file cannot hold), so the check follows it.
  const firstChoice = useRef(true);
  useEffect(() => {
    if (firstChoice.current) { firstChoice.current = false; return; }
    schedulePlan(120);
  }, [choice, schedulePlan]);

  const loadExports = useCallback(async () => {
    const token = exportsGuard.next();
    const result = await attempt<{ exports: ExportView[] }>("roughcut.exports", { cutId });
    if (exportsGuard.isCurrent(token) && result.ok) setExports(asArray<ExportView>(result.value.exports));
  }, [cutId, exportsGuard]);
  const load = useCallback(async () => {
    const token = docGuard.next();
    const result = await attempt<CutDoc>("roughcut.get", { cutId });
    if (!docGuard.isCurrent(token)) return;
    if (!result.ok) { onError.current(result.error.message); return; }
    setDoc(result.value);
  }, [cutId, docGuard]);
  useEffect(() => { void load(); void loadExports(); void runPlan(); }, [load, loadExports, runPlan]);

  // The export reports each step as a notice; the list follows it, and when it ends the sequence is free again.
  useEffect(() => {
    const off = window.manga.onNotice?.((notice) => {
      if (notice.topic === "proposal.changed" && notice.payload.status === "applied") {
        void load();
        void loadExports();
        void runPlan();
        return;
      }
      if (notice.topic !== "roughcut.export") return;
      const view = notice.payload as unknown as ExportView;
      if (view.cutId !== cutId) return;
      setExports((current) => (current.some((item) => item.id === view.id) ? current.map((item) => (item.id === view.id ? view : item)) : [view, ...current]));
      if (TERMINAL.has(view.state)) { void load(); }
    });
    return () => { off?.(); };
  }, [cutId, load, loadExports, runPlan]);

  const commit = useCallback((actions: Action[], label?: string): Promise<EditResult | null> => (
    enqueue(async () => {
      const result = await attempt<EditResult>("roughcut.edit", { cutId, actions, ...(label ? { label } : {}) });
      if (!docGuard.isAlive()) return null;
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
    })
  ), [cutId, load, onChanged, schedulePlan, t, enqueue, docGuard]);

  const step = useCallback(async (direction: "undo" | "redo") => {
    await enqueue(async () => {
      const result = await attempt<{ doc: CutDoc }>(`roughcut.${direction}`, { cutId });
      if (!docGuard.isAlive()) return;
      if (!result.ok) { if (result.error.code !== "NOT_FOUND") onError.current(result.error.message); await load(); return; }
      setDoc(result.value.doc);
      onChanged();
      schedulePlan();
    });
  }, [cutId, load, onChanged, schedulePlan, enqueue, docGuard]);

  const titles = useMemo(() => new Map((doc?.clips ?? []).map((clip, i) => [clip.id, clip.title || `#${i + 1}`])), [doc?.clips]);
  const titleOf = useCallback((clipId?: string) => (clipId ? titles.get(clipId) ?? "" : ""), [titles]);
  const setSnap = useCallback((on: boolean) => { setSnapState(on); writeSnap(on); }, []);
  const opLabel = (label: string) => (ROUGHCUT_OPS.has(label) ? t(`roughcut.op.${label}` as MessageKey) : label);

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
          <button type="button" className="icon-button" data-testid="rc-undo" disabled={!doc.ops.canUndo || busy} aria-label={doc.ops.undoLabel ? t("roughcut.undoLabel", { label: opLabel(doc.ops.undoLabel) }) : t("roughcut.undo")} title={doc.ops.undoLabel ? t("roughcut.undoLabel", { label: opLabel(doc.ops.undoLabel) }) : t("roughcut.undo")} onClick={() => void step("undo")}><Undo2 size={16} aria-hidden="true" /></button>
          <button type="button" className="icon-button" data-testid="rc-redo" disabled={!doc.ops.canRedo || busy} aria-label={doc.ops.redoLabel ? t("roughcut.redoLabel", { label: opLabel(doc.ops.redoLabel) }) : t("roughcut.redo")} title={doc.ops.redoLabel ? t("roughcut.redoLabel", { label: opLabel(doc.ops.redoLabel) }) : t("roughcut.redo")} onClick={() => void step("redo")}><Redo2 size={16} aria-hidden="true" /></button>
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
