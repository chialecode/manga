import { useEffect, useState } from "react";
import type { Translator } from "@manga/i18n";
import { Modal } from "../components/modal.tsx";
import { useAsyncGuard } from "../hooks/use-async-guard.ts";
import { asArray, attempt } from "../lib/api.ts";
import type { WorkMediaKind, WorkSummary } from "../lib/works.ts";

type T = Translator["t"];

/** Moving a file to another work, or to a new one named here: the work is the unit, so a file filed under the wrong work can be put right. */
export function MoveDialog(props: { t: T; resourceId: string; fromWorkId: string | null; kind: WorkMediaKind; onClose: () => void; onMoved: () => void; onError: (message: string) => void }) {
  const { t } = props;
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<WorkSummary[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const guard = useAsyncGuard();
  useEffect(() => {
    const token = guard.next();
    void attempt<{ items: WorkSummary[] }>("works.list", { kind: props.kind, group: false, limit: 20, ...(query.trim() ? { query: query.trim() } : {}) }).then((result) => {
      if (guard.isCurrent(token) && result.ok) setRows(asArray<WorkSummary>(result.value.items).filter((work) => work.id !== props.fromWorkId));
    });
  }, [query, props.kind, props.fromWorkId, guard]);

  async function move(input: { toWorkId?: string; newWorkTitle?: string }) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await attempt("works.moveResource", { resourceId: props.resourceId, ...input });
      if (!guard.isAlive()) return;
      if (!result.ok) { props.onError(result.error.message); return; }
      props.onMoved();
    } finally {
      if (guard.isAlive()) setBusy(false);
    }
  }

  return (
    <Modal variant="dialog" testId="work-move" title={t("work.move.title")} closeLabel={t("common.close")} onClose={() => { if (!busy) props.onClose(); }}>
      <label className="search-box"><input data-testid="work-move-query" value={query} placeholder={t("work.move.search")} aria-label={t("work.move.search")} onChange={(event) => setQuery(event.target.value)} /></label>
      <ul className="detail-list" data-testid="work-move-list">
        {rows.map((work) => <li key={work.id}><button type="button" className="link-button" data-testid={`work-move-to-${work.id}`} disabled={busy} onClick={() => void move({ toWorkId: work.id })}>{work.title}</button></li>)}
        {rows.length === 0 ? <li className="detail-muted">{t("work.move.none")}</li> : null}
      </ul>
      <form className="match-search" onSubmit={(event) => { event.preventDefault(); if (title.trim()) void move({ newWorkTitle: title.trim() }); }}>
        <input data-testid="work-move-new" value={title} disabled={busy} placeholder={t("work.move.newPlaceholder")} aria-label={t("work.move.newPlaceholder")} onChange={(event) => setTitle(event.target.value)} />
        <button type="submit" className="secondary-button" data-testid="work-move-new-go" disabled={busy || !title.trim()}>{t("work.move.newGo")}</button>
      </form>
    </Modal>
  );
}
