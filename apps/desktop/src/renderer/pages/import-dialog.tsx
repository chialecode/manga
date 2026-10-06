import { useEffect, useRef, useState } from "react";
import { File as FileIcon, FolderOpen } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Modal } from "../components/modal.tsx";
import { attempt, uid } from "../lib/api.ts";
import { MEDIA_KINDS, type WorkMediaKind } from "../lib/works.ts";

type T = Translator["t"];

type Inspect = {
  entry: "file" | "directory";
  name: string;
  bytes?: number;
  suggestion: { kind: WorkMediaKind; basis: string; confidence: "high" | "low"; pages?: number };
  counts?: Record<WorkMediaKind, number>;
  truncated?: boolean;
  items?: Array<{ relative: string; type: string; imageCount?: number }>;
};

type Picked = { pathHandle: string; name: string; mode: "file" | "directory" };

/** A file name without its extension, for a work title when the file itself names nothing better. */
export function titleFromName(name: string): string {
  const base = name.replace(/\.[^./\\]{1,8}$/, "").trim();
  return base || name;
}

/**
 * Import: pick a file or a folder, see what it looks like and which kind the app suggests, choose the kind, import.
 * The kind is the user's choice; the suggestion is only a pre-selection with its basis shown.
 */
export function ImportDialog(props: {
  t: T;
  onClose: () => void;
  onImported: (workId: string | undefined, kind: WorkMediaKind) => void;
  onError: (message: string) => void;
}) {
  const { t } = props;
  const [picked, setPicked] = useState<Picked | null>(null);
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [kind, setKind] = useState<WorkMediaKind>("novel");
  const [state, setState] = useState<"idle" | "inspecting" | "importing" | "failed">("idle");
  const [message, setMessage] = useState<string>();
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  /** How far the check of a folder has got; the walk runs in a worker, so the dialog can say so while it goes. */
  const [looked, setLooked] = useState<{ folders: number; items: number } | null>(null);
  const alive = useRef(true);
  const requestId = useRef<string>("");
  const inspectId = useRef<string>("");

  useEffect(() => {
    alive.current = true;
    const off = window.manga.onNotice?.((notice) => {
      if (notice.topic === "inspect.progress") {
        const seen = notice.payload as { requestId?: string; stage?: string; folders?: number; items?: number };
        if (seen.requestId === inspectId.current && seen.stage === "folders") setLooked({ folders: Number(seen.folders ?? 0), items: Number(seen.items ?? 0) });
        return;
      }
      if (notice.topic !== "import.progress") return;
      const payload = notice.payload as { requestId?: string; done?: number; total?: number; label?: string };
      if (payload.requestId !== requestId.current) return;
      setProgress({ done: Number(payload.done ?? 0), total: Number(payload.total ?? 0), label: String(payload.label ?? "") });
    });
    return () => { alive.current = false; off?.(); };
  }, []);

  async function pick(mode: "file" | "directory") {
    if (!window.manga.pick) { setMessage(t("import.pickUnavailable")); return; }
    const result = await window.manga.pick({ mode, filter: "any" });
    if (!result || !alive.current) return;
    setPicked(result);
    setInspect(null);
    setMessage(undefined);
    setState("inspecting");
    setLooked(null);
    const key = uid();
    inspectId.current = key;
    const inspected = await attempt<Inspect>("library.inspectFile", { pathHandle: result.pathHandle }, { key });
    if (!alive.current) return;
    if (!inspected.ok) { setState("failed"); setMessage(inspected.error.message); return; }
    setInspect(inspected.value);
    setKind(inspected.value.suggestion.kind);
    setState("idle");
  }

  async function start() {
    if (!picked || !inspect) return;
    setState("importing");
    setMessage(undefined);
    setProgress(null);
    const key = uid();
    // The command's request id is its idempotency key, so progress notices can be matched to this import.
    requestId.current = key;
    const result = picked.mode === "directory"
      ? await attempt<{ workId?: string }>("works.importDirectory", { pathHandle: picked.pathHandle, kind }, { key })
      : await attempt<{ workId?: string }>("library.importDocument", { title: titleFromName(picked.name), pathHandle: picked.pathHandle, format: "auto", kind }, { key });
    if (!alive.current) return;
    if (!result.ok) { setState("failed"); setMessage(result.error.message); props.onError(result.error.message); return; }
    props.onImported(result.value.workId, kind);
  }

  const counts = inspect?.counts;
  const busy = state === "inspecting" || state === "importing";
  return (
    <Modal title={t("import.title")} description={t("import.description")} closeLabel={t("common.close")} onClose={() => { if (state !== "importing") props.onClose(); }} testId="import-dialog">
      <div className="import-pick">
        <button type="button" className="secondary-button" data-testid="import-pick-file" disabled={busy} onClick={() => void pick("file")}><FileIcon size={16} />{t("import.pickFile")}</button>
        <button type="button" className="secondary-button" data-testid="import-pick-dir" disabled={busy} onClick={() => void pick("directory")}><FolderOpen size={16} />{t("import.pickDirectory")}</button>
      </div>
      {picked ? <p className="import-name" data-testid="import-name">{picked.name}</p> : <p className="import-hint">{t("import.hint")}</p>}
      {state === "inspecting" ? <p role="status" data-testid="import-inspecting">{t("import.inspecting")}{looked ? ` · ${t("import.inspectProgress", { folders: looked.folders, items: looked.items })}` : ""}</p> : null}
      {inspect ? (
        <fieldset className="import-kinds" disabled={state === "importing"}>
          <legend>{t("import.kind")}</legend>
          {MEDIA_KINDS.map((item) => (
            <label key={item} className="import-kind">
              <input type="radio" name="import-kind" value={item} checked={kind === item} data-testid={`import-kind-${item}`} onChange={() => setKind(item)} />
              <span>{t(`shelf.kind.${item}` as "shelf.kind.novel")}{counts ? ` · ${counts[item]}` : ""}</span>
              {inspect.suggestion.kind === item ? <span className="chip" data-testid="import-suggested">{t("import.suggested")}</span> : null}
            </label>
          ))}
          <p className="import-basis" data-testid="import-basis">
            {t(`import.basis.${inspect.suggestion.basis}` as "import.basis.unknown")}
            {inspect.suggestion.confidence === "low" ? ` · ${t("import.lowConfidence")}` : ""}
          </p>
        </fieldset>
      ) : null}
      {inspect?.entry === "directory" && inspect.items?.length ? (
        <details className="import-items">
          <summary>{t("import.items", { count: inspect.items.length })}{inspect.truncated ? "+" : ""}</summary>
          <ul>{inspect.items.map((item) => <li key={item.relative}>{item.relative}{item.imageCount !== undefined ? ` · ${item.imageCount}` : ""}</li>)}</ul>
        </details>
      ) : null}
      {state === "importing" ? (
        <div role="status" data-testid="import-progress" className="import-progress">
          <progress value={progress?.done ?? 0} max={Math.max(progress?.total ?? 0, 1)} aria-label={t("import.progress")} />
          <span>{progress && progress.total ? `${progress.done}/${progress.total}` : t("import.working")}{progress?.label ? ` · ${progress.label}` : ""}</span>
        </div>
      ) : null}
      {state === "failed" && message ? <p role="alert" className="shelf-error" data-testid="import-error">{message}</p> : null}
      <div className="modal-actions">
        <button type="button" className="secondary-button" data-testid="import-cancel" disabled={state === "importing"} onClick={props.onClose}>{t("common.cancel")}</button>
        <button type="button" className="primary-button" data-testid="import-confirm" disabled={!inspect || state === "importing"} onClick={() => void start()}>{t("import.confirm")}</button>
      </div>
    </Modal>
  );
}
