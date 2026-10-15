import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronUp, MessageSquareText, RefreshCw, X } from "lucide-react";
import type { Translator } from "@manga/i18n";
import type { DanmakuCandidate, DanmakuSettings } from "@manga/contracts/danmaku";
import { Popup } from "../components/popup.tsx";
import type { DanmakuActions, DanmakuEpisode, DanmakuProblem } from "../hooks/use-danmaku.ts";
import { OFFSET_STEPS, offsetSeconds } from "./danmaku-model.ts";

type T = Translator["t"];
export type DanmakuView = DanmakuEpisode & { actions: DanmakuActions };

/** One line for a thing that did not work, in the person's words and with the service's own reason when it gave one. */
export function problemText(t: T, problem: DanmakuProblem): string {
  const seconds = Math.max(1, Math.ceil((problem.retryAfterMs ?? 0) / 1000));
  switch (problem.code) {
    case "CREDENTIAL_UNAVAILABLE": return t("danmaku.noCredentials");
    case "AUTHENTICATION_FAILED": return problem.message ? t("danmaku.error.forbidden", { message: problem.message }) : t("danmaku.error.forbiddenPlain");
    case "RATE_LIMITED": return problem.reason === "refresh_too_soon" ? t("danmaku.refreshTooSoon", { seconds }) : t("danmaku.error.rate_limited", { seconds });
    case "PROVIDER_UNAVAILABLE":
      if (problem.reason === "network") return t("danmaku.error.network");
      if (problem.reason === "bad_response") return t("danmaku.error.bad_response");
      if (problem.reason === "rejected") return t("danmaku.error.rejected", { message: problem.message });
      return t("danmaku.error.unknown", { message: problem.message });
    default: return t("danmaku.error.unknown", { message: problem.message });
  }
}

const clockOf = (iso: string | null): string => {
  const at = iso ? new Date(iso) : null;
  return at && Number.isFinite(at.getTime()) ? at.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
};

function CandidateList(props: { t: T; candidates: DanmakuCandidate[]; busy: boolean; onPick: (candidate: DanmakuCandidate) => void }) {
  return (
    <ul className="danmaku-candidates" data-testid="danmaku-candidates">
      {props.candidates.map((candidate) => (
        <li key={candidate.episodeId}>
          <button type="button" className="danmaku-candidate" data-testid={`danmaku-candidate-${candidate.episodeId}`} disabled={props.busy} onClick={() => props.onPick(candidate)}>
            <span>{props.t("danmaku.search.candidate", { anime: candidate.animeTitle, episode: candidate.episodeTitle })}</span>
            {candidate.typeDescription ? <span className="detail-muted"> · {candidate.typeDescription}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Search the network's episodes by show name and number, and pick the one this file is. */
function Chooser(props: { t: T; view: DanmakuView }) {
  const { t, view } = props;
  const choice = view.choice;
  const [query, setQuery] = useState(choice?.suggestedQuery ?? view.suggestedQuery);
  const [episode, setEpisode] = useState(choice?.episodeNumber !== null && choice?.episodeNumber !== undefined ? String(choice.episodeNumber) : view.episodeNumber !== null ? String(view.episodeNumber) : "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    const number = episode.trim() === "" ? undefined : Number(episode);
    view.actions.search(text, number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined);
  };
  const reason = choice?.reason ?? "none";
  return (
    <div className="danmaku-choose" data-testid="danmaku-choose">
      <p>{reason === "uncertain" ? t("danmaku.choose.uncertain") : reason === "denied" ? t("danmaku.choose.denied") : reason === "no_episode" ? t("danmaku.choose.noEpisode") : t("danmaku.choose.none")}</p>
      {choice && choice.candidates.length > 0 ? <CandidateList t={t} candidates={choice.candidates} busy={view.busy} onPick={view.actions.choose} /> : null}
      <form className="danmaku-search" onSubmit={submit}>
        <label>
          <span>{t("danmaku.search.label")}</span>
          <input type="text" data-testid="danmaku-search-query" value={query} maxLength={128} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label>
          <span>{t("danmaku.search.episode")}</span>
          <input type="text" inputMode="numeric" data-testid="danmaku-search-episode" value={episode} onChange={(event) => setEpisode(event.target.value.replace(/[^0-9]/g, ""))} />
        </label>
        <button type="submit" className="secondary-button" data-testid="danmaku-search-go" disabled={view.busy || query.trim() === ""}>{view.busy ? t("danmaku.search.running") : t("danmaku.search.go")}</button>
      </form>
      {view.results ? (
        view.results.candidates.length === 0
          ? <p className="detail-muted" data-testid="danmaku-search-empty">{t("danmaku.search.empty")}</p>
          : <>
            <CandidateList t={t} candidates={view.results.candidates} busy={view.busy} onPick={view.actions.choose} />
            {view.results.hasMore ? <p className="detail-muted">{t("danmaku.search.more")}</p> : null}
          </>
      ) : null}
    </div>
  );
}

function MatchInfo(props: { t: T; view: DanmakuView; shown: number }) {
  const { t, view } = props;
  const match = view.match;
  if (!match) return null;
  return (
    <div className="danmaku-match" data-testid="danmaku-match-info">
      <p data-testid="danmaku-match">{t("danmaku.match.line", { anime: match.animeTitle, episode: match.episodeTitle })}</p>
      <p className="detail-muted">{t(`danmaku.method.${match.method}` as never)}{match.confirmed ? "" : ` · ${t("danmaku.match.unconfirmed")}`}</p>
      <div className="danmaku-actions">
        {match.confirmed ? null : <button type="button" className="secondary-button" data-testid="danmaku-confirm" onClick={view.actions.confirm}>{t("danmaku.match.confirm")}</button>}
        <button type="button" className="secondary-button" data-testid="danmaku-rematch" onClick={view.actions.rematch}>{t("danmaku.match.change")}</button>
      </div>
      <p data-testid="danmaku-count">{props.shown === view.items.length ? t("danmaku.ready", { count: view.items.length }) : t("danmaku.readyShown", { shown: props.shown, count: view.items.length })}</p>
      {view.items.length === 0 ? <p className="detail-muted">{t("danmaku.empty")}</p> : null}
      <p className="detail-muted" data-testid="danmaku-fetched">{view.fromCache ? t("danmaku.fromCache", { time: clockOf(view.expiresAt) }) : t("danmaku.fetchedAt", { time: clockOf(view.fetchedAt) })}</p>
      <div className="danmaku-actions">
        <button type="button" className="secondary-button" data-testid="danmaku-refresh" title={t("danmaku.refreshHint")} disabled={view.busy} onClick={view.actions.refresh}><RefreshCw size={14} />{t("danmaku.refresh")}</button>
      </div>
      <fieldset className="danmaku-offset">
        <legend>{t("danmaku.offset.title")}</legend>
        <div className="danmaku-actions">
          {([-OFFSET_STEPS.coarse, -OFFSET_STEPS.fine] as const).map((step) => (
            <button key={step} type="button" className="secondary-button" data-testid={`danmaku-offset${step}`} onClick={() => view.actions.setOffset(Math.max(-600_000, match.offsetMs + step))}>{t(step === -OFFSET_STEPS.coarse ? "danmaku.offset.back5" : "danmaku.offset.back05")}</button>
          ))}
          <output data-testid="danmaku-offset-value">{t("danmaku.offset.value", { seconds: offsetSeconds(match.offsetMs) })}</output>
          {([OFFSET_STEPS.fine, OFFSET_STEPS.coarse] as const).map((step) => (
            <button key={step} type="button" className="secondary-button" data-testid={`danmaku-offset+${step}`} onClick={() => view.actions.setOffset(Math.min(600_000, match.offsetMs + step))}>{t(step === OFFSET_STEPS.fine ? "danmaku.offset.fwd05" : "danmaku.offset.fwd5")}</button>
          ))}
          <button type="button" className="link-button" data-testid="danmaku-offset-reset" disabled={match.offsetMs === 0} onClick={() => view.actions.setOffset(0)}>{t("danmaku.offset.reset")}</button>
        </div>
        <p className="detail-muted">{t("danmaku.offset.hint")}</p>
      </fieldset>
    </div>
  );
}

/** What the panel says for each stage of finding and fetching the comments of an episode. */
function PanelBody(props: { t: T; view: DanmakuView; settings: DanmakuSettings; shown: number; onOpenSettings?: () => void }) {
  const { t, view } = props;
  switch (view.phase) {
    case "off":
      return <p data-testid="danmaku-state" data-phase="off">{t("danmaku.off")}</p>;
    case "loading":
      return <p role="status" data-testid="danmaku-state" data-phase="loading">{t("danmaku.loading")}</p>;
    case "no_credentials":
      return (
        <div data-testid="danmaku-state" data-phase="no_credentials">
          <p role="alert">{t("danmaku.noCredentials")}</p>
          {props.onOpenSettings ? <button type="button" className="secondary-button" data-testid="danmaku-open-settings" onClick={props.onOpenSettings}>{t("danmaku.openSettings")}</button> : null}
        </div>
      );
    case "consent":
      return (
        <div data-testid="danmaku-state" data-phase="consent">
          <strong>{t("danmaku.consent.title")}</strong>
          <p>{t("danmaku.consent.body")}</p>
          <div className="danmaku-actions">
            <button type="button" className="primary-button" data-testid="danmaku-consent-allow" onClick={() => view.actions.allow(true)}>{t("danmaku.consent.allow")}</button>
            <button type="button" className="secondary-button" data-testid="danmaku-consent-deny" onClick={() => view.actions.allow(false)}>{t("danmaku.consent.deny")}</button>
          </div>
        </div>
      );
    case "choose":
      return (
        <div data-testid="danmaku-state" data-phase="choose">
          <strong>{t("danmaku.choose.title")}</strong>
          <Chooser t={t} view={view} />
          {view.consent === "denied" ? (
            <p className="detail-muted">{t("danmaku.consent.denied")} <button type="button" className="link-button" data-testid="danmaku-consent-change" onClick={() => view.actions.allow(true)}>{t("danmaku.consent.change")}</button></p>
          ) : null}
        </div>
      );
    case "error":
      return (
        <div data-testid="danmaku-state" data-phase="error">
          <p role="alert" data-testid="danmaku-problem">{view.problem ? problemText(t, view.problem) : ""}</p>
          <button type="button" className="secondary-button" data-testid="danmaku-retry" onClick={view.actions.retry}>{t("video.retry")}</button>
        </div>
      );
    case "ready":
      return (
        <div data-testid="danmaku-state" data-phase="ready">
          <MatchInfo t={t} view={view} shown={props.shown} />
          {view.consent === "allowed" && !view.linked ? <p className="detail-muted">{t("danmaku.consent.allowed")}</p> : null}
        </div>
      );
  }
}

/**
 * Danmaku in the player's bar: one button turns it on and off, and a second one opens the panel that says where the comments come from, which
 * episode they are for, and lets the person fix the match, move the timing or fetch them again. The panel opens on the top layer like the menus.
 */
export function DanmakuControl(props: {
  t: T;
  view: DanmakuView;
  settings: DanmakuSettings;
  shown: number;
  open: boolean;
  onOpen: (open: boolean) => void;
  onToggle: () => void;
  onOpenSettings?: () => void;
}) {
  const { t, view, settings } = props;
  const wrap = useRef<HTMLSpanElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  // A question that needs an answer opens the panel by itself, once, so the person is not left wondering why nothing shows.
  const asked = useRef<string | null>(null);
  const { onOpen } = props;
  useEffect(() => {
    if ((view.phase === "consent" || view.phase === "choose") && asked.current !== view.phase) { asked.current = view.phase; onOpen(true); }
    if (view.phase === "ready" || view.phase === "off") asked.current = null;
  }, [view.phase, onOpen]);
  const label = settings.enabled ? t("danmaku.toggleOff") : t("danmaku.toggleOn");
  return (
    <span ref={wrap} className="danmaku-control" data-testid="danmaku-control">
      <button type="button" className="icon-button" data-testid="video-danmaku" aria-pressed={settings.enabled} aria-label={label} title={`${label}`} onClick={props.onToggle}><MessageSquareText size={18} /></button>
      <button ref={caret} type="button" className="icon-button danmaku-caret" data-testid="video-danmaku-panel" aria-expanded={props.open} aria-haspopup="dialog" aria-label={t("danmaku.panelButton")} title={t("danmaku.panelButton")} onClick={() => props.onOpen(!props.open)}><ChevronUp size={14} /></button>
      {props.open ? (
        <Popup
          anchor={caret}
          onClose={() => props.onOpen(false)}
          placement="above"
          align="end"
          role="dialog"
          label={t("danmaku.panelTitle")}
          className="danmaku-panel"
          testId="danmaku-panel"
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); props.onOpen(false); caret.current?.focus(); } }}
        >
          <div className="danmaku-head">
            <strong>{t("danmaku.panelTitle")}</strong>
            <button type="button" className="icon-button" data-testid="danmaku-close" aria-label={t("danmaku.close")} title={t("danmaku.close")} onClick={() => props.onOpen(false)}><X size={14} /></button>
          </div>
          <p className="detail-muted" data-testid="danmaku-attribution">{t("danmaku.attribution")}</p>
          <PanelBody t={t} view={view} settings={settings} shown={props.shown} onOpenSettings={props.onOpenSettings} />
          {view.warning ? <p className="danmaku-warning" role="status" data-testid="danmaku-warning">{view.stale ? t("danmaku.stale", { reason: problemText(t, view.warning) }) : problemText(t, view.warning)}</p> : null}
          {props.onOpenSettings && view.phase !== "no_credentials" ? <button type="button" className="link-button" data-testid="danmaku-open-settings" onClick={props.onOpenSettings}>{t("danmaku.openSettings")}</button> : null}
        </Popup>
      ) : null}
    </span>
  );
}
