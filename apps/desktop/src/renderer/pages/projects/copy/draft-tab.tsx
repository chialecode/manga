import { useCallback, useEffect, useRef, useState } from "react";
import { CommandError, asArray, attempt } from "../../../lib/api.ts";
import type { ProjectTabContext } from "../project-page.tsx";
import { DocWorkspace, type DocKind } from "../canvas/doc-workspace.tsx";
import { DraftEditor } from "./draft-editor.tsx";
import { SuggestForm, SuggestionList, SuggestionView } from "./draft-suggestions.tsx";
import { VersionsPanel } from "./draft-versions.tsx";
import type { DraftDoc, DraftSummary, Range, SuggestionItem, VersionItem } from "./draft-model.ts";

const SAVE_DELAY_MS = 900;
const POLL_MS = 1500;

const DRAFT_KIND: DocKind<DraftSummary> = {
  prefix: "draft", item: "draft", focusKind: "draft",
  commands: { list: "draft.list", create: "draft.create", rename: "draft.rename", delete: "draft.delete" },
  idField: "draftId", listField: "drafts", createdField: "draft",
  meta: (draft, ctx) => ctx.t("draft.counts", { chars: draft.chars, version: draft.version }) + (draft.pending ? ` · ${ctx.t("draft.status.pending")} ${draft.pending}` : ""),
  defaultTitle: (n, ctx) => ctx.t("draft.defaultTitle", { n }),
  words: { list: "draft.drafts", empty: "draft.empty", create: "draft.new", rename: "draft.rename", remove: "draft.delete", confirm: "draft.deleteConfirm" },
};

/** The drafts of one project: the list on the left, the draft on show with its suggestions and versions. */
export function DraftTab({ ctx }: { ctx: ProjectTabContext }) {
  return <DocWorkspace ctx={ctx} kind={DRAFT_KIND} render={(draftId, refresh) => <DraftView key={draftId} ctx={ctx} draftId={draftId} onChanged={refresh} />} />;
}

type Loaded = { draft: DraftDoc; versions: VersionItem[]; suggestions: SuggestionItem[] };

/**
 * One draft: the text on the left, which saves itself as it is typed, and on the right the suggestions asked for and the versions kept. A
 * suggestion only ever shows a difference; the text changes when it is taken, and taking it can be undone.
 */
function DraftView({ ctx, draftId, onChanged }: { ctx: ProjectTabContext; draftId: string; onChanged: () => void }) {
  const { t } = ctx;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [panel, setPanelState] = useState<"suggest" | "versions">("suggest");
  const panelRef = useRef<"suggest" | "versions">("suggest");
  const setPanel = (next: "suggest" | "versions") => { panelRef.current = next; setPanelState(next); void load(false); };
  const [open, setOpen] = useState<string | null>(null);
  const [state, setState] = useState<"saved" | "saving" | "error" | "conflict">("saved");
  const [selection, setSelection] = useState<Range | null>(null);
  const text = useRef("");
  const version = useRef(0);
  const dirty = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; window.clearTimeout(timer.current); }, []);

  const load = useCallback(async (resetText: boolean) => {
    const result = await attempt<Loaded>("draft.get", { draftId });
    if (!alive.current) return;
    if (!result.ok) { ctx.onError(result.error.message); return; }
    const value = { draft: result.value.draft, versions: asArray<VersionItem>(result.value.versions), suggestions: asArray<SuggestionItem>(result.value.suggestions) };
    setLoaded(value);
    if (resetText) {
      text.current = value.draft.text; version.current = value.draft.version; dirty.current = false;
      setEpoch((current) => current + 1);
      setState("saved");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);
  useEffect(() => { void load(true); }, [load]);

  /** Writes the text that is on screen. Resolves false when it could not be saved, so a suggestion is never made from text the server does not have. */
  const flush = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current;
    if (!dirty.current) return state !== "conflict" && state !== "error";
    const attemptSave = (async () => {
      const sent = text.current;
      setState("saving");
      const result = await attempt<{ draft: DraftDoc }>("draft.save", { draftId, expectedVersion: version.current, text: sent });
      if (!alive.current) return result.ok;
      if (!result.ok) {
        setState(result.error instanceof CommandError && result.error.code === "REVISION_CONFLICT" ? "conflict" : "error");
        return false;
      }
      version.current = result.value.draft.version;
      // More typing during the save leaves the page unsaved; the next flush takes it.
      dirty.current = text.current !== sent;
      if (dirty.current) { timer.current = window.setTimeout(() => { void flush(); }, SAVE_DELAY_MS); setState("saving"); } else setState("saved");
      setLoaded((current) => current ? { ...current, draft: { ...current.draft, version: result.value.draft.version, text: sent } } : current);
      onChanged();
      // The list of versions follows the text while it is on show (the version being edited is the one marked current).
      if (panelRef.current === "versions") void load(false);
      return true;
    })();
    inFlight.current = attemptSave;
    try { return await attemptSave; } finally { if (inFlight.current === attemptSave) inFlight.current = null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, state]);
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const stableFlush = useCallback(() => flushRef.current(), []);

  useEffect(() => () => { if (dirty.current) void flushRef.current(); }, []);

  function typed(next: string) {
    text.current = next;
    dirty.current = true;
    if (state !== "conflict") setState("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flushRef.current(); }, SAVE_DELAY_MS);
  }

  /** The text was replaced on the server (a suggestion taken, a version restored): show it, and keep its version number for the next save. */
  function replaced(draft: DraftDoc) {
    text.current = draft.text; version.current = draft.version; dirty.current = false;
    setEpoch((current) => current + 1);
    setState("saved");
    setLoaded((current) => current ? { ...current, draft: { ...current.draft, ...draft } } : current);
  }

  const reload = useCallback(async () => { await load(false); onChanged(); }, [load, onChanged]);

  // A suggestion being written reports itself; a slow poll covers a notice that never arrived.
  const running = loaded?.suggestions.some((item) => item.status === "running") ?? false;
  useEffect(() => {
    const off = window.manga.onNotice?.((notice) => { if (notice.topic === "draft.suggestion" && notice.payload.draftId === draftId) void load(false); });
    return () => { off?.(); };
  }, [draftId, load]);
  useEffect(() => {
    if (!running) return;
    const poll = window.setInterval(() => { void load(false); }, POLL_MS);
    return () => window.clearInterval(poll);
  }, [running, load]);

  if (!loaded) return <div className="draft-view" aria-busy="true" data-testid="draft-view" />;
  const stamp = (id: string) => { const item = loaded.suggestions.find((candidate) => candidate.id === id); return item ? `${item.status}:${item.updatedAt}` : ""; };
  return (
    <div className="draft-view" data-testid="draft-view" data-save-state={state}>
      {/* The view is the container the two columns are measured against: where it is narrow (both side columns open), the panel goes under the editor. */}
      <div className="draft-grid">
        <section className="draft-main" aria-label={loaded.draft.title}>
          <header className="draft-head">
            <h2>{loaded.draft.title}</h2>
            <span className="detail-muted" role="status" data-testid="draft-state">
              {state === "saving" ? t("draft.saving") : state === "saved" ? t("draft.saved") : state === "conflict" ? t("draft.conflict") : t("draft.saveFailed")}
            </span>
            {state === "error" ? <button type="button" data-testid="draft-retry" onClick={() => void flush()}>{t("draft.retry")}</button> : null}
            {state === "conflict" ? <button type="button" data-testid="draft-reload" onClick={() => void load(true)}>{t("draft.reload")}</button> : null}
          </header>
          <DraftEditor text={loaded.draft.text} epoch={epoch} label={t("draft.editor")} onChange={typed} onSelection={setSelection} />
        </section>
        <aside className="draft-side">
          <div role="tablist" className="draft-tabs">
            <button type="button" role="tab" aria-selected={panel === "suggest"} data-testid="draft-panel-suggest" onClick={() => setPanel("suggest")}>{t("draft.tab.suggest")}</button>
            <button type="button" role="tab" aria-selected={panel === "versions"} data-testid="draft-panel-versions" onClick={() => setPanel("versions")}>{t("draft.tab.versions")}</button>
          </div>
          {panel === "versions" ? (
            <VersionsPanel t={t} formatDate={ctx.formatDate} draft={loaded.draft} versions={loaded.versions} flush={stableFlush} onChanged={reload} onDraft={replaced} onError={ctx.onError} />
          ) : open ? (
            <SuggestionView t={t} id={open} draft={loaded.draft} stamp={stamp(open)} flush={stableFlush} onBack={() => { setOpen(null); void load(false); }} onChanged={reload} onDraft={replaced} onOpen={setOpen} onError={ctx.onError} />
          ) : (
            <>
              <SuggestForm t={t} projectId={ctx.detail.project.id} draftId={draftId} selection={selection} flush={stableFlush} onError={ctx.onError}
                onStarted={(suggestion) => { void reload().then(() => setOpen(suggestion.id)); }} />
              <SuggestionList t={t} formatDate={ctx.formatDate} items={loaded.suggestions} onOpen={setOpen} />
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
