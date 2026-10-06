import { useCallback, useEffect, useRef, useState } from "react";
import { asArray, attempt, messageOf } from "./api.ts";
import type { RelatedWorks, WorkDetail } from "./works.ts";

export type CoverSummary = { id: string; workId: string; source: "file" | "bangumi" | "user"; providerId: string | null; width: number | null; height: number | null; selected: boolean; createdAt: string };
export type CoverList = { workId: string; state: "auto" | "user" | "locked"; coverId: string | null; covers: CoverSummary[] };
export type NoteRow = { objectId: string; title: string; preview: string; resourceId: string | null; updatedAt: string };
export type CaptureRow = {
  id: string; stage: string; audioState: string; playable: boolean; durationMs: number; createdAt: string; resourceId: string | null;
  segments: { total: number; done: number; failed: number; pending: number; noSpeech: number };
};

export type DetailState = {
  detail: WorkDetail | null;
  status: "loading" | "ready" | "error";
  error?: string;
  covers: CoverList | null;
  related: RelatedWorks | null;
  relatedStatus: "idle" | "loading" | "ready" | "off" | "error";
  notes: NoteRow[];
  captures: CaptureRow[];
  reload: () => Promise<void>;
};

/**
 * Everything the work detail shows, loaded in the background after the core record: related works,
 * notes and recordings are separate commands, so a slow or disabled one never holds the rest back.
 */
export function useWorkDetail(workId: string, options: { metadata: boolean; voice: boolean }): DetailState {
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  const [status, setStatus] = useState<DetailState["status"]>("loading");
  const [error, setError] = useState<string>();
  const [covers, setCovers] = useState<CoverList | null>(null);
  const [related, setRelated] = useState<RelatedWorks | null>(null);
  const [relatedStatus, setRelatedStatus] = useState<DetailState["relatedStatus"]>("idle");
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [captures, setCaptures] = useState<CaptureRow[]>([]);
  const token = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++token.current;
    const core = await attempt<WorkDetail>("works.get", { workId });
    if (mine !== token.current) return;
    if (!core.ok) { setStatus("error"); setError(core.error.message); return; }
    setDetail(core.value);
    setStatus("ready");
    setError(undefined);
    const resources = core.value.resources ?? [];

    void attempt<CoverList>("covers.list", { workId }).then((result) => { if (mine === token.current && result.ok) setCovers(result.value); });

    if (options.metadata) {
      setRelatedStatus("loading");
      void attempt<RelatedWorks>("metadata.related", { workId }).then((result) => {
        if (mine !== token.current) return;
        if (result.ok) { setRelated(result.value); setRelatedStatus("ready"); return; }
        setRelatedStatus(result.error.code === "CAPABILITY_UNAVAILABLE" ? "off" : "error");
      });
    } else setRelatedStatus("off");

    void Promise.all(resources.slice(0, 8).map((resource) => attempt("notes.list", { resourceId: resource.id, limit: 20 }))).then((rows) => {
      if (mine !== token.current) return;
      const seen = new Set<string>();
      const merged: NoteRow[] = [];
      for (const row of rows) {
        if (!row.ok) continue;
        for (const note of asArray<NoteRow>(row.value)) {
          if (seen.has(note.objectId)) continue;
          seen.add(note.objectId);
          merged.push(note);
        }
      }
      setNotes(merged);
    });

    if (options.voice) {
      void attempt("capture.list", { workId, limit: 20 }).then((result) => {
        if (mine !== token.current) return;
        const value = result.ok ? (result.value as { sessions?: CaptureRow[] }).sessions ?? asArray<CaptureRow>(result.value) : [];
        setCaptures(value);
      });
    }
  }, [workId, options.metadata, options.voice]);

  useEffect(() => {
    setDetail(null);
    setStatus("loading");
    setCovers(null);
    setRelated(null);
    setNotes([]);
    setCaptures([]);
    void reload().catch((failure) => { setStatus("error"); setError(messageOf(failure)); });
    return () => { token.current += 1; };
  }, [reload]);

  return { detail, status, error, covers, related, relatedStatus, notes, captures, reload };
}
