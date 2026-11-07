import { useState } from "react";
import { PackageOpen } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { attempt, type CommandError } from "../../lib/api.ts";
import { Modal } from "../../components/modal.tsx";

type T = Translator["t"];

/** What a project package holds and how it would meet this profile, read without changing anything (`project.packagePreview`). */
export type PackagePreview = {
  createdAt: string;
  projectId: string;
  name: string;
  goal: string;
  counts: Record<string, number>;
  /** The project is already here, so importing makes a copy; otherwise it is restored under its own ids. */
  copy: boolean;
  materials: Array<{ kind: string; targetId: string; label: string; present: boolean }>;
  missing: number;
};
type Imported = { projectId: string; mode: "restore" | "copy"; missing: unknown[] };

const REASONS = ["format", "newer", "hash", "extra", "missing", "unsafe", "size", "schema", "missing-file"] as const;

/** One sentence for why a package was refused, in words that say what to do about it; nothing in it names a file or a path. */
export function packageFailure(t: T, error: CommandError): string {
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  if (reason && (REASONS as readonly string[]).includes(reason)) return t(`projects.package.reason.${reason}` as "projects.package.reason.format");
  return t("projects.package.failed", { reason: error.message });
}

/** The import button of the projects page and its dialog: choose a file, read what it holds and what it would meet here, then import it. */
export function ImportProjectPackage(props: {
  t: T;
  formatDate: (value: string) => string;
  onImported: (projectId: string) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [chosen, setChosen] = useState<{ handle: string; preview: PackagePreview } | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose() {
    if (!window.manga.pick) { props.onError(t("projects.package.unavailable")); return; }
    const picked = await window.manga.pick({ mode: "file", filter: "package" });
    if (!picked) return;
    setBusy(true);
    const result = await attempt<PackagePreview>("project.packagePreview", { pathHandle: picked.pathHandle });
    setBusy(false);
    if (!result.ok) { props.onError(packageFailure(t, result.error)); return; }
    setChosen({ handle: picked.pathHandle, preview: result.value });
  }

  async function run() {
    if (!chosen) return;
    setBusy(true);
    const result = await attempt<Imported>("project.importPackage", { pathHandle: chosen.handle });
    setBusy(false);
    if (!result.ok) { props.onError(packageFailure(t, result.error)); setChosen(null); return; }
    const name = chosen.preview.name;
    setChosen(null);
    props.onNotice(t(result.value.mode === "copy" ? "projects.package.importedCopy" : "projects.package.imported", { name }));
    props.onImported(result.value.projectId);
  }

  const preview = chosen?.preview;
  return (
    <>
      <button type="button" className="secondary-button" data-testid="projects-import" disabled={busy} onClick={() => void choose()}><PackageOpen size={15} aria-hidden="true" /> {t("projects.package.import")}</button>
      {preview ? (
        <Modal testId="project-import" title={t("projects.package.import")} closeLabel={t("common.close")} onClose={() => setChosen(null)}
          footer={<>
            <button type="button" className="secondary-button" data-testid="project-import-cancel" onClick={() => setChosen(null)}>{t("projects.cancel")}</button>
            <button type="button" className="primary-button" data-testid="project-import-do" disabled={busy} onClick={() => void run()}>{t(preview.copy ? "projects.package.doCopy" : "projects.package.doRestore")}</button>
          </>}>
          <div className="package-preview" data-testid="project-import-preview" data-mode={preview.copy ? "copy" : "restore"}>
            <h4 data-testid="project-import-name">{preview.name}</h4>
            {preview.goal ? <p className="detail-muted project-goal">{preview.goal}</p> : null}
            <p className="detail-muted">{t("projects.package.madeAt", { date: props.formatDate(preview.createdAt) })}</p>
            <p data-testid="project-import-contents">{t("projects.package.contents", {
              boards: preview.counts.whiteboards ?? 0, maps: preview.counts.mindmaps ?? 0, drafts: preview.counts.drafts ?? 0,
              excerpts: preview.counts.excerpts ?? 0, cuts: preview.counts.rough_cuts ?? 0, materials: preview.counts.project_materials ?? 0, terms: preview.counts.project_terms ?? 0,
            })}</p>
            <p data-testid="project-import-notice">{t(preview.copy ? "projects.package.copyNotice" : "projects.package.restoreNotice")}</p>
            {preview.materials.length ? (
              <>
                <h5>{t("projects.package.materials")}</h5>
                <ul className="package-materials" data-testid="project-import-materials">
                  {preview.materials.map((item) => (
                    <li key={`${item.kind}:${item.targetId}`} data-present={item.present ? "yes" : "no"}>
                      <span className="chip">{t(`projects.materials.kind.${item.kind}` as "projects.materials.kind.work")}</span>
                      <span className="truncate">{item.label || t("projects.package.unnamed")}</span>
                      {item.present ? null : <span className="chip chip-warn">{t("projects.package.absent")}</span>}
                    </li>
                  ))}
                </ul>
                <p className="detail-muted" data-testid="project-import-missing">{preview.missing ? t("projects.package.absentHint", { count: preview.missing }) : t("projects.package.allPresent")}</p>
              </>
            ) : null}
            <p className="detail-muted">{t("projects.package.carries")}</p>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/** The project's settings: write it to a file in a folder the user chooses. */
export function ExportProjectPackage(props: { t: T; projectId: string; onError: (message: string) => void; onNotice: (message: string) => void }) {
  const { t } = props;
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!window.manga.pick) { props.onError(t("projects.package.unavailable")); return; }
    const folder = await window.manga.pick({ mode: "directory" });
    if (!folder) return;
    setBusy(true);
    const result = await attempt<{ fileName: string }>("project.exportPackage", { projectId: props.projectId, pathHandle: folder.pathHandle });
    setBusy(false);
    if (!result.ok) { props.onError(t("projects.package.exportFailed", { reason: result.error.message })); return; }
    props.onNotice(t("projects.package.exported", { name: result.value.fileName }));
  }

  return (
    <section className="project-package" data-testid="project-package">
      <h4>{t("projects.package.export")}</h4>
      <p className="detail-muted">{t("projects.package.exportHint")}</p>
      <div><button type="button" className="secondary-button" data-testid="project-export" disabled={busy} onClick={() => void run()}>{busy ? t("projects.package.exporting") : t("projects.package.export")}</button></div>
    </section>
  );
}
