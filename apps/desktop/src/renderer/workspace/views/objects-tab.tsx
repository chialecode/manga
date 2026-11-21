import { useCallback, useEffect, useRef, useState } from "react";
import { OBJECT_KINDS, type ObjectListKind, type ObjectRow } from "@manga/contracts";
import type { MessageKey } from "@manga/i18n";
import { InlineRename } from "../../components/inline-rename.tsx";
import { Modal } from "../../components/modal.tsx";
import { useDebouncedSearch } from "../../hooks/use-async-guard.ts";
import { attempt } from "../../lib/api.ts";
import { OBJECT_SPEC } from "../../lib/object-kinds.ts";
import { Pager, SettingsPage } from "../../pages/settings/rows.tsx";
import { str } from "../model.ts";
import { useServices } from "../services.tsx";
import { useTabEnv } from "../tab-env.tsx";

const PAGE = 30;

/**
 * The management tab of one kind of a project's objects (A-99, 交互设计 2.10): the whiteboards, maps, drafts or cuts of every project, newest first, narrowed
 * by name. An object opens in the project it belongs to; it can be renamed and deleted (after a confirmation) from here.
 */
export function ObjectsTab() {
  const env = useTabEnv();
  const s = useServices();
  const { t } = s;
  const asked = str(env.model?.target.kind);
  const kind = (OBJECT_KINDS as readonly string[]).includes(asked) ? (asked as ObjectListKind) : null;
  const search = useDebouncedSearch("", 250);
  const q = search.query;
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<ObjectRow[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [asking, setAsking] = useState<ObjectRow | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const setErrorRef = useRef(s.setError);
  setErrorRef.current = s.setError;

  useEffect(() => { setOffset(0); }, [q]);

  const load = useCallback(async () => {
    if (!kind) return;
    const mine = ++latest.current;
    const result = await attempt<{ items: ObjectRow[]; total: number }>("workspace.objects", { kind, ...(q ? { q } : {}), limit: PAGE, offset });
    if (mine !== latest.current) return;
    if (!result.ok) { setStatus("error"); setErrorRef.current(result.error.message); return; }
    setItems(result.value.items);
    setTotal(result.value.total);
    setStatus("ready");
  }, [kind, q, offset]);
  useEffect(() => { void load(); }, [load, s.projectsVersion, s.shelfKey, s.listsVersion]);

  // A tab that is told another kind shows that kind from its first page.
  useEffect(() => { setOffset(0); setItems([]); setStatus("loading"); setRenaming(null); }, [kind]);

  if (!kind) return null;
  const spec = OBJECT_SPEC[kind];
  const name = (key: string) => t(`objects.${key}` as MessageKey);

  async function commitRename(id: string, title: string) {
    setRenaming(null);
    const result = await attempt(spec.rename, { [spec.idField]: id, title });
    if (!result.ok) { s.setError(result.error.message); return; }
    s.changedProjects();
  }

  async function remove() {
    if (!asking) return;
    setBusy(true);
    const result = await attempt(spec.delete, { [spec.idField]: asking.id });
    setBusy(false);
    setAsking(null);
    if (!result.ok) { s.setError(result.error.message); return; }
    s.changedProjects();
  }

  return (
    <div className="records-tab" data-testid="objects-tab" data-kind={kind}>
      <div className="settings-view" data-testid="page-objects">
        <SettingsPage id="objects" title={t(`sidebar.manage.${kind}` as MessageKey)} hint={name("hint")} wide>
          <div className="records-filters" role="search" data-testid="objects-filters">
            <input type="search" aria-label={name("search")} placeholder={name("search")} data-testid="objects-search" {...search.inputProps} />
          </div>
          {status === "loading" && !items.length ? <p role="status" className="detail-muted" data-testid="objects-loading">{t("status.loading")}</p> : null}
          {status === "ready" && items.length === 0 ? <p className="detail-muted settings-empty" data-testid="objects-empty">{q ? name("emptyFound") : name("empty")}</p> : null}
          <ul className="records-list" data-testid="objects-list" aria-busy={status === "loading"}>
            {items.map((item) => (
              <li key={item.id} className="record-row" data-testid={`object-${item.id}`} data-archived={item.projectArchived ? "true" : "false"}>
                <div className="record-main">
                  {renaming?.id === item.id ? (
                    <InlineRename initialValue={renaming.text} ariaLabel={name("name")} testId="object-rename" onCommit={(title) => commitRename(item.id, title)} onCancel={() => setRenaming(null)} />
                  ) : <strong className="record-title">{item.title}</strong>}
                  <span className="detail-muted record-meta">{[item.projectName, item.projectArchived ? name("archived") : null, s.i18n.formatDate(item.updatedAt)].filter(Boolean).join(" · ")}</span>
                </div>
                <div className="record-actions">
                  <button type="button" className="secondary-button" data-testid={`object-open-${item.id}`} data-opens onClick={() => void s.open.item({ open: { kind, id: item.id }, contextId: item.projectId, title: item.title })}>{t("records.open")}</button>
                  <button type="button" className="secondary-button" data-testid={`object-rename-${item.id}`} onClick={() => setRenaming({ id: item.id, text: item.title })}>{name("rename")}</button>
                  <button type="button" className="link-button" data-testid={`object-delete-${item.id}`} onClick={() => setAsking(item)}>{t("records.delete")}</button>
                </div>
              </li>
            ))}
          </ul>
          <Pager testId="objects-pager" offset={offset} limit={PAGE} total={total} onPage={setOffset} previous={t("pager.previous")} next={t("pager.next")} label={(from, to, count) => t("pager.range", { from, to, total: count })} />
        </SettingsPage>
      </div>
      {asking ? (
        <Modal
          variant="dialog"
          testId="object-delete-confirm"
          title={t("sidebar.deleteObject.title", { name: asking.title })}
          closeLabel={t("common.close")}
          onClose={() => { if (!busy) setAsking(null); }}
          footer={(
            <>
              <button type="button" className="secondary-button" data-testid="object-delete-cancel" disabled={busy} onClick={() => setAsking(null)}>{t("common.cancel")}</button>
              <button type="button" className="danger-button" data-testid="object-delete-ok" disabled={busy} onClick={() => void remove()}>{t("whiteboard.deleteDo")}</button>
            </>
          )}
        >
          <p>{t(spec.confirm, { name: asking.title })}</p>
        </Modal>
      ) : null}
    </div>
  );
}
