import { useCallback, useEffect, useState } from "react";
import { FolderPlus } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { attempt } from "../../lib/api.ts";
import { addLibraryFolder } from "../../lib/relink.ts";
import type { WorkMediaKind } from "../../lib/works.ts";
import { SettingsSection } from "./rows.tsx";

type T = Translator["t"];
type Item = { resourceId: string; title: string; kind: string; workTitle: string | null };
type Group = { folder: string | null; items: Item[] };
type Preview = { resources: number; remove: Record<string, number>; keep: Record<string, number> };

const REMOVE_KEYS = ["files", "assets", "playCopies", "danmakuMatches"] as const;
const KEEP_KEYS = ["notes", "bookmarks", "recordings", "screenshots", "conversations", "progress"] as const;
const asKind = (kind: string): WorkMediaKind => (kind === "comic" || kind === "video" ? kind : "novel");

/**
 * The resources whose file is under no library path (A-113, Q-35 13): they are in no list of the library, so they are here, by the folder they were
 * in. A folder can be added as a library path (the resources come back to their works); each one opens the view of what was made on it; and the
 * records of all of them can be removed, after a confirmation that says what goes and what stays. Hidden while there are none.
 */
export function OutsideSection(props: {
  t: T;
  refreshKey: number;
  onViewRecords: (resourceId: string, kind: WorkMediaKind) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [state, setState] = useState<{ total: number; groups: Group[] } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await attempt<{ total: number; groups: Group[] }>("library.outside", {});
    if (result.ok) setState(result.value);
  }, []);
  useEffect(() => { void load(); }, [load, props.refreshKey]);

  async function addFolder(group: Group) {
    setBusy(true);
    const added = await addLibraryFolder(group.folder!, asKind(group.items[0]?.kind ?? "novel"));
    setBusy(false);
    if (added.kind === "failed") { props.onError(added.message); return; }
    if (added.kind === "added") { props.onNotice(t("content.folderAdded")); props.onChanged(); await load(); }
  }

  async function ask() {
    const result = await attempt<Preview>("library.outsidePreview", {});
    if (!result.ok) { props.onError(result.error.message); return; }
    setPreview(result.value);
  }

  async function remove() {
    if (!preview) return;
    setBusy(true);
    const result = await attempt<{ removed: number }>("library.removeOutside", { expectedCount: preview.resources });
    setBusy(false);
    setPreview(null);
    if (!result.ok) { props.onError(result.error.message); await load(); return; }
    props.onNotice(t("outside.removed", { count: result.value.removed }));
    props.onChanged();
    await load();
  }

  if (!state?.groups?.length) return null;
  return (
    <SettingsSection
      title={t("outside.title", { count: state.total })}
      hint={t("outside.hint")}
      testId="library-outside"
      actions={<button type="button" className="danger-button" data-testid="library-outside-remove" disabled={busy} onClick={() => void ask()}>{t("outside.remove")}</button>}
    >
      {preview ? (
        <div className="outside-confirm" role="alertdialog" aria-labelledby="outside-confirm-title" data-testid="library-outside-confirm">
          <p id="outside-confirm-title"><strong>{t("outside.confirm.title", { count: preview.resources })}</strong></p>
          <p>{t("outside.confirm.remove")}</p>
          <ul>{REMOVE_KEYS.map((key) => <li key={key}>{t(`outside.remove.${key}` as "outside.remove.files", { count: preview.remove[key] ?? 0 })}</li>)}</ul>
          <p>{t("outside.confirm.keep")}</p>
          <ul>{KEEP_KEYS.map((key) => <li key={key}>{t(`outside.keep.${key}` as "outside.keep.notes", { count: preview.keep[key] ?? 0 })}</li>)}</ul>
          <p className="detail-muted">{t("outside.confirm.final")}</p>
          <div className="outside-confirm-actions">
            <button type="button" className="secondary-button" data-testid="library-outside-cancel" onClick={() => setPreview(null)}>{t("common.cancel")}</button>
            <button type="button" className="danger-button" data-testid="library-outside-confirm-remove" disabled={busy} onClick={() => void remove()}>{t("outside.confirm.do", { count: preview.resources })}</button>
          </div>
        </div>
      ) : null}
      <ul className="outside-groups">
        {state.groups.map((group) => (
          <li key={group.folder ?? ""} className="outside-group" data-testid="library-outside-group">
            <div className="outside-folder">
              <span className="outside-folder-path" title={group.folder ?? undefined}>{group.folder ?? t("outside.unknownFolder")}</span>
              {group.folder ? <button type="button" className="secondary-button" disabled={busy} data-testid="library-outside-add" onClick={() => void addFolder(group)}><FolderPlus size={14} aria-hidden="true" />{t("outside.addFolder")}</button> : null}
            </div>
            <ul>
              {group.items.map((item) => (
                <li key={item.resourceId} className="outside-item" data-testid={`library-outside-${item.resourceId}`}>
                  <span className="outside-title" title={item.title}>{item.workTitle ? `${item.workTitle} · ${item.title}` : item.title}</span>
                  <button type="button" className="link-button" data-testid={`library-outside-view-${item.resourceId}`} onClick={() => props.onViewRecords(item.resourceId, asKind(item.kind))}>{t("outside.view")}</button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
