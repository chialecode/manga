/**
 * What the context debug panel shows is what the model was given, with what must not be copied out of the app taken away (A-48):
 * credentials, tokens, and where files sit on this machine. The panel can copy its content as JSON, so the copy is already clean.
 */
const SECRET_KEY = /(?:api[-_]?key|secret|token|password|passwd|credential|authorization|cookie|ciphertext)/i;
const PATH_LIKE = /(?:\b[A-Za-z]:[\\/][^\s"'<>`]+|\\\\[^\s"'<>`\\]+\\[^\s"'<>`]+|(?<![\w/.:-])\/(?:Users|home|tmp|var|private|mnt|Volumes)\/[^\s"'<>`]+)/g;
const TOKEN_LIKE = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})/g;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

export const REDACTED_SECRET = "[已隐去]";
export const REDACTED_PATH = "[本机路径]";

export function redactText(text: string): { text: string; secrets: number; paths: number } {
  let secrets = 0;
  let paths = 0;
  let out = text.replace(URL_CREDENTIALS, (_all, scheme: string) => { secrets += 1; return `${scheme}${REDACTED_SECRET}@`; });
  out = out.replace(TOKEN_LIKE, () => { secrets += 1; return REDACTED_SECRET; });
  out = out.replace(PATH_LIKE, () => { paths += 1; return REDACTED_PATH; });
  return { text: out, secrets, paths };
}

/** Redact every string below `value` and drop the value of any field that is named like a secret. Counts are returned so the panel can say what was taken away. */
export function redactDeep<T>(value: T): { value: T; secrets: number; paths: number } {
  const total = { secrets: 0, paths: 0 };
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 12) return null;
    if (typeof item === "string") {
      const result = redactText(item);
      total.secrets += result.secrets;
      total.paths += result.paths;
      return result.text;
    }
    if (Array.isArray(item)) return item.map((child) => walk(child, depth + 1));
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (SECRET_KEY.test(key) && child !== null && child !== undefined && child !== "") {
          total.secrets += 1;
          out[key] = REDACTED_SECRET;
        } else out[key] = walk(child, depth + 1);
      }
      return out;
    }
    return item;
  };
  return { value: walk(value, 0) as T, ...total };
}
