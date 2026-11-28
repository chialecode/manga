import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, MoreHorizontal, Pencil, Play } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { AddToProject } from "../components/add-to-project.tsx";
import { Menu, type MenuItem } from "../components/menu.tsx";
import { useAsyncGuard } from "../hooks/use-async-guard.ts";
import { asArray, attempt } from "../lib/api.ts";
import { coverMeta, forgetCover, useCovers } from "../lib/covers.ts";
import { useWorkDetail, type CoverSummary } from "../lib/use-work-detail.ts";
import { SHELF_ORDER, formatContextPosition, percentOf, type Facets, type ProjectedField, type ShelfState, type WorkDetail, type WorkMediaKind } from "../lib/works.ts";
import { DeleteEntryDialog } from "./delete-entry-dialog.tsx";
import { MoveDialog } from "./move-resource-dialog.tsx";
import { ResourceContent } from "./resource-content.tsx";
import { CoverImage, progressLine, shelfLabel } from "./work-card.tsx";
import {
  WorkCoversSection,
  WorkOverviewTab,
  WorkRecordsTab,
  formatFieldValue,
  isSafeExternalUrl,
  type WorkCredits,
  type WorkCreditsState,
} from "./work-home-tabs.tsx";
import { MatchDialog, providerName } from "./work-match.tsx";

type T = Translator["t"];
export type WorkTab = "overview" | "records";

export const FIELD_ORDER = ["title", "titleOriginal", "author", "studio", "summary", "releaseDate", "platform", "episodeCount", "volumeCount", "tags"] as const;

/** Where a field's value came from, in the user's words, with the fetch time for online data. */
export function fieldSource(t: T, field: ProjectedField, formatDate: (value: string | Date) => string): string {
  switch (field.source) {
    case "online": return field.fetchedAt ? t("detail.source.online", { provider: providerName(field.providerId ?? "bangumi", t), time: formatDate(field.fetchedAt) }) : t("detail.source.onlineNoTime", { provider: providerName(field.providerId ?? "bangumi", t) });
    case "detached": return t("detail.source.detached", { provider: providerName(field.providerId ?? "bangumi", t) });
    case "file": return t("detail.source.file");
    case "filename": return t("detail.source.filename");
    case "user": return field.policy === "locked" ? t("detail.source.locked") : t("detail.source.user");
    default: return field.policy === "locked" ? t("detail.source.locked") : "";
  }
}

/**
 * One work's own page (A-47): hero header, the button that opens the file, the shelf state, matching, and two tabs separating
 * work info ("作品资料", Bangumi-style unified layout) from personal records ("我的记录"). Opening a card on a shelf lands here;
 * only "read" or "watch" opens a file. The profile is edited here too: every field is shown and can be filled, locked, or restored.
 */
export function WorkHome(props: {
  t: T;
  workId: string;
  facets: Facets;
  formatDate: (value: string | Date) => string;
  initialTab?: "cover" | "match";
  onBack: () => void;
  onOpenResource: (resourceId: string, kind: WorkMediaKind) => void;
  onOpenNote: (objectId: string) => void;
  onOpenWork: (workId: string) => void;
  onOpenRecording?: (sessionId: string) => void;
  /** A conversation made about one of the work's resources, opened where conversations are read. */
  onOpenConversation?: (sessionId: string) => void;
  /** Library paths are where resources come from; a resource imported on its own points the person there. */
  onAddPath?: () => void;
  /** The work's name and author once they are known, for the conversation beside the page (quick tasks fill them in). */
  onLoaded?: (work: { workId: string; title: string; author: string | null; mediaKind: string }) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  /** Current workspace context (`null` for "最近"), so "继续" resumes that context's own resource when it has one (A-96, A-129). */
  context?: string | null;
}) {
  const { t, formatDate } = props;
  const metadataOn = props.facets.has("metadata");
  const voiceOn = props.facets.has("voice");
  const state = useWorkDetail(props.workId, { metadata: metadataOn, voice: voiceOn });
  // Guard against stale detail from the previous workId during the render before useWorkDetail's reset effect commits.
  const detail = state.detail && state.detail.id === props.workId ? state.detail : null;
  const tabsId = useId();
  const [tab, setTab] = useState<WorkTab>("overview");
  const [editMode, setEditMode] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [coversOpen, setCoversOpen] = useState(props.initialTab === "cover");
  const [match, setMatch] = useState<null | "link" | "refresh">(props.initialTab === "match" ? "link" : null);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  /** The resource whose own page (what was made on it, and its file) is shown in place of the work's page (A-67). */
  const [viewing, setViewing] = useState<string | null>(null);
  const [credits, setCredits] = useState<WorkCreditsState>({ status: "idle" });
  const creditsGuard = useAsyncGuard();
  const prevWorkIdRef = useRef(props.workId);
  const tabRefs = useRef<Partial<Record<WorkTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (prevWorkIdRef.current === props.workId) return;
    prevWorkIdRef.current = props.workId;
    creditsGuard.invalidate();
    setTab("overview");
    setEditing(null);
    setEditMode(false);
    setViewing(null);
    setCoversOpen(props.initialTab === "cover");
    setMatch(props.initialTab === "match" ? "link" : null);
    setDeleting(false);
    setMoving(null);
    setCredits({ status: "idle" });
  }, [props.workId, props.initialTab, creditsGuard]);

  const loaded = props.onLoaded;
  useEffect(() => {
    if (detail && loaded) loaded({ workId: detail.id, title: detail.title, author: detail.author ?? null, mediaKind: detail.mediaKind });
  }, [detail?.id, detail?.title, detail?.author, detail?.mediaKind, loaded]);

  const coverIds = useMemo(() => state.covers?.covers.map((cover) => cover.id) ?? [], [state.covers]);
  const thumb = useCovers([detail?.coverId, ...coverIds], "detail");
  const linked = detail?.linkedSource ?? null;
  const linkedKey = linked ? `${linked.providerId}:${linked.externalId}:${linked.fetchedAt ?? ""}` : "";

  const loadCredits = useCallback(async () => {
    const token = creditsGuard.next();
    setCredits({ status: "loading" });
    const result = await attempt<Partial<WorkCredits>>("metadata.characters", { workId: props.workId });
    if (!creditsGuard.isCurrent(token)) return;
    if (!result.ok) {
      setCredits({ status: "error", error: result.error.message });
      return;
    }
    const raw = result.value ?? {};
    const characters = asArray<WorkCredits["characters"][number]>(raw.characters).map((item) => ({
      ...item,
      actors: asArray<{ id: string; name: string }>(item.actors),
    }));
    const persons = asArray<WorkCredits["persons"][number]>(raw.persons).map((item) => ({
      ...item,
      career: asArray<string>(item.career),
    }));
    const avatarLimit = typeof raw.avatarLimit === "number" && Number.isFinite(raw.avatarLimit) ? raw.avatarLimit : 20;
    setCredits({
      status: "ready",
      value: { source: raw.source ?? null, characters, persons, avatarLimit },
    });
  }, [props.workId, creditsGuard]);

  // Load characters & staff eagerly for linked works so the unified overview displays them without extra tab clicks.
  useEffect(() => {
    if (!metadataOn || !linkedKey) {
      creditsGuard.invalidate();
      setCredits({ status: "idle" });
      return;
    }
    void loadCredits();
  }, [metadataOn, linkedKey, loadCredits, creditsGuard]);

  async function act(commandId: string, input: unknown): Promise<boolean> {
    const result = await attempt(commandId, input);
    if (!creditsGuard.isAlive()) return false;
    if (!result.ok) { props.onError(result.error.message); return false; }
    return true;
  }
  async function changed(): Promise<WorkDetail | null> { const next = await state.reload(); props.onChanged(); return next; }

  async function chooseCover(cover: CoverSummary) { if (await act("covers.select", { workId: props.workId, coverId: cover.id })) { forgetCover(cover.id); await changed(); } }
  async function lockCover() { if (await act("covers.lock", { workId: props.workId, locked: state.covers?.state !== "locked" })) await changed(); }
  async function coverFromFile() {
    if (!window.manga.pick) return;
    const picked = await window.manga.pick({ mode: "file", filter: "image" });
    if (picked && await act("covers.fromImage", { workId: props.workId, pathHandle: picked.pathHandle })) await changed();
  }
  async function setShelf(next: ShelfState) { if (await act("works.setShelf", { workId: props.workId, state: next })) await changed(); }

  async function saveField(key: string) {
    if (!detail) return;
    const override = detail.override;
    const value: string | string[] = key === "tags" ? draft.split(/[,，、]/).map((item) => item.trim()).filter(Boolean) : draft.trim();
    const fields = { ...override.fields, [key]: value };
    if (await act("works.setOverride", { workId: props.workId, fields, locked: override.locked, cleared: override.cleared.filter((item) => item !== key) })) { setEditing(null); await changed(); }
  }
  async function resetField(key: string) {
    if (!detail) return;
    const { [key]: _removed, ...fields } = detail.override.fields;
    if (await act("works.setOverride", { workId: props.workId, fields, locked: detail.override.locked.filter((item) => item !== key), cleared: detail.override.cleared.filter((item) => item !== key) })) await changed();
  }
  async function toggleLock(key: string) {
    if (!detail) return;
    const lockedField = detail.override.locked.includes(key);
    const next = lockedField ? detail.override.locked.filter((item) => item !== key) : [...detail.override.locked, key];
    if (await act("works.setOverride", { workId: props.workId, fields: detail.override.fields, locked: next, cleared: detail.override.cleared })) await changed();
  }
  async function unlink() {
    if (!detail?.linkedSource) return;
    if (await act("metadata.unlink", { workId: props.workId, providerId: detail.linkedSource.providerId })) { props.onNotice(t("match.unlinked.done")); await changed(); }
  }

  const external = (url: string) => { if (isSafeExternalUrl(url)) void window.manga.openExternal?.(url); };
  const kind = (detail?.mediaKind === "comic" || detail?.mediaKind === "video" ? detail.mediaKind : "novel") as WorkMediaKind;
  // "继续" goes to a resource that can be opened: the current context's own resource when it has one (A-96), else the last one opened, else the first (A-113).
  const openable = (row: { available?: boolean; outside?: boolean }) => row.available !== false && row.outside !== true;
  const ownContextResourceId = props.context !== undefined && detail?.contextPositions
    ? detail.contextPositions.find((entry) => (entry.contextId ?? null) === (props.context ?? null) && detail.resources.some((row) => row.id === entry.resourceId && openable(row)))?.resourceId ?? null
    : null;
  const target = detail
    ? (ownContextResourceId
      ?? (detail.lastResource && detail.resources.find((row) => row.id === detail.lastResource!.id && openable(row)) ? detail.lastResource.id : detail.resources.find(openable)?.id ?? null))
    : null;
  const completed = detail ? (detail.progressCompleted === true || (detail.resourceCount > 0 && detail.finishedCount >= detail.resourceCount)) : false;
  const percent = detail ? (completed ? 100 : percentOf(detail.progress)) : 0;
  const verb = kind === "video" ? t("work.watch") : t("work.read");
  const readLabel = detail && percent > 0 && detail.lastResource
    ? (kind === "video" ? t("work.continueWatch", { place: progressLine(t, detail) || `${percent}%` }) : t("work.continueRead", { place: progressLine(t, detail) || `${percent}%` }))
    : verb;

  const titleOriginal = detail ? formatFieldValue(detail.fields.titleOriginal?.value ?? null).trim() : "";
  const showSubtitle = Boolean(detail && titleOriginal && titleOriginal !== detail.title.trim());

  const ratingScore = linked?.rating?.score;
  const hasRating = typeof ratingScore === "number" && Number.isFinite(ratingScore) && ratingScore > 0;
  const scoreText = hasRating ? ratingScore.toFixed(1) : "";
  const ratingTotal = linked?.rating?.total;
  const ratingRank = linked?.rating?.rank;

  const detailCoverMeta = coverMeta(detail?.coverId, "detail");
  const coverLandscape = kind === "video" && !linked && Boolean(detailCoverMeta && detailCoverMeta.width > detailCoverMeta.height);
  const detailCoverStyle = !coverLandscape && detailCoverMeta && detailCoverMeta.width > 0 && detailCoverMeta.height > 0
    ? { aspectRatio: `${detailCoverMeta.width} / ${detailCoverMeta.height}` }
    : undefined;

  const linkMenu: MenuItem[] = linked ? [
    { id: "refresh", label: t("match.refresh"), onSelect: () => setMatch("refresh") },
    { id: "change", label: t("match.change"), onSelect: () => setMatch("link") },
    { id: "unlink", label: t("match.unlink"), onSelect: () => void unlink() },
    ...(isSafeExternalUrl(linked.sourceUrl) ? [{ id: "open", label: t("match.openBrowser"), onSelect: () => external(linked.sourceUrl!) }] : []),
  ] : [];
  const moreMenu: MenuItem[] = [
    { id: "cover", label: t("card.cover"), onSelect: () => setCoversOpen((open) => !open) },
    { id: "delete", label: t("entry.delete"), danger: true, onSelect: () => setDeleting(true) },
  ];

  const tabs: Array<{ id: WorkTab; label: string }> = [
    { id: "overview", label: t("work.tab.overview") },
    { id: "records", label: t("work.tab.records") },
  ];

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex = -1;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex]!.id;
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  function toggleEditMode() {
    setEditMode((value) => !value);
    setEditing(null);
    setTab("overview");
  }

  if (viewing) {
    return (
      <div className="work-home page-pad" data-testid="page-work" data-view="resource">
        <ResourceContent
          t={t}
          resourceId={viewing}
          formatDate={formatDate}
          onBack={() => { setViewing(null); void state.reload(); }}
          onOpenNote={props.onOpenNote}
          onOpenRecording={voiceOn ? props.onOpenRecording : undefined}
          onOpenConversation={props.onOpenConversation}
          onOpenResource={(resourceId) => props.onOpenResource(resourceId, kind)}
          onError={props.onError}
          onNotice={props.onNotice}
        />
      </div>
    );
  }

  return (
    <div className="work-home page-pad" data-testid="page-work">
      <button type="button" className="link-button work-back" data-testid="work-back" onClick={props.onBack}><ArrowLeft size={14} />{detail ? t("work.back", { name: t(`shelf.title.${kind}` as "shelf.title.novel") }) : t("common.back")}</button>
      {state.status === "loading" ? <p role="status" data-testid="detail-loading">{t("status.loading")}</p> : null}
      {state.status === "error" ? <p role="alert" className="shelf-error" data-testid="detail-error">{state.error}</p> : null}
      {detail ? (
        <>
          <header className="detail-head work-head">
            <div className={`detail-cover ${coverLandscape ? "is-landscape" : ""}`} style={detailCoverStyle}>
              <CoverImage url={thumb(detail.coverId)} coverId={detail.coverId} kind={detail.mediaKind} title={detail.title} landscape={coverLandscape} />
            </div>
            <div className="detail-meta">
              <div className="work-head-top">
                <div className="work-head-titles">
                  <h1 data-testid="detail-title">{detail.title}</h1>
                  {showSubtitle ? <p className="detail-muted work-subtitle" data-testid="detail-subtitle">{titleOriginal}</p> : null}
                  <p className="detail-muted" data-testid="work-facts">
                    {[detail.author ?? formatFieldValue(detail.fields.studio?.value ?? null), t(`shelf.kind.${kind}` as "shelf.kind.novel"), formatFieldValue(detail.fields.releaseDate?.value ?? null).slice(0, 4), detail.fields.episodeCount?.value ? t(`work.episodes.${kind}` as "work.episodes.video", { count: Number(detail.fields.episodeCount.value) }) : detail.resourceCount > 0 ? t("work.files", { count: detail.resourceCount }) : ""].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {hasRating ? (
                  <div
                    className="work-rating-card"
                    data-testid="work-rating"
                    title={t("work.rating", { score: scoreText, provider: providerName(linked!.providerId, t), time: linked!.fetchedAt ? formatDate(linked!.fetchedAt) : "—" })}
                  >
                    <div className="work-rating-score-row">
                      <span className="work-rating-score" data-testid="work-rating-score">{scoreText}</span>
                      {typeof ratingRank === "number" && ratingRank > 0 ? (
                        <span className="work-rating-rank" data-testid="work-rating-rank">{t("work.rating.rank", { rank: ratingRank })}</span>
                      ) : null}
                    </div>
                    <div className="work-rating-meta">
                      <span className="work-rating-provider">{providerName(linked!.providerId, t)}</span>
                      {typeof ratingTotal === "number" && ratingTotal > 0 ? (
                        <span className="work-rating-votes" data-testid="work-rating-votes">{t("work.rating.votes", { count: ratingTotal })}</span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
              {formatFieldValue(detail.fields.tags?.value ?? null) ? <p className="work-tags" data-testid="work-tags">{asArray<string>(detail.fields.tags?.value).slice(0, 12).map((tag) => <span key={tag} className="chip">{tag}</span>)}</p> : null}
              {completed || percent > 0 ? (
                <div className="work-progress-block" data-testid="work-progress-summary">
                  <p className="work-progress-text">
                    <span className="work-progress-label">{completed ? shelfLabel(t, "finished", kind) : t(kind === "video" ? "card.watched" : "card.read", { percent })}</span>
                    {detail.progressContext ? <span className="work-origin" data-testid="work-progress-origin">{t("card.origin", { name: detail.progressContext.name })}</span> : null}
                  </p>
                  {detail.contextPositions && detail.contextPositions.length > 0 ? (
                    <p className="detail-muted work-context-positions" data-testid="work-context-positions">
                      {detail.contextPositions.map((entry) => formatContextPosition(t, entry, kind, detail.resources.length > 1)).join(" · ")}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="detail-actions work-actions">
                <button type="button" className="primary-button" data-testid="work-read" disabled={!target} onClick={() => target && props.onOpenResource(target, kind)}><Play size={14} />{readLabel}</button>
                <label className="detail-shelf">
                  <span>{t("card.setShelf")}</span>
                  <select data-testid="detail-shelf" value={detail.shelf} onChange={(event) => void setShelf(event.target.value as ShelfState)}>
                    <option value="none">{shelfLabel(t, "none", kind)}</option>
                    {SHELF_ORDER.map((item) => <option key={item} value={item}>{shelfLabel(t, item, kind)}</option>)}
                  </select>
                </label>
                {metadataOn ? (
                  linked
                    ? <span className="work-linked"><button type="button" className="secondary-button" data-testid="detail-match" onClick={() => setMatch("link")}>{t("match.linkedTag", { id: linked.externalId })}</button><Menu label={t("match.menu")} testId="work-link-menu" align="end" trigger={<MoreHorizontal size={15} />} items={linkMenu} /></span>
                    : <button type="button" className="secondary-button" data-testid="detail-match" onClick={() => setMatch("link")}>{t("detail.matchAction")}</button>
                ) : null}
                <button type="button" className="secondary-button" data-testid="detail-edit" aria-pressed={editMode} onClick={toggleEditMode}><Pencil size={14} />{editMode ? t("work.editDone") : t("work.edit")}</button>
                {props.facets.has("projects") ? <AddToProject t={t} kind="work" targetId={props.workId} label={detail.title} onError={props.onError} onNotice={props.onNotice} /> : null}
                <Menu label={t("work.more")} testId="work-more" align="end" trigger={<MoreHorizontal size={16} />} items={moreMenu} />
              </div>
              {detail.versions && detail.versions.length > 1 ? (
                <label className="detail-shelf work-versions" data-testid="work-versions" title={t("work.versionHint")}>
                  <span>{t("work.versions")}</span>
                  <select data-testid="work-version" value={props.workId} onChange={(event) => { if (event.target.value !== props.workId) props.onOpenWork(event.target.value); }}>
                    {detail.versions.map((version) => <option key={version.workId} value={version.workId}>{t("work.versionOption", { title: version.label, count: version.resourceCount })}</option>)}
                  </select>
                </label>
              ) : null}
              {!target ? <p className="detail-muted" data-testid="work-no-resource">{detail.resources.length ? t("work.noneAvailable") : t("work.noResourcesKept")}</p> : null}
              {detail.outsideCount > 0 ? (
                <p className="detail-muted" data-testid="work-outside"><span className="chip chip-muted">{t("work.outside")}</span> {t("work.outsideHint", { count: detail.outsideCount })}{props.onAddPath ? <> <button type="button" className="link-button" data-testid="work-outside-add" onClick={props.onAddPath}>{t("work.outsideAdd")}</button></> : null}</p>
              ) : null}
            </div>
          </header>

          {coversOpen ? (
            <WorkCoversSection t={t} covers={state.covers} coverId={detail.coverId} thumb={thumb} onChoose={(cover) => void chooseCover(cover)} onFromFile={() => void coverFromFile()} onLock={() => void lockCover()} />
          ) : null}

          <div role="tablist" className="shelf-tabs detail-tabs" aria-label={t("detail.tabs")}>
            {tabs.map((item, index) => (
              <button
                key={item.id}
                ref={(node) => { tabRefs.current[item.id] = node; }}
                id={`${tabsId}-tab-${item.id}`}
                type="button"
                role="tab"
                tabIndex={tab === item.id ? 0 : -1}
                aria-selected={tab === item.id}
                aria-controls={`${tabsId}-panel-${item.id}`}
                data-testid={`detail-tab-${item.id}`}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`} className="work-tab-panel">
            {tab === "overview" ? (
              <WorkOverviewTab
                key={detail.id}
                t={t}
                detail={detail}
                kind={kind}
                verb={verb}
                metadataOn={metadataOn}
                showSubtitleInHeader={showSubtitle}
                fieldOrder={FIELD_ORDER}
                fieldSource={fieldSource}
                formatDate={formatDate}
                editMode={editMode}
                editing={editing}
                draft={draft}
                credits={credits}
                related={state.related}
                relatedStatus={state.relatedStatus}
                onToggleEdit={toggleEditMode}
                onStartEdit={(key, value) => { setEditing(key); setDraft(value); }}
                onCancelEdit={() => setEditing(null)}
                onDraft={setDraft}
                onSaveField={(key) => void saveField(key)}
                onToggleLock={(key) => void toggleLock(key)}
                onResetField={(key) => void resetField(key)}
                onOpenResource={(resourceId) => props.onOpenResource(resourceId, kind)}
                onViewResource={setViewing}
                onMoveResource={setMoving}
                onRefreshCredits={() => setMatch("refresh")}
                onOpenWork={props.onOpenWork}
                onOpenExternal={external}
              />
            ) : (
              <WorkRecordsTab
                t={t}
                workId={props.workId}
                folderVersion={`${linkedKey}:${detail.resources.length}`}
                voiceOn={voiceOn}
                notes={state.notes}
                captures={state.captures}
                formatDate={formatDate}
                onOpenNote={props.onOpenNote}
                onOpenRecording={props.onOpenRecording}
                onError={props.onError}
                onNotice={props.onNotice}
                onChanged={() => { void state.reload(); props.onChanged(); }}
              />
            )}
          </div>

          {match ? (
            <MatchDialog
              t={t}
              detail={detail}
              refresh={match === "refresh"}
              formatDate={formatDate}
              onClose={() => setMatch(null)}
              onOpenExternal={external}
              onError={props.onError}
              onApplied={(message) => {
                const prevKey = linkedKey;
                setMatch(null);
                props.onNotice(message);
                void changed().then((next) => {
                  const nextLinked = next?.linkedSource ?? null;
                  const nextKey = nextLinked ? `${nextLinked.providerId}:${nextLinked.externalId}:${nextLinked.fetchedAt ?? ""}` : "";
                  if (metadataOn && nextKey && nextKey === prevKey) void loadCredits();
                });
              }}
            />
          ) : null}
          {deleting ? (
            <DeleteEntryDialog
              t={t}
              workId={props.workId}
              title={detail.title}
              onClose={() => setDeleting(false)}
              onError={props.onError}
              onDeleted={(result) => { setDeleting(false); props.onNotice(t("entry.delete.done", { title: result.title, count: result.resourceCount })); props.onChanged(); props.onBack(); }}
            />
          ) : null}
          {moving ? (
            <MoveDialog t={t} resourceId={moving} fromWorkId={props.workId} kind={kind} onClose={() => setMoving(null)} onError={props.onError} onMoved={() => { setMoving(null); props.onNotice(t("work.move.done")); void changed(); }} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
