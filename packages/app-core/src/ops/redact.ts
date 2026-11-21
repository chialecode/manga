/**
 * What the context debug panel and agent call traces show is what the model was given, with what must not be copied or stored
 * in plaintext taken away (A-48): credentials, tokens, and where files sit on this machine. Count fields (`inputTokens`,
 * `outputTokens`, `maxOutputTokens`, `contextTokens`) are preserved.
 */
export const SECRET_KEY = /(?:api[-_]?key|secret|password|passwd|credential|authorization|cookie|ciphertext)|^(?:access|refresh|auth|bearer|session|id|api)?[-_]?token$/i;
const PATH_LIKE = /(?:file:\/\/\/[^\s"'<>`]+|\b[A-Za-z]:[\\/][^\s"'<>`]+|\\\\[^\s"'<>`\\]+\\[^\s"'<>`]+|(?<![\w/.:-])\/(?:Users|home|tmp|var|private|mnt|Volumes)\/[^\s"'<>`]+)/g;
const TOKEN_LIKE = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
const AUTH_SCHEME_LIKE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const URL_CREDENTIALS = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{1,2048}:[^\s/@]{1,2048}@/gi;
const QUERY_SECRET = /([?&](?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|key)=)([^&\s"'<>`]+)/gi;

export const REDACTED_SECRET = "[已隐去]";
export const REDACTED_PATH = "[本机路径]";

export type RedactDeepOptions = { maxDepth?: number; overflowMarker?: unknown };

export function redactText(text: string): { text: string; secrets: number; paths: number } {
  let secrets = 0;
  let paths = 0;
  let out = text;
  if (out.includes("://") && out.includes("@")) {
    out = out.replace(URL_CREDENTIALS, (_all, scheme: string) => { secrets += 1; return `${scheme}${REDACTED_SECRET}@`; });
  }
  if (out.includes("=") && (out.includes("?") || out.includes("&"))) {
    out = out.replace(QUERY_SECRET, (_all, prefix: string) => { secrets += 1; return `${prefix}${REDACTED_SECRET}`; });
  }
  out = out.replace(AUTH_SCHEME_LIKE, () => { secrets += 1; return REDACTED_SECRET; });
  out = out.replace(TOKEN_LIKE, () => { secrets += 1; return REDACTED_SECRET; });
  if (out.includes("/") || out.includes("\\")) {
    out = out.replace(PATH_LIKE, () => { paths += 1; return REDACTED_PATH; });
  }
  return { text: out, secrets, paths };
}

/** Redact every string below `value` and drop the value of any field that is named like a secret. Counts are returned so callers can report what was taken away. */
export function redactDeep<T>(value: T, options: RedactDeepOptions = {}): { value: T; secrets: number; paths: number } {
  const maxDepth = options.maxDepth ?? 12;
  const overflowMarker = "overflowMarker" in options ? options.overflowMarker : null;
  const total = { secrets: 0, paths: 0 };
  const seen = new WeakSet<object>();
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > maxDepth) return overflowMarker;
    if (typeof item === "string") {
      const result = redactText(item);
      total.secrets += result.secrets;
      total.paths += result.paths;
      return result.text;
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) return overflowMarker;
      seen.add(item);
      try {
        if (Array.isArray(item)) return item.map((child) => walk(child, depth + 1));
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
          if (SECRET_KEY.test(key) && child !== null && child !== undefined && child !== "") {
            total.secrets += 1;
            out[key] = REDACTED_SECRET;
          } else out[key] = walk(child, depth + 1);
        }
        return out;
      } finally {
        seen.delete(item);
      }
    }
    return item;
  };
  return { value: walk(value, 0) as T, ...total };
}
