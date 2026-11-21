import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import type { MessageKey } from "@manga/i18n";
import { asArray, attempt } from "../../../lib/api.ts";
import { isImeEvent } from "../../../lib/ime.ts";
import { useAsyncGuard } from "../../../hooks/use-async-guard.ts";
import { Modal } from "../../../components/modal.tsx";
import type { ProjectTabContext } from "../project-page.tsx";

export type DocSummary = { id: string; title: string };

/** What one kind of document (a whiteboard, a mind map, a draft, a rough cut) calls its commands and its words; the list, the choice and the deletion are the same for both. */
export type DocKind<S extends DocSummary> = {
  /** Prefix of the test ids and of the remembered choice. */
  prefix: "whiteboard" | "mindmap" | "draft" | "roughcut";
  /** The word in the test id of one entry: `board` or `map`. */
  item: "board" | "map" | "draft" | "cut";
  focusKind: "whiteboard" | "mindmap" | "draft" | "roughcut";
  commands: { list: string; create: string; rename: string; delete: string };
  idField: "boardId" | "mapId" | "draftId" | "cutId";
  listField: "boards" | "maps" | "drafts" | "cuts";
  createdField: "board" | "map" | "draft" | "cut";
  meta: (summary: S, ctx: ProjectTabContext) => string;
  defaultTitle: (n: number, ctx: ProjectTabContext) => string;
  words: { list: MessageKey; empty: MessageKey; create: MessageKey; rename: MessageKey; remove: MessageKey; confirm: MessageKey; titleLabel?: MessageKey };
};

/**
 * The shared frame of a project's boards, maps, drafts or rough cuts: the list on the left (create, rename, delete with a confirmation that says what goes) and the
 * document on show on the right. Which one is open follows the project's focus (one opened from a reference), else the one used last, else the first.
 */
export function DocWorkspace<S extends DocSummary>(props: { ctx: ProjectTabContext; kind: DocKind<S>; render: (id: string, refreshList: () => void) => ReactNode }) {
  const { ctx, kind } = props;
  const { t, detail } = ctx;
  const projectId = detail.project.id;
  const [docs, setDocs] = useState<S[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<S | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastKey = `manga.${kind.prefix}.last.${projectId}`;
  const guard = useAsyncGuard();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const reload = useCallback(async (select?: string) => {
    const token = guard.next();
    const result = await attempt<Record<string, unknown>>(kindRef.current.commands.list, { projectId });
    if (!guard.isCurrent(token)) return;
    if (!result.ok) { ctxRef.current.onError(result.error.message); setDocs([]); return; }
    const list = asArray<S>(result.value[kindRef.current.listField]);
    setDocs(list);
    setOpenId((current) => {
      if (select && list.some((doc) => doc.id === select)) return select;
      if (current && list.some((doc) => doc.id === current)) return current;
      let last: string | null = null;
      try { last = localStorage.getItem(lastKey); } catch { /* storage may be blocked */ }
      return list.find((doc) => doc.id === last)?.id ?? list[0]?.id ?? null;
    });
  }, [projectId, lastKey, guard]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const off = window.manga.onNotice?.((notice) => {
      if (notice.topic === "proposal.changed" && notice.payload.status === "applied" && (!notice.payload.projectId || notice.payload.projectId === projectId)) {
        void reload();
        ctxRef.current.reload();
      }
    });
    return () => { off?.(); };
  }, [reload, projectId]);
  const focusId = ctx.focus?.kind === kind.focusKind ? ctx.focus.id : null;
  useEffect(() => {
    if (!focusId) return;
    void reload(focusId).then(() => { if (guard.isAlive()) ctxRef.current.onFocus(null); });
  }, [focusId, reload, guard]);
  useEffect(() => { if (openId) { try { localStorage.setItem(lastKey, openId); } catch { /* ignore */ } } }, [openId, lastKey]);

  async function create() {
    if (busy) return;
    setBusy(true);
    const result = await attempt<Record<string, unknown>>(kind.commands.create, { projectId, title: kind.defaultTitle((docs?.length ?? 0) + 1, ctx) });
    if (!guard.isAlive()) return;
    setBusy(false);
    if (!result.ok) { ctx.onError(result.error.message); return; }
    await reload((result.value[kind.createdField] as S).id);
    if (guard.isAlive()) ctx.reload();
  }
  async function rename(doc: S, title: string) {
    setRenaming(null);
    if (busy || !title.trim() || title === doc.title) return;
    setBusy(true);
    const result = await attempt(kind.commands.rename, { [kind.idField]: doc.id, title: title.trim() });
    if (!guard.isAlive()) return;
    setBusy(false);
    if (!result.ok) { ctx.onError(result.error.message); return; }
    await reload();
  }
  async function remove(doc: S) {
    if (busy) return;
    setBusy(true);
    const result = await attempt(kind.commands.delete, { [kind.idField]: doc.id });
    if (!guard.isAlive()) return;
    setBusy(false);
    setConfirming(null);
    if (!result.ok) { ctx.onError(result.error.message); return; }
    setOpenId((current) => (current === doc.id ? null : current));
    await reload();
    if (guard.isAlive()) ctx.reload();
  }

  const p = kind.prefix;
  if (!docs) return <div className="wb-tab" data-testid={`${p}-tab`} aria-busy="true" />;
  return (
    <div className="wb-tab" data-testid={`${p}-tab`}>
      <aside className="wb-boards" aria-label={t(kind.words.list)}>
        <button type="button" className="primary-button wb-new" data-testid={`${p}-new`} disabled={busy} onClick={() => void create()}><Plus size={15} aria-hidden="true" /> {t(kind.words.create)}</button>
        <ul>
          {docs.map((doc) => (
            <li key={doc.id} className={doc.id === openId ? "is-current" : ""}>
              {renaming === doc.id ? (
                <input data-testid={`${p}-rename-input`} defaultValue={doc.title} aria-label={kind.words.titleLabel ? t(kind.words.titleLabel) : t(kind.words.rename)} autoFocus onBlur={(event) => void rename(doc, event.target.value)} onKeyDown={(event) => { if (isImeEvent(event)) return; if (event.key === "Enter") event.currentTarget.blur(); else if (event.key === "Escape") setRenaming(null); }} />
              ) : (
                <button type="button" className="wb-board-open" data-testid={`${p}-${kind.item}-${doc.id}`} aria-current={doc.id === openId} onClick={() => setOpenId(doc.id)} onDoubleClick={() => setRenaming(doc.id)}>
                  <span>{doc.title}</span><small>{kind.meta(doc, ctx)}</small>
                </button>
              )}
              {doc.id === openId ? (
                <span className="wb-board-actions">
                  <button type="button" className="link-button" data-testid={`${p}-rename`} disabled={busy} onClick={() => setRenaming(doc.id)}>{t(kind.words.rename)}</button>
                  <button type="button" className="link-button" data-testid={`${p}-delete`} disabled={busy} onClick={() => setConfirming(doc)}>{t(kind.words.remove)}</button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </aside>
      <div className="wb-stage">
        {openId ? props.render(openId, () => void reload()) : <p className="detail-muted wb-empty" data-testid={`${p}-empty`}>{t(kind.words.empty)}</p>}
      </div>
      {confirming ? (
        <Modal title={t(kind.words.remove)} closeLabel={t("whiteboard.cancel")} onClose={() => { if (!busy) setConfirming(null); }} testId={`${p}-delete-dialog`}
          footer={<><button type="button" disabled={busy} onClick={() => setConfirming(null)}>{t("whiteboard.cancel")}</button><button type="button" className="danger-button" data-testid={`${p}-delete-confirm`} disabled={busy} onClick={() => void remove(confirming)}>{t("whiteboard.deleteDo")}</button></>}>
          <p>{t(kind.words.confirm, { name: confirming.title })}</p>
        </Modal>
      ) : null}
    </div>
  );
}
