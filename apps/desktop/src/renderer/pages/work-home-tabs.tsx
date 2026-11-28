import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Lock, LockOpen, Pencil, Play, RefreshCw, Replace } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { asArray } from "../lib/api.ts";
import type { CoverSummary, DetailState } from "../lib/use-work-detail.ts";
import {
  percentOf,
  type ProjectedField,
  type RelatedProvider,
  type RelatedSimilar,
  type WorkDetail,
  type WorkEpisode,
  type WorkMediaKind,
  type WorkResourceRow,
} from "../lib/works.ts";
import { WorkFolderSection } from "./work-folder-section.tsx";
import { progressLine, shelfLabel } from "./work-card.tsx";
import { providerName } from "./work-match.tsx";

type T = Translator["t"];

type Credit = { id: string; name: string; relation: string; avatar: { url: string } | null };
type Character = Credit & { summary: string; actors: Array<{ id: string; name: string }> };
type Person = Credit & { career: string[]; episodes: string };
export type WorkCredits = { source: { providerId: string; fetchedAt: string | null } | null; characters: Character[]; persons: Person[]; avatarLimit: number };
export type WorkCreditsState = { status: "idle" | "loading" | "ready" | "error"; value?: WorkCredits; error?: string };

const EDITABLE = new Set(["title", "titleOriginal", "author", "studio", "summary", "releaseDate", "platform", "tags"]);
const INFOBOX_FIELDS = ["titleOriginal", "author", "studio", "releaseDate", "platform", "episodeCount", "volumeCount"] as const;
const PREVIEW_LIMIT = 8;
const SUMMARY_COLLAPSE_CHARS = 220;
const SUMMARY_COLLAPSE_LINES = 5;
const REMOTE_EPISODE_GRID_LIMIT = 50;

const emptyField = (): ProjectedField => ({ value: null, source: null, policy: "none", candidates: [] });

export const formatFieldValue = (value: ProjectedField["value"]): string => (Array.isArray(value) ? value.join("、") : value === null || value === undefined ? "" : String(value));

export function isSafeExternalUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function resourceProgressOf(resource: WorkResourceRow): { percent: number; completed: boolean } {
  const raw = resource.progress as unknown;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const pct = percentOf(raw);
    const completed = (resource as { completionState?: string }).completionState === "completed" || pct >= 100;
    return { percent: completed ? 100 : pct, completed };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as { percent?: number; completion?: string };
    const completed = obj.completion === "completed";
    const pct = typeof obj.percent === "number" && Number.isFinite(obj.percent) ? percentOf(obj.percent) : 0;
    return { percent: completed ? 100 : pct, completed };
  }
  return { percent: 0, completed: false };
}

function resourceOrdinalNumber(resource: WorkResourceRow): number | null {
  if (typeof resource.ordinalNumber === "number" && Number.isFinite(resource.ordinalNumber)) return resource.ordinalNumber;
  if (resource.ordinalLabel) {
    const match = /\d+(?:\.\d+)?/.exec(resource.ordinalLabel);
    if (match) {
      const parsed = Number(match[0]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function formatEpisodeNumber(num: number, special = false): string {
  const formatted = Number.isInteger(num) && num >= 0 && num < 10 ? `0${num}` : String(num);
  return special ? `SP${formatted}` : formatted;
}

function matchBangumiEpisode(resource: WorkResourceRow, episodes: readonly WorkEpisode[]): WorkEpisode | null {
  if (episodes.length === 0) return null;
  const num = resourceOrdinalNumber(resource);
  if (num === null) return null;
  if (resource.ordinalType === "special") {
    const specials = episodes.filter((ep) => ep.type === 1);
    return specials.find((ep) => ep.ep === num) ?? specials.find((ep) => ep.sort === num) ?? null;
  }
  const main = episodes.filter((ep) => ep.type === 0);
  const pool = main.length > 0 ? main : episodes;
  return pool.find((ep) => ep.ep === num) ?? pool.find((ep) => ep.sort === num) ?? null;
}

function Avatar(props: { url?: string; name: string }) {
  return <span className="credit-avatar" aria-hidden="true">{props.url ? <img src={props.url} alt="" loading="lazy" width={44} height={44} /> : <span>{[...props.name][0] ?? ""}</span>}</span>;
}

export function WorkCoversSection(props: {
  t: T;
  covers: DetailState["covers"];
  coverId: string | null;
  thumb: (coverId: string | null | undefined) => string | undefined;
  onChoose: (cover: CoverSummary) => void;
  onFromFile: () => void;
  onLock: () => void;
}) {
  const { t } = props;
  return (
    <section className="detail-section" data-testid="detail-covers">
      <h3>{t("detail.covers")}</h3>
      <ul className="cover-strip">
        {(props.covers?.covers ?? []).map((cover) => (
          <li key={cover.id}>
            <button type="button" className="cover-choice" data-testid={`cover-${cover.id}`} aria-pressed={cover.selected} onClick={() => props.onChoose(cover)}>
              {props.thumb(cover.id) ? <img src={props.thumb(cover.id)} alt="" loading="lazy" /> : <span className="cover-placeholder" />}
              <span>{t(`detail.coverSource.${cover.source}` as "detail.coverSource.file")}</span>
            </button>
          </li>
        ))}
      </ul>
      {(props.covers?.covers.length ?? 0) === 0 ? <p className="detail-muted">{t("detail.coversNone")}</p> : null}
      <div className="detail-actions">
        <button type="button" className="secondary-button" data-testid="cover-from-file" onClick={props.onFromFile}>{t("detail.coverFromFile")}</button>
        <button type="button" className="secondary-button" data-testid="cover-lock" aria-pressed={props.covers?.state === "locked"} disabled={!props.coverId} onClick={props.onLock}>
          {props.covers?.state === "locked" ? <><LockOpen size={14} />{t("detail.coverUnlock")}</> : <><Lock size={14} />{t("detail.coverLock")}</>}
        </button>
      </div>
      <p className="detail-muted">{t("detail.coverLockHint")}</p>
    </section>
  );
}

function FoldToggle(props: { expanded: boolean; total: number; testId: string; t: T; plain?: boolean; onToggle: () => void }) {
  const { t } = props;
  return (
    <button type="button" className="link-button work-fold-toggle" data-testid={props.testId} aria-expanded={props.expanded} onClick={props.onToggle}>
      {props.expanded ? (
        <>
          <ChevronUp size={13} aria-hidden="true" />
          {t("work.collapse")}
        </>
      ) : (
        <>
          <ChevronDown size={13} aria-hidden="true" />
          {props.plain ? t("work.expandAll") : t("work.expandCount", { count: props.total })}
        </>
      )}
    </button>
  );
}

function WorkProfileEditor(props: {
  t: T;
  detail: WorkDetail;
  fieldOrder: readonly string[];
  fieldSource: (t: T, field: ProjectedField, formatDate: (value: string | Date) => string) => string;
  formatDate: (value: string | Date) => string;
  editing: string | null;
  draft: string;
  onStartEdit: (key: string, value: string) => void;
  onCancelEdit: () => void;
  onDraft: (value: string) => void;
  onSaveField: (key: string) => void;
  onToggleLock: (key: string) => void;
  onResetField: (key: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const { t, detail, formatDate } = props;
  const linked = detail.linkedSource ?? null;
  return (
    <section className="detail-section work-edit-panel" data-testid="detail-fields" data-editing="true">
      <div className="work-edit-head">
        <h3>{t("work.editMode.title")}</h3>
        <p className="detail-muted">{t("work.editMode.hint")}</p>
      </div>
      <dl className="detail-fields">
        {props.fieldOrder.map((key) => {
          const field = detail.fields[key] ?? emptyField();
          const lockedField = detail.override.locked.includes(key);
          const empty = field.value === null || formatFieldValue(field.value) === "";
          const editable = EDITABLE.has(key);
          return (
            <div key={key} className="detail-field" data-testid={`field-${key}`}>
              <dt>{t(`detail.field.${key}` as "detail.field.title")}</dt>
              <dd>
                {props.editing === key ? (
                  <form className="field-edit" onSubmit={(event) => { event.preventDefault(); props.onSaveField(key); }}>
                    {key === "summary"
                      ? <textarea data-testid={`field-input-${key}`} value={props.draft} onChange={(event) => props.onDraft(event.target.value)} rows={5} autoFocus />
                      : <input data-testid={`field-input-${key}`} value={props.draft} onChange={(event) => props.onDraft(event.target.value)} autoFocus />}
                    <button type="submit" className="primary-button" data-testid={`field-save-${key}`}>{t("common.save")}</button>
                    <button type="button" className="secondary-button" onClick={props.onCancelEdit}>{t("common.cancel")}</button>
                  </form>
                ) : (
                  <>
                    <span className={key === "summary" ? "field-summary" : undefined}>{formatFieldValue(field.value) || t("detail.fieldEmpty")}</span>
                    <span className="detail-source" data-testid={`field-source-${key}`}>{props.fieldSource(t, field, formatDate)}</span>
                    {editable ? (
                      <span className="field-tools">
                        <button type="button" className="link-button" data-testid={`field-edit-${key}`} onClick={() => props.onStartEdit(key, formatFieldValue(field.value))}>{empty ? t("work.fill") : t("common.edit")}</button>
                        <button type="button" className="link-button" data-testid={`field-lock-${key}`} aria-pressed={lockedField} onClick={() => props.onToggleLock(key)}>{lockedField ? t("detail.unlockField") : t("detail.lockField")}</button>
                        {field.source === "user" || lockedField || key in detail.override.fields ? <button type="button" className="link-button" data-testid={`field-reset-${key}`} onClick={() => props.onResetField(key)}>{t("detail.resetField")}</button> : null}
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
        <p className="detail-muted work-edit-foot" data-testid="detail-source-line">
          <span>{t("detail.sourceLine", { provider: providerName(linked.providerId, t), time: linked.fetchedAt ? formatDate(linked.fetchedAt) : "—" })}</span>
          {isSafeExternalUrl(linked.sourceUrl) ? <button type="button" className="link-button" data-testid="detail-open-page" onClick={() => props.onOpenExternal(linked.sourceUrl!)}>{t("match.openPage")}<ExternalLink size={12} aria-hidden="true" /></button> : null}
        </p>
      ) : null}
    </section>
  );
}

function WorkInfobox(props: {
  t: T;
  detail: WorkDetail;
  showSubtitleInHeader: boolean;
  formatDate: (value: string | Date) => string;
  onToggleEdit: () => void;
  onOpenExternal: (url: string) => void;
}) {
  const { t, detail, formatDate } = props;
  const linked = detail.linkedSource ?? null;
  const aliases = asArray<string>(linked?.aliases).map((item) => item.trim()).filter(Boolean);

  const fieldRows = INFOBOX_FIELDS.flatMap((key) => {
    const field = detail.fields[key] ?? emptyField();
    const lockedField = detail.override.locked.includes(key);
    if (key === "titleOriginal" && props.showSubtitleInHeader) return [];
    const formatted = formatFieldValue(field.value);
    const empty = field.value === null || formatted === "";
    if (empty && !lockedField) return [];
    return [{ key, value: formatted || t("detail.fieldEmpty"), lockedField }];
  });

  const hasRows = aliases.length > 0 || fieldRows.length > 0;

  return (
    <aside className="work-infobox" data-testid="detail-fields" data-editing="false">
      <div className="work-infobox-head">
        <h3>{t("work.infobox.title")}</h3>
        <button type="button" className="link-button work-infobox-edit" data-testid="infobox-edit" onClick={props.onToggleEdit}>
          <Pencil size={12} aria-hidden="true" />
          {t("work.infobox.edit")}
        </button>
      </div>
      {hasRows ? (
        <dl className="work-infobox-list">
          {aliases.length > 0 ? (
            <div className="work-infobox-row" data-testid="field-aliases">
              <dt>{t("work.infobox.aliases")}</dt>
              <dd>{aliases.join(" / ")}</dd>
            </div>
          ) : null}
          {fieldRows.map(({ key, value, lockedField }) => (
            <div key={key} className="work-infobox-row" data-testid={`field-${key}`}>
              <dt>{t(`detail.field.${key}` as "detail.field.title")}</dt>
              <dd>
                <span>{value}</span>
                {lockedField ? (
                  <span className="work-infobox-lock" data-testid={`field-locked-${key}`} title={t("work.infobox.locked")} aria-label={t("work.infobox.locked")}>
                    <Lock size={11} aria-hidden="true" />
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : !linked ? (
        <p className="detail-muted work-infobox-empty" data-testid="infobox-empty">{t("work.infobox.emptyHint")}</p>
      ) : null}
      {linked ? (
        <div className="work-infobox-foot" data-testid="detail-source-line">
          <span>{t("detail.sourceLine", { provider: providerName(linked.providerId, t), time: linked.fetchedAt ? formatDate(linked.fetchedAt) : "—" })}</span>
          {isSafeExternalUrl(linked.sourceUrl) ? (
            <button type="button" className="link-button work-infobox-ext" data-testid="detail-open-page" onClick={() => props.onOpenExternal(linked.sourceUrl!)}>
              {t("match.openPage")}
              <ExternalLink size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function WorkResourcesSection(props: {
  t: T;
  detail: WorkDetail;
  kind: WorkMediaKind;
  verb: string;
  onOpenResource: (resourceId: string) => void;
  onViewResource: (resourceId: string) => void;
  onMoveResource: (resourceId: string) => void;
}) {
  const { t, detail, kind } = props;
  const [expanded, setExpanded] = useState(false);
  const bgmEpisodes = asArray<WorkEpisode>(detail.linkedSource?.episodes);
  const resources = asArray<WorkResourceRow>(detail.resources);
  const showLocalGrid = resources.length >= 2 || (kind === "video" && resources.length >= 1 && bgmEpisodes.length > 0);
  const remoteMainEps = resources.length === 0 && kind === "video" && bgmEpisodes.length > 0
    ? (bgmEpisodes.filter((ep) => ep.type === 0).length > 0 ? bgmEpisodes.filter((ep) => ep.type === 0) : bgmEpisodes).slice(0, REMOTE_EPISODE_GRID_LIMIT)
    : [];
  const visibleResources = expanded || resources.length <= PREVIEW_LIMIT ? resources : resources.slice(0, PREVIEW_LIMIT);
  const summaryLine = progressLine(t, detail);

  return (
    <section className="work-section" data-testid="detail-resources">
      <div className="work-section-head">
        <h3>
          {t(`work.tab.resources.${kind}` as "work.tab.resources.novel")}
          {resources.length > 0 ? <span className="work-section-count">{resources.length}</span> : null}
        </h3>
        {summaryLine ? <span className="detail-muted">{summaryLine}</span> : null}
      </div>

      {showLocalGrid ? (
        <div className="work-ep-grid" role="group" aria-label={t("work.episode.grid")} data-testid="work-episode-grid">
          {resources.map((resource, index) => {
            const { percent, completed } = resourceProgressOf(resource);
            const isUnavailable = resource.available === false || resource.outside === true;
            const cellState = isUnavailable ? "unavailable" : completed ? "completed" : percent > 0 ? "in-progress" : "unwatched";
            const matched = matchBangumiEpisode(resource, bgmEpisodes);
            const num = resourceOrdinalNumber(resource);
            const cellLabel = num !== null ? formatEpisodeNumber(num, resource.ordinalType === "special") : formatEpisodeNumber(index + 1);
            const localTitle = `${resource.ordinalLabel ? `${resource.ordinalLabel} · ` : ""}${resource.title || t("work.resource.unnamed")}`;
            const bgmTitle = matched?.title && !localTitle.includes(matched.title) ? matched.title : "";
            const airdateText = matched?.airdate ? t("work.episode.airdate", { date: matched.airdate }) : "";
            const tooltip = [localTitle, bgmTitle, airdateText].filter(Boolean).join(" · ");
            return (
              <button
                key={resource.id}
                type="button"
                className="ep-cell"
                data-testid={`episode-cell-${resource.id}`}
                data-state={cellState}
                title={tooltip}
                aria-label={tooltip}
                onClick={() => (resource.available !== false ? props.onOpenResource(resource.id) : props.onViewResource(resource.id))}
              >
                <span className="ep-cell-num">{cellLabel}</span>
                {cellState === "in-progress" ? <span className="ep-cell-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span> : null}
              </button>
            );
          })}
        </div>
      ) : remoteMainEps.length > 0 ? (
        <div className="work-ep-grid" role="group" aria-label={t("work.episode.grid")} data-testid="work-episode-grid">
          {remoteMainEps.map((ep, index) => {
            const num = ep.ep ?? ep.sort ?? index + 1;
            const cellLabel = formatEpisodeNumber(num, ep.type === 1);
            const airdateText = ep.airdate ? t("work.episode.airdate", { date: ep.airdate }) : "";
            const tooltip = [cellLabel, ep.title, airdateText].filter(Boolean).join(" · ");
            return (
              <button
                key={`${ep.type}-${ep.sort}-${index}`}
                type="button"
                className="ep-cell"
                data-state="unavailable"
                disabled
                title={tooltip}
                aria-label={tooltip}
              >
                <span className="ep-cell-num">{cellLabel}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {resources.length === 0 ? <p className="detail-muted">{t("detail.resourcesNone")}</p> : (
        <>
          <ul className="resource-list">
            {visibleResources.map((resource) => {
              const { percent, completed } = resourceProgressOf(resource);
              const matched = matchBangumiEpisode(resource, bgmEpisodes);
              const localTitle = resource.title || t("work.resource.unnamed");
              const bgmTitle = matched?.title && !localTitle.includes(matched.title) ? matched.title : "";
              const airdateText = matched?.airdate ? t("work.episode.airdate", { date: matched.airdate }) : "";
              const bgmMeta = [bgmTitle, airdateText].filter(Boolean).join(" · ");
              return (
                <li key={resource.id} className="resource-row" data-testid={`detail-resource-${resource.id}`}>
                  <div className="resource-main">
                    <span className="resource-title">
                      <strong>{resource.ordinalLabel ? `${resource.ordinalLabel} · ` : ""}{localTitle}</strong>
                      {resource.available === false ? <span className="chip chip-muted">{t("detail.unavailable")}</span> : null}
                      {resource.outside ? <span className="chip chip-muted" data-testid={`detail-outside-${resource.id}`}>{t("work.outside")}</span> : null}
                    </span>
                    {bgmMeta ? <span className="detail-muted resource-bgm-meta" data-testid={`detail-resource-ep-${resource.id}`}>{bgmMeta}</span> : null}
                  </div>
                  <span className="resource-progress">
                    <progress value={completed ? 100 : percent} max={100} aria-label={t("detail.progress")} />
                    <span>{completed ? shelfLabel(t, "finished", kind) : `${percent}%`}</span>
                  </span>
                  <span className="resource-actions">
                    {resource.available !== false
                      ? <button type="button" className="secondary-button" data-testid={`detail-open-${resource.id}`} onClick={() => props.onOpenResource(resource.id)}><Play size={14} />{props.verb}</button>
                      : <button type="button" className="secondary-button" data-testid={`detail-open-${resource.id}`} onClick={() => props.onViewResource(resource.id)}>{t("work.viewContent")}</button>}
                    <button type="button" className="icon-button" data-testid={`detail-move-${resource.id}`} aria-label={t("work.move.title")} title={t("work.move.title")} onClick={() => props.onMoveResource(resource.id)}><Replace size={14} /></button>
                  </span>
                </li>
              );
            })}
          </ul>
          {resources.length > PREVIEW_LIMIT ? (
            <FoldToggle expanded={expanded} total={resources.length} testId="resources-toggle" t={t} onToggle={() => setExpanded((value) => !value)} />
          ) : null}
        </>
      )}
    </section>
  );
}

function WorkCreditsSections(props: {
  t: T;
  credits: WorkCreditsState;
  onRefresh: () => void;
}) {
  const { t, credits } = props;
  const [charsExpanded, setCharsExpanded] = useState(false);
  const [staffExpanded, setStaffExpanded] = useState(false);

  const characters = asArray<Character>(credits.value?.characters);
  const persons = asArray<Person>(credits.value?.persons);
  const avatarLimit = credits.value?.avatarLimit ?? 20;
  const totalCredits = characters.length + persons.length;
  const showLimitNote = credits.status === "ready" && totalCredits > avatarLimit;

  const visibleChars = charsExpanded || characters.length <= PREVIEW_LIMIT ? characters : characters.slice(0, PREVIEW_LIMIT);
  const visibleStaff = staffExpanded || persons.length <= PREVIEW_LIMIT ? persons : persons.slice(0, PREVIEW_LIMIT);
  const showStaffSection = credits.status === "ready" && persons.length > 0;

  return (
    <>
      <section className="work-section" data-testid="detail-characters">
        <div className="work-section-head">
          <h3>
            {t("work.tab.characters")}
            {characters.length > 0 ? <span className="work-section-count">{characters.length}</span> : null}
          </h3>
          <button type="button" className="link-button work-section-action" data-testid="credits-refresh" onClick={props.onRefresh}>
            <RefreshCw size={12} aria-hidden="true" />
            {t("match.refresh")}
          </button>
        </div>
        {credits.status === "loading" ? <p role="status" className="detail-muted">{t("status.loading")}</p> : null}
        {credits.status === "error" ? <p role="alert" className="shelf-error">{credits.error}</p> : null}
        {credits.status === "ready" ? (
          characters.length > 0 ? (
            <>
              <ul className="credit-grid" data-testid="credit-characters">
                {visibleChars.map((item) => {
                  const actors = asArray<{ id: string; name: string }>(item.actors);
                  return (
                    <li key={item.id} className="credit-card" data-testid={`character-${item.id}`}>
                      <Avatar url={item.avatar?.url} name={item.name} />
                      <div className="credit-card-body">
                        <div className="credit-card-top">
                          <strong className="credit-name">{item.name}</strong>
                          {item.relation ? <span className="credit-role">{item.relation}</span> : null}
                        </div>
                        {actors.length > 0 ? (
                          <span className="detail-muted credit-sub">{t("work.credits.voice", { names: actors.map((actor) => actor.name).join("、") })}</span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {characters.length > PREVIEW_LIMIT ? (
                <FoldToggle expanded={charsExpanded} total={characters.length} testId="characters-toggle" t={t} onToggle={() => setCharsExpanded((value) => !value)} />
              ) : null}
            </>
          ) : (
            <p className="detail-muted" data-testid="credits-none">{t("work.credits.none")}</p>
          )
        ) : null}
        {showLimitNote && !showStaffSection ? <p className="detail-muted work-credits-limit" data-testid="credits-limit">{t("work.credits.limit", { count: avatarLimit })}</p> : null}
      </section>

      {showStaffSection ? (
        <section className="work-section" data-testid="detail-staff">
          <div className="work-section-head">
            <h3>
              {t("work.tab.staff")}
              <span className="work-section-count">{persons.length}</span>
            </h3>
          </div>
          <ul className="credit-grid" data-testid="credit-persons">
            {visibleStaff.map((item) => {
              const meta = [...asArray<string>(item.career), item.episodes].filter(Boolean).join(" · ");
              return (
                <li key={item.id} className="credit-card" data-testid={`person-${item.id}`}>
                  <Avatar url={item.avatar?.url} name={item.name} />
                  <div className="credit-card-body">
                    <div className="credit-card-top">
                      <strong className="credit-name">{item.name}</strong>
                      {item.relation ? <span className="credit-role">{item.relation}</span> : null}
                    </div>
                    {meta ? <span className="detail-muted credit-sub">{meta}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {persons.length > PREVIEW_LIMIT ? (
            <FoldToggle expanded={staffExpanded} total={persons.length} testId="staff-toggle" t={t} onToggle={() => setStaffExpanded((value) => !value)} />
          ) : null}
          {showLimitNote ? <p className="detail-muted work-credits-limit" data-testid="credits-limit">{t("work.credits.limit", { count: avatarLimit })}</p> : null}
        </section>
      ) : null}
    </>
  );
}

function WorkRelatedSection(props: {
  t: T;
  related: DetailState["related"];
  relatedStatus: DetailState["relatedStatus"];
  formatDate: (value: string | Date) => string;
  onOpenWork: (workId: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const { t, related, relatedStatus, formatDate } = props;
  const [expanded, setExpanded] = useState(false);
  const relations = asArray<RelatedProvider>(related?.relations);
  const similar = asArray<RelatedSimilar>(related?.similar);
  const totalCount = relations.length + similar.length;
  const visibleRelations = expanded || relations.length <= PREVIEW_LIMIT ? relations : relations.slice(0, PREVIEW_LIMIT);

  return (
    <section className="work-section" data-testid="detail-related">
      <div className="work-section-head">
        <h3>
          {t("detail.related")}
          {totalCount > 0 ? <span className="work-section-count">{totalCount}</span> : null}
        </h3>
        {related?.source ? (
          <span className="detail-muted">{t("detail.relatedSource", { provider: providerName(related.source.providerId, t), time: related.source.fetchedAt ? formatDate(related.source.fetchedAt) : "—" })}</span>
        ) : null}
      </div>
      {relatedStatus === "loading" ? <p role="status" className="detail-muted">{t("status.loading")}</p> : null}
      {relatedStatus === "off" ? <p className="detail-muted">{t("detail.relatedOff")}</p> : null}
      {relatedStatus === "error" ? <p role="alert" className="shelf-error">{t("detail.relatedError")}</p> : null}
      {relations.length > 0 ? (
        <>
          <ul className="detail-list work-related-list" data-testid="related-relations">
            {visibleRelations.map((item) => (
              <li key={`${item.relation}:${item.externalId}`} className="related-row">
                <span className="chip">{item.relation}</span>
                <span className="related-title">{item.title}</span>
                <span className="detail-muted">{providerName(item.providerId, t)}</span>
                <span className="related-actions">
                  {item.inLibraryWorkId ? <button type="button" className="link-button" data-testid={`related-open-${item.inLibraryWorkId}`} onClick={() => props.onOpenWork(item.inLibraryWorkId!)}>{t("detail.inLibrary")}</button> : null}
                  {isSafeExternalUrl(item.sourceUrl) ? <button type="button" className="link-button" onClick={() => props.onOpenExternal(item.sourceUrl!)}>{t("match.openPage")}<ExternalLink size={12} aria-hidden="true" /></button> : null}
                </span>
              </li>
            ))}
          </ul>
          {relations.length > PREVIEW_LIMIT ? (
            <FoldToggle expanded={expanded} total={relations.length} testId="related-toggle" t={t} onToggle={() => setExpanded((value) => !value)} />
          ) : null}
        </>
      ) : null}
      {similar.length > 0 ? (
        <div className="work-similar-block">
          <h4>{t("detail.similar")}</h4>
          <ul className="detail-list work-related-list" data-testid="related-similar">
            {similar.map((item) => (
              <li key={item.workId} className="related-row">
                <button type="button" className="link-button" data-testid={`similar-open-${item.workId}`} onClick={() => props.onOpenWork(item.workId)}>{item.title}</button>
                <span className="detail-muted">{t("detail.sharedTags", { tags: asArray<string>(item.sharedTags).join("、") })}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {relatedStatus === "ready" && relations.length === 0 && similar.length === 0 ? <p className="detail-muted" data-testid="related-none">{t("detail.relatedNone")}</p> : null}
    </section>
  );
}

export function WorkOverviewTab(props: {
  t: T;
  detail: WorkDetail;
  kind: WorkMediaKind;
  verb: string;
  metadataOn: boolean;
  showSubtitleInHeader: boolean;
  fieldOrder: readonly string[];
  fieldSource: (t: T, field: ProjectedField, formatDate: (value: string | Date) => string) => string;
  formatDate: (value: string | Date) => string;
  editMode: boolean;
  editing: string | null;
  draft: string;
  credits: WorkCreditsState;
  related: DetailState["related"];
  relatedStatus: DetailState["relatedStatus"];
  onToggleEdit: () => void;
  onStartEdit: (key: string, value: string) => void;
  onCancelEdit: () => void;
  onDraft: (value: string) => void;
  onSaveField: (key: string) => void;
  onToggleLock: (key: string) => void;
  onResetField: (key: string) => void;
  onOpenResource: (resourceId: string) => void;
  onViewResource: (resourceId: string) => void;
  onMoveResource: (resourceId: string) => void;
  onRefreshCredits: () => void;
  onOpenWork: (workId: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const { t, detail } = props;
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  if (props.editMode) {
    return (
      <WorkProfileEditor
        t={t}
        detail={detail}
        fieldOrder={props.fieldOrder}
        fieldSource={props.fieldSource}
        formatDate={props.formatDate}
        editing={props.editing}
        draft={props.draft}
        onStartEdit={props.onStartEdit}
        onCancelEdit={props.onCancelEdit}
        onDraft={props.onDraft}
        onSaveField={props.onSaveField}
        onToggleLock={props.onToggleLock}
        onResetField={props.onResetField}
        onOpenExternal={props.onOpenExternal}
      />
    );
  }

  const summary = formatFieldValue(detail.fields.summary?.value ?? null).trim();
  const summaryLong = summary.length > SUMMARY_COLLAPSE_CHARS || summary.split("\n").length > SUMMARY_COLLAPSE_LINES;
  const linked = detail.linkedSource ?? null;

  return (
    <div className="work-bangumi-grid" data-testid="work-bangumi-layout">
      <WorkInfobox
        t={t}
        detail={detail}
        showSubtitleInHeader={props.showSubtitleInHeader}
        formatDate={props.formatDate}
        onToggleEdit={props.onToggleEdit}
        onOpenExternal={props.onOpenExternal}
      />
      <div className="work-main-col">
        {summary ? (
          <section className="work-section work-summary-section" data-testid="work-summary">
            <div className="work-section-head">
              <h3>{t("detail.field.summary")}</h3>
            </div>
            <p className={`work-summary-text ${!summaryExpanded && summaryLong ? "is-clamped" : ""}`}>{summary}</p>
            {summaryLong ? (
              <FoldToggle expanded={summaryExpanded} total={0} testId="summary-toggle" t={t} plain onToggle={() => setSummaryExpanded((value) => !value)} />
            ) : null}
          </section>
        ) : null}

        <WorkResourcesSection
          t={t}
          detail={detail}
          kind={props.kind}
          verb={props.verb}
          onOpenResource={props.onOpenResource}
          onViewResource={props.onViewResource}
          onMoveResource={props.onMoveResource}
        />

        {props.metadataOn && linked ? (
          <WorkCreditsSections t={t} credits={props.credits} onRefresh={props.onRefreshCredits} />
        ) : null}

        {props.metadataOn ? (
          <WorkRelatedSection
            t={t}
            related={props.related}
            relatedStatus={props.relatedStatus}
            formatDate={props.formatDate}
            onOpenWork={props.onOpenWork}
            onOpenExternal={props.onOpenExternal}
          />
        ) : null}
      </div>
    </div>
  );
}

export function WorkRecordsTab(props: {
  t: T;
  workId: string;
  folderVersion: string;
  voiceOn: boolean;
  notes: DetailState["notes"];
  captures: DetailState["captures"];
  formatDate: (value: string | Date) => string;
  onOpenNote: (objectId: string) => void;
  onOpenRecording?: (sessionId: string) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onChanged: () => void;
}) {
  const { t, formatDate } = props;
  return (
    <section className="detail-section work-records-panel" data-testid="detail-notes">
      <div className="work-section">
        <div className="work-section-head">
          <h3>
            {t("detail.notes")}
            {props.notes.length > 0 ? <span className="work-section-count">{props.notes.length}</span> : null}
          </h3>
        </div>
        {props.notes.length === 0 ? <p className="detail-muted">{t("detail.notesNone")}</p> : (
          <ul className="detail-list">
            {props.notes.map((note) => (
              <li key={note.objectId}><button type="button" className="link-button" data-testid={`detail-note-${note.objectId}`} onClick={() => props.onOpenNote(note.objectId)}>{note.title || note.preview || t("records.untitled")}</button></li>
            ))}
          </ul>
        )}
      </div>
      {props.voiceOn ? (
        <div className="work-section">
          <div className="work-section-head">
            <h3>
              {t("detail.recordings")}
              {props.captures.length > 0 ? <span className="work-section-count">{props.captures.length}</span> : null}
            </h3>
          </div>
          {props.captures.length === 0 ? <p className="detail-muted">{t("detail.recordingsNone")}</p> : (
            <ul className="detail-list" data-testid="detail-recordings">
              {props.captures.map((capture) => (
                <li key={capture.id} className="recording-row">
                  <span>{formatDate(capture.createdAt)} · {Math.round(capture.durationMs / 1000)}s · {t(`capture.stage.${capture.stage}` as "capture.stage.done")}</span>
                  {props.onOpenRecording ? <button type="button" className="link-button" data-testid={`detail-recording-${capture.id}`} onClick={() => props.onOpenRecording!(capture.id)}>{t("review.open")}</button> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <WorkFolderSection t={t} workId={props.workId} version={props.folderVersion} canTranscribe={props.voiceOn} formatDate={formatDate} onError={props.onError} onNotice={props.onNotice} onChanged={props.onChanged} />
    </section>
  );
}
