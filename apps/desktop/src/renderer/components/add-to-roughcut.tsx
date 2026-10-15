import { useState } from "react";
import { Scissors } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";
import { Modal } from "./modal.tsx";
import { readRange } from "../pages/projects/roughcut/roughcut-model.ts";
import { formatClockMs, parseClock } from "../readers/video-model.ts";

type T = Translator["t"];
type Named = { id: string; name: string };
type Sequence = { id: string; title: string };

const NEW = "__new__";
/** With no marks, a clip starts where the video is and runs this far. */
const DEFAULT_LENGTH_MS = 5000;

/**
 * "加入粗剪" in the player: puts the marked stretch of this video (or, without marks, a few seconds from where it is) into a sequence of a project,
 * picked or made right here. Only the times and a pointer to this revision of the video are kept; the video is not copied or changed.
 */
export function AddToRoughcut(props: {
  t: T;
  resourceId: string;
  revisionId: string;
  title: string;
  durationMs: number;
  currentMs: number;
  interval: { startMs: number; endMs: number } | null;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onAdded?: (cutId: string) => void;
}) {
  const { t } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<Named[]>([]);
  const [projectId, setProjectId] = useState(NEW);
  const [projectName, setProjectName] = useState("");
  const [cuts, setCuts] = useState<Sequence[]>([]);
  const [cutId, setCutId] = useState(NEW);
  const [cutName, setCutName] = useState("");
  const [inText, setInText] = useState("");
  const [outText, setOutText] = useState("");
  const [fromMarks, setFromMarks] = useState(false);
  const [problem, setProblem] = useState<"time" | "range" | null>(null);

  async function loadCuts(id: string) {
    if (id === NEW) { setCuts([]); setCutId(NEW); return; }
    const result = await attempt<{ cuts: Sequence[] }>("roughcut.list", { projectId: id });
    const list = result.ok ? asArray<Sequence>(result.value.cuts) : [];
    setCuts(list);
    setCutId(list[0]?.id ?? NEW);
  }

  async function show() {
    const result = await attempt<{ projects: Named[] }>("project.list", { status: "active" });
    if (!result.ok) { props.onError(result.error.message); return; }
    const list = asArray<Named>(result.value.projects);
    setProjects(list);
    const first = list[0]?.id ?? NEW;
    setProjectId(first);
    setProjectName("");
    setCutName("");
    setProblem(null);
    const start = props.interval?.startMs ?? props.currentMs;
    const end = props.interval?.endMs ?? Math.min(props.durationMs, start + DEFAULT_LENGTH_MS);
    setInText(formatClockMs(start));
    setOutText(formatClockMs(end));
    setFromMarks(props.interval !== null);
    await loadCuts(first);
    setOpen(true);
  }

  async function add() {
    const range = readRange(inText, outText, parseClock, props.durationMs);
    if (typeof range === "string") { setProblem(range); return; }
    setProblem(null);
    setBusy(true);
    try {
      let project = projectId;
      if (project === NEW) {
        const made = await attempt<{ id: string }>("project.create", { name: projectName.trim() || props.title });
        if (!made.ok) { props.onError(made.error.message); return; }
        project = made.value.id;
      }
      let cut = cutId;
      let name = cuts.find((item) => item.id === cut)?.title ?? "";
      if (cut === NEW) {
        name = cutName.trim() || t("roughcut.defaultTitle", { n: cuts.length + 1 });
        const made = await attempt<{ cut: Sequence }>("roughcut.create", { projectId: project, title: name });
        if (!made.ok) { props.onError(made.error.message); return; }
        cut = made.value.cut.id;
      }
      const added = await attempt("roughcut.edit", { cutId: cut, label: t("roughcut.op.add"), actions: [{ type: "add", resourceId: props.resourceId, resourceRevisionId: props.revisionId, inMs: range.inMs, outMs: range.outMs }] });
      if (!added.ok) {
        const reason = (added.error.details as { reason?: string } | undefined)?.reason;
        props.onError(reason === "range" ? t("roughcut.rangeInvalid") : reason === "busy" ? t("roughcut.busy") : added.error.message);
        return;
      }
      setOpen(false);
      props.onNotice(t("roughcut.add.done", { name }));
      props.onAdded?.(cut);
    } finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" className="secondary-button" data-testid="add-to-roughcut" title={t("roughcut.add.hint")} onClick={() => void show()}><Scissors size={15} aria-hidden="true" /> {t("roughcut.add")}</button>
      {open ? (
        <Modal testId="add-to-roughcut-dialog" title={t("roughcut.add")} description={t("roughcut.add.hint")} closeLabel={t("common.close")} onClose={() => setOpen(false)}
          footer={<>
            <button type="button" className="secondary-button" data-testid="add-to-roughcut-cancel" onClick={() => setOpen(false)}>{t("common.cancel")}</button>
            <button type="button" className="primary-button" data-testid="add-to-roughcut-do" disabled={busy} onClick={() => void add()}>{t("roughcut.add.do")}</button>
          </>}>
          <form className="rc-add" onSubmit={(event) => { event.preventDefault(); void add(); }}>
            <p className="detail-muted" data-testid="add-to-roughcut-source">{props.title} · {t(fromMarks ? "roughcut.add.fromMarks" : "roughcut.add.fromPosition")}</p>
            <div className="rc-add-row">
              <label className="rc-field">{t("roughcut.add.in")}
                <input type="text" inputMode="decimal" spellCheck={false} data-testid="add-to-roughcut-in" value={inText} aria-invalid={problem ? true : undefined} onChange={(event) => setInText(event.target.value)} />
              </label>
              <label className="rc-field">{t("roughcut.add.out")}
                <input type="text" inputMode="decimal" spellCheck={false} data-testid="add-to-roughcut-out" value={outText} aria-invalid={problem ? true : undefined} onChange={(event) => setOutText(event.target.value)} />
              </label>
            </div>
            {problem ? <small className="rc-clip-warn" role="alert" data-testid="add-to-roughcut-error">{t(problem === "time" ? "roughcut.timeInvalid" : "roughcut.rangeInvalid")}</small> : null}
            <div className="rc-add-row">
              <label className="rc-field">{t("roughcut.add.project")}
                <select data-testid="add-to-roughcut-project" value={projectId} onChange={(event) => { setProjectId(event.target.value); void loadCuts(event.target.value); }}>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  <option value={NEW}>{t("roughcut.add.newProject")}</option>
                </select>
              </label>
              {projectId === NEW ? (
                <label className="rc-field rc-field-wide">{t("roughcut.add.projectName")}
                  <input type="text" maxLength={120} data-testid="add-to-roughcut-project-name" value={projectName} placeholder={props.title} onChange={(event) => setProjectName(event.target.value)} />
                </label>
              ) : null}
            </div>
            {projects.length === 0 ? <small className="detail-muted">{t("roughcut.add.noProjects")}</small> : null}
            <div className="rc-add-row">
              <label className="rc-field">{t("roughcut.add.sequence")}
                <select data-testid="add-to-roughcut-sequence" value={cutId} onChange={(event) => setCutId(event.target.value)}>
                  {cuts.map((cut) => <option key={cut.id} value={cut.id}>{cut.title}</option>)}
                  <option value={NEW}>{t("roughcut.add.newSequence")}</option>
                </select>
              </label>
              {cutId === NEW ? (
                <label className="rc-field rc-field-wide">{t("roughcut.add.sequenceName")}
                  <input type="text" maxLength={120} data-testid="add-to-roughcut-sequence-name" value={cutName} placeholder={t("roughcut.defaultTitle", { n: cuts.length + 1 })} onChange={(event) => setCutName(event.target.value)} />
                </label>
              ) : null}
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
