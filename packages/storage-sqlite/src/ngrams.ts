const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;

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
  const chars = [...trimmed];
  if (CJK.test(trimmed) && chars.length >= 2) {
    const grams: string[] = [];
    for (let i = 0; i < chars.length - 1; i += 1) {
      grams.push(`"${`${chars[i]}${chars[i + 1]}`.replaceAll('"', "")}"`);
    }
    return grams.join(" AND ");
  }
  return `"${trimmed.replaceAll('"', "")}"`;
}
