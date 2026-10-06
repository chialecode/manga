/**
 * What a user may paste to say which Bangumi entry a work is (A-51): the entry number, `subject/<number>`, or the address of the entry's
 * page on one of the sites that serve it. Only the number is taken out; the address itself is never fetched or stored.
 */
export type RefFailure = "empty" | "bad-id" | "not-a-subject" | "foreign-host" | "character-page" | "person-page" | "other-page" | "extra-path";

export type ParsedRef = { ok: true; externalId: string; form: "id" | "path" | "url" } | { ok: false; reason: RefFailure };

/** Sites that serve the same entries. `www.` is accepted in front of any of them. */
export const BANGUMI_PAGE_HOSTS = ["bgm.tv", "bangumi.tv", "chii.in"] as const;

const MAX_ID_DIGITS = 10;

function idOf(digits: string): string | null {
  const trimmed = digits.replace(/^0+/, "");
  return trimmed.length > 0 && trimmed.length <= MAX_ID_DIGITS ? trimmed : null;
}

/** A path on the site, without host: `subject/123`, `/subject/123/`, `character/9`. */
function parsePath(path: string): ParsedRef {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
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

export function parseBangumiRef(input: string): ParsedRef {
  const text = input.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (/^\d+$/.test(text)) {
    const externalId = idOf(text);
    return externalId ? { ok: true, externalId, form: "id" } : { ok: false, reason: "bad-id" };
  }
  // A query or fragment after a path is ignored.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const bareHost = new RegExp(`^(?:www\\.)?(?:${BANGUMI_PAGE_HOSTS.map((host) => host.replace(".", "\\.")).join("|")})(?:[/?#]|$)`, "i").test(text);
  if (hasScheme || bareHost) {
    let url: URL;
    try { url = new URL(hasScheme ? text : `https://${text}`); } catch { return { ok: false, reason: "not-a-subject" }; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "not-a-subject" };
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.username || url.password || url.port || !(BANGUMI_PAGE_HOSTS as readonly string[]).includes(host)) return { ok: false, reason: "foreign-host" };
    const parsed = parsePath(url.pathname);
    return parsed.ok ? { ...parsed, form: "url" } : parsed;
  }
  // Without a slash it is neither a number nor a path: there is nothing to take an entry number from.
  const path = text.replace(/[?#].*$/, "");
  return path.includes("/") ? parsePath(path) : { ok: false, reason: "not-a-subject" };
}

/** One short sentence for each way a reference can be wrong, in the interface's language. */
export const REF_FAILURE_MESSAGES: Record<RefFailure, string> = {
  empty: "请输入条目编号或条目页面的链接",
  "bad-id": "条目编号应是数字",
  "not-a-subject": "无法识别：请输入条目编号、subject/编号，或 bgm.tv、bangumi.tv、chii.in 的条目页面链接",
  "foreign-host": "只接受 bgm.tv、bangumi.tv、chii.in 的链接",
  "character-page": "这是角色页面；请使用作品条目页面的链接",
  "person-page": "这是人物页面；请使用作品条目页面的链接",
  "other-page": "这不是条目页面；条目页面的地址形如 /subject/编号",
  "extra-path": "请使用条目首页的链接（/subject/编号），不要带子页面路径",
};
