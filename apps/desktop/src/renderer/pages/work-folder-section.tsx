import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Pencil, Upload } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";
import { ScreenshotThumb } from "../components/screenshot-thumb.tsx";

type T = Translator["t"];

type Folder = { id: string; title: string; relDir: string; mediaKind: string; ownerKind: "subject" | "work" | "resource" };
type FileRow = { id: string; kind: string; fileName: string; subDir: string; bytes: number; createdAt: string; refKind: string | null; refId: string | null };
type Group = { folder: Folder; files: FileRow[] };
const SHOWN = 12;

const sizeText = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Where the work's own content is kept (DATA-05, A-88): the folder of its entry, or one folder per file under 未分类, and what each holds. The
 * things worth doing from here are opening a folder in the system's file manager and bringing an existing recording in (it is copied into the
 * folder and written down as a note). Nothing is made until something is written.
 */
export function WorkFolderSection(props: {
  t: T;
  workId: string;
  /** The page asks again after a link or an unlink, which can move the folder. */
  version?: string | number;
  canTranscribe: boolean;
  formatDate: (value: string | Date) => string;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onChanged: () => void;
}) {
  const { t } = props;
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [all, setAll] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await attempt<{ groups: Group[] }>("workFolders.forWork", { workId: props.workId });
    setGroups(result.ok ? asArray<Group>(result.value.groups).map((group) => ({ folder: group.folder, files: asArray<FileRow>(group.files) })) : []);
  }, [props.workId]);
  useEffect(() => { setGroups(null); setAll(null); void load(); }, [load, props.version]);

  async function open(folder: Folder) {
    const result = await window.manga.reveal(`workfolder:${folder.id}`);
    if (result.status === "error") props.onError(result.error?.message ?? "");
  }
  async function rename(folder: Folder) {
    const result = await attempt<{ folder: Folder }>("workFolders.rename", { folderId: folder.id });
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("workfolder.renamed", { name: result.value.folder.relDir.split("/").pop() ?? result.value.folder.title }));
    await load();
    props.onChanged();
  }
  async function importAudio() {
    const handle = await window.manga.chooseAudio();
    if (!handle) return;
    setBusy(true);
    const result = await attempt("library.transcribeAudio", { pathHandle: handle, workId: props.workId });
    setBusy(false);
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onNotice(t("workfolder.importDone"));
    await load();
    props.onChanged();
  }

  return (
    <section className="detail-section work-folder" data-testid="work-folder">
      <h3>{t("workfolder.title")}</h3>
      <p className="detail-muted">{t("workfolder.hint")}</p>
      {props.canTranscribe ? (
        <div className="work-folder-actions">
          <button type="button" className="secondary-button" data-testid="work-folder-import-audio" title={t("workfolder.importAudioHint")} disabled={busy} onClick={() => void importAudio()}><Upload size={14} aria-hidden="true" /> {t("workfolder.importAudio")}</button>
        </div>
      ) : null}
      {groups && groups.length === 0 ? <p className="detail-muted" data-testid="work-folder-none">{t("workfolder.none")}</p> : null}
      {(groups ?? []).map(({ folder, files }) => {
        const shown = all === folder.id ? files : files.slice(0, SHOWN);
        return (
          <div key={folder.id} className="work-folder-group" data-testid={`work-folder-${folder.id}`}>
            <div className="work-folder-actions">
              <p className="detail-muted" data-testid="work-folder-path">{folder.relDir} · {t("workfolder.files", { count: files.length })}</p>
              <button type="button" className="secondary-button" data-testid="work-folder-open" onClick={() => void open(folder)}><FolderOpen size={14} aria-hidden="true" /> {t("workfolder.open")}</button>
              {folder.ownerKind !== "resource" ? <button type="button" className="secondary-button" data-testid="work-folder-rename" onClick={() => void rename(folder)}><Pencil size={14} aria-hidden="true" /> {t("workfolder.rename")}</button> : null}
            </div>
            {files.length === 0 ? <p className="detail-muted" data-testid="work-folder-empty">{t("workfolder.empty")}</p> : (
              <ul className="folder-files" data-testid="work-folder-files">
                {shown.map((file) => (
                  <li key={file.id} data-kind={file.kind} data-testid={`work-file-${file.id}`}>
                    {file.kind === "screenshot" && file.refId ? <ScreenshotThumb screenshotId={file.refId} alt={t("screenshot.thumb")} /> : null}
                    <span className="chip">{t(`workfolder.kind.${file.kind}` as never)}</span>
                    <span className="folder-file-name">{file.fileName}</span>
                    <span className="detail-muted">{sizeText(file.bytes)} · {props.formatDate(file.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            {all !== folder.id && files.length > SHOWN ? <button type="button" className="link-button" data-testid="work-folder-all" onClick={() => setAll(folder.id)}>{t("workfolder.showAll", { count: files.length })}</button> : null}
          </div>
        );
      })}
    </section>
  );
}
