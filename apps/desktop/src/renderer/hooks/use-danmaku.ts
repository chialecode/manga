import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DanmakuCandidate, DanmakuItem, DanmakuMatchInfo } from "@manga/contracts/danmaku";
import { attempt, CommandError, isModuleOff } from "../lib/api.ts";
import type { CredentialSource } from "./use-danmaku-settings.ts";

export type ConsentState = "unasked" | "allowed" | "denied";
/** What the panel shows when something did not work: the code, the service's own words, and how long to wait if it asked for a pause. */
export type DanmakuProblem = { code: string; message: string; reason?: string; retryAfterMs?: number };
export type Choice = { candidates: DanmakuCandidate[]; reason: "denied" | "uncertain" | "none" | "no_episode"; suggestedQuery: string; episodeNumber: number | null };
export type SearchResults = { query: string; candidates: DanmakuCandidate[]; hasMore: boolean };

export type DanmakuPhase = "off" | "loading" | "ready" | "consent" | "choose" | "no_credentials" | "error";

export type DanmakuEpisode = {
  phase: DanmakuPhase;
  items: DanmakuItem[];
  match: DanmakuMatchInfo | null;
  fetchedAt: string | null;
  expiresAt: string | null;
  fromCache: boolean;
  stale: boolean;
  /** Something the person should know that did not stop the comments from showing (a copy kept from before, a refresh that was too early). */
  warning: DanmakuProblem | null;
  problem: DanmakuProblem | null;
  choice: Choice | null;
  results: SearchResults | null;
  consent: ConsentState;
  linked: boolean;
  credentials: CredentialSource;
  suggestedQuery: string;
  episodeNumber: number | null;
  /** A search, a match or a refresh is running. */
  busy: boolean;
};

export type DanmakuActions = {
  /** Answer the question about sending the file's details. */
  allow(allowed: boolean): void;
  search(query: string, episode?: number): void;
  choose(candidate: DanmakuCandidate): void;
  /** The match is right as it is: keep it as the person's own. */
  confirm(): void;
  /** Open the search again for an episode that was matched wrongly. */
  rematch(): void;
  refresh(): void;
  setOffset(offsetMs: number): void;
  retry(): void;
};

const IDLE: DanmakuEpisode = {
  phase: "off", items: [], match: null, fetchedAt: null, expiresAt: null, fromCache: false, stale: false, warning: null, problem: null, choice: null, results: null,
  consent: "unasked", linked: false, credentials: "none", suggestedQuery: "", episodeNumber: null, busy: false,
};

type Status = { match: DanmakuMatchInfo | null; consent: ConsentState; linked: boolean; credentials: CredentialSource; suggestedQuery: string; episodeNumber: number | null };
type MatchReply =
  | { state: "matched"; match: DanmakuMatchInfo }
  | { state: "no_credentials" }
  | { state: "needs_consent" }
  | ({ state: "needs_choice" } & Choice);
type LoadReply =
  | { state: "ok"; items: DanmakuItem[]; fetchedAt: string; expiresAt: string; fromCache: boolean; stale: boolean; warning: DanmakuProblem | null; match: DanmakuMatchInfo }
  | { state: "no_match" }
  | { state: "no_credentials" };

const problemOf = (error: CommandError): DanmakuProblem => {
  const details = (error.details ?? {}) as { reason?: unknown; retryAfterMs?: unknown; serverMessage?: unknown };
  return {
    code: error.code,
    message: typeof details.serverMessage === "string" && details.serverMessage ? details.serverMessage : error.message,
    ...(typeof details.reason === "string" ? { reason: details.reason } : {}),
    ...(typeof details.retryAfterMs === "number" ? { retryAfterMs: details.retryAfterMs } : {}),
  };
};

/**
 * The danmaku of the episode on screen: find which episode of the network it is, fetch its comments, and keep the question or the choice the person
 * has to answer on the way. Nothing is asked of the network until `on` (the module) and `enabled` (the person's switch) are both true, and only
 * for this one episode.
 */
export function useDanmaku(input: { on: boolean; enabled: boolean; resourceId: string; revisionId: string; convert: string }): DanmakuEpisode & { actions: DanmakuActions } {
  const [state, setState] = useState<DanmakuEpisode>(IDLE);
  const run = useRef(0);
  const latest = useRef(state);
  latest.current = state;
  const ids = useMemo(() => ({ resourceId: input.resourceId, resourceRevisionId: input.revisionId }), [input.resourceId, input.revisionId]);
  const patch = useCallback((next: Partial<DanmakuEpisode>) => setState((current) => ({ ...current, ...next })), []);

  const fail = useCallback((error: CommandError) => {
    if (isModuleOff(error)) { patch({ phase: "off", busy: false }); return; }
    if (error.code === "CREDENTIAL_UNAVAILABLE") { patch({ phase: "no_credentials", busy: false, problem: null }); return; }
    patch({ phase: "error", busy: false, problem: problemOf(error) });
  }, [patch]);

  const begin = useCallback(async (consent?: boolean) => {
    const mine = ++run.current;
    const live = () => run.current === mine;
    patch({ phase: "loading", problem: null, warning: null, busy: false });
    const status = await attempt<Status>("danmaku.status", ids);
    if (!live()) return;
    if (!status.ok) { fail(status.error); return; }
    patch({ consent: status.value.consent, linked: status.value.linked, credentials: status.value.credentials, suggestedQuery: status.value.suggestedQuery, episodeNumber: status.value.episodeNumber, match: status.value.match });
    let match = status.value.match;
    if (!match) {
      const matched = await attempt<MatchReply>("danmaku.match", { ...ids, ...(consent !== undefined ? { consent } : {}) });
      if (!live()) return;
      if (!matched.ok) { fail(matched.error); return; }
      const answer = matched.value;
      if (answer.state === "no_credentials") { patch({ phase: "no_credentials" }); return; }
      if (answer.state === "needs_consent") { patch({ phase: "consent", consent: "unasked" }); return; }
      if (answer.state === "needs_choice") {
        patch({ phase: "choose", choice: { candidates: answer.candidates, reason: answer.reason, suggestedQuery: answer.suggestedQuery, episodeNumber: answer.episodeNumber }, results: null, ...(answer.reason === "denied" ? { consent: "denied" as const } : { consent: "allowed" as const }) });
        return;
      }
      match = answer.match;
      patch({ match, ...(consent === true ? { consent: "allowed" as const } : {}) });
    }
    const loaded = await attempt<LoadReply>("danmaku.load", ids);
    if (!live()) return;
    if (!loaded.ok) { fail(loaded.error); return; }
    if (loaded.value.state === "no_credentials") { patch({ phase: "no_credentials" }); return; }
    if (loaded.value.state === "no_match") { patch({ phase: "error", problem: { code: "NOT_FOUND", message: "no match" } }); return; }
    const value = loaded.value;
    patch({ phase: "ready", items: value.items, match: value.match, fetchedAt: value.fetchedAt, expiresAt: value.expiresAt, fromCache: value.fromCache, stale: value.stale, warning: value.warning, choice: null, results: null });
  }, [ids, patch, fail]);

  useEffect(() => {
    if (!input.on || !input.enabled) {
      run.current += 1;
      setState(IDLE);
      return;
    }
    void begin();
    return () => { run.current += 1; };
    // The conversion setting changes the comments the network sends, so a change of it fetches this episode again.
  }, [input.on, input.enabled, begin, input.convert]);

  const actions = useMemo<DanmakuActions>(() => ({
    allow: (allowed) => { void begin(allowed); },
    retry: () => { void begin(); },
    search: (query, episode) => {
      patch({ busy: true, warning: null });
      void attempt<{ candidates: DanmakuCandidate[]; hasMore: boolean }>("danmaku.search", { query, ...(episode !== undefined ? { episode } : {}) }).then((result) => {
        if (!result.ok) { setState((current) => ({ ...current, busy: false, warning: problemOf(result.error) })); return; }
        patch({ busy: false, results: { query, candidates: result.value.candidates, hasMore: result.value.hasMore } });
      });
    },
    choose: (candidate) => {
      patch({ busy: true });
      void attempt("danmaku.choose", { ...ids, episodeId: candidate.episodeId, animeId: candidate.animeId, animeTitle: candidate.animeTitle, episodeTitle: candidate.episodeTitle }).then((result) => {
        if (!result.ok) { setState((current) => ({ ...current, busy: false, warning: problemOf(result.error) })); return; }
        void begin();
      });
    },
    confirm: () => {
      const match = latest.current.match;
      if (!match) return;
      void attempt<{ match: DanmakuMatchInfo }>("danmaku.choose", { ...ids, episodeId: match.episodeId, animeId: match.animeId, animeTitle: match.animeTitle, episodeTitle: match.episodeTitle }).then((result) => {
        if (result.ok) patch({ match: result.value.match });
      });
    },
    rematch: () => {
      const { suggestedQuery, episodeNumber } = latest.current;
      patch({ phase: "choose", results: null, choice: { candidates: [], reason: "none", suggestedQuery, episodeNumber } });
    },
    refresh: () => {
      patch({ busy: true, warning: null });
      void attempt<LoadReply>("danmaku.load", { ...ids, refresh: true }).then((result) => {
        if (!result.ok) { setState((current) => ({ ...current, busy: false, warning: problemOf(result.error) })); return; }
        const value = result.value;
        if (value.state !== "ok") { patch({ busy: false }); return; }
        patch({ busy: false, items: value.items, match: value.match, fetchedAt: value.fetchedAt, expiresAt: value.expiresAt, fromCache: value.fromCache, stale: value.stale, warning: value.warning });
      });
    },
    setOffset: (offsetMs) => {
      void attempt<{ match: DanmakuMatchInfo }>("danmaku.setOffset", { ...ids, offsetMs }).then((result) => {
        if (result.ok) patch({ match: result.value.match });
        else patch({ warning: problemOf(result.error) });
      });
    },
  }), [ids, begin, patch]);

  return { ...state, actions };
}
