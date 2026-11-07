/**
 * Sort keys for ordered siblings (the children of a mind-map node, the clips of a rough cut). A key is a string that sorts by plain string
 * comparison; a new one can always be made between two neighbours, so putting an item between two others rewrites no other row, and two
 * edits made in different places never fight over the same number.
 */
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0]!;

/** A key strictly between `a` (the empty string is the start) and `b` (`null` is the end). Keys never end in the zero digit. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`sort key order is broken: ${a} is not before ${b}`);
  if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) throw new Error("a sort key cannot end in the zero digit");
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const low = a ? DIGITS.indexOf(a[0]!) : 0;
  const high = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[low]! + midpoint(a.slice(1), null);
}

export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) throw new Error(`sort key order is broken: ${before} is not before ${after}`);
  return midpoint(before ?? "", after);
}

/** `count` keys in order, spread evenly: used to start a list and to renew a list whose keys have grown long. */
export function evenKeys(count: number): string[] {
  if (count <= 0) return [];
  let width = 1;
  while (DIGITS.length ** width < (count + 1) * 4) width += 1;
  const step = Math.floor(DIGITS.length ** width / (count + 1));
  const keys: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    let value = step * i;
    // A key never ends in the zero digit, so a new one can always go between it and its neighbours.
    if (value % DIGITS.length === 0) value += 1;
    keys.push(value.toString(DIGITS.length).padStart(width, ZERO));
  }
  return keys;
}

/** Keys longer than this make a list worth renumbering. */
export const KEY_LIMIT = 24;
