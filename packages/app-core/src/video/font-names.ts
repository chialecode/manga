/**
 * The family names a font file declares, lower case, for TrueType and OpenType files and collections (WOFF is compressed and gives none). A subtitle
 * style asks for a font by one of these names, so they tell which of a video's fonts a style will find. Names come from the `name` table: the family
 * (1), the full name (4) and the typographic family (16). A damaged file gives what could be read before the damage.
 */
export function fontFamilies(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = new Set<string>();
  const tag = (offset: number) => offset + 4 <= bytes.length ? String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!) : "";
  const fonts: number[] = [];
  if (tag(0) === "ttcf") {
    if (bytes.length < 12) return [];
    const count = Math.min(view.getUint32(8), 64);
    for (let index = 0; index < count && 12 + index * 4 + 4 <= bytes.length; index += 1) fonts.push(view.getUint32(12 + index * 4));
  } else if (["\u0000\u0001\u0000\u0000", "OTTO", "true"].includes(tag(0))) {
    fonts.push(0);
  } else {
    return [];
  }
  for (const font of fonts) {
    if (font + 12 > bytes.length) continue;
    const tables = view.getUint16(font + 4);
    let nameOffset = -1;
    for (let index = 0; index < tables && font + 12 + index * 16 + 16 <= bytes.length; index += 1) {
      const record = font + 12 + index * 16;
      if (tag(record) === "name") { nameOffset = view.getUint32(record + 8); break; }
    }
    if (nameOffset < 0 || nameOffset + 6 > bytes.length) continue;
    const count = view.getUint16(nameOffset + 2);
    const strings = nameOffset + view.getUint16(nameOffset + 4);
    for (let index = 0; index < count; index += 1) {
      const record = nameOffset + 6 + index * 12;
      if (record + 12 > bytes.length) break;
      const platform = view.getUint16(record);
      const id = view.getUint16(record + 6);
      if (id !== 1 && id !== 4 && id !== 16) continue;
      const length = view.getUint16(record + 8);
      const start = strings + view.getUint16(record + 10);
      if (start + length > bytes.length) continue;
      let text = "";
      if (platform === 3 || platform === 0) {
        for (let at = start; at + 1 < start + length; at += 2) text += String.fromCharCode(view.getUint16(at));
      } else if (platform === 1) {
        for (let at = start; at < start + length; at += 1) text += String.fromCharCode(bytes[at]!);
      } else continue;
      const name = text.trim().toLowerCase();
      if (name) names.add(name);
    }
  }
  return [...names];
}
