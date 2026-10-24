import { useEffect, useMemo, useState } from "react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";
import { autoAddMaterial } from "../lib/materials.ts";
import { Modal } from "./modal.tsx";

type T = Translator["t"];
type Option = { id: string; title: string };
export type ShotRef = { id: string; title: string };

const newBlockId = () => `b_${crypto.randomUUID().slice(0, 8)}`;

/**
 * Where a screenshot that was just taken goes: into a note, as a block of its own that opens the source again, or onto a whiteboard, as a reference
 * card. The picture stays in the folder of its work; both only point at it.
 */
export function ScreenshotTargetDialog(props: {
  t: T;
  shot: ShotRef;
  target: "note" | "board";
  /** The context the picture was taken in: a note made for it there becomes a material of the project. */
  contextId?: string | null;
  onDone: (message: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const { t, shot } = props;
  const [items, setItems] = useState<Option[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    const load = async (): Promise<Option[]> => {
      if (props.target === "note") {
        const result = await attempt<Array<{ objectId: string; title: string }>>("notes.list", { limit: 200 });
        return result.ok ? asArray<{ objectId: string; title: string }>(result.value).map((note) => ({ id: note.objectId, title: note.title })) : [];
      }
      const result = await attempt<{ boards: Option[] }>("whiteboard.list", {});
      return result.ok ? asArray<Option>(result.value.boards) : [];
    };
    void load().then((found) => { if (live) setItems(found); });
    return () => { live = false; };
  }, [props.target]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (items ?? []).filter((item) => !needle || item.title.toLowerCase().includes(needle));
  }, [items, query]);

  async function intoNote(noteId: string, title: string) {
    const opened = await attempt<{ revision: number; document?: { blocks?: Array<Record<string, unknown>> } }>("notes.get", { objectId: noteId });
    if (!opened.ok) { props.onError(opened.error.message); return; }
    const blocks = [...(opened.value.document?.blocks ?? []), { id: newBlockId(), type: "screenshot", text: "", attrs: { screenshotId: shot.id } }];
    const saved = await attempt("notes.replace", { objectId: noteId, expectedRevision: Number(opened.value.revision), blocks });
    if (!saved.ok) { props.onError(saved.error.message); return; }
    props.onDone(t("screenshot.insertedNote", { title }));
  }

  async function newNote() {
    const created = await attempt<{ objectId: string }>("notes.create", { title: shot.title, text: "" });
    if (!created.ok) { props.onError(created.error.message); return; }
    void autoAddMaterial(props.contextId ?? null, "note", created.value.objectId);
    await intoNote(created.value.objectId, shot.title);
  }

  async function ontoBoard(boardId: string, title: string) {
    const board = await attempt<{ nodes: Array<{ x: number; y: number; w: number }> }>("whiteboard.get", { boardId });
    if (!board.ok) { props.onError(board.error.message); return; }
    const nodes = asArray<{ x: number; y: number; w: number }>(board.value.nodes);
    // Put it to the right of what is there, level with the top, so it lands where the person will see it and covers nothing.
    const x = nodes.length ? Math.max(...nodes.map((node) => node.x + node.w)) + 40 : 0;
    const y = nodes.length ? Math.min(...nodes.map((node) => node.y)) : 0;
    const edited = await attempt("whiteboard.edit", { boardId, label: shot.title.slice(0, 80), actions: [{ type: "addNode", kind: "ref", x, y, data: { refKind: "screenshot", targetId: shot.id, label: shot.title } }] });
    if (!edited.ok) { props.onError(edited.error.message); return; }
    props.onDone(t("screenshot.addedBoard", { title }));
  }

  return (
    <Modal title={props.target === "note" ? t("screenshot.pickNote") : t("screenshot.pickBoard")} closeLabel={t("common.close")} onClose={props.onClose} testId="screenshot-target">
      <div className="ref-picker">
        <input type="search" data-testid="screenshot-target-search" value={query} placeholder={t("whiteboard.ref.search")} aria-label={t("whiteboard.ref.search")} onChange={(event) => setQuery(event.target.value)} autoFocus />
        {props.target === "note" ? <button type="button" className="secondary-button" data-testid="screenshot-new-note" onClick={() => void newNote()}>{t("screenshot.newNote")}</button> : null}
        {items === null ? <p className="detail-muted">{t("status.loading")}</p> : null}
        {items && !items.length ? <p className="detail-muted" data-testid="screenshot-target-empty">{props.target === "note" ? t("screenshot.noNotes") : t("screenshot.noBoards")}</p> : null}
        <ul className="ref-list">
          {shown.map((item) => (
            <li key={item.id}>
              <button type="button" data-testid={`screenshot-target-${item.id}`} onClick={() => void (props.target === "note" ? intoNote(item.id, item.title) : ontoBoard(item.id, item.title))}>
                <span className="ref-label">{item.title || t("embed.untitled")}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
