import { useEffect, useMemo, useState } from "react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";
import { Modal } from "../components/modal.tsx";
import type { EmbedAttr, EmbedKind } from "./embed-types.ts";

type T = Translator["t"];
type Candidate = { id: string; title: string };
const KINDS: EmbedKind[] = ["note", "whiteboard", "mindmap"];

/**
 * Choose what to put into a note: another note, a whiteboard or a mind map, followed live or frozen as it is now. The note itself is not on
 * the list, since a note cannot hold itself; longer loops are accepted and shown as a loop by the embed.
 */
export function EmbedPicker(props: { t: T; noteId: string; kinds?: EmbedKind[]; onPick: (embed: EmbedAttr) => void; onClose: () => void }) {
  const { t } = props;
  const kinds = props.kinds ?? KINDS;
  const [kind, setKind] = useState<EmbedKind>(kinds[0] ?? "note");
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState(false);

  useEffect(() => {
    let live = true;
    setItems(null);
    const load = async (): Promise<Candidate[]> => {
      if (kind === "note") {
        const result = await attempt<Array<{ objectId: string; title: string }>>("notes.list", { limit: 200 });
        return result.ok ? asArray<{ objectId: string; title: string }>(result.value).map((note) => ({ id: note.objectId, title: note.title })) : [];
      }
      if (kind === "whiteboard") {
        const result = await attempt<{ boards: Candidate[] }>("whiteboard.list", {});
        return result.ok ? asArray<Candidate>(result.value.boards) : [];
      }
      const result = await attempt<{ maps: Candidate[] }>("mindmap.list", {});
      return result.ok ? asArray<Candidate>(result.value.maps) : [];
    };
    void load().then((found) => { if (live) setItems(found); });
    return () => { live = false; };
  }, [kind]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (items ?? []).filter((item) => !(kind === "note" && item.id === props.noteId) && (!needle || item.title.toLowerCase().includes(needle)));
  }, [items, query, kind, props.noteId]);

  return (
    <Modal title={t("embed.insert.title")} closeLabel={t("whiteboard.cancel")} onClose={props.onClose} testId="embed-picker">
      <div className="ref-picker">
        <div role="radiogroup" aria-label={t("embed.insert.kind")} className="embed-kinds">
          {kinds.map((item) => (
            <button key={item} type="button" role="radio" aria-checked={kind === item} className="secondary-button" data-testid={`embed-kind-${item}`} onClick={() => setKind(item)}>{t(`embed.insert.kind.${item}` as never)}</button>
          ))}
        </div>
        <input type="search" data-testid="embed-search" value={query} placeholder={t("whiteboard.ref.search")} aria-label={t("whiteboard.ref.search")} onChange={(event) => setQuery(event.target.value)} autoFocus />
        <label className="ref-snapshot"><input type="checkbox" data-testid="embed-snapshot" checked={snapshot} onChange={(event) => setSnapshot(event.target.checked)} /> {t("embed.insert.snapshot")}</label>
        {items === null ? <p className="detail-muted">{t("status.loading")}</p> : null}
        {items && !shown.length ? <p className="detail-muted" data-testid="embed-empty">{t("embed.insert.empty")}</p> : null}
        <ul className="ref-list">
          {shown.map((item) => (
            <li key={`${kind}:${item.id}`}>
              <button type="button" data-testid={`embed-pick-${item.id}`} onClick={() => props.onPick({ kind, targetId: item.id, label: item.title, mode: snapshot ? "snapshot" : "live" })}>
                <span className="ref-label">{item.title || t("embed.untitled")}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
