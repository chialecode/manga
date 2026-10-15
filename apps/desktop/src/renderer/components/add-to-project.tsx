import { useState } from "react";
import { FolderPlus } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";
import { Modal } from "./modal.tsx";

type T = Translator["t"];
type Option = { id: string; name: string };

/**
 * "加入项目": makes the thing on this page a material of a project the person picks, or of a new one made right here. It only adds a
 * reference; the work, note or recording stays where it is and is not copied.
 */
export function AddToProject(props: {
  t: T;
  kind: "work" | "resource" | "anchor" | "note" | "recording" | "excerpt" | "whiteboard" | "mindmap" | "draft" | "roughcut";
  targetId: string;
  label?: string;
  onAdded?: (projectId: string) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Option[]>([]);
  const [name, setName] = useState("");

  async function show() {
    const result = await attempt<{ projects: Option[] }>("project.list", { status: "active" });
    if (!result.ok) { props.onError(result.error.message); return; }
    setProjects(asArray<Option>(result.value.projects));
    setOpen(true);
  }

  async function add(projectId: string) {
    const result = await attempt("project.addMaterial", { projectId, kind: props.kind, targetId: props.targetId, ...(props.label ? { label: props.label } : {}) });
    if (!result.ok) { props.onError(result.error.message); return; }
    setOpen(false);
    props.onNotice(t("projects.materials.added"));
    props.onAdded?.(projectId);
  }

  async function createAndAdd() {
    const title = name.trim();
    if (!title) return;
    const created = await attempt<{ id: string }>("project.create", { name: title });
    if (!created.ok) { props.onError(created.error.message); return; }
    setName("");
    await add(created.value.id);
  }

  return (
    <>
      <button type="button" className="secondary-button" data-testid="add-to-project" title={t("projects.materials.addToHint")} onClick={() => void show()}><FolderPlus size={15} aria-hidden="true" /> {t("projects.materials.addTo")}</button>
      {open ? (
        <Modal testId="add-to-project-dialog" title={t("projects.materials.addTo")} description={t("projects.materials.addToHint")} closeLabel={t("common.close")} onClose={() => setOpen(false)}>
          {projects.length === 0 ? <p className="detail-muted" data-testid="add-to-project-empty">{t("projects.empty")}</p> : (
            <ul className="add-to-project-list">
              {projects.map((project) => <li key={project.id}><button type="button" className="secondary-button" data-testid={`add-to-project-${project.id}`} onClick={() => void add(project.id)}>{project.name}</button></li>)}
            </ul>
          )}
          <form className="dictionary-add" onSubmit={(event) => { event.preventDefault(); void createAndAdd(); }}>
            <input data-testid="add-to-project-name" aria-label={t("projects.name")} placeholder={t("projects.name")} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
            <button type="submit" className="primary-button" data-testid="add-to-project-create" disabled={!name.trim()}>{t("projects.new")}</button>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
