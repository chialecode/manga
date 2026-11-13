import { ExternalLink, Lock, LockOpen, Play, RefreshCw, Replace } from "lucide-react";
import type { Translator } from "@manga/i18n";
import type { CoverSummary, DetailState } from "../lib/use-work-detail.ts";
import { percentOf, type ProjectedField, type WorkDetail, type WorkMediaKind } from "../lib/works.ts";
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
const emptyField = (): ProjectedField => ({ value: null, source: null, policy: "none", candidates: [] });

export const formatFieldValue = (value: ProjectedField["value"]): string => (Array.isArray(value) ? value.join("、") : value === null || value === undefined ? "" : String(value));

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

export function WorkOverviewTab(props: {
  t: T;
  detail: WorkDetail;
  fieldOrder: readonly string[];
  fieldSource: (t: T, field: ProjectedField, formatDate: (value: string | Date) => string) => string;
  formatDate: (value: string | Date) => string;
  editMode: boolean;
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
    <section className="detail-section" data-testid="detail-fields" data-editing={props.editMode ? "true" : "false"}>
      <dl className="detail-fields">
        {props.fieldOrder.map((key) => {
          const field = detail.fields[key] ?? emptyField();
          const lockedField = detail.override.locked.includes(key);
          const empty = field.value === null || formatFieldValue(field.value) === "";
          // Reading shows what there is. Editing shows every field, including the empty ones, so a blank can be filled.
          if (!props.editMode && empty && !lockedField) return null;
          const editable = EDITABLE.has(key);
          return (
            <div key={key} className="detail-field" data-testid={`field-${key}`}>
              <dt>{t(`detail.field.${key}` as "detail.field.title")}</dt>
              <dd>
                {props.editing === key ? (
                  <form className="field-edit" onSubmit={(event) => { event.preventDefault(); props.onSaveField(key); }}>
                    {key === "summary" ? <textarea data-testid={`field-input-${key}`} value={props.draft} onChange={(event) => props.onDraft(event.target.value)} rows={5} autoFocus /> : <input data-testid={`field-input-${key}`} value={props.draft} onChange={(event) => props.onDraft(event.target.value)} autoFocus />}
                    <button type="submit" className="primary-button" data-testid={`field-save-${key}`}>{t("common.save")}</button>
                    <button type="button" className="secondary-button" onClick={props.onCancelEdit}>{t("common.cancel")}</button>
                  </form>
                ) : (
                  <>
                    <span className={key === "summary" ? "field-summary" : undefined}>{formatFieldValue(field.value) || t("detail.fieldEmpty")}</span>
                    <span className="detail-source" data-testid={`field-source-${key}`}>{props.fieldSource(t, field, formatDate)}</span>
                    {props.editMode && editable ? (
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
        <p className="detail-muted" data-testid="detail-source-line">
          {t("detail.sourceLine", { provider: providerName(linked.providerId, t), time: linked.fetchedAt ? formatDate(linked.fetchedAt) : "—" })}
          {linked.sourceUrl ? <button type="button" className="link-button" data-testid="detail-open-page" onClick={() => props.onOpenExternal(linked.sourceUrl!)}>{t("match.openPage")}<ExternalLink size={12} /></button> : null}
        </p>
      ) : null}
    </section>
  );
}

export function WorkResourcesTab(props: {
  t: T;
  detail: WorkDetail;
  kind: WorkMediaKind;
  verb: string;
  onOpenResource: (resourceId: string) => void;
  onViewResource: (resourceId: string) => void;
  onMoveResource: (resourceId: string) => void;
}) {
  const { t, detail, kind } = props;
  return (
    <section className="detail-section" data-testid="detail-resources">
      {detail.resources.length === 0 ? <p className="detail-muted">{t("detail.resourcesNone")}</p> : (
        <ul className="resource-list">
          {detail.resources.map((resource) => (
            <li key={resource.id} className="resource-row" data-testid={`detail-resource-${resource.id}`}>
              <span className="resource-title">
                <strong>{resource.ordinalLabel ? `${resource.ordinalLabel} · ` : ""}{resource.title || t("work.resource.unnamed")}</strong>
                {!resource.available ? <span className="chip chip-muted">{t("detail.unavailable")}</span> : null}
                {resource.outside ? <span className="chip chip-muted" data-testid={`detail-outside-${resource.id}`}>{t("work.outside")}</span> : null}
              </span>
              <span className="resource-progress">
                <progress value={resource.progress.completion === "completed" ? 100 : percentOf(resource.progress.percent)} max={100} aria-label={t("detail.progress")} />
                <span>{resource.progress.completion === "completed" ? shelfLabel(t, "finished", kind) : `${percentOf(resource.progress.percent)}%`}</span>
              </span>
              {resource.available
                ? <button type="button" className="secondary-button" data-testid={`detail-open-${resource.id}`} onClick={() => props.onOpenResource(resource.id)}><Play size={14} />{props.verb}</button>
                : <button type="button" className="secondary-button" data-testid={`detail-open-${resource.id}`} onClick={() => props.onViewResource(resource.id)}>{t("work.viewContent")}</button>}
              <button type="button" className="icon-button" data-testid={`detail-move-${resource.id}`} aria-label={t("work.move.title")} title={t("work.move.title")} onClick={() => props.onMoveResource(resource.id)}><Replace size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <p className="detail-muted">{progressLine(t, detail)}</p>
    </section>
  );
}

export function WorkCreditsTab(props: {
  t: T;
  tab: "characters" | "staff";
  credits: WorkCreditsState;
  formatDate: (value: string | Date) => string;
  onRefresh: () => void;
}) {
  const { t, tab, credits, formatDate } = props;
  return (
    <section className="detail-section" data-testid={`detail-${tab}`}>
      {credits.status === "loading" ? <p role="status">{t("status.loading")}</p> : null}
      {credits.status === "error" ? <p role="alert" className="shelf-error">{credits.error}</p> : null}
      {credits.status === "ready" && !credits.value?.source ? <p className="detail-muted" data-testid="credits-unlinked">{t("work.credits.unlinked")}</p> : null}
      {credits.status === "ready" && credits.value?.source ? (
        <>
          <p className="detail-muted">{t("work.credits.source", { provider: providerName(credits.value.source.providerId, t), time: credits.value.source.fetchedAt ? formatDate(credits.value.source.fetchedAt) : "—" })}</p>
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
      {credits.status === "ready" && credits.value?.source ? <button type="button" className="secondary-button" data-testid="credits-refresh" onClick={props.onRefresh}><RefreshCw size={13} />{t("match.refresh")}</button> : null}
    </section>
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
    <section className="detail-section" data-testid="detail-notes">
      <h3>{t("detail.notes")}</h3>
      {props.notes.length === 0 ? <p className="detail-muted">{t("detail.notesNone")}</p> : (
        <ul className="detail-list">
          {props.notes.map((note) => (
            <li key={note.objectId}><button type="button" className="link-button" data-testid={`detail-note-${note.objectId}`} onClick={() => props.onOpenNote(note.objectId)}>{note.title || note.preview || t("records.untitled")}</button></li>
          ))}
        </ul>
      )}
      {props.voiceOn ? (
        <>
          <h3>{t("detail.recordings")}</h3>
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
        </>
      ) : null}
      <WorkFolderSection t={t} workId={props.workId} version={props.folderVersion} canTranscribe={props.voiceOn} formatDate={formatDate} onError={props.onError} onNotice={props.onNotice} onChanged={props.onChanged} />
    </section>
  );
}

export function WorkRelatedTab(props: {
  t: T;
  related: DetailState["related"];
  relatedStatus: DetailState["relatedStatus"];
  formatDate: (value: string | Date) => string;
  onOpenWork: (workId: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const { t, related, relatedStatus, formatDate } = props;
  return (
    <section className="detail-section" data-testid="detail-related">
      <h3>{t("detail.related")}</h3>
      {relatedStatus === "loading" ? <p role="status">{t("status.loading")}</p> : null}
      {relatedStatus === "off" ? <p className="detail-muted">{t("detail.relatedOff")}</p> : null}
      {relatedStatus === "error" ? <p role="alert" className="shelf-error">{t("detail.relatedError")}</p> : null}
      {related?.source ? <p className="detail-muted">{t("detail.relatedSource", { provider: providerName(related.source.providerId, t), time: related.source.fetchedAt ? formatDate(related.source.fetchedAt) : "—" })}</p> : null}
      {related && related.relations.length ? (
        <ul className="detail-list" data-testid="related-relations">
          {related.relations.map((item) => (
            <li key={`${item.relation}:${item.externalId}`} className="related-row">
              <span className="chip">{item.relation}</span>
              <span>{item.title}</span>
              <span className="detail-muted">{providerName(item.providerId, t)}</span>
              {item.inLibraryWorkId ? <button type="button" className="link-button" data-testid={`related-open-${item.inLibraryWorkId}`} onClick={() => props.onOpenWork(item.inLibraryWorkId!)}>{t("detail.inLibrary")}</button> : null}
              {item.sourceUrl ? <button type="button" className="link-button" onClick={() => props.onOpenExternal(item.sourceUrl!)}>{t("match.openPage")}<ExternalLink size={12} /></button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {related && related.similar.length ? (
        <>
          <h4>{t("detail.similar")}</h4>
          <ul className="detail-list" data-testid="related-similar">
            {related.similar.map((item) => (
              <li key={item.workId} className="related-row">
                <button type="button" className="link-button" data-testid={`similar-open-${item.workId}`} onClick={() => props.onOpenWork(item.workId)}>{item.title}</button>
                <span className="detail-muted">{t("detail.sharedTags", { tags: item.sharedTags.join("、") })}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {relatedStatus === "ready" && !related?.relations.length && !related?.similar.length ? <p className="detail-muted" data-testid="related-none">{t("detail.relatedNone")}</p> : null}
    </section>
  );
}
