import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, Lock, LockOpen, MoreHorizontal, Pencil, Play, RefreshCw, Replace } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Menu, type MenuItem } from "../components/menu.tsx";
import { Modal } from "../components/modal.tsx";
import { asArray, attempt } from "../lib/api.ts";
import { forgetCover, useCovers } from "../lib/covers.ts";
import { useWorkDetail, type CoverSummary } from "../lib/use-work-detail.ts";
import { SHELF_ORDER, percentOf, type Facets, type ProjectedField, type ShelfState, type WorkMediaKind, type WorkSummary } from "../lib/works.ts";
import { CoverImage, progressLine, shelfLabel } from "./work-card.tsx";
import { MatchDialog, providerName } from "./work-match.tsx";

type T = Translator["t"];
export type WorkTab = "overview" | "resources" | "characters" | "staff" | "records" | "related";

export const FIELD_ORDER = ["title", "titleOriginal", "author", "studio", "summary", "releaseDate", "platform", "episodeCount", "volumeCount", "tags"] as const;
const EDITABLE = new Set(["title", "titleOriginal", "author", "studio", "summary", "releaseDate", "platform", "tags"]);

const formatValue = (value: ProjectedField["value"]): string => (Array.isArray(value) ? value.join("、") : value === null || value === undefined ? "" : String(value));
const emptyField = (): ProjectedField => ({ value: null, source: null, policy: "none", candidates: [] });

/** Where a field's value came from, in the user's words, with the fetch time for online data. */
export function fieldSource(t: T, field: ProjectedField, formatDate: (value: string | Date) => string): string {
  switch (field.source) {
    case "online": return field.fetchedAt ? t("detail.source.online", { provider: providerName(field.providerId ?? "bangumi"), time: formatDate(field.fetchedAt) }) : t("detail.source.onlineNoTime", { provider: providerName(field.providerId ?? "bangumi") });
    case "detached": return t("detail.source.detached", { provider: providerName(field.providerId ?? "bangumi") });
    case "file": return t("detail.source.file");
    case "filename": return t("detail.source.filename");
    case "user": return field.policy === "locked" ? t("detail.source.locked") : t("detail.source.user");
    default: return field.policy === "locked" ? t("detail.source.locked") : "";
  }
}

type Credit = { id: string; name: string; relation: string; avatar: { url: string } | null };
type Character = Credit & { summary: string; actors: Array<{ id: string; name: string }> };
type Person = Credit & { career: string[]; episodes: string };
type Credits = { source: { providerId: string; fetchedAt: string | null } | null; characters: Character[]; persons: Person[]; avatarLimit: number };

function Avatar(props: { url?: string; name: string }) {
  return <span className="credit-avatar" aria-hidden="true">{props.url ? <img src={props.url} alt="" loading="lazy" width={44} height={44} /> : <span>{[...props.name][0] ?? ""}</span>}</span>;
}

/** Moving a file to another work, or to a new one named here: the work is the unit, so a file filed under the wrong work can be put right. */
function MoveDialog(props: { t: T; resourceId: string; fromWorkId: string; kind: WorkMediaKind; onClose: () => void; onMoved: () => void; onError: (message: string) => void }) {
  const { t } = props;
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<WorkSummary[]>([]);
  const [title, setTitle] = useState("");
  useEffect(() => {
    let cancelled = false;
    void attempt<{ items: WorkSummary[] }>("works.list", { kind: props.kind, limit: 20, ...(query.trim() ? { query: query.trim() } : {}) }).then((result) => {
      if (!cancelled && result.ok) setRows(asArray<WorkSummary>(result.value.items).filter((work) => work.id !== props.fromWorkId));
    });
    return () => { cancelled = true; };
  }, [query, props.kind, props.fromWorkId]);

  async function move(input: { toWorkId?: string; newWorkTitle?: string }) {
    const result = await attempt("works.moveResource", { resourceId: props.resourceId, ...input });
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onMoved();
  }

  return (
    <Modal variant="dialog" testId="work-move" title={t("work.move.title")} closeLabel={t("common.close")} onClose={props.onClose}>
      <label className="search-box"><input data-testid="work-move-query" value={query} placeholder={t("work.move.search")} aria-label={t("work.move.search")} onChange={(event) => setQuery(event.target.value)} /></label>
      <ul className="detail-list" data-testid="work-move-list">
        {rows.map((work) => <li key={work.id}><button type="button" className="link-button" data-testid={`work-move-to-${work.id}`} onClick={() => void move({ toWorkId: work.id })}>{work.title}</button></li>)}
        {rows.length === 0 ? <li className="detail-muted">{t("work.move.none")}</li> : null}
      </ul>
      <form className="match-search" onSubmit={(event) => { event.preventDefault(); if (title.trim()) void move({ newWorkTitle: title.trim() }); }}>
        <input data-testid="work-move-new" value={title} placeholder={t("work.move.newPlaceholder")} aria-label={t("work.move.newPlaceholder")} onChange={(event) => setTitle(event.target.value)} />
        <button type="submit" className="secondary-button" data-testid="work-move-new-go" disabled={!title.trim()}>{t("work.move.newGo")}</button>
      </form>
    </Modal>
  );
}

/**
 * One work's own page (A-47): head, the button that opens the file, the shelf state, matching, and the tabs. Opening a card on a
 * shelf lands here; only "read" or "watch" opens a file. The profile is edited here too: every field is shown and can be filled,
 * locked, or restored to what the source says.
 */
export function WorkHome(props: {
  t: T;
  workId: string;
  facets: Facets;
  formatDate: (value: string | Date) => string;
  initialTab?: "cover";
  onBack: () => void;
  onOpenResource: (resourceId: string, kind: WorkMediaKind) => void;
  onOpenNote: (objectId: string) => void;
  onOpenWork: (workId: string) => void;
  onOpenRecording?: (sessionId: string) => void;
  /** The work's name and author once they are known, for the conversation beside the page (quick tasks fill them in). */
  onLoaded?: (work: { workId: string; title: string; author: string | null; mediaKind: string }) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t, formatDate } = props;
  const metadataOn = props.facets.has("metadata");
  const voiceOn = props.facets.has("voice");
  const state = useWorkDetail(props.workId, { metadata: metadataOn, voice: voiceOn });
  const { detail } = state;
  const [tab, setTab] = useState<WorkTab>("overview");
  const [editMode, setEditMode] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [coversOpen, setCoversOpen] = useState(props.initialTab === "cover");
  const [match, setMatch] = useState<null | "link" | "refresh">(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [credits, setCredits] = useState<{ status: "idle" | "loading" | "ready" | "error"; value?: Credits; error?: string }>({ status: "idle" });

  useEffect(() => { setTab("overview"); setEditing(null); setEditMode(false); setCredits({ status: "idle" }); }, [props.workId]);

  const loaded = props.onLoaded;
  useEffect(() => {
    if (detail && loaded) loaded({ workId: detail.id, title: detail.title, author: detail.author ?? null, mediaKind: detail.mediaKind });
  }, [detail?.id, detail?.title, detail?.author, detail?.mediaKind, loaded]);

  const coverIds = useMemo(() => state.covers?.covers.map((cover) => cover.id) ?? [], [state.covers]);
  const thumb = useCovers([detail?.coverId, ...coverIds], "detail");
  const linkedKey = detail?.linkedSource ? `${detail.linkedSource.providerId}:${detail.linkedSource.externalId}:${detail.linkedSource.fetchedAt}` : "";

  const loadCredits = useCallback(async () => {
    setCredits({ status: "loading" });
    const result = await attempt<Credits>("metadata.characters", { workId: props.workId });
    setCredits(result.ok ? { status: "ready", value: result.value } : { status: "error", error: result.error.message });
  }, [props.workId]);
  useEffect(() => { if ((tab === "characters" || tab === "staff") && metadataOn) void loadCredits(); }, [tab, metadataOn, loadCredits, linkedKey]);

  async function act(commandId: string, input: unknown): Promise<boolean> {
    const result = await attempt(commandId, input);
    if (!result.ok) { props.onError(result.error.message); return false; }
    return true;
  }
  async function changed() { await state.reload(); props.onChanged(); }

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
    const locked = detail.override.locked.includes(key);
    const next = locked ? detail.override.locked.filter((item) => item !== key) : [...detail.override.locked, key];
    if (await act("works.setOverride", { workId: props.workId, fields: detail.override.fields, locked: next, cleared: detail.override.cleared })) await changed();
  }
  async function unlink() {
    if (!detail?.linkedSource) return;
    if (await act("metadata.unlink", { workId: props.workId, providerId: detail.linkedSource.providerId })) { props.onNotice(t("match.unlinked.done")); await changed(); }
  }

  const external = (url: string) => { void window.manga.openExternal?.(url); };
  const kind = (detail?.mediaKind === "comic" || detail?.mediaKind === "video" ? detail.mediaKind : "novel") as WorkMediaKind;
  const target = detail ? (detail.lastResource && detail.resources.find((row) => row.id === detail.lastResource!.id && row.available) ? detail.lastResource.id : detail.resources.find((row) => row.available)?.id ?? null) : null;
  const percent = detail ? percentOf(detail.progress) : 0;
  const verb = kind === "video" ? t("work.watch") : t("work.read");
  const readLabel = detail && percent > 0 && detail.lastResource
    ? (kind === "video" ? t("work.continueWatch", { place: progressLine(t, detail) || `${percent}%` }) : t("work.continueRead", { place: progressLine(t, detail) || `${percent}%` }))
    : verb;
  const linked = detail?.linkedSource ?? null;
  const rating = linked?.rating?.score;

  const linkMenu: MenuItem[] = linked ? [
    { id: "refresh", label: t("match.refresh"), onSelect: () => setMatch("refresh") },
    { id: "change", label: t("match.change"), onSelect: () => setMatch("link") },
    { id: "unlink", label: t("match.unlink"), onSelect: () => void unlink() },
    ...(linked.sourceUrl ? [{ id: "open", label: t("match.openBrowser"), onSelect: () => external(linked.sourceUrl!) }] : []),
  ] : [];
  const moreMenu: MenuItem[] = [{ id: "cover", label: t("card.cover"), onSelect: () => setCoversOpen((open) => !open) }];

  const tabs: Array<{ id: WorkTab; label: string; show: boolean }> = [
    { id: "overview", label: t("work.tab.overview"), show: true },
    { id: "resources", label: t("work.tab.resources"), show: true },
    { id: "characters", label: t("work.tab.characters"), show: metadataOn },
    { id: "staff", label: t("work.tab.staff"), show: metadataOn },
    { id: "records", label: t("work.tab.records"), show: true },
    { id: "related", label: t("work.tab.related"), show: metadataOn },
  ];

  return (
    <div className="work-home page-pad" data-testid="page-work">
      <button type="button" className="link-button work-back" data-testid="work-back" onClick={props.onBack}><ArrowLeft size={14} />{t("work.back")}</button>
      {state.status === "loading" ? <p role="status" data-testid="detail-loading">{t("status.loading")}</p> : null}
      {state.status === "error" ? <p role="alert" className="shelf-error" data-testid="detail-error">{state.error}</p> : null}
      {detail ? (
        <>
          <header className="detail-head work-head">
            <div className={`detail-cover ${kind === "video" ? "is-landscape" : ""}`}>
              <CoverImage url={thumb(detail.coverId)} coverId={detail.coverId} kind={detail.mediaKind} title={detail.title} landscape={kind === "video"} />
            </div>
            <div className="detail-meta">
              <h1 data-testid="detail-title">{detail.title}</h1>
              {detail.originalTitle && detail.originalTitle !== detail.title ? <p className="detail-muted">{detail.originalTitle}</p> : null}
              <p className="detail-muted" data-testid="work-facts">
                {[detail.author ?? formatValue(detail.fields.studio?.value ?? null), t(`shelf.kind.${kind}` as "shelf.kind.novel"), formatValue(detail.fields.releaseDate?.value ?? null).slice(0, 4), detail.fields.episodeCount?.value ? t("work.episodes", { count: Number(detail.fields.episodeCount.value) }) : detail.resourceCount > 0 ? t("work.files", { count: detail.resourceCount }) : ""].filter(Boolean).join(" · ")}
              </p>
              {rating ? <p className="detail-muted" data-testid="work-rating">{t("work.rating", { score: rating, provider: providerName(linked!.providerId), time: linked!.fetchedAt ? formatDate(linked!.fetchedAt) : "—" })}</p> : null}
              {formatValue(detail.fields.tags?.value ?? null) ? <p className="work-tags" data-testid="work-tags">{asArray<string>(detail.fields.tags?.value).slice(0, 12).map((tag) => <span key={tag} className="chip">{tag}</span>)}</p> : null}
              <div className="detail-actions work-actions">
                <button type="button" className="primary-button" data-testid="work-read" disabled={!target} onClick={() => target && props.onOpenResource(target, kind)}><Play size={14} />{readLabel}</button>
                <label className="detail-shelf">
                  <span>{t("card.setShelf")}</span>
                  <select data-testid="detail-shelf" value={detail.shelf} onChange={(event) => void setShelf(event.target.value as ShelfState)}>
                    <option value="none">{shelfLabel(t, "none")}</option>
                    {SHELF_ORDER.map((item) => <option key={item} value={item}>{shelfLabel(t, item)}</option>)}
                  </select>
                </label>
                {metadataOn ? (
                  linked
                    ? <span className="work-linked"><button type="button" className="secondary-button" data-testid="detail-match" onClick={() => setMatch("link")}>{t("match.linkedTag", { id: linked.externalId })}</button><Menu label={t("match.menu")} testId="work-link-menu" align="end" trigger={<MoreHorizontal size={15} />} items={linkMenu} /></span>
                    : <button type="button" className="secondary-button" data-testid="detail-match" onClick={() => setMatch("link")}>{t("detail.matchAction")}</button>
                ) : null}
                <button type="button" className="secondary-button" data-testid="detail-edit" aria-pressed={editMode} onClick={() => { setEditMode((value) => !value); setEditing(null); setTab("overview"); }}><Pencil size={14} />{editMode ? t("work.editDone") : t("work.edit")}</button>
                <Menu label={t("work.more")} testId="work-more" align="end" trigger={<MoreHorizontal size={16} />} items={moreMenu} />
              </div>
              {!target ? <p className="detail-muted" data-testid="work-no-resource">{detail.resources.length ? t("work.noneAvailable") : t("work.noResources")}</p> : null}
            </div>
          </header>

          {coversOpen ? (
            <section className="detail-section" data-testid="detail-covers">
              <h3>{t("detail.covers")}</h3>
              <ul className="cover-strip">
                {(state.covers?.covers ?? []).map((cover) => (
                  <li key={cover.id}>
                    <button type="button" className="cover-choice" data-testid={`cover-${cover.id}`} aria-pressed={cover.selected} onClick={() => void chooseCover(cover)}>
                      {thumb(cover.id) ? <img src={thumb(cover.id)} alt="" loading="lazy" /> : <span className="cover-placeholder" />}
                      <span>{t(`detail.coverSource.${cover.source}` as "detail.coverSource.file")}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {(state.covers?.covers.length ?? 0) === 0 ? <p className="detail-muted">{t("detail.coversNone")}</p> : null}
              <div className="detail-actions">
                <button type="button" className="secondary-button" data-testid="cover-from-file" onClick={() => void coverFromFile()}>{t("detail.coverFromFile")}</button>
                <button type="button" className="secondary-button" data-testid="cover-lock" aria-pressed={state.covers?.state === "locked"} disabled={!detail.coverId} onClick={() => void lockCover()}>
                  {state.covers?.state === "locked" ? <><LockOpen size={14} />{t("detail.coverUnlock")}</> : <><Lock size={14} />{t("detail.coverLock")}</>}
                </button>
              </div>
              <p className="detail-muted">{t("detail.coverLockHint")}</p>
            </section>
          ) : null}

          <div role="tablist" className="shelf-tabs detail-tabs" aria-label={t("detail.tabs")}>
            {tabs.filter((item) => item.show).map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} data-testid={`detail-tab-${item.id}`} onClick={() => setTab(item.id)}>{item.label}</button>
            ))}
          </div>

          {tab === "overview" ? (
            <section className="detail-section" data-testid="detail-fields" data-editing={editMode ? "true" : "false"}>
              <dl className="detail-fields">
                {FIELD_ORDER.map((key) => {
                  const field = detail.fields[key] ?? emptyField();
                  const lockedField = detail.override.locked.includes(key);
                  const empty = field.value === null || formatValue(field.value) === "";
                  // Reading shows what there is. Editing shows every field, including the empty ones, so a blank can be filled.
                  if (!editMode && empty && !lockedField) return null;
                  const editable = EDITABLE.has(key);
                  return (
                    <div key={key} className="detail-field" data-testid={`field-${key}`}>
                      <dt>{t(`detail.field.${key}` as "detail.field.title")}</dt>
                      <dd>
                        {editing === key ? (
                          <form className="field-edit" onSubmit={(event) => { event.preventDefault(); void saveField(key); }}>
                            {key === "summary" ? <textarea data-testid={`field-input-${key}`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={5} autoFocus /> : <input data-testid={`field-input-${key}`} value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus />}
                            <button type="submit" className="primary-button" data-testid={`field-save-${key}`}>{t("common.save")}</button>
                            <button type="button" className="secondary-button" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
                          </form>
                        ) : (
                          <>
                            <span className={key === "summary" ? "field-summary" : undefined}>{formatValue(field.value) || t("detail.fieldEmpty")}</span>
                            <span className="detail-source" data-testid={`field-source-${key}`}>{fieldSource(t, field, formatDate)}</span>
                            {editMode && editable ? (
                              <span className="field-tools">
                                <button type="button" className="link-button" data-testid={`field-edit-${key}`} onClick={() => { setEditing(key); setDraft(formatValue(field.value)); }}>{empty ? t("work.fill") : t("common.edit")}</button>
                                <button type="button" className="link-button" data-testid={`field-lock-${key}`} aria-pressed={lockedField} onClick={() => void toggleLock(key)}>{lockedField ? t("detail.unlockField") : t("detail.lockField")}</button>
                                {field.source === "user" || lockedField || key in detail.override.fields ? <button type="button" className="link-button" data-testid={`field-reset-${key}`} onClick={() => void resetField(key)}>{t("detail.resetField")}</button> : null}
                              </span>
                            ) : null}
                          </>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {linked ? (
                <p className="detail-muted" data-testid="detail-source-line">
                  {t("detail.sourceLine", { provider: providerName(linked.providerId), time: linked.fetchedAt ? formatDate(linked.fetchedAt) : "—" })}
                  {linked.sourceUrl ? <button type="button" className="link-button" data-testid="detail-open-page" onClick={() => external(linked.sourceUrl!)}>{t("match.openPage")}<ExternalLink size={12} /></button> : null}
                </p>
              ) : null}
            </section>
          ) : null}

          {tab === "resources" ? (
            <section className="detail-section" data-testid="detail-resources">
              {detail.resources.length === 0 ? <p className="detail-muted">{t("detail.resourcesNone")}</p> : (
                <ul className="resource-list">
                  {detail.resources.map((resource) => (
                    <li key={resource.id} className="resource-row" data-testid={`detail-resource-${resource.id}`}>
                      <span className="resource-title">
                        <strong>{resource.ordinalLabel ? `${resource.ordinalLabel} · ` : ""}{resource.title}</strong>
                        {!resource.available ? <span className="chip chip-muted">{t("detail.unavailable")}</span> : null}
                      </span>
                      <span className="resource-progress">
                        <progress value={Math.round(resource.progress.percent)} max={100} aria-label={t("detail.progress")} />
                        <span>{Math.round(resource.progress.percent)}%</span>
                      </span>
                      <button type="button" className="secondary-button" data-testid={`detail-open-${resource.id}`} disabled={!resource.available} onClick={() => props.onOpenResource(resource.id, kind)}><Play size={14} />{verb}</button>
                      <button type="button" className="icon-button" data-testid={`detail-move-${resource.id}`} aria-label={t("work.move.title")} title={t("work.move.title")} onClick={() => setMoving(resource.id)}><Replace size={14} /></button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="detail-muted">{progressLine(t, detail)}</p>
            </section>
          ) : null}

          {(tab === "characters" || tab === "staff") && metadataOn ? (
            <section className="detail-section" data-testid={`detail-${tab}`}>
              {credits.status === "loading" ? <p role="status">{t("status.loading")}</p> : null}
              {credits.status === "error" ? <p role="alert" className="shelf-error">{credits.error}</p> : null}
              {credits.status === "ready" && !credits.value?.source ? <p className="detail-muted" data-testid="credits-unlinked">{t("work.credits.unlinked")}</p> : null}
              {credits.status === "ready" && credits.value?.source ? (
                <>
                  <p className="detail-muted">{t("work.credits.source", { provider: providerName(credits.value.source.providerId), time: credits.value.source.fetchedAt ? formatDate(credits.value.source.fetchedAt) : "—" })}</p>
                  {tab === "characters" ? (
                    credits.value.characters.length ? (
                      <ul className="credit-list" data-testid="credit-characters">
                        {credits.value.characters.map((item) => (
                          <li key={item.id} className="credit-row" data-testid={`character-${item.id}`}>
                            <Avatar url={item.avatar?.url} name={item.name} />
                            <span><strong>{item.name}</strong> <span className="detail-muted">{item.relation}</span>{item.actors.length ? <span className="detail-muted"> · {t("work.credits.voice", { names: item.actors.map((actor) => actor.name).join("、") })}</span> : null}</span>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="detail-muted" data-testid="credits-none">{t("work.credits.none")}</p>
                  ) : (
                    credits.value.persons.length ? (
                      <ul className="credit-list" data-testid="credit-persons">
                        {credits.value.persons.map((item) => (
                          <li key={item.id} className="credit-row" data-testid={`person-${item.id}`}>
                            <Avatar url={item.avatar?.url} name={item.name} />
                            <span><strong>{item.name}</strong> <span className="detail-muted">{[item.relation, ...item.career].filter(Boolean).join(" · ")}{item.episodes ? ` · ${item.episodes}` : ""}</span></span>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="detail-muted" data-testid="credits-none">{t("work.credits.none")}</p>
                  )}
                  <p className="detail-muted">{t("work.credits.limit", { count: credits.value.avatarLimit })}</p>
                </>
              ) : null}
              {credits.status === "ready" && credits.value?.source ? <button type="button" className="secondary-button" data-testid="credits-refresh" onClick={() => setMatch("refresh")}><RefreshCw size={13} />{t("match.refresh")}</button> : null}
            </section>
          ) : null}

          {tab === "records" ? (
            <section className="detail-section" data-testid="detail-notes">
              <h3>{t("detail.notes")}</h3>
              {state.notes.length === 0 ? <p className="detail-muted">{t("detail.notesNone")}</p> : (
                <ul className="detail-list">
                  {state.notes.map((note) => (
                    <li key={note.objectId}><button type="button" className="link-button" data-testid={`detail-note-${note.objectId}`} onClick={() => props.onOpenNote(note.objectId)}>{note.title || note.preview || note.objectId}</button></li>
                  ))}
                </ul>
              )}
              {voiceOn ? (
                <>
                  <h3>{t("detail.recordings")}</h3>
                  {state.captures.length === 0 ? <p className="detail-muted">{t("detail.recordingsNone")}</p> : (
                    <ul className="detail-list" data-testid="detail-recordings">
                      {state.captures.map((capture) => (
                        <li key={capture.id} className="recording-row">
                          <span>{formatDate(capture.createdAt)} · {Math.round(capture.durationMs / 1000)}s · {t(`capture.stage.${capture.stage}` as "capture.stage.done")}</span>
                          {props.onOpenRecording ? <button type="button" className="link-button" data-testid={`detail-recording-${capture.id}`} onClick={() => props.onOpenRecording!(capture.id)}>{t("review.open")}</button> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : null}
            </section>
          ) : null}

          {tab === "related" && metadataOn ? (
            <section className="detail-section" data-testid="detail-related">
              <h3>{t("detail.related")}</h3>
              {state.relatedStatus === "loading" ? <p role="status">{t("status.loading")}</p> : null}
              {state.relatedStatus === "off" ? <p className="detail-muted">{t("detail.relatedOff")}</p> : null}
              {state.relatedStatus === "error" ? <p role="alert" className="shelf-error">{t("detail.relatedError")}</p> : null}
              {state.related?.source ? <p className="detail-muted">{t("detail.relatedSource", { provider: providerName(state.related.source.providerId), time: state.related.source.fetchedAt ? formatDate(state.related.source.fetchedAt) : "—" })}</p> : null}
              {state.related && state.related.relations.length ? (
                <ul className="detail-list" data-testid="related-relations">
                  {state.related.relations.map((item) => (
                    <li key={`${item.relation}:${item.externalId}`} className="related-row">
                      <span className="chip">{item.relation}</span>
                      <span>{item.title}</span>
                      <span className="detail-muted">{providerName(item.providerId)}</span>
                      {item.inLibraryWorkId ? <button type="button" className="link-button" data-testid={`related-open-${item.inLibraryWorkId}`} onClick={() => props.onOpenWork(item.inLibraryWorkId!)}>{t("detail.inLibrary")}</button> : null}
                      {item.sourceUrl ? <button type="button" className="link-button" onClick={() => external(item.sourceUrl!)}>{t("match.openPage")}<ExternalLink size={12} /></button> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {state.related && state.related.similar.length ? (
                <>
                  <h4>{t("detail.similar")}</h4>
                  <ul className="detail-list" data-testid="related-similar">
                    {state.related.similar.map((item) => (
                      <li key={item.workId} className="related-row">
                        <button type="button" className="link-button" data-testid={`similar-open-${item.workId}`} onClick={() => props.onOpenWork(item.workId)}>{item.title}</button>
                        <span className="detail-muted">{t("detail.sharedTags", { tags: item.sharedTags.join("、") })}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {state.relatedStatus === "ready" && !state.related?.relations.length && !state.related?.similar.length ? <p className="detail-muted" data-testid="related-none">{t("detail.relatedNone")}</p> : null}
            </section>
          ) : null}

          {match ? (
            <MatchDialog
              t={t}
              detail={detail}
              refresh={match === "refresh"}
              formatDate={formatDate}
              onClose={() => setMatch(null)}
              onOpenExternal={external}
              onError={props.onError}
              onApplied={(message) => { setMatch(null); props.onNotice(message); void changed().then(() => { if (tab === "characters" || tab === "staff") void loadCredits(); }); }}
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
