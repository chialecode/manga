import { useEffect, useState } from "react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../../lib/api.ts";
import type { NoteSummary } from "../../lib/types.ts";
import { formatClock } from "../../readers/video-model.ts";
import { Modal } from "../modal.tsx";

type T = Translator["t"];

/** A task takes at most this many recording transcripts (the same limit the host checks). */
export const MAX_TASK_RECORDINGS = 3;
type RecordingRow = { id: string; stage: string; durationMs: number; createdAt: string; segments: { done: number } };

/**
 * The "choose materials" step of the "+" menu: resources and notes whose text goes to the Agent with the next task, as the user ticks
 * them. The ticks stay with the conversation; what the task finally receives is frozen when it is sent.
 */
export function MaterialsDialog(props: {
  t: T;
  resources: Array<{ id: string; title: string }>;
  materials: string[];
  noteMaterials: string[];
  onMaterials: (ids: string[]) => void;
  onNoteMaterials: (ids: string[]) => void;
  /** The open resource, when the voice module is on: its finished recordings can go with the task as text, with their times. */
  recordingsOf?: string | null;
  recordings?: string[];
  onRecordings?: (ids: string[]) => void;
  formatDate?: (value: string) => string;
  onClose: () => void;
}) {
  const { t } = props;
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [captures, setCaptures] = useState<RecordingRow[]>([]);
  useEffect(() => {
    if (!props.recordingsOf) { setCaptures([]); return; }
    let cancelled = false;
    void attempt<{ sessions?: RecordingRow[] }>("capture.list", { resourceId: props.recordingsOf, limit: 10 }).then((result) => {
      if (!cancelled) setCaptures(result.ok ? asArray<RecordingRow>(result.value.sessions).filter((row) => row.stage === "done" && row.segments.done > 0) : []);
    });
    return () => { cancelled = true; };
  }, [props.recordingsOf]);
  const picked = props.recordings ?? [];
  useEffect(() => {
    let cancelled = false;
    void attempt<NoteSummary[]>("notes.list", {}).then((result) => { if (!cancelled && result.ok) setNotes(asArray<NoteSummary>(result.value)); });
    return () => { cancelled = true; };
  }, []);
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((item) => item !== id));
  return (
    <Modal testId="materials-dialog" title={t("agent.materials")} closeLabel={t("common.close")} onClose={props.onClose}>
      <fieldset className="agent-materials">
        <legend>{t("agent.materials")}</legend>
        {props.resources.length === 0 ? <p className="detail-muted">{t("agent.materialsNone")}</p> : (
          <ul>
            {props.resources.map((resource) => (
              <li key={resource.id}>
                <label className="msettings-check"><input type="checkbox" checked={props.materials.includes(resource.id)} onChange={(event) => props.onMaterials(toggle(props.materials, resource.id, event.target.checked))} data-testid={`material-${resource.id}`} />{resource.title}</label>
              </li>
            ))}
          </ul>
        )}
        {notes.length ? (
          <>
            <h4>{t("agent.noteMaterials")}</h4>
            <ul>
              {notes.map((note) => (
                <li key={note.objectId}>
                  <label className="msettings-check"><input type="checkbox" checked={props.noteMaterials.includes(note.objectId)} onChange={(event) => props.onNoteMaterials(toggle(props.noteMaterials, note.objectId, event.target.checked))} data-testid={`note-material-${note.objectId}`} />{note.title || t("notes.open")}</label>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {captures.length ? (
          <>
            <h4>{t("rp.recordings")}</h4>
            <ul data-testid="material-recordings">
              {captures.map((row) => (
                <li key={row.id}>
                  <label className="msettings-check">
                    <input
                      type="checkbox"
                      data-testid={`agent-recording-${row.id}`}
                      checked={picked.includes(row.id)}
                      onChange={(event) => props.onRecordings?.(event.target.checked ? [...new Set([...picked, row.id])].slice(0, MAX_TASK_RECORDINGS) : picked.filter((item) => item !== row.id))}
                    />
                    {t("rp.recordings.item", { time: props.formatDate ? props.formatDate(row.createdAt) : row.createdAt, duration: formatClock(row.durationMs), segments: row.segments.done })}
                  </label>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="detail-muted">{t("agent.scope")}：{t("agent.scopeCount", { count: props.materials.length + props.noteMaterials.length + picked.length })}</p>
      </fieldset>
    </Modal>
  );
}
