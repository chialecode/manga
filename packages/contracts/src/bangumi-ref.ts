/**
 * Pure Bangumi subject reference parser and search-input classifier (A-51, A-62).
 * Extracts a numeric subject id from an id, `subject/<id>`, or official Bangumi URL without fetching anything.
 * Contains structured reason codes only — user-facing text lives in `@manga/i18n`.
 */

export const REF_FAILURE_REASONS = [
  "empty",
  "bad-id",
  "not-a-subject",
  "foreign-host",
  "character-page",
  "person-page",
  "other-page",
  "extra-path",
] as const;

export type RefFailureReason = (typeof REF_FAILURE_REASONS)[number];

/** Backwards-compatible alias for `RefFailureReason`. */
export type RefFailure = RefFailureReason;

export type ParsedBangumiRef =
  | { ok: true; externalId: string; form: "id" | "path" | "url" }
  | { ok: false; reason: RefFailureReason };

/** Sites that serve Bangumi entries (`www.` is accepted in front of any of them). */
export const BANGUMI_PAGE_HOSTS = ["bgm.tv", "bangumi.tv", "chii.in"] as const;

const MAX_ID_DIGITS = 10;

const BARE_HOST = new RegExp(
  `^(?:www\\.)?(?:${BANGUMI_PAGE_HOSTS.map((host) => host.replace(".", "\\.")).join("|")})(?:[/?#]|$)`,
  "i",
);

function idOf(digits: string): string | null {
  const trimmed = digits.replace(/^0+/, "");
  return trimmed.length > 0 && trimmed.length <= MAX_ID_DIGITS ? trimmed : null;
}

function parsePath(rawPath: string): ParsedBangumiRef {
  const trimmed = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  const [kind, id, ...rest] = trimmed ? trimmed.split("/") : [];
  if (!kind) return { ok: false, reason: "not-a-subject" };
  const lower = kind.toLowerCase();
  if (lower === "character") return { ok: false, reason: "character-page" };
  if (lower === "person") return { ok: false, reason: "person-page" };
  if (lower !== "subject") return { ok: false, reason: "other-page" };
  if (id === undefined || !/^\d+$/.test(id)) return { ok: false, reason: "bad-id" };
  if (rest.length) return { ok: false, reason: "extra-path" };
  const externalId = idOf(id);
  return externalId ? { ok: true, externalId, form: "path" } : { ok: false, reason: "bad-id" };
}

export function parseBangumiRef(input: string): ParsedBangumiRef {
  const text = input.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (/^\d+$/.test(text)) {
    const externalId = idOf(text);
    return externalId ? { ok: true, externalId, form: "id" } : { ok: false, reason: "bad-id" };
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const bareHost = BARE_HOST.test(text);
  if (hasScheme || bareHost) {
    let url: URL;
    try { url = new URL(hasScheme ? text : `https://${text}`); } catch { return { ok: false, reason: "not-a-subject" }; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "not-a-subject" };
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.username || url.password || url.port || !(BANGUMI_PAGE_HOSTS as readonly string[]).includes(host)) {
      return { ok: false, reason: "foreign-host" };
    }
    const parsed = parsePath(url.pathname);
    return parsed.ok ? { ...parsed, form: "url" } : parsed;
  }
  const rawPath = text.replace(/[?#].*$/, "");
  return rawPath.includes("/") ? parsePath(rawPath) : { ok: false, reason: "not-a-subject" };
}

export type SearchIntent =
  | { type: "empty" }
  | { type: "name"; query: string }
  | { type: "number"; externalId: string; query: string }
  | { type: "entry"; externalId: string }
  | { type: "refused"; reason: RefFailureReason };

/**
 * Classifies one Bangumi match input (A-62): plain title, numeric id + title search, direct entry reference, or refusal reason.
 */
export function classifySearchInput(input: string): SearchIntent {
  const text = input.trim();
  if (!text) return { type: "empty" };
  if (/^\d+$/.test(text)) {
    const externalId = idOf(text);
    return externalId ? { type: "number", externalId, query: text } : { type: "name", query: text };
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const bareHost = BARE_HOST.test(text);
  const entryPath = /^\/?(?:subject|character|person)\/[^\s]*$/i.test(text.replace(/[?#].*$/, ""));
  if (!hasScheme && !bareHost && !entryPath) return { type: "name", query: text };
  const parsed = parseBangumiRef(text.replace(/^\/(?=(?:subject|character|person)\/)/i, ""));
  return parsed.ok ? { type: "entry", externalId: parsed.externalId } : { type: "refused", reason: parsed.reason };
}
