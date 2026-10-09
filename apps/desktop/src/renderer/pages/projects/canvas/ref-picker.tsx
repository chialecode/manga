import { useEffect, useMemo, useState } from "react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../../../lib/api.ts";
import { Modal } from "../../../components/modal.tsx";

type T = Translator["t"];
export type PickedRef = { kind: string; id: string; label: string; mode: "live" | "snapshot" };
type Candidate = { kind: string; id: string; label: string; state: "ok" | "missing" | "disabled"; own: boolean };

/** The kinds whose content can be shown inside another object, so a live or snapshot choice makes sense for them. */
const EMBEDDABLE = new Set(["note", "whiteboard", "mindmap"]);

/**
 * Choose what a board or a map should point at: the materials the project holds and the objects it owns. A reference only points, so nothing is
 * copied; for an object that can be shown inside another one the choice is to follow it live or to freeze what it shows now.
 */
export function RefPicker(props: { t: T; projectId: string; excludeId?: string; onPick: (ref: PickedRef) => void; onClose: () => void }) {
  const { t } = props;
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState(false);

  useEffect(() => {
    let live = true;
    void attempt<{ objects: Candidate[] }>("project.objects", { projectId: props.projectId }).then((result) => { if (live) setItems(result.ok ? asArray<Candidate>(result.value.objects) : []); });
    return () => { live = false; };
  }, [props.projectId]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (items ?? []).filter((item) => item.state !== "missing" && item.id !== props.excludeId && (!needle || item.label.toLowerCase().includes(needle)));
  }, [items, query, props.excludeId]);

  return (
    <Modal title={t("whiteboard.ref.pick")} closeLabel={t("whiteboard.cancel")} onClose={props.onClose} testId="ref-picker">
      <div className="ref-picker">
        <input type="search" data-testid="ref-search" value={query} placeholder={t("whiteboard.ref.search")} aria-label={t("whiteboard.ref.search")} onChange={(event) => setQuery(event.target.value)} autoFocus />
        <label className="ref-snapshot"><input type="checkbox" data-testid="ref-snapshot" checked={snapshot} onChange={(event) => setSnapshot(event.target.checked)} /> {t("whiteboard.ref.snapshot")}</label>
        {items === null ? <p className="detail-muted">{t("status.loading")}</p> : null}
        {items && !items.length ? <p className="detail-muted" data-testid="ref-empty">{t("whiteboard.ref.empty")}</p> : null}
        {items && items.length && !shown.length ? <p className="detail-muted">{t("whiteboard.ref.noMatch")}</p> : null}
        <ul className="ref-list">
          {shown.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <button type="button" data-testid={`ref-pick-${item.id}`} disabled={item.state === "disabled"} onClick={() => props.onPick({ kind: item.kind, id: item.id, label: item.label, mode: snapshot && EMBEDDABLE.has(item.kind) ? "snapshot" : "live" })}>
                <span className="chip">{t(`whiteboard.ref.kind.${item.kind}` as never)}</span>
                <span className="ref-label">{item.label || t("embed.untitled")}</span>
                {item.state === "disabled" ? <span className="detail-muted">{t("whiteboard.ref.state.disabled")}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
