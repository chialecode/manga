import { useEffect, useRef, useState } from "react";
import type { Translator } from "@manga/i18n";
import { attempt } from "../../../lib/api.ts";
import { useAsyncGuard } from "../../../hooks/use-async-guard.ts";
import { DiffText } from "./diff-text.tsx";
import type { DraftDoc, VersionItem } from "./draft-model.ts";

type T = Translator["t"];

/** The versions of a draft: name the current one, look at an older one against the text now, go back to it. Going back keeps what was there. */
export function VersionsPanel(props: {
  t: T; formatDate: (iso: string) => string; draft: DraftDoc; versions: VersionItem[];
  flush: () => Promise<boolean>; onChanged: () => Promise<void>; onDraft: (draft: DraftDoc) => void; onError: (message: string) => void;
}) {
  const { t } = props;
  const [label, setLabel] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [older, setOlder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = useAsyncGuard();
  const onErrorRef = useRef(props.onError);
  onErrorRef.current = props.onError;

  useEffect(() => {
    if (open === null) { setOlder(null); return; }
    const token = guard.next();
    void attempt<{ text: string }>("draft.version", { draftId: props.draft.id, version: open }).then((result) => {
      if (!guard.isCurrent(token)) return;
      if (result.ok) setOlder(result.value.text); else onErrorRef.current(result.error.message);
    });
  }, [open, props.draft.id, props.draft.version, guard]);

  async function checkpoint() {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await props.flush())) return;
      const result = await attempt("draft.checkpoint", { draftId: props.draft.id, ...(label.trim() ? { label: label.trim() } : {}) });
      if (!guard.isAlive()) return;
      if (!result.ok) { props.onError(result.error.message); return; }
      setLabel("");
      await props.onChanged();
    } finally {
      if (guard.isAlive()) setBusy(false);
    }
  }
  async function restore(version: number) {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await props.flush())) return;
      const result = await attempt<{ draft: DraftDoc }>("draft.restore", { draftId: props.draft.id, version });
      if (!guard.isAlive()) return;
      if (!result.ok) { props.onError(result.error.message); return; }
      props.onDraft(result.value.draft);
      setOpen(null);
      await props.onChanged();
    } finally {
      if (guard.isAlive()) setBusy(false);
    }
  }

  return (
    <div className="draft-versions" data-testid="versions-panel">
      <h3>{t("draft.versions")}</h3>
      <form className="draft-checkpoint" onSubmit={(event) => { event.preventDefault(); void checkpoint(); }}>
        <input data-testid="version-label" value={label} maxLength={120} placeholder={t("draft.v.checkpointName")} aria-label={t("draft.v.checkpointName")} onChange={(event) => setLabel(event.target.value)} />
        <button type="submit" data-testid="version-checkpoint" disabled={busy}>{t("draft.v.checkpoint")}</button>
      </form>
      <ul>
        {props.versions.map((item) => (
          <li key={item.version} className={item.current ? "is-current" : ""}>
            <button type="button" data-testid={`version-${item.version}`} aria-expanded={open === item.version} disabled={item.current} onClick={() => setOpen(open === item.version ? null : item.version)}>
              <strong>v{item.version}</strong> {item.label || t("draft.v.untitled")}
              {item.current ? <span className="chip">{t("draft.v.current")}</span> : null}
              <small className="detail-muted">{props.formatDate(item.createdAt)} · {t("draft.v.chars", { chars: item.chars })}</small>
            </button>
            {open === item.version && older !== null ? (
              <div className="draft-version-open" data-testid={`version-open-${item.version}`}>
                <p className="detail-muted">{t("draft.v.compare")}</p>
                <DiffText t={t} before={older} after={props.draft.text} empty={t("draft.v.same")} testId={`version-diff-${item.version}`} />
                <p className="detail-muted">{t("draft.v.restoreHint")}</p>
                <button type="button" className="primary-button" data-testid={`version-restore-${item.version}`} disabled={busy} onClick={() => void restore(item.version)}>{t("draft.v.restore")}</button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
