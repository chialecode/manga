import { useState } from "react";
import { Download } from "lucide-react";
import { attempt } from "../../../lib/api.ts";
import { useAsyncGuard } from "../../../hooks/use-async-guard.ts";
import { Modal } from "../../../components/modal.tsx";
import { formatClockMs } from "../../../readers/video-model.ts";
import type { ProjectTabContext } from "../project-page.tsx";
import {
  choiceSummary, lengthText, optionsOf, problemText, secondsText, toggleAudio, toggleSubtitle, trackLabel,
  type ExportChoice, type ExportView, type PlanView,
} from "./roughcut-model.ts";

/** What an export is asked to be: one file or one for each clip, the audio and subtitle tracks to keep, chapters. The tracks are those of the first clip's source. */
export function OptionsPanel({ ctx, cutId, plan, choice, busy, clipCount, onChoice }: { ctx: ProjectTabContext; cutId: string; plan: PlanView; choice: ExportChoice; busy: boolean; clipCount: number; onChoice: (choice: ExportChoice) => void }) {
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
export function PlanDetails({ t, plan, mode, titleOf, stale }: { t: ProjectTabContext["t"]; plan: PlanView; mode: ExportChoice["mode"]; titleOf: (clipId?: string) => string; stale: boolean }) {
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
export function ExportDetails({ t, view }: { t: ProjectTabContext["t"]; view: ExportView }) {
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
export function ExportDialog(props: { ctx: ProjectTabContext; cutId: string; title: string; plan: PlanView | null; choice: ExportChoice; onClose: () => void; onStarted: (view: ExportView) => void }) {
  const { t } = props.ctx;
  const [name, setName] = useState("");
  const [destination, setDestination] = useState<"work" | "folder">("work");
  const [busy, setBusy] = useState(false);
  const guard = useAsyncGuard();

  async function start() {
    if (busy) return;
    let pathHandle: string | undefined;
    if (destination === "folder") {
      if (!window.manga.pick) { props.ctx.onError(t("roughcut.export.pickUnavailable")); return; }
      const picked = await window.manga.pick({ mode: "directory" });
      if (!picked || !guard.isAlive()) return;
      pathHandle = picked.pathHandle;
    }
    setBusy(true);
    const result = await attempt<{ export: ExportView }>("roughcut.export", { cutId: props.cutId, ...(pathHandle ? { pathHandle } : {}), ...(name.trim() ? { fileName: name.trim() } : {}), options: optionsOf(props.choice) });
    if (!guard.isAlive()) return;
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
    <Modal testId="rc-export-dialog" title={t("roughcut.export.title")} description={t("roughcut.export.hint")} closeLabel={t("common.close")} onClose={() => { if (!busy) props.onClose(); }}
      footer={<>
        <button type="button" className="secondary-button" data-testid="rc-export-dialog-cancel" disabled={busy} onClick={props.onClose}>{t("common.cancel")}</button>
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
