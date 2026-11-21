const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;
const WORD_RUN = /[\p{L}\p{N}]+/gu;

export function ngramsFor(text: string): string {
  const tokens = new Set<string>();
  const parts = text.normalize("NFC").split(/\s+/u).filter(Boolean);
  for (const part of parts) {
    tokens.add(part.toLowerCase());
    const chars = [...part];
    for (let i = 0; i < chars.length; i += 1) {
      tokens.add(chars[i]!);
      if (i + 1 < chars.length) tokens.add(`${chars[i]}${chars[i + 1]}`);
      if (i + 2 < chars.length) tokens.add(`${chars[i]}${chars[i + 1]}${chars[i + 2]}`);
    }
  }
  return [...tokens].join(" ");
}

export function matchQuery(text: string): string {
  const trimmed = text.trim().normalize("NFC");
  if (!trimmed) return "";
  // Split into contiguous alphanumeric/letter token runs so whitespace and punctuation
  // never form separator-only FTS5 bigrams (such as `" -"` or `"：「"`) that match 0 rows.
  const runs = trimmed.match(WORD_RUN);
  if (!runs?.length) return "";
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (token: string) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    terms.push(`"${token}"`);
  };
  for (const run of runs) {
    const chars = [...run];
    if (CJK.test(run) && chars.length >= 2) {
      for (let i = 0; i < chars.length - 1; i += 1) {
        add(`${chars[i]}${chars[i + 1]}`);
      }
    } else {
      add(run);
    }
  }
  return terms.join(" AND ");
}
