import { useCallback, useEffect, useRef, useState } from "react";
import { asArray, attempt } from "../../../lib/api.ts";
import { useAsyncGuard } from "../../../hooks/use-async-guard.ts";
import type { ProjectTabContext } from "../project-page.tsx";
import { ExcerptList } from "./excerpt-list.tsx";
import { PagesPanel, SearchPanel, WebSearchPanel } from "./finder-panels.tsx";
import { PageReader } from "./page-reader.tsx";
import { SemanticPanel } from "./semantic-panel.tsx";
import type { SemanticHitView } from "../../../lib/semantic-model.ts";
import type { ExcerptItem, FetchOutcome, PageDoc } from "./research-model.ts";

/**
 * The excerpt tab of a project: look through the person's own material, fetch a web page they name, read it as plain text, and keep the words
 * they select as excerpts that remember which version of the page they came from. Nothing here reaches the network except the one fetch.
 */
export function ResearchTab({ ctx }: { ctx: ProjectTabContext }) {
  const { t, detail } = ctx;
  const projectId = detail.project.id;
  const [doc, setDoc] = useState<PageDoc | null>(null);
  const [excerpts, setExcerpts] = useState<ExcerptItem[] | null>(null);
  const [pagesVersion, setPagesVersion] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [refetching, setRefetching] = useState(false);
  const [mode, setMode] = useState<"keyword" | "meaning">("keyword");
  const meaningOn = ctx.facets.has("semantic");
  const excerptsGuard = useAsyncGuard();
  const pageGuard = useAsyncGuard();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const loadExcerpts = useCallback(async () => {
    const token = excerptsGuard.next();
    const result = await attempt<{ excerpts: ExcerptItem[] }>("excerpt.list", { projectId });
    if (!excerptsGuard.isCurrent(token)) return;
    if (!result.ok) { ctxRef.current.onError(result.error.message); setExcerpts([]); return; }
    setExcerpts(asArray<ExcerptItem>(result.value.excerpts));
  }, [projectId, excerptsGuard]);
  useEffect(() => { void loadExcerpts(); }, [loadExcerpts]);

  const openPage = useCallback(async (pageId: string, focus: string | null = null) => {
    const token = pageGuard.next();
    const result = await attempt<PageDoc>("webpage.get", { pageId });
    if (!pageGuard.isCurrent(token)) return;
    if (!result.ok) { ctxRef.current.onError(result.error.message); return; }
    setDoc({ page: result.value.page, text: result.value.text, versions: asArray(result.value.versions), excerpts: asArray(result.value.excerpts) });
    setFocusId(focus);
  }, [pageGuard]);

  const openExcerpt = useCallback(async (excerptId: string) => {
    const token = pageGuard.next();
    const found = await attempt<{ excerpt: ExcerptItem }>("excerpt.get", { excerptId });
    if (!pageGuard.isCurrent(token)) return;
    if (!found.ok) { ctxRef.current.onError(found.error.code === "NOT_FOUND" ? ctxRef.current.t("research.excerpt.gone") : found.error.message); return; }
    await openPage(found.value.excerpt.pageId, excerptId);
  }, [openPage, pageGuard]);

  // An excerpt opened from the project's materials arrives as the tab's focus.
  const focusKey = ctx.focus?.kind === "excerpt" ? ctx.focus.id : null;
  useEffect(() => {
    if (!focusKey) return;
    void openExcerpt(focusKey).then(() => { if (pageGuard.isAlive()) ctxRef.current.onFocus(null); });
  }, [focusKey, openExcerpt, pageGuard]);

  /** A passage found by meaning opens where it is: an excerpt in this tab, anything else in the app. */
  function openHit(hit: SemanticHitView) {
    if (hit.kind === "excerpt" && hit.excerptId) { void openExcerpt(hit.excerptId); return; }
    ctx.onOpenHit?.(hit);
  }

  async function changed(select?: string) {
    setPagesVersion((value) => value + 1);
    await loadExcerpts();
    if (!pageGuard.isAlive()) return;
    if (select) await openExcerpt(select);
    else if (doc) await openPage(doc.page.id, focusId);
    if (pageGuard.isAlive()) ctx.reload();
  }

  async function fetched(outcome: FetchOutcome) {
    setPagesVersion((value) => value + 1);
    await openPage(outcome.page.id);
  }

  async function refetch() {
    if (!doc || refetching) return;
    setRefetching(true);
    const result = await attempt<FetchOutcome>("webpage.fetch", { url: doc.page.url });
    if (!pageGuard.isAlive()) return;
    setRefetching(false);
    if (!result.ok) { ctx.onError(result.error.message); return; }
    ctx.onNotice(result.value.created ? t("research.fetch.created", { title: result.value.page.title }) : result.value.changed ? t("research.fetch.changed", { title: result.value.page.title, version: result.value.page.version }) : t("research.fetch.same", { title: result.value.page.title }));
    setPagesVersion((value) => value + 1);
    await openPage(result.value.page.id);
    await loadExcerpts();
  }

  return (
    <div className="research-tab" data-testid="research-tab">
      <div className="research-side">
        {meaningOn ? (
          <div className="research-modes" role="radiogroup" aria-label={t("semantic.mode")} data-testid="research-modes">
            {(["keyword", "meaning"] as const).map((item) => (
              <label key={item} className="chip-check">
                <input type="radio" name="research-mode" data-testid={`research-mode-${item}`} checked={mode === item} onChange={() => setMode(item)} />
                <span>{t(`semantic.mode.${item}`)}</span>
              </label>
            ))}
          </div>
        ) : null}
        {meaningOn && mode === "meaning" ? (
          <SemanticPanel t={t} projectId={projectId} onOpen={openHit} onOpenSettings={ctx.onOpenSettings ? () => ctx.onOpenSettings!("semantic") : undefined} onError={ctx.onError} />
        ) : <SearchPanel t={t} formatDate={ctx.formatDate} projectId={projectId} onOpenMaterial={ctx.onOpenMaterial} onOpenExcerpt={(id) => void openExcerpt(id)} onOpenPage={(id) => void openPage(id)}
          onAdded={ctx.reload} onError={ctx.onError} onNotice={ctx.onNotice} />}
        <WebSearchPanel t={t} available={Boolean(ctx.webSearch)} onOpenSettings={ctx.onOpenSettings ? () => ctx.onOpenSettings!("models") : undefined} onFetched={(outcome) => void fetched(outcome)} onNotice={ctx.onNotice} />
        <PagesPanel t={t} formatDate={ctx.formatDate} version={pagesVersion} openId={doc?.page.id ?? null} onOpen={(id) => void openPage(id)} onFetched={(outcome) => void fetched(outcome)}
          onDeleted={(pageId) => { setPagesVersion((value) => value + 1); setDoc((current) => (current?.page.id === pageId ? null : current)); }} onError={ctx.onError} onNotice={ctx.onNotice} />
      </div>
      <div className="research-main">
        {doc ? (
          <PageReader key={doc.page.id} t={t} formatDate={ctx.formatDate} projectId={projectId} doc={doc} focusExcerptId={focusId} onOpenVersion={(id) => void openPage(id)} onRefetch={() => void refetch()} refetching={refetching}
            onSaved={() => void changed()} onError={ctx.onError} onNotice={ctx.onNotice} />
        ) : <p className="detail-muted research-empty" data-testid="research-reader-empty">{t("research.reader.empty")}</p>}
        <ExcerptList t={t} formatDate={ctx.formatDate} items={excerpts} focusId={focusId} onShow={(item) => void openPage(item.pageId, item.id)} onChanged={(select) => void changed(select)} onError={ctx.onError} onNotice={ctx.onNotice} />
      </div>
    </div>
  );
}
